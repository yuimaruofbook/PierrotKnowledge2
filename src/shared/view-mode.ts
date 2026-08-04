/**
 * Which view a freshly opened file lands in.
 *
 * Reading, for anything with a rendered form. Opening a document into a raw
 * textarea shows the frontmatter, the link syntax and the markup before the
 * content, which is the wrong first impression of a page you came to read.
 * The layers this covers — `wiki/`, `raw/`, `.rag/` — are the whole bundle, so
 * it applies to everything the tree can open.
 *
 * Kept out of the editor and out of `main.ts` so it can be tested: it is a
 * one-line rule that is easy to change by accident and invisible when wrong.
 */

export type ViewMode = "edit" | "preview";

/** Extensions the Markdown renderer actually understands. */
const RENDERABLE = /\.(md|markdown)$/i;

export function initialViewMode(path: string, binary?: boolean): ViewMode {
  // Nothing to render either way: a binary file has no text at all, and a
  // non-Markdown text file put through the Markdown renderer comes out subtly
  // wrong — a JSON file's braces and quotes are not markup, and treating them
  // as such hides the content instead of presenting it.
  if (binary) return "edit";
  return RENDERABLE.test(path) ? "preview" : "edit";
}
