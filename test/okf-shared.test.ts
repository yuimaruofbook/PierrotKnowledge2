import { describe, expect, test } from "bun:test";
import { messages } from "../src/shared/messages";
import {
  buildBacklinks,
  checkConformance,
  conceptIdFromRelPath,
  deriveTrustTier,
  extractLinks,
  isStale,
  joinFrontmatter,
  maskCode,
  readScalar,
  resolveLinkTarget,
  splitFrontmatter,
} from "../src/shared/okf";

describe("splitFrontmatter", () => {
  test("splits a normal document", () => {
    const { yaml, body } = splitFrontmatter("---\ntype: Concept\n---\n\n# Title\n");
    expect(yaml).toBe("type: Concept");
    // The body is preserved verbatim, blank line included. Trimming is the
    // parser's job, so a round-trip cannot silently reflow a document.
    expect(body).toBe("\n# Title\n");
  });

  test("returns null yaml when there is no frontmatter", () => {
    expect(splitFrontmatter("# Just a heading").yaml).toBeNull();
  });

  test("tolerates CRLF and reports the line ending", () => {
    const doc = splitFrontmatter("---\r\ntype: Note\r\n---\r\nbody\r\n");
    expect(doc.yaml).toBe("type: Note");
    expect(doc.eol).toBe("\r\n");
  });

  test("tolerates a BOM", () => {
    expect(splitFrontmatter("﻿---\ntype: Note\n---\nbody").yaml).toBe("type: Note");
  });

  test("does not treat a horizontal rule as frontmatter", () => {
    expect(splitFrontmatter("text\n\n---\n\nmore").yaml).toBeNull();
  });

  test("round-trips through joinFrontmatter", () => {
    const raw = joinFrontmatter("type: Concept", "# Body\n");
    expect(splitFrontmatter(raw).yaml).toBe("type: Concept");
    expect(splitFrontmatter(raw).body.trimStart()).toBe("# Body\n");
  });
});

describe("readScalar", () => {
  test("reads quoted and unquoted values", () => {
    expect(readScalar('type: "My Type"', "type")).toBe("My Type");
    expect(readScalar("type: Concept", "type")).toBe("Concept");
  });

  test("returns null for an empty or block value", () => {
    expect(readScalar("type:", "type")).toBeNull();
    expect(readScalar("type: |", "type")).toBeNull();
  });
});

describe("checkConformance", () => {
  test("accepts a concept with a non-empty type", () => {
    expect(checkConformance("wiki/a.md", "---\ntype: Concept\n---\nbody").ok).toBe(true);
  });

  test("rejects a concept without frontmatter", () => {
    const result = checkConformance("wiki/a.md", "# no frontmatter");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe(messages.missingFrontmatter);
  });

  test("rejects an empty type", () => {
    expect(checkConformance("wiki/a.md", "---\ntype:\n---\n").ok).toBe(false);
  });

  test("requires reserved files to have no frontmatter", () => {
    expect(checkConformance("wiki/index.md", "# Index\n").ok).toBe(true);
    expect(checkConformance("wiki/log.md", "---\ntype: X\n---\n").ok).toBe(false);
  });
});

describe("conceptIdFromRelPath", () => {
  test("strips the extension and normalises separators", () => {
    expect(conceptIdFromRelPath("topics\\deep\\note.md")).toBe("topics/deep/note");
  });
});

describe("trust and lifecycle", () => {
  test("derives the tier from who verified", () => {
    expect(deriveTrustTier(undefined)).toBe("unverified");
    expect(deriveTrustTier([])).toBe("unverified");
    expect(deriveTrustTier({ by: "process:ci", at: "2026-01-01" })).toBe("machine-confirmed");
    expect(
      deriveTrustTier([
        { by: "process:ci", at: "2026-01-01" },
        { by: "human:kn", at: "2026-01-02" },
      ])
    ).toBe("human-reviewed");
  });

  test("staleness compares against stale_after", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(isStale({ type: "C", stale_after: "2026-01-01T00:00:00Z" }, now)).toBe(true);
    expect(isStale({ type: "C", stale_after: "2027-01-01T00:00:00Z" }, now)).toBe(false);
    expect(isStale({ type: "C", stale_after: "not a date" }, now)).toBe(false);
    expect(isStale({ type: "C" }, now)).toBe(false);
  });
});

describe("maskCode", () => {
  test("blanks fenced blocks but preserves line count", () => {
    const source = "a\n```\n[[hidden]]\n```\nb";
    const masked = maskCode(source);
    expect(masked).not.toContain("[[hidden]]");
    expect(masked.split("\n").length).toBe(source.split("\n").length);
  });

  test("blanks inline code", () => {
    expect(maskCode("use `[[not-a-link]]` here")).not.toContain("[[not-a-link]]");
  });
});

describe("extractLinks", () => {
  const known = new Set(["a", "topics/b", "topics/deep/c"]);

  test("finds wikilinks and markdown links", () => {
    const links = extractLinks("see [[topics/b]] and [B](./topics/b.md)", "a", known);
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.resolved === "topics/b")).toBe(true);
  });

  test("ignores links inside code", () => {
    expect(extractLinks("```\n[[topics/b]]\n```", "a", known)).toHaveLength(0);
  });

  test("ignores image embeds", () => {
    expect(extractLinks("![alt](./pic.png)", "a", known)).toHaveLength(0);
  });

  test("leaves external links unresolved", () => {
    const [link] = extractLinks("[x](https://example.com)", "a", known);
    expect(link?.resolved).toBeNull();
  });

  test("captures a wikilink label", () => {
    const [link] = extractLinks("[[topics/b|Nice name]]", "a", known);
    expect(link?.label).toBe("Nice name");
  });

  test("deduplicates repeated targets", () => {
    expect(extractLinks("[[a]] [[a]] [[a]]", "topics/b", known)).toHaveLength(1);
  });
});

describe("resolveLinkTarget", () => {
  const known = new Set(["a", "topics/b", "topics/deep/c"]);

  test("resolves relative to the linking document", () => {
    expect(resolveLinkTarget("./deep/c.md", "topics/b", known)).toBe("topics/deep/c");
    expect(resolveLinkTarget("../a.md", "topics/b", known)).toBe("a");
  });

  test("resolves a bare name by unique basename", () => {
    expect(resolveLinkTarget("c", "a", known)).toBe("topics/deep/c");
  });

  test("refuses to guess an ambiguous basename", () => {
    const ambiguous = new Set(["x/note", "y/note"]);
    expect(resolveLinkTarget("note", "a", ambiguous)).toBeNull();
  });

  test("drops the fragment before resolving", () => {
    expect(resolveLinkTarget("topics/b#section", "a", known)).toBe("topics/b");
  });

  test("returns null for external targets and non-Markdown assets", () => {
    expect(resolveLinkTarget("https://example.com", "a", known)).toBeNull();
    expect(resolveLinkTarget("mailto:x@y.z", "a", known)).toBeNull();
    expect(resolveLinkTarget("./diagram.png", "a", known)).toBeNull();
  });
});

describe("buildBacklinks", () => {
  test("inverts the link graph and ignores self-links", () => {
    const graph = new Map([
      ["a", [{ target: "b", kind: "wikilink" as const, resolved: "b" }]],
      [
        "c",
        [
          { target: "b", kind: "markdown" as const, resolved: "b" },
          { target: "c", kind: "wikilink" as const, resolved: "c" },
        ],
      ],
    ]);
    const backlinks = buildBacklinks(graph);
    expect(backlinks.get("b")).toEqual(["a", "c"]);
    expect(backlinks.has("c")).toBe(false);
  });
});

describe("cross-linking forms (OKF §6)", () => {
  const known = new Set(["a", "other", "topics/a", "topics/other", "topics/deep/c"]);

  test("an absolute link is bundle-rooted, never relative", () => {
    // §6: a leading "/" is interpreted from the bundle root. From topics/a,
    // "/other.md" must be `other` and never `topics/other`.
    expect(resolveLinkTarget("/other.md", "topics/a", known)).toBe("other");
  });

  test("a relative link is anchored to the linking document, never the root", () => {
    // Both `other` and `topics/other` exist; "./other.md" means the sibling.
    expect(resolveLinkTarget("./other.md", "topics/a", known)).toBe("topics/other");
    expect(resolveLinkTarget("../other.md", "topics/deep/c", known)).toBe("topics/other");
  });

  test("an explicitly relative link does not fall back to a bundle-root match", () => {
    expect(resolveLinkTarget("./nope.md", "topics/a", known)).toBeNull();
  });

  test("an absolute link to a missing target is simply unresolved", () => {
    // §6: consumers MUST tolerate broken links — not-yet-written knowledge.
    expect(resolveLinkTarget("/nowhere.md", "a", known)).toBeNull();
  });

  test("a bare name may still match anywhere, for wikilinks", () => {
    expect(resolveLinkTarget("c", "a", known)).toBe("topics/deep/c");
  });
});

describe("staleness (OKF §5.5)", () => {
  const on = (day: string) => new Date(`${day}T12:00:00`);

  test("stale on and after the named day", () => {
    // §5.5 defines staleness as `today >= stale_after`, so the boundary day
    // itself counts as stale.
    expect(isStale({ type: "C", stale_after: "2026-08-01" }, on("2026-08-01"))).toBe(true);
    expect(isStale({ type: "C", stale_after: "2026-08-01" }, on("2026-08-02"))).toBe(true);
  });

  test("not stale before it", () => {
    expect(isStale({ type: "C", stale_after: "2026-08-01" }, on("2026-07-31"))).toBe(false);
  });

  test("absent or unparseable stale_after is never stale", () => {
    expect(isStale({ type: "C" }, on("2026-08-01"))).toBe(false);
    expect(isStale({ type: "C", stale_after: "soon" }, on("2026-08-01"))).toBe(false);
    expect(isStale({ type: "C", stale_after: 42 as unknown as string }, on("2026-08-01"))).toBe(
      false
    );
  });
});

describe("conformance is minimal (OKF §11)", () => {
  test("a concept carrying only `type` is fully conformant", () => {
    expect(checkConformance("a.md", "---\ntype: Concept\n---\n").ok).toBe(true);
  });

  test("unknown types and extra keys are not grounds for rejection", () => {
    const raw = "---\ntype: SomethingNovel\nunknown_key: 1\n---\nbody";
    expect(checkConformance("a.md", raw).ok).toBe(true);
  });
});
