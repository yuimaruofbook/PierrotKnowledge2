/**
 * Path resolution and the layer contract.
 *
 * Every path that reaches the filesystem goes through here. The MCP server
 * hands untrusted, agent-authored strings to the same read/write calls the UI
 * uses, so containment cannot be a caller responsibility: `resolve()` is the
 * only way to turn a relative path into an absolute one, and it refuses
 * anything that escapes the bundle.
 */

import { isAbsolute, relative, resolve, sep } from "path";
import { messages } from "../../shared/messages";
import { DAILY_DIR } from "../../shared/okf/daily";
import { HUMAN_FILE, MAP_FILE, TASK_FILE } from "../../shared/okf/workspace-files";
import type { Layer } from "../../shared/types";

export const RAW_DIR = "raw";
export const RAG_DIR = ".rag";
export const WIKI_DIR = "wiki";
export const SKILLS_DIR = "skills";
export const LOOPS_DIR = "loops";
export const AGENTS_FILE = "AGENTS.md";

/** Who is asking. The layer contract is a question of authority, not of path. */
export type Actor = "human" | "agent";

export class PathEscapeError extends Error {
  constructor(path: string) {
    super(messages.pathEscapesBundle(path));
    this.name = "PathEscapeError";
  }
}

export class LayerViolationError extends Error {
  constructor(path: string, reason: string) {
    super(messages.layerViolation(reason, path));
    this.name = "LayerViolationError";
  }
}

/**
 * Whether two paths differing only in case name the same file.
 *
 * macOS counts, not just Windows: APFS and HFS+ are case-insensitive by
 * default, so `raw/note.md` and `RAW/note.md` are one file there. Treating
 * them as two is not a cosmetic bug — `isContained` is what `assertWritable`
 * uses to keep agents out of `raw/`, and a case-sensitive comparison on a
 * case-insensitive filesystem means `RAW/x.md` passes the check and then
 * lands in `raw/` anyway.
 *
 * A macOS volume *can* be formatted case-sensitively. Assuming it is not is
 * the safe direction here: it only ever makes containment match more paths,
 * which blocks more writes rather than fewer.
 */
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function comparable(path: string): string {
  return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

/** Normalise any bundle-relative path to `/`-separated with no leading slash. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** True when `child` is `parent` itself or lives beneath it. */
export function isContained(parent: string, child: string): boolean {
  const p = comparable(resolve(parent));
  const c = comparable(resolve(child));
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export class BundlePaths {
  /** Absolute, normalised bundle root. */
  readonly root: string;
  /**
   * Bundle-relative wiki directory: `"wiki"` for a full LLM-Wiki layout, or
   * `""` when an arbitrary Markdown folder was opened directly.
   */
  readonly wikiDir: string;

  constructor(root: string, wikiDir: string) {
    this.root = resolve(root);
    this.wikiDir = toPosix(wikiDir);
  }

  /** Absolute path of the wiki layer (Layer 2). */
  get wikiRoot(): string {
    return this.wikiDir ? resolve(this.root, this.wikiDir) : this.root;
  }

  /** Absolute path of the immutable source layer (Layer 1). */
  get rawRoot(): string {
    return resolve(this.root, RAW_DIR);
  }

  /** Absolute path of the derived index layer (Layer 3). */
  get ragRoot(): string {
    return resolve(this.root, RAG_DIR);
  }

  /**
   * SkillSpace, inside the wiki layer.
   *
   * Skills are curated content about the wiki, so they belong to layer 2 — not
   * to a layer of their own. They are excluded from the *concept* scan though
   * (see `isSubsystemPath`): a procedure is not a fact, and mixing the two
   * would put instructions in the same search results as knowledge.
   */
  get skillsRoot(): string {
    return resolve(this.wikiRoot, SKILLS_DIR);
  }

/** Loop designs and their history, inside the wiki layer. */
  get loopsRoot(): string {
    return resolve(this.wikiRoot, LOOPS_DIR);
  }

  /**
   * Daily notes, inside the wiki layer and deliberately *not* a subsystem.
   *
   * Unlike `skills/` and `loops/` these are indexed as ordinary concepts:
   * "what did I decide last Tuesday" is a real question, and it can only be
   * answered if the days are in the search index like everything else.
   */
  get dailyRoot(): string {
    return resolve(this.wikiRoot, DAILY_DIR);
  }

  /**
   * Files inside the wiki layer that are not concepts.
   *
   * `skills/` and `loops/` are wiki content but not knowledge, so they are
   * skipped by the concept scan, the search index and conformance checking.
   */
  isSubsystemPath(relPath: string): boolean {
    const abs = resolve(this.root, toPosix(relPath));
    return isContained(this.skillsRoot, abs) || isContained(this.loopsRoot, abs);
  }

  /**
   * The agent contract, inside the wiki layer.
   *
   * It describes what the wiki is and how to work on it, so it belongs to the
   * curated layer rather than floating above the three.
   */
  get agentsMdPath(): string {
    return resolve(this.wikiRoot, AGENTS_FILE);
  }

  /**
   * Where older bundles kept it.
   *
   * Read-only fallback: a bundle written before the layout was corrected still
   * has `AGENTS.md` at the root, and refusing to read it would silently strip
   * an agent of its instructions.
   */
  get legacyAgentsMdPath(): string {
    return resolve(this.root, AGENTS_FILE);
  }

  /**
   * The orientation files, at the bundle root beside the three layers.
   *
   * Deliberately outside them. `raw/`, `wiki/` and `.rag/` are three stages of
   * the same material — sources, curated knowledge, derived index — and these
   * three are not that material at all: `MAP.md` describes where things live,
   * `human.md` is about the person, `Task.md` is about the work in flight.
   * None of them is knowledge, none is derived from knowledge, and filing them
   * inside a layer made the layer mean two different things at once.
   *
   * `AGENTS.md` stays in `wiki/`: it is the contract for editing that layer,
   * so it genuinely is content *about* the wiki.
   */
  get mapMdPath(): string {
    return resolve(this.root, MAP_FILE);
  }

  /** What the agent should know about the person it works for. */
  get humanMdPath(): string {
    return resolve(this.root, HUMAN_FILE);
  }

  /** Open and recently finished work. */
  get taskMdPath(): string {
    return resolve(this.root, TASK_FILE);
  }

  /**
   * Where these three lived before they were lifted out of `wiki/`.
   *
   * Read-only fallbacks, and the source for the migration on open.
   */
  get legacyOrientationPaths(): Array<{ from: string; to: string; name: string }> {
    return [MAP_FILE, HUMAN_FILE, TASK_FILE].map((name) => ({
      from: resolve(this.wikiRoot, name),
      to: resolve(this.root, name),
      name,
    }));
  }

  get indexMdPath(): string {
    return resolve(this.wikiRoot, "index.md");
  }

  get logMdPath(): string {
    return resolve(this.wikiRoot, "log.md");
  }

  /**
   * Resolve a bundle-relative path to an absolute one.
   *
   * Rejects absolute inputs, NUL bytes and anything that normalises outside
   * the root — `../`, `..\`, symlink-free traversal and Windows drive-relative
   * forms all collapse to the same check.
   */
  resolve(relPath: string): string {
    if (relPath.includes("\0")) throw new PathEscapeError(relPath);
    const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (isAbsolute(relPath) || /^[a-z]:/i.test(relPath)) {
      // Accept an absolute path only when it already points inside the bundle.
      const abs = resolve(relPath);
      if (!isContained(this.root, abs)) throw new PathEscapeError(relPath);
      return abs;
    }
    const abs = resolve(this.root, cleaned);
    if (!isContained(this.root, abs)) throw new PathEscapeError(relPath);
    return abs;
  }

  /** Convert an absolute path back to a `/`-separated bundle-relative one. */
  toRel(absPath: string): string {
    return toPosix(relative(this.root, resolve(absPath)));
  }

  /** Path relative to the wiki root — this is what concept ids are built from. */
  toWikiRel(absPath: string): string {
    return toPosix(relative(this.wikiRoot, resolve(absPath)));
  }

  /** Bundle-relative path of a concept id. */
  relPathOfId(id: string): string {
    const rel = `${toPosix(id)}.md`;
    return this.wikiDir ? `${this.wikiDir}/${rel}` : rel;
  }

  /** Which layer a bundle-relative path belongs to, if any. */
  layerOf(relPath: string): Layer | undefined {
    const abs = resolve(this.root, toPosix(relPath));
    if (isContained(this.rawRoot, abs)) return "raw";
    if (isContained(this.ragRoot, abs)) return "rag";
    // skills/ and loops/ fall through to "wiki" on purpose: they are inside it.
    if (isContained(this.wikiRoot, abs)) return "wiki";
    return undefined;
  }

  /**
   * Enforce the layer contract for writes.
   *
   * The rule is about *who*, not about which layer is precious:
   *
   *   - **`raw/` is the human's inbox.** People drop originals in — by hand,
   *     or through an import from Notion or Drive that they triggered. Agents
   *     cannot write there: `raw/` is the record of what was actually
   *     received, and material an agent produced was not received from anywhere.
   *   - **`wiki/` and `.rag/` are open to both.** Curated knowledge and the
   *     derived index are worked on from either side.
   */
  assertWritable(relPath: string, by: Actor = "human"): string {
    const abs = this.resolve(relPath);
    const layer = this.layerOf(this.toRel(abs));
    if (layer === "raw" && by !== "human") {
      throw new LayerViolationError(relPath, messages.rawIsHumanOnly);
    }
    return abs;
  }

  /**
   * Whether this actor may move a file between these layers.
   *
   * Same rule as `assertWritable`, applied to both ends: `raw/` belongs to the
   * human in either direction, and `wiki/` and `.rag/` are open to both.
   * Moving *out of* `raw/` is the moment somebody takes responsibility for
   * unreviewed material, which is not a call an agent can make.
   */
  assertMovable(from: string, to: string, by: Actor): void {
    if (by === "human") return;

    if (this.layerOf(toPosix(from)) === "raw") {
      throw new LayerViolationError(from, messages.rawPromotionIsHumanOnly);
    }
    if (this.layerOf(toPosix(to)) === "raw") {
      throw new LayerViolationError(to, messages.rawIsHumanOnly);
    }
  }
}
