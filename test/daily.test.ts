/**
 * Daily notes, and the rule that moves their task lines into `Task.md`.
 *
 * The rule is the part that needs holding down. It rewrites two files at once,
 * and the failure modes are both silent: a requirement that never arrives in
 * `Task.md`, or one that arrives again every time the tool is called.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  DAILY_TASK_HEADING,
  dailyId,
  dailyRelPath,
  dailyTemplate,
  dailyTitle,
  isDailyPath,
  markTransferred,
  pendingTaskLines,
} from "../src/shared/okf/daily";
import { Workspace } from "../src/bun/workspace";
import { removeTempDir } from "./helpers";

describe("naming a day", () => {
  test("the id is the local date, not UTC", () => {
    // `new Date("2026-08-04")` is UTC midnight, which is 2026-08-03 anywhere
    // west of Greenwich — the note would be filed under the wrong day.
    const localMorning = new Date(2026, 7, 4, 1, 30);
    expect(dailyId(localMorning)).toBe("2026-08-04");

    const localLateNight = new Date(2026, 7, 4, 23, 45);
    expect(dailyId(localLateNight)).toBe("2026-08-04");
  });

  test("the path lives under daily/", () => {
    expect(dailyRelPath(new Date(2026, 7, 4))).toBe("daily/2026-08-04.md");
  });

  test("the title carries the weekday", () => {
    // 2026-08-04 is a Tuesday. Scanning back through days is much easier with
    // it than without.
    expect(dailyTitle(new Date(2026, 7, 4))).toBe("2026-08-04（火）");
  });

  test("a daily note is recognisable from its path alone", () => {
    expect(isDailyPath("daily/2026-08-04.md")).toBe(true);
    expect(isDailyPath("wiki/daily/2026-08-04.md")).toBe(true);
    expect(isDailyPath("daily/notes.md")).toBe(false);
    expect(isDailyPath("3-resources/2026-08-04.md")).toBe(false);
  });
});

describe("finding task lines", () => {
  const note = [
    "# 2026-08-04（火）",
    "",
    DAILY_TASK_HEADING,
    "",
    "- [ ] 議事録を wiki に取り込む",
    "- [x] 資料を集める → T-0011",
    "- [ ] ",
    "",
    "## メモ",
    "",
    "持ち物:",
    "- [ ] 充電器",
    "- [ ] 鍵",
  ].join("\n");

  test("only unchecked items under the task heading count", () => {
    const found = pendingTaskLines(note);
    expect(found.map((f) => f.text)).toEqual(["議事録を wiki に取り込む"]);
  });

  test("checklists in other sections are left alone", () => {
    // A packing list is not a work item, and hoovering up every checkbox would
    // fill Task.md with things nobody asked to track.
    expect(pendingTaskLines(note).some((f) => f.text.includes("充電器"))).toBe(false);
  });

  test("the template's empty placeholder never becomes a task", () => {
    expect(pendingTaskLines(dailyTemplate())).toEqual([]);
  });

  test("a transferred line is ticked and stamped with its id", () => {
    const found = pendingTaskLines(note);
    const after = markTransferred(note, found[0]!.line, "T-0042");

    expect(after).toContain("- [x] 議事録を wiki に取り込む → T-0042");
    // And is no longer pending, which is what makes a second run a no-op.
    expect(pendingTaskLines(after)).toEqual([]);
  });
});

describe("the daily note in a bundle", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okf-daily-"));
    workspace = new Workspace({ watch: false });
    await workspace.scaffold(root);
    await workspace.open(root);
  });

  afterEach(async () => {
    await workspace.close();
    await removeTempDir(root);
  });

  test("opening today creates it once, then reuses it", async () => {
    const first = await workspace.openDaily();
    expect(first.created).toBe(true);

    const second = await workspace.openDaily();
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });

  test("a daily note is a conformant concept, so it is searchable", async () => {
    // The whole point of filing these in wiki/ rather than off to one side:
    // "what did I decide last Tuesday" has to be answerable.
    const { path } = await workspace.openDaily();
    const issues = workspace.conformanceIssues();

    expect(issues.filter((i) => i.path === path)).toEqual([]);
  });

  test("task lines move into Task.md and are not moved twice", async () => {
    const { path } = await workspace.openDaily();
    const original = (await workspace.readFile(path)).content;

    await workspace.writeFile(
      path,
      original.replace("- [ ] ", "- [ ] 議事録を取り込む\n- [ ] 図を描き直す"),
      { actor: "human:local", action: "update" }
    );

    const created = await workspace.collectDailyTasks();
    expect(created.map((t) => t.title)).toEqual(["議事録を取り込む", "図を描き直す"]);

    // Each carries where it came from, so the task is traceable to the day.
    expect(created[0]!.note).toContain(dailyId());

    // The note now shows them ticked with their ids.
    const after = await readFile(join(root, path), "utf8");
    expect(after).toContain(`→ ${created[0]!.id}`);

    // Running again adds nothing: this is called on every daily-note read.
    expect(await workspace.collectDailyTasks()).toEqual([]);
    expect((await workspace.listTasks()).length).toBe(2);
  });

  test("a note with nothing pending is left untouched", async () => {
    const { path } = await workspace.openDaily();
    const before = await readFile(join(root, path), "utf8");

    expect(await workspace.collectDailyTasks()).toEqual([]);
    expect(await readFile(join(root, path), "utf8")).toBe(before);
  });

  test("collecting from a day with no note at all is not an error", async () => {
    // An agent may call this speculatively; failing would make it unusable.
    expect(await workspace.collectDailyTasks(new Date(2020, 0, 1))).toEqual([]);
  });
});
