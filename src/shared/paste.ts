/**
 * Choosing which clipboard flavour to insert.
 *
 * A browser, Notion or Word puts two things on the clipboard: `text/plain`,
 * which is the formatting already flattened away, and `text/html`, which still
 * has the structure. Taking only the plain flavour is why pasted headings,
 * lists, links and tables arrived as undifferentiated prose.
 *
 * The *policy* lives here, free of the DOM, because getting it wrong silently
 * mangles someone's paste. The conversion *mechanisms* need a DOM and live in
 * the view layer.
 *
 * Converting to Markdown is the default rather than the only option: the
 * clipboard's HTML is the richer flavour, and a file that is itself HTML has no
 * reason to give that up.
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
  content: string;
  /** Which flavour was used — surfaced in the status bar so it is not a mystery. */
  from: "html" | "text";
  /** What was inserted, which is not the same question as where it came from. */
  format: "markdown" | "html";
}

/**
 * How much say the user has taken over the choice.
 *
 *   - `auto` — the heuristic below decides.
 *   - `plain` — the escape hatch for when it guesses wrong, bound to the
 *     Ctrl+Shift+V that every editor uses for "paste without formatting".
 *   - `html` — keep the markup. Chosen deliberately (Ctrl+Alt+V), and the
 *     default when the open file *is* HTML, where converting the clipboard to
 *     Markdown would insert syntax that the file never renders.
 */
export type PasteMode = "auto" | "plain" | "html";

/** Both conversions, injected so this stays testable without a DOM. */
export interface PasteConverters {
  /** Clipboard HTML → Markdown. */
  markdown: (html: string) => string;
  /** Clipboard HTML → HTML worth keeping, with the wrapper noise removed. */
  html: (html: string) => string;
}

/** Nothing to keep from the HTML flavour; the plain one is what is left. */
function plain(source: PasteSource): PasteDecision {
  return { content: source.text, from: "text", format: "markdown" };
}

/** Decide what to insert. */
export function decidePaste(
  source: PasteSource,
  convert: PasteConverters,
  mode: PasteMode = "auto"
): PasteDecision {
  if (mode === "plain" || !source.html?.trim()) return plain(source);

  if (mode === "html") {
    const kept = convert.html(source.html);
    if (!kept.trim()) return plain(source);
    return { content: kept, from: "html", format: "html" };
  }

  if (source.text.trim() && looksLikeMarkdown(source.text)) return plain(source);

  const converted = convert.markdown(source.html);
  // HTML that carries no more than the plain text is not worth preferring.
  if (!converted.trim()) return plain(source);

  return { content: converted, from: "html", format: "markdown" };
}
