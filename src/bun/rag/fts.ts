/**
 * Layer 3: the retrieval index.
 *
 * Chunks, not documents, are the unit: a section carries its heading path, so a
 * hit is precise enough to cite and small enough to put in a context window.
 * Indexed text is bigram-normalised (see `shared/okf/text.ts`) so Japanese is
 * actually searchable; the original text is kept alongside for snippets and
 * retrieval, because the indexed form is unreadable by design.
 *
 * The whole thing rebuilds from Layer 2 — delete `.rag/` and nothing is lost.
 */

import { Database, type Statement } from "bun:sqlite";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import { messages } from "../../shared/messages";
import { PARA_WEIGHTS, paraOf } from "../../shared/okf/para";
import type {
  ChunkHit,
  ConceptDocument,
  SearchFilters,
  SearchHit,
  TagCount,
} from "../../shared/types";
import {
  buildMatchQuery,
  chunkBody,
  chunkId,
  conceptTitle,
  findHighlights,
  makeSnippet,
  parseQueryTerms,
  normalizeForIndex,
  type QueryMode,
} from "../../shared/okf";

/** Bumped when the schema or the normalisation changes; forces a rebuild. */
const SCHEMA_VERSION = "5";

/**
 * Tags are stored as one delimited string so a document stays a single row.
 * The delimiter wraps both ends, so a LIKE on the wrapped tag matches a whole
 * tag and never a prefix of a longer one. A newline cannot occur in a tag.
 */
const TAG_SEP = "\n";

function packTags(tags: readonly string[]): string {
  return tags.length ? TAG_SEP + tags.join(TAG_SEP) + TAG_SEP : "";
}

function unpackTags(packed: string): string[] {
  return packed.split(TAG_SEP).filter(Boolean);
}

/**
 * Choose what a snippet should be built from.
 *
 * A hit can come from the title or the heading rather than the prose — in
 * which case a snippet of the body alone shows unrelated text with nothing
 * highlighted, which reads like a wrong result. Falling back to the heading
 * makes it obvious *why* the row matched.
 */
function snippetSource(row: ChunkRow, query: string): string {
  const terms = parseQueryTerms(query);
  if (row.text && findHighlights(row.text, terms).length > 0) return row.text;

  const heading = row.heading_path || row.title;
  return row.text ? `${heading} — ${row.text}` : heading;
}

interface ChunkRow {
  chunk_id: string;
  doc_id: string;
  ord: number;
  heading_path: string;
  text: string;
  score: number;
  path: string;
  title: string;
  type: string;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  /** Return one hit per document (best chunk) instead of every chunk. */
  groupByDocument?: boolean;
  /**
   * Strict phrase matching (default) or recall-oriented loose matching.
   * Retrieval uses `loose`; the search box uses `phrase`.
   */
  mode?: QueryMode;
}

export class FtsIndex {
  private db: Database | null = null;
  private statements = new Map<string, Statement>();
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
  }

  private get handle(): Database {
    if (!this.db) throw new Error(messages.searchIndexClosed);
    return this.db;
  }

  private stmt(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.handle.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  async open(): Promise<void> {
    if (this.db) return;
    await mkdir(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true });

    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS docs (
        id     TEXT PRIMARY KEY,
        path   TEXT NOT NULL,
        title  TEXT NOT NULL,
        type   TEXT NOT NULL,
        tags   TEXT NOT NULL DEFAULT '',
        mtime  REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id     TEXT PRIMARY KEY,
        doc_id       TEXT NOT NULL,
        ord          INTEGER NOT NULL,
        heading_path TEXT NOT NULL DEFAULT '',
        text         TEXT NOT NULL,
        char_start   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS chunks_by_doc ON chunks(doc_id);

      -- Normalised projections only. Nothing here is meant to be read back.
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED,
        title_n,
        heading_n,
        text_n,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);

    this.db = db;

    if (this.getMeta("schema_version") !== SCHEMA_VERSION) {
      this.clear();
      this.setMeta("schema_version", SCHEMA_VERSION);
    }
  }

  close(): void {
    if (!this.db) return;
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A failed checkpoint costs a rebuild, nothing more.
    }
    this.db.close(false);
    this.db = null;
  }

  private getMeta(key: string): string | null {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.stmt("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  clear(): void {
    this.handle.exec("DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM docs;");
  }

  get documentCount(): number {
    return (this.stmt("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n;
  }

  get chunkCount(): number {
    return (this.stmt("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  }

  /** Replace every chunk of one document. */
  upsert(doc: ConceptDocument): void {
    this.remove(doc.id);

    const title = conceptTitle(doc.id, doc.frontmatter);
    const tags = Array.isArray(doc.frontmatter.tags)
      ? doc.frontmatter.tags.filter((t): t is string => typeof t === "string")
      : [];

    this.stmt(
      "INSERT INTO docs (id, path, title, type, tags, mtime) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(doc.id, doc.relPath, title, doc.frontmatter.type, packTags(tags), doc.mtimeMs);

    const titleNormalized = normalizeForIndex(title);
    const chunks = chunkBody(doc.body);

    // A document with an empty body still needs a row, or its title becomes
    // unsearchable the moment someone writes a stub page.
    if (chunks.length === 0) {
      const id = chunkId(doc.id, 0);
      this.stmt(
        "INSERT INTO chunks (chunk_id, doc_id, ord, heading_path, text, char_start) VALUES (?, ?, 0, '', '', 0)"
      ).run(id, doc.id);
      this.stmt(
        "INSERT INTO chunks_fts (chunk_id, title_n, heading_n, text_n) VALUES (?, ?, '', '')"
      ).run(id, titleNormalized);
      return;
    }

    for (const chunk of chunks) {
      const id = chunkId(doc.id, chunk.ord);
      const headingPath = chunk.headingPath.join(" › ");
      this.stmt(
        `INSERT INTO chunks (chunk_id, doc_id, ord, heading_path, text, char_start)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, doc.id, chunk.ord, headingPath, chunk.text, chunk.charStart);
      this.stmt(
        "INSERT INTO chunks_fts (chunk_id, title_n, heading_n, text_n) VALUES (?, ?, ?, ?)"
      ).run(id, titleNormalized, normalizeForIndex(headingPath), normalizeForIndex(chunk.text));
    }
  }

  remove(docId: string): void {
    this.stmt(
      "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)"
    ).run(docId);
    this.stmt("DELETE FROM chunks WHERE doc_id = ?").run(docId);
    this.stmt("DELETE FROM docs WHERE id = ?").run(docId);
  }

  /** Reindex only what changed, comparing mtimes. */
  sync(docs: readonly ConceptDocument[]): { indexed: number; removed: number } {
    const known = new Map(
      (this.stmt("SELECT id, mtime FROM docs").all() as Array<{ id: string; mtime: number }>).map(
        (row) => [row.id, row.mtime]
      )
    );

    const stale = docs.filter((doc) => known.get(doc.id) !== doc.mtimeMs);
    const live = new Set(docs.map((doc) => doc.id));
    const gone = [...known.keys()].filter((id) => !live.has(id));

    this.handle.transaction(() => {
      for (const id of gone) this.remove(id);
      for (const doc of stale) this.upsert(doc);
      this.setMeta("indexed_at", new Date().toISOString());
    })();

    return { indexed: stale.length, removed: gone.length };
  }

  rebuild(docs: readonly ConceptDocument[]): number {
    this.handle.transaction(() => {
      this.clear();
      for (const doc of docs) this.upsert(doc);
      this.setMeta("schema_version", SCHEMA_VERSION);
      this.setMeta("indexed_at", new Date().toISOString());
    })();
    return docs.length;
  }

  /**
   * Rank chunks against a query.
   *
   * Column weights put a title match well above a heading match, and a heading
   * above body prose — matching how a person scans a wiki.
   */
  searchChunks(query: string, options: SearchOptions = {}): ChunkHit[] {
    const match = buildMatchQuery(query, options.mode ?? "phrase");
    if (!match) return [];

    const where: string[] = ["chunks_fts MATCH ?"];
    const params: unknown[] = [match];

    if (options.type) {
      where.push("d.type = ?");
      params.push(options.type);
    }
    if (options.pathPrefix) {
      where.push("d.path LIKE ?");
      params.push(`${options.pathPrefix.replace(/[%_]/g, "")}%`);
    }
    for (const tag of options.tags ?? []) {
      // Tags are stored unit-separated, so a LIKE cannot match a partial tag.
      where.push("d.tags LIKE ?");
      params.push(`%${TAG_SEP}${tag}${TAG_SEP}%`);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    // Over-fetch: grouping means one dense document can crowd out the rest, and
    // PARA re-weighting below can only reorder what was actually fetched.
    params.push(options.groupByDocument ? limit * 5 : limit * 3);

    let rows: ChunkRow[];
    try {
      rows = this.handle
        .prepare(
          `SELECT c.chunk_id, c.doc_id, c.ord, c.heading_path, c.text,
                  d.path, d.title, d.type,
                  bm25(chunks_fts, 0, 12.0, 4.0, 1.0) AS score
             FROM chunks_fts
             JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
             JOIN docs   d ON d.id = c.doc_id
            WHERE ${where.join(" AND ")}
            ORDER BY score
            LIMIT ?`
        )
        .all(...(params as never[])) as ChunkRow[];
    } catch {
      // A half-typed query is not a fault.
      return [];
    }

    const hits: ChunkHit[] = rows.map((row) => ({
      chunkId: row.chunk_id,
      id: row.doc_id,
      path: row.path,
      title: row.title,
      type: row.type,
      headingPath: row.heading_path ? row.heading_path.split(" › ") : [],
      text: row.text,
      // Markers rather than HTML: the view escapes the text, then restores
      // only these, so document content can never inject markup.
      snippet: makeSnippet(snippetSource(row, query), query, {
        open: "<mark>",
        close: "</mark>",
      }),
      // PARA is a priority order, so it multiplies relevance rather than
      // replacing it: what matches is still decided by BM25, but between two
      // comparable matches the active project wins and the shelved note loses.
      score: -row.score * PARA_WEIGHTS[paraOf(row.doc_id)],
      // The doc id is wiki-relative; `path` still carries the `wiki/` prefix,
      // which would make every note look unfiled.
      para: paraOf(row.doc_id),
    }));

    hits.sort((a, b) => b.score - a.score);

    if (!options.groupByDocument) return hits.slice(0, limit);

    const best = new Map<string, ChunkHit>();
    for (const hit of hits) if (!best.has(hit.id)) best.set(hit.id, hit);
    return [...best.values()].slice(0, limit);
  }

  /** Document-level search: the best chunk of each matching document. */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    return this.searchChunks(query, { ...options, groupByDocument: true }).map((hit) => ({
      id: hit.id,
      path: hit.path,
      title: hit.title,
      type: hit.type,
      snippet: hit.snippet,
      score: hit.score,
      para: hit.para,
      headingPath: hit.headingPath,
    }));
  }

  /** Every chunk of one document, in order. */
  chunksOf(docId: string): ChunkHit[] {
    const rows = this.stmt(
      `SELECT c.chunk_id, c.doc_id, c.ord, c.heading_path, c.text,
              d.path, d.title, d.type, 0 AS score
         FROM chunks c JOIN docs d ON d.id = c.doc_id
        WHERE c.doc_id = ? ORDER BY c.ord`
    ).all(docId) as ChunkRow[];

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      id: row.doc_id,
      path: row.path,
      title: row.title,
      type: row.type,
      para: paraOf(row.doc_id),
      headingPath: row.heading_path ? row.heading_path.split(" › ") : [],
      text: row.text,
      snippet: "",
      score: 0,
    }));
  }

  /** Tag counts across the bundle, most used first. */
  tags(): TagCount[] {
    const rows = this.stmt("SELECT tags FROM docs WHERE tags <> ''").all() as Array<{
      tags: string;
    }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of unpackTags(row.tags)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Distinct concept types, most used first. */
  types(): TagCount[] {
    const rows = this.stmt(
      "SELECT type AS tag, COUNT(*) AS count FROM docs GROUP BY type ORDER BY count DESC, type"
    ).all() as TagCount[];
    return rows;
  }
}
