/**
 * Text normalisation for search.
 *
 * SQLite's `unicode61` tokenizer cannot segment Japanese: a run of kana and
 * kanji becomes one or two enormous tokens, so 「軽量」 in the middle of a
 * sentence is unfindable. The `trigram` tokenizer handles substrings but
 * cannot match anything shorter than three characters, which rules out the
 * two-character words Japanese is full of (知識, 軽量, 設計).
 *
 * So CJK runs are expanded into overlapping bigrams at index time and query
 * time both. `unicode61` keeps a space-separated bigram intact even across a
 * script boundary (識ベ, トア), which makes the two ends line up exactly.
 */

/**
 * Characters that need n-gram treatment: kana, kanji, and the CJK extensions.
 * Deliberately excludes CJK punctuation (　-〿), which should separate
 * words rather than join them.
 */
const CJK_CLASS =
  "\u3040-\u309f" + // hiragana
  "\u30a0-\u30ff" + // katakana
  "\u31f0-\u31ff" + // katakana phonetic extensions
  "\u3400-\u4dbf" + // CJK extension A
  "\u4e00-\u9fff" + // CJK unified ideographs
  "\uf900-\ufaff" + // CJK compatibility ideographs
  "\uff66-\uff9f"; //  halfwidth katakana

const CJK_RE = new RegExp(`[${CJK_CLASS}]`);
const CJK_RUN_RE = new RegExp(`[${CJK_CLASS}]+`, "g");

export function isCjk(char: string): boolean {
  return CJK_RE.test(char);
}

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** Overlapping bigrams of a CJK run; a single character is emitted as itself. */
export function bigrams(run: string): string[] {
  if (run.length <= 1) return run ? [run] : [];
  const out: string[] = [];
  for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  return out;
}

/**
 * Convert text into the form actually stored in the FTS index.
 *
 * Latin text passes through lowercased and is tokenised normally; CJK runs
 * become space-separated bigrams.
 */
export function normalizeForIndex(text: string): string {
  if (!text) return "";
  return (
    text
      .toLowerCase()
      .replace(CJK_RUN_RE, (run) => ` ${bigrams(run).join(" ")} `)
      // Punctuation becomes a separator, mirroring what unicode61 does when it
      // tokenizes. Without this a query token keeps its trailing "?" or "," and
      // never equals the indexed word, which silently breaks any comparison
      // made outside SQLite — such as the retrieval coverage check.
      .replace(/[^\p{Letter}\p{Number}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export interface QueryTerm {
  /** The term as the user typed it, for highlighting. */
  raw: string;
  /** FTS5 tokens this term expands to. */
  tokens: string[];
  cjk: boolean;
}

/**
 * Split user input into terms, keeping quoted phrases together.
 */
export function parseQueryTerms(query: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;

  for (const match of query.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw) continue;

    const cjk = containsCjk(raw);
    const normalized = normalizeForIndex(raw);
    const tokens = normalized.split(" ").filter(Boolean);
    if (tokens.length) terms.push({ raw, tokens, cjk });
  }

  return terms;
}

/**
 * How strictly a query should be interpreted.
 *
 * `phrase` — every term must appear, and a multi-bigram term must appear
 * contiguously. Right for *locating* a page from a term you know.
 *
 * `loose` — any token may match, with BM25 doing the ranking. Right for
 * *retrieval*, where the input is a natural-language question. Japanese has no
 * word spaces, so a whole clause arrives as one term; requiring it verbatim
 * would mean a question only ever matches text that already contains it.
 */
export type QueryMode = "phrase" | "loose";

/**
 * Build an FTS5 MATCH expression.
 *
 * Every token is quoted, which neutralises the FTS5 operators (`NEAR`, `OR`,
 * `-`, `:`) that would otherwise turn a stray character in a search box into a
 * syntax error. A single CJK character has no bigram to match, so it becomes a
 * prefix query against the bigrams that start with it.
 */
export function buildMatchQuery(query: string, mode: QueryMode = "phrase"): string | null {
  const terms = parseQueryTerms(query);
  if (terms.length === 0) return null;

  if (mode === "loose") {
    // Every bigram becomes an independent clause. Recall comes from the OR;
    // precision comes from BM25 favouring documents that match more of them.
    const tokens = new Set<string>();
    for (const term of terms) {
      for (const token of term.tokens) tokens.add(token);
    }
    const clauses = [...tokens].map((token) =>
      token.length === 1 ? `"${token}"*` : `"${token}"`
    );
    return clauses.length ? clauses.join(" OR ") : null;
  }

  const clauses: string[] = [];
  for (const term of terms) {
    if (term.cjk && term.tokens.length === 1 && term.tokens[0]!.length === 1) {
      clauses.push(`"${term.tokens[0]}"*`);
      continue;
    }
    // A multi-token term is a phrase: the bigrams must be adjacent, not merely
    // both present, or 「知識」+「識ベ」 would match documents containing them
    // in unrelated places.
    if (term.tokens.length > 1) {
      clauses.push(`"${term.tokens.join(" ")}"`);
      continue;
    }
    clauses.push(`"${term.tokens[0]}"`);
  }

  return clauses.join(" AND ");
}

const HIRAGANA_ONLY_RE = /^[぀-ゟー]+$/;

/**
 * Whether a token carries meaning rather than grammar.
 *
 * In Japanese, content words are written with kanji or katakana; a bigram made
 * only of hiragana is almost always particles or inflection (はど, どう, てい,
 * いる). Counting those as evidence makes a long question look mostly
 * unmatched, because no document contains that particular glue — the question
 * would then be judged irrelevant to the very page that answers it.
 *
 * The heuristic misfires on genuinely hiragana words like 「もの」, which are
 * low-information anyway, so the cost of being wrong is small.
 */
export function isContentToken(token: string): boolean {
  return !HIRAGANA_ONLY_RE.test(token);
}

export interface Highlight {
  start: number;
  end: number;
}

/** Locate query terms inside the original text, case-insensitively. */
export function findHighlights(text: string, terms: readonly QueryTerm[]): Highlight[] {
  const haystack = text.toLowerCase();
  const spans: Highlight[] = [];

  for (const term of terms) {
    const needle = term.raw.toLowerCase();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      spans.push({ start: at, end: at + needle.length });
      from = at + needle.length;
      if (spans.length > 64) break;
    }
  }

  return mergeSpans(spans);
}

function mergeSpans(spans: Highlight[]): Highlight[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Highlight[] = [sorted[0]!];
  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  }
  return merged;
}

export interface SnippetOptions {
  /** Characters of context to show. */
  width?: number;
  /** Marker inserted around matches. */
  open?: string;
  close?: string;
  ellipsis?: string;
}

/**
 * Build a snippet centred on the first match.
 *
 * Generated here rather than with SQLite's `snippet()` because the indexed text
 * is bigram-expanded — `snippet()` would return a stream of bigrams instead of
 * readable prose.
 */
export function makeSnippet(
  text: string,
  query: string,
  options: SnippetOptions = {}
): string {
  const width = options.width ?? 160;
  const open = options.open ?? "";
  const close = options.close ?? "";
  const ellipsis = options.ellipsis ?? "…";

  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";

  const spans = findHighlights(flat, parseQueryTerms(query));
  if (spans.length === 0) {
    return flat.length <= width ? flat : `${flat.slice(0, width)}${ellipsis}`;
  }

  const first = spans[0]!;
  const pad = Math.max(0, Math.floor((width - (first.end - first.start)) / 2));
  const start = Math.max(0, first.start - pad);
  const end = Math.min(flat.length, start + width);

  let out = "";
  let cursor = start;
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    const from = Math.max(span.start, start);
    const to = Math.min(span.end, end);
    out += flat.slice(cursor, from) + open + flat.slice(from, to) + close;
    cursor = to;
  }
  out += flat.slice(cursor, end);

  return `${start > 0 ? ellipsis : ""}${out}${end < flat.length ? ellipsis : ""}`;
}
