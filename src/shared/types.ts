/**
 * Pure data types shared by the Bun main process and the webview.
 *
 * This module must stay dependency-free and side-effect-free: it is imported
 * by both bundles, and anything heavy here is paid for twice.
 */

import type { ParaClass } from "./okf/para";

export type { ParaClass };

/** OKF v0.2 concept type. Free-form string; only "non-empty" is enforced. */
export type ConceptType = string;

/** Actor convention (OKF §7): `human:<name>`, `process:<name>`, `<producer>/<version>`. */
export type Actor = string;

/** Source credibility signal (OKF §5.1). */
export interface SourceEntry {
  id?: string;
  resource: string;
  title?: string;
  author?: Actor;
  usage_count?: number;
  /** YYYY-MM-DD */
  last_modified?: string;
}

export interface UsageWindow {
  from: string;
  to: string;
}

/** `generated` field (OKF §5.2). */
export interface Generated {
  by: Actor;
  /** ISO 8601 */
  at: string;
}

/** `verified` entry (OKF §5.2). */
export interface VerifiedEntry {
  by: Actor;
  /** ISO 8601 */
  at: string;
}

/** Lifecycle (OKF §5.4–5.5). */
export type Status = "draft" | "stable" | "deprecated";

/** Trust tier derived from `verified` (OKF §5.3). */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/**
 * Concept frontmatter. `type` is the only required key (OKF §4.1 / §11);
 * every other key is optional and preserved verbatim on round-trip.
 */
export interface ConceptFrontmatter {
  type: ConceptType;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  sources?: SourceEntry[];
  usage_window?: UsageWindow;
  generated?: Generated;
  verified?: VerifiedEntry | VerifiedEntry[];
  status?: Status;
  /** ISO 8601 timestamp after which the concept is considered stale. */
  stale_after?: string;
  [key: string]: unknown;
}

/** A link found in a concept body. */
export interface ConceptLink {
  /** Raw target as written in the source. */
  target: string;
  /** Display text, when the syntax carries one. */
  label?: string;
  kind: "wikilink" | "markdown";
  /** Resolved concept id, or null when the target is external/unresolvable. */
  resolved: string | null;
}

export interface ConceptDocument {
  /** Concept id = wiki-relative path without the `.md` suffix (OKF §2). */
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the bundle root, always `/`-separated. */
  relPath: string;
  frontmatter: ConceptFrontmatter;
  /** Body with frontmatter removed. */
  body: string;
  /** Outbound links parsed from the body. */
  links: ConceptLink[];
  /** File mtime in milliseconds, used for incremental indexing. */
  mtimeMs: number;
}

/** LLM Wiki layers. */
/**
 * The three layers of the LLM Wiki pattern.
 *
 * `skills/`, `loops/` and `AGENTS.md` are *not* layers — they live inside the
 * wiki layer, because they are curated, human- and agent-authored content
 * about the wiki. Making them siblings of raw/wiki/rag would turn a
 * three-layer model into a five-layer one and lose the meaning of the split.
 */
export type Layer = "raw" | "wiki" | "rag";

export interface BundleInfo {
  /** Absolute bundle root. */
  root: string;
  /**
   * Bundle-relative path of the wiki layer. `"wiki"` when a `wiki/` directory
   * exists, otherwise `""` — which lets a plain folder of Markdown be opened
   * as a bundle without restructuring it.
   */
  wikiDir: string;
  hasAgentsMd: boolean;
  hasIndex: boolean;
  hasLog: boolean;
  hasRaw: boolean;
  conceptCount: number;
  /** Concepts failing OKF §11 conformance. */
  nonConformantCount: number;
  /**
   * Things that went wrong while opening, none of which prevented it.
   *
   * Creating `index.md` and `log.md` is a convenience, so a folder that will
   * not accept them still opens — the notes in it are readable either way.
   * Empty on a healthy bundle.
   */
  warnings: string[];
}

export interface SearchHit {
  id: string;
  /** Bundle-relative path. */
  path: string;
  title: string;
  /** Plain-text excerpt around the match; the view escapes and highlights it. */
  snippet: string;
  /** Higher is better. */
  score: number;
  type: string;
  /** Heading trail of the best-matching section. */
  headingPath: string[];
  /** PARA class, derived from the path. Drives ranking and the UI badge. */
  para: ParaClass;
}

/** A single retrievable section of a document. */
export interface ChunkHit extends SearchHit {
  /** `<docId>#<ord>` */
  chunkId: string;
  /** Full chunk text, for retrieval rather than display. */
  text: string;
}

export interface SearchFilters {
  /** Restrict to one OKF `type`. */
  type?: string;
  /** Require every listed tag. */
  tags?: string[];
  /** Restrict to a bundle-relative path prefix. */
  pathPrefix?: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

/** One passage in an assembled retrieval context. */
export interface RetrievedPassage {
  /** Citation anchor, e.g. `topics/note.md#setup`. */
  anchor: string;
  id: string;
  path: string;
  title: string;
  type: string;
  headingPath: string[];
  text: string;
  score: number;
}

export interface RetrievalResult {
  query: string;
  passages: RetrievedPassage[];
  /** Characters of passage text returned. */
  usedChars: number;
  /** True when the budget cut the result short. */
  truncated: boolean;
}

export interface FileNode {
  name: string;
  /** Bundle-relative, `/`-separated. */
  path: string;
  type: "file" | "dir";
  /** Layer this node belongs to, when it sits inside one. */
  layer?: Layer;
  children?: FileNode[];
}

/** Conformance report for a single concept (OKF §11). */
export interface ConformanceIssue {
  path: string;
  errors: string[];
}

export interface ReadFileResult {
  /** Empty when the file is binary — there is nothing safe to show. */
  content: string;
  /** True when the file is not text and must not be rendered. */
  binary?: boolean;
  /** Recognised file type, e.g. "SQLite データベース". */
  fileType?: string;
  /** Size on disk, so the UI can say something useful about a binary file. */
  byteLength?: number;
  /** Present only for concept documents (i.e. not reserved files). */
  concept?: ConceptDocument;
  /** Concept ids linking *to* this document. */
  backlinks: string[];
  mtimeMs: number;
}

export interface WriteFileResult {
  ok: true;
  mtimeMs: number;
  /** Conformance errors, if the written file is a non-conformant concept. */
  warnings: string[];
}

export interface LogEntry {
  /** ISO 8601 */
  at: string;
  actor: Actor;
  action: string;
  path: string;
  note?: string;
}
