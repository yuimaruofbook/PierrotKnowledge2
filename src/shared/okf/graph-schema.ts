/**
 * The knowledge-graph design layer: typed relations and the graph schema.
 *
 * A concept may declare typed relations in its frontmatter:
 *
 *     relations:
 *       depends_on: [topics/a, "[[b]]"]
 *       part_of: wiki/1-projects/p.md
 *
 * Each entry is a link that carries its kind, so it counts everywhere a body
 * link counts (backlinks, unresolved links, link depth) and labels the edge in
 * a canvas. `wiki/graph/schema.md` — a concept of type `GraphSchema` — says
 * which concept types and relation kinds the bundle intends to use; a bundle
 * with a schema gets *warnings* (never errors) for anything outside it, and a
 * bundle without one sees nothing new.
 *
 * The Rust port is `rust/src/shared/okf/graph_schema.rs`; both must give the
 * same links, the same schema JSON and the same warning text.
 *
 * Pure and DOM-free.
 */

import type { ConceptLink } from "../types";
import { resolveLinkTarget } from "./links";

/** `wiki/graph/` and what it holds. */
export const GRAPH_DIR = "graph";
export const GRAPH_TITLE = "Graph";
export const CANVASES_DIR = "graph/canvases";
export const CANVASES_TITLE = "Canvases";
/** Concept id (wiki-relative, no extension) of the schema. */
export const GRAPH_SCHEMA_ID = "graph/schema";
export const GRAPH_SCHEMA_FILE = "graph/schema.md";
export const GRAPH_SCHEMA_TYPE = "GraphSchema";

/** Relations read from one concept, and schema entries kept: bounds on hostile frontmatter. */
export const MAX_RELATION_ENTRIES = 500;
export const MAX_SCHEMA_ENTRIES = 200;
export const MAX_SCHEMA_ENDPOINTS = 50;

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Compare strings by code point, which is what Rust's `str::cmp` does.
 * Plain `<` compares UTF-16 units and disagrees for characters above U+FFFF,
 * and a layout that orders by path must order the same in both builds.
 */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

// ---- relations -------------------------------------------------------------------

export interface RelationRef {
  kind: string;
  /** Link target in the form `resolveLinkTarget` takes: no brackets, no wiki-dir prefix. */
  target: string;
}

/**
 * One relation entry as a link target: `[[x|label]]` and `x#heading` lose their
 * decoration, a bundle-relative `wiki/…` path loses its layer prefix. `null`
 * for an entry with nothing in it.
 */
export function normalizeRelationTarget(raw: string, wikiDir: string): string | null {
  let target = raw.trim();
  const wiki = /^\[\[([\s\S]*)\]\]$/.exec(target);
  if (wiki) target = wiki[1]!;
  target = target.split("|")[0]!.split("#")[0]!.trim().replace(/\\/g, "/");
  if (wikiDir && target.startsWith(`${wikiDir}/`)) target = target.slice(wikiDir.length + 1);
  return target === "" ? null : target;
}

export interface RelationRead {
  refs: RelationRef[];
  /** Things in the `relations` value that are not a kind with paths. */
  problems: string[];
}

/** What a concept's `relations` frontmatter says, in the order it says it. */
export function readRelations(frontmatter: Dict, wikiDir: string): RelationRead {
  const refs: RelationRef[] = [];
  const problems: string[] = [];
  const value = frontmatter.relations;
  if (value === undefined || value === null) return { refs, problems };
  if (!isDict(value)) {
    return { refs, problems: ["relations must be a mapping of kind to a list of paths"] };
  }

  const seen = new Set<string>();
  for (const [rawKind, entries] of Object.entries(value)) {
    const kind = rawKind.trim();
    if (!kind) {
      problems.push("a relation kind is empty");
      continue;
    }
    const list = typeof entries === "string" ? [entries] : Array.isArray(entries) ? entries : null;
    if (list === null) {
      problems.push(`relation '${kind}' must be a path, a wiki link or a list of them`);
      continue;
    }
    for (const entry of list) {
      if (typeof entry !== "string") {
        problems.push(`relation '${kind}' has an entry that is not a path`);
        continue;
      }
      const target = normalizeRelationTarget(entry, wikiDir);
      if (target === null) continue;
      const key = `${kind}\n${target}`;
      if (seen.has(key)) continue;
      if (refs.length >= MAX_RELATION_ENTRIES) {
        problems.push(`more than ${MAX_RELATION_ENTRIES} relations; the rest are ignored`);
        return { refs, problems };
      }
      seen.add(key);
      refs.push({ kind, target });
    }
  }
  return { refs, problems };
}

/** The relations as links, resolved against the concept ids like any other link. */
export function relationLinks(
  frontmatter: Dict,
  fromId: string,
  knownIds: ReadonlySet<string> | undefined,
  wikiDir: string
): ConceptLink[] {
  return readRelations(frontmatter, wikiDir).refs.map((ref) => ({
    target: ref.target,
    kind: "relation" as const,
    relation: ref.kind,
    resolved: resolveLinkTarget(ref.target, fromId, knownIds),
  }));
}

// ---- the schema ------------------------------------------------------------------

export interface SchemaType {
  name: string;
  description?: string;
}

export interface SchemaKind {
  name: string;
  description?: string;
  from?: string[];
  to?: string[];
}

export interface GraphSchema {
  /** `null` when the schema does not list types at all: then none is checked. */
  types: SchemaType[] | null;
  kinds: SchemaKind[] | null;
  problems: string[];
}

function endpoints(value: unknown, where: string, problems: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (list === null) {
    problems.push(`${where} must be a type name or a list of them`);
    return undefined;
  }
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) {
      problems.push(`${where} has an entry that is not a type name`);
      continue;
    }
    if (out.length >= MAX_SCHEMA_ENDPOINTS) {
      problems.push(`${where} lists more than ${MAX_SCHEMA_ENDPOINTS} types; the rest are ignored`);
      break;
    }
    if (!out.includes(item.trim())) out.push(item.trim());
  }
  return out;
}

/** Read the `types` and `kinds` a `GraphSchema` concept declares. */
export function parseGraphSchema(frontmatter: Dict): GraphSchema {
  const problems: string[] = [];

  const entries = (key: "types" | "kinds"): Array<{ name: string; item: Dict }> | null => {
    const value = frontmatter[key];
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) {
      problems.push(`${key} must be a list`);
      return null;
    }
    const out: Array<{ name: string; item: Dict }> = [];
    let overflow = false;
    value.forEach((item, i) => {
      const dict: Dict | null = typeof item === "string" ? { name: item } : isDict(item) ? item : null;
      const name = dict && typeof dict.name === "string" ? dict.name.trim() : "";
      if (!dict || !name) {
        problems.push(`${key}[${i}] needs a name`);
        return;
      }
      if (out.some((e) => e.name === name)) return;
      if (out.length >= MAX_SCHEMA_ENTRIES) {
        if (!overflow) problems.push(`${key} lists more than ${MAX_SCHEMA_ENTRIES} entries; the rest are ignored`);
        overflow = true;
        return;
      }
      out.push({ name, item: dict });
    });
    return out;
  };

  const describe = (item: Dict): { description?: string } =>
    typeof item.description === "string" && item.description.trim() ? { description: item.description.trim() } : {};

  const types = entries("types")?.map(({ name, item }): SchemaType => ({ name, ...describe(item) })) ?? null;
  const kinds =
    entries("kinds")?.map(({ name, item }): SchemaKind => {
      const from = endpoints(item.from, `kinds '${name}' from`, problems);
      const to = endpoints(item.to, `kinds '${name}' to`, problems);
      return { name, ...describe(item), ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }) ?? null;
  return { types, kinds, problems };
}

/** What the checks need of a concept. */
export interface SchemaSubject {
  id: string;
  relPath: string;
  frontmatter: Dict;
  links: ReadonlyArray<ConceptLink>;
}

const list = (names: readonly string[]) => `[${names.join(", ")}]`;

/**
 * Concept types and relation kinds the schema does not cover, per concept.
 *
 * Warnings, not errors: a schema describes intent, and a bundle that has
 * outgrown it should be told, not broken. Concepts come back ordered by path.
 */
export function schemaWarnings(
  schema: GraphSchema,
  subjects: readonly SchemaSubject[],
  wikiDir: string
): Array<{ path: string; warnings: string[] }> {
  const typeOf = new Map<string, string>();
  for (const s of subjects) typeOf.set(s.id, String(s.frontmatter.type ?? ""));
  const declaredTypes = schema.types ? new Set(schema.types.map((t) => t.name)) : null;
  const kindByName = new Map((schema.kinds ?? []).map((k) => [k.name, k] as const));

  const out: Array<{ path: string; warnings: string[] }> = [];
  for (const s of [...subjects].sort((a, b) => compareCodePoints(a.relPath, b.relPath))) {
    const warnings: string[] = [];
    const type = typeOf.get(s.id)!;
    if (declaredTypes && !declaredTypes.has(type)) {
      warnings.push(`type '${type}' is not declared in the graph schema`);
    }

    const read = readRelations(s.frontmatter, wikiDir);
    warnings.push(...(schema.kinds ? read.problems : []));
    const kinds = [...new Set(read.refs.map((r) => r.kind))];
    for (const kind of schema.kinds ? kinds : []) {
      const declared = kindByName.get(kind);
      if (!declared) {
        warnings.push(`relation kind '${kind}' is not declared in the graph schema`);
        continue;
      }
      if (declared.from && declared.from.length > 0 && !declared.from.includes(type)) {
        warnings.push(`relation '${kind}': source type '${type}' is not one of ${list(declared.from)}`);
      }
      if (declared.to && declared.to.length > 0) {
        for (const link of s.links) {
          if (link.kind !== "relation" || link.relation !== kind || link.resolved === null) continue;
          const targetType = typeOf.get(link.resolved) ?? "";
          if (!declared.to.includes(targetType)) {
            warnings.push(`relation '${kind}' -> ${link.resolved}: target type '${targetType}' is not one of ${list(declared.to)}`);
          }
        }
      }
    }
    if (warnings.length > 0) out.push({ path: s.relPath, warnings });
  }
  return out;
}
