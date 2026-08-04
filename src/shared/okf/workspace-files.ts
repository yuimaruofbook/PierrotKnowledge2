/**
 * The three orientation files: `MAP.md`, `human.md`, `Task.md`.
 *
 * They sit at the bundle root, **beside** the three layers rather than inside
 * one. `raw/`, `wiki/` and `.rag/` are three stages of the same material;
 * these are not that material. MAP describes where things live, `human.md` is
 * about the person, `Task.md` is about work in flight — none is knowledge and
 * none is derived from knowledge.
 *
 * They answer the questions an agent has *before* it knows anything: who am I
 * working for, what am I supposed to be doing, and where does everything live.
 * Without them an agent's only way to find out is to read widely — which is
 * exactly the cost this module exists to avoid.
 *
 * The efficiency argument is structural, not a matter of writing less:
 *
 *   - **MAP.md is read first and is small.** It is a routing table, so the
 *     agent opens the one file that holds what it needs instead of scanning to
 *     find out where things are. Its generated half is rendered from the code
 *     below, so it cannot drift from the layout it describes.
 *   - **`Task.md` is queryable.** Open work is a handful of lines; the history
 *     behind it is unbounded. Parsing means an agent can ask for what is open
 *     and never pay for what is finished — the same trade the loop designs
 *     make, and for the same reason.
 *   - **`human.md` is deliberately not parsed.** It is small, read whole, and
 *     read rarely. A parser would add a format to maintain and save nothing.
 *
 * They are still excluded from the concept scan by name: a bundle opened
 * directly as its own wiki layer has no separate root to put them in, and
 * there they would otherwise be indexed as pages.
 */

import { PARA_DESCRIPTIONS, type ParaClass, parseParaClass } from "./para";

export const MAP_FILE = "MAP.md";
export const HUMAN_FILE = "human.md";
export const TASK_FILE = "Task.md";

/**
 * Lowercase basenames of the wiki-layer files that are not concepts.
 *
 * Kept apart from OKF's `RESERVED_FILENAMES` on purpose: OKF §3 reserves
 * exactly `index.md` and `log.md`. These are the LLM Wiki pattern's own files,
 * and folding them into the OKF set would make this implementation claim
 * something the format does not say.
 */
export const WORKSPACE_FILENAMES = [
  MAP_FILE.toLowerCase(),
  HUMAN_FILE.toLowerCase(),
  TASK_FILE.toLowerCase(),
] as const;

export function isWorkspaceFilename(name: string): boolean {
  return (WORKSPACE_FILENAMES as readonly string[]).includes(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus = "doing" | "todo" | "done";

export interface Task {
  /** `T-0007`. Stable across edits so notes and commits can refer to it. */
  id: string;
  title: string;
  status: TaskStatus;
  para?: ParaClass;
  /** ISO date. */
  due?: string;
  /** ISO date the task was completed. */
  done?: string;
  /** One line of detail, indented under the item. */
  note?: string;
}

/**
 * Completed tasks kept in the file.
 *
 * Finished work is worth a little memory and not much: enough to see what
 * happened recently, not so much that the file grows without limit. The count
 * of everything ever completed is kept in the heading, so nothing is silently
 * lost.
 */
export const KEPT_DONE_TASKS = 25;

const SECTION_DOING = "## 進行中";
const SECTION_TODO = "## 未着手";
const SECTION_DONE = "## 完了";

/** Status comes from the section a task sits in, not from the checkbox. */
const SECTION_STATUS: Array<[string, TaskStatus]> = [
  [SECTION_DOING, "doing"],
  [SECTION_TODO, "todo"],
  [SECTION_DONE, "done"],
];

const TASK_LINE_RE = /^\s*-\s*\[( |x|X)\]\s*(T-\d{4})\s+(.*)$/;
const ID_RE = /^T-(\d{4})$/;

export function formatTaskId(n: number): string {
  return `T-${String(n).padStart(4, "0")}`;
}

/** The next free id, so two agents appending do not collide on a number. */
export function nextTaskId(tasks: readonly Task[]): string {
  let highest = 0;
  for (const task of tasks) {
    const match = ID_RE.exec(task.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return formatTaskId(highest + 1);
}

/**
 * Render one task.
 *
 * Metadata rides on the same line separated by `·`, which keeps a task to one
 * line in every renderer while staying trivially parseable. The checkbox is
 * only ever `[ ]` or `[x]` so the file renders correctly in any Markdown tool;
 * "doing" is expressed by the section, not by a non-standard checkbox.
 */
function renderTask(task: Task): string {
  const parts = [task.title];
  // The PARA class round-trips as its own name, which `parseParaClass` reads
  // back directly.
  if (task.para) parts.push(task.para);
  if (task.due) parts.push(`期限 ${task.due}`);
  if (task.done) parts.push(`完了 ${task.done}`);

  const box = task.status === "done" ? "x" : " ";
  const head = `- [${box}] ${task.id} ${parts.join(" · ")}`;
  return task.note ? `${head}\n      ${task.note}` : head;
}

export interface TaskFile {
  tasks: Task[];
  /** Completed tasks ever, including those aged out of the file. */
  doneEver: number;
}

export function renderTasks(file: TaskFile): string {
  const lines = [
    "# タスク",
    "",
    "<!--",
    "  okf のタスクツールが読み書きします。手で編集しても構いません。",
    "  状態は見出しで決まります（チェックボックスではありません）。",
    "  ID は書き換えないでください。",
    "-->",
    "",
  ];

  const kept = file.tasks.filter((t) => t.status === "done").slice(0, KEPT_DONE_TASKS);
  const dropped = Math.max(0, file.doneEver - kept.length);

  for (const [heading, status] of SECTION_STATUS) {
    const inSection = status === "done" ? kept : file.tasks.filter((t) => t.status === status);

    lines.push(
      status === "done" && file.doneEver > 0
        ? `${heading}（直近 ${kept.length} 件 / 全 ${file.doneEver} 件）`
        : heading,
      ""
    );

    if (inSection.length === 0) {
      lines.push(status === "done" ? "まだありません。" : "なし。", "");
      continue;
    }

    for (const task of inSection) lines.push(renderTask(task));
    lines.push("");
  }

  if (dropped > 0) {
    lines.push(`<!-- 古い完了 ${dropped} 件は件数のみ保持しています。 -->`, "");
  }

  return lines.join("\n");
}

/**
 * Read a task file back.
 *
 * Tolerant on purpose: this file is meant to be edited by hand, so anything
 * that is not a recognisable task line is skipped rather than treated as an
 * error. Losing a user's prose to a strict parser would be far worse than
 * ignoring a line.
 */
export function parseTasks(raw: string): TaskFile {
  const tasks: Task[] = [];
  let status: TaskStatus | null = null;
  let doneEver = 0;
  let sawDoneHeading = false;

  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const heading = SECTION_STATUS.find(([h]) => line.startsWith(h));
    if (heading) {
      status = heading[1];
      if (heading[1] === "done") {
        sawDoneHeading = true;
        // `## 完了（直近 3 件 / 全 41 件）`
        const total = /全\s*(\d+)\s*件/.exec(line);
        if (total) doneEver = Number(total[1]);
      }
      continue;
    }
    // Any other heading ends the current section, so stray prose below a
    // user-added section is never read as tasks.
    if (/^##\s/.test(line)) {
      status = null;
      continue;
    }

    const match = TASK_LINE_RE.exec(line);
    if (!match || !status) continue;

    const [, , id, rest] = match;
    const fields = (rest ?? "").split("·").map((f) => f.trim());
    // The heading wins over the checkbox: a `[x]` under 未着手 is a typo, and
    // trusting it would move a task nobody finished into the done pile.
    const task: Task = { id: id ?? "", title: fields[0] ?? "", status };

    for (const field of fields.slice(1)) {
      const para = parseParaClass(field);
      if (para) {
        task.para = para;
        continue;
      }
      const due = /^期限\s*(\S+)/.exec(field);
      if (due?.[1]) {
        task.due = due[1];
        continue;
      }
      const done = /^完了\s*(\S+)/.exec(field);
      if (done?.[1]) task.done = done[1];
    }

    // A note is the indented line directly beneath the task.
    const next = lines[i + 1] ?? "";
    if (/^\s{4,}\S/.test(next) && !TASK_LINE_RE.test(next)) {
      task.note = next.trim();
      i++;
    }

    tasks.push(task);
  }

  const doneCount = tasks.filter((t) => t.status === "done").length;
  return {
    tasks,
    // Without the heading there is nothing to trust but what is in the file.
    doneEver: sawDoneHeading ? Math.max(doneEver, doneCount) : doneCount,
  };
}

/** Open work, in the order it should be looked at. */
export function openTasks(file: TaskFile): Task[] {
  const rank: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2 };
  return file.tasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => rank[a.status] - rank[b.status]);
}

// ---------------------------------------------------------------------------
// MAP
// ---------------------------------------------------------------------------

export interface MapEntry {
  /** What the reader is trying to find out. */
  question: string;
  /** Bundle-relative location. */
  where: string;
  /** The cheapest tool that answers it. */
  tool: string;
  /** Who may write there. */
  writable: string;
}

/**
 * The routing table, as data.
 *
 * This is the single source of truth for MAP.md's generated half, so the file
 * cannot describe a layout the code does not implement.
 */
export const MAP_ENTRIES: readonly MapEntry[] = [
  {
    question: "利用者のこと（呼び方・進め方・制約）",
    where: HUMAN_FILE,
    tool: "read_human",
    writable: "人間 / エージェント",
  },
  {
    question: "いま何をやるか",
    where: TASK_FILE,
    tool: "list_tasks",
    writable: "人間 / エージェント",
  },
  {
    question: "今日のこと（書き留め・その日のタスク）",
    where: "wiki/daily/YYYY-MM-DD.md",
    tool: "daily_note",
    writable: "人間 / エージェント",
  },
  {
    question: "このバンドルの規約",
    where: "wiki/AGENTS.md",
    tool: "read_agents_md",
    writable: "人間",
  },
  {
    question: "手順（やり方が決まっている作業）",
    where: "wiki/skills/",
    tool: "skill_find",
    writable: "人間 / エージェント",
  },
  {
    question: "繰り返す作業の設計",
    where: "wiki/loops/",
    tool: "loop_list",
    writable: "人間 / エージェント",
  },
  {
    question: "知識（事実・調べたこと）",
    where: "wiki/1-projects … 4-archive",
    tool: "retrieve / search",
    writable: "人間 / エージェント",
  },
  {
    question: "取り込んだ生データ",
    where: "raw/",
    tool: "list_files",
    writable: "人間のみ",
  },
  {
    question: "検索索引",
    where: ".rag/",
    tool: "(自動生成)",
    writable: "—",
  },
];

/** Everything below this line survives regeneration. */
export const MAP_USER_MARKER = "<!-- okf:user-rules -->";

const MAP_USER_DEFAULT = [
  MAP_USER_MARKER,
  "",
  "## このバンドル固有のルール",
  "",
  "ここから下は自動生成されません。独自の置き場所の決まりがあれば書いてください。",
  "",
].join("\n");

/**
 * Render MAP.md, keeping whatever the user wrote below the marker.
 *
 * Regenerating must never cost someone their own notes, so the generated half
 * stops at the marker and the rest is carried through untouched.
 */
export function renderMap(previous?: string): string {
  const lines = [
    "# MAP — どこに何があるか",
    "",
    "**最初にこれを読んでください。** 目的の情報がある 1 ファイルだけを開けば済み、",
    "探すために読み回る必要がなくなります。",
    "",
    "| 知りたいこと | 場所 | 呼ぶもの | 書ける人 |",
    "|---|---|---|---|",
  ];

  for (const entry of MAP_ENTRIES) {
    lines.push(`| ${entry.question} | \`${entry.where}\` | \`${entry.tool}\` | ${entry.writable} |`);
  }

  lines.push(
    "",
    // One line, not the rule itself. MAP is read on every session and its
    // whole value is being cheap; the reasoning lives in AGENTS.md, which is
    // read only when MAP points at it.
    "## 規則",
    "",
    "- デイリーノートの `## タスク` に未チェック項目があれば `collect_daily_tasks`",
    "  を呼び、`Task.md` へ移す（詳細は `wiki/AGENTS.md` §3）",
    "",
    "## 層の決まり",
    "",
    "- `raw/` は生データ。**エージェントは書けません**（人間は置けます）",
    "- `wiki/` が正典。エージェントも人間も書けます",
    "- `.rag/` は導出物。手で触らないでください",
    "",
    "## 優先順位（PARA）",
    ""
  );

  for (const [para, description] of Object.entries(PARA_DESCRIPTIONS)) {
    lines.push(`- **${para}** — ${description}`);
  }

  lines.push("", "---", "");

  const marker = previous?.indexOf(MAP_USER_MARKER) ?? -1;
  lines.push(marker >= 0 ? previous!.slice(marker).trimEnd() : MAP_USER_DEFAULT.trimEnd());

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// human.md
// ---------------------------------------------------------------------------

/**
 * The starting point for `human.md`.
 *
 * Written as prompts rather than empty headings: a blank section invites
 * nothing, and an unfilled file is worth less than no file at all because an
 * agent still pays to read it.
 */
export function renderHumanTemplate(): string {
  return [
    "# 利用者について",
    "",
    "<!--",
    "  エージェントが最初に読む情報です。短く保ってください。",
    "  ここに書いたことは毎回読まれます — 長いほど毎回のコストになります。",
    "-->",
    "",
    "## 基本",
    "",
    "- 呼び方:",
    "- 役割・専門:",
    "- 使う言語: 日本語",
    "- タイムゾーン:",
    "",
    "## 進め方の好み",
    "",
    "- 例: 結論から先に。前置きは不要",
    "- 例: 不明点は推測せず確認する",
    "",
    "## 制約・やらないこと",
    "",
    "- 例: このマシンから外部に送信しない",
    "",
    "## いまの文脈",
    "",
    "- 取り組んでいること:",
    "- 期限があるもの:",
    "",
  ].join("\n");
}
