/**
 * Loops: one file per loop *design*, holding that design's run history.
 *
 * A loop design is a repeatable unit of agent work — "ingest meeting notes",
 * "weekly lint" — written once and run many times. Each design owns exactly
 * one file, and every run of it appends to that file and no other.
 *
 * **One design, one file.** That is the rule that keeps the record readable.
 * Two designs never share a file, because then you could not tell which
 * preflight belonged to which kind of work; and a run never writes outside its
 * own design's file, because then the design's history would be incomplete.
 * A file per *run* would satisfy the same isolation but grow without bound —
 * hundreds of near-identical files for the same recurring task — so the unit
 * is the design, and history lives inside it.
 *
 * History is capped rather than unbounded: recent runs stay in full detail,
 * older ones collapse to a single line, and beyond that they are dropped with
 * only the total run count kept. A journal nobody can read is not a record.
 *
 * Pure and DOM-free; the Bun side does the filesystem work.
 */

import { splitFrontmatter } from "./frontmatter";

export type RunStatus = "running" | "done" | "abandoned";

/** Counts that describe the health of the bundle at a point in time. */
export interface LoopSnapshot {
  concepts: number;
  nonConformant: number;
  unresolvedLinks: number;
}

export interface RunJournalEntry {
  at: string;
  action: string;
  detail: string;
}

export interface LoopRun {
  started: string;
  ended?: string;
  status: RunStatus;
  before: LoopSnapshot;
  after?: LoopSnapshot;
  journal: RunJournalEntry[];
  outcome?: string;
  /**
   * Pre-rendered deltas, kept when a run has aged into the summary tier.
   *
   * A one-line summary cannot carry both snapshots, so once a run is collapsed
   * its `before`/`after` are gone. Without this the next rewrite of the file
   * would re-render it as "未完了" — the history would decay every time it was
   * touched, which is worse than dropping it outright.
   */
  summary?: { concepts: string; nonConformant: string };
}

export interface LoopDesign {
  /** Identifier and filename. */
  name: string;
  /** What this loop accomplishes, every time it runs. */
  goal: string;
  /** Skill to follow. */
  skill?: string;
  /** What must be true before the run is considered finished. */
  checks: string[];
  created: string;
  /** Total runs ever, including ones aged out of the history. */
  runs: number;
  /** Runs newest first, subject to the caps below. */
  history: LoopRun[];
}

/** Runs kept with their full journal. */
export const DETAILED_RUNS = 5;
/** Runs kept as a one-line summary after that. */
export const SUMMARY_RUNS = 25;

const SECTION_DESIGN = "## 設計";
const SECTION_HISTORY = "## 実行履歴";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidLoopName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Turn a goal into a usable loop name. */
export function slugifyLoopName(goal: string, max = 40): string {
  const ascii = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return ascii || "loop";
}

function snapshotInline(snapshot: LoopSnapshot): string {
  return `概念 ${snapshot.concepts} / 非準拠 ${snapshot.nonConformant} / 未解決 ${snapshot.unresolvedLinks}`;
}

function delta(before: number, after: number): string {
  const diff = after - before;
  return diff === 0 ? "±0" : `${diff > 0 ? "+" : ""}${diff}`;
}

/** The postflight comparison, which is why a preflight is taken at all. */
export function renderDiff(before: LoopSnapshot, after: LoopSnapshot): string[] {
  return [
    `- 概念: ${before.concepts} → ${after.concepts} (${delta(before.concepts, after.concepts)})`,
    `- OKF 非準拠: ${before.nonConformant} → ${after.nonConformant} (${delta(before.nonConformant, after.nonConformant)})`,
    `- 未解決リンク: ${before.unresolvedLinks} → ${after.unresolvedLinks} (${delta(before.unresolvedLinks, after.unresolvedLinks)})`,
  ];
}

/**
 * Whether a run left the bundle worse than it found it.
 *
 * Only non-conformance counts. More unresolved links is normal and usually
 * good — it means the work identified knowledge that is missing, which is the
 * whole point of linking to pages that do not exist yet.
 */
export function isRegression(before: LoopSnapshot, after: LoopSnapshot): boolean {
  return after.nonConformant > before.nonConformant;
}

function renderRunDetailed(run: LoopRun): string[] {
  const lines = [`### ${run.started} — ${run.status}`, ""];
  lines.push(`- 開始: ${snapshotInline(run.before)}`);

  if (run.after) {
    lines.push(
      `- 終了: ${snapshotInline(run.after)} ` +
        `(概念 ${delta(run.before.concepts, run.after.concepts)} · ` +
        `非準拠 ${delta(run.before.nonConformant, run.after.nonConformant)} · ` +
        `未解決 ${delta(run.before.unresolvedLinks, run.after.unresolvedLinks)})`
    );
  }

  if (run.journal.length > 0) {
    lines.push("- 経過:");
    for (const entry of run.journal) {
      lines.push(`  - \`${entry.at}\` **${entry.action}** ${entry.detail}`);
    }
  }

  lines.push(`- 結果: ${run.outcome?.trim() || "（未記入）"}`);
  if (run.after && isRegression(run.before, run.after)) {
    lines.push("- ⚠ OKF 非準拠が増えました");
  }
  lines.push("");
  return lines;
}

/**
 * Older runs: one line, enough to see the shape of the history.
 *
 * The deltas are emitted in a fixed order so the line can be read back and
 * re-emitted unchanged — a summarised run must survive every later rewrite of
 * the file, not decay a little each time.
 */
function renderRunSummary(run: LoopRun): string {
  const concepts =
    run.summary?.concepts ?? (run.after ? delta(run.before.concepts, run.after.concepts) : "?");
  const nonConformant =
    run.summary?.nonConformant ??
    (run.after ? delta(run.before.nonConformant, run.after.nonConformant) : "?");

  const outcome = run.outcome?.trim().split("\n")[0] ?? "";
  return (
    `- \`${run.started}\` ${run.status} · 概念 ${concepts} · 非準拠 ${nonConformant}` +
    (outcome ? ` · ${outcome}` : "")
  );
}

export function renderLoop(design: LoopDesign): string {
  const running = design.history.some((run) => run.status === "running");

  const lines = [
    "---",
    `loop: ${design.name}`,
    `goal: ${design.goal}`,
    ...(design.skill ? [`skill: ${design.skill}`] : []),
    `created: ${design.created}`,
    `runs: ${design.runs}`,
    `status: ${running ? "running" : "idle"}`,
    "---",
    "",
    `# ${design.goal}`,
    "",
    SECTION_DESIGN,
    "",
    `- ループ名: \`${design.name}\``,
    `- 使うスキル: ${design.skill ? `\`${design.skill}\`` : "（未指定）"}`,
    "- 完了条件:",
  ];

  if (design.checks.length === 0) {
    lines.push("  - （未設定）");
  } else {
    for (const check of design.checks) lines.push(`  - ${check}`);
  }

  lines.push("", SECTION_HISTORY, "");

  if (design.history.length === 0) {
    lines.push("（まだ実行されていません）", "");
  } else {
    const detailed = design.history.slice(0, DETAILED_RUNS);
    const summarised = design.history.slice(DETAILED_RUNS, SUMMARY_RUNS);

    for (const run of detailed) lines.push(...renderRunDetailed(run));

    if (summarised.length > 0) {
      lines.push("### 以前の実行", "");
      for (const run of summarised) lines.push(renderRunSummary(run));
      lines.push("");
    }

    const dropped = design.runs - Math.min(design.history.length, SUMMARY_RUNS);
    if (dropped > 0) {
      lines.push(`（さらに ${dropped} 回の実行は記録から省略されています）`, "");
    }
  }

  return lines.join("\n");
}

function parseSnapshotInline(text: string): LoopSnapshot | undefined {
  const match = /概念 (\d+) \/ 非準拠 (\d+) \/ 未解決 (\d+)/.exec(text);
  if (!match) return undefined;
  return {
    concepts: Number(match[1]),
    nonConformant: Number(match[2]),
    unresolvedLinks: Number(match[3]),
  };
}

function section(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start === -1) return "";
  const after = start + heading.length;
  const next = /^## /m.exec(body.slice(after));
  return body.slice(after, next ? after + next.index : body.length).trim();
}

/**
 * Read a loop file back.
 *
 * Tolerant by design: these are meant to be edited by hand — a person adding a
 * completion check, or correcting an outcome — so a file that no longer parses
 * perfectly must still yield a usable design.
 */
export function parseLoop(raw: string, fallbackName: string): LoopDesign {
  const { yaml, body } = splitFrontmatter(raw);
  const header: Record<string, string> = {};

  for (const line of (yaml ?? "").split(/\r?\n/)) {
    const match = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (match?.[1]) header[match[1]] = (match[2] ?? "").trim();
  }

  const designText = section(body, SECTION_DESIGN);
  const checks: string[] = [];
  let inChecks = false;
  for (const line of designText.split(/\r?\n/)) {
    if (/^-\s*完了条件:/.test(line.trim())) {
      inChecks = true;
      continue;
    }
    if (inChecks) {
      const item = /^\s{2,}-\s+(.*)$/.exec(line);
      if (item) {
        const value = (item[1] ?? "").trim();
        if (value && value !== "（未設定）") checks.push(value);
        continue;
      }
      if (line.trim()) inChecks = false;
    }
  }

  const history = parseHistory(section(body, SECTION_HISTORY));
  const parsedRuns = Number(header.runs);

  return {
    name: header.loop || fallbackName,
    goal: header.goal || "",
    ...(header.skill ? { skill: header.skill } : {}),
    checks,
    created: header.created || "",
    runs: Number.isFinite(parsedRuns) ? parsedRuns : history.length,
    history,
  };
}

function parseHistory(text: string): LoopRun[] {
  const runs: LoopRun[] = [];
  const lines = text.split(/\r?\n/);
  let current: LoopRun | null = null;

  const flush = () => {
    if (current) runs.push(current);
    current = null;
  };

  for (const line of lines) {
    const heading = /^###\s+(\S+)\s+—\s+(running|done|abandoned)\s*$/.exec(line.trim());
    if (heading) {
      flush();
      current = {
        started: heading[1] as string,
        status: heading[2] as RunStatus,
        before: { concepts: 0, nonConformant: 0, unresolvedLinks: 0 },
        journal: [],
      };
      continue;
    }

    // The collapsed tail. Fixed field order, so the deltas and the outcome can
    // be told apart even though both may contain the separator.
    const summary =
      /^-\s+`(\S+)`\s+(running|done|abandoned)\s+·\s+概念\s+(\S+)\s+·\s+非準拠\s+(\S+)(?:\s+·\s+(.*))?$/.exec(
        line.trim()
      );
    if (summary) {
      flush();
      runs.push({
        started: summary[1] as string,
        status: summary[2] as RunStatus,
        before: { concepts: 0, nonConformant: 0, unresolvedLinks: 0 },
        journal: [],
        summary: { concepts: summary[3] as string, nonConformant: summary[4] as string },
        ...(summary[5]?.trim() ? { outcome: summary[5].trim() } : {}),
      });
      continue;
    }

    if (!current) continue;

    if (line.trim().startsWith("- 開始:")) {
      current.before = parseSnapshotInline(line) ?? current.before;
    } else if (line.trim().startsWith("- 終了:")) {
      const after = parseSnapshotInline(line);
      if (after) current.after = after;
    } else if (line.trim().startsWith("- 結果:")) {
      const outcome = line.trim().slice("- 結果:".length).trim();
      if (outcome && outcome !== "（未記入）") current.outcome = outcome;
    } else {
      const entry = /^\s+-\s+`([^`]+)`\s+\*\*([^*]+)\*\*\s*(.*)$/.exec(line);
      if (entry) {
        current.journal.push({
          at: entry[1] as string,
          action: (entry[2] as string).trim(),
          detail: (entry[3] ?? "").trim(),
        });
      }
    }
  }

  flush();
  return runs;
}
