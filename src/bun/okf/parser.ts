/**
 * Concept (de)serialisation. Owns the only YAML dependency in the app.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ConceptDocument, ConceptFrontmatter } from "../../shared/types";
import {
  DEFAULT_CONCEPT_TYPE,
  conceptIdFromRelPath,
  extractLinks,
  joinFrontmatter,
  splitFrontmatter,
} from "../../shared/okf";

/** Frontmatter keys emitted first, so hand-editing stays pleasant. */
const KEY_ORDER = ["type", "title", "description", "tags", "status"];

export interface ParseConceptOptions {
  /** Concept id, i.e. wiki-relative path without `.md`. */
  id: string;
  /** Bundle-relative path. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  raw: string;
  mtimeMs?: number;
  /** Ids used to resolve `[[wikilinks]]`; omit during a first pass. */
  knownIds?: ReadonlySet<string>;
}

/**
 * Parse frontmatter into a `ConceptFrontmatter`.
 *
 * A YAML document can legally be a scalar, a list or null, none of which is a
 * mapping — those are treated as "no usable frontmatter" rather than crashing
 * on property access. `type` is normalised *after* the spread, otherwise a
 * missing or non-string `type` in the file would overwrite the default.
 */
export function parseFrontmatter(yaml: string | null): ConceptFrontmatter {
  if (yaml === null || !yaml.trim()) return { type: DEFAULT_CONCEPT_TYPE };

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    return { type: DEFAULT_CONCEPT_TYPE };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { type: DEFAULT_CONCEPT_TYPE };
  }

  const record = parsed as Record<string, unknown>;
  const rawType = record.type;
  const type =
    typeof rawType === "string" && rawType.trim() ? rawType.trim() : DEFAULT_CONCEPT_TYPE;

  return { ...record, type };
}

export function parseConcept(opts: ParseConceptOptions): ConceptDocument {
  const { yaml, body } = splitFrontmatter(opts.raw);
  const frontmatter = parseFrontmatter(yaml);
  const id = opts.id || conceptIdFromRelPath(opts.relPath);
  const trimmedBody = body.replace(/^[\r\n]+/, "");

  return {
    id,
    path: opts.absPath,
    relPath: opts.relPath,
    frontmatter,
    body: trimmedBody,
    links: extractLinks(trimmedBody, id, opts.knownIds),
    mtimeMs: opts.mtimeMs ?? 0,
  };
}

/** Serialise frontmatter + body back to a file, with a stable key order. */
export function serializeConcept(frontmatter: ConceptFrontmatter, body: string): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (frontmatter[key] !== undefined) ordered[key] = frontmatter[key];
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }
  const yaml = stringifyYaml(ordered, { lineWidth: 0 }).replace(/\s*$/, "");
  return joinFrontmatter(yaml, body);
}

export interface ConceptSkeletonOptions {
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  body?: string;
  generatedBy?: string;
  now?: Date;
}

/** Build a minimal OKF-conformant concept file. */
export function skeletonConcept(opts: ConceptSkeletonOptions): string {
  const frontmatter: ConceptFrontmatter = {
    type: opts.type.trim() || DEFAULT_CONCEPT_TYPE,
  };
  if (opts.title) frontmatter.title = opts.title;
  if (opts.description) frontmatter.description = opts.description;
  if (opts.tags?.length) frontmatter.tags = opts.tags;
  if (opts.generatedBy) {
    frontmatter.generated = {
      by: opts.generatedBy,
      at: (opts.now ?? new Date()).toISOString(),
    };
  }
  frontmatter.status = "draft";

  const heading = opts.title ? `# ${opts.title}\n\n` : "";
  return serializeConcept(frontmatter, `${heading}${opts.body ?? ""}`.replace(/\s*$/, "") + "\n");
}
