/**
 * `.base` files on disk: finding them, reading them, and turning the open
 * bundle's concepts into rows for the engine in `shared/okf/base.ts`.
 */

import type { ConceptDocument } from "../../shared/types";
import { BASE_EXT, isBasePath, type BaseRow } from "../../shared/okf/base";
import type { Bundle } from "./bundle";
import { parseBaseYaml } from "./parser";

/** What the engine sees of a concept. */
export function baseRowOf(doc: ConceptDocument): BaseRow {
  return {
    path: doc.relPath,
    wikiPath: `${doc.id}.md`,
    id: doc.id,
    mtimeMs: doc.mtimeMs,
    frontmatter: doc.frontmatter as Record<string, unknown>,
    links: doc.links.map((l) => ({ target: l.target, resolved: l.resolved })),
  };
}

/** Bundle-relative paths of every `.base` file in the wiki layer, sorted. */
export async function listBasePaths(bundle: Bundle): Promise<string[]> {
  const found: string[] = [];
  const walk = (nodes: Awaited<ReturnType<Bundle["listDir"]>>): void => {
    for (const node of nodes) {
      if (node.type === "dir") walk(node.children ?? []);
      else if (node.name.toLowerCase().endsWith(BASE_EXT)) found.push(node.path);
    }
  };
  walk(await bundle.listDir(bundle.paths.wikiDir, true));
  return found.sort((a, b) => a.localeCompare(b));
}

export type BaseFile =
  | { ok: true; text: string; value: unknown }
  | { ok: false; text: string; error: string };

/** Read and parse one `.base` file. A missing file throws; bad YAML is a value. */
export async function readBaseFile(bundle: Bundle, path: string): Promise<BaseFile> {
  if (!isBasePath(path)) throw new Error("'path' must end in .base");
  bundle.paths.resolve(path); // a path outside the bundle fails here, with the usual message
  let text: string;
  try {
    const file = await bundle.readFile(path);
    if (file.binary) throw new Error("binary");
    text = file.content;
  } catch {
    throw new Error(`${path} not found`);
  }
  const parsed = parseBaseYaml(text);
  return parsed.ok
    ? { ok: true, text, value: parsed.value }
    : { ok: false, text, error: "the content is not valid YAML" };
}
