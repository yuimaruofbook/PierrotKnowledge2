/**
 * SkillSpace: discovery and on-demand loading of the `skills/` layer.
 *
 * The whole design goal is that having many skills costs almost nothing until
 * one is used. So this keeps three tiers strictly apart:
 *
 *   1. `summaries()` — name, description, size. Always affordable.
 *   2. `open(name)`  — the SKILL.md body. Paid for once, on purpose.
 *   3. `readResource(name, path)` — a supporting file the body pointed at.
 *
 * Nothing in tier 1 reads a body, and nothing in tier 2 reads a resource. That
 * is the only reason a catalogue of fifty skills can sit behind an agent
 * without the agent paying for fifty procedures on every request.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, relative, resolve } from "path";
import { messages } from "../../shared/messages";
import {
  SKILL_FILE,
  estimateTokens,
  parseSkill,
  type SkillDocument,
  type SkillSummary,
} from "../../shared/okf/skill";
import { rankSkills, selectionConfidence, type RankedSkill } from "../../shared/okf/skill-rank";
import { isContained, toPosix, type BundlePaths } from "./paths";

/** Files inside a skill folder that are never offered as resources. */
const HIDDEN_PREFIXES = [".", "_"];

/** Cap on how deep a skill folder is walked when listing its resources. */
const MAX_RESOURCE_DEPTH = 3;

/** A resource has to be text to be worth handing to a model. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv", ".tsv",
  ".js", ".ts", ".py", ".sh", ".ps1", ".sql", ".html", ".css", ".xml",
]);

export interface SkillFindResult {
  ranked: Array<{ name: string; description: string; score: number; matched: string[] }>;
  confidence: "high" | "medium" | "low";
  /** What it would cost to open the top result. */
  topTokens: number;
}

interface CacheEntry {
  document: SkillDocument;
  resources: string[];
  mtimeMs: number;
}

export class SkillSpace {
  private cache = new Map<string, CacheEntry>();
  /** Cleared wholesale on any change; a skill catalogue is small enough. */
  private listing: SkillSummary[] | null = null;

  constructor(private readonly paths: BundlePaths) {}

  /** Drop everything. Called when the watcher sees `skills/` change. */
  invalidate(): void {
    this.cache.clear();
    this.listing = null;
  }

  /**
   * The cheap tier: every skill's routing information and nothing else.
   *
   * Bodies are read here only to measure them — the text is discarded rather
   * than cached, because caching bodies for skills nobody opens is exactly the
   * memory-for-nothing trade this layer exists to avoid.
   */
  async summaries(): Promise<SkillSummary[]> {
    if (this.listing) return this.listing;

    const names = await this.folderNames();
    const summaries: SkillSummary[] = [];

    for (const { name } of names) {
      const entry = await this.load(name).catch(() => null);
      if (!entry) continue;
      // A skill with no description can never be selected, so listing it would
      // only spend tokens telling an agent about something it cannot use.
      if (!entry.document.description) continue;

      summaries.push({
        name: entry.document.name,
        category: entry.document.category,
        para: entry.document.para,
        description: entry.document.description,
        tags: entry.document.tags,
        bodyTokens: estimateTokens(entry.document.body),
        resources: entry.resources,
      });
    }

    // Category first, then name: the listing reads like the folder tree.
    summaries.sort(
      (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
    );
    this.listing = summaries;
    return summaries;
  }

  /** Rank the catalogue against a request without loading any body. */
  async find(task: string, limit = 3): Promise<SkillFindResult> {
    // Archived skills are kept and can still be opened by name, but they are
    // never proposed: an archived procedure is one somebody decided to stop
    // using, and suggesting it would undo that decision silently.
    const summaries = (await this.summaries()).filter((s) => s.para !== "archive");
    const withWhen = await Promise.all(
      summaries.map(async (summary) => {
        const entry = await this.load(summary.name).catch(() => null);
        return {
          name: summary.name,
          description: summary.description,
          when: entry?.document.when ?? [],
          tags: summary.tags,
          bodyTokens: summary.bodyTokens,
        };
      })
    );

    const ranked = rankSkills(task, withWhen, { limit });
    return {
      ranked: ranked.map((r: RankedSkill<(typeof withWhen)[number]>) => ({
        name: r.skill.name,
        description: r.skill.description,
        score: Math.round(r.score * 100) / 100,
        matched: r.matched,
      })),
      confidence: selectionConfidence(ranked),
      topTokens: ranked[0]?.skill.bodyTokens ?? 0,
    };
  }

  /** The paid tier: a skill's full procedure. */
  async open(name: string): Promise<SkillDocument & { resources: string[] }> {
    const entry = await this.load(name);
    return { ...entry.document, resources: entry.resources };
  }

  /**
   * Read one supporting file from inside a skill folder.
   *
   * The path is resolved and then checked for containment rather than filtered
   * as a string: a skill body is content, and content that can name a file is
   * a traversal vector like any other.
   */
  async readResource(name: string, resourcePath: string): Promise<{ path: string; content: string }> {
    const folder = await this.folderOf(name);
    const abs = resolve(folder, toPosix(resourcePath));

    if (!isContained(folder, abs)) {
      throw new Error(messages.skillResourceEscapes(resourcePath, name));
    }

    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) {
      throw new Error(messages.skillResourceMissing(resourcePath, name));
    }

    return {
      path: toPosix(relative(folder, abs)),
      content: await readFile(abs, "utf8"),
    };
  }

  /** Bundle-relative path of a skill's `SKILL.md`, for opening it in the editor. */
  async relPathOf(name: string): Promise<string> {
    const base = toPosix(relative(this.paths.root, this.paths.skillsRoot));
    const category = await this.categoryOf(name).catch(() => "");
    return [base, category, name, SKILL_FILE].filter(Boolean).join("/");
  }

  /** Where a *new* skill would be created, under an optional category. */
  newSkillPath(name: string, category = ""): string {
    const base = toPosix(relative(this.paths.root, this.paths.skillsRoot));
    return [base, toPosix(category), name, SKILL_FILE].filter(Boolean).join("/");
  }

  // ---- internals ----

  /**
   * Every skill, as `{ category, name }`.
   *
   * Two shapes are accepted: `skills/<category>/<name>/SKILL.md`, and the
   * older flat `skills/<name>/SKILL.md`. A directory is a category when it
   * has no SKILL.md of its own — which means adding a category to an existing
   * bundle is just making a folder and dragging skills into it.
   */
  private async folderNames(): Promise<Array<{ category: string; name: string }>> {
    const top = await readdir(this.paths.skillsRoot, { withFileTypes: true }).catch(() => []);
    const found: Array<{ category: string; name: string }> = [];

    for (const entry of top) {
      if (!entry.isDirectory() || HIDDEN_PREFIXES.some((p) => entry.name.startsWith(p))) continue;

      const dir = join(this.paths.skillsRoot, entry.name);
      if (await stat(join(dir, SKILL_FILE)).catch(() => null)) {
        found.push({ category: "", name: entry.name });
        continue;
      }

      for (const child of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!child.isDirectory() || HIDDEN_PREFIXES.some((p) => child.name.startsWith(p))) continue;
        if (await stat(join(dir, child.name, SKILL_FILE)).catch(() => null)) {
          found.push({ category: entry.name, name: child.name });
        }
      }
    }

    return found;
  }

  /** Categories currently in use, for grouping in the UI. */
  async categories(): Promise<string[]> {
    const names = await this.folderNames();
    return [...new Set(names.map((n) => n.category).filter(Boolean))].sort();
  }

  /**
   * Locate a skill's folder by name, whatever category it sits in.
   *
   * Names stay flat even though the folders are nested: an agent refers to a
   * skill by name, and making it also know the category would mean every
   * reference breaks when a skill is filed differently.
   */
  private async folderOf(name: string): Promise<string> {
    const clean = toPosix(name);
    // `name` arrives from agents and tool arguments, so it is untrusted even
    // though it looks like a bare identifier.
    if (clean.includes("/") || clean.includes("..")) {
      throw new Error(messages.skillUnknown(name));
    }

    for (const entry of await this.folderNames()) {
      if (entry.name !== clean) continue;
      const folder = entry.category
        ? resolve(this.paths.skillsRoot, entry.category, entry.name)
        : resolve(this.paths.skillsRoot, entry.name);
      if (!isContained(this.paths.skillsRoot, folder)) break;
      return folder;
    }

    throw new Error(messages.skillUnknown(name));
  }

  /** The category a skill is filed under, or "" when uncategorised. */
  private async categoryOf(name: string): Promise<string> {
    const entry = (await this.folderNames()).find((e) => e.name === name);
    return entry?.category ?? "";
  }

  private async load(name: string): Promise<CacheEntry> {
    const folder = await this.folderOf(name);
    const skillFile = join(folder, SKILL_FILE);

    const info = await stat(skillFile).catch(() => null);
    if (!info?.isFile()) throw new Error(messages.skillMissingFile(name));

    const cached = this.cache.get(name);
    if (cached && cached.mtimeMs === info.mtimeMs) return cached;

    const raw = await readFile(skillFile, "utf8");
    const entry: CacheEntry = {
      // The category comes from the folder, not the frontmatter: the tree is
      // where a person files things, so the tree is what decides.
      document: parseSkill(raw, name, await this.categoryOf(name)),
      resources: await this.resourcesOf(folder),
      mtimeMs: info.mtimeMs,
    };

    this.cache.set(name, entry);
    return entry;
  }

  /** List the text files beside `SKILL.md`, without reading any of them. */
  private async resourcesOf(folder: string, depth = 0): Promise<string[]> {
    if (depth >= MAX_RESOURCE_DEPTH) return [];

    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const found: string[] = [];

    for (const entry of entries) {
      if (HIDDEN_PREFIXES.some((p) => entry.name.startsWith(p))) continue;

      if (entry.isDirectory()) {
        const nested = await this.resourcesOf(join(folder, entry.name), depth + 1);
        found.push(...nested.map((child) => `${entry.name}/${child}`));
        continue;
      }
      if (entry.name === SKILL_FILE) continue;

      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) found.push(entry.name);
    }

    return found.sort();
  }
}
