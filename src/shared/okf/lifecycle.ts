/**
 * Lifecycle tags: `Product` and `DEAD`.
 *
 * PARA says how *current* a note is; lifecycle says what *kind of status* it
 * has. A Product concept is the finished, trusted output (a shipped spec, a
 * final answer), and a DEAD concept is retired material that must stop
 * showing up in an agent's context without being deleted — so the history, the
 * links to it and the human's ability to find it all survive.
 *
 * Stored as ordinary frontmatter tags rather than a new field, so the tag
 * filters, the tag list and every other tool already see them. Matching is
 * case-sensitive: only exactly `Product` and `DEAD` count, because a bundle
 * may already use `product` or `dead` for something else and must not change
 * behaviour. Writing uses the canonical spelling.
 *
 * Pure and DOM-free.
 */

import { splitFrontmatter } from "./frontmatter";

export type Lifecycle = "product" | "dead";
export type LifecycleChoice = Lifecycle | "none";

/** The canonical tag written for each lifecycle. */
export const LIFECYCLE_TAGS: Record<Lifecycle, string> = {
  product: "Product",
  dead: "DEAD",
};

/**
 * Ranking factor for a Product concept.
 *
 * It multiplies the BM25 score like a PARA weight, but is deliberately smaller
 * than one PARA step (resource 1.0 → area 1.2): a nudge that settles ties
 * between comparable matches in favour of the finished page, never one that
 * lets a Product note outrank a clearly better match or jump a priority class.
 */
export const PRODUCT_WEIGHT = 1.1;

/** ASCII-only lower-casing, for tolerant parsing of an agent's choice. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function lifecycleOfTag(tag: unknown): Lifecycle | null {
  if (tag === LIFECYCLE_TAGS.dead) return "dead";
  if (tag === LIFECYCLE_TAGS.product) return "product";
  return null;
}

/**
 * The lifecycle a tag list expresses.
 *
 * A hand-edited concept can carry both tags; DEAD wins, because the cost of
 * wrongly hiding a note is a lookup with `include_dead`, while wrongly
 * surfacing retired material is silent.
 */
export function lifecycleOf(tags: readonly unknown[] | undefined): LifecycleChoice {
  let found: LifecycleChoice = "none";
  for (const tag of tags ?? []) {
    const lifecycle = lifecycleOfTag(tag);
    if (lifecycle === "dead") return "dead";
    if (lifecycle === "product") found = "product";
  }
  return found;
}

/** Ranking multiplier for a tag list (1 unless Product). */
export function lifecycleWeight(tags: readonly unknown[] | undefined): number {
  return lifecycleOf(tags) === "product" ? PRODUCT_WEIGHT : 1;
}

/**
 * The tag list after setting a lifecycle.
 *
 * Both lifecycle tags are removed first (a concept is never both), then the
 * canonical one is put back — in the place the first matching tag held, so the
 * author's tag order is kept. Other tags (`product`, `dead`, non-strings) are
 * left exactly as they were.
 */
export function withLifecycle(tags: readonly unknown[], to: LifecycleChoice): unknown[] {
  const out: unknown[] = [];
  let placed = false;

  for (const tag of tags) {
    const lifecycle = lifecycleOfTag(tag);
    if (lifecycle === null) {
      out.push(tag);
      continue;
    }
    if (lifecycle === to && !placed) {
      out.push(LIFECYCLE_TAGS[to]);
      placed = true;
    }
  }

  if (to !== "none" && !placed) out.push(LIFECYCLE_TAGS[to]);
  return out;
}

/** Parse an agent-supplied choice, tolerantly. */
export function parseLifecycle(value: string): LifecycleChoice | null {
  const key = asciiLower(value.trim());
  return key === "product" || key === "dead" || key === "none" ? key : null;
}

// ---- raw frontmatter edit ---------------------------------------------------

/** One element of the new tag list: an original item to keep, or new text. */
type Slot = number | string;

/**
 * Which original items survive in `withLifecycle(current, to)`, in order.
 *
 * A lifecycle tag already in the list keeps its own raw text (quotes and
 * all); only a tag that is new is written as the bare canonical spelling.
 */
function planSlots(current: readonly unknown[], to: LifecycleChoice): Slot[] {
  const kept: number[] = [];
  current.forEach((tag, i) => {
    if (lifecycleOfTag(tag) === null) kept.push(i);
  });
  const used = new Set<number>();
  let next = 0;
  const slots: Slot[] = [];
  for (const tag of withLifecycle(current, to)) {
    if (lifecycleOfTag(tag) === null) {
      slots.push(kept[next++]!);
      continue;
    }
    const at = current.findIndex((c, i) => c === tag && !used.has(i));
    if (at >= 0) used.add(at);
    slots.push(at >= 0 ? at : (tag as string));
  }
  return slots;
}

const TAGS_KEY_RE = /^(?:tags|"tags"|'tags')[ \t]*:/;
const BLANK_OR_COMMENT_RE = /^[ \t]*(?:#.*)?$/;

const stripEol = (line: string) => line.replace(/\r?\n$/, "");
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Walk a flow sequence from its opening `[`, reporting where each top-level
 * item ends and where the sequence closes.
 *
 * A quote only opens a string at the start of an item: an apostrophe inside a
 * plain scalar (`don't`) is just a character.
 */
function scanFlow(text: string, open: number): { close: number; items: string[] } | null {
  let depth = 0;
  let quote = "";
  let itemStart = false;
  let from = open + 1;
  const items: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if ((c === '"' || c === "'") && itemStart) {
      quote = c;
      itemStart = false;
    } else if (c === "[" || c === "{") {
      depth++;
      itemStart = true;
    } else if (c === "]" || c === "}") {
      if (--depth === 0) {
        const last = text.slice(from, i).trim();
        if (last) items.push(last);
        return { close: i, items };
      }
    } else if (c === "," && depth === 1) {
      items.push(text.slice(from, i).trim());
      from = i + 1;
      itemStart = true;
    } else if (!isSpace(c)) {
      itemStart = false;
    }
  }
  return null;
}

/**
 * The file text with a lifecycle applied to its `tags` entry, and nothing
 * else touched.
 *
 * Re-serialising the whole frontmatter would drop comments and change
 * quoting (`version: 1.10` becomes `1.1`). This edits only the lines of the
 * `tags` entry (flow `[a, b]`, block `- a`, or absent) and leaves every other
 * byte as written. `null` means the entry has a shape it cannot edit safely
 * (an alias, a comment inside a multi-line list, items it cannot count); the
 * caller refuses rather than guess.
 *
 * `current` is the parsed tag list, used to check that the raw items counted
 * here are the ones the YAML parser saw.
 */
export function setLifecycleInDocument(
  raw: string,
  current: readonly unknown[],
  to: LifecycleChoice
): string | null {
  const bom = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fence = /^---[ \t]*\r?\n/.exec(raw.slice(bom));
  const { yaml, eol } = splitFrontmatter(raw);
  if (!fence || yaml === null) return null;
  const start = bom + fence[0].length;

  const edited = editTagsYaml(yaml, eol, current, to);
  return edited === null ? null : raw.slice(0, start) + edited + raw.slice(start + yaml.length);
}

function editTagsYaml(
  yaml: string,
  eol: string,
  current: readonly unknown[],
  to: LifecycleChoice
): string | null {
  const slots = planSlots(current, to);
  const lines = yaml.split(/(?<=\n)/);
  const flowOf = (items: string[]) => `[${items.join(", ")}]`;
  const endsWithNewline = /\n$/.test(lines[lines.length - 1]!);

  /** Replace lines [from, until) with `text` (no final newline); "" deletes them. */
  const splice = (from: number, until: number, text: string): string => {
    const atEof = until >= lines.length && !endsWithNewline;
    let out = lines.slice(0, from).join("");
    if (text) out += text + (atEof ? "" : eol);
    else if (atEof) out = out.replace(/\r?\n$/, "");
    return out + lines.slice(until).join("");
  };

  const keyAt = lines.findIndex((l) => TAGS_KEY_RE.test(l));
  if (keyAt < 0) {
    if (slots.length === 0) return yaml;
    return `${yaml}${endsWithNewline ? "" : eol}tags: ${flowOf(slots as string[])}`;
  }

  const keyLine = stripEol(lines[keyAt]!);
  const colon = keyLine.indexOf(":");
  const rest = keyLine.slice(colon + 1);
  const value = rest.trimStart();
  const valueAt = colon + 1 + (rest.length - value.length);
  const lineOffset = lines.slice(0, keyAt).reduce((n, l) => n + l.length, 0);

  if (value.startsWith("[")) {
    const open = lineOffset + valueAt;
    const flow = scanFlow(yaml, open);
    if (!flow) return null;

    let end = keyAt;
    let endStart = lineOffset;
    while (endStart + lines[end]!.length <= flow.close) endStart += lines[end++]!.length;
    const suffix = stripEol(lines[end]!).slice(flow.close - endStart + 1);
    if (!BLANK_OR_COMMENT_RE.test(suffix)) return null;

    const inner = yaml.slice(open + 1, flow.close);
    if (inner.includes("\n") && inner.includes("#")) return null;
    if (flow.items.length !== current.length) return null;
    if (slots.length === 0) return splice(keyAt, end + 1, "");
    const items = slots.map((s) => (typeof s === "number" ? flow.items[s]! : s));
    return splice(keyAt, end + 1, keyLine.slice(0, valueAt) + flowOf(items) + suffix);
  }

  const commentAt = value.search(/(?:^|[ \t])#/);
  const bare = (commentAt < 0 ? value : value.slice(0, commentAt)).trim();
  if (bare !== "" && bare !== "~" && bare !== "null") return null;
  const comment = commentAt < 0 ? "" : ` ${value.slice(commentAt).trimStart()}`;

  // Block items follow only when the value itself is empty.
  const groups: Array<{ from: number; until: number }> = [];
  let indent = "";
  let lastBody = keyAt;
  for (let i = keyAt + 1; bare === "" && i < lines.length; i++) {
    const text = stripEol(lines[i]!);
    if (BLANK_OR_COMMENT_RE.test(text)) continue;
    const item = /^([ \t]*)-(?:[ \t]|$)/.exec(text);
    if (item && (groups.length === 0 || item[1] === indent)) {
      if (groups.length === 0) indent = item[1]!;
      groups.push({ from: i, until: i + 1 });
    } else if (groups.length === 0 || text.length - text.trimStart().length <= indent.length) {
      break;
    }
    lastBody = i;
  }
  // Comments between two items stay with the item above them.
  groups.forEach((g, i) => (g.until = i + 1 < groups.length ? groups[i + 1]!.from : lastBody + 1));

  if (groups.length !== current.length) return null;
  if (groups.length === 0) {
    if (slots.length === 0) return yaml;
    return splice(keyAt, keyAt + 1, `${keyLine.slice(0, colon + 1)} ${flowOf(slots as string[])}${comment}`);
  }
  if (slots.length === 0) return splice(keyAt, lastBody + 1, "");

  const terminated = (line: string) => (/\n$/.test(line) ? line : line + eol);
  const block = slots
    .map((s) =>
      typeof s === "string"
        ? `${indent}- ${s}${eol}`
        : lines.slice(groups[s]!.from, groups[s]!.until).map(terminated).join("")
    )
    .join("")
    .replace(/\r?\n$/, "");
  return splice(keyAt + 1, lastBody + 1, block);
}
