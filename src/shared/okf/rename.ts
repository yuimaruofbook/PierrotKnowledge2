/**
 * Rewriting links when a concept moves.
 *
 * Renaming a page in a wiki is only safe if every reference follows it.
 * Without this, a rename silently breaks the graph — the failure mode that
 * makes people stop reorganising their notes at all.
 *
 * Rewrites operate on the source text so that formatting, spacing and link
 * style are all preserved: a `[[wikilink]]` stays a wikilink, a relative
 * Markdown link stays relative to its own directory.
 */

import { maskCode, resolveLinkTarget } from "./links";

export interface RenameEdit {
  /** Concept id of the document being edited. */
  id: string;
  /** Rewritten body. */
  body: string;
  /** How many references changed. */
  count: number;
}

/** Relative path from one concept id's directory to another concept id. */
export function relativeIdPath(fromId: string, toId: string): string {
  const fromParts = fromId.split("/").slice(0, -1);
  const toParts = toId.split("/");
  const toName = toParts.pop()!;

  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }

  const up = fromParts.length - common;
  const down = toParts.slice(common);
  const segments = [...Array<string>(up).fill(".."), ...down, toName];
  const path = segments.join("/");

  // A bare name would read as a sibling anyway, but an explicit `./` makes the
  // intent unambiguous to both readers and other Markdown tools.
  return up === 0 && down.length === 0 ? `./${path}` : path;
}

const WIKILINK_RE = /\[\[([^\[\]|#]+)((?:#[^\[\]|]*)?)((?:\|[^\[\]]*)?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]]*)\]\(\s*<?([^)<>\s]+)>?((?:\s+"[^"]*")?)\s*\)/g;

/**
 * Rewrite every link in `body` that resolves to `oldId` so it points at `newId`.
 *
 * `knownIds` must describe the state *before* the move, so that the same
 * resolution rules that made a link point at the old id are used to decide
 * whether it needs updating.
 */
export function rewriteLinks(
  body: string,
  fromId: string,
  oldId: string,
  newId: string,
  knownIds: ReadonlySet<string>
): { body: string; count: number } {
  if (oldId === newId) return { body, count: 0 };

  const masked = maskCode(body);
  let count = 0;

  // Edits are collected against the masked copy and applied to the original by
  // offset, so links inside fenced code are never touched.
  const edits: Array<{ start: number; end: number; text: string }> = [];

  for (const match of masked.matchAll(WIKILINK_RE)) {
    const target = (match[1] ?? "").trim();
    if (resolveLinkTarget(target, fromId, knownIds) !== oldId) continue;

    const fragment = match[2] ?? "";
    const label = match[3] ?? "";
    // A bare `[[old]]` with no label would silently change its displayed text
    // on rename, so the old name is preserved as an explicit label.
    const keepsLabel = label ? label : `|${target}`;
    const replacement = `[[${newId}${fragment}${keepsLabel}]]`;

    edits.push({ start: match.index!, end: match.index! + match[0].length, text: replacement });
    count++;
  }

  for (const match of masked.matchAll(MDLINK_RE)) {
    if (match[1]) continue; // image embed
    const target = (match[3] ?? "").trim();
    if (resolveLinkTarget(target, fromId, knownIds) !== oldId) continue;

    const fragment = target.includes("#") ? `#${target.split("#").slice(1).join("#")}` : "";
    const next = `${relativeIdPath(fromId, newId)}.md${fragment}`;
    const replacement = `[${match[2] ?? ""}](${next}${match[4] ?? ""})`;

    edits.push({ start: match.index!, end: match.index! + match[0].length, text: replacement });
    count++;
  }

  if (edits.length === 0) return { body, count: 0 };

  edits.sort((a, b) => b.start - a.start);
  let next = body;
  for (const edit of edits) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }

  return { body: next, count };
}

/**
 * Rewrite a document's *own* relative links after it moves.
 *
 * Its wikilinks are unaffected (they address ids, not paths), but every
 * relative Markdown link was written from the old directory and would
 * otherwise point somewhere else — or nowhere.
 */
export function rebaseOwnLinks(
  body: string,
  oldId: string,
  newId: string,
  knownIds: ReadonlySet<string>
): { body: string; count: number } {
  const oldDir = oldId.split("/").slice(0, -1).join("/");
  const newDir = newId.split("/").slice(0, -1).join("/");
  if (oldDir === newDir) return { body, count: 0 };

  const masked = maskCode(body);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let count = 0;

  for (const match of masked.matchAll(MDLINK_RE)) {
    if (match[1]) continue;
    const target = (match[3] ?? "").trim();
    const resolved = resolveLinkTarget(target, oldId, knownIds);
    if (!resolved || resolved === oldId) continue;

    const fragment = target.includes("#") ? `#${target.split("#").slice(1).join("#")}` : "";
    const next = `${relativeIdPath(newId, resolved)}.md${fragment}`;
    edits.push({
      start: match.index!,
      end: match.index! + match[0].length,
      text: `[${match[2] ?? ""}](${next}${match[4] ?? ""})`,
    });
    count++;
  }

  if (edits.length === 0) return { body, count: 0 };

  edits.sort((a, b) => b.start - a.start);
  let next = body;
  for (const edit of edits) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }

  return { body: next, count };
}
