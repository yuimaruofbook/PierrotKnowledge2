import { describe, expect, test } from "bun:test";
import { rebaseOwnLinks, relativeIdPath, rewriteLinks } from "../src/shared/okf";

const known = new Set(["a", "topics/b", "topics/deep/c", "other"]);

describe("relativeIdPath", () => {
  test("same directory is explicitly relative", () => {
    // An explicit "./" reads unambiguously to both people and Markdown tools.
    expect(relativeIdPath("topics/b", "topics/x")).toBe("./x");
  });

  test("upwards", () => {
    expect(relativeIdPath("topics/deep/c", "a")).toBe("../../a");
  });

  test("downwards", () => {
    expect(relativeIdPath("a", "topics/deep/c")).toBe("topics/deep/c");
  });

  test("root to root is explicitly relative", () => {
    expect(relativeIdPath("a", "other")).toBe("./other");
  });
});

describe("rewriteLinks", () => {
  test("updates a wikilink and keeps the displayed text", () => {
    const { body, count } = rewriteLinks("see [[topics/b]] here", "a", "topics/b", "topics/z", known);
    expect(count).toBe(1);
    // Without the preserved label the rendered text would silently change.
    expect(body).toBe("see [[topics/z|topics/b]] here");
  });

  test("keeps an existing label", () => {
    const { body } = rewriteLinks("[[topics/b|Bee]]", "a", "topics/b", "topics/z", known);
    expect(body).toBe("[[topics/z|Bee]]");
  });

  test("preserves a fragment", () => {
    const { body } = rewriteLinks("[[topics/b#setup]]", "a", "topics/b", "topics/z", known);
    expect(body).toContain("topics/z#setup");
  });

  test("updates a relative markdown link, staying relative", () => {
    const { body, count } = rewriteLinks(
      "see [B](./topics/b.md)",
      "a",
      "topics/b",
      "topics/deep/z",
      known
    );
    expect(count).toBe(1);
    expect(body).toBe("see [B](topics/deep/z.md)");
  });

  test("rewrites relative to the linking document", () => {
    const { body } = rewriteLinks("[A](../a.md)", "topics/b", "a", "moved/a", known);
    expect(body).toBe("[A](../moved/a.md)");
  });

  test("leaves links to other documents alone", () => {
    const source = "[[other]] and [C](./topics/deep/c.md)";
    const { body, count } = rewriteLinks(source, "a", "topics/b", "topics/z", known);
    expect(count).toBe(0);
    expect(body).toBe(source);
  });

  test("never touches links inside fenced code", () => {
    const source = "```\n[[topics/b]]\n```\nreal [[topics/b]]";
    const { body, count } = rewriteLinks(source, "a", "topics/b", "topics/z", known);
    expect(count).toBe(1);
    expect(body).toContain("```\n[[topics/b]]\n```");
    expect(body).toContain("[[topics/z|topics/b]]");
  });

  test("ignores image embeds", () => {
    const source = "![pic](./topics/b.md)";
    expect(rewriteLinks(source, "a", "topics/b", "topics/z", known).count).toBe(0);
  });

  test("a no-op rename changes nothing", () => {
    expect(rewriteLinks("[[topics/b]]", "a", "topics/b", "topics/b", known).count).toBe(0);
  });

  test("rewrites every occurrence", () => {
    const { count } = rewriteLinks(
      "[[topics/b]] then [B](./topics/b.md) then [[topics/b|x]]",
      "a",
      "topics/b",
      "z",
      known
    );
    expect(count).toBe(3);
  });
});

describe("rebaseOwnLinks", () => {
  test("rewrites the moved document's own relative links", () => {
    // `a` links to topics/b; moving `a` into topics/ makes `./topics/b.md` wrong.
    const { body, count } = rebaseOwnLinks("[B](./topics/b.md)", "a", "topics/a", known);
    expect(count).toBe(1);
    expect(body).toBe("[B](./b.md)");
  });

  test("does nothing when the directory is unchanged", () => {
    const { count } = rebaseOwnLinks("[B](./topics/b.md)", "a", "renamed", known);
    expect(count).toBe(0);
  });

  test("leaves wikilinks alone — they address ids, not paths", () => {
    const { body, count } = rebaseOwnLinks("[[topics/b]]", "a", "deep/a", known);
    expect(count).toBe(0);
    expect(body).toBe("[[topics/b]]");
  });

  test("leaves external links alone", () => {
    const { count } = rebaseOwnLinks("[x](https://example.com)", "a", "deep/a", known);
    expect(count).toBe(0);
  });
});
