/**
 * The OKF bundle: an on-disk directory tree, loaded into a concept map and a
 * link graph.
 *
 * File over app — nothing here caches authoritatively. The maps are a read
 * model that can be rebuilt from disk at any moment, which is what makes an
 * external edit (human in another editor, or an agent over MCP) indistinguishable
 * from one made in the UI.
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join, resolve, sep } from "path";
import type {
  BundleInfo,
  ConceptDocument,
  ConformanceIssue,
  FileNode,
  LogEntry,
  ReadFileResult,
  WriteFileResult,
} from "../../shared/types";
import { inspect } from "../../shared/binary";
import { messages } from "../../shared/messages";
import {
  parseTasks,
  renderMap,
  renderTasks,
  type TaskFile,
} from "../../shared/okf/workspace-files";
import { migrateLayout, type MigrationResult } from "./migrate";
import {
  OKF_VERSION,
  basenameOf,
  buildBacklinks,
  checkConformance,
  conceptIdFromRelPath,
  conceptTitle,
  emptyLogMd,
  extractLinks,
  insertLogEntry,
  isConceptPath,
  isReservedFilename,
  rebaseOwnLinks,
  renderIndexMd,
  resolveLinkTarget,
  rewriteLinks,
  splitFrontmatter,
  joinFrontmatter,
  readOkfVersion,
  type IndexSection,
} from "../../shared/okf";
import { parseConcept } from "./parser";
import { BundlePaths, RAW_DIR, WIKI_DIR, isContained, toPosix, type Actor } from "./paths";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path that does not exist yet, by appending `-2`, `-3` … when needed.
 * Re-importing the same page should add a copy, never replace the first.
 */
async function uniquePath(abs: string): Promise<string> {
  if (!(await pathExists(abs))) return abs;

  const dot = abs.lastIndexOf(".");
  const stem = dot > abs.lastIndexOf(sep) ? abs.slice(0, dot) : abs;
  const ext = dot > abs.lastIndexOf(sep) ? abs.slice(dot) : "";

  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The part of a filesystem error worth showing.
 *
 * Node repeats the absolute path inside the message, and the caller has
 * already put the path in front of it. `ENOENT: no such file or directory` is
 * what is left, which is the part that says what to fix.
 */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/,\s*(?:open|mkdir|unlink|rename|stat)\s+'[^']*'\s*$/, "");
}

export class Bundle {
  readonly paths: BundlePaths;

  private concepts = new Map<string, ConceptDocument>();
  private backlinks = new Map<string, string[]>();
  private conformance = new Map<string, string[]>();

  private constructor(paths: BundlePaths) {
    this.paths = paths;
  }

  /**
   * Open a directory as a bundle.
   *
   * A `wiki/` subdirectory switches on the full three-layer layout; without
   * one the directory *is* the wiki layer, so an existing folder of Markdown
   * can be opened untouched.
   */
  static async open(root: string): Promise<Bundle> {
    const absRoot = resolve(root);
    if (!(await isDirectory(absRoot))) {
      throw new Error(messages.notADirectory(absRoot));
    }
    const wikiDir = (await isDirectory(join(absRoot, WIKI_DIR))) ? WIKI_DIR : "";
    const paths = new BundlePaths(absRoot, wikiDir);

    // Bundles written before the layout was corrected keep AGENTS.md, skills/
    // and loops/ at the root. Fix them on open rather than making the user do
    // it: the alternative is an app that silently cannot see its own skills.
    const migration = await migrateLayout(paths).catch(() => null);

    const bundle = new Bundle(paths);
    if (migration) bundle.migration = migration;
    await bundle.reload();
    return bundle;
  }

  /** What the layout migration moved on open, if anything. */
  migration: MigrationResult = { moved: [], skipped: [] };

  get root(): string {
    return this.paths.root;
  }

  /** Re-read every concept from disk and rebuild the graph. */
  async reload(): Promise<void> {
    const found: ConceptDocument[] = [];
    const conformance = new Map<string, string[]>();
    await this.walk(this.paths.wikiRoot, found, conformance);

    // Two passes: wikilinks can only be resolved once every id is known.
    const knownIds = new Set(found.map((doc) => doc.id));
    for (const doc of found) {
      doc.links = extractLinks(doc.body, doc.id, knownIds);
    }

    this.concepts = new Map(found.map((doc) => [doc.id, doc]));
    this.conformance = conformance;
    this.rebuildBacklinks();
  }

  private rebuildBacklinks(): void {
    const graph = new Map<string, ConceptDocument["links"]>();
    for (const [id, doc] of this.concepts) graph.set(id, doc.links);
    this.backlinks = buildBacklinks(graph);
  }

  private async walk(
    dir: string,
    out: ConceptDocument[],
    conformance: Map<string, string[]>
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Dot-directories cover `.rag`, `.git`, `.obsidian` and friends in one rule.
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === RAW_DIR && dirname(abs) === this.paths.root) continue;
        // skills/ and loops/ are wiki content but not knowledge. Scanning them
        // as concepts would put procedures and work logs into the same search
        // results as facts.
        if (this.paths.isSubsystemPath(this.paths.toRel(abs))) continue;
        await this.walk(abs, out, conformance);
        continue;
      }

      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;

      const relPath = this.paths.toRel(abs);
      let raw: string;
      let mtimeMs = 0;
      try {
        raw = await readFile(abs, "utf8");
        mtimeMs = (await stat(abs)).mtimeMs;
      } catch {
        continue; // unreadable file: skip rather than fail the whole open
      }

      const report = checkConformance(this.paths.toWikiRel(abs), raw);
      if (!report.ok) conformance.set(relPath, report.errors);

      // isConceptPath also excludes AGENTS.md, which now lives in wiki/.
      if (isConceptPath(entry.name)) {
        out.push(
          parseConcept({
            id: conceptIdFromRelPath(this.paths.toWikiRel(abs)),
            relPath,
            absPath: abs,
            raw,
            mtimeMs,
          })
        );
      }
    }
  }

  async info(): Promise<BundleInfo> {
    const [hasAgentsMd, hasIndex, hasLog, hasRaw] = await Promise.all([
      pathExists(this.paths.agentsMdPath),
      pathExists(this.paths.indexMdPath),
      pathExists(this.paths.logMdPath),
      isDirectory(this.paths.rawRoot),
    ]);

    return {
      root: this.paths.root,
      wikiDir: this.paths.wikiDir,
      hasAgentsMd,
      hasIndex,
      hasLog,
      hasRaw,
      conceptCount: this.concepts.size,
      nonConformantCount: this.conformance.size,
      warnings: [...this.warnings],
    };
  }

  allConcepts(): ConceptDocument[] {
    return [...this.concepts.values()];
  }

  getConcept(id: string): ConceptDocument | undefined {
    return this.concepts.get(id);
  }

  conceptIds(): Set<string> {
    return new Set(this.concepts.keys());
  }

  backlinksOf(id: string): string[] {
    return this.backlinks.get(id) ?? [];
  }

  conformanceIssues(): ConformanceIssue[] {
    return [...this.conformance.entries()]
      .map(([path, errors]) => ({ path, errors }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Resolve a raw link target written inside `from` to a concept id. */
  resolveLink(from: string, target: string): string | null {
    return resolveLinkTarget(target, from, this.conceptIds());
  }

  async listDir(rel = "", recursive = false): Promise<FileNode[]> {
    const dir = this.paths.resolve(rel);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes: FileNode[] = [];
    for (const entry of entries) {
      // Every dot-directory is hidden, `.rag/` included. It holds SQLite
      // files that are meaningless to read and actively harmful to open, and
      // it rebuilds from Layer 2 — there is nothing in it to browse.
      if (entry.name.startsWith(".")) continue;

      const childRel = rel ? `${toPosix(rel)}/${entry.name}` : entry.name;
      const layer = this.paths.layerOf(childRel);
      const node: FileNode = {
        name: entry.name,
        path: childRel,
        type: entry.isDirectory() ? "dir" : "file",
        ...(layer ? { layer } : {}),
      };
      if (entry.isDirectory() && recursive) {
        node.children = await this.listDir(childRel, true);
      }
      nodes.push(node);
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async readFile(relPath: string): Promise<ReadFileResult> {
    const abs = this.paths.resolve(relPath);
    const bytes = new Uint8Array(await readFile(abs));
    const mtimeMs = (await stat(abs)).mtimeMs;
    const rel = this.paths.toRel(abs);

    // Decoding a SQLite database as UTF-8 fills the editor with replacement
    // characters that are indistinguishable from an encoding fault. Report the
    // file for what it is instead.
    const check = inspect(bytes);
    if (check.binary) {
      return {
        content: "",
        binary: true,
        ...(check.fileType ? { fileType: check.fileType } : {}),
        byteLength: bytes.byteLength,
        backlinks: [],
        mtimeMs,
      };
    }

    const content = new TextDecoder("utf-8").decode(bytes);

    if (!isConceptPath(rel)) {
      return { content, backlinks: [], mtimeMs };
    }

    const concept = parseConcept({
      id: conceptIdFromRelPath(this.paths.toWikiRel(abs)),
      relPath: rel,
      absPath: abs,
      raw: content,
      mtimeMs,
      knownIds: this.conceptIds(),
    });
    this.indexConcept(concept);

    return { content, concept, backlinks: this.backlinksOf(concept.id), mtimeMs };
  }

  /**
   * Write a file and keep the read model in step.
   *
   * Layer rules are enforced here rather than at each call site, so the UI and
   * the MCP server cannot drift apart on what an agent is allowed to touch.
   */
  async writeFile(
    relPath: string,
    content: string,
    opts: { actor?: string; log?: boolean; action?: string; note?: string; by?: Actor } = {}
  ): Promise<WriteFileResult & { concept?: ConceptDocument }> {
    const abs = this.paths.assertWritable(relPath, opts.by ?? "human");
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");

    const mtimeMs = (await stat(abs)).mtimeMs;
    const rel = this.paths.toRel(abs);

    // Keep the conformance report in step with the write, so a bundle-wide
    // check reflects what is on disk rather than what was there at open time.
    const report = checkConformance(this.paths.toWikiRel(abs), content);
    if (report.ok) this.conformance.delete(rel);
    else this.conformance.set(rel, report.errors);

    let concept: ConceptDocument | undefined;
    if (isConceptPath(rel)) {
      concept = parseConcept({
        id: conceptIdFromRelPath(this.paths.toWikiRel(abs)),
        relPath: rel,
        absPath: abs,
        raw: content,
        mtimeMs,
        knownIds: this.conceptIds(),
      });
      this.indexConcept(concept);
    }

    if (opts.log !== false) {
      await this.appendLog({
        at: new Date().toISOString(),
        actor: opts.actor ?? "human:local",
        action: opts.action ?? "write",
        path: rel,
        ...(opts.note ? { note: opts.note } : {}),
      });
    }

    return { ok: true, mtimeMs, warnings: report.errors, ...(concept ? { concept } : {}) };
  }

  /** Refresh a single path from disk after an external change. */
  async refresh(relPath: string): Promise<ConceptDocument | null> {
    const abs = this.paths.resolve(relPath);
    const rel = this.paths.toRel(abs);

    if (!(await pathExists(abs))) {
      const id = conceptIdFromRelPath(this.paths.toWikiRel(abs));
      this.concepts.delete(id);
      this.conformance.delete(rel);
      this.rebuildBacklinks();
      return null;
    }

    if (!/\.md$/i.test(rel)) return null;

    const content = await readFile(abs, "utf8");
    const report = checkConformance(this.paths.toWikiRel(abs), content);
    if (report.ok) this.conformance.delete(rel);
    else this.conformance.set(rel, report.errors);

    if (!isConceptPath(rel)) return null;

    const concept = parseConcept({
      id: conceptIdFromRelPath(this.paths.toWikiRel(abs)),
      relPath: rel,
      absPath: abs,
      raw: content,
      mtimeMs: (await stat(abs)).mtimeMs,
      knownIds: this.conceptIds(),
    });
    this.indexConcept(concept);
    return concept;
  }

  private indexConcept(concept: ConceptDocument): void {
    this.concepts.set(concept.id, concept);
    this.rebuildBacklinks();
  }

  /** Create a directory inside the bundle. */
  async createDirectory(relPath: string, by: Actor = "human"): Promise<void> {
    const abs = this.paths.assertWritable(relPath, by);
    await mkdir(abs, { recursive: true });
  }

  /**
   * Move or rename a file, updating every link that pointed at it.
   *
   * Returns the documents that were rewritten, so the caller can reindex them.
   * A rename that silently broke inbound links would be worse than no rename
   * at all, so this is one operation rather than a move plus a manual fixup.
   */
  async movePath(
    fromRel: string,
    toRel: string,
    opts: { actor?: string; by?: "human" | "agent" } = {}
  ): Promise<{ moved: string; updated: string[]; linkCount: number }> {
    // Crossing layers is a curation decision with its own rule; `assertWritable`
    // only answers "may this path be edited".
    this.paths.assertMovable(fromRel, toRel, opts.by ?? "human");

    const fromAbs = this.paths.resolve(fromRel);
    const toAbs = this.paths.assertWritable(toRel, opts.by ?? "human");

    if (!(await pathExists(fromAbs))) throw new Error(messages.notFound(fromRel));
    if (await pathExists(toAbs)) throw new Error(messages.alreadyExists(toRel));

    const wasConcept = isConceptPath(this.paths.toRel(fromAbs));
    const oldId = conceptIdFromRelPath(this.paths.toWikiRel(fromAbs));
    const newId = conceptIdFromRelPath(this.paths.toWikiRel(toAbs));

    // Link resolution has to use the pre-move id set, because that is what
    // made each existing link point where it does.
    const knownIds = this.conceptIds();
    const updated: string[] = [];
    let linkCount = 0;

    if (wasConcept && isConceptPath(this.paths.toRel(toAbs)) && oldId !== newId) {
      // The moved document's own relative links are rebased before it moves,
      // while its old location is still the anchor they were written against.
      const source = await readFile(fromAbs, "utf8");
      const { yaml, body } = splitFrontmatter(source);
      const rebased = rebaseOwnLinks(body, oldId, newId, knownIds);
      if (rebased.count > 0) {
        await writeFile(
          fromAbs,
          yaml === null ? rebased.body : joinFrontmatter(yaml, rebased.body),
          "utf8"
        );
        linkCount += rebased.count;
      }
    }

    await mkdir(dirname(toAbs), { recursive: true });
    await rename(fromAbs, toAbs);

    if (wasConcept && oldId !== newId) {
      for (const [id, doc] of this.concepts) {
        if (id === oldId) continue;
        if (!doc.links.some((link) => link.resolved === oldId)) continue;

        const source = await readFile(doc.path, "utf8");
        const { yaml, body } = splitFrontmatter(source);
        const result = rewriteLinks(body, id, oldId, newId, knownIds);
        if (result.count === 0) continue;

        await writeFile(
          doc.path,
          yaml === null ? result.body : joinFrontmatter(yaml, result.body),
          "utf8"
        );
        updated.push(doc.relPath);
        linkCount += result.count;
      }
    }

    await this.reload();

    if (opts.actor !== undefined) {
      await this.appendLog({
        at: new Date().toISOString(),
        actor: opts.actor,
        action: "move",
        path: `${this.paths.toRel(fromAbs)} → ${this.paths.toRel(toAbs)}`,
        ...(linkCount ? { note: `${linkCount} link(s) updated` } : {}),
      });
    }

    return { moved: this.paths.toRel(toAbs), updated, linkCount };
  }

  /**
   * Delete a file or directory.
   *
   * Inbound links are reported rather than rewritten: there is no correct
   * target to point them at, and quietly stripping them would destroy the
   * record that something used to be there.
   */
  /**
   * Bring a file up from `raw/` into the wiki layer.
   *
   * This is the curation step made explicit. By default the original stays
   * where it is and the new file records where it came from: `raw/` is the
   * record of what was actually received, and a wiki page whose source has
   * been moved away cannot be checked against it.
   *
   * `keepSource: false` performs a true move, for the case where something
   * simply landed in the wrong place.
   */
  async promoteFromRaw(
    fromRel: string,
    toRel: string,
    opts: { actor?: string; keepSource?: boolean } = {}
  ): Promise<{ promoted: string; source: string; kept: boolean }> {
    const keep = opts.keepSource !== false;

    // Promotion is human-only; `assertMovable` is where that is decided.
    this.paths.assertMovable(fromRel, toRel, "human");

    const fromAbs = this.paths.resolve(fromRel);
    if (this.paths.layerOf(this.paths.toRel(fromAbs)) !== "raw") {
      throw new Error(messages.notFound(fromRel));
    }
    if (!(await pathExists(fromAbs))) throw new Error(messages.notFound(fromRel));

    const toAbs = await uniquePath(this.paths.assertWritable(toRel));
    await mkdir(dirname(toAbs), { recursive: true });

    if (keep) {
      await copyFile(fromAbs, toAbs);
    } else {
      await rename(fromAbs, toAbs);
    }

    const promoted = this.paths.toRel(toAbs);
    await this.appendLog({
      at: new Date().toISOString(),
      actor: opts.actor ?? "human:local",
      action: keep ? "promote-copy" : "promote",
      path: promoted,
      note: `from ${this.paths.toRel(fromAbs)}`,
    });

    await this.refresh(promoted);
    return { promoted, source: this.paths.toRel(fromAbs), kept: keep };
  }

  async deletePath(
    relPath: string,
    opts: { actor?: string; recursive?: boolean; by?: Actor } = {}
  ): Promise<{ deleted: string; brokenLinksFrom: string[] }> {
    const abs = this.paths.assertWritable(relPath, opts.by ?? "human");
    const rel = this.paths.toRel(abs);

    if (isReservedFilename(basenameOf(rel))) {
      throw new Error(messages.reservedCannotDelete(rel));
    }
    if (!(await pathExists(abs))) throw new Error(messages.notFound(relPath));

    const id = conceptIdFromRelPath(this.paths.toWikiRel(abs));
    const brokenLinksFrom = isConceptPath(rel) ? this.backlinksOf(id) : [];

    await rm(abs, { recursive: opts.recursive ?? true, force: false });
    await this.reload();

    if (opts.actor !== undefined) {
      await this.appendLog({
        at: new Date().toISOString(),
        actor: opts.actor,
        action: "delete",
        path: rel,
        ...(brokenLinksFrom.length
          ? { note: `${brokenLinksFrom.length} inbound link(s) now broken` }
          : {}),
      });
    }

    return { deleted: rel, brokenLinksFrom };
  }

  /**
   * Capture a new source file into Layer 1.
   *
   * `raw/` is immutable in the sense that matters: a source, once captured, is
   * never altered or replaced. Capturing a *new* one is how material gets in at
   * all, so this is the one narrow way to write there — and it refuses to
   * overwrite, choosing a fresh name instead, so no previously captured source
   * can be lost.
   */
  async importToRaw(
    relPath: string,
    content: string,
    opts: { actor?: string; note?: string } = {}
  ): Promise<{ path: string }> {
    const abs = this.paths.resolve(relPath);
    if (!isContained(this.paths.rawRoot, abs)) {
      throw new Error(messages.importOutsideRaw(relPath));
    }

    const unique = await uniquePath(abs);
    await mkdir(dirname(unique), { recursive: true });
    await writeFile(unique, content, "utf8");

    const rel = this.paths.toRel(unique);
    await this.appendLog({
      at: new Date().toISOString(),
      actor: opts.actor ?? "process:import",
      action: "create",
      path: rel,
      ...(opts.note ? { note: opts.note } : {}),
    });

    return { path: rel };
  }

  /** Every tag in the bundle with its usage count. */
  tagCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const doc of this.concepts.values()) {
      const tags = doc.frontmatter.tags;
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        if (typeof tag !== "string" || !tag) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Concepts whose wikilinks point at ids that do not exist yet. */
  unresolvedLinks(): Array<{ from: string; target: string }> {
    const out: Array<{ from: string; target: string }> = [];
    for (const doc of this.concepts.values()) {
      for (const link of doc.links) {
        if (link.resolved === null && link.kind === "wikilink") {
          out.push({ from: doc.id, target: link.target });
        }
      }
    }
    return out;
  }

  /**
   * Create `index.md` and `log.md` if absent. Never overwrites.
   *
   * Never fatal, either. These two files are a convenience — an entry point and
   * a history — and the folder's actual contents are readable without them, so
   * a name that cannot be written must not cost the user the whole bundle.
   * Opening a folder used to abort with a bare
   * `ENOENT: ... open '<root>\index.md'` when the name was occupied by a broken
   * link, which read as the folder being unopenable when every note in it was
   * fine.
   *
   * Failures are collected into `warnings` and surfaced in `info()`.
   */
  async ensureReservedFiles(): Promise<void> {
    this.warnings = [];

    try {
      await mkdir(this.paths.wikiRoot, { recursive: true });
    } catch (error) {
      this.warnings.push(
        messages.reservedFileNotCreated(this.paths.wikiRoot, reasonOf(error))
      );
      return;
    }

    await this.ensureReservedFile(this.paths.indexMdPath, () => this.renderIndex());
    await this.ensureReservedFile(this.paths.logMdPath, async () => emptyLogMd());
  }

  private async ensureReservedFile(abs: string, render: () => Promise<string>): Promise<void> {
    try {
      if (await pathExists(abs)) return;
      await writeFile(abs, await render(), "utf8");
    } catch (error) {
      this.warnings.push(messages.reservedFileNotCreated(abs, reasonOf(error)));
    }
  }

  /** Non-fatal problems from the last open. */
  private warnings: string[] = [];

  /**
   * Build the bundle-root `index.md` (OKF §8).
   *
   * Concepts are grouped into sections by their top-level directory, which is
   * what "progressive disclosure" means here: the reader sees the shape of the
   * bundle before any individual page. Links use the bundle-absolute form the
   * spec recommends, so they survive a document moving within its directory.
   */
  private async renderIndex(): Promise<string> {
    const grouped = new Map<string, IndexSection>();

    for (const doc of this.allConcepts().sort((a, b) => a.id.localeCompare(b.id))) {
      const heading = doc.id.includes("/") ? doc.id.slice(0, doc.id.indexOf("/")) : "Concepts";
      let section = grouped.get(heading);
      if (!section) {
        section = { heading, entries: [] };
        grouped.set(heading, section);
      }
      section.entries.push({
        href: `/${doc.id}.md`,
        title: conceptTitle(doc.id, doc.frontmatter),
        ...(typeof doc.frontmatter.description === "string" && doc.frontmatter.description.trim()
          ? { description: doc.frontmatter.description }
          : {}),
      });
    }

    // Root-level concepts first, then subdirectories alphabetically.
    const sections = [...grouped.values()].sort((a, b) => {
      if (a.heading === "Concepts") return -1;
      if (b.heading === "Concepts") return 1;
      return a.heading.localeCompare(b.heading);
    });

    return renderIndexMd(basenameOf(this.paths.root), sections, { okfVersion: OKF_VERSION });
  }

  /** Regenerate `index.md` from the current concept set. */
  async rebuildIndexMd(): Promise<number> {
    await this.reload();
    const content = await this.renderIndex();
    await mkdir(this.paths.wikiRoot, { recursive: true });
    await writeFile(this.paths.indexMdPath, content, "utf8");
    return this.concepts.size;
  }

  /** The `okf_version` declared by the bundle-root `index.md`, if any. */
  async readOkfVersion(): Promise<string | null> {
    try {
      return readOkfVersion(await readFile(this.paths.indexMdPath, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Record one entry in `log.md` (OKF §9).
   *
   * The format is date-grouped and newest-first, so this is a read-modify-write
   * rather than an append: a new entry goes at the *top* of today's section.
   * Cost is bounded by the log's size, which is the price of a format a human
   * can actually read.
   */
  async appendLog(entry: LogEntry): Promise<void> {
    const path = this.paths.logMdPath;
    await mkdir(this.paths.wikiRoot, { recursive: true });

    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = emptyLogMd();
    }

    await writeFile(path, insertLogEntry(existing, entry), "utf8");
  }

  async readAgentsMd(): Promise<string | null> {
    try {
      return await readFile(this.paths.agentsMdPath, "utf8");
    } catch {
      // Bundles written before the layout was corrected keep it at the root.
      // Refusing to read it would silently strip an agent of its contract.
      try {
        return await readFile(this.paths.legacyAgentsMdPath, "utf8");
      } catch {
        return null;
      }
    }
  }

  // ---- orientation files -------------------------------------------------

  /**
   * The routing table, regenerated on read when it is missing.
   *
   * Written rather than returned in memory so the file exists for a human to
   * open, and because the next reader should not have to generate it again.
   */
  async readMap(): Promise<string> {
    let previous: string | undefined;
    try {
      previous = await readFile(this.paths.mapMdPath, "utf8");
    } catch {
      previous = undefined;
    }

    // Always re-render: the generated half describes the layout this build
    // implements, so a stale MAP would send an agent to the wrong place. The
    // user's own half is carried through untouched.
    const rendered = renderMap(previous);
    if (rendered !== previous) {
      await mkdir(dirname(this.paths.mapMdPath), { recursive: true });
      await writeFile(this.paths.mapMdPath, rendered, "utf8");
    }
    return rendered;
  }

  async readHuman(): Promise<string | null> {
    try {
      return await readFile(this.paths.humanMdPath, "utf8");
    } catch {
      return null;
    }
  }

  async writeHuman(content: string): Promise<void> {
    await mkdir(dirname(this.paths.humanMdPath), { recursive: true });
    await writeFile(this.paths.humanMdPath, content, "utf8");
  }

  async readTaskFile(): Promise<TaskFile> {
    try {
      return parseTasks(await readFile(this.paths.taskMdPath, "utf8"));
    } catch {
      return { tasks: [], doneEver: 0 };
    }
  }

  async writeTaskFile(file: TaskFile): Promise<void> {
    await mkdir(dirname(this.paths.taskMdPath), { recursive: true });
    await writeFile(this.paths.taskMdPath, renderTasks(file), "utf8");
  }
}
