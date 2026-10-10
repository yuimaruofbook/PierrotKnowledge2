/**
 * Paste decision logic.
 *
 * The HTML→Markdown conversion itself needs a DOM and is verified in the
 * browser against real clipboard markup; what is tested here is the choice
 * *between* the clipboard's two flavours, which is pure and is where a wrong
 * answer silently mangles someone's paste.
 */

import { describe, expect, test } from "bun:test";
import { decidePaste, looksLikeMarkdown } from "../src/shared/paste";

/** The DOM-backed converters are verified in the browser; here they are stubs. */
const convert = {
  markdown: (html: string) => html.replace(/<[^>]+>/g, "").trim(),
  html: (html: string) => html.replace(/<meta[^>]*>/gi, "").trim(),
};

describe("looksLikeMarkdown", () => {
  test("recognises the syntax people actually copy", () => {
    expect(looksLikeMarkdown("## 見出し")).toBe(true);
    expect(looksLikeMarkdown("```\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("[リンク](https://example.com)")).toBe(true);
    expect(looksLikeMarkdown("- [ ] タスク")).toBe(true);
    expect(looksLikeMarkdown("> 引用")).toBe(true);
    expect(looksLikeMarkdown("[[wikilink]]")).toBe(true);
    expect(looksLikeMarkdown("---\ntype: Note\n---\n")).toBe(true);
  });

  test("plain prose is not Markdown", () => {
    expect(looksLikeMarkdown("ただの文章です。箇条書きでもありません。")).toBe(false);
    expect(looksLikeMarkdown("Hello world")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
  });

  test("a bare hyphen list is not a strong enough signal", () => {
    // Notion's plain-text flavour uses "- " too, so it cannot decide anything.
    expect(looksLikeMarkdown("- 一つ目\n- 二つ目")).toBe(false);
  });
});

describe("decidePaste", () => {
  test("uses plain text when there is no HTML flavour", () => {
    expect(decidePaste({ html: null, text: "そのまま" }, convert)).toEqual({
      content: "そのまま",
      from: "text",
      format: "markdown",
    });
  });

  test("uses plain text when the HTML flavour is empty", () => {
    expect(decidePaste({ html: "   ", text: "そのまま" }, convert).from).toBe("text");
  });

  test("Ctrl+Shift+V forces plain text even when HTML is richer", () => {
    const decision = decidePaste({ html: "<h1>見出し</h1>", text: "見出し" }, convert, "plain");
    expect(decision).toEqual({ content: "見出し", from: "text", format: "markdown" });
  });

  test("Markdown source copied from another editor is taken verbatim", () => {
    // Editors put highlighted <span> soup on text/html; converting it mangles
    // the source the user actually meant to copy.
    const source = {
      html: '<div style="color:#abb2bf"><span>## 見出し</span></div>',
      text: "## 見出し\n\n[リンク](https://a.b)",
    };
    const decision = decidePaste(source, convert);
    expect(decision.from).toBe("text");
    expect(decision.content).toBe(source.text);
  });

  test("an empty clipboard yields nothing to insert", () => {
    expect(decidePaste({ html: null, text: "" }, convert).content).toBe("");
  });
});

describe("pasting as HTML", () => {
  const source = {
    html: '<meta charset="utf-8"><h1>見出し</h1><p>本文</p>',
    text: "見出し\n本文",
  };

  test("keeps the markup instead of converting it", () => {
    const decision = decidePaste(source, convert, "html");
    expect(decision).toEqual({
      content: "<h1>見出し</h1><p>本文</p>",
      from: "html",
      format: "html",
    });
  });

  test("Markdown-looking plain text does not win in this mode", () => {
    // The heuristic exists to guess; asking for HTML explicitly is not a guess.
    const decision = decidePaste(
      { html: "<h1>見出し</h1><p>本文</p>", text: "## 見出し" },
      convert,
      "html"
    );
    expect(decision.format).toBe("html");
  });

  test("falls back to plain text when the clipboard has no HTML", () => {
    // Nothing to keep: inserting the plain flavour into an HTML file is still
    // better than inserting nothing.
    const decision = decidePaste({ html: null, text: "ただの文字列" }, convert, "html");
    expect(decision).toEqual({ content: "ただの文字列", from: "text", format: "markdown" });
  });

  test("clipboard HTML that cleans away to nothing falls back too", () => {
    const decision = decidePaste({ html: '<meta charset="utf-8">', text: "本文" }, convert, "html");
    expect(decision).toEqual({ content: "本文", from: "text", format: "markdown" });
  });
});
