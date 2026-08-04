/**
 * Retrieval: turning a query into context an agent can actually use.
 *
 * `search` answers "which pages match". Retrieval answers "what should I put
 * in the model's context", which is a different job: passages have to be
 * deduplicated, kept within a budget, and carry a citation so the answer can
 * be traced back to a file the human can open and correct.
 */

import type { ChunkHit, RetrievalResult, RetrievedPassage, SearchFilters } from "../../shared/types";
import { chunkAnchor, isContentToken, normalizeForIndex, parseQueryTerms } from "../../shared/okf";
import type { FtsIndex } from "./fts";

/**
 * Default character budget.
 *
 * Deliberately expressed in characters, not tokens: the tokenizer depends on
 * the model, and a rough character cap is honest about being approximate
 * rather than pretending to a precision it does not have. Roughly 3–4k tokens
 * for English, fewer for Japanese.
 */
export const DEFAULT_BUDGET_CHARS = 6000;

/** Cap on passages taken from any one document, so one page cannot fill the budget. */
const MAX_PASSAGES_PER_DOC = 3;

/**
 * Content tokens a passage must share with the query to be kept.
 *
 * Loose matching ORs every token for recall, which on its own lets a passage
 * qualify on one incidental bigram — so a nonsense question comes back with
 * confident-looking passages. This is the cheap equivalent of "minimum should
 * match", which FTS5 has no operator for.
 *
 * A small absolute floor rather than a fraction: a natural-language question
 * produces many bigrams, most of them grammar, so demanding a *proportion* of
 * them would reject the very page that answers a long question. Two shared
 * content tokens is weak evidence — but this is lexical search, not semantic,
 * and returning the best lexical matches for the agent to judge beats
 * returning nothing.
 */
const DEFAULT_MIN_CONTENT_MATCHES = 2;

export interface RetrieveOptions extends SearchFilters {
  /** Maximum passages to return. */
  limit?: number;
  /** Character budget across all passages. */
  budgetChars?: number;
  /** Include neighbouring chunks of a hit for continuity. */
  expandNeighbours?: boolean;
  /** Content tokens a passage must share with the query. */
  minContentMatches?: number;
}

/**
 * Retrieve passages for a query.
 *
 * Chunks are ranked individually but capped per document, which keeps a long
 * page from crowding out a short one that answers the question better.
 */
export function retrieve(
  index: FtsIndex,
  query: string,
  options: RetrieveOptions = {}
): RetrievalResult {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
  // An explicit budget is honoured as given — silently raising it to a floor
  // would blow the caller's context window, which is the one thing a budget
  // exists to prevent.
  const budget = Math.max(1, options.budgetChars ?? DEFAULT_BUDGET_CHARS);

  const filters: SearchFilters = {};
  if (options.type) filters.type = options.type;
  if (options.tags?.length) filters.tags = options.tags;
  if (options.pathPrefix) filters.pathPrefix = options.pathPrefix;

  // Retrieval takes a question, not a term: loose matching keeps recall up and
  // lets BM25 decide which passages actually answer it.
  const hits = index.searchChunks(query, { ...filters, limit: limit * 4, mode: "loose" });
  if (hits.length === 0) {
    return { query, passages: [], usedChars: 0, truncated: false };
  }

  const relevant = filterByCoverage(
    hits,
    query,
    options.minContentMatches ?? DEFAULT_MIN_CONTENT_MATCHES
  );
  if (relevant.length === 0) {
    return { query, passages: [], usedChars: 0, truncated: false };
  }

  const selected = selectPassages(relevant, limit);
  const expanded = options.expandNeighbours ? withNeighbours(index, selected) : selected;

  const passages: RetrievedPassage[] = [];
  let usedChars = 0;
  let truncated = false;

  for (const hit of expanded) {
    const remaining = budget - usedChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    // Trim at a paragraph edge rather than mid-sentence when the budget bites.
    const text = hit.text.length <= remaining ? hit.text : trimToBudget(hit.text, remaining);
    if (text.length < hit.text.length) truncated = true;
    if (!text) {
      truncated = true;
      break;
    }

    passages.push({
      anchor: chunkAnchor(hit.id, hit.headingPath[hit.headingPath.length - 1] ?? ""),
      id: hit.id,
      path: hit.path,
      title: hit.title,
      type: hit.type,
      headingPath: hit.headingPath,
      text,
      score: hit.score,
    });
    usedChars += text.length;
  }

  return { query, passages, usedChars, truncated };
}

/**
 * Drop passages that share too little with the query.
 *
 * Matching is measured over the same normalised tokens the index uses, so the
 * comparison is like for like in both Japanese and English — and restricted to
 * content tokens, so grammar cannot inflate or deflate the count.
 */
function filterByCoverage(
  hits: readonly ChunkHit[],
  query: string,
  minMatches: number
): ChunkHit[] {
  if (minMatches <= 0) return [...hits];

  const wanted = new Set<string>();
  for (const term of parseQueryTerms(query)) {
    for (const token of term.tokens) {
      if (isContentToken(token)) wanted.add(token);
    }
  }
  // A query of pure grammar has nothing to check against; let BM25 decide.
  if (wanted.size === 0) return [...hits];

  const needed = Math.min(minMatches, wanted.size);

  return hits.filter((hit) => {
    const haystack = new Set(
      normalizeForIndex(
        [hit.title, hit.headingPath.join(" "), hit.text].filter(Boolean).join(" ")
      ).split(" ")
    );
    let found = 0;
    for (const token of wanted) {
      if (haystack.has(token)) found++;
      if (found >= needed) return true;
    }
    return false;
  });
}

function selectPassages(hits: readonly ChunkHit[], limit: number): ChunkHit[] {
  const perDoc = new Map<string, number>();
  const out: ChunkHit[] = [];

  for (const hit of hits) {
    const taken = perDoc.get(hit.id) ?? 0;
    if (taken >= MAX_PASSAGES_PER_DOC) continue;
    perDoc.set(hit.id, taken + 1);
    out.push(hit);
    if (out.length >= limit) break;
  }

  return out;
}

/**
 * Pull in the chunk on either side of each hit.
 *
 * A section boundary often lands mid-argument; the neighbours restore enough
 * continuity for a model to read the passage as prose rather than a fragment.
 */
function withNeighbours(index: FtsIndex, hits: readonly ChunkHit[]): ChunkHit[] {
  const seen = new Set(hits.map((hit) => hit.chunkId));
  const out: ChunkHit[] = [];

  for (const hit of hits) {
    const siblings = index.chunksOf(hit.id);
    const at = siblings.findIndex((chunk) => chunk.chunkId === hit.chunkId);
    if (at === -1) {
      out.push(hit);
      continue;
    }

    for (const offset of [-1, 0, 1]) {
      const sibling = siblings[at + offset];
      if (!sibling) continue;
      if (offset !== 0 && seen.has(sibling.chunkId)) continue;
      seen.add(sibling.chunkId);
      out.push(offset === 0 ? hit : { ...sibling, score: hit.score });
    }
  }

  return out;
}

function trimToBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  const slice = text.slice(0, budget);
  const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("。"), slice.lastIndexOf(". "));
  // Only honour the break if it keeps most of the budget; otherwise a single
  // long paragraph would be discarded entirely.
  return breakAt > budget * 0.5 ? slice.slice(0, breakAt).trimEnd() : slice.trimEnd();
}

/**
 * Human-readable location of a passage.
 *
 * A document's H1 usually repeats its frontmatter title, which would render as
 * "検索の仕組み › 検索の仕組み › 日本語対応"; consecutive duplicates are collapsed.
 */
export function passageLocation(passage: RetrievedPassage): string {
  const parts: string[] = [];
  for (const segment of [passage.title, ...passage.headingPath]) {
    if (segment && segment !== parts[parts.length - 1]) parts.push(segment);
  }
  return parts.join(" › ");
}

/**
 * Render a retrieval result as Markdown for an agent.
 *
 * Each passage is prefixed with its anchor so the model can cite it, and the
 * paths are real files the human can open — the whole point of file-over-app.
 */
export function formatRetrieval(result: RetrievalResult): string {
  if (result.passages.length === 0) {
    return `No passages found for: ${result.query}`;
  }

  const parts = result.passages.map((passage) => {
    const location = passageLocation(passage);
    return [
      `### ${location}`,
      `source: \`${passage.path}\` · anchor: \`${passage.anchor}\` · type: ${passage.type}`,
      "",
      passage.text,
    ].join("\n");
  });

  const header = `Retrieved ${result.passages.length} passage(s) for: ${result.query}`;
  const footer = result.truncated
    ? "\n\n_(truncated to fit the context budget — narrow the query or raise budget_chars for more)_"
    : "";

  return `${header}\n\n${parts.join("\n\n---\n\n")}${footer}`;
}
