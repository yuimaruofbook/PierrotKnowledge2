import { describe, expect, test } from "bun:test";
import {
  bigrams,
  buildMatchQuery,
  chunkAnchor,
  chunkBody,
  containsCjk,
  makeSnippet,
  normalizeForIndex,
  parseQueryTerms,
  slugifyHeading,
} from "../src/shared/okf";

describe("CJK detection", () => {
  test("recognises kana and kanji, not latin", () => {
    expect(containsCjk("軽量")).toBe(true);
    expect(containsCjk("ノート")).toBe(true);
    expect(containsCjk("ひらがな")).toBe(true);
    expect(containsCjk("lightweight")).toBe(false);
    expect(containsCjk("")).toBe(false);
  });
});

describe("bigrams", () => {
  test("produces overlapping pairs", () => {
    expect(bigrams("知識ベース")).toEqual(["知識", "識ベ", "ベー", "ース"]);
  });

  test("a single character is emitted as itself", () => {
    expect(bigrams("知")).toEqual(["知"]);
    expect(bigrams("")).toEqual([]);
  });
});

describe("normalizeForIndex", () => {
  test("expands CJK runs and lowercases latin", () => {
    expect(normalizeForIndex("知識ベース")).toBe("知識 識ベ ベー ース");
    expect(normalizeForIndex("Hello World")).toBe("hello world");
  });

  test("keeps mixed text usable on both sides", () => {
    const out = normalizeForIndex("RAG と知識ベース");
    expect(out).toContain("rag");
    expect(out).toContain("知識");
  });

  test("CJK punctuation separates rather than joins", () => {
    // 「」 must not produce a bigram spanning two unrelated words.
    expect(normalizeForIndex("軽量、設計")).not.toContain("量設");
  });
});

describe("buildMatchQuery", () => {
  test("returns null for empty input", () => {
    expect(buildMatchQuery("   ")).toBeNull();
  });

  test("quotes every term, neutralising FTS5 operators", () => {
    for (const query of ['"', "a OR b", "NEAR(x", "-x", "a:b", "*"]) {
      const match = buildMatchQuery(query);
      if (match) expect(match).not.toMatch(/(^|\s)(OR|NEAR|NOT)(\s|\()/);
    }
  });

  test("a two-character Japanese word becomes one bigram phrase", () => {
    expect(buildMatchQuery("軽量")).toBe('"軽量"');
  });

  test("a longer Japanese word becomes an adjacency phrase", () => {
    // A phrase, not AND: the bigrams must be adjacent or unrelated documents match.
    expect(buildMatchQuery("知識ベース")).toBe('"知識 識ベ ベー ース"');
  });

  test("a single Japanese character becomes a prefix query", () => {
    expect(buildMatchQuery("軽")).toBe('"軽"*');
  });

  test("multiple terms are ANDed", () => {
    expect(buildMatchQuery("軽量 設計")).toBe('"軽量" AND "設計"');
  });
});

describe("parseQueryTerms", () => {
  test("keeps a quoted phrase together", () => {
    const terms = parseQueryTerms('"hello world" other');
    expect(terms.map((t) => t.raw)).toEqual(["hello world", "other"]);
  });
});

describe("makeSnippet", () => {
  test("centres on the match and marks it", () => {
    const text = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
    const snippet = makeSnippet(text, "needle", { open: "<mark>", close: "</mark>", width: 80 });
    expect(snippet).toContain("<mark>needle</mark>");
    expect(snippet.length).toBeLessThan(140);
  });

  test("works for Japanese", () => {
    const snippet = makeSnippet("これは軽量なノートアプリです", "軽量", {
      open: "[",
      close: "]",
    });
    expect(snippet).toContain("[軽量]");
  });

  test("falls back to a head excerpt when nothing matches", () => {
    expect(makeSnippet("abc def", "zzz")).toBe("abc def");
  });

  test("collapses whitespace so a snippet stays one line", () => {
    expect(makeSnippet("a\n\n  b", "a")).not.toContain("\n");
  });
});

describe("chunkBody", () => {
  const doc = [
    "Intro paragraph.",
    "",
    "## Setup",
    "",
    "Install it.",
    "",
    "### Windows",
    "",
    "Use the installer.",
    "",
    "## Usage",
    "",
    "Run it.",
  ].join("\n");

  test("splits at headings and records the heading path", () => {
    const chunks = chunkBody(doc);
    expect(chunks.map((c) => c.heading)).toEqual(["", "Setup", "Windows", "Usage"]);
    expect(chunks[2]?.headingPath).toEqual(["Setup", "Windows"]);
    expect(chunks[3]?.headingPath).toEqual(["Usage"]);
  });

  test("chunk text excludes the heading line", () => {
    const chunks = chunkBody(doc);
    expect(chunks[1]?.text).toBe("Install it.");
  });

  test("a document without headings stays one chunk", () => {
    const chunks = chunkBody("Just a short note.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual([]);
  });

  test("headings inside fenced code do not split the document", () => {
    const chunks = chunkBody("Text\n\n```sh\n# not a heading\necho hi\n```\n\nMore");
    expect(chunks).toHaveLength(1);
  });

  test("an over-long section is split into several chunks", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"word ".repeat(20)}`).join(
      "\n\n"
    );
    const chunks = chunkBody(`## Big\n\n${long}`);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk keeps the heading it came from, so context is never lost.
    expect(chunks.every((c) => c.heading === "Big")).toBe(true);
  });

  test("empty input yields no chunks", () => {
    expect(chunkBody("   \n\n  ")).toEqual([]);
  });
});

describe("heading anchors", () => {
  test("slugs match common Markdown anchor rules", () => {
    expect(slugifyHeading("Getting Started")).toBe("getting-started");
    expect(slugifyHeading("`code` and *stars*")).toBe("code-and-stars");
    expect(slugifyHeading("設計 原則")).toBe("設計-原則");
  });

  test("anchor falls back to the file when there is no heading", () => {
    expect(chunkAnchor("topics/note", "")).toBe("topics/note.md");
    expect(chunkAnchor("topics/note", "Setup")).toBe("topics/note.md#setup");
  });
});

describe("wikilink expansion respects code", () => {
  test("expands a real wikilink", async () => {
    const { expandWikilinks } = await import("../src/shared/okf/links");
    expect(expandWikilinks("see [[topics/a]]")).toContain("okf-wiki:topics%2Fa");
  });

  test("leaves a wikilink inside inline code alone", async () => {
    const { expandWikilinks } = await import("../src/shared/okf/links");
    // Documentation *about* wikilink syntax must render as written.
    const out = expandWikilinks("write `[[hello]]` to link");
    expect(out).toBe("write `[[hello]]` to link");
  });

  test("leaves a wikilink inside a fenced block alone", async () => {
    const { expandWikilinks } = await import("../src/shared/okf/links");
    const source = "```\n[[hello]]\n```\n\nreal [[hello]]";
    const out = expandWikilinks(source);
    expect(out).toContain("```\n[[hello]]\n```");
    expect(out).toContain("okf-wiki:hello");
  });

  test("uses the label when one is given", async () => {
    const { expandWikilinks } = await import("../src/shared/okf/links");
    expect(expandWikilinks("[[a|表示名]]")).toContain("[表示名](");
  });
});
