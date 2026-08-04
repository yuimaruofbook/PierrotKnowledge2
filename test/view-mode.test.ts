/**
 * Which view a file opens in.
 *
 * A one-line rule, tested because it is easy to change by accident and
 * invisible when wrong: nobody notices a regression here until they open a
 * page and get raw frontmatter instead of the document.
 */

import { describe, expect, test } from "bun:test";
import { initialViewMode } from "../src/shared/view-mode";

describe("opening a file", () => {
  test("Markdown opens in reading view, in every layer", () => {
    // wiki/, raw/ and .rag/ are the whole bundle, so the rule is the same
    // wherever the file came from.
    expect(initialViewMode("wiki/1-projects/note.md", false)).toBe("preview");
    expect(initialViewMode("raw/取り込んだ議事録.md", false)).toBe("preview");
    expect(initialViewMode(".rag/notes.md", false)).toBe("preview");
    expect(initialViewMode("wiki/MAP.md")).toBe("preview");
  });

  test("case and the long extension both count", () => {
    expect(initialViewMode("wiki/NOTE.MD", false)).toBe("preview");
    expect(initialViewMode("wiki/note.markdown", false)).toBe("preview");
  });

  test("a file the renderer cannot render opens in the editor", () => {
    // Markdown-rendering a JSON file hides its braces and quotes, which are
    // its content rather than markup.
    expect(initialViewMode("raw/export.json", false)).toBe("edit");
    expect(initialViewMode("raw/notes.txt", false)).toBe("edit");
    expect(initialViewMode(".rag/index.sqlite", false)).toBe("edit");
  });

  test("a binary file never opens in reading view", () => {
    // Even when it is named like a document: there is no text to render, and
    // decoding the bytes is what produced screens of replacement characters.
    expect(initialViewMode("raw/scan.md", true)).toBe("edit");
    expect(initialViewMode("raw/photo.png", true)).toBe("edit");
  });

  test("a name containing .md is not enough", () => {
    expect(initialViewMode("raw/notes.md.bak", false)).toBe("edit");
    expect(initialViewMode("raw/mdfile", false)).toBe("edit");
  });
});
