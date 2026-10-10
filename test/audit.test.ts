/**
 * Provenance across models: parsing log.md back into entries, auditing them by
 * actor, and the write-time nudge that keeps `generated` on agent output.
 *
 * The scenario is several models writing into one bundle. What is tested is
 * the safety net that makes that tolerable: every recognisable log row can be
 * attributed, and an agent write without provenance is warned about at the
 * moment it happens rather than discovered later.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { insertLogEntry, isoDate, parseLogEntries } from "../src/shared/okf";
import { messages } from "../src/shared/messages";
import { Workspace } from "../src/bun/workspace";
import { callTool } from "../src/bun/mcp/tools";
import { removeTempDir } from "./helpers";

describe("parseLogEntries", () => {
  test("round-trips what insertLogEntry wrote, dotted actors included", () => {
    let log = "";
    log = insertLogEntry(log, {
      at: "2026-09-01T12:00:00Z",
      actor: "process:fable-5.1",
      action: "create",
      path: "wiki/a.md",
    });
    log = insertLogEntry(log, {
      at: "2026-09-02T12:00:00Z",
      actor: "human:local",
      action: "write",
      path: "wiki/b.md",
      note: "typo fixed",
    });

    const entries = parseLogEntries(log);
    expect(entries).toEqual([
      { date: "2026-09-02", kind: "Update", path: "wiki/b.md", actor: "human:local", note: "typo fixed" },
      { date: "2026-09-01", kind: "Creation", path: "wiki/a.md", actor: "process:fable-5.1" },
    ]);
  });

  test("skips hand-written prose instead of failing the audit", () => {
    const log = [
      "# Log",
      "",
      "## 2026-09-01",
      "",
      "* 手で書いたメモ。書式は自由。",
      "* **Update**: `wiki/x.md` by human:local.",
      "",
    ].join("\n");

    const entries = parseLogEntries(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("wiki/x.md");
  });
});

describe("auditing a live bundle", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okf-audit-test-"));
    await mkdir(join(root, "wiki"), { recursive: true });
    workspace = new Workspace({ watch: false });
    await workspace.open(root);

    await workspace.writeFile("wiki/one.md", "---\ntype: Note\n---\n\nA\n", {
      by: "agent",
      actor: "process:local-qwen",
    });
    await workspace.writeFile("wiki/two.md", "---\ntype: Note\n---\n\nB\n", {
      by: "agent",
      actor: "process:local-qwen",
    });
    await workspace.writeFile("wiki/three.md", "---\ntype: Note\n---\n\nC\n", {
      actor: "human:local",
    });
  });

  afterEach(async () => {
    await workspace.close();
    await removeTempDir(root);
  });

  test("groups changes by actor, busiest first", async () => {
    const audit = await workspace.auditChanges();
    expect(audit.total).toBe(3);
    expect(audit.actors[0]!.actor).toBe("process:local-qwen");
    expect(audit.actors[0]!.count).toBe(2);
    expect(audit.actors.map((a) => a.actor)).toContain("human:local");
  });

  test("filters by actor substring and by date", async () => {
    const agents = await workspace.auditChanges({ actor: "process:" });
    expect(agents.total).toBe(2);
    expect(agents.actors).toHaveLength(1);

    // Local tomorrow, because log headings are local days.
    const next = new Date();
    next.setDate(next.getDate() + 1);
    const future = await workspace.auditChanges({ since: isoDate(next) });
    expect(future.total).toBe(0);
  });

  test("audit_changes tool reports and validates", async () => {
    const ok = await callTool(workspace, "audit_changes", { actor: "process:" });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).toContain("process:local-qwen");

    const bad = await callTool(workspace, "audit_changes", { since: "yesterday" });
    expect(bad.isError).toBe(true);

    const none = await callTool(workspace, "audit_changes", { actor: "process:nonexistent" });
    expect(none.content[0]!.text).toBe(messages.auditNoChanges);
  });

  test("an agent write without generated frontmatter is warned about", async () => {
    const result = await callTool(workspace, "write_file", {
      path: "wiki/no-provenance.md",
      content: "---\ntype: Note\n---\n\nbody\n",
      actor: "process:test",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain(messages.missingProvenance);
  });

  test("a write carrying generated passes clean", async () => {
    const result = await callTool(workspace, "write_file", {
      path: "wiki/with-provenance.md",
      content:
        "---\ntype: Note\ngenerated:\n  by: process:test\n  at: 2026-09-10T00:00:00Z\n---\n\nbody\n",
      actor: "process:test",
    });
    expect(result.content[0]!.text).toBe("Wrote wiki/with-provenance.md");
  });

  test("a non-concept write is not held to concept provenance", async () => {
    const result = await callTool(workspace, "write_file", {
      path: "wiki/loops/README.md",
      content: "# Loops\n",
      actor: "process:test",
    });
    expect(result.content[0]!.text).not.toContain(messages.missingProvenance);
  });

  test("a layer root cannot be deleted, even recursively", async () => {
    for (const root of ["wiki", "", "raw", ".rag"]) {
      await expect(workspace.delete(root, "human:local", "human")).rejects.toThrow(/層のルート/);
    }
  });

  test("changing the case of a layer root does not get past the guard", async () => {
    // On Windows and macOS `WIKI` and `wiki` are one directory, so a
    // case-sensitive check would let this delete the whole wiki layer.
    const casings = process.platform === "linux" ? ["wiki"] : ["WIKI", "Wiki", "./WIKI"];
    for (const path of casings) {
      await expect(workspace.delete(path, "human:local", "human")).rejects.toThrow(/層のルート/);
    }

    // The layer is still there afterwards.
    expect((await workspace.listTasks()).length).toBeGreaterThanOrEqual(0);
    expect(workspace.requireBundle().allConcepts().length).toBe(3);
  });

  test("promotion refuses a source outside raw/ with the real reason", async () => {
    // Not "not found" — the file exists; it is just not promotable.
    await expect(workspace.promote("wiki/one.md", "wiki/copy.md")).rejects.toThrow(
      /raw\/ の中のファイル/
    );
  });

  test("daily_note rejects a rolled-over calendar date", async () => {
    const result = await callTool(workspace, "daily_note", { date: "2026-02-30" });
    expect(result.isError).toBe(true);
  });
});
