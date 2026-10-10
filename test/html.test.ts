/**
 * Recognising HTML.
 *
 * Two questions, both of which decide how a file is stored and shown: does this
 * path name an HTML file, and is this *text* HTML? The second is the one worth
 * testing hard — an MCP server that returns a web page and a note that happens
 * to contain `<br>` must not be treated the same way, and getting it wrong
 * either stores a page as unreadable Markdown or renders someone's notes as
 * markup.
 */

import { describe, expect, test } from "bun:test";
import { isHtmlPath, looksLikeHtml } from "../src/shared/html";

describe("isHtmlPath", () => {
  test("the extensions a captured page actually arrives with", () => {
    expect(isHtmlPath("raw/notion/2026-08-08-page.html")).toBe(true);
    expect(isHtmlPath("raw/page.htm")).toBe(true);
    expect(isHtmlPath("raw/page.xhtml")).toBe(true);
  });

  test("case does not decide the answer", () => {
    // Windows hands back whatever case the file was created with.
    expect(isHtmlPath("raw/PAGE.HTML")).toBe(true);
  });

  test("everything else is not HTML", () => {
    expect(isHtmlPath("wiki/note.md")).toBe(false);
    expect(isHtmlPath("raw/data.json")).toBe(false);
    expect(isHtmlPath("raw/html")).toBe(false);
    expect(isHtmlPath("raw/index.html.md")).toBe(false);
    expect(isHtmlPath("")).toBe(false);
  });
});

describe("looksLikeHtml", () => {
  test("a document is HTML whatever else it contains", () => {
    expect(looksLikeHtml("<!DOCTYPE html>\n<html><body><p>本文</p></body></html>")).toBe(true);
    expect(looksLikeHtml("<html lang=\"ja\">…</html>")).toBe(true);
    expect(looksLikeHtml("  \n<!doctype HTML>")).toBe(true);
  });

  test("a fragment with real structure is HTML", () => {
    expect(
      looksLikeHtml("<div><h1>見出し</h1><p>段落</p><ul><li>項目</li></ul></div>")
    ).toBe(true);
  });

  test("prose and Markdown are not HTML", () => {
    expect(looksLikeHtml("ただの文章です。")).toBe(false);
    expect(looksLikeHtml("## 見出し\n\n- 項目\n- 項目")).toBe(false);
    expect(looksLikeHtml("")).toBe(false);
    expect(looksLikeHtml("   ")).toBe(false);
  });

  test("a stray tag inside prose is not enough", () => {
    // Notes carry the odd <br> or <sub>; storing them as .html would render the
    // surrounding Markdown as literal text.
    expect(looksLikeHtml("一行目<br>二行目")).toBe(false);
    expect(looksLikeHtml("<p>ひとつだけ</p>")).toBe(false);
  });

  test("Markdown wins when both are present in a fragment", () => {
    // A Markdown note may embed a table or an aligned block; it is still a note.
    const markdown = [
      "## 見出し",
      "",
      "<div align=\"center\"><p>中央寄せ</p></div>",
      "",
      "<ul><li>項目</li></ul>",
      "",
      "[リンク](https://example.com)",
    ].join("\n");
    expect(looksLikeHtml(markdown)).toBe(false);
  });

  test("but a full document stays HTML even with Markdown-looking text in it", () => {
    // A captured page can contain a code sample; the doctype is decisive.
    const page = "<!DOCTYPE html>\n<html><body><pre># これは見出しではない</pre></body></html>";
    expect(looksLikeHtml(page)).toBe(true);
  });

  test("XML-ish preambles do not hide the document", () => {
    expect(
      looksLikeHtml('<?xml version="1.0"?>\n<!DOCTYPE html>\n<html><body>x</body></html>')
    ).toBe(true);
  });
});
