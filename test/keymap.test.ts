/**
 * Editor text transforms. Pure functions, so they are tested directly rather
 * than through the DOM.
 */

import { describe, expect, test } from "bun:test";
import {
  completeWikilink,
  continueList,
  indent,
  wikilinkContext,
} from "../src/mainview/ui/keymap";
import { fuzzyScore } from "../src/shared/fuzzy";

/** Build an edit state from a string where `|` marks the caret. */
function at(marked: string) {
  const caret = marked.indexOf("|");
  const value = marked.replace("|", "");
  return { value, selectionStart: caret, selectionEnd: caret };
}

/** Render a result back into the `|` notation. */
function show(result: { value: string; selectionStart: number } | null): string | null {
  if (!result) return null;
  return (
    result.value.slice(0, result.selectionStart) + "|" + result.value.slice(result.selectionStart)
  );
}

describe("continueList", () => {
  test("continues a bullet", () => {
    expect(show(continueList(at("- item|")))).toBe("- item\n- |");
  });

  test("continues a numbered list, incrementing", () => {
    expect(show(continueList(at("3. item|")))).toBe("3. item\n4. |");
  });

  test("preserves indentation", () => {
    expect(show(continueList(at("  - item|")))).toBe("  - item\n  - |");
  });

  test("continues a task list with an unchecked box", () => {
    // A new item must never inherit the checked state.
    expect(show(continueList(at("- [x] done|")))).toBe("- [x] done\n- [ ] |");
  });

  test("an empty item ends the list", () => {
    expect(show(continueList(at("- item\n- |")))).toBe("- item\n|");
  });

  test("continues a blockquote", () => {
    expect(show(continueList(at("> quoted|")))).toBe("> quoted\n> |");
  });

  test("plain text is left to the default behaviour", () => {
    expect(continueList(at("just text|"))).toBeNull();
  });

  test("does nothing when there is a selection", () => {
    expect(continueList({ value: "- a", selectionStart: 0, selectionEnd: 3 })).toBeNull();
  });
});

describe("indent", () => {
  test("Tab inserts spaces with no selection", () => {
    expect(show(indent(at("ab|cd"), false))).toBe("ab  |cd");
  });

  test("indents every line of a selection", () => {
    const result = indent({ value: "a\nb", selectionStart: 0, selectionEnd: 3 }, false);
    expect(result?.value).toBe("  a\n  b");
  });

  test("outdents every line of a selection", () => {
    const result = indent({ value: "  a\n  b", selectionStart: 0, selectionEnd: 7 }, true);
    expect(result?.value).toBe("a\nb");
  });

  test("outdenting an unindented line is harmless", () => {
    const result = indent({ value: "a\nb", selectionStart: 0, selectionEnd: 3 }, true);
    expect(result?.value).toBe("a\nb");
  });

  test("does not indent an empty line", () => {
    const result = indent({ value: "a\n\nb", selectionStart: 0, selectionEnd: 4 }, false);
    expect(result?.value).toBe("  a\n\n  b");
  });
});

describe("wikilinkContext", () => {
  test("detects an in-progress link", () => {
    expect(wikilinkContext("see [[top", 9)).toEqual({ query: "top", start: 6 });
  });

  test("detects an empty one right after the brackets", () => {
    expect(wikilinkContext("see [[", 6)).toEqual({ query: "", start: 6 });
  });

  test("ignores a completed link", () => {
    expect(wikilinkContext("see [[done]] and", 16)).toBeNull();
  });

  test("ignores a newline inside the brackets", () => {
    expect(wikilinkContext("[[a\nb", 5)).toBeNull();
  });

  test("returns null when there is no opening", () => {
    expect(wikilinkContext("plain text", 5)).toBeNull();
  });
});

describe("completeWikilink", () => {
  test("closes the brackets", () => {
    const state = at("see [[top|");
    const context = wikilinkContext(state.value, state.selectionStart)!;
    expect(show(completeWikilink(state, context, "topics/foo"))).toBe("see [[topics/foo]]|");
  });

  test("does not duplicate an existing closer", () => {
    const state = { value: "see [[top]]", selectionStart: 9, selectionEnd: 9 };
    const context = wikilinkContext(state.value, state.selectionStart)!;
    expect(completeWikilink(state, context, "topics/foo").value).toBe("see [[topics/foo]]");
  });
});

describe("fuzzyScore", () => {
  test("matches a subsequence", () => {
    expect(fuzzyScore("topics/design", "tdes")).not.toBeNull();
  });

  test("rejects a non-subsequence", () => {
    expect(fuzzyScore("topics/design", "zzz")).toBeNull();
  });

  test("an empty query matches everything", () => {
    expect(fuzzyScore("anything", "")).toBe(0);
  });

  test("prefers contiguous matches", () => {
    const contiguous = fuzzyScore("design", "des")!;
    const scattered = fuzzyScore("d-e-s-ign", "des")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  test("prefers a shorter target on a tie", () => {
    expect(fuzzyScore("abc", "abc")!).toBeGreaterThan(fuzzyScore("abcdefghij", "abc")!);
  });

  test("is case-insensitive", () => {
    expect(fuzzyScore("Design", "des")).not.toBeNull();
  });
});
