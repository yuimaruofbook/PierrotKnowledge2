/**
 * The application core: one open bundle, its search index, and its watcher.
 *
 * Both front ends — the served interface and the MCP server — drive this same
 * object. That is what makes human and agent edits symmetric: there is exactly
 * one write path, one layer check and one index update, so the two callers
 * cannot drift.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import type {
  BundleInfo,
  ChunkHit,
  ConceptDocument,
  ConformanceIssue,
  FileNode,
  LinkedFile,
  ReadFileResult,
  RetrievalResult,
  SearchFilters,
  SearchHit,
  TagCount,
  WriteFileResult,
} from "../shared/types";
import { messages } from "../shared/messages";
import { reclassify, withinParaDepth, type ParaClass } from "../shared/okf/para";
import { rankSkills, selectionConfidence } from "../shared/okf/skill-rank";
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
  type TaskFile,
  type TaskStatus,
} from "../shared/okf/workspace-files";
import {
  ACTIVITY_DIR,
  ACTIVITY_TITLE,
  ACTIVITY_TYPE,
  KNOWHOW_DIR,
  KNOWHOW_TITLE,
  KNOWHOW_TYPE,
  activityRelPath,
  conceptTitle,
  deriveDescription,
  filterActivity,
  isConceptPath,
  isoDate,
  knowhowSlug,
  lifecycleOf,
  parseLogEntries,
  resolveLinkTarget,
  splitFrontmatter,
  summarizeActivity,
  setLifecycleInDocument,
  withLifecycle,
  type Lifecycle,
  type LifecycleChoice,
  type ParsedLogEntry,
} from "../shared/okf";
import {
  BaseError,
  isBasePath,
  listViews,
  renderBaseMarkdown,
  runBase,
  validateBase,
  type BaseResult,
  type BaseViewResponse,
} from "../shared/okf/base";
import {
  CANVASES_DIR,
  GRAPH_SCHEMA_ID,
  GRAPH_SCHEMA_TYPE,
  buildGraphCanvas,
  canvasOutline,
  compareCodePoints,
  describeCanvasErrors,
  isCanvasPath,
  parseCanvas,
  parseGraphSchema,
  renderSystemMap,
  schemaWarnings,
  serializeCanvas,
  type GraphSchema,
  type SystemMapFacts,
} from "../shared/okf";
import { paraOf } from "../shared/okf/para";
import { Bundle, type MoveResult } from "./okf/bundle";
import { baseRowOf, listBasePaths, readBaseFile } from "./okf/bases";
import { canvasFileResolver, listCanvasPaths, readCanvasFile, resolveRootConcept } from "./okf/canvases";
import { parseBaseYaml } from "./okf/parser";
import { frontmatterRecord, skeletonConcept } from "./okf/parser";
import { LOOPS_DIR, RAG_DIR, SKILLS_DIR } from "./okf/paths";
import { SkillSpace } from "./okf/skills";
import { LoopSpace } from "./okf/loops";
import { scaffoldBundle, type ScaffoldResult } from "./okf/scaffold";
import { FtsIndex, type SearchOptions } from "./rag/fts";
import { DEFAULT_BUDGET_CHARS, retrieve, type RetrieveOptions } from "./rag/retrieve";
import {
  TIER_DEFAULTS,
  groupPassages,
  type ContextPack,
  type ContextPackKnowhow,
  type ContextTier,
} from "./rag/context-pack";
import { BundleWatcher } from "./watch";

/**
 * How long a self-inflicted write suppresses watcher events for that path.
 * Long enough to outlast the OS event, short enough that a genuine external
 * edit moments later is still seen.
 */
const SELF_WRITE_GRACE_MS = 750;

/** How many search hits a `canvas_from_links` query starts from. */
const QUERY_ROOTS = 5;

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

  /**
   * Suppress the watcher event for the `log.md` row an operation is about to
   * append. Every mutating operation writes one, so every one of them owes
   * this call — otherwise the app reports its own bookkeeping as an edit made
   * from outside.
   */
  private markLogWrite(): void {
    const bundle = this.requireBundle();
    this.markSelfWrite(bundle.paths.toRel(bundle.paths.logMdPath));
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
    this.markLogWrite();

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
    by: "human" | "agent" = "human",
    actor?: string
  ): Promise<{ from: string; to: string; para: ParaClass; moved: boolean; danglingRelations: MoveResult["danglingRelations"] }> {
    const bundle = this.requireBundle();
    const wikiRel = bundle.paths.toWikiRel(bundle.paths.resolve(path));
    const nextWikiRel = reclassify(wikiRel, to);

    if (nextWikiRel === wikiRel) {
      return { from: path, to: path, para: to, moved: false, danglingRelations: [] };
    }

    const nextPath = bundle.paths.wikiDir ? `${bundle.paths.wikiDir}/${nextWikiRel}` : nextWikiRel;
    // The default tag matches the caller's kind, so an agent refile is
    // findable with the same 'process:' audit filter as its other writes.
    const result = await this.move(
      path,
      nextPath,
      actor ?? (by === "agent" ? "process:mcp" : "human:local"),
      by
    );
    return { from: path, to: result.moved, para: to, moved: true, danglingRelations: result.danglingRelations };
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
    if (opts.log !== false) this.markLogWrite();

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

  /**
   * Assemble budgeted, cited context for an agent.
   *
   * `linkDepth` is applied here rather than in the index: following a link
   * needs the concept graph, which only the bundle has.
   */
  retrieve(query: string, options: RetrieveOptions = {}): RetrievalResult {
    const result = retrieve(this.requireFts(), query, options);

    const depth = options.linkDepth ?? 0;
    if (depth <= 0 || result.passages.length === 0) return result;

    const budget = Math.max(1, options.budgetChars ?? DEFAULT_BUDGET_CHARS);
    const reached = this.followLinks(
      [...new Set(result.passages.map((p) => p.id))],
      depth,
      budget - result.usedChars,
      options
    );
    return {
      ...result,
      linked: reached.linked,
      usedChars: result.usedChars + reached.usedChars,
      truncated: result.truncated || reached.truncated,
    };
  }

  /**
   * Walk outgoing links from some files, up to `depth` hops, collecting each
   * file once as a pointer: path, title and the one-line description.
   *
   * Pointers, not bodies, because the point is to show what else is nearby at
   * a cost the budget can bound; the cost of an entry is its title plus its
   * description, and the walk stops at the first one that no longer fits.
   * Filters apply to what is shown: a hidden file (DEAD, past the PARA depth,
   * outside `type` / `tags` / `path_prefix`) is not listed and not walked through, but is still marked seen so it is
   * judged once.
   */
  private followLinks(
    startIds: readonly string[],
    depth: number,
    budgetLeft: number,
    filters: SearchFilters
  ): { linked: LinkedFile[]; usedChars: number; truncated: boolean } {
    const bundle = this.requireBundle();
    // Resolved against the ids that exist now, not the `resolved` recorded
    // when each page was parsed: a link written before its target existed
    // stays unresolved there until the next reload.
    const ids = bundle.conceptIds();
    const seen = new Set(startIds);
    const linked: LinkedFile[] = [];
    let used = 0;
    let frontier = [...startIds];

    for (let hops = 1; hops <= depth; hops++) {
      const next: string[] = [];
      for (const id of frontier) {
        const from = bundle.getConcept(id);
        if (!from) continue;

        for (const link of from.links) {
          const resolved = resolveLinkTarget(link.target, from.id, ids);
          const target = resolved === null ? undefined : bundle.getConcept(resolved);
          if (!target || seen.has(target.id)) continue;
          seen.add(target.id);

          if (!filters.includeDead && lifecycleOf(tagsOf(target)) === "dead") continue;
          if (!matchesFilters(target, filters)) continue;
          if (filters.paraDepth !== undefined && !withinParaDepth(target.id, filters.paraDepth)) {
            continue;
          }

          const title = conceptTitle(target.id, target.frontmatter);
          const description = target.frontmatter.description;
          const text = typeof description === "string" && description.trim() ? description : undefined;
          const cost = title.length + (text?.length ?? 0);
          if (used + cost > budgetLeft) return { linked, usedChars: used, truncated: true };

          used += cost;
          linked.push({
            path: target.relPath,
            id: target.id,
            title,
            type: target.frontmatter.type,
            ...(text ? { description: text } : {}),
            hops,
            from: from.relPath,
          });
          next.push(target.id);
        }
      }
      frontier = next;
    }

    return { linked, usedChars: used, truncated: false };
  }

  /**
   * Assemble a context pack: the minimal file set for a task, plus the skills
   * that match it, sized to the model tier that will consume it.
   *
   * This is retrieval regrouped for starting work rather than answering a
   * question — see `context-pack.ts` for why the two are different jobs.
   */
  async contextPack(
    task: string,
    options: RetrieveOptions & { tier?: ContextTier } = {}
  ): Promise<ContextPack> {
    const defaults = options.tier
      ? TIER_DEFAULTS[options.tier]
      : { budgetChars: DEFAULT_BUDGET_CHARS, limit: 8 };
    const budgetChars = options.budgetChars ?? defaults.budgetChars;

    const retrieval = this.retrieve(task, {
      ...options,
      budgetChars,
      limit: options.limit ?? defaults.limit,
    });

    const bundle = this.requireBundle();
    const files = groupPassages(retrieval, (id) => {
      const description = bundle.getConcept(id)?.frontmatter.description;
      return typeof description === "string" && description.trim() ? description : undefined;
    });

    const found = await this.requireSkills().find(task, 3);

    // Know-how sits outside PARA, so it counts as a resource: a narrow
    // `paraDepth` that stops short of resources leaves it out with the rest.
    // It follows the caller's filters like any other file, and each entry is
    // paid for from the same budget as the passages (title + description, as a
    // linked pointer is), so the pack never outgrows `budgetChars`.
    const knowhow: ContextPackKnowhow[] = [];
    let usedChars = retrieval.usedChars;
    let truncated = retrieval.truncated;
    if (options.paraDepth === undefined || withinParaDepth(KNOWHOW_DIR, options.paraDepth)) {
      for (const r of this.knowhowFind(task, 3, options.includeDead === true, options).ranked) {
        const cost = r.title.length + r.description.length;
        if (usedChars + cost > budgetChars) {
          truncated = true;
          break;
        }
        usedChars += cost;
        knowhow.push({
          title: r.title,
          description: r.description,
          path: r.path,
          by: r.by,
          score: r.score,
        });
      }
    }

    return {
      task,
      ...(options.tier ? { tier: options.tier } : {}),
      budgetChars,
      files,
      skills: found.ranked.map((r) => ({
        name: r.name,
        description: r.description,
        score: r.score,
      })),
      knowhow,
      linked: retrieval.linked ?? [],
      usedChars,
      truncated,
    };
  }

  /**
   * Group log.md rows by actor: who — human or which model — changed what.
   *
   * The audit multiple-model setups need before trusting agent-written pages.
   * Rows the parser cannot read (hand-written prose, which §9 allows) are
   * simply absent, so this reports what the log records, not more.
   */
  async auditChanges(
    opts: { since?: string; actor?: string } = {}
  ): Promise<{
    total: number;
    since?: string;
    actors: Array<{ actor: string; count: number; entries: ParsedLogEntry[] }>;
  }> {
    const log = await this.requireBundle().readLog();

    let entries = parseLogEntries(log);
    if (opts.since) entries = entries.filter((entry) => entry.date >= opts.since!);
    if (opts.actor) entries = entries.filter((entry) => entry.actor.includes(opts.actor!));

    const byActor = new Map<string, ParsedLogEntry[]>();
    for (const entry of entries) {
      const list = byActor.get(entry.actor);
      if (list) list.push(entry);
      else byActor.set(entry.actor, [entry]);
    }

    const actors = [...byActor.entries()]
      .map(([actor, list]) => ({ actor, count: list.length, entries: list }))
      .sort((a, b) => b.count - a.count || a.actor.localeCompare(b.actor));

    return { total: entries.length, ...(opts.since ? { since: opts.since } : {}), actors };
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Mark a concept Product or DEAD, or clear the mark.
   *
   * An edit of the frontmatter `tags` through the normal write path, so the
   * layer rules, the log row and the reindex all apply. Nothing is moved or
   * deleted: DEAD only changes what search and packs show by default.
   */
  async setLifecycle(
    path: string,
    to: LifecycleChoice,
    actor = "process:mcp"
  ): Promise<{ path: string; lifecycle: LifecycleChoice; changed: boolean }> {
    const file = await this.requireBundle().readFile(path);
    if (file.binary || !file.concept) {
      throw new Error(`${path} is not a concept document, so it has no tags to change`);
    }

    const { yaml } = splitFrontmatter(file.content);
    // The frontmatter as written, never the defaulted one: rewriting a block
    // that could not be read would replace it with a guess.
    const record = frontmatterRecord(yaml);
    if (!record) {
      throw new Error(
        `${path} has no readable YAML frontmatter mapping; add one before setting a lifecycle`
      );
    }

    const current = record.tags ?? [];
    if (!Array.isArray(current)) throw new Error(`tags in ${path} is not a list`);

    const next = withLifecycle(current, to);
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return { path, lifecycle: to, changed: false };
    }

    // Only the `tags` lines change: a whole-block rewrite would drop the
    // author's comments and re-quote values like `version: 1.10`.
    const edited = setLifecycleInDocument(file.content, current, to);
    if (edited === null) {
      throw new Error(`tags in ${path} are written in a form that cannot be edited safely; change them by hand`);
    }

    await this.writeFile(path, edited, {
      by: "agent",
      actor,
      action: "write",
      note: `lifecycle: ${to}`,
    });
    return { path, lifecycle: to, changed: true };
  }

  // ---- know-how --------------------------------------------------------------

  /** Create a wiki sub-folder's index.md on first use, without a watcher echo. */
  private async ensureFolder(dir: string, title: string): Promise<void> {
    const created = await this.requireBundle().ensureFolderIndex(dir, title);
    if (created) this.markSelfWrite(created);
  }

  /** Bundle-relative path for a wiki-relative one. */
  private wikiPath(wikiRel: string): string {
    const { wikiDir } = this.requireBundle().paths;
    return wikiDir ? `${wikiDir}/${wikiRel}` : wikiRel;
  }

  /**
   * Record a lesson for the agents that come next.
   *
   * One file per lesson under `knowhow/`, named for its title; a repeated
   * title gets a numbered name rather than overwriting what another agent
   * wrote. `by` is stored beside `generated.by` so the lesson's source is a
   * first-class field a reader can filter on.
   */
  async knowhowAdd(input: {
    title: string;
    body: string;
    tags?: string[];
    actor: string;
  }): Promise<{ path: string }> {
    const bundle = this.requireBundle();
    await this.ensureFolder(KNOWHOW_DIR, KNOWHOW_TITLE);

    const slug = knowhowSlug(input.title);
    let path = this.wikiPath(`${KNOWHOW_DIR}/${slug}.md`);
    for (let n = 2; await bundle.exists(path); n++) {
      path = this.wikiPath(`${KNOWHOW_DIR}/${slug}-${n}.md`);
    }

    const description = deriveDescription(input.body);
    await this.writeFile(
      path,
      skeletonConcept({
        type: KNOWHOW_TYPE,
        title: input.title,
        ...(description ? { description } : {}),
        tags: input.tags ?? [],
        body: input.body,
        generatedBy: input.actor,
        extra: { by: input.actor },
      }),
      { by: "agent", actor: input.actor, action: "create" }
    );
    return { path };
  }

  /**
   * Rank recorded know-how against a task, as `skill_find` ranks skills.
   *
   * Cheap by design: titles, descriptions, scores and who recorded each, no
   * bodies. DEAD lessons are retired and not offered unless asked for. The
   * candidates are put in id order first so equal scores break the same way
   * on every run.
   */
  knowhowFind(
    task: string,
    limit = 3,
    includeDead = false,
    filters: SearchFilters = {}
  ): {
    ranked: Array<{
      title: string;
      path: string;
      description: string;
      by: string;
      score: number;
      matched: string[];
    }>;
    confidence: "high" | "medium" | "low";
  } {
    const prefix = `${KNOWHOW_DIR}/`;
    const candidates = this.requireBundle()
      .allConcepts()
      .filter((doc) => doc.id.startsWith(prefix))
      .filter((doc) => includeDead || lifecycleOf(tagsOf(doc)) !== "dead")
      .filter((doc) => matchesFilters(doc, filters))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc) => {
        const generated = doc.frontmatter.generated as { by?: unknown } | undefined;
        const by = doc.frontmatter.by;
        return {
          name: conceptTitle(doc.id, doc.frontmatter),
          description:
            typeof doc.frontmatter.description === "string" ? doc.frontmatter.description : "",
          tags: tagsOf(doc),
          path: doc.relPath,
          by: typeof by === "string" ? by : typeof generated?.by === "string" ? generated.by : "",
        };
      });

    const ranked = rankSkills(task, candidates, {
      limit: Math.max(1, Math.min(Math.trunc(limit), 20)),
    });
    return {
      ranked: ranked.map((r) => ({
        title: r.skill.name,
        path: r.skill.path,
        description: r.skill.description,
        by: r.skill.by,
        score: Math.round(r.score * 100) / 100,
        matched: r.matched,
      })),
      confidence: selectionConfidence(ranked),
    };
  }

  // ---- activity ----------------------------------------------------------------

  /**
   * Summarise log.md as a page whose every line cites a log row.
   *
   * With `save` it is also written as an `ActivitySummary` concept through the
   * normal write path, so it is searchable, logged and attributable like any
   * other page. Nothing is written when no row matched: an empty summary would
   * only be a file that claims nothing.
   */
  async summarizeActivity(
    opts: { since?: string; until?: string; actor?: string; by?: string; save?: boolean } = {}
  ): Promise<{ total: number; markdown: string; saved?: string }> {
    const bundle = this.requireBundle();
    const filter = {
      ...(opts.since ? { since: opts.since } : {}),
      ...(opts.until ? { until: opts.until } : {}),
      ...(opts.actor ? { actor: opts.actor } : {}),
    };

    const entries = filterActivity(parseLogEntries(await bundle.readLog()), filter);
    const summary = summarizeActivity(entries, {
      ...filter,
      source: bundle.paths.toRel(bundle.paths.logMdPath),
    });
    if (!summary) return { total: 0, markdown: "" };

    const markdown = `# ${summary.title}\n\n${summary.body}`;
    if (!opts.save) return { total: summary.total, markdown };

    // Whoever ran the tool is credited; the actor filter only narrows the rows.
    const actor = opts.by?.trim() || "process:okf";
    const path = this.wikiPath(activityRelPath(summary.from, summary.to, opts.actor));
    const existed = await bundle.exists(path);

    await this.ensureFolder(ACTIVITY_DIR, ACTIVITY_TITLE);
    await this.writeFile(
      path,
      skeletonConcept({
        type: ACTIVITY_TYPE,
        title: summary.title,
        description: summary.description,
        tags: ["activity"],
        body: summary.body,
        generatedBy: actor,
      }),
      { by: "agent", actor, action: existed ? "write" : "create" }
    );
    return { total: summary.total, markdown, saved: path };
  }

  // ---- bases -------------------------------------------------------------------

  /** Every `.base` file with the views it offers, or why it cannot be read. */
  async baseList(): Promise<Array<{ path: string; views: Array<{ name: string; type: string }>; error?: string }>> {
    const bundle = this.requireBundle();
    const out: Array<{ path: string; views: Array<{ name: string; type: string }>; error?: string }> = [];
    for (const path of await listBasePaths(bundle)) {
      const file = await readBaseFile(bundle, path).catch(() => null);
      if (!file) continue;
      if (!file.ok) {
        out.push({ path, views: [], error: file.error });
        continue;
      }
      const { errors } = validateBase(file.value);
      out.push({
        path,
        views: listViews(file.value),
        ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      });
    }
    return out;
  }

  /** One view of a base over the bundle's concepts. Reads the file afresh every time. */
  async baseQuery(path: string, view?: string, limit?: number): Promise<BaseResult & { markdown: string }> {
    const bundle = this.requireBundle();
    const file = await readBaseFile(bundle, path);
    if (!file.ok) throw new BaseError(file.error);
    const result = runBase(file.value, bundle.allConcepts().map(baseRowOf), {
      ...(view !== undefined ? { view } : {}),
      ...(limit !== undefined ? { limit } : {}),
      now: Date.now(),
    });
    return { ...result, markdown: renderBaseMarkdown(result) };
  }

  /**
   * What the interface shows for a `.base` file: its views, and one of them run.
   *
   * Failures come back as a message instead of a throw, so the view switcher
   * and the raw-YAML toggle stay usable while the file is being fixed.
   */
  async baseView(path: string, view?: string): Promise<BaseViewResponse> {
    const bundle = this.requireBundle();
    let file;
    try {
      file = await readBaseFile(bundle, path);
    } catch (error) {
      return { views: [], error: error instanceof Error ? error.message : String(error) };
    }
    if (!file.ok) return { views: [], error: file.error };
    const views = listViews(file.value);
    try {
      const result = runBase(file.value, bundle.allConcepts().map(baseRowOf), {
        ...(view !== undefined ? { view } : {}),
        now: Date.now(),
      });
      return { views, result };
    } catch (error) {
      return { views, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Validate, then write exactly the text given: unknown keys and the author's
   * formatting survive because nothing is re-serialised. Returns the warnings.
   */
  async baseWrite(
    path: string,
    content: string,
    opts: { by: "human" | "agent"; actor?: string }
  ): Promise<string[]> {
    const bundle = this.requireBundle();
    if (!isBasePath(path)) throw new Error("'path' must end in .base");
    const abs = bundle.paths.resolve(path);
    const rel = bundle.paths.toRel(abs);
    if (bundle.paths.layerOf(rel) !== "wiki") {
      throw new Error(`A .base file must live under wiki/: ${path}`);
    }
    // In a flat bundle the wiki layer is the whole folder, so the layer check alone
    // would let a base into .okf/, .git/ or any other hidden place.
    if (rel.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
      throw new Error(`A .base file cannot live in a hidden folder: ${path}`);
    }
    const parsed = parseBaseYaml(content);
    if (!parsed.ok) throw new Error("Invalid base, nothing written: the content is not valid YAML");
    const found = validateBase(parsed.value);
    if (found.errors.length > 0) throw new Error(`Invalid base, nothing written: ${found.errors.join("; ")}`);
    await this.writeFile(path, content, { by: opts.by, ...(opts.actor ? { actor: opts.actor } : {}) });
    return found.warnings;
  }

  // ---- canvases and the graph schema ---------------------------------------------

  /** Every `.canvas` file with its size, or why it cannot be read. */
  async canvasList(): Promise<Array<{ path: string; nodes?: number; edges?: number; error?: string }>> {
    const bundle = this.requireBundle();
    const out: Array<{ path: string; nodes?: number; edges?: number; error?: string }> = [];
    for (const path of await listCanvasPaths(bundle)) {
      const file = await readCanvasFile(bundle, path).catch(() => null);
      if (!file) continue;
      out.push(
        file.ok
          ? { path, nodes: file.value.nodes?.length ?? 0, edges: file.value.edges?.length ?? 0 }
          : { path, error: describeCanvasErrors(file.errors) }
      );
    }
    return out;
  }

  /** One canvas as structured JSON plus the text outline an agent reads. */
  async canvasRead(path: string): Promise<{ path: string; nodeCount: number; edgeCount: number; canvas: unknown; outline: string }> {
    const bundle = this.requireBundle();
    const file = await readCanvasFile(bundle, path);
    if (!file.ok) throw new Error(`Invalid canvas ${path}: ${describeCanvasErrors(file.errors)}`);
    return {
      path,
      nodeCount: file.value.nodes?.length ?? 0,
      edgeCount: file.value.edges?.length ?? 0,
      canvas: file.value,
      outline: canvasOutline(file.value, canvasFileResolver(bundle), path),
    };
  }

  /**
   * Validate, then write exactly the text given: unknown keys, the order of
   * nodes and edges and the author's formatting survive because nothing is
   * re-serialised.
   */
  async canvasWrite(path: string, content: string, opts: { by: "human" | "agent"; actor?: string }): Promise<void> {
    const bundle = this.requireBundle();
    if (!isCanvasPath(path)) throw new Error("'path' must end in .canvas");
    const abs = bundle.paths.resolve(path);
    const rel = bundle.paths.toRel(abs);
    if (bundle.paths.layerOf(rel) !== "wiki") {
      throw new Error(`A .canvas file must live under wiki/: ${path}`);
    }
    // In a flat bundle the wiki layer is the whole folder, so the layer check alone
    // would let a canvas into .okf/, .git/ or any other hidden place.
    if (rel.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
      throw new Error(`A .canvas file cannot live in a hidden folder: ${path}`);
    }
    const parsed = parseCanvas(content);
    if (!parsed.ok) throw new Error(`Invalid canvas, nothing written: ${describeCanvasErrors(parsed.errors)}`);
    await this.writeFile(path, content, { by: opts.by, ...(opts.actor ? { actor: opts.actor } : {}) });
  }

  /**
   * Draw the neighbourhood of a concept, or of what a query finds, as a canvas
   * and save it. The layout is deterministic (`shared/okf/canvas-graph.ts`).
   */
  async canvasFromLinks(opts: {
    root?: string;
    query?: string;
    depth?: number;
    includeDead?: boolean;
    paraDepth?: number;
    groupByPara?: boolean;
    /** Replace a canvas already at `path`. Off by default: a hand-made canvas must not be lost to a redraw. */
    overwrite?: boolean;
    path: string;
    by: "human" | "agent";
    actor?: string;
  }): Promise<{ path: string; concepts: number; edges: number; truncated: boolean; outline: string }> {
    const bundle = this.requireBundle();
    const roots: string[] = [];
    if (opts.root) {
      const id = resolveRootConcept(bundle, opts.root);
      if (id === null) throw new Error(`No concept matches root: ${opts.root}`);
      roots.push(id);
    }
    if (opts.query) {
      const hits = this.search(opts.query, {
        limit: QUERY_ROOTS,
        ...(opts.includeDead ? { includeDead: true } : {}),
        ...(opts.paraDepth !== undefined ? { paraDepth: opts.paraDepth } : {}),
      });
      if (hits.length === 0 && roots.length === 0) throw new Error(`No concept matches the query: ${opts.query}`);
      for (const hit of hits) roots.push(hit.id);
    }

    // A bare file name goes in the default folder; anything with a folder is taken as written.
    const target = /[\\/]/.test(opts.path)
      ? opts.path
      : `${bundle.paths.wikiDir ? `${bundle.paths.wikiDir}/` : ""}${CANVASES_DIR}/${opts.path}`;

    const result = buildGraphCanvas(
      bundle.allConcepts().map((doc) => ({
        id: doc.id,
        path: doc.relPath,
        dead: lifecycleOf(tagsOf(doc)) === "dead",
        links: doc.links.map((l) => ({ resolved: l.resolved, ...(l.relation !== undefined ? { relation: l.relation } : {}) })),
      })),
      {
        roots,
        depth: opts.depth ?? 1,
        includeDead: opts.includeDead === true,
        ...(opts.paraDepth !== undefined ? { paraDepth: opts.paraDepth } : {}),
        groupByPara: opts.groupByPara === true,
      }
    );
    if (opts.overwrite !== true && (await bundle.exists(target))) {
      throw new Error(`${target} already exists; pass overwrite: true to replace it`);
    }
    await this.canvasWrite(target, serializeCanvas(result.canvas), {
      by: opts.by,
      ...(opts.actor ? { actor: opts.actor } : {}),
    });
    return {
      path: target,
      concepts: result.concepts,
      edges: result.edges,
      truncated: result.truncated,
      outline: canvasOutline(result.canvas, canvasFileResolver(bundle), target),
    };
  }

  /** A path in the default canvas folder that nothing uses yet: `stem.canvas`, then `stem-2.canvas`, ... */
  async uniqueCanvasPath(stem: string): Promise<string> {
    const bundle = this.requireBundle();
    const dir = `${bundle.paths.wikiDir ? `${bundle.paths.wikiDir}/` : ""}${CANVASES_DIR}`;
    for (let n = 1; ; n++) {
      const path = `${dir}/${stem}${n === 1 ? "" : `-${n}`}.canvas`;
      if (!(await bundle.exists(path))) return path;
    }
  }

  /** The schema concept, parsed, or `null` when the bundle has none. */
  private loadGraphSchema(): { schema: GraphSchema; type: string } | null {
    const doc = this.requireBundle().getConcept(GRAPH_SCHEMA_ID);
    if (!doc) return null;
    return { schema: parseGraphSchema(doc.frontmatter as Record<string, unknown>), type: doc.frontmatter.type };
  }

  /** `graph_schema`: the declared concept types and relation kinds. */
  graphSchema(): {
    path: string;
    exists: boolean;
    types: NonNullable<GraphSchema["types"]>;
    kinds: NonNullable<GraphSchema["kinds"]>;
    problems?: string[];
  } {
    const path = this.requireBundle().paths.relPathOfId(GRAPH_SCHEMA_ID);
    const loaded = this.loadGraphSchema();
    if (!loaded) return { path, exists: false, types: [], kinds: [] };
    const problems = [...loaded.schema.problems];
    if (loaded.type !== GRAPH_SCHEMA_TYPE) problems.unshift(`the schema concept's type should be ${GRAPH_SCHEMA_TYPE}`);
    return {
      path,
      exists: true,
      types: loaded.schema.types ?? [],
      kinds: loaded.schema.kinds ?? [],
      ...(problems.length > 0 ? { problems } : {}),
    };
  }

  /**
   * Concept types and relation kinds outside the schema, per concept. Empty
   * when there is no schema, so a bundle that never made one sees nothing.
   */
  schemaWarnings(): Array<{ path: string; warnings: string[] }> {
    const bundle = this.requireBundle();
    const loaded = this.loadGraphSchema();
    if (!loaded) return [];
    return schemaWarnings(loaded.schema, bundle.allConcepts(), bundle.paths.wikiDir);
  }

  // ---- SYSTEMMAP.md -----------------------------------------------------------------

  private async systemMapFacts(toolCount: number): Promise<SystemMapFacts> {
    const bundle = this.requireBundle();
    const docs = bundle.allConcepts();
    const para = { project: 0, area: 0, resource: 0, archive: 0 };
    const types = new Map<string, number>();
    let dead = 0;
    let knowhow = 0;
    for (const doc of docs) {
      para[paraOf(doc.id)] += 1;
      const type = String(doc.frontmatter.type);
      types.set(type, (types.get(type) ?? 0) + 1);
      if (lifecycleOf(tagsOf(doc)) === "dead") dead += 1;
      if (doc.id.startsWith(`${KNOWHOW_DIR}/`)) knowhow += 1;
    }

    const loops = this.requireLoops();
    const loopFacts: SystemMapFacts["loops"] = [];
    for (const name of [...(await loops.list())].sort(compareCodePoints)) {
      const design = await loops.read(name).catch(() => null);
      if (design) loopFacts.push({ name: design.name, goal: design.goal });
    }

    const schema = this.loadGraphSchema()?.schema ?? null;
    return {
      concepts: docs.length,
      dead,
      knowhow,
      toolCount,
      para,
      types: [...types.entries()].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0])),
      bases: (await this.baseList()).map((b) => ({
        path: b.path,
        views: b.views.map((v) => v.name),
        ...(b.error !== undefined ? { error: b.error } : {}),
      })),
      canvases: await this.canvasList(),
      skills: (await this.requireSkills().summaries())
        .map((s) => ({ name: s.name, description: s.description }))
        .sort((a, b) => compareCodePoints(a.name, b.name)),
      loops: loopFacts,
      schema: schema && {
        types: schema.types?.map((t) => t.name) ?? null,
        kinds: schema.kinds?.map((k) => ({ name: k.name, ...(k.from ? { from: k.from } : {}), ...(k.to ? { to: k.to } : {}) })) ?? null,
      },
    };
  }

  /**
   * SYSTEMMAP.md, as it is on disk. With `refresh`, the section between the
   * markers is regenerated from the bundle and written; the text around it is
   * not touched. A bundle that has none gets the file on the first refresh.
   */
  async systemMap(opts: { refresh?: boolean; actor?: string; toolCount: number }): Promise<string> {
    const bundle = this.requireBundle();
    const path = bundle.paths.toRel(bundle.paths.systemMapMdPath);
    let previous: string | undefined;
    try {
      previous = await readFile(bundle.paths.systemMapMdPath, "utf8");
    } catch (error) {
      // Only "not there" means absent. A locked or unreadable file must not be
      // taken for a missing one, or the refresh would overwrite it.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      previous = undefined;
    }
    if (!opts.refresh) {
      return previous ?? renderSystemMap(undefined, await this.systemMapFacts(opts.toolCount));
    }

    const next = renderSystemMap(previous, await this.systemMapFacts(opts.toolCount));
    if (next !== previous) {
      await this.writeFile(path, next, {
        by: "agent",
        actor: opts.actor || "process:mcp",
        action: previous === undefined ? "create" : "write",
      });
    }
    return next;
  }

  tags(): TagCount[] {
    return this.requireFts().tags();
  }

  types(): TagCount[] {
    return this.requireFts().types();
  }

  /** Every concept id and title, for the quick switcher. */
  listConcepts(): Array<{
    id: string;
    path: string;
    title: string;
    type: string;
    lifecycle?: Lifecycle;
  }> {
    return this.requireBundle()
      .allConcepts()
      .map((doc) => {
        const lifecycle = lifecycleOf(tagsOf(doc));
        return {
          id: doc.id,
          path: doc.relPath,
          title:
            typeof doc.frontmatter.title === "string" && doc.frontmatter.title.trim()
              ? doc.frontmatter.title
              : doc.id,
          type: doc.frontmatter.type,
          // Listed even when DEAD: this is the inventory, and a retired note
          // must stay visible here to be found and revived. Only a marked
          // concept carries the key, so an unmarked entry looks as it always did.
          ...(lifecycle === "none" ? {} : { lifecycle }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  unresolvedLinks(): Array<{ from: string; target: string; relation?: string }> {
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
  ): Promise<MoveResult> {
    const bundle = this.requireBundle();
    this.markSelfWrite(from);
    this.markSelfWrite(to);
    this.markLogWrite();

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
    this.markLogWrite();

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
    await this.writeHuman(template);
    return template;
  }

  async writeHuman(content: string): Promise<void> {
    const bundle = this.requireBundle();
    this.markSelfWrite(bundle.paths.toRel(bundle.paths.humanMdPath));
    await bundle.writeHuman(content);
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

    await this.writeFile(
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

    // One write of Task.md for the whole note, rather than one per line.
    const created = await this.addTasks(
      pending.map((item) => ({
        title: item.text,
        // Where it came from, so the task is traceable back to the day.
        note: `${dailyId(date)} のノートから`,
      }))
    );

    let body = file.content;
    for (const [at, item] of pending.entries()) {
      body = markTransferred(body, item.line, created[at]!.id);
    }

    // 'process:', not a bare 'agent': the transfer is automated whichever
    // front end asked for it, and the audit filter for automation is 'process:'.
    await this.writeFile(relPath, body, {
      by: "agent",
      actor: "process:task-collect",
      action: "update",
    });
    return created;
  }

  async listTasks(status?: TaskStatus): Promise<Task[]> {
    const file = await this.requireBundle().readTaskFile();
    // The default is open work only. Finished tasks are the bulk of the file
    // and are almost never what the caller wanted.
    if (!status) return openTasks(file);
    return file.tasks.filter((task) => task.status === status);
  }

  async addTask(input: TaskInput): Promise<Task> {
    const [task] = await this.addTasks([input]);
    return task!;
  }

  /**
   * Add several tasks in one read-modify-write of `Task.md`.
   *
   * Ids are allocated against the list as it grows, so a batch cannot collide
   * with itself. Doing this per task would rewrite the whole file once each
   * time and leave a window between writes for the watcher — or another
   * writer — to see a half-transferred list.
   */
  async addTasks(inputs: readonly TaskInput[]): Promise<Task[]> {
    const file = await this.requireBundle().readTaskFile();

    const created = inputs.map((input) => {
      const task: Task = {
        id: nextTaskId(file.tasks),
        title: input.title.trim(),
        status: input.status ?? "todo",
        ...(input.para ? { para: input.para } : {}),
        ...(input.due ? { due: input.due } : {}),
        ...(input.note ? { note: input.note } : {}),
      };
      file.tasks.unshift(task);
      return task;
    });

    await this.writeTaskFile(file);
    return created;
  }

  /** Write `Task.md`, suppressing the watcher event for our own write. */
  private async writeTaskFile(file: TaskFile): Promise<void> {
    const bundle = this.requireBundle();
    this.markSelfWrite(bundle.paths.toRel(bundle.paths.taskMdPath));
    await bundle.writeTaskFile(file);
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
        task.done = isoDate(new Date());
        file.doneEver += 1;
      } else if (wasDone) {
        delete task.done;
        file.doneEver = Math.max(0, file.doneEver - 1);
      }
    }

    // Newest completions first, so the kept window holds the recent ones.
    file.tasks.sort((a, b) => (b.done ?? "").localeCompare(a.done ?? ""));

    await this.writeTaskFile(file);
    return task;
  }
}

export interface TaskInput {
  title: string;
  status?: TaskStatus;
  para?: ParaClass;
  due?: string;
  note?: string;
}

/** A concept's tags that are strings, which is all the index and lifecycle read. */
function tagsOf(doc: ConceptDocument): string[] {
  const tags: unknown = doc.frontmatter.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
}

/** ASCII-only lower-casing: the fold SQLite's LIKE applies in the index filters. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Whether a concept passes the `type` / `tags` / `path_prefix` filters, with
 * the same rules the index applies to searches (so a link or a know-how note
 * is held to what a passage would be).
 */
function matchesFilters(doc: ConceptDocument, filters: SearchFilters): boolean {
  if (filters.type && doc.frontmatter.type !== filters.type) return false;
  if (filters.pathPrefix) {
    const prefix = asciiLower(filters.pathPrefix.replace(/[%_]/g, ""));
    if (!asciiLower(doc.relPath).startsWith(prefix)) return false;
  }
  const tags = tagsOf(doc).map(asciiLower);
  return (filters.tags ?? []).every((tag) => tags.includes(asciiLower(tag)));
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
