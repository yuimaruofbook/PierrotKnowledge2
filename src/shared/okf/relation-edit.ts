/**
 * Keeping typed relations pointing at a concept that moves.
 *
 * `relations:` lives in the frontmatter, where the YAML is the author's: key
 * order, quoting, comments and indentation all stay as written. So this edits
 * only the text of the relation entries that must change, in place, and
 * refuses (reports the entry) when it cannot be sure it found the right text.
 * Like `setLifecycleInDocument`, it never re-serialises the frontmatter.
 *
 * It recognises the shapes people write:
 *
 *     relations:
 *       depends_on: [a/b, "[[c]]"]      # flow list on one line
 *       part_of:
 *         - wiki/x/y.md                 # block list
 *       see_also: z/w                   # a single value
 *
 * Anything else (anchors, multi-line flow lists, block scalars, tabs) is left
 * alone and reported. Each located value is checked against what the YAML
 * parser read for the same entry before it is touched.
 *
 * The Rust port is `rust/src/shared/okf/relation_edit.rs`; both must make the
 * same edits.
 *
 * Pure and DOM-free.
 */

import { splitFrontmatter } from "./frontmatter";
import { normalizeRelationTarget } from "./graph-schema";
import { resolveLinkTarget } from "./links";
import { relativeIdPath } from "./rename";

/** A scalar's text in the frontmatter source. */
interface Token {
  start: number;
  end: number;
  quote: '"' | "'" | "";
  /** The scalar as the YAML parser reads it. */
  value: string;
  flow: boolean;
}

/** An entry of a list. `null`: present, but not a scalar this editor can place. */
type Item = Token | null;

export interface RelationEditResult {
  raw: string;
  /** Entries rewritten. */
  count: number;
  /** Entries that needed a rewrite and could not be edited safely. */
  unsafe: Array<{ kind: string; target: string }>;
}

const isBlank = (c: string | undefined) => c === " " || c === "\t";

/** The scalar at the start of `text` (leading blanks skipped), or `null` if it is not a plain/quoted one. */
function scalarToken(text: string, base: number, flow: boolean): Token | null {
  let lead = 0;
  while (isBlank(text[lead])) lead++;
  const s = text.slice(lead);
  const at = base + lead;
  if (s === "") return null;
  const q = s[0]!;
  if (q === '"' || q === "'") {
    let value = "";
    let i = 1;
    for (; i < s.length; i++) {
      const c = s[i]!;
      if (q === '"') {
        if (c === "\\") {
          const n = s[i + 1];
          if (n !== "\\" && n !== '"') return null;
          value += n;
          i++;
          continue;
        }
        if (c === '"') break;
      } else if (c === "'") {
        if (s[i + 1] === "'") {
          value += "'";
          i++;
          continue;
        }
        break;
      }
      value += c;
    }
    if (i >= s.length) return null;
    const rest = s.slice(i + 1);
    const tail = flow ? rest.trim() === "" : rest.trim() === "" || /^[ \t]+#/.test(rest);
    return tail ? { start: at, end: at + i + 1, quote: q, value, flow } : null;
  }
  if (/^[&*!|>%@`[\]{}#,]/.test(s)) return null;
  let text2 = s;
  if (!flow) {
    const hash = s.search(/[ \t]#/);
    if (hash >= 0) text2 = s.slice(0, hash);
  }
  text2 = text2.trimEnd();
  if (text2 === "" || text2.includes(": ") || text2.endsWith(":")) return null;
  if (flow && /[,[\]{}]/.test(text2)) return null;
  return { start: at, end: at + text2.length, quote: "", value: text2, flow };
}

/** A single-line `[a, "b"]` starting at `text`'s first non-blank: its items, or `null` when it is not editable. */
function flowItems(text: string, base: number): Item[] | null {
  let lead = 0;
  while (isBlank(text[lead])) lead++;
  const s = text.slice(lead);
  let depth = 0;
  let quote = "";
  let close = -1;
  const cuts: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === "," && depth === 1) cuts.push(i);
  }
  if (close < 0) return null;
  const tail = s.slice(close + 1);
  if (tail.trim() !== "" && !/^[ \t]+#/.test(tail)) return null;
  if (s.slice(1, close).trim() === "") return [];

  const bounds = [0, ...cuts, close];
  const items: Item[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const from = bounds[k]! + 1;
    const piece = s.slice(from, bounds[k + 1]!);
    if (piece.trim() === "") {
      // A trailing comma is allowed; an empty slot elsewhere is not a list this reads.
      if (k + 2 === bounds.length && k > 0) continue;
      return null;
    }
    items.push(scalarToken(piece, base + lead + from, true));
  }
  return items;
}

/** Every kind under the top-level `relations:` key, with the text of its entries. `null` when it cannot be read at all. */
function scanRelations(yaml: string): Map<string, Item[] | null> | null {
  const lines: Array<{ text: string; start: number }> = [];
  let pos = 0;
  for (const piece of yaml.split(/(?<=\n)/)) {
    lines.push({ text: piece.replace(/\r?\n$/, ""), start: pos });
    pos += piece.length;
  }
  const skippable = (t: string) => /^[ \t]*(?:#.*)?$/.test(t);
  const indentOf = (t: string) => t.length - t.replace(/^[ \t]+/, "").length;

  const keyAt = lines.findIndex((l) => /^relations[ \t]*:/.test(l.text));
  if (keyAt < 0) return null;
  const afterKey = lines[keyAt]!.text.slice(lines[keyAt]!.text.indexOf(":") + 1);
  if (!skippable(afterKey)) return null;

  const block: Array<{ text: string; start: number }> = [];
  for (let i = keyAt + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!skippable(l.text) && !isBlank(l.text[0])) break;
    block.push(l);
  }
  if (block.some((l) => /^[ \t]*\t/.test(l.text) && !skippable(l.text))) return null;
  const first = block.find((l) => !skippable(l.text));
  if (!first) return new Map();
  const kindIndent = indentOf(first.text);

  const out = new Map<string, Item[] | null>();
  let current: { name: string; items: Item[] | null; block: boolean; seqIndent: number } | null = null;
  for (const line of block) {
    if (skippable(line.text)) continue;
    const ind = indentOf(line.text);
    if (ind < kindIndent) return null;
    const isItem = /^[ \t]*-(?:[ \t]|$)/.test(line.text);

    if (ind === kindIndent && !isItem) {
      current = null;
      const m =
        /^[ \t]*"([^"\\]*)"[ \t]*:(?:[ \t]+(.*))?$/.exec(line.text) ??
        /^[ \t]*'([^']*)'[ \t]*:(?:[ \t]+(.*))?$/.exec(line.text) ??
        /^[ \t]*([^\s"'#\-?:[\]{},&*!|>%@`][^:]*?)[ \t]*:(?:[ \t]+(.*))?$/.exec(line.text);
      if (!m) continue;
      const name = m[1]!;
      const rest = m[2] ?? "";
      const restAt = line.start + line.text.length - rest.length;
      current = { name, items: [], block: false, seqIndent: -1 };
      if (rest.trim() === "" || rest.trimStart().startsWith("#")) current.block = true;
      else if (rest.trimStart().startsWith("[")) current.items = flowItems(rest, restAt);
      else {
        const token = scalarToken(rest, restAt, false);
        current.items = token ? [token] : null;
      }
      out.set(name, current.items);
      continue;
    }

    if (!current || current.items === null) continue;
    if (!current.block || !isItem) {
      current.items = null;
      out.set(current.name, null);
      continue;
    }
    if (current.seqIndent < 0) current.seqIndent = ind;
    else if (ind !== current.seqIndent) {
      current.items = null;
      out.set(current.name, null);
      continue;
    }
    const dash = line.text.indexOf("-");
    const valueText = line.text.slice(dash + 1);
    current.items.push(valueText.trim() === "" ? null : scalarToken(valueText, line.start + dash + 1, false));
  }
  return out;
}

/** Can `text` stand as an unquoted scalar where `flow` says it will be? */
function plainSafe(text: string, flow: boolean): boolean {
  if (text === "" || text !== text.trim()) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return false;
  if (text.includes(": ") || text.includes(" #") || text.endsWith(":")) return false;
  if (flow && /[,[\]{}]/.test(text)) return false;
  return !/[\n\r]/.test(text);
}

function encode(token: Token, text: string): string | null {
  if (/[\n\r]/.test(text)) return null;
  if (token.quote === '"') return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (token.quote === "'") return `'${text.replace(/'/g, "''")}'`;
  return plainSafe(text, token.flow) ? text : null;
}

/**
 * Apply `decide` to every string entry of `relations` (the parsed value) and
 * rewrite those it answers for. `decide` returns the new text of an entry, `null`
 * to leave it, or `undefined` for "needs changing, but I cannot write it".
 */
export function editRelationEntries(
  raw: string,
  relations: unknown,
  decide: (entry: string) => string | null | undefined
): RelationEditResult {
  const result: RelationEditResult = { raw, count: 0, unsafe: [] };
  if (typeof relations !== "object" || relations === null || Array.isArray(relations)) return result;

  const wanted: Array<{ name: string; kind: string; index: number; length: number; entry: string; to: string | undefined }> = [];
  for (const [name, entries] of Object.entries(relations)) {
    const list = typeof entries === "string" ? [entries] : Array.isArray(entries) ? entries : null;
    if (list === null) continue;
    list.forEach((entry, index) => {
      if (typeof entry !== "string") return;
      const to = decide(entry);
      if (to === null) return;
      wanted.push({ name, kind: name.trim(), index, length: list.length, entry, to });
    });
  }
  if (wanted.length === 0) return result;

  const bom = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fence = /^---[ \t]*\r?\n/.exec(raw.slice(bom));
  const { yaml } = splitFrontmatter(raw);
  const scan = fence && yaml !== null ? scanRelations(yaml) : null;
  const origin = bom + (fence ? fence[0].length : 0);

  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const w of wanted) {
    const items = scan?.get(w.name) ?? null;
    const token = items && items.length === w.length ? items[w.index] : null;
    const text = token && w.to !== undefined && token.value === w.entry ? encode(token, w.to) : null;
    if (!token || text === null) {
      result.unsafe.push({ kind: w.kind, target: w.entry });
      continue;
    }
    edits.push({ start: origin + token.start, end: origin + token.end, text });
  }

  edits.sort((a, b) => b.start - a.start);
  let next = raw;
  for (const e of edits) next = next.slice(0, e.start) + e.text + next.slice(e.end);
  return { raw: next, count: edits.length, unsafe: result.unsafe };
}

/** An entry rewritten to name `newId`, in the form it was written in; `undefined` when it has no form this knows. */
function retarget(entry: string, fromId: string, newId: string, wikiDir: string): string | undefined {
  const core = entry.trim();
  const lead = entry.slice(0, entry.indexOf(core));
  const trail = entry.slice(lead.length + core.length);

  const wiki = /^\[\[([\s\S]*)\]\]$/.exec(core);
  if (wiki) {
    const m = /^([^|#]*)(#[^|]*)?(\|[\s\S]*)?$/.exec(wiki[1]!);
    return m ? `${lead}[[${newId}${m[2] ?? ""}${m[3] ?? ""}]]${trail}` : undefined;
  }
  if (/[|\\]/.test(core)) return undefined;
  const hash = core.indexOf("#");
  const path = hash < 0 ? core : core.slice(0, hash);
  const fragment = hash < 0 ? "" : core.slice(hash);
  const ext = /\.(?:md|markdown)$/i.exec(path)?.[0] ?? "";
  let head: string;
  if (wikiDir && path.startsWith(`${wikiDir}/`)) head = `${wikiDir}/${newId}`;
  else if (path.startsWith("/")) head = `/${newId}`;
  else if (/^\.{1,2}\//.test(path)) head = relativeIdPath(fromId, newId);
  else head = newId;
  return `${lead}${head}${ext}${fragment}${trail}`;
}

/**
 * `relations` entries of the document `fromId` that point at `oldId`, rewritten
 * to `newId`. `knownIds` is the id set before the move, which is what made each
 * entry resolve the way it does. A rewrite is kept only if it resolves to
 * `newId` afterwards.
 */
export function relationsAfterMove(
  raw: string,
  relations: unknown,
  fromId: string,
  oldId: string,
  newId: string,
  knownIds: ReadonlySet<string>,
  wikiDir: string
): RelationEditResult {
  const after = new Set(knownIds);
  after.delete(oldId);
  after.add(newId);
  return editRelationEntries(raw, relations, (entry) => {
    const target = normalizeRelationTarget(entry, wikiDir);
    if (target === null || resolveLinkTarget(target, fromId, knownIds) !== oldId) return null;
    const next = retarget(entry, fromId, newId, wikiDir);
    const check = next === undefined ? null : normalizeRelationTarget(next, wikiDir);
    return next !== undefined && check !== null && resolveLinkTarget(check, fromId, after) === newId ? next : undefined;
  });
}

/**
 * The moved document's own `relations`: an entry written relative to its old
 * folder (or pointing at itself) is rewritten if it would resolve elsewhere
 * from the new one.
 */
export function rebaseOwnRelations(
  raw: string,
  relations: unknown,
  oldId: string,
  newId: string,
  knownIds: ReadonlySet<string>,
  wikiDir: string
): RelationEditResult {
  const after = new Set(knownIds);
  after.delete(oldId);
  after.add(newId);
  return editRelationEntries(raw, relations, (entry) => {
    const target = normalizeRelationTarget(entry, wikiDir);
    if (target === null) return null;
    const before = resolveLinkTarget(target, oldId, knownIds);
    if (before === null) return null;
    const want = before === oldId ? newId : before;
    if (resolveLinkTarget(target, newId, after) === want) return null;
    const next = retarget(entry, newId, want, wikiDir);
    const check = next === undefined ? null : normalizeRelationTarget(next, wikiDir);
    return next !== undefined && check !== null && resolveLinkTarget(check, newId, after) === want ? next : undefined;
  });
}
