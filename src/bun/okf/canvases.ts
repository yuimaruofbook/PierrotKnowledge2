/**
 * `.canvas` files on disk: finding them, reading them, and resolving what a
 * file node points at. The spec, the outline and the layout are in
 * `shared/okf/canvas*.ts`.
 */

import { stat } from "fs/promises";
import type { Bundle } from "./bundle";
import {
  CANVAS_EXT,
  MAX_CANVAS_BYTES,
  compareCodePoints,
  conceptTitle,
  isCanvasPath,
  parseCanvas,
  resolveLinkTarget,
  type Canvas,
  type ResolvedFile,
} from "../../shared/okf";

/** Bundle-relative paths of every `.canvas` file in the wiki layer, in code point order. */
export async function listCanvasPaths(bundle: Bundle): Promise<string[]> {
  const found: string[] = [];
  const walk = (nodes: Awaited<ReturnType<Bundle["listDir"]>>): void => {
    for (const node of nodes) {
      if (node.type === "dir") walk(node.children ?? []);
      else if (node.name.toLowerCase().endsWith(CANVAS_EXT)) found.push(node.path);
    }
  };
  walk(await bundle.listDir(bundle.paths.wikiDir, true));
  return found.sort(compareCodePoints);
}

export type CanvasFile =
  | { ok: true; text: string; value: Canvas }
  | { ok: false; errors: string[] };

/**
 * Read and check one `.canvas` file. A missing file throws; an invalid one is
 * a value. A file over the size limit is refused before it is read.
 */
export async function readCanvasFile(bundle: Bundle, path: string): Promise<CanvasFile> {
  if (!isCanvasPath(path)) throw new Error("'path' must end in .canvas");
  const abs = bundle.paths.resolve(path); // a path outside the bundle fails here, with the usual message
  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    throw new Error(`${path} not found`);
  }
  if (size > MAX_CANVAS_BYTES) return { ok: false, errors: [`the canvas is larger than ${MAX_CANVAS_BYTES} bytes`] };

  let text: string;
  try {
    const file = await bundle.readFile(path);
    if (file.binary) throw new Error("binary");
    text = file.content;
  } catch {
    throw new Error(`${path} not found`);
  }
  const parsed = parseCanvas(text);
  return parsed.ok ? { ok: true, text, value: parsed.value } : { ok: false, errors: parsed.errors };
}

/**
 * What a file node's `file` names, when it is a concept.
 *
 * Canvas paths are relative to the bundle root, as every path here is, so the
 * wiki folder prefix is dropped; a path already relative to the wiki layer
 * works too.
 */
export function canvasFileResolver(bundle: Bundle): (file: string) => ResolvedFile | null {
  const wikiDir = bundle.paths.wikiDir;
  return (file) => {
    const path = file.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!/\.md$/i.test(path)) return null;
    const candidates = wikiDir && path.startsWith(`${wikiDir}/`) ? [path.slice(wikiDir.length + 1), path] : [path];
    for (const candidate of candidates) {
      const doc = bundle.getConcept(candidate.replace(/\.md$/i, ""));
      if (!doc) continue;
      const description = doc.frontmatter.description;
      return {
        title: conceptTitle(doc.id, doc.frontmatter),
        ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}),
      };
    }
    return null;
  };
}

/** A concept id for what the caller typed: an id, a bundle-relative path, or a bare name. */
export function resolveRootConcept(bundle: Bundle, raw: string): string | null {
  const text = raw.trim().replace(/\\/g, "/");
  if (!text) return null;
  const wikiDir = bundle.paths.wikiDir;
  const stripped = wikiDir && text.startsWith(`${wikiDir}/`) ? text.slice(wikiDir.length + 1) : text;
  for (const candidate of [stripped, text]) {
    const id = candidate.replace(/\.md$/i, "");
    if (bundle.getConcept(id)) return id;
  }
  return resolveLinkTarget(text, "", bundle.conceptIds());
}
