/**
 * PARA: Projects, Areas, Resources, Archive.
 *
 * Tiago Forte's method, used here as the organising axis of the wiki layer.
 * The four classes are an explicit *priority order*, not just four boxes:
 *
 *   1. **Project**  — in progress, has an end. What you are doing now.
 *   2. **Area**     — no deadline, but you have chosen to care about it.
 *   3. **Resource** — useful knowledge, consulted when relevant.
 *   4. **Archive**  — not in use. Kept for the record, not for retrieval.
 *
 * The class is the *folder*, so archiving is a move a person can see and undo,
 * and the priority is visible in the tree without opening anything. Ranking
 * uses the same order: a passage from an active project outranks the same
 * passage from something shelved a year ago.
 *
 * Pure and DOM-free.
 */

export type ParaClass = "project" | "area" | "resource" | "archive";

/** Directory names, numbered so the tree sorts by priority on its own. */
export const PARA_DIRS: Record<ParaClass, string> = {
  project: "1-projects",
  area: "2-areas",
  resource: "3-resources",
  archive: "4-archive",
};

/** Highest priority first. The order is the point of the method. */
export const PARA_ORDER: readonly ParaClass[] = ["project", "area", "resource", "archive"];

export const PARA_LABELS: Record<ParaClass, string> = {
  project: "プロジェクト",
  area: "エリア",
  resource: "リソース",
  archive: "アーカイブ",
};

export const PARA_DESCRIPTIONS: Record<ParaClass, string> = {
  project: "現在進行中で、終わりのあるもの",
  area: "期日はないが、優先したい関心ごと",
  resource: "役に立つ知識。必要なときに参照する",
  archive: "現在使っていないもの。記録として残す",
};

/**
 * Retrieval weight per class.
 *
 * Multiplied into the BM25 score, so relevance still decides *what* matches
 * and PARA decides which of two comparable matches surfaces first. Archive is
 * heavily penalised rather than excluded: material that is genuinely the only
 * answer should still be findable, just never preferred.
 */
export const PARA_WEIGHTS: Record<ParaClass, number> = {
  project: 1.5,
  area: 1.2,
  resource: 1.0,
  archive: 0.25,
};

/** Anything not filed anywhere is a Resource — the neutral, useful default. */
export const DEFAULT_PARA: ParaClass = "resource";

const DIR_TO_CLASS = new Map<string, ParaClass>(
  (Object.entries(PARA_DIRS) as Array<[ParaClass, string]>).map(([cls, dir]) => [dir, cls])
);

/**
 * Which PARA class a wiki-relative path falls in.
 *
 * Only the first segment counts: `1-projects/q3/notes.md` is a Project, and a
 * folder called `1-projects` nested deeper is just a folder. Keeping it to the
 * top level means the class of a note is always visible from its path.
 */
export function paraOf(wikiRelPath: string): ParaClass {
  const first = wikiRelPath.replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0] ?? "";
  return DIR_TO_CLASS.get(first.toLowerCase()) ?? DEFAULT_PARA;
}

/** True when the path is filed in one of the four folders. */
export function isFiled(wikiRelPath: string): boolean {
  const first = wikiRelPath.replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0] ?? "";
  return DIR_TO_CLASS.has(first.toLowerCase());
}

export function isArchived(wikiRelPath: string): boolean {
  return paraOf(wikiRelPath) === "archive";
}

/** Parse a user- or agent-supplied class name, tolerantly. */
export function parseParaClass(value: string): ParaClass | null {
  const key = value.trim().toLowerCase();
  if ((PARA_ORDER as readonly string[]).includes(key)) return key as ParaClass;

  // Accept the folder name and the bare number too — an agent that read the
  // tree will have seen `1-projects`, not `project`.
  const byDir = DIR_TO_CLASS.get(key);
  if (byDir) return byDir;

  const numbered: Record<string, ParaClass> = { "1": "project", "2": "area", "3": "resource", "4": "archive" };
  return numbered[key] ?? null;
}

/**
 * Where a note would live under a different class, keeping its sub-path.
 *
 * `1-projects/q3/notes.md` → archive → `4-archive/q3/notes.md`. An unfiled note
 * keeps its whole path and simply gains a prefix, so filing something for the
 * first time does not flatten the structure someone already built.
 */
export function reclassify(wikiRelPath: string, to: ParaClass): string {
  const clean = wikiRelPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = clean.split("/");
  const rest = isFiled(clean) ? segments.slice(1) : segments;
  return [PARA_DIRS[to], ...rest].join("/");
}

/** Sort comparator: priority order, then path. */
export function byParaPriority(a: string, b: string): number {
  const rank = (p: string) => PARA_ORDER.indexOf(paraOf(p));
  return rank(a) - rank(b) || a.localeCompare(b);
}
