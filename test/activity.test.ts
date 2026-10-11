/**
 * Traceable activity summaries.
 *
 * The property under test is traceability: every line of a summary is a log.md
 * row restated with its date and path, and nothing else. The log is written
 * with fixed dates by hand so the expected page can be spelled out exactly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  activityRelPath,
  filterActivity,
  parseLogEntries,
  summarizeActivity,
} from "../src/shared/okf";
import { Workspace } from "../src/bun/workspace";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { callTool, TOOLS } from "../src/bun/mcp/tools";
import { removeTempDir } from "./helpers";

const LOG = [
  "# Log",
  "",
  "## 2026-09-03",
  "",
  "* **Update**: `wiki/b.md` by process:codex. second pass",
  "* **Creation**: `wiki/c.md` by process:claude-code.",
  "",
  "## 2026-09-02",
  "",
  "* **Update**: `wiki/a.md` by process:claude-code. fixed typo",
  "* **Move**: `wiki/x.md → wiki/y.md` by human:local.",
  "",
  "## 2026-09-01",
  "",
  "* **Creation**: `wiki/a.md` by process:claude-code.",
  "",
].join("\n");

describe("summarizeActivity", () => {
  const entries = parseLogEntries(LOG);

  test("groups by actor then file, citing date and path on every line", () => {
    const summary = summarizeActivity(entries, { source: "wiki/log.md" })!;
    expect(summary.title).toBe("Activity 2026-09-01 → 2026-09-03");
    expect(summary.total).toBe(5);
    expect(summary.body).toBe(
      [
        "Source: `wiki/log.md` · 5 entries · 3 actor(s) · 4 file(s)",
        "",
        "## Totals by action",
        "",
        "* Creation: 2",
        "* Update: 2",
        "* Move: 1",
        "",
        "## process:claude-code (3)",
        "",
        "### `wiki/a.md`",
        "",
        "* 2026-09-02 · Update · `wiki/a.md` — fixed typo",
        "* 2026-09-01 · Creation · `wiki/a.md`",
        "",
        "### `wiki/c.md`",
        "",
        "* 2026-09-03 · Creation · `wiki/c.md`",
        "",
        "## human:local (1)",
        "",
        "### `wiki/x.md → wiki/y.md`",
        "",
        "* 2026-09-02 · Move · `wiki/x.md → wiki/y.md`",
        "",
        "## process:codex (1)",
        "",
        "### `wiki/b.md`",
        "",
        "* 2026-09-03 · Update · `wiki/b.md` — second pass",
      ].join("\n")
    );
  });

  test("filters by range and actor, and is null when nothing matches", () => {
    const some = filterActivity(entries, { since: "2026-09-02", until: "2026-09-02", actor: "claude" });
    expect(some).toHaveLength(1);
    expect(summarizeActivity(some, { source: "s", since: "2026-09-02", until: "2026-09-02", actor: "claude" })!.title).toBe(
      "Activity 2026-09-02 → 2026-09-02 (claude)"
    );
    expect(filterActivity(entries, { since: "2027-01-01" })).toEqual([]);
    expect(summarizeActivity([], { source: "s" })).toBeNull();
  });

  test("saved paths are dates plus a filename-safe actor", () => {
    expect(activityRelPath("2026-09-01", "2026-09-03")).toBe("activity/2026-09-01_2026-09-03.md");
    // Nothing is lost in the name, so no hash is needed.
    expect(activityRelPath("2026-09-01", "2026-09-03", "codex")).toBe("activity/2026-09-01_2026-09-03_codex.md");
    expect(activityRelPath("2026-09-01", "2026-09-03", "process:claude-code")).toBe(
      "activity/2026-09-01_2026-09-03_process-claude-code-041f4214.md"
    );
    expect(activityRelPath("a", "b", "::")).toBe("activity/a_b_980630f5.md");
  });

  test("two different actor filters never share a file", () => {
    const filters = ["process:codex", "process-codex", "process codex", "田中", "佐藤", "x".repeat(60), "x".repeat(61)];
    const paths = filters.map((actor) => activityRelPath("2026-09-01", "2026-09-03", actor));
    expect(new Set(paths).size).toBe(filters.length);
    // A Japanese filter has no ASCII letters at all: the hash alone names it.
    expect(paths[3]).toMatch(/^activity\/2026-09-01_2026-09-03_[0-9a-f]{8}\.md$/);
    // Stable: the same filter always maps to the same file.
    expect(activityRelPath("2026-09-01", "2026-09-03", "田中")).toBe(paths[3]!);
  });

  test("the actor filter is recorded in the body", () => {
    const entries = filterActivity(parseLogEntries(LOG), { actor: "codex" });
    const summary = summarizeActivity(entries, { actor: "codex", source: "wiki/log.md" })!;
    expect(summary.body).toContain("Actor filter: codex");
    expect(summarizeActivity(entries, { source: "wiki/log.md" })!.body).not.toContain("Actor filter");
  });
});

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-activity-test-"));
  await scaffoldBundle(root);
  await writeFile(join(root, "wiki", "log.md"), LOG, "utf8");
  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("workspace.summarizeActivity", () => {
  test("reads the log without writing anything", async () => {
    const result = await workspace.summarizeActivity({});
    expect(result.total).toBe(5);
    expect(result.markdown.startsWith("# Activity 2026-09-01 → 2026-09-03\n\n")).toBe(true);
    expect(result.saved).toBeUndefined();
    expect((await workspace.auditChanges()).total).toBe(5);
  });

  test("save writes an ActivitySummary concept through the normal write path", async () => {
    const result = await workspace.summarizeActivity({
      since: "2026-09-02",
      actor: "process:claude-code",
      save: true,
    });
    expect(result.saved).toBe("wiki/activity/2026-09-02_2026-09-03_process-claude-code-041f4214.md");

    const file = (await workspace.readFile(result.saved!)).concept!;
    expect(file.frontmatter.type).toBe("ActivitySummary");
    // The filter picks the rows; it does not say who ran the tool.
    expect(file.frontmatter.generated?.by).toBe("process:okf");
    expect(file.body).toContain("* 2026-09-02 · Update · `wiki/a.md` — fixed typo");
    expect(file.body).toContain("Actor filter: process:claude-code");

    const audit = await workspace.auditChanges({ actor: "process:okf" });
    expect(audit.actors[0]!.entries.some((e) => e.path === result.saved)).toBe(true);
    expect(workspace.search("fixed typo", { type: "ActivitySummary" }).map((h) => h.id)).toEqual([
      "activity/2026-09-02_2026-09-03_process-claude-code-041f4214",
    ]);
  });

  test("a save is credited to whoever ran it, in the file and the log", async () => {
    const saved = await workspace.summarizeActivity({
      actor: "claude",
      by: "process:tester",
      save: true,
    });
    const file = (await workspace.readFile(saved.saved!)).concept!;
    expect(file.frontmatter.generated?.by).toBe("process:tester");
    const audit = await workspace.auditChanges({ actor: "process:tester" });
    expect(audit.actors[0]!.entries.some((e) => e.path === saved.saved)).toBe(true);
  });

  test("an unattributed save is credited to process:okf, and saving twice updates in place", async () => {
    const first = await workspace.summarizeActivity({ save: true });
    expect(first.saved).toBe("wiki/activity/2026-09-01_2026-09-03.md");
    const text = await readFile(join(root, first.saved!), "utf8");
    expect(text).toContain("by: process:okf");

    // The first save added log rows dated today, so pin the range to compare like with like.
    const second = await workspace.summarizeActivity({ save: true, until: "2026-09-03" });
    expect(second.saved).toBe(first.saved);
  });

  test("nothing matched means nothing is saved", async () => {
    const result = await workspace.summarizeActivity({ since: "2030-01-01", save: true });
    expect(result.total).toBe(0);
    expect(result.saved).toBeUndefined();
  });

  test("the first save creates activity/ with its index.md", async () => {
    await workspace.summarizeActivity({ save: true });
    const index = await readFile(join(root, "wiki", "activity", "index.md"), "utf8");
    expect(index).toContain("# Activity");
  });
});

describe("summarize_activity tool", () => {
  test("is listed with its schema", () => {
    const tool = TOOLS.find((t) => t.name === "summarize_activity")!;
    expect(tool.inputSchema.required).toBeUndefined();
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["since", "until", "actor", "by", "save"]);
    expect((tool.inputSchema.properties.save as { type: string }).type).toBe("boolean");
  });

  test("rejects bad dates and inverted ranges", async () => {
    const bad = await callTool(workspace, "summarize_activity", { since: "last week" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toBe("since must be an ISO date: last week");
    const badUntil = await callTool(workspace, "summarize_activity", { until: "2026-9-1" });
    expect(badUntil.content[0]!.text).toBe("until must be an ISO date: 2026-9-1");
    const inverted = await callTool(workspace, "summarize_activity", { since: "2026-09-03", until: "2026-09-01" });
    expect(inverted.isError).toBe(true);
    expect(inverted.content[0]!.text).toContain("until must not be before since");
  });

  test("returns the page, or the saved path", async () => {
    const page = await callTool(workspace, "summarize_activity", { actor: "codex" });
    expect(page.content[0]!.text).toContain("* 2026-09-03 · Update · `wiki/b.md` — second pass");
    expect(page.content[0]!.text).not.toContain("wiki/a.md");

    const none = await callTool(workspace, "summarize_activity", { since: "2030-01-01" });
    expect(none.isError).toBeUndefined();
    expect(none.content[0]!.text).toBe("No log entries matched the given range or actor.");

    const saved = await callTool(workspace, "summarize_activity", { save: true, actor: "process:codex" });
    expect(saved.content[0]!.text).toBe(
      "Saved wiki/activity/2026-09-03_2026-09-03_process-codex-f256b097.md (1 row(s))"
    );
  });
});
