/**
 * Loops: one file per loop *design*, runs accumulating inside it.
 *
 * Two properties matter and neither is visible from ordinary use, so both are
 * asserted directly: designs never share a file, and the history stays bounded
 * no matter how many times a design is run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Workspace } from "../src/bun/workspace";
import { callTool } from "../src/bun/mcp/tools";
import {
  DETAILED_RUNS,
  SUMMARY_RUNS,
  isRegression,
  isValidLoopName,
  parseLoop,
  renderLoop,
  slugifyLoopName,
} from "../src/shared/okf/loop";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? "";

/** Design files only — the scaffold also puts a README in loops/. */
async function loopFiles(): Promise<string[]> {
  const entries = await readdir(join(root, "wiki", "loops"));
  return entries.filter((name) => name.endsWith(".md") && name !== "README.md");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-loop-test-"));
  workspace = new Workspace({ watch: false });
  await workspace.scaffold(root);
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("loop names", () => {
  test("a goal becomes a usable name", () => {
    expect(slugifyLoopName("Ingest meeting notes")).toBe("ingest-meeting-notes");
  });

  test("Japanese goals still yield a valid name", () => {
    // Japanese cannot survive in an ASCII identifier, so it degrades to a
    // default rather than producing something unusable as a filename.
    expect(isValidLoopName(slugifyLoopName("議事録を取り込む"))).toBe(true);
  });

  test("path separators can never appear in a name", () => {
    expect(isValidLoopName("../escape")).toBe(false);
    expect(isValidLoopName("a/b")).toBe(false);
    expect(isValidLoopName("Weekly Lint")).toBe(false);
    expect(isValidLoopName("weekly-lint")).toBe(true);
  });
});

describe("the design file", () => {
  const design = {
    name: "ingest-notes",
    goal: "議事録を取り込む",
    skill: "okf-ingest",
    checks: ["未解決リンクを確認した", "index.md を再構築した"],
    created: "2026-08-01T00:00:00Z",
    runs: 2,
    history: [
      {
        started: "2026-08-02T14:30:00Z",
        ended: "2026-08-02T14:52:00Z",
        status: "done" as const,
        before: { concepts: 42, nonConformant: 0, unresolvedLinks: 7 },
        after: { concepts: 45, nonConformant: 0, unresolvedLinks: 9 },
        journal: [{ at: "14:35:00", action: "create", detail: "wiki/a.md" }],
        outcome: "3 ページ作成",
      },
      {
        started: "2026-08-01T09:00:00Z",
        status: "done" as const,
        before: { concepts: 40, nonConformant: 0, unresolvedLinks: 5 },
        after: { concepts: 42, nonConformant: 0, unresolvedLinks: 7 },
        journal: [],
        outcome: "2 ページ作成",
      },
    ],
  };

  test("round-trips through render and parse", () => {
    const again = parseLoop(renderLoop(design), design.name);

    expect(again.goal).toBe(design.goal);
    expect(again.skill).toBe("okf-ingest");
    expect(again.checks).toEqual(design.checks);
    expect(again.runs).toBe(2);
    expect(again.history).toHaveLength(2);
    expect(again.history[0]?.journal).toEqual(design.history[0]!.journal);
    expect(again.history[0]?.outcome).toBe("3 ページ作成");
    expect(again.history[0]?.before).toEqual(design.history[0]!.before);
    expect(again.history[0]?.after).toEqual(design.history[0]!.after);
  });

  test("a design that has never run is still valid", () => {
    const fresh = parseLoop(
      renderLoop({ ...design, runs: 0, history: [] }),
      design.name
    );

    expect(fresh.history).toEqual([]);
    expect(fresh.runs).toBe(0);
  });

  test("a hand-edited file still parses", () => {
    const loop = parseLoop("---\nloop: x\ngoal: 手で書いた\n---\n\n# 手で書いた\n", "x");

    expect(loop.goal).toBe("手で書いた");
    expect(loop.history).toEqual([]);
  });

  test("only rising non-conformance counts as a regression", () => {
    const base = { concepts: 10, nonConformant: 0, unresolvedLinks: 3 };

    expect(isRegression(base, { ...base, nonConformant: 1 })).toBe(true);
    // More unresolved links means gaps were identified — that is the point.
    expect(isRegression(base, { ...base, unresolvedLinks: 9 })).toBe(false);
  });
});

describe("one design, one file", () => {
  test("defining a loop creates exactly one file", async () => {
    // The scaffold ships starter designs, so count the change rather than the
    // total.
    const before = (await loopFiles()).length;
    await workspace.requireLoops().define({ goal: "Brand new loop" });

    const after = await loopFiles();
    expect(after.length).toBe(before + 1);
    expect(after).toContain("brand-new-loop.md");
  });

  test("running the same design many times does not create more files", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });

    for (let n = 0; n < 5; n++) {
      await loops.start({ name: "weekly-lint" });
      await loops.end({ outcome: `run ${n}` });
    }

    // This is the correction the whole redesign is about: five runs, one file.
    expect((await loopFiles()).filter((n) => n === "weekly-lint.md")).toHaveLength(1);
    expect((await loops.read("weekly-lint")).runs).toBe(5);
  });

  test("different designs never share a file", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Ingest notes", name: "ingest-notes" });
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });

    expect(await loopFiles()).toContain("ingest-notes.md");
    expect(await loopFiles()).toContain("weekly-lint.md");
    expect((await loops.read("ingest-notes")).goal).toBe("Ingest notes");
    expect((await loops.read("weekly-lint")).goal).toBe("Weekly lint");
  });

  test("redefining updates the design without touching its history", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });
    await loops.start({ name: "weekly-lint" });
    await loops.end({ outcome: "一回目" });

    await loops.define({ goal: "Weekly lint (改訂)", name: "weekly-lint", checks: ["新しい条件"] });

    const design = await loops.read("weekly-lint");
    expect(design.goal).toBe("Weekly lint (改訂)");
    expect(design.checks).toEqual(["新しい条件"]);
    // Editing the plan must not rewrite the past.
    expect(design.runs).toBe(1);
    expect(design.history[0]?.outcome).toBe("一回目");
  });

  test("a name cannot escape the loops directory", async () => {
    for (const bad of ["../wiki/index", "a/b", "..\\escape"]) {
      try {
        await workspace.requireLoops().read(bad);
        throw new Error(`should have refused: ${bad}`);
      } catch (error) {
        expect((error as Error).message).toContain("ループ名");
      }
    }
  });
});

describe("one run at a time", () => {
  test("a second run is refused while one is in progress", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Ingest notes", name: "ingest-notes" });
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });

    await loops.start({ name: "ingest-notes" });

    try {
      await loops.start({ name: "weekly-lint" });
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("実行中");
    }
  });

  test("closing frees the slot", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });

    await loops.start({ name: "weekly-lint" });
    await loops.end({});
    const second = await loops.start({ name: "weekly-lint" });

    expect(second.runNumber).toBe(2);
  });

  test("an in-progress run is recovered after a restart", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });
    await loops.start({ name: "weekly-lint" });
    await workspace.close();

    const reopened = new Workspace({ watch: false });
    await reopened.open(root);

    expect(reopened.requireLoops().runningLoop).toBe("weekly-lint");
    await reopened.close();
  });

  test("ending without a run in progress is refused", async () => {
    try {
      await workspace.requireLoops().end({});
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("実行中のループがありません");
    }
  });
});

describe("bounded history", () => {
  test("runs beyond the cap are dropped, but the count survives", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });

    const total = SUMMARY_RUNS + 5;
    for (let n = 0; n < total; n++) {
      await loops.start({ name: "weekly-lint" });
      await loops.end({ outcome: `run ${n}` });
    }

    const design = await loops.read("weekly-lint");
    expect(design.runs).toBe(total);
    // The file must stay readable no matter how long the loop has been in use.
    expect(design.history.length).toBeLessThanOrEqual(SUMMARY_RUNS);

    const raw = await readFile(join(root, "wiki", "loops", "weekly-lint.md"), "utf8");
    expect(raw).toContain("回の実行は記録から省略");
  });

  test("only the most recent runs keep their journal", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });

    for (let n = 0; n < DETAILED_RUNS + 3; n++) {
      await loops.start({ name: "weekly-lint" });
      await loops.note("note", `詳細 ${n}`);
      await loops.end({ outcome: `run ${n}` });
    }

    const raw = await readFile(join(root, "wiki", "loops", "weekly-lint.md"), "utf8");
    const latest = DETAILED_RUNS + 2;
    expect(raw).toContain(`詳細 ${latest}`);
    // The oldest run's journal is gone; its one-line summary is not.
    expect(raw).not.toContain("詳細 0");
    expect(raw).toContain("run 0");
  });

  test("a summarised run does not decay on later rewrites", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });

    // Push a run past the detail cap, then keep running so its summary line is
    // parsed and re-emitted several more times.
    for (let n = 0; n < DETAILED_RUNS + 6; n++) {
      await loops.start({ name: "weekly-lint" });
      await loops.end({ outcome: `run ${n}` });
    }

    const raw = await readFile(join(root, "wiki", "loops", "weekly-lint.md"), "utf8");
    // Every summarised run finished, so none of them may read as unfinished.
    expect(raw).not.toContain("未完了");
    expect(raw).toContain("run 0");

    const design = await loops.read("weekly-lint");
    const oldest = design.history[design.history.length - 1];
    expect(oldest?.status).toBe("done");
    expect(oldest?.summary?.nonConformant).toBe("±0");
  });

  test("a file with a long history stays a reasonable size", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Weekly lint", name: "weekly-lint" });

    for (let n = 0; n < SUMMARY_RUNS + 10; n++) {
      await loops.start({ name: "weekly-lint" });
      await loops.note("write", "wiki/some/long/path/to/a/note.md");
      await loops.end({ outcome: `run ${n}` });
    }

    const raw = await readFile(join(root, "wiki", "loops", "weekly-lint.md"), "utf8");
    expect(raw.length).toBeLessThan(8000);
  });
});

describe("preflight and postflight", () => {
  test("start reports state, skill and checks in one call", async () => {
    await callTool(workspace, "loop_define", {
      goal: "議事録を wiki に取り込む",
      name: "ingest-notes",
      skill: "okf-ingest",
      checks: ["未解決リンクを確認した"],
    });

    const payload = JSON.parse(
      textOf(await callTool(workspace, "loop_start", { name: "ingest-notes" }))
    );

    expect(payload.before.nonConformant).toBe(0);
    expect(payload.skill).toBe("okf-ingest");
    expect(payload.checks).toEqual(["未解決リンクを確認した"]);
    expect(payload.next).toContain("skill_open");
    expect(payload.runNumber).toBe(1);
  });

  test("start suggests a skill when the design names none", async () => {
    const payload = JSON.parse(
      textOf(await callTool(workspace, "loop_start", { goal: "議事録を取り込みたい" }))
    );

    expect(payload.suggested[0].name).toBe("okf-ingest");
  });

  test("start defines the design on the spot when it is new", async () => {
    const payload = JSON.parse(
      textOf(await callTool(workspace, "loop_start", { goal: "Weekly lint", name: "weekly-lint" }))
    );

    expect(payload.name).toBe("weekly-lint");
    expect(await loopFiles()).toContain("weekly-lint.md");
  });

  test("start reports how the previous run went", async () => {
    await callTool(workspace, "loop_start", { goal: "Weekly lint", name: "weekly-lint" });
    await callTool(workspace, "loop_end", { outcome: "前回の結果" });

    const payload = JSON.parse(
      textOf(await callTool(workspace, "loop_start", { name: "weekly-lint" }))
    );

    expect(payload.lastRun.outcome).toBe("前回の結果");
    expect(payload.runNumber).toBe(2);
  });

  test("end reports the difference and the checks", async () => {
    await callTool(workspace, "loop_define", {
      goal: "ページを作る",
      name: "make-pages",
      checks: ["index.md を再構築した"],
    });
    await callTool(workspace, "loop_start", { name: "make-pages" });
    await workspace.writeFile("wiki/new-note.md", "---\ntype: Concept\n---\n\n# 新規\n", {
      actor: "test",
    });

    const result = await callTool(workspace, "loop_end", { outcome: "1 ページ作成" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("(+1)");
    expect(textOf(result)).toContain("index.md を再構築した");
  });

  test("a rise in non-conformance is reported as an error", async () => {
    await callTool(workspace, "loop_start", { goal: "壊す", name: "break-it" });
    // No frontmatter: an OKF §11 violation.
    await workspace.writeFile("wiki/broken.md", "# frontmatter がない\n", { actor: "test" });

    const result = await callTool(workspace, "loop_end", {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("非準拠");
  });
});

describe("the journal", () => {
  test("writes, moves and deletes are recorded automatically", async () => {
    const loops = workspace.requireLoops();
    await workspace.writeFile("wiki/old.md", "---\ntype: Concept\n---\n\n# Old\n", { actor: "t" });

    await loops.define({ goal: "Tidy up", name: "tidy-up" });
    await loops.start({ name: "tidy-up" });

    await workspace.writeFile("wiki/a.md", "---\ntype: Concept\n---\n\n# A\n", { actor: "test" });
    await workspace.move("wiki/old.md", "wiki/renamed.md");
    await workspace.delete("wiki/renamed.md");

    const journal = (await loops.read("tidy-up")).history[0]?.journal ?? [];
    expect(journal.map((e) => e.action)).toEqual(["write", "move", "delete"]);
    expect(journal[0]?.detail).toBe("wiki/a.md");
  });

  test("the journal does not journal itself", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Work", name: "work" });
    await loops.start({ name: "work" });
    await workspace.writeFile("wiki/a.md", "---\ntype: Concept\n---\n\n# A\n", { actor: "test" });

    // Recursion here would grow the file without bound.
    const journal = (await loops.read("work")).history[0]?.journal ?? [];
    expect(journal.some((e) => e.detail.startsWith("loops/"))).toBe(false);
  });

  test("entries reach disk as work happens, not only at the end", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "Work", name: "work" });
    await loops.start({ name: "work" });
    await loops.note("note", "途中経過");

    // An abandoned run must still leave a usable trace.
    const raw = await readFile(join(root, "wiki", "loops", "work.md"), "utf8");
    expect(raw).toContain("途中経過");
  });

  test("notes are refused when nothing is running", async () => {
    expect((await callTool(workspace, "loop_note", { detail: "x" })).isError).toBe(true);
  });

  test("a note lands in the running design's file and no other", async () => {
    const loops = workspace.requireLoops();
    await loops.define({ goal: "One", name: "one" });
    await loops.define({ goal: "Two", name: "two" });

    await loops.start({ name: "one" });
    await loops.note("note", "これは one のもの");
    await loops.end({});

    expect(await readFile(join(root, "wiki", "loops", "two.md"), "utf8")).not.toContain("one のもの");
  });
});

describe("the MCP surface", () => {
  test("loop_list guides an agent that is resuming", async () => {
    await callTool(workspace, "loop_define", { goal: "Weekly lint", name: "weekly-lint" });

    const idle = JSON.parse(textOf(await callTool(workspace, "loop_list", {})));
    expect(idle.running).toBeNull();
    expect(idle.loops.map((l: { name: string }) => l.name)).toContain("weekly-lint");
    expect(idle.hint).toContain("loop_start");

    await callTool(workspace, "loop_start", { name: "weekly-lint" });

    const busy = JSON.parse(textOf(await callTool(workspace, "loop_list", {})));
    expect(busy.running).toBe("weekly-lint");
    expect(busy.hint).toContain("loop_end");
  });

  test("loop_read returns the design and its history", async () => {
    await callTool(workspace, "loop_start", { goal: "Weekly lint", name: "weekly-lint" });
    await callTool(workspace, "loop_end", { outcome: "終わった" });

    const design = JSON.parse(
      textOf(await callTool(workspace, "loop_read", { name: "weekly-lint" }))
    );

    expect(design.runs).toBe(1);
    expect(design.history[0].outcome).toBe("終わった");
  });

  test("loop_start needs either a name or a goal", async () => {
    expect((await callTool(workspace, "loop_start", {})).isError).toBe(true);
  });

  test("an unknown loop fails clearly", async () => {
    const result = await callTool(workspace, "loop_read", { name: "no-such-loop" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no-such-loop");
  });

  test("abandoning is recorded as such", async () => {
    await callTool(workspace, "loop_start", { goal: "やめる", name: "give-up" });
    await callTool(workspace, "loop_end", { status: "abandoned", outcome: "中断" });

    expect((await workspace.requireLoops().read("give-up")).history[0]?.status).toBe("abandoned");
  });
});

describe("the layer contract", () => {
  test("loops live inside the wiki layer, not beside it", () => {
    // Three layers, not five: loops are curated content about the wiki.
    const paths = workspace.requireBundle().paths;

    expect(paths.layerOf("wiki/loops/weekly-lint.md")).toBe("wiki");
    expect(paths.layerOf("wiki/skills/x/SKILL.md")).toBe("wiki");
    expect(paths.layerOf("wiki/index.md")).toBe("wiki");
    expect(paths.layerOf("raw/a.md")).toBe("raw");
    expect(paths.layerOf(".rag/fts.sqlite")).toBe("rag");
  });

  test("loops are excluded from the concept scan", () => {
    // Inside the wiki layer, but not knowledge — a work log must not turn up
    // in the same results as a fact.
    const paths = workspace.requireBundle().paths;

    expect(paths.isSubsystemPath("wiki/loops/weekly-lint.md")).toBe(true);
    expect(paths.isSubsystemPath("wiki/skills/okf-ingest/SKILL.md")).toBe(true);
    expect(paths.isSubsystemPath("wiki/index.md")).toBe(false);
  });

  test("loop files are writable — they are a record, not a derived artifact", () => {
    expect(() => workspace.requireBundle().paths.assertWritable("wiki/loops/x.md")).not.toThrow();
  });

  test("loops are not indexed as concepts", async () => {
    await workspace.requireLoops().define({ goal: "検索に出てはいけない目的", name: "hidden" });

    // A loop is process, not knowledge; mixing them corrupts every search.
    expect(workspace.search("検索に出てはいけない目的")).toEqual([]);
  });
});
