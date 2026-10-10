/**
 * Recognising HTML, so it can be captured and shown as HTML.
 *
 * Material arrives as HTML more often than as Markdown: a page fetched over
 * MCP, a browser's clipboard, a saved `.html` on disk. Converting all of it to
 * Markdown loses whatever Markdown has no syntax for, and storing it as `.md`
 * means the reader sees tags instead of a document.
 *
 * The *policy* — is this HTML? — lives here, free of the DOM, because both the
 * capture side (Bun) and the display side (webview) have to agree on it and a
 * wrong answer is silent: prose stored as markup, or markup stored as prose.
 * Rendering is a separate concern and needs a DOM (`mainview/markdown.ts`).
 */

import { looksLikeMarkdown } from "./paste";

/**
 * Escape text for insertion into markup.
 *
 * Lives here rather than in the view layer because both sides need it: the
 * webview builds snippets, and the capture side writes a provenance header
 * around a title and arguments that came from a remote server.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Extensions that name an HTML file. `.xhtml` included: browsers save it. */
const HTML_EXT_RE = /\.(x?html|htm)$/i;

export function isHtmlPath(path: string): boolean {
  return HTML_EXT_RE.test(path);
}

/**
 * Tags that only appear in an actual HTML document, never in a note.
 *
 * A `<div>` is something a Markdown file may legitimately contain; a `<body>`
 * is not — nothing produces one except a document.
 */
const DOCUMENT_SIGNAL_RE = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i;

/**
 * How far in the document signal is looked for.
 *
 * A captured page opens with its doctype or `<html>`; a note that merely
 * *mentions* `<html>` does so in prose or a code fence, further down. Bounding
 * the search is what keeps those apart, and keeps this cheap on large pages.
 */
const PREAMBLE_CHARS = 1024;

/** Noise that can precede the doctype without meaning anything. */
const PREAMBLE_NOISE_RE = /^(\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)+/;

/**
 * Block-level structure. Inline tags are deliberately absent: a note with a
 * `<br>` or a `<sub>` in it is a note.
 */
const BLOCK_TAG_RE =
  /<(p|div|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|h[1-6]|article|section|main|header|footer|nav|aside|blockquote|pre|figure)\b[^>]*>/gi;

const CLOSING_BLOCK_RE =
  /<\/(p|div|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|h[1-6]|article|section|main|header|footer|nav|aside|blockquote|pre|figure)\s*>/i;

/**
 * Structure needed before a fragment counts as HTML.
 *
 * One tag is an ornament inside prose. Three nested block elements with their
 * closing tags is a document fragment someone exported.
 */
const BLOCK_TAGS_REQUIRED = 3;

/**
 * Whether text should be treated as HTML rather than Markdown.
 *
 * Two independent grounds, in order:
 *
 *   1. **A document signal near the top.** Decisive on its own — a captured page
 *      is HTML even when its body contains a code sample full of `#` and `-`.
 *   2. **Enough block structure, and no Markdown.** A fragment is only HTML if
 *      Markdown does not explain it better: notes embed `<div align>` and raw
 *      tables all the time, and those files are still notes.
 */
export function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const preamble = trimmed.replace(PREAMBLE_NOISE_RE, "").slice(0, PREAMBLE_CHARS);
  if (DOCUMENT_SIGNAL_RE.test(preamble)) return true;

  const blocks = trimmed.match(BLOCK_TAG_RE)?.length ?? 0;
  if (blocks < BLOCK_TAGS_REQUIRED) return false;
  if (!CLOSING_BLOCK_RE.test(trimmed)) return false;

  return !looksLikeMarkdown(trimmed);
}
