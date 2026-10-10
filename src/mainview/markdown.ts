/**
 * Rendering for the preview pane: Markdown, and captured HTML.
 *
 * Note content is untrusted: files arrive from disk, from imports, and from
 * agents writing over MCP. This webview holds an RPC bridge to a process with
 * full filesystem authority, so rendering raw HTML from a note would turn any
 * downloaded vault into arbitrary local file access. Everything is therefore
 * built as DOM nodes and passed through an allowlist before display.
 *
 * Captured HTML pages go through the *same* allowlist. Being the file's own
 * markup rather than something a Markdown note embedded makes it no more
 * trustworthy — it is a third-party page that was copied in verbatim, which is
 * the least trustworthy content in the bundle.
 */

import { Marked } from "marked";
import { WIKILINK_SCHEME, expandWikilinks } from "../shared/okf/links";
import { escapeHtml } from "./dom";

/**
 * Elements that may be displayed. Anything else is unwrapped to its text.
 *
 * The first rows are what Marked emits. The rest are what real pages use: they
 * carry no behaviour, and unwrapping them would flatten a captured document's
 * structure into one long run of text.
 */
const ALLOWED_TAGS = new Set([
  "A", "P", "BR", "HR", "EM", "STRONG", "DEL", "CODE", "PRE", "BLOCKQUOTE",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI",
  "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "IMG", "MARK", "SPAN", "INPUT",
  // Markdown has no alignment syntax, so the toolbar emits <div align> — the
  // one form GitHub, Obsidian, VS Code and pandoc all honour.
  "DIV",
  // Structure a captured page relies on.
  "SECTION", "ARTICLE", "HEADER", "FOOTER", "NAV", "ASIDE", "MAIN",
  "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "CAPTION", "TFOOT",
  // Inline typography with no Markdown equivalent.
  "B", "I", "U", "S", "SMALL", "SUB", "SUP", "ABBR", "CITE", "Q", "TIME",
  "KBD", "SAMP", "VAR",
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

/**
 * Elements removed outright rather than unwrapped.
 *
 * Two reasons, both of which make the *content* the problem:
 *
 *   - It executes or embeds (`script`, `iframe`, `object`).
 *   - It is a document's plumbing (`head`, `title`, `meta`, `noscript`), whose
 *     text is not part of the page and reads as garbage when spilled into it —
 *     a captured page would otherwise open with its `<title>` and its "enable
 *     JavaScript" notice as body prose.
 *
 * `svg` and `math` are here because they are foreign content: they parse under
 * different rules, and case-folding a foreign tag name to match an allowlist is
 * how sanitizers get walked around. A captured page loses its inline diagrams;
 * that is the right trade for a webview holding a filesystem bridge.
 */
const DROP_ENTIRELY = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE",
  "HEAD", "TITLE", "META", "LINK", "BASE", "NOSCRIPT",
  "FRAME", "FRAMESET", "SVG", "MATH", "CANVAS", "AUDIO", "VIDEO", "SOURCE",
]);

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

    // `input` is allowed for one reason: Markdown task lists render as disabled
    // checkboxes. A captured page's login form has no such claim — its fields
    // would render as live, focusable inputs in a document that is supposed to
    // be something you read.
    if (tag === "INPUT" && element.getAttribute("type")?.toLowerCase() !== "checkbox") {
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
 * Parse HTML into a sanitized fragment.
 *
 * `<template>` parsing keeps the markup inert — nothing loads, nothing runs —
 * and the nodes are then moved into the page rather than re-serialised, so
 * there is no second parse for a mutation-XSS payload to be re-read by.
 */
function toFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitize(template.content);
  return template.content;
}

/**
 * Tag every link with what it points at, so the host can intercept navigation
 * rather than letting the webview follow it.
 */
function wireLinks(fragment: DocumentFragment): void {
  for (const anchor of Array.from(fragment.querySelectorAll("a[href]"))) {
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
}

/** Render Markdown to a sanitized DOM fragment. */
export function renderMarkdown(source: string): DocumentFragment {
  const fragment = toFragment(marked.parse(expandWikilinks(source), { async: false }) as string);
  wireLinks(fragment);
  return fragment;
}

/**
 * Render a captured HTML document to a sanitized DOM fragment.
 *
 * The source is the file itself, not Markdown output, so it goes straight to
 * the parser — but through the same allowlist, and with links wired the same
 * way. Wikilinks are not expanded: `[[…]]` is Markdown syntax, and a captured
 * page that happens to contain double brackets means nothing by them.
 *
 * A whole document is fine as input: fragment parsing ignores the
 * `<html>`/`<head>`/`<body>` wrappers and keeps what was inside them, and the
 * head's own contents — `<title>`, `<meta>`, `<style>` — are then dropped as
 * plumbing, leaving the part of the page that was worth capturing.
 */
export function renderHtml(source: string): DocumentFragment {
  const fragment = toFragment(source);
  wireLinks(fragment);
  return fragment;
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
