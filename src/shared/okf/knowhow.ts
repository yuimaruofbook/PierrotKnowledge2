/**
 * Know-how: short lessons one agent leaves for the next.
 *
 * Lighter than a skill. A skill is a procedure you open and follow; a
 * know-how note is one thing learned the hard way — a pitfall, a convention,
 * "this worked" — small enough that a context pack can offer the best three by
 * title alone. Each carries who recorded it, so a reader can weigh a lesson by
 * its source.
 *
 * Pure and DOM-free.
 */

import { isConceptPath } from "./concept";

/** Where know-how lives, inside the wiki layer. */
export const KNOWHOW_DIR = "knowhow";

/** The concept type of a know-how note. */
export const KNOWHOW_TYPE = "Knowhow";

/** Longest derived description, in code points. */
const DESCRIPTION_MAX = 140;

/** Windows device names: a file with one of these stems cannot be created there. */
const DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * A filename stem from a title.
 *
 * Unlike a loop name this keeps letters and digits of any script — the notes
 * are written in Japanese as often as English, and an ASCII-only slug would
 * collapse every Japanese title into the same fallback.
 *
 * A stem that would make the file something other than a plain concept
 * (`index`, `log`, `agents`, `map`, `human`, `task`: reserved or workspace
 * files, never indexed) or a Windows device name gets `-note` appended.
 */
export function knowhowSlug(title: string, max = 60): string {
  const slug = Array.from(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
  )
    .slice(0, max)
    .join("")
    .replace(/-+$/, "");
  const stem = slug || KNOWHOW_DIR;
  return !isConceptPath(`${stem}.md`) || DEVICE_NAME_RE.test(stem) ? `${stem}-note` : stem;
}

/**
 * One line summarising a body: its first meaningful line, markers stripped.
 *
 * Know-how is added with a title and a body only, but the pack and
 * `knowhow_find` show descriptions — deriving one keeps the call small without
 * leaving the entry undescribed.
 */
export function deriveDescription(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw
      .replace(/^[#>*\-\s]+/, "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    if (!line) continue;
    const chars = Array.from(line);
    return chars.length > DESCRIPTION_MAX ? `${chars.slice(0, DESCRIPTION_MAX).join("")}…` : line;
  }
  return "";
}

/** Heading of the folder's `index.md`. */
export const KNOWHOW_TITLE = "Know-how";
