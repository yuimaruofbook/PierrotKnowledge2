/**
 * YAML frontmatter framing.
 *
 * Splitting and re-joining are kept separate from YAML *parsing* so the webview
 * never has to pull in a YAML library: it only ever needs the body.
 */

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export type Eol = "\n" | "\r\n";

export interface SplitDocument {
  /** Frontmatter source, without the `---` fences. `null` when absent. */
  yaml: string | null;
  /** Document body with the frontmatter block removed. */
  body: string;
  /** Line ending detected in the source, used to round-trip faithfully. */
  eol: Eol;
}

export function detectEol(raw: string): Eol {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Split a raw file into frontmatter and body.
 *
 * A leading UTF-8 BOM is tolerated: editors add one silently and it would
 * otherwise make the `---` fence unmatchable.
 */
export function splitFrontmatter(raw: string): SplitDocument {
  const eol = detectEol(raw);
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { yaml: null, body: text, eol };
  return { yaml: m[1] ?? "", body: text.slice(m[0].length), eol };
}

export function hasFrontmatter(raw: string): boolean {
  return splitFrontmatter(raw).yaml !== null;
}

/** Re-attach a frontmatter block to a body. */
export function joinFrontmatter(yaml: string, body: string, eol: Eol = "\n"): string {
  const block = ["---", yaml.replace(/\r?\n$/, ""), "---", ""].join(eol);
  return block + eol + body.replace(/^[\r\n]+/, "");
}

/**
 * Read a single scalar key straight out of frontmatter source.
 *
 * Used for conformance checks and cheap metadata reads where paying for a full
 * YAML parse is not worth it. Only top-level, unquoted-or-quoted scalars.
 */
export function readScalar(yaml: string, key: string): string | null {
  const re = new RegExp(`^${escapeRegExp(key)}[ \\t]*:[ \\t]*(.*)$`, "m");
  const m = yaml.match(re);
  if (!m) return null;
  const value = (m[1] ?? "").trim();
  if (!value || value === "|" || value === ">") return null;
  return stripQuotes(value);
}

function stripQuotes(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first) && value.length > 1) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
