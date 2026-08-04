/**
 * Move a bundle written with the old layout into the corrected one.
 *
 * An earlier version put `AGENTS.md`, `skills/` and `loops/` at the bundle
 * root, as siblings of `raw/`, `wiki/` and `.rag/`. That turned the LLM Wiki
 * pattern's three layers into five and lost the meaning of the split: all three
 * are curated content *about* the wiki, so they belong inside it.
 *
 * ```
 *   before                     after
 *   bundle/                    bundle/
 *   ├── AGENTS.md              ├── raw/
 *   ├── skills/                ├── wiki/
 *   ├── loops/                 │   ├── AGENTS.md
 *   ├── raw/                   │   ├── skills/
 *   ├── wiki/                  │   └── loops/
 *   └── .rag/                  └── .rag/
 * ```
 *
 * Runs on open, and does nothing when there is nothing to move. Never
 * overwrites: if a destination already exists the source is left alone and
 * reported, because a half-migrated bundle that silently lost a skill would be
 * worse than one that needs a manual decision.
 */

import { readdir, rename, stat } from "fs/promises";
import { join } from "path";
import { AGENTS_FILE, LOOPS_DIR, SKILLS_DIR, type BundlePaths } from "./paths";

export interface MigrationResult {
  /** Bundle-relative paths that were moved, as `from -> to`. */
  moved: string[];
  /** Sources left in place because the destination already existed. */
  skipped: string[];
}

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => null));
}

/**
 * Relocate one entry, refusing to clobber.
 *
 * A directory that exists at both ends is merged entry by entry rather than
 * replaced wholesale — a user who created one new skill under the corrected
 * layout should not lose the twenty that were still under the old one.
 */
async function relocate(
  from: string,
  to: string,
  label: string,
  result: MigrationResult
): Promise<void> {
  if (!(await exists(from))) return;

  if (!(await exists(to))) {
    await rename(from, to);
    result.moved.push(label);
    return;
  }

  const fromInfo = await stat(from);
  if (!fromInfo.isDirectory()) {
    result.skipped.push(label);
    return;
  }

  let merged = 0;
  for (const entry of await readdir(from)) {
    const childFrom = join(from, entry);
    const childTo = join(to, entry);
    if (await exists(childTo)) {
      result.skipped.push(`${label}/${entry}`);
      continue;
    }
    await rename(childFrom, childTo);
    merged++;
  }
  if (merged > 0) result.moved.push(`${label} (${merged} 件)`);
}

/**
 * Migrate a bundle in place.
 *
 * Only acts when the bundle actually has a `wiki/` directory: a folder opened
 * directly as the wiki layer has nowhere to move things *to*, and its
 * `skills/` already resolves to the right place.
 */
export async function migrateLayout(paths: BundlePaths): Promise<MigrationResult> {
  const result: MigrationResult = { moved: [], skipped: [] };

  // With no wiki subdirectory the roots already coincide; moving would be a
  // no-op at best and a rename onto itself at worst.
  if (!paths.wikiDir) return result;
  if (!(await exists(paths.wikiRoot))) return result;

  await relocate(
    join(paths.root, AGENTS_FILE),
    paths.agentsMdPath,
    AGENTS_FILE,
    result
  );
  await relocate(join(paths.root, SKILLS_DIR), paths.skillsRoot, `${SKILLS_DIR}/`, result);
  await relocate(join(paths.root, LOOPS_DIR), paths.loopsRoot, `${LOOPS_DIR}/`, result);

  // The opposite direction: MAP.md, human.md and Task.md were briefly inside
  // wiki/ and now sit beside the layers. They are not knowledge, so they were
  // never part of the material the three layers describe.
  for (const { from, to, name } of paths.legacyOrientationPaths) {
    await relocate(from, to, name, result);
  }

  return result;
}
