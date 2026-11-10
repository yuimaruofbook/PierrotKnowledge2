/**
 * Retrieval: turning a query into context an agent can actually use.
 *
 * `search` answers "which pages match". Retrieval answers "what should I put
 * in the model's context", which is a different job: passages have to be
 * deduplicated, kept within a budget, and carry a citation so the answer can
 * be traced back to a file the human can open and correct.
 */

import type {
  ChunkHit,
  LinkedFile,
  RetrievalResult,
  RetrievedPassage,
  SearchFilters,
} from "../../shared/types";
import { chunkAnchor, isContentToken, normalizeForIndex, parseQueryTerms } from "../../shared/okf";
import { estimateTokens } from "../../shared/okf/skill";
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

/**
 * How much each inbound link lifts a page's passages, and how many count.
 * A page the rest of the wiki points at is more often the one meant than a
 * page that mentions the same words in passing.
 */
const LINK_BOOST = 0.05;
const MAX_COUNTED_LINKS = 8;

/**
 * Reciprocal rank fusion's constant: large enough that a passage found by two
 * phrasings outranks one found first by a single phrasing.
 */
const RRF_K = 60;

export interface RetrieveOptions extends SearchFilters {
  /** Maximum passages to return. */
  limit?: number;
  /** Character budget across all passages. */
  budgetChars?: number;
  /** Include neighbouring chunks of a hit for continuity. */
  expandNeighbours?: boolean;
  /** Content tokens a passage must share with the query. */
  minContentMatches?: number;
  /**
   * Links to follow from the retrieved files (0-2). Applied by
   * `Workspace.retrieve`, which has the link graph; the index-level
   * function ignores it.
   */
  linkDepth?: number;
  /** Other phrasings of the same question, fused with it by rank. */
  queries?: readonly string[];
  /**
   * Budget in estimated tokens; overrides `budgetChars`. A CJK character costs
   * about a token where four Latin letters do, so a character budget buys very
   * different amounts of context by language.
   */
  budgetTokens?: number;
  /**
   * Inbound link count per concept id, for ranking. Filled in by
   * `Workspace.retrieve`, which has the link graph.
   */
  inbound?: ReadonlyMap<string, number>;
}

/** The budget, in whichever unit was asked for. */
export function budgetOf(options: RetrieveOptions): number {
  return Math.max(1, options.budgetTokens ?? options.budgetChars ?? DEFAULT_BUDGET_CHARS);
}

/** What a text costs against the budget: estimated tokens or UTF-16 units. */
export function costOf(options: RetrieveOptions, text: string): number {
  return options.budgetTokens !== undefined ? estimateTokens(text) : text.length;
}

/**
 * Retrieve passages for a query, and for any other phrasings of it.
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
  const budget = budgetOf(options);

  const filters: SearchFilters = {};
  if (options.type) filters.type = options.type;
  if (options.tags?.length) filters.tags = options.tags;
  if (options.pathPrefix) filters.pathPrefix = options.pathPrefix;
  if (options.includeDead) filters.includeDead = true;
  if (options.paraDepth !== undefined) filters.paraDepth = options.paraDepth;

  const phrasings = [query, ...(options.queries ?? []).filter((q) => q.trim())];
  const minMatches = options.minContentMatches ?? DEFAULT_MIN_CONTENT_MATCHES;

  const ranked = phrasings.map((phrasing) => {
    // Retrieval takes a question, not a term: loose matching keeps recall up
    // and lets BM25 decide which passages actually answer it.
    const hits = index.searchChunks(phrasing, { ...filters, limit: limit * 4, mode: "loose" });
    return filterByCoverage(index, boostByLinks(hits, options.inbound), phrasing, minMatches);
  });
  const relevant = ranked.length === 1 ? ranked[0]! : fuse(ranked);

  const passages: RetrievedPassage[] = [];
  let used = 0;
  let truncated = false;

  if (relevant.length > 0) {
    const selected = selectPassages(relevant, limit);
    const expanded = options.expandNeighbours ? withNeighbours(index, selected) : selected;

    for (const hit of expanded) {
      const remaining = budget - used;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      // Trim at a paragraph edge rather than mid-sentence when the budget bites.
      const text = costOf(options, hit.text) <= remaining ? hit.text : trimToCost(hit.text, remaining, options);
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
      used += costOf(options, text);
    }
  }

  return {
    query: phrasings.join(" | "),
    passages,
    usedChars: used,
    ...(options.budgetTokens !== undefined ? { budgetTokens: options.budgetTokens } : {}),
    truncated,
  };
}

/** Lift the passages of pages other pages link to, then put them back in order. */
function boostByLinks(hits: readonly ChunkHit[], inbound: ReadonlyMap<string, number> | undefined): ChunkHit[] {
  if (!inbound || inbound.size === 0) return [...hits];
  return hits
    .map((hit) => ({
      ...hit,
      score: hit.score * (1 + LINK_BOOST * Math.min(inbound.get(hit.id) ?? 0, MAX_COUNTED_LINKS)),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Merge the rankings of several phrasings by reciprocal rank: a passage's
 * score is the sum of 1 / (k + rank) over the phrasings that found it. Ranks
 * rather than scores, because BM25 scores of different queries do not compare.
 */
function fuse(ranked: readonly (readonly ChunkHit[])[]): ChunkHit[] {
  const fused = new Map<string, ChunkHit>();
  for (const hits of ranked) {
    hits.forEach((hit, rank) => {
      const share = 1 / (RRF_K + rank + 1);
      const seen = fused.get(hit.chunkId);
      if (seen) seen.score += share;
      else fused.set(hit.chunkId, { ...hit, score: share });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/**
 * Drop passages that share too little with the query.
 *
 * Matching is measured over the same normalised tokens the index uses, so the
 * comparison is like for like in both Japanese and English — restricted to
 * content tokens, so grammar cannot inflate or deflate the count, and over
 * everything a passage is indexed with: its page's title, description and tags
 * as well as its text.
 */
function filterByCoverage(
  index: FtsIndex,
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

  // Half of what the question carries, up to the minimum: a two-word question
  // is not asked to match both, since one is often the asking word (何時, how)
  // rather than the subject.
  const needed = Math.min(minMatches, Math.ceil(wanted.size / 2));

  return hits.filter((hit) => {
    const haystack = new Set(
      normalizeForIndex(
        [hit.title, hit.headingPath.join(" "), index.contextOf(hit.id), hit.text].filter(Boolean).join(" ")
      ).split(" ")
    );
    let found = 0;
    for (const token of wanted) {
      if (haystack.has(token)) found++;
    }
    return found >= needed;
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

/**
 * Cut `text` to what `remaining` of the budget buys. In characters that is
 * `trimToBudget`; in tokens, start from the proportional length and shorten
 * until the estimate fits.
 */
function trimToCost(text: string, remaining: number, options: RetrieveOptions): string {
  if (options.budgetTokens === undefined) return trimToBudget(text, remaining);
  let chars = Math.floor((text.length * remaining) / Math.max(1, costOf(options, text)));
  for (;;) {
    const cut = trimToBudget(text, chars);
    if (chars === 0 || costOf(options, cut) <= remaining) return cut;
    chars = Math.floor((chars * 9) / 10);
  }
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
 * Render the files reached by following links: path, title and the one-line
 * description, with the hop count and the file each came from so the chain can
 * be walked back. Shared by retrieval and context packs.
 */
export function formatLinked(linked: readonly LinkedFile[]): string {
  const lines = ["## Linked files (descriptions only - read_file to open one)", ""];
  for (const file of linked) {
    const description = file.description ? `: ${file.description}` : "";
    lines.push(
      `- \`${file.path}\` — ${file.title} (${file.type}) · hop ${file.hops} from \`${file.from}\`${description}`
    );
  }
  return lines.join("\n");
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
  const linked = result.linked?.length ? `\n\n${formatLinked(result.linked)}` : "";
  const knob = result.budgetTokens !== undefined ? "budget_tokens" : "budget_chars";
  const footer = result.truncated
    ? `\n\n_(truncated to fit the context budget — narrow the query or raise ${knob} for more)_`
    : "";

  return `${header}\n\n${parts.join("\n\n---\n\n")}${linked}${footer}`;
}
