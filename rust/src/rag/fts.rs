//! Layer 3: the retrieval index (`src/bun/rag/fts.ts`).
//!
//! Chunks, not documents, are the unit: a section carries its heading path, so
//! a hit is precise enough to cite and small enough to put in a context
//! window. Indexed text is bigram-normalised so Japanese is searchable; the
//! original text is kept alongside for snippets and retrieval.
//!
//! The schema, SQL, tokenizer and bm25 weights are identical to the TS
//! original, so an index file is interchangeable between the two and ranking
//! matches.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};

use rusqlite::{params, params_from_iter, Connection};

use crate::shared::js_compat::locale_compare;
use crate::shared::messages::SEARCH_INDEX_CLOSED;
use crate::shared::okf::lifecycle::lifecycle_weight;
use crate::shared::okf::para::{para_of, ParaClass, PARA_ORDER};
use crate::shared::okf::{
    build_match_query, chunk_body, chunk_id, concept_title, find_highlights, make_snippet,
    normalize_for_index, parse_query_terms, QueryMode, SnippetOptions,
};
use crate::shared::types::{ChunkHit, ConceptDocument, SearchFilters, SearchHit, TagCount};

/// Bumped when the schema or the normalisation changes; forces a rebuild.
pub const SCHEMA_VERSION: &str = "5";

/// Tags are stored as one delimited string so a document stays a single row.
/// The delimiter wraps both ends, so a LIKE on the wrapped tag matches a whole
/// tag and never a prefix of a longer one. A newline cannot occur in a tag.
const TAG_SEP: &str = "\n";

/// Separator inside a stored heading path.
const HEADING_SEP: &str = " › ";

#[derive(Debug)]
pub enum FtsError {
    /// The index has not been opened (or was closed).
    Closed,
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for FtsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FtsError::Closed => f.write_str(SEARCH_INDEX_CLOSED),
            FtsError::Io(e) => write!(f, "{e}"),
            FtsError::Sqlite(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for FtsError {}

impl From<rusqlite::Error> for FtsError {
    fn from(e: rusqlite::Error) -> Self {
        FtsError::Sqlite(e)
    }
}

impl From<std::io::Error> for FtsError {
    fn from(e: std::io::Error) -> Self {
        FtsError::Io(e)
    }
}

pub type FtsResult<T> = Result<T, FtsError>;

fn pack_tags(tags: &[String]) -> String {
    if tags.is_empty() {
        String::new()
    } else {
        format!("{TAG_SEP}{}{TAG_SEP}", tags.join(TAG_SEP))
    }
}

fn unpack_tags(packed: &str) -> impl Iterator<Item = &str> {
    packed.split(TAG_SEP).filter(|t| !t.is_empty())
}

struct ChunkRow {
    chunk_id: String,
    doc_id: String,
    heading_path: String,
    text: String,
    score: f64,
    path: String,
    title: String,
    r#type: String,
    tags: String,
}

/// SQL for `para_depth`, or `None` when every class is in range.
///
/// Done in the query rather than after it so a narrow depth still returns a
/// full page of hits; the same rule, per path, is `within_para_depth`. Depth 3
/// and up name what to leave out (the unfiled concepts are resources, so they
/// have no folder to name); depths 1 and 2 name what to keep.
fn para_depth_clause(depth: i64) -> Option<(String, Vec<String>)> {
    let d = depth.max(1) as usize;
    if d >= PARA_ORDER.len() {
        return None;
    }
    let like = |class: &ParaClass| format!("{}/%", class.dir());
    if d >= 3 {
        let out = &PARA_ORDER[d..];
        let sql = out.iter().map(|_| "d.id NOT LIKE ?").collect::<Vec<_>>().join(" AND ");
        return Some((sql, out.iter().map(like).collect()));
    }
    let kept = &PARA_ORDER[..d];
    let sql = format!("({})", kept.iter().map(|_| "d.id LIKE ?").collect::<Vec<_>>().join(" OR "));
    Some((sql, kept.iter().map(like).collect()))
}

/// Choose what a snippet should be built from.
///
/// A hit can come from the title or the heading rather than the prose, in which
/// case a snippet of the body alone shows unrelated text with nothing
/// highlighted. Falling back to the heading shows *why* the row matched.
fn snippet_source(row: &ChunkRow, query: &str) -> String {
    let terms = parse_query_terms(query);
    if !row.text.is_empty() && !find_highlights(&row.text, &terms).is_empty() {
        return row.text.clone();
    }
    let heading = if row.heading_path.is_empty() {
        &row.title
    } else {
        &row.heading_path
    };
    if row.text.is_empty() {
        heading.clone()
    } else {
        format!("{heading} — {}", row.text)
    }
}

fn split_heading(heading_path: &str) -> Vec<String> {
    if heading_path.is_empty() {
        Vec::new()
    } else {
        heading_path.split(HEADING_SEP).map(str::to_string).collect()
    }
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub filters: SearchFilters,
    /// Default 20, clamped to 1..=200.
    pub limit: Option<i64>,
    /// Return one hit per document (best chunk) instead of every chunk.
    pub group_by_document: bool,
    /// Strict phrase matching (default) or recall-oriented loose matching.
    /// Retrieval uses `Loose`; the search box uses `Phrase`.
    pub mode: Option<QueryMode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncStats {
    pub indexed: usize,
    pub removed: usize,
}

/// FTS5 `bm25()` re-implemented as an auxiliary function so its floating-point
/// contraction matches the TypeScript server's SQLite.
///
/// Bun's SQLite is compiled with fused multiply-add contraction, so the
/// denominator `f + k1 * (...)` in SQLite's `fts5Bm25Function` is evaluated
/// with a single rounding; the MSVC build bundled by rusqlite evaluates it in
/// two. The scores then differ in the last digit (about 1 ULP), which breaks
/// byte-for-byte comparison of `score` and can reorder near-ties. This copy is
/// otherwise a line-for-line port of the SQLite function (same IDF, same
/// weights, same `avgdl`), and `OKF_BM25_FMA` selects the arithmetic:
/// `0` plain (default off Windows x64), `1` fused denominator, `2` also fused
/// accumulation (default on Windows x64, where it was measured).
mod bm25 {
    use rusqlite::ffi;
    use std::ffi::{c_char, c_int, c_void};
    use std::sync::OnceLock;

    #[repr(C)]
    struct Fts5Api {
        i_version: c_int,
        x_create_tokenizer: *const c_void,
        x_find_tokenizer: *const c_void,
        x_create_function: unsafe extern "C" fn(
            *mut Fts5Api,
            *const c_char,
            *mut c_void,
            ExtFn,
            Option<unsafe extern "C" fn(*mut c_void)>,
        ) -> c_int,
    }

    #[repr(C)]
    struct Fts5Ext {
        i_version: c_int,
        x_user_data: *const c_void,
        x_column_count: *const c_void,
        x_row_count: unsafe extern "C" fn(*mut c_void, *mut i64) -> c_int,
        x_column_total_size: unsafe extern "C" fn(*mut c_void, c_int, *mut i64) -> c_int,
        x_tokenize: *const c_void,
        x_phrase_count: unsafe extern "C" fn(*mut c_void) -> c_int,
        x_phrase_size: *const c_void,
        x_inst_count: unsafe extern "C" fn(*mut c_void, *mut c_int) -> c_int,
        x_inst: unsafe extern "C" fn(*mut c_void, c_int, *mut c_int, *mut c_int, *mut c_int) -> c_int,
        x_rowid: *const c_void,
        x_column_text: *const c_void,
        x_column_size: unsafe extern "C" fn(*mut c_void, c_int, *mut c_int) -> c_int,
        x_query_phrase: unsafe extern "C" fn(
            *mut c_void,
            c_int,
            *mut c_void,
            unsafe extern "C" fn(*const Fts5Ext, *mut c_void, *mut c_void) -> c_int,
        ) -> c_int,
        x_set_auxdata: unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            Option<unsafe extern "C" fn(*mut c_void)>,
        ) -> c_int,
        x_get_auxdata: unsafe extern "C" fn(*mut c_void, c_int) -> *mut c_void,
    }

    type ExtFn = unsafe extern "C" fn(
        *const Fts5Ext,
        *mut c_void,
        *mut ffi::sqlite3_context,
        c_int,
        *mut *mut ffi::sqlite3_value,
    );

    struct Data {
        idf: Vec<f64>,
        freq: Vec<f64>,
        avgdl: f64,
    }

    fn mode() -> u8 {
        static MODE: OnceLock<u8> = OnceLock::new();
        // Fused arithmetic was measured against Bun on Windows x64 only. Other
        // targets keep SQLite's own unfused arithmetic until measured there;
        // on x86_64 without the `fma` feature, mul_add is also a slow libm call.
        let default = if cfg!(all(windows, target_arch = "x86_64")) { 2 } else { 0 };
        *MODE.get_or_init(|| match std::env::var("OKF_BM25_FMA").as_deref() {
            Ok("0") => 0,
            Ok("1") => 1,
            Ok("2") => 2,
            _ => default,
        })
    }

    unsafe extern "C" fn count_cb(_api: *const Fts5Ext, _fts: *mut c_void, user: *mut c_void) -> c_int {
        *(user as *mut i64) += 1;
        ffi::SQLITE_OK
    }

    unsafe extern "C" fn destroy(p: *mut c_void) {
        drop(Box::from_raw(p as *mut Data));
    }

    unsafe fn get_data(api: &Fts5Ext, fts: *mut c_void) -> Result<*mut Data, c_int> {
        let existing = (api.x_get_auxdata)(fts, 0) as *mut Data;
        if !existing.is_null() {
            return Ok(existing);
        }
        let n_phrase = (api.x_phrase_count)(fts).max(0) as usize;
        let (mut n_row, mut n_token) = (0i64, 0i64);
        let mut rc = (api.x_row_count)(fts, &mut n_row);
        if rc == ffi::SQLITE_OK {
            rc = (api.x_column_total_size)(fts, -1, &mut n_token);
        }
        if rc != ffi::SQLITE_OK {
            return Err(rc);
        }
        let mut data = Box::new(Data {
            idf: vec![0.0; n_phrase],
            freq: vec![0.0; n_phrase],
            avgdl: n_token as f64 / n_row as f64,
        });
        for i in 0..n_phrase {
            let mut n_hit = 0i64;
            let rc = (api.x_query_phrase)(fts, i as c_int, &mut n_hit as *mut i64 as *mut c_void, count_cb);
            if rc != ffi::SQLITE_OK {
                return Err(rc);
            }
            let mut idf = (((n_row - n_hit) as f64 + 0.5) / (n_hit as f64 + 0.5)).ln();
            if idf <= 0.0 {
                idf = 1e-6;
            }
            data.idf[i] = idf;
        }
        let ptr = Box::into_raw(data);
        let rc = (api.x_set_auxdata)(fts, ptr as *mut c_void, Some(destroy));
        if rc != ffi::SQLITE_OK {
            // SQLite has already called `destroy` on failure.
            return Err(rc);
        }
        Ok(ptr)
    }

    unsafe extern "C" fn bm25_fn(
        api: *const Fts5Ext,
        fts: *mut c_void,
        ctx: *mut ffi::sqlite3_context,
        n_val: c_int,
        ap_val: *mut *mut ffi::sqlite3_value,
    ) {
        let api = &*api;
        let data = match get_data(api, fts) {
            Ok(d) => &mut *d,
            Err(rc) => return ffi::sqlite3_result_error_code(ctx, rc),
        };
        data.freq.iter_mut().for_each(|f| *f = 0.0);
        let mut n_inst: c_int = 0;
        let mut rc = (api.x_inst_count)(fts, &mut n_inst);
        let mut i = 0;
        while rc == ffi::SQLITE_OK && i < n_inst {
            let (mut ip, mut ic, mut io) = (0, 0, 0);
            rc = (api.x_inst)(fts, i, &mut ip, &mut ic, &mut io);
            if rc == ffi::SQLITE_OK {
                let w = if n_val > ic {
                    ffi::sqlite3_value_double(*ap_val.add(ic as usize))
                } else {
                    1.0
                };
                data.freq[ip as usize] += w;
            }
            i += 1;
        }
        let mut n_tok: c_int = 0;
        if rc == ffi::SQLITE_OK {
            rc = (api.x_column_size)(fts, -1, &mut n_tok);
        }
        if rc != ffi::SQLITE_OK {
            return ffi::sqlite3_result_error_code(ctx, rc);
        }
        let d = n_tok as f64;
        let (k1, b) = (1.2f64, 0.75f64);
        let fma = mode();
        let mut score = 0.0f64;
        for i in 0..data.idf.len() {
            let f = data.freq[i];
            let inner = 1.0 - b + b * d / data.avgdl;
            let denom = if fma >= 1 { k1.mul_add(inner, f) } else { f + k1 * inner };
            let q = (f * (k1 + 1.0)) / denom;
            score = if fma >= 2 { data.idf[i].mul_add(q, score) } else { score + data.idf[i] * q };
        }
        ffi::sqlite3_result_double(ctx, -score);
    }

    /// Replace the built-in `bm25` auxiliary function on this connection. A
    /// failure leaves the built-in in place (scores then differ in the last
    /// digit, nothing else).
    pub fn register(conn: &rusqlite::Connection) {
        unsafe {
            let db = conn.handle();
            let mut stmt: *mut ffi::sqlite3_stmt = std::ptr::null_mut();
            if ffi::sqlite3_prepare_v2(db, c"SELECT fts5(?1)".as_ptr(), -1, &mut stmt, std::ptr::null_mut())
                != ffi::SQLITE_OK
            {
                return;
            }
            let mut api: *mut Fts5Api = std::ptr::null_mut();
            ffi::sqlite3_bind_pointer(
                stmt,
                1,
                &mut api as *mut *mut Fts5Api as *mut c_void,
                c"fts5_api_ptr".as_ptr(),
                None,
            );
            ffi::sqlite3_step(stmt);
            ffi::sqlite3_finalize(stmt);
            if api.is_null() || (*api).i_version < 2 {
                return;
            }
            ((*api).x_create_function)(api, c"bm25".as_ptr(), std::ptr::null_mut(), bm25_fn, None);
        }
    }
}

pub struct FtsIndex {
    conn: Option<Connection>,
    path: PathBuf,
}

impl FtsIndex {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            conn: None,
            path: db_path.into(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_open(&self) -> bool {
        self.conn.is_some()
    }

    fn handle(&self) -> FtsResult<&Connection> {
        self.conn.as_ref().ok_or(FtsError::Closed)
    }

    pub fn open(&mut self) -> FtsResult<()> {
        if self.conn.is_some() {
            return Ok(());
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(&self.path)?;
        bm25::register(&conn);
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            "
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
    ",
        )?;
        self.conn = Some(conn);

        if self.get_meta("schema_version")?.as_deref() != Some(SCHEMA_VERSION) {
            self.clear()?;
            self.set_meta("schema_version", SCHEMA_VERSION)?;
        }
        Ok(())
    }

    pub fn close(&mut self) {
        let Some(conn) = self.conn.take() else {
            return;
        };
        // A failed checkpoint costs a rebuild, nothing more.
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        let _ = conn.close();
    }

    fn get_meta(&self, key: &str) -> FtsResult<Option<String>> {
        let conn = self.handle()?;
        let mut stmt = conn.prepare_cached("SELECT value FROM meta WHERE key = ?")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(row.get::<_, Option<String>>(0)?),
            None => Ok(None),
        }
    }

    fn set_meta(&self, key: &str, value: &str) -> FtsResult<()> {
        self.handle()?
            .prepare_cached("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")?
            .execute(params![key, value])?;
        Ok(())
    }

    /// Value stored under `key` in the `meta` table.
    pub fn meta(&self, key: &str) -> FtsResult<Option<String>> {
        self.get_meta(key)
    }

    pub fn clear(&self) -> FtsResult<()> {
        self.handle()?
            .execute_batch("DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM docs;")?;
        Ok(())
    }

    pub fn document_count(&self) -> FtsResult<u64> {
        self.count("SELECT COUNT(*) AS n FROM docs")
    }

    pub fn chunk_count(&self) -> FtsResult<u64> {
        self.count("SELECT COUNT(*) AS n FROM chunks")
    }

    fn count(&self, sql: &str) -> FtsResult<u64> {
        let n: i64 = self
            .handle()?
            .prepare_cached(sql)?
            .query_row([], |r| r.get(0))?;
        Ok(n as u64)
    }

    /// Replace every chunk of one document.
    pub fn upsert(&self, doc: &ConceptDocument) -> FtsResult<()> {
        let conn = self.handle()?;
        self.remove(&doc.id)?;

        let title = concept_title(&doc.id, &doc.frontmatter);
        let tags = doc.frontmatter.string_tags();

        conn.prepare_cached(
            "INSERT INTO docs (id, path, title, type, tags, mtime) VALUES (?, ?, ?, ?, ?, ?)",
        )?
        .execute(params![
            doc.id,
            doc.rel_path,
            title,
            doc.frontmatter.r#type,
            pack_tags(&tags),
            doc.mtime_ms
        ])?;

        let title_normalized = normalize_for_index(&title);
        let chunks = chunk_body(&doc.body);

        // A document with an empty body still needs a row, or its title becomes
        // unsearchable the moment someone writes a stub page.
        if chunks.is_empty() {
            let id = chunk_id(&doc.id, 0);
            conn.prepare_cached(
                "INSERT INTO chunks (chunk_id, doc_id, ord, heading_path, text, char_start) VALUES (?, ?, 0, '', '', 0)",
            )?
            .execute(params![id, doc.id])?;
            conn.prepare_cached(
                "INSERT INTO chunks_fts (chunk_id, title_n, heading_n, text_n) VALUES (?, ?, '', '')",
            )?
            .execute(params![id, title_normalized])?;
            return Ok(());
        }

        for chunk in &chunks {
            let id = chunk_id(&doc.id, chunk.ord);
            let heading_path = chunk.heading_path.join(HEADING_SEP);
            conn.prepare_cached(
                "INSERT INTO chunks (chunk_id, doc_id, ord, heading_path, text, char_start)
         VALUES (?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                id,
                doc.id,
                chunk.ord as i64,
                heading_path,
                chunk.text,
                chunk.char_start as i64
            ])?;
            conn.prepare_cached(
                "INSERT INTO chunks_fts (chunk_id, title_n, heading_n, text_n) VALUES (?, ?, ?, ?)",
            )?
            .execute(params![
                id,
                title_normalized,
                normalize_for_index(&heading_path),
                normalize_for_index(&chunk.text)
            ])?;
        }
        Ok(())
    }

    pub fn remove(&self, doc_id: &str) -> FtsResult<()> {
        let conn = self.handle()?;
        conn.prepare_cached(
            "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)",
        )?
        .execute(params![doc_id])?;
        conn.prepare_cached("DELETE FROM chunks WHERE doc_id = ?")?
            .execute(params![doc_id])?;
        conn.prepare_cached("DELETE FROM docs WHERE id = ?")?
            .execute(params![doc_id])?;
        Ok(())
    }

    fn now_iso() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    /// Reindex only what changed, comparing mtimes.
    pub fn sync(&self, docs: &[ConceptDocument]) -> FtsResult<SyncStats> {
        let conn = self.handle()?;
        let known: HashMap<String, f64> = {
            let mut stmt = conn.prepare_cached("SELECT id, mtime FROM docs")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };

        let stale: Vec<&ConceptDocument> = docs
            .iter()
            .filter(|doc| known.get(&doc.id) != Some(&doc.mtime_ms))
            .collect();
        let live: HashSet<&str> = docs.iter().map(|d| d.id.as_str()).collect();
        let gone: Vec<&String> = known
            .keys()
            .filter(|id| !live.contains(id.as_str()))
            .collect();

        let tx = conn.unchecked_transaction()?;
        for id in &gone {
            self.remove(id)?;
        }
        for doc in &stale {
            self.upsert(doc)?;
        }
        self.set_meta("indexed_at", &Self::now_iso())?;
        tx.commit()?;

        Ok(SyncStats {
            indexed: stale.len(),
            removed: gone.len(),
        })
    }

    pub fn rebuild(&self, docs: &[ConceptDocument]) -> FtsResult<usize> {
        let tx = self.handle()?.unchecked_transaction()?;
        self.clear()?;
        for doc in docs {
            self.upsert(doc)?;
        }
        self.set_meta("schema_version", SCHEMA_VERSION)?;
        self.set_meta("indexed_at", &Self::now_iso())?;
        tx.commit()?;
        Ok(docs.len())
    }

    /// Rank chunks against a query.
    ///
    /// Column weights put a title match well above a heading match, and a
    /// heading above body prose, matching how a person scans a wiki.
    pub fn search_chunks(&self, query: &str, options: &SearchOptions) -> FtsResult<Vec<ChunkHit>> {
        let conn = self.handle()?;
        let Some(match_expr) = build_match_query(query, options.mode.unwrap_or(QueryMode::Phrase))
        else {
            return Ok(Vec::new());
        };

        let mut wheres: Vec<String> = vec!["chunks_fts MATCH ?".to_string()];
        let mut params: Vec<rusqlite::types::Value> = vec![match_expr.into()];

        if let Some(t) = options.filters.r#type.as_deref().filter(|t| !t.is_empty()) {
            wheres.push("d.type = ?".into());
            params.push(t.to_string().into());
        }
        if let Some(prefix) = options
            .filters
            .path_prefix
            .as_deref()
            .filter(|p| !p.is_empty())
        {
            wheres.push("d.path LIKE ?".into());
            let cleaned: String = prefix.chars().filter(|c| *c != '%' && *c != '_').collect();
            params.push(format!("{cleaned}%").into());
        }
        for tag in options.filters.tags.as_deref().unwrap_or(&[]) {
            // Tags are stored unit-separated, so a LIKE cannot match a partial tag.
            wheres.push("d.tags LIKE ?".into());
            params.push(format!("%{TAG_SEP}{tag}{TAG_SEP}%").into());
        }
        // DEAD is retired material: out of every result unless asked for. GLOB
        // is case-sensitive, so a bundle's own `dead` tag is not hidden.
        if options.filters.include_dead != Some(true) {
            wheres.push("d.tags NOT GLOB ?".into());
            params.push(format!("*{TAG_SEP}DEAD{TAG_SEP}*").into());
        }
        if let Some((sql, like_params)) = options.filters.para_depth.and_then(para_depth_clause) {
            wheres.push(sql);
            params.extend(like_params.into_iter().map(rusqlite::types::Value::from));
        }

        let limit = options.limit.unwrap_or(20).clamp(1, 200);
        // Over-fetch: grouping means one dense document can crowd out the rest,
        // and PARA re-weighting below can only reorder what was fetched.
        let fetch = if options.group_by_document {
            limit * 5
        } else {
            limit * 3
        };
        params.push(fetch.into());

        let sql = format!(
            "SELECT c.chunk_id, c.doc_id, c.ord, c.heading_path, c.text,
                  d.path, d.title, d.type, d.tags,
                  bm25(chunks_fts, 0, 12.0, 4.0, 1.0) AS score
             FROM chunks_fts
             JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
             JOIN docs   d ON d.id = c.doc_id
            WHERE {}
            ORDER BY score
            LIMIT ?",
            wheres.join(" AND ")
        );

        let run = || -> rusqlite::Result<Vec<ChunkRow>> {
            let mut stmt = conn.prepare_cached(&sql)?;
            let rows = stmt.query_map(params_from_iter(params.iter()), |r| {
                Ok(ChunkRow {
                    chunk_id: r.get(0)?,
                    doc_id: r.get(1)?,
                    heading_path: r.get(3)?,
                    text: r.get(4)?,
                    path: r.get(5)?,
                    title: r.get(6)?,
                    r#type: r.get(7)?,
                    tags: r.get(8)?,
                    score: r.get(9)?,
                })
            })?;
            rows.collect()
        };
        // A half-typed query is not a fault.
        let Ok(rows) = run() else {
            return Ok(Vec::new());
        };

        let mut hits: Vec<ChunkHit> = rows
            .into_iter()
            .map(|row| {
                let para = para_of(&row.doc_id);
                let tags: Vec<&str> = unpack_tags(&row.tags).collect();
                let snippet = make_snippet(
                    &snippet_source(&row, query),
                    query,
                    &SnippetOptions {
                        open: Some("<mark>".into()),
                        close: Some("</mark>".into()),
                        ..Default::default()
                    },
                );
                ChunkHit {
                    hit: SearchHit {
                        id: row.doc_id,
                        path: row.path,
                        title: row.title,
                        snippet,
                        // PARA is a priority order, so it multiplies relevance
                        // rather than replacing it. A Product concept adds a
                        // smaller nudge of the same kind.
                        score: -row.score * para.weight() * lifecycle_weight(&tags),
                        r#type: row.r#type,
                        heading_path: split_heading(&row.heading_path),
                        para,
                    },
                    chunk_id: row.chunk_id,
                    text: row.text,
                }
            })
            .collect();

        // Stable, descending: equal scores keep SQL order, as JS sort does.
        hits.sort_by(|a, b| {
            b.hit
                .score
                .partial_cmp(&a.hit.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let limit = limit as usize;
        if !options.group_by_document {
            hits.truncate(limit);
            return Ok(hits);
        }

        let mut seen = HashSet::new();
        let mut best = Vec::new();
        for hit in hits {
            if seen.insert(hit.hit.id.clone()) {
                best.push(hit);
            }
        }
        best.truncate(limit);
        Ok(best)
    }

    /// Document-level search: the best chunk of each matching document.
    pub fn search(&self, query: &str, options: &SearchOptions) -> FtsResult<Vec<SearchHit>> {
        let opts = SearchOptions {
            group_by_document: true,
            ..options.clone()
        };
        Ok(self
            .search_chunks(query, &opts)?
            .into_iter()
            .map(|c| c.hit)
            .collect())
    }

    /// Every chunk of one document, in order.
    pub fn chunks_of(&self, doc_id: &str) -> FtsResult<Vec<ChunkHit>> {
        let conn = self.handle()?;
        let mut stmt = conn.prepare_cached(
            "SELECT c.chunk_id, c.doc_id, c.ord, c.heading_path, c.text,
              d.path, d.title, d.type, 0 AS score
         FROM chunks c JOIN docs d ON d.id = c.doc_id
        WHERE c.doc_id = ? ORDER BY c.ord",
        )?;
        let rows = stmt.query_map(params![doc_id], |r| {
            let doc_id: String = r.get(1)?;
            let heading_path: String = r.get(3)?;
            Ok(ChunkHit {
                hit: SearchHit {
                    para: para_of(&doc_id),
                    id: doc_id,
                    path: r.get(5)?,
                    title: r.get(6)?,
                    r#type: r.get(7)?,
                    heading_path: split_heading(&heading_path),
                    snippet: String::new(),
                    score: 0.0,
                },
                chunk_id: r.get(0)?,
                text: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Tag counts across the bundle, most used first.
    pub fn tags(&self) -> FtsResult<Vec<TagCount>> {
        let conn = self.handle()?;
        let mut stmt = conn.prepare_cached("SELECT tags FROM docs WHERE tags <> ''")?;
        let packed: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        let mut counts: HashMap<String, u64> = HashMap::new();
        for row in &packed {
            for tag in unpack_tags(row) {
                *counts.entry(tag.to_string()).or_insert(0) += 1;
            }
        }
        let mut out: Vec<TagCount> = counts
            .into_iter()
            .map(|(tag, count)| TagCount { tag, count })
            .collect();
        out.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| locale_compare(&a.tag, &b.tag))
        });
        Ok(out)
    }

    /// Distinct concept types, most used first.
    pub fn types(&self) -> FtsResult<Vec<TagCount>> {
        let conn = self.handle()?;
        let mut stmt = conn.prepare_cached(
            "SELECT type AS tag, COUNT(*) AS count FROM docs GROUP BY type ORDER BY count DESC, type",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TagCount {
                tag: r.get(0)?,
                count: r.get::<_, i64>(1)? as u64,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

impl Drop for FtsIndex {
    fn drop(&mut self) {
        self.close();
    }
}

/// Shared fixtures for the rag tests: the corpus of `test/rag.test.ts`.
#[cfg(test)]
pub(crate) mod testutil {
    use super::*;

    pub fn doc(id: &str, ty: &str, title: &str, tags: &[&str], body: &str) -> ConceptDocument {
        let mut fm = crate::shared::types::ConceptFrontmatter::new(ty);
        fm.title = Some(title.to_string());
        if !tags.is_empty() {
            fm.tags = Some(tags.iter().map(|t| t.to_string()).collect());
        }
        ConceptDocument {
            id: id.to_string(),
            path: format!("/bundle/wiki/{id}.md"),
            rel_path: format!("wiki/{id}.md"),
            frontmatter: fm,
            body: body.to_string(),
            links: Vec::new(),
            mtime_ms: 1000.0,
        }
    }

    pub fn corpus() -> Vec<ConceptDocument> {
        vec![
            doc(
                "design",
                "Concept",
                "設計原則",
                &["design", "okf"],
                &[
                    "# 設計原則",
                    "",
                    "## File over App",
                    "",
                    "ノートの正本は常にローカルの Markdown ファイル。アプリはビューアに過ぎない。",
                    "",
                    "## 最高軽量",
                    "",
                    "システム WebView を使い、不要な機能を削る。メモリとバイナリサイズを最優先する。",
                ]
                .join("\n"),
            ),
            doc(
                "rag",
                "Playbook",
                "RAG構成",
                &["rag", "search"],
                &[
                    "# RAG構成",
                    "",
                    "## インデックス",
                    "",
                    "SQLite FTS5 で BM25 検索を行う。埋め込みは使わない。",
                    "",
                    "## チャンク分割",
                    "",
                    "見出し単位で分割し、見出しパスを添えて返す。",
                ]
                .join("\n"),
            ),
            doc(
                "english",
                "Note",
                "Lightweight notes",
                &["design"],
                "# Lightweight\n\nThe application stays small by avoiding a bundled browser engine.",
            ),
        ]
    }

    pub fn open_corpus(dir: &std::path::Path) -> FtsIndex {
        let mut index = FtsIndex::new(dir.join(".rag").join("index.db"));
        index.open().unwrap();
        index.rebuild(&corpus()).unwrap();
        index
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    fn ids(index: &FtsIndex, q: &str, opts: &SearchOptions) -> Vec<String> {
        index.search(q, opts).unwrap().into_iter().map(|h| h.id).collect()
    }

    fn plain() -> SearchOptions {
        SearchOptions::default()
    }

    fn with_filters(f: SearchFilters) -> SearchOptions {
        SearchOptions {
            filters: f,
            ..Default::default()
        }
    }

    #[test]
    fn japanese_search() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let p = plain();
        assert!(ids(&i, "軽量", &p).contains(&"design".into()));
        assert!(ids(&i, "ノート", &p).contains(&"design".into()));
        assert!(ids(&i, "見出しパス", &p).contains(&"rag".into()));
        assert!(!ids(&i, "軽", &p).is_empty());
        assert!(!ids(&i, "軽率", &p).contains(&"design".into()));
        assert!(ids(&i, "設計原則", &p).contains(&"design".into()));
        assert!(ids(&i, "lightweight", &p).contains(&"english".into()));
        assert!(ids(&i, "LIGHTWEIGHT", &p).contains(&"english".into()));
    }

    #[test]
    fn chunk_level_results() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let hits = i.search("最高軽量", &plain()).unwrap();
        assert_eq!(hits[0].id, "design");
        assert!(hits[0].heading_path.contains(&"最高軽量".to_string()));

        let o = SearchOptions {
            limit: Some(5),
            ..Default::default()
        };
        let a = &i.search_chunks("ローカル", &o).unwrap()[0];
        let b = &i.search_chunks("バイナリサイズ", &o).unwrap()[0];
        assert_eq!(a.hit.heading_path, ["設計原則", "File over App"]);
        assert_eq!(b.hit.heading_path, ["設計原則", "最高軽量"]);

        let hit = &i.search("軽量", &plain()).unwrap()[0];
        assert!(hit.snippet.contains("軽量"));
        assert!(hit.snippet.contains("<mark>"));
    }

    #[test]
    fn filters() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let by_type = with_filters(SearchFilters {
            r#type: Some("Playbook".into()),
            ..Default::default()
        });
        let hits = i.search("分割", &by_type).unwrap();
        assert!(!hits.is_empty() && hits.iter().all(|h| h.r#type == "Playbook"));

        let tag = |t: &str| {
            with_filters(SearchFilters {
                tags: Some(vec![t.into()]),
                ..Default::default()
            })
        };
        assert!(ids(&i, "軽量", &tag("design")).contains(&"design".into()));
        assert!(ids(&i, "インデックス", &tag("design")).is_empty());
        assert!(ids(&i, "軽量", &tag("desi")).is_empty());

        let prefix = |p: &str| {
            with_filters(SearchFilters {
                path_prefix: Some(p.into()),
                ..Default::default()
            })
        };
        assert!(!ids(&i, "軽量", &prefix("wiki/")).is_empty());
        assert!(ids(&i, "軽量", &prefix("nowhere/")).is_empty());
    }

    #[test]
    fn tags_and_types() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let tags: HashMap<_, _> = i.tags().unwrap().into_iter().map(|t| (t.tag, t.count)).collect();
        assert_eq!(tags["design"], 2);
        assert_eq!(tags["rag"], 1);
        let types: Vec<_> = i.types().unwrap().into_iter().map(|t| t.tag).collect();
        for t in ["Concept", "Playbook", "Note"] {
            assert!(types.contains(&t.to_string()));
        }
    }

    #[test]
    fn index_maintenance() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        assert_eq!(i.document_count().unwrap(), 3);
        assert!(i.chunk_count().unwrap() > 3);

        i.upsert(&doc("新規", "Note", "新規ノート", &[], "特殊な用語ホゲフガ。\n")).unwrap();
        assert!(ids(&i, "ホゲフガ", &plain()).contains(&"新規".into()));

        i.upsert(&doc("design", "Concept", "設計原則", &[], "## 新章\n\n差し替えた内容。\n"))
            .unwrap();
        assert!(ids(&i, "差し替え", &plain()).contains(&"design".into()));
        assert!(!ids(&i, "バイナリサイズ", &plain()).contains(&"design".into()));

        i.upsert(&doc("stub", "Note", "スタブ頁", &[], "")).unwrap();
        assert!(ids(&i, "スタブ", &plain()).contains(&"stub".into()));
    }

    #[test]
    fn sync_reindexes_only_changes() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let mut docs = corpus();
        assert_eq!(i.sync(&docs).unwrap(), SyncStats { indexed: 0, removed: 0 });
        docs.remove(2);
        docs[0].mtime_ms = 2000.0;
        assert_eq!(i.sync(&docs).unwrap(), SyncStats { indexed: 1, removed: 1 });
        assert_eq!(i.document_count().unwrap(), 2);
    }

    #[test]
    fn closed_index_reports_japanese_message_and_reopens_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let mut i = open_corpus(dir.path());
        i.close();
        assert!(!i.is_open());
        assert_eq!(i.document_count().unwrap_err().to_string(), SEARCH_INDEX_CLOSED);
        i.open().unwrap();
        assert_eq!(i.document_count().unwrap(), 3);
    }

    #[test]
    fn malformed_query_is_not_a_fault() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        assert!(i.search("\"", &plain()).is_ok());
        assert!(i.search("   ", &plain()).unwrap().is_empty());
    }
}
