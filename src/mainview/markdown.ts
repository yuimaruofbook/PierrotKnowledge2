/**
 * Markdown rendering for the preview pane.
 *
 * Note content is untrusted: files arrive from disk, from imports, and from
 * agents writing over MCP. This webview holds an RPC bridge to a process with
 * full filesystem authority, so rendering raw HTML from a note would turn any
 * downloaded vault into arbitrary local file access. Everything is therefore
 * built as DOM nodes and passed through an allowlist before display.
 */

import { Marked } from "marked";
import { WIKILINK_SCHEME, expandWikilinks } from "../shared/okf/links";
import { escapeHtml } from "./dom";

/** Elements a note may produce. Anything else is unwrapped to its text. */
const ALLOWED_TAGS = new Set([
  "A", "P", "BR", "HR", "EM", "STRONG", "DEL", "CODE", "PRE", "BLOCKQUOTE",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
  "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "IMG", "MARK", "SPAN", "INPUT",
  // Markdown has no alignment syntax, so the toolbar emits <div align> — the
  // one form GitHub, Obsidian, VS Code and pandoc all honour.
  "DIV",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(["href", "title", "data-link", "data-target", "class"]),
  IMG: new Set(["src", "alt", "title"]),
  INPUT: new Set(["type", "checked", "disabled"]),
  SPAN: new Set(["class"]),
  CODE: new Set(["class"]),
  TH: new Set(["align"]),
  TD: new Set(["align"]),
  DIV: new Set(["align"]),
};

/** Values `align` may take. Anything else is dropped with the attribute. */
const ALIGN_VALUES = new Set(["left", "center", "right", "justify"]);

/** Elements whose *content* is dangerous, so they are removed outright. */
const DROP_ENTIRELY = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE"]);

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
/**
 * `okf-wiki:` is our own scheme, produced by `expandWikilinks` from `[[...]]`
 * and rewritten into `href="#"` plus data attributes immediately after
 * sanitising. It has to survive the allowlist or every wikilink loses its href
 * and stops being clickable.
 *
 * Letting note content write `[x](okf-wiki:y)` directly costs nothing: the
 * worst it can do is navigate to another note in the same bundle, which is
 * what an ordinary internal link already does.
 */
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "okf-wiki"]);
/** ASCII whitespace and control characters, which browsers ignore inside URLs. */
const URL_NOISE_RE = /[\u0000-\u0020\u007f]/g;

/**
 * Allow fragments, relative paths and a small set of schemes; reject the rest.
 *
 * The noise strip matters: browsers ignore control characters inside a URL, so
 * `java\tscript:alert(1)` is live unless the scheme is read from a cleaned
 * string rather than matched around.
 */
export function isSafeUrl(url: string): boolean {
  const cleaned = url.replace(URL_NOISE_RE, "");
  if (!cleaned) return false;
  if (cleaned.startsWith("#")) return true;
  const scheme = cleaned.match(SCHEME_RE);
  if (!scheme) return true; // relative path
  return SAFE_SCHEMES.has(scheme[1]!.toLowerCase());
}

const marked = new Marked({ gfm: true, breaks: false });

/**
 * Strip every node and attribute outside the allowlist, in place.
 *
 * Unknown elements are unwrapped rather than deleted so their text survives —
 * losing a paragraph because it was wrapped in an unrecognised tag would be a
 * worse failure than showing it unstyled.
 */
function sanitize(root: ParentNode): void {
  const doomed: Element[] = [];

  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tag = element.tagName.toUpperCase();

    if (!ALLOWED_TAGS.has(tag)) {
      doomed.push(element);
      continue;
    }

    const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (!allowed.has(name)) {
        element.removeAttribute(attr.name);
        continue;
      }
      // `align` is allowlisted by value too: an attribute whose value lands in
      // a style context must never carry whatever the note author typed.
      if (name === "align" && !ALIGN_VALUES.has(attr.value.toLowerCase())) {
        element.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && !isSafeUrl(attr.value)) {
        element.removeAttribute(attr.name);
      }
    }
  }

  for (const element of doomed) {
    if (DROP_ENTIRELY.has(element.tagName.toUpperCase())) element.remove();
    else element.replaceWith(...Array.from(element.childNodes));
  }
}

/**
 * Render Markdown to a sanitized DOM fragment.
 *
 * Internal links are tagged with `data-link` and their target so the host can
 * intercept navigation rather than letting the webview follow it.
 */
export function renderMarkdown(source: string): DocumentFragment {
  const html = marked.parse(expandWikilinks(source), { async: false }) as string;

  const template = document.createElement("template");
  template.innerHTML = html;
  sanitize(template.content);

  for (const anchor of Array.from(template.content.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href") ?? "";

    if (href.startsWith(WIKILINK_SCHEME)) {
      anchor.setAttribute("data-link", "wikilink");
      anchor.setAttribute("data-target", decodeURIComponent(href.slice(WIKILINK_SCHEME.length)));
      anchor.setAttribute("href", "#");
      anchor.classList.add("wikilink");
      continue;
    }

    if (/^https?:/i.test(href)) {
      anchor.setAttribute("data-link", "external");
      continue;
    }

    anchor.setAttribute("data-link", "internal");
    anchor.setAttribute("data-target", href);
    anchor.setAttribute("href", "#");
  }

  return template.content;
}

/**
 * Render an FTS5 snippet, which arrives as document text with `<mark>` markers.
 *
 * The surrounding text is untrusted, so it is escaped first and only the
 * markers SQLite was asked to insert are turned back into elements.
 */
export function renderSnippet(snippet: string): string {
  return escapeHtml(snippet)
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}
