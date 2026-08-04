/**
 * Choosing which clipboard flavour to insert.
 *
 * A browser, Notion or Word puts two things on the clipboard: `text/plain`,
 * which is the formatting already flattened away, and `text/html`, which still
 * has the structure. Taking only the plain flavour is why pasted headings,
 * lists, links and tables arrived as undifferentiated prose.
 *
 * The *policy* lives here, free of the DOM, because getting it wrong silently
 * mangles someone's paste. The HTML→Markdown *mechanism* needs a DOM and lives
 * in the view layer.
 */

/** Markdown signals strong enough to mean "this text is already Markdown". */
const MARKDOWN_SIGNALS: RegExp[] = [
  /^```/m, // fenced code
  /^#{1,6}\s+\S/m, // ATX heading
  /\[[^\]]*\]\([^)]*\)/, // inline link
  /^\s*[-*+]\s+\[[ xX]\]/m, // task list
  /^\s*>\s+\S/m, // blockquote
  /\[\[[^\]]+\]\]/, // wikilink
  /^---\r?\n[\s\S]*?\r?\n---/, // frontmatter
];

/**
 * Whether the plain-text flavour should win over the HTML one.
 *
 * Copying out of another Markdown editor puts the *source* on `text/plain` and
 * syntax-highlighted `<span>` soup on `text/html`. Converting that HTML
 * produces mangled output, so text that is already Markdown is taken verbatim.
 *
 * A bare `- item` list is deliberately not a signal: Notion's plain flavour
 * uses it too, so it cannot distinguish the two cases.
 */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_SIGNALS.some((pattern) => pattern.test(text));
}

export interface PasteSource {
  /** `text/html` from the clipboard, if the source offered it. */
  html: string | null;
  /** `text/plain` from the clipboard. */
  text: string;
}

export interface PasteDecision {
  markdown: string;
  /** Which flavour was used — surfaced in the status bar so it is not a mystery. */
  from: "html" | "text";
}

/**
 * Decide what to insert.
 *
 * `convert` is injected so this stays testable without a DOM. `forcePlain` is
 * the escape hatch for when the heuristic guesses wrong; it is bound to the
 * Ctrl+Shift+V that every editor uses for "paste without formatting".
 */
export function decidePaste(
  source: PasteSource,
  convert: (html: string) => string,
  forcePlain = false
): PasteDecision {
  if (forcePlain || !source.html?.trim()) {
    return { markdown: source.text, from: "text" };
  }

  if (source.text.trim() && looksLikeMarkdown(source.text)) {
    return { markdown: source.text, from: "text" };
  }

  const converted = convert(source.html);
  // HTML that carries no more than the plain text is not worth preferring.
  if (!converted.trim()) return { markdown: source.text, from: "text" };

  return { markdown: converted, from: "html" };
}
