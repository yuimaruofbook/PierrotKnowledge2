/**
 * The reserved files, checked against the formats OKF actually specifies
 * (§8 for `index.md`, §9 for `log.md`) rather than a convenient tabular
 * approximation of them.
 */

import { describe, expect, test } from "bun:test";
import {
  OKF_VERSION,
  checkConformance,
  emptyLogMd,
  formatLogEntry,
  insertLogEntry,
  isoDate,
  logDates,
  readOkfVersion,
  renderIndexMd,
} from "../src/shared/okf";

describe("index.md (OKF §8)", () => {
  test("renders sectioned bullet entries, not a table", () => {
    const md = renderIndexMd("Bundle", [
      { heading: "Concepts", entries: [{ href: "/a.md", title: "Alpha", description: "first" }] },
    ]);
    expect(md).toContain("## Concepts");
    expect(md).toContain("* [Alpha](/a.md) - first");
    expect(md).not.toContain("|");
  });

  test("omits the description when there is none", () => {
    const md = renderIndexMd("B", [
      { heading: "Concepts", entries: [{ href: "/a.md", title: "A" }] },
    ]);
    expect(md).toContain("* [A](/a.md)");
    expect(md).not.toContain(" - ");
  });

  test("uses the bundle-absolute link form the spec recommends", () => {
    const md = renderIndexMd("B", [
      { heading: "topics", entries: [{ href: "/topics/x.md", title: "X" }] },
    ]);
    expect(md).toContain("](/topics/x.md)");
  });

  test("skips empty sections", () => {
    expect(renderIndexMd("B", [{ heading: "Empty", entries: [] }])).not.toContain("## Empty");
  });

  test("escapes brackets in a title", () => {
    const md = renderIndexMd("B", [
      { heading: "C", entries: [{ href: "/a.md", title: "A [draft]" }] },
    ]);
    expect(md).toContain("A \\[draft\\]");
  });

  test("collapses a multi-line description onto one bullet", () => {
    const md = renderIndexMd("B", [
      { heading: "C", entries: [{ href: "/a.md", title: "A", description: "one\ntwo" }] },
    ]);
    expect(md).toContain("* [A](/a.md) - one two");
  });

  test("carries okf_version only when asked", () => {
    expect(renderIndexMd("B", [])).not.toContain("okf_version");

    const rooted = renderIndexMd("B", [], { okfVersion: OKF_VERSION });
    expect(rooted.startsWith("---")).toBe(true);
    expect(readOkfVersion(rooted)).toBe(OKF_VERSION);
  });

  test("readOkfVersion returns null when absent", () => {
    expect(readOkfVersion("# Index\n")).toBeNull();
  });
});

describe("reserved-file conformance (OKF §8, §11)", () => {
  test("a root index carrying okf_version is conformant", () => {
    // §8 grants exactly one exception to "reserved files have no frontmatter".
    const md = renderIndexMd("B", [], { okfVersion: OKF_VERSION });
    expect(checkConformance("index.md", md).ok).toBe(true);
  });

  test("the exception applies only at the bundle root", () => {
    const md = renderIndexMd("B", [], { okfVersion: OKF_VERSION });
    expect(checkConformance("sub/index.md", md).ok).toBe(false);
  });

  test("the exception covers only the okf_version key", () => {
    expect(checkConformance("index.md", "---\ntype: Concept\n---\n").ok).toBe(false);
    expect(checkConformance("index.md", "---\nokf_version: 0.2\ntitle: X\n---\n").ok).toBe(false);
  });

  test("reserved files without frontmatter are conformant anywhere", () => {
    expect(checkConformance("index.md", "# Index\n").ok).toBe(true);
    expect(checkConformance("deep/sub/log.md", "# Log\n").ok).toBe(true);
  });
});

describe("log.md (OKF §9)", () => {
  const entry = (at: string, path: string, action = "write") => ({
    at,
    actor: "human:kn",
    action,
    path,
  });

  test("groups entries under ISO 8601 date headings", () => {
    const log = insertLogEntry("", entry("2026-08-01T10:00:00Z", "a.md"));
    expect(log).toContain("## 2026-08-01");
    expect(logDates(log)).toEqual(["2026-08-01"]);
  });

  test("entries are prose bullets with the conventional leading word", () => {
    expect(formatLogEntry(entry("2026-08-01T00:00:00Z", "a.md"))).toContain("**Update**");
    expect(formatLogEntry(entry("2026-08-01T00:00:00Z", "a.md", "create"))).toContain(
      "**Creation**"
    );
    expect(formatLogEntry(entry("2026-08-01T00:00:00Z", "a.md", "move"))).toContain("**Move**");
    expect(formatLogEntry(entry("2026-08-01T00:00:00Z", "a.md", "delete"))).toContain(
      "**Deletion**"
    );
  });

  test("an entry names the path and the actor", () => {
    const line = formatLogEntry(entry("2026-08-01T00:00:00Z", "wiki/a.md"));
    expect(line).toContain("wiki/a.md");
    expect(line).toContain("human:kn");
  });

  test("date sections are newest first", () => {
    let log = insertLogEntry("", entry("2026-07-30T00:00:00Z", "old.md"));
    log = insertLogEntry(log, entry("2026-08-01T00:00:00Z", "new.md"));
    expect(logDates(log)).toEqual(["2026-08-01", "2026-07-30"]);
  });

  test("a middle date lands between existing sections", () => {
    let log = insertLogEntry("", entry("2026-07-30T00:00:00Z", "a.md"));
    log = insertLogEntry(log, entry("2026-08-05T00:00:00Z", "b.md"));
    log = insertLogEntry(log, entry("2026-08-01T00:00:00Z", "c.md"));
    expect(logDates(log)).toEqual(["2026-08-05", "2026-08-01", "2026-07-30"]);
  });

  test("within a day, the newest entry comes first", () => {
    let log = insertLogEntry("", entry("2026-08-01T01:00:00Z", "first.md"));
    log = insertLogEntry(log, entry("2026-08-01T02:00:00Z", "second.md"));

    const bullets = log.split("\n").filter((line) => line.startsWith("* "));
    expect(bullets[0]).toContain("second.md");
    expect(bullets[1]).toContain("first.md");
    expect(logDates(log)).toEqual(["2026-08-01"]);
  });

  test("the title is never duplicated", () => {
    let log = insertLogEntry("", entry("2026-08-01T00:00:00Z", "a.md"));
    log = insertLogEntry(log, entry("2026-08-02T00:00:00Z", "b.md"));
    expect(log.match(/^# /gm)).toHaveLength(1);
  });

  test("starting from an existing empty log keeps one title", () => {
    const log = insertLogEntry(emptyLogMd(), entry("2026-08-01T00:00:00Z", "a.md"));
    expect(log.match(/^# /gm)).toHaveLength(1);
    expect(log).toContain("## 2026-08-01");
  });

  test("a log with entries stays conformant", () => {
    const log = insertLogEntry("", entry("2026-08-01T00:00:00Z", "a.md"));
    expect(checkConformance("log.md", log).ok).toBe(true);
  });

  test("isoDate reduces a timestamp to the date heading form", () => {
    expect(isoDate("2026-08-01T23:59:59Z")).toBe("2026-08-01");
    expect(isoDate(new Date("2026-01-02T00:00:00Z"))).toBe("2026-01-02");
  });
});
