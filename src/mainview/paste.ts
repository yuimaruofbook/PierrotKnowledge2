/**
 * Pasting from other tools.
 *
 * A browser, Notion or Word puts two things on the clipboard: `text/plain`,
 * which is the formatting flattened away, and `text/html`, which still has the
 * structure. Reading only the plain flavour is why headings, lists, links and
 * tables arrived as undifferentiated prose.
 *
 * This module is the *mechanism*: turning clipboard HTML back into Markdown.
 * The policy — which flavour to prefer — lives in `shared/paste.ts`, which has
 * no DOM dependency and can be tested directly.
 *
 * Conversion is the one place where being liberal is right: real clipboard HTML
 * from Notion, Google Docs and Word is deeply nested, style-laden and often
 * invalid.
 */

import TurndownService from "turndown";
import {
  decidePaste,
  type PasteDecision,
  type PasteMode,
  type PasteSource,
} from "../shared/paste";
import { gfm } from "turndown-plugin-gfm";

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, "");
}

function createConverter(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx", // `## x`, matching what this app writes
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });

  service.use(gfm); // tables, strikethrough, task lists

  // Elements that carry no content worth keeping.
  service.remove(["script", "style", "head", "meta", "link", "noscript", "title"]);

  /**
   * One space after the list marker, not three.
   *
   * Turndown's default (`-   item`, four-space continuation) is valid Markdown
   * but does not match what this app writes by hand, so a file would end up
   * with two list styles depending on how each line got there.
   */
  service.addRule("tightListItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/gm, "\n  "); // continuation lines align under the text

      const parent = node.parentNode as HTMLElement | null;
      let prefix = `${options.bulletListMarker} `;

      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? 1);
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      }

      const trailing = node.nextSibling && !/\n$/.test(body) ? "\n" : "";
      return prefix + body + trailing;
    },
  });

  /**
   * Google Docs and Word mark bold/italic with inline styles rather than
   * `<b>`/`<i>`, so the structure is invisible to the default rules.
   */
  service.addRule("styledEmphasis", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      /font-weight:\s*(bold|[6-9]00)|font-style:\s*italic/i.test(
        node.getAttribute("style") ?? ""
      ),
    replacement: (content, node) => {
      if (!content.trim()) return content;
      const style = (node as HTMLElement).getAttribute("style") ?? "";
      const bold = /font-weight:\s*(bold|[6-9]00)/i.test(style);
      const italic = /font-style:\s*italic/i.test(style);
      let out = content;
      if (italic) out = `*${out}*`;
      if (bold) out = `**${out}**`;
      return out;
    },
  });

  /**
   * Keep a bare image as a Markdown image only when it has a usable source.
   * Notion and Docs emit `<img>` with blob: or data: URLs that mean nothing
   * once pasted, so those become their alt text instead of a broken embed.
   */
  service.addRule("safeImages", {
    filter: "img",
    replacement: (_content, node) => {
      const element = node as HTMLImageElement;
      const src = element.getAttribute("src") ?? "";
      const alt = element.getAttribute("alt") ?? "";
      if (!src || /^(blob:|data:)/i.test(src)) return alt;
      return `![${alt}](${src})`;
    },
  });

  return service;
}

let converter: TurndownService | null = null;

/** Convert clipboard HTML into Markdown. */
export function htmlToMarkdown(html: string): string {
  converter ??= createConverter();
  const markdown = converter.turndown(stripNoise(html));
  // Collapse the runs of blank lines that nested wrappers leave behind.
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Keep clipboard HTML as HTML, minus the wrapper the source put around it.
 *
 * What a browser or Word puts on `text/html` is a fragment wrapped in a charset
 * `<meta>`, Office's `<!--StartFragment-->` markers and often a whole
 * stylesheet. None of that is the content, and the stylesheet in particular
 * would be dropped at render time anyway — so it is removed here rather than
 * written into the file.
 *
 * The markup that remains is *not* trusted by anything downstream: it is stored
 * as text and sanitised when rendered, the same as any other captured HTML.
 */
export function keepHtml(html: string): string {
  return stripNoise(html)
    .replace(/<\/?(html|body|meta|link|base)\b[^>]*>/gi, "")
    .trim();
}

/** Read both clipboard flavours from a paste event. */
export function readClipboard(data: DataTransfer | null): PasteSource {
  return {
    html: data?.getData("text/html") || null,
    text: data?.getData("text/plain") ?? "",
  };
}

/** Decide what to insert, using the Turndown-backed converters. */
export function decidePasteContent(source: PasteSource, mode: PasteMode = "auto"): PasteDecision {
  return decidePaste(source, { markdown: htmlToMarkdown, html: keepHtml }, mode);
}
