/**
 * Link extraction and resolution.
 *
 * OKF expresses relations as standard Markdown links; wiki-style `[[id]]` is
 * supported on top of that because it is what note-takers actually type. Both
 * resolve to the same concept-id space, so the graph is uniform.
 */

import type { ConceptLink } from "../types";
import { conceptIdFromRelPath } from "./concept";

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(`+)(?:[^`]|(?!\1)`)*\1/g;
const WIKILINK_RE = /\[\[([^\[\]|#]+)(?:#([^\[\]|]*))?(?:\|([^\[\]]*))?\]\]/g;
const MDLINK_RE = /(!?)\[([^\]]*)\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Blank out code spans and fenced blocks, replacing them with spaces so every
 * character offset and line number in the result still lines up with the
 * source. Callers match against the mask and edit the original by offset.
 *
 * Without this, every fenced example containing `[[foo]]` would pollute the
 * link graph — and a rename would rewrite links inside code samples.
 *
 * Scanned line by line rather than with one multiline regex: fences are a
 * line-oriented construct, and a regex spanning them needs a backreference and
 * a lazy body whose behaviour is hard to predict at the edges (a fence opening
 * on the very first line, or never closing at all).
 */
export function maskCode(body: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const lines = body.split("\n");
  /** The opening fence marker while inside a block, else null. */
  let fence: string | null = null;

  const masked = lines.map((line) => {
    const marker = line.match(FENCE_OPEN_RE)?.[1];

    if (fence === null) {
      if (marker) {
        fence = marker;
        return blank(line);
      }
      return line.replace(INLINE_CODE_RE, blank);
    }

    // A closing fence must use the same character and be at least as long.
    if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
    return blank(line);
  });

  return masked.join("\n");
}

export function isExternalTarget(target: string): boolean {
  return EXTERNAL_RE.test(target) || target.startsWith("#");
}

/** Normalise a POSIX-ish path, resolving `.` and `..` segments. */
function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

function stripFragment(target: string): string {
  return target.split("#")[0]!.split("?")[0]!;
}

function decode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/**
 * Resolve a link target to a concept id (OKF §6).
 *
 * The spec defines two forms: **absolute**, beginning with `/` and interpreted
 * from the bundle root, and **relative**, an ordinary Markdown path. The form
 * written decides how it resolves — a leading `/` is not a hint to be weighed
 * against alternatives. Resolving `./other.md` as bundle-absolute first would
 * silently point it at a different document whenever both exist.
 *
 * A bare wiki-style `[[name]]` is neither form, so it falls back to a *unique*
 * basename match anywhere in the bundle. Ambiguous names stay unresolved rather
 * than being guessed at.
 *
 * Broken links are not an error: §6 requires consumers to tolerate a target
 * that does not exist, since it may simply be knowledge not yet written.
 */
export function resolveLinkTarget(
  target: string,
  fromId: string,
  knownIds?: ReadonlySet<string>
): string | null {
  const raw = stripFragment(target).trim();
  if (!raw || isExternalTarget(target)) return null;

  const cleaned = decode(raw).replace(/\\/g, "/");
  if (!/\.(md|markdown)$/i.test(cleaned) && /\.[a-z0-9]+$/i.test(cleaned)) {
    // A link to a non-Markdown asset is a valid relation but not a concept.
    return null;
  }

  const withoutExt = conceptIdFromRelPath(cleaned);
  const isAbsolute = cleaned.startsWith("/");

  if (isAbsolute) {
    const absolute = normalizeSegments(withoutExt.replace(/^\//, ""));
    if (!knownIds) return absolute;
    return knownIds.has(absolute) ? absolute : null;
  }

  const fromDir = fromId.includes("/") ? fromId.slice(0, fromId.lastIndexOf("/")) : "";
  const relative = normalizeSegments(fromDir ? `${fromDir}/${withoutExt}` : withoutExt);

  if (!knownIds) return relative;
  if (knownIds.has(relative)) return relative;

  // Explicitly relative paths (`./x`, `../x`) mean what they say; only a bare
  // name may be a wikilink searching the whole bundle.
  const isExplicitlyRelative = /^\.{1,2}\//.test(cleaned);
  if (isExplicitlyRelative) return null;

  const bundleRooted = normalizeSegments(withoutExt);
  if (knownIds.has(bundleRooted)) return bundleRooted;

  if (!withoutExt.includes("/")) {
    const matches = [...knownIds].filter((id) => id.slice(id.lastIndexOf("/") + 1) === withoutExt);
    if (matches.length === 1) return matches[0]!;
  }

  return null;
}

/**
 * Extract every outbound link from a concept body.
 *
 * Image embeds (`![alt](src)`) are skipped: they are asset references, not
 * knowledge relations.
 */
export function extractLinks(
  body: string,
  fromId: string,
  knownIds?: ReadonlySet<string>
): ConceptLink[] {
  const masked = maskCode(body);
  const links: ConceptLink[] = [];
  const seen = new Set<string>();

  const push = (link: ConceptLink) => {
    const key = `${link.kind}:${link.target}:${link.label ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  for (const m of masked.matchAll(WIKILINK_RE)) {
    const target = (m[1] ?? "").trim();
    if (!target) continue;
    const label = m[3]?.trim();
    push({
      target,
      ...(label ? { label } : {}),
      kind: "wikilink",
      resolved: resolveLinkTarget(target, fromId, knownIds),
    });
  }

  for (const m of masked.matchAll(MDLINK_RE)) {
    if (m[1]) continue; // image embed
    const target = (m[3] ?? "").trim();
    if (!target) continue;
    const label = (m[2] ?? "").trim();
    push({
      target,
      ...(label ? { label } : {}),
      kind: "markdown",
      resolved: resolveLinkTarget(target, fromId, knownIds),
    });
  }

  return links;
}

/** Invert an id → outbound-ids map into id → inbound-ids. */
export function buildBacklinks(
  graph: ReadonlyMap<string, readonly ConceptLink[]>
): Map<string, string[]> {
  const backlinks = new Map<string, string[]>();
  for (const [from, links] of graph) {
    for (const link of links) {
      if (!link.resolved || link.resolved === from) continue;
      const list = backlinks.get(link.resolved);
      if (list) {
        if (!list.includes(from)) list.push(from);
      } else {
        backlinks.set(link.resolved, [from]);
      }
    }
  }
  for (const list of backlinks.values()) list.sort();
  return backlinks;
}

/** Internal scheme used to smuggle a wikilink target through the parser. */
export const WIKILINK_SCHEME = "okf-wiki:";

/**
 * Rewrite `[[target|label]]` into a Markdown link carrying the raw target.
 *
 * Done before parsing so wikilinks inherit all of Marked's escaping, and so
 * fenced code is handled by the parser rather than by a second regex pass.
 */
export function expandWikilinks(source: string): string {
  // Matches are found against a copy with code blanked out, then applied to the
  // original by offset. Rewriting `[[x]]` inside backticks would leak the
  // internal scheme into documentation that is *about* wikilink syntax.
  const masked = maskCode(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];

  for (const match of masked.matchAll(WIKILINK_RE)) {
    const target = (match[1] ?? "").trim();
    if (!target) continue;
    const label = (match[3] ?? "").trim();
    const text = label || target;
    edits.push({
      start: match.index!,
      end: match.index! + match[0].length,
      text: `[${text}](${WIKILINK_SCHEME}${encodeURIComponent(target)})`,
    });
  }

  let out = source;
  for (const edit of edits.reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
