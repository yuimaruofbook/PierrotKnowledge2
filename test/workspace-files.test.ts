/**
 * The orientation files: MAP.md, human.md and Task.md.
 *
 * Two things need testing. The task file must survive a round trip, because it
 * is rewritten in place on every change and a lossy parser would quietly
 * delete someone's work. And the token claim behind the whole design — that
 * routing through MAP is cheaper than reading around — has to be measured
 * rather than asserted.
 */

import { describe, expect, test } from "bun:test";
import {
  KEPT_DONE_TASKS,
  MAP_ENTRIES,
  MAP_USER_MARKER,
  isWorkspaceFilename,
  nextTaskId,
  openTasks,
  parseTasks,
  renderHumanTemplate,
  renderMap,
  renderTasks,

  type TaskFile,
} from "../src/shared/okf/workspace-files";
import { estimateTokens } from "../src/shared/okf/skill";
import { isConceptPath } from "../src/shared/okf/concept";

const sample: TaskFile = {
  doneEver: 3,
  tasks: [
    { id: "T-0003", title: "RMUX 連携を検証する", status: "doing", para: "project" },
    { id: "T-0004", title: "human.md を書く", status: "todo", due: "2026-08-31" },
    { id: "T-0005", title: "取り込み手順を直す", status: "todo", note: "raw/ の議事録から" },
    { id: "T-0002", title: "rmux をインストールする", status: "done", done: "2026-08-03" },
  ],
};

describe("task file round trip", () => {
  test("every field survives render → parse", () => {
    const back = parseTasks(renderTasks(sample));

    expect(back.tasks).toHaveLength(sample.tasks.length);
    for (const original of sample.tasks) {
      const parsed = back.tasks.find((t) => t.id === original.id);
      expect(parsed).toEqual(original);
    }
  });

  test("the all-time completed count survives", () => {
    // Without this the heading would reset every rewrite and the count would
    // silently shrink as old entries aged out.
    expect(parseTasks(renderTasks(sample)).doneEver).toBe(3);
  });

  test("status comes from the section, not the checkbox", () => {
    // A stray `[x]` under 未着手 is a typo; trusting it would move a task
    // nobody finished into the done pile.
    const file = parseTasks(["# タスク", "", "## 未着手", "", "- [x] T-0009 まだ終わっていない"].join("\n"));

    expect(file.tasks[0]?.status).toBe("todo");
  });

  test("prose under a user's own heading is not read as tasks", () => {
    const file = parseTasks(
      [
        "## 未着手",
        "",
        "- [ ] T-0001 本物のタスク",
        "",
        "## メモ",
        "",
        "- [ ] T-0002 これは例であってタスクではない",
      ].join("\n")
    );

    expect(file.tasks.map((t) => t.id)).toEqual(["T-0001"]);
  });

  test("a hand-written line that is not a task is skipped, not lost", () => {
    // The file is meant to be edited by hand, so anything unrecognised is
    // ignored rather than treated as an error.
    const file = parseTasks(["## 未着手", "", "ここに自由に書ける", "- [ ] T-0001 タスク"].join("\n"));

    expect(file.tasks).toHaveLength(1);
  });

  test("ids do not collide with what is already there", () => {
    expect(nextTaskId(sample.tasks)).toBe("T-0006");
    expect(nextTaskId([])).toBe("T-0001");
  });

  test("completed history is bounded", () => {
    const many: TaskFile = {
      doneEver: 100,
      tasks: Array.from({ length: 100 }, (_, i) => ({
        id: `T-${String(i + 1).padStart(4, "0")}`,
        title: `古い作業 ${i}`,
        status: "done" as const,
        done: "2026-01-01",
      })),
    };

    const rendered = renderTasks(many);
    expect(parseTasks(rendered).tasks).toHaveLength(KEPT_DONE_TASKS);
    // The count is kept even though the entries are not, so nothing is
    // silently lost.
    expect(parseTasks(rendered).doneEver).toBe(100);
  });

  test("open work is ordered with what is in progress first", () => {
    const order = openTasks(sample).map((t) => t.status);
    expect(order[0]).toBe("doing");
    expect(order).not.toContain("done");
  });
});

describe("MAP", () => {
  test("regenerating keeps what the user wrote", () => {
    const first = renderMap();
    const edited = `${first}\n私の決まり: 議事録は必ず raw/meetings に置く\n`;
    const again = renderMap(edited);

    expect(again).toContain("私の決まり: 議事録は必ず raw/meetings に置く");
    expect(again).toContain(MAP_USER_MARKER);
  });

  test("every routed location is named in the rendered table", () => {
    const map = renderMap();
    for (const entry of MAP_ENTRIES) {
      expect(map).toContain(entry.where);
      expect(map).toContain(entry.tool);
    }
  });

  test("the layer permissions are stated, since they are the one hard rule", () => {
    const map = renderMap();
    expect(map).toContain("raw/");
    expect(map).toMatch(/エージェントは書けません/);
  });
});

describe("these files are not knowledge", () => {
  test("they are excluded from the concept scan", () => {
    // Indexing them would put a task list and someone's personal details into
    // the same search results as facts.
    expect(isConceptPath("wiki/MAP.md")).toBe(false);
    expect(isConceptPath("wiki/human.md")).toBe(false);
    expect(isConceptPath("wiki/Task.md")).toBe(false);
    expect(isConceptPath("wiki/1-projects/real-note.md")).toBe(true);
  });

  test("the check is case-insensitive, since Windows is", () => {
    expect(isWorkspaceFilename("map.md")).toBe(true);
    expect(isWorkspaceFilename("TASK.MD")).toBe(true);
    expect(isWorkspaceFilename("mapping.md")).toBe(false);
  });
});

describe("the cost this design is meant to avoid", () => {
  test("MAP is small enough to always read first", () => {
    // The whole argument for reading MAP before anything else is that it is
    // cheap. If it grows past a few hundred tokens that stops being true.
    expect(estimateTokens(renderMap())).toBeLessThan(700);
  });

  test("asking for open work costs far less than reading the file", () => {
    // This is the measurement behind `list_tasks` defaulting to open work: the
    // finished history dominates a real file, and almost no caller wants it.
    const file: TaskFile = {
      doneEver: 60,
      tasks: [
        { id: "T-0100", title: "いま進めていること", status: "doing" },
        { id: "T-0101", title: "次にやること", status: "todo" },
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `T-${String(i + 1).padStart(4, "0")}`,
          title: `終わった作業 ${i}: 経緯と結果をそれなりの長さで書いたもの`,
          status: "done" as const,
          done: "2026-07-01",
        })),
      ],
    };

    const whole = estimateTokens(renderTasks(file));
    const open = estimateTokens(openTasks(file).map((t) => `${t.id} ${t.title}`).join("\n"));

    expect(open).toBeLessThan(whole / 4);
  });

  test("the human template is a prompt, not an empty shell", () => {
    // An unfilled file is worth less than no file: the agent still pays to
    // read it. Prompts get answered; blank headings do not.
    const template = renderHumanTemplate();
    expect(template).toContain("呼び方");
    expect(template).toMatch(/例:/);
    expect(estimateTokens(template)).toBeLessThan(400);
  });
});
