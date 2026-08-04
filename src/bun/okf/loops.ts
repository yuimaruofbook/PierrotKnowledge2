/**
 * LoopSpace: loop designs and their run history, one file per design.
 *
 * Four guarantees:
 *
 *   1. **One design, one file.** `define()` creates or updates exactly one
 *      file, and a run only ever writes into its own design's file.
 *   2. **One run at a time.** Starting a run while another is in progress is
 *      refused rather than queued — two runs interleaving into one history is
 *      the contamination this layer exists to prevent.
 *   3. **History is bounded.** Recent runs keep their journal, older ones
 *      collapse to a line, the rest become a count. A design run daily for a
 *      year is still a file a person can open.
 *   4. **A finished run is not rewritten.** Journal entries only ever append
 *      to the run currently in progress.
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from "fs/promises";
import { join } from "path";
import { messages } from "../../shared/messages";
import {
  isRegression,
  isValidLoopName,
  parseLoop,
  renderDiff,
  renderLoop,
  slugifyLoopName,
  SUMMARY_RUNS,
  type LoopDesign,
  type LoopRun,
  type LoopSnapshot,
} from "../../shared/okf/loop";
import { LOOPS_DIR, toPosix, type BundlePaths } from "./paths";

export interface LoopStartResult {
  name: string;
  path: string;
  goal: string;
  skill?: string;
  checks: string[];
  before: LoopSnapshot;
  /** How this design has gone before, so a run can learn from the last one. */
  lastRun?: { started: string; status: string; outcome?: string };
  runNumber: number;
  /** Skills that fit this design, when it does not name one. */
  suggested: Array<{ name: string; description: string; score: number }>;
}

export interface LoopEndResult {
  name: string;
  path: string;
  before: LoopSnapshot;
  after: LoopSnapshot;
  diff: string[];
  runNumber: number;
  regressed: boolean;
  /** Completion checks the design declared, for the agent to confirm. */
  checks: string[];
}

export type SnapshotFn = () => Promise<LoopSnapshot>;

export class LoopSpace {
  /** Design whose run is in progress, if any. */
  private running: string | null = null;
  /** Serialises appends; see `note()`. */
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: BundlePaths,
    private readonly snapshot: SnapshotFn
  ) {}

  get runningLoop(): string | null {
    return this.running;
  }

  relPathOf(name: string): string {
    return `${LOOPS_DIR}/${name}.md`;
  }

  private absPathOf(name: string): string {
    return join(this.paths.loopsRoot, `${name}.md`);
  }

  /** Names reach here from agents, so they are validated, not trusted. */
  private requireName(name: string): string {
    const clean = toPosix(name.trim()).replace(/\.md$/i, "");
    if (!isValidLoopName(clean)) throw new Error(messages.loopBadName(name));
    return clean;
  }

  async list(): Promise<string[]> {
    const entries = await readdir(this.paths.loopsRoot).catch(() => []);
    return entries
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.slice(0, -3))
      // A README lives here too; only files that could be designs are listed.
      .filter((name) => isValidLoopName(name))
      .sort();
  }

  async read(name: string): Promise<LoopDesign> {
    const clean = this.requireName(name);
    const abs = this.absPathOf(clean);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new Error(messages.loopUnknown(clean));
    return parseLoop(await readFile(abs, "utf8"), clean);
  }

  async exists(name: string): Promise<boolean> {
    return !!(await stat(this.absPathOf(this.requireName(name))).catch(() => null));
  }

  /**
   * Restore the in-progress run after a restart.
   *
   * Without it, a restart would silently allow a second run to begin beside an
   * unfinished one — exactly what guarantee 2 exists to stop.
   */
  async resume(): Promise<string | null> {
    for (const name of await this.list()) {
      const design = await this.read(name).catch(() => null);
      if (design?.history[0]?.status === "running") {
        this.running = name;
        return name;
      }
    }
    this.running = null;
    return null;
  }

  /**
   * Create or update a loop design.
   *
   * Updating never touches the run history: the design is the plan, the history
   * is what happened, and editing the plan must not rewrite the past.
   */
  async define(options: {
    name?: string;
    goal: string;
    skill?: string;
    checks?: string[];
    now?: Date;
  }): Promise<LoopDesign> {
    if (!options.goal.trim()) throw new Error(messages.loopNeedsGoal);

    const name = this.requireName(options.name?.trim() || slugifyLoopName(options.goal));
    const existing = await this.read(name).catch(() => null);

    const design: LoopDesign = {
      name,
      goal: options.goal.trim(),
      ...(options.skill ? { skill: options.skill } : existing?.skill ? { skill: existing.skill } : {}),
      checks: options.checks ?? existing?.checks ?? [],
      created: existing?.created || (options.now ?? new Date()).toISOString(),
      runs: existing?.runs ?? 0,
      history: existing?.history ?? [],
    };

    await this.persist(design);
    return design;
  }

  /** Begin a run of one design. */
  async start(options: {
    name: string;
    actor?: string;
    suggested?: Array<{ name: string; description: string; score: number }>;
    now?: Date;
  }): Promise<LoopStartResult> {
    if (this.running) throw new Error(messages.loopAlreadyRunning(this.running));

    const design = await this.read(options.name);
    // A file edited by hand could leave a run marked running; treat the design
    // as busy rather than starting a second one into the same history.
    if (design.history[0]?.status === "running") {
      this.running = design.name;
      throw new Error(messages.loopAlreadyRunning(design.name));
    }

    const before = await this.snapshot();
    const previous = design.history[0];

    const run: LoopRun = {
      started: (options.now ?? new Date()).toISOString(),
      status: "running",
      before,
      journal: [],
    };

    design.history = [run, ...design.history];
    design.runs += 1;
    await this.persist(design);
    this.running = design.name;

    return {
      name: design.name,
      path: this.relPathOf(design.name),
      goal: design.goal,
      ...(design.skill ? { skill: design.skill } : {}),
      checks: design.checks,
      before,
      ...(previous
        ? {
            lastRun: {
              started: previous.started,
              status: previous.status,
              ...(previous.outcome ? { outcome: previous.outcome } : {}),
            },
          }
        : {}),
      runNumber: design.runs,
      suggested: options.suggested ?? [],
    };
  }

  /**
   * Append to the running run's journal.
   *
   * Serialised, because appending is read-modify-write on one file: two entries
   * landing together — a move that rewrites several links, say — would
   * otherwise both read the same state and the second would erase the first.
   */
  async note(action: string, detail: string, now = new Date()): Promise<void> {
    if (!this.running) return;

    this.writes = this.writes.then(async () => {
      if (!this.running) return;

      const design = await this.read(this.running).catch(() => null);
      const run = design?.history[0];
      if (!design || !run || run.status !== "running") {
        this.running = null;
        return;
      }

      run.journal.push({ at: now.toISOString().slice(11, 19), action, detail });
      await this.persist(design);
    });

    return this.writes;
  }

  /** Wait for queued journal writes, so a read sees everything recorded. */
  async settle(): Promise<void> {
    await this.writes;
  }

  /** Close the running run, recording the postflight and the comparison. */
  async end(
    options: { outcome?: string; status?: "done" | "abandoned"; now?: Date } = {}
  ): Promise<LoopEndResult> {
    if (!this.running) throw new Error(messages.loopNoneRunning);

    await this.settle();

    const design = await this.read(this.running);
    const run = design.history[0];
    if (!run || run.status !== "running") {
      this.running = null;
      throw new Error(messages.loopNoneRunning);
    }

    const after = await this.snapshot();
    run.after = after;
    run.status = options.status ?? "done";
    run.ended = (options.now ?? new Date()).toISOString();
    if (options.outcome?.trim()) run.outcome = options.outcome.trim();

    await this.persist(design);
    this.running = null;

    return {
      name: design.name,
      path: this.relPathOf(design.name),
      before: run.before,
      after,
      diff: renderDiff(run.before, after),
      runNumber: design.runs,
      regressed: isRegression(run.before, after),
      checks: design.checks,
    };
  }

  /**
   * Write a design out, trimming history to the caps.
   *
   * Written to a temporary file and renamed, so an interrupted write cannot
   * leave a half-rendered design where the history used to be.
   */
  private async persist(design: LoopDesign): Promise<void> {
    design.history = design.history.slice(0, SUMMARY_RUNS);

    await mkdir(this.paths.loopsRoot, { recursive: true });
    const abs = this.absPathOf(design.name);
    const temp = `${abs}.tmp`;
    await writeFile(temp, renderLoop(design), "utf8");
    await rename(temp, abs);
  }
}
