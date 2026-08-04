/**
 * The application core: one open bundle, its search index, and its watcher.
 *
 * Both front ends — the served interface and the MCP server — drive this same
 * object. That is what makes human and agent edits symmetric: there is exactly
 * one write path, one layer check and one index update, so the two callers
 * cannot drift.
 */

import { join } from "path";
import type {
  BundleInfo,
  ChunkHit,
  ConformanceIssue,
  FileNode,
  ReadFileResult,
  RetrievalResult,
  SearchHit,
  TagCount,
  WriteFileResult,
} from "../shared/types";
import { messages } from "../shared/messages";
import { reclassify, type ParaClass } from "../shared/okf/para";
import {
  dailyId,
  dailyRelPath,
  dailyTemplate,
  dailyTitle,
  markTransferred,
  pendingTaskLines,
} from "../shared/okf/daily";
import {
  nextTaskId,
  openTasks,
  renderHumanTemplate,
  type Task,
  type TaskStatus,
} from "../shared/okf/workspace-files";
import { isConceptPath } from "../shared/okf";
import { Bundle } from "./okf/bundle";
import { skeletonConcept } from "./okf/parser";
import { LOOPS_DIR, RAG_DIR, SKILLS_DIR } from "./okf/paths";
import { SkillSpace } from "./okf/skills";
import { LoopSpace } from "./okf/loops";
import { scaffoldBundle, type ScaffoldResult } from "./okf/scaffold";
import { FtsIndex, type SearchOptions } from "./rag/fts";
import { retrieve, type RetrieveOptions } from "./rag/retrieve";
import { BundleWatcher } from "./watch";

/**
 * How long a self-inflicted write suppresses watcher events for that path.
 * Long enough to outlast the OS event, short enough that a genuine external
 * edit moments later is still seen.
 */
const SELF_WRITE_GRACE_MS = 750;

export interface WorkspaceOptions {
  /** Enable filesystem watching. Off for one-shot CLI use. */
  watch?: boolean;
  onExternalChange?: (paths: string[], info: BundleInfo) => void;
  onError?: (error: unknown) => void;
}

export class Workspace {
  private bundle: Bundle | null = null;
  private fts: FtsIndex | null = null;
  private skillSpace: SkillSpace | null = null;
  private loopSpace: LoopSpace | null = null;
  private watcher: BundleWatcher | null = null;
  private selfWrites = new Map<string, number>();

  constructor(private readonly options: WorkspaceOptions = {}) {}

  get isOpen(): boolean {
    return this.bundle !== null;
  }

  /** The open bundle, or a clear error naming the fix. */
  requireBundle(): Bundle {
    if (!this.bundle) throw new Error(messages.noBundleOpen);
    return this.bundle;
  }

  /**
   * The index is created and destroyed with the bundle, so "no index" always
   * means "no bundle" — reporting it as anything else sends the caller looking
   * for a problem that does not exist.
   */
  private requireFts(): FtsIndex {
    this.requireBundle();
    if (!this.fts) throw new Error(messages.noBundleOpen);
    return this.fts;
  }

  async open(path: string): Promise<BundleInfo> {
    await this.close();

    const bundle = await Bundle.open(path);
    await bundle.ensureReservedFiles();

    const fts = new FtsIndex(join(bundle.root, RAG_DIR, "fts.sqlite"));
    await fts.open();
    fts.sync(bundle.allConcepts());

    this.bundle = bundle;
    this.fts = fts;
    this.skillSpace = new SkillSpace(bundle.paths);
    this.loopSpace = new LoopSpace(bundle.paths, () => this.healthSnapshot());
    // Pick up a loop left open by a previous session, so the one-open-loop
    // rule survives a restart rather than being reset by it.
    await this.loopSpace.resume().catch(() => null);

    if (this.options.watch !== false) this.startWatching();

    return bundle.info();
  }

  async close(): Promise<void> {
    this.watcher?.stop();
    this.watcher = null;
    this.fts?.close();
    this.fts = null;
    this.skillSpace = null;
    this.loopSpace = null;
    this.bundle = null;
    this.selfWrites.clear();
  }

  private startWatching(): void {
    const bundle = this.requireBundle();
    this.watcher = new BundleWatcher(bundle.root, {
      onChange: (paths) => void this.handleExternalChange(paths),
      ...(this.options.onError ? { onError: this.options.onError } : {}),
    });
    this.watcher.start();
  }

  private markSelfWrite(relPath: string): void {
    this.selfWrites.set(relPath, Date.now());
    this.watcher?.ignoreNext(relPath);
  }

  private isSelfWrite(relPath: string): boolean {
    const at = this.selfWrites.get(relPath);
    if (at === undefined) return false;
    if (Date.now() - at > SELF_WRITE_GRACE_MS) {
      this.selfWrites.delete(relPath);
      return false;
    }
    return true;
  }

  /** Reconcile the read model and the index with what changed on disk. */
  private async handleExternalChange(paths: string[]): Promise<void> {
    const bundle = this.bundle;
    if (!bundle) return;

    const external = paths.filter((path) => !this.isSelfWrite(path));
    if (external.length === 0) return;

    for (const path of external) {
      try {
        const before = bundle.getConcept(idOf(bundle, path));
        const concept = await bundle.refresh(path);
        if (concept) this.fts?.upsert(concept);
        else if (before) this.fts?.remove(before.id);
      } catch (error) {
        this.options.onError?.(error);
      }
    }

    // A skill edited on disk must be visible to the next request; the
    // catalogue is small, so dropping all of it is cheaper than tracking which
    // entry each path belonged to.
    if (external.some((path) => path.startsWith(`${SKILLS_DIR}/`))) {
      this.skillSpace?.invalidate();
    }

    this.options.onExternalChange?.(external, await bundle.info());
  }

  /**
   * Bring a file up from `raw/` into the wiki layer.
   *
   * Human-only by contract, so there is no `by` parameter: the MCP surface
   * does not expose this at all.
   */
  async promote(
    from: string,
    to: string,
    opts: { actor?: string; keepSource?: boolean } = {}
  ): Promise<{ promoted: string; source: string; kept: boolean }> {
    const bundle = this.requireBundle();
    this.markSelfWrite(to);

    const result = await bundle.promoteFromRaw(from, to, opts);
    this.fts?.sync(bundle.allConcepts());
    await this.journal("promote", `${result.source} → ${result.promoted}`);
    return result;
  }

  /**
   * Refile a concept under a different PARA class.
   *
   * A move, not a metadata edit: the class *is* the folder, so archiving is
   * something a person can see in the tree and undo by dragging back. Links
   * are rewritten by `move`, so refiling never breaks the graph.
   */
  async setPara(
    path: string,
    to: ParaClass,
    by: "human" | "agent" = "human"
  ): Promise<{ from: string; to: string; para: ParaClass; moved: boolean }> {
    const bundle = this.requireBundle();
    const wikiRel = bundle.paths.toWikiRel(bundle.paths.resolve(path));
    const nextWikiRel = reclassify(wikiRel, to);

    if (nextWikiRel === wikiRel) {
      return { from: path, to: path, para: to, moved: false };
    }

    const nextPath = bundle.paths.wikiDir ? `${bundle.paths.wikiDir}/${nextWikiRel}` : nextWikiRel;
    const result = await this.move(path, nextPath, `${by}:local`, by);
    return { from: path, to: result.moved, para: to, moved: true };
  }

  /** LoopSpace for the open bundle. */
  requireLoops(): LoopSpace {
    this.requireBundle();
    if (!this.loopSpace) throw new Error(messages.noBundleOpen);
    return this.loopSpace;
  }

  /**
   * The counts a loop compares before and after.
   *
   * Deliberately three numbers rather than a full inventory: a preflight has to
   * be cheap enough that taking one is never the reason not to open a loop.
   */
  private async healthSnapshot(): Promise<{
    concepts: number;
    nonConformant: number;
    unresolvedLinks: number;
  }> {
    const bundle = this.requireBundle();
    return {
      concepts: bundle.allConcepts().length,
      nonConformant: bundle.conformanceIssues().length,
      unresolvedLinks: bundle.unresolvedLinks().length,
    };
  }

  /**
   * Journal a change into the open loop, if there is one.
   *
   * Writes inside `loops/` are skipped: journalling the journal would recurse,
   * and the loop file's own history is not part of what the loop did.
   */
  private async journal(action: string, path: string): Promise<void> {
    if (!this.loopSpace?.runningLoop) return;
    if (path.replace(/\\/g, "/").startsWith(`${LOOPS_DIR}/`)) return;
    // Awaited rather than fired and forgotten: a caller that writes and then
    // reads the loop back must see its own entry.
    await this.loopSpace.note(action, path).catch(() => {});
  }

  /** SkillSpace for the open bundle. */
  requireSkills(): SkillSpace {
    this.requireBundle();
    if (!this.skillSpace) throw new Error(messages.noBundleOpen);
    return this.skillSpace;
  }

  /** Re-read the bundle from disk, e.g. after a source was captured. */
  async reloadBundle(): Promise<void> {
    const bundle = this.requireBundle();
    await bundle.reload();
    this.fts?.sync(bundle.allConcepts());
  }

  async info(): Promise<BundleInfo | null> {
    return this.bundle ? this.bundle.info() : null;
  }

  async scaffold(path: string): Promise<ScaffoldResult> {
    return scaffoldBundle(path);
  }

  async listDir(path = "", recursive = false): Promise<FileNode[]> {
    return this.requireBundle().listDir(path, recursive);
  }

  async readFile(path: string): Promise<ReadFileResult> {
    return this.requireBundle().readFile(path);
  }

  async writeFile(
    path: string,
    content: string,
    opts: { actor?: string; log?: boolean; action?: string; note?: string; by?: "human" | "agent" } = {}
  ): Promise<WriteFileResult> {
    const bundle = this.requireBundle();
    this.markSelfWrite(path);

    const result = await bundle.writeFile(path, content, opts);
    if (result.concept) this.fts?.upsert(result.concept);

    // The log row is our own write too; do not bounce it back to the UI.
    if (opts.log !== false) {
      this.markSelfWrite(bundle.paths.toRel(bundle.paths.logMdPath));
    }

    await this.journal(opts.action === "create" ? "create" : "write", path);

    const { concept: _concept, ...rest } = result;
    return rest;
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    return this.requireFts().search(query, options);
  }

  searchChunks(query: string, options: SearchOptions = {}): ChunkHit[] {
    return this.requireFts().searchChunks(query, options);
  }

  /** Assemble budgeted, cited context for an agent. */
  retrieve(query: string, options: RetrieveOptions = {}): RetrievalResult {
    return retrieve(this.requireFts(), query, options);
  }

  tags(): TagCount[] {
    return this.requireFts().tags();
  }

  types(): TagCount[] {
    return this.requireFts().types();
  }

  /** Every concept id and title, for the quick switcher. */
  listConcepts(): Array<{ id: string; path: string; title: string; type: string }> {
    return this.requireBundle()
      .allConcepts()
      .map((doc) => ({
        id: doc.id,
        path: doc.relPath,
        title:
          typeof doc.frontmatter.title === "string" && doc.frontmatter.title.trim()
            ? doc.frontmatter.title
            : doc.id,
        type: doc.frontmatter.type,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  unresolvedLinks(): Array<{ from: string; target: string }> {
    return this.requireBundle().unresolvedLinks();
  }

  async createDirectory(path: string, by: "human" | "agent" = "human"): Promise<void> {
    await this.requireBundle().createDirectory(path, by);
  }

  /**
   * Move or rename, rewriting inbound links.
   *
   * The whole affected set is reindexed rather than just the moved file,
   * because rewriting a link changes the body of every referring document.
   */
  async move(
    from: string,
    to: string,
    actor = "human:local",
    by: "human" | "agent" = "human"
  ): Promise<{ moved: string; updated: string[]; linkCount: number }> {
    const bundle = this.requireBundle();
    this.markSelfWrite(from);
    this.markSelfWrite(to);

    const result = await bundle.movePath(from, to, { actor, by });
    for (const path of result.updated) this.markSelfWrite(path);
    await this.journal("move", `${from} → ${to}`);

    this.requireFts().rebuild(bundle.allConcepts());
    return result;
  }

  async delete(
    path: string,
    actor = "human:local",
    by: "human" | "agent" = "human"
  ): Promise<{ deleted: string; brokenLinksFrom: string[] }> {
    const bundle = this.requireBundle();
    this.markSelfWrite(path);

    const result = await bundle.deletePath(path, { actor, by });
    this.requireFts().rebuild(bundle.allConcepts());
    await this.journal("delete", path);
    return result;
  }

  resolveLink(from: string, target: string): string | null {
    return this.requireBundle().resolveLink(from, target);
  }

  async rebuildIndex(): Promise<{ rows: number }> {
    const bundle = this.requireBundle();
    this.markSelfWrite(bundle.paths.toRel(bundle.paths.indexMdPath));
    return { rows: await bundle.rebuildIndexMd() };
  }

  async rebuildRag(): Promise<{ indexed: number }> {
    const bundle = this.requireBundle();
    await bundle.reload();
    return { indexed: this.requireFts().rebuild(bundle.allConcepts()) };
  }

  conformanceIssues(): ConformanceIssue[] {
    return this.requireBundle().conformanceIssues();
  }

  /** Index statistics, for status display and diagnostics. */
  indexStats(): { documents: number; chunks: number } {
    const fts = this.requireFts();
    return { documents: fts.documentCount, chunks: fts.chunkCount };
  }

  async readAgentsMd(): Promise<string | null> {
    return this.requireBundle().readAgentsMd();
  }

  // ---- orientation files -------------------------------------------------

  async readMap(): Promise<string> {
    return this.requireBundle().readMap();
  }

  async readHuman(): Promise<string | null> {
    return this.requireBundle().readHuman();
  }

  /** Create `human.md` from the template, or return what is already there. */
  async ensureHuman(): Promise<string> {
    const bundle = this.requireBundle();
    const existing = await bundle.readHuman();
    if (existing !== null) return existing;

    const template = renderHumanTemplate();
    await bundle.writeHuman(template);
    return template;
  }

  async writeHuman(content: string): Promise<void> {
    await this.requireBundle().writeHuman(content);
  }

  // ---- daily notes --------------------------------------------------------

  /**
   * Today's note, created from the template if it does not exist yet.
   *
   * Returns the bundle-relative path either way, so a caller can open it
   * without caring which happened — the whole point is that it takes one
   * action, not "check, then decide, then create".
   */
  async openDaily(date = new Date()): Promise<{ path: string; created: boolean }> {
    const bundle = this.requireBundle();
    const wikiRel = dailyRelPath(date);
    const relPath = bundle.paths.wikiDir ? `${bundle.paths.wikiDir}/${wikiRel}` : wikiRel;

    const existing = await bundle.readFile(relPath).catch(() => null);
    if (existing) return { path: relPath, created: false };

    await bundle.writeFile(
      relPath,
      skeletonConcept({
        type: "Daily",
        title: dailyTitle(date),
        body: dailyTemplate(),
        generatedBy: "human:local",
        now: date,
      }),
      { actor: "human:local", action: "create" }
    );

    return { path: relPath, created: true };
  }

  /**
   * Move unchecked task lines out of a daily note and into `Task.md`.
   *
   * The rule this implements: a requirement written into a day's notes is
   * invisible tomorrow, because `Task.md` is the list that gets read and a
   * line in a daily note is not.
   *
   * Idempotent by construction — each transferred line is checked off and
   * stamped with the id it became, and checked lines are never picked up
   * again, so running this twice on the same day adds nothing the second time.
   */
  async collectDailyTasks(date = new Date()): Promise<Task[]> {
    const bundle = this.requireBundle();
    const wikiRel = dailyRelPath(date);
    const relPath = bundle.paths.wikiDir ? `${bundle.paths.wikiDir}/${wikiRel}` : wikiRel;

    const file = await bundle.readFile(relPath).catch(() => null);
    if (!file || file.binary) return [];

    const pending = pendingTaskLines(file.content);
    if (pending.length === 0) return [];

    const created: Task[] = [];
    let body = file.content;

    for (const item of pending) {
      const task = await this.addTask({
        title: item.text,
        // Where it came from, so the task is traceable back to the day.
        note: `${dailyId(date)} のノートから`,
      });
      created.push(task);
      body = markTransferred(body, item.line, task.id);
    }

    await bundle.writeFile(relPath, body, { actor: "agent", action: "update" });
    return created;
  }

  async listTasks(status?: TaskStatus): Promise<Task[]> {
    const file = await this.requireBundle().readTaskFile();
    // The default is open work only. Finished tasks are the bulk of the file
    // and are almost never what the caller wanted.
    if (!status) return openTasks(file);
    return file.tasks.filter((task) => task.status === status);
  }

  async addTask(input: {
    title: string;
    status?: TaskStatus;
    para?: ParaClass;
    due?: string;
    note?: string;
  }): Promise<Task> {
    const bundle = this.requireBundle();
    const file = await bundle.readTaskFile();

    const task: Task = {
      id: nextTaskId(file.tasks),
      title: input.title.trim(),
      status: input.status ?? "todo",
      ...(input.para ? { para: input.para } : {}),
      ...(input.due ? { due: input.due } : {}),
      ...(input.note ? { note: input.note } : {}),
    };

    file.tasks.unshift(task);
    await bundle.writeTaskFile(file);
    return task;
  }

  /**
   * Change a task's state or fields.
   *
   * Completing one stamps the date and bumps the all-time count, so the
   * heading stays honest even after old entries age out of the file.
   */
  async updateTask(
    id: string,
    changes: { status?: TaskStatus; title?: string; para?: ParaClass; due?: string; note?: string }
  ): Promise<Task | null> {
    const bundle = this.requireBundle();
    const file = await bundle.readTaskFile();

    const task = file.tasks.find((t) => t.id === id);
    if (!task) return null;

    const wasDone = task.status === "done";

    if (changes.title !== undefined) task.title = changes.title.trim();
    if (changes.para !== undefined) task.para = changes.para;
    if (changes.due !== undefined) task.due = changes.due;
    if (changes.note !== undefined) task.note = changes.note;

    if (changes.status !== undefined && changes.status !== task.status) {
      task.status = changes.status;
      if (changes.status === "done") {
        task.done = new Date().toISOString().slice(0, 10);
        file.doneEver += 1;
      } else if (wasDone) {
        delete task.done;
        file.doneEver = Math.max(0, file.doneEver - 1);
      }
    }

    // Newest completions first, so the kept window holds the recent ones.
    file.tasks.sort((a, b) => (b.done ?? "").localeCompare(a.done ?? ""));

    await bundle.writeTaskFile(file);
    return task;
  }
}

/** Concept id for a bundle-relative path, or `""` for non-concept files. */
function idOf(bundle: Bundle, relPath: string): string {
  if (!isConceptPath(relPath)) return "";
  try {
    return bundle.paths
      .toWikiRel(bundle.paths.resolve(relPath))
      .replace(/\.md$/i, "");
  } catch {
    return "";
  }
}
