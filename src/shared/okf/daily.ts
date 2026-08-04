/**
 * Daily notes: one dated page per day, and the task lines written in it.
 *
 * A daily note is a capture surface. You open it and write — a meeting, a
 * decision, something to do later — without first deciding where any of it
 * belongs. Curating comes after, which is the same shape as `raw/` → `wiki/`
 * except that here you are the source.
 *
 * They live in `wiki/daily/` and are ordinary concepts: indexed, searchable,
 * linkable. "What did I decide last Tuesday" is a real question and it can only
 * be answered if these are in the index like everything else.
 *
 * The task half exists because a requirement written into a day's notes is
 * invisible tomorrow. `Task.md` is the list that gets read; a line in a daily
 * note is not. So an unchecked item under the tasks heading is a *request* to
 * put it there, and once it has been the line is checked off and stamped with
 * the id — which makes the transfer idempotent, because a checked line is
 * already done and is never carried over twice.
 */

export const DAILY_DIR = "daily";

/** Heading whose unchecked items become tasks. */
export const DAILY_TASK_HEADING = "## タスク";

/** `2026-08-04`. Local date, because a day is a local idea. */
export function dailyId(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Wiki-relative path of a day's note. */
export function dailyRelPath(date: Date = new Date()): string {
  return `${DAILY_DIR}/${dailyId(date)}.md`;
}

/** True for a path that is a daily note, so callers need not re-derive it. */
export function isDailyPath(wikiRelPath: string): boolean {
  return /(^|\/)daily\/\d{4}-\d{2}-\d{2}\.md$/i.test(wikiRelPath.replace(/\\/g, "/"));
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** `2026-08-04（火）` — the weekday matters when scanning back through days. */
export function dailyTitle(date: Date = new Date()): string {
  return `${dailyId(date)}（${WEEKDAYS[date.getDay()]}）`;
}

/**
 * The body of a new daily note.
 *
 * Headings rather than an empty page: a blank note gets filled with whatever
 * shape the day happens to take, and next week none of them match. The task
 * heading is first because it is the one an agent acts on.
 */
export function dailyTemplate(): string {
  return [
    DAILY_TASK_HEADING,
    "",
    "<!-- 未チェックの項目は Task.md に取り込まれ、取り込み後に [x] と ID が付きます -->",
    "",
    "- [ ] ",
    "",
    "## メモ",
    "",
    "",
    "## 今日わかったこと",
    "",
    "<!-- あとで概念として切り出す価値があるものはここに -->",
    "",
  ].join("\n");
}

export interface DailyTaskLine {
  /** 0-based index into the note's lines. */
  line: number;
  /** The task text, without the checkbox. */
  text: string;
}

const TASK_LINE = /^(\s*)-\s*\[( |x|X)\]\s*(.*)$/;

/**
 * Unchecked items under the task heading.
 *
 * Scoped to that one section on purpose: checklists appear all over notes —
 * packing lists, test steps, things already done — and hoovering up every
 * checkbox in the file would fill `Task.md` with things nobody asked to track.
 *
 * Empty items are skipped so the template's own placeholder never becomes a
 * task named "".
 */
export function pendingTaskLines(raw: string): DailyTaskLine[] {
  const lines = raw.split(/\r?\n/);
  const out: DailyTaskLine[] = [];
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (/^##\s/.test(line)) {
      inSection = line.trim() === DAILY_TASK_HEADING;
      continue;
    }
    if (!inSection) continue;

    const match = TASK_LINE.exec(line);
    if (!match) continue;

    const [, , box, text = ""] = match;
    if (box !== " ") continue;
    if (!text.trim()) continue;

    out.push({ line: i, text: text.trim() });
  }

  return out;
}

/**
 * Check off a transferred line and record the id it became.
 *
 * Writing the id back is what makes the daily note still worth reading later:
 * "I said I would do this" and "it is tracked as T-0012" are different facts,
 * and only the second one survives in `Task.md`.
 */
export function markTransferred(raw: string, line: number, taskId: string): string {
  const lines = raw.split(/\r?\n/);
  const target = lines[line];
  if (target === undefined) return raw;

  const match = TASK_LINE.exec(target);
  if (!match) return raw;

  const [, indent = "", , text = ""] = match;
  lines[line] = `${indent}- [x] ${text.trim()} → ${taskId}`;
  return lines.join("\n");
}
