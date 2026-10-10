//! Pure data types shared across the app (`src/shared/types.ts`).
//!
//! Field order and names follow the TS interfaces so the JSON that crosses the
//! MCP boundary is identical: camelCase via serde renames, optional fields
//! omitted when `None`. Fields TS types as `T | null` stay present as `null`.

use super::js_compat::serialize_js_f64;
pub use super::okf::para::ParaClass;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// OKF v0.2 concept type. Free-form string; only "non-empty" is enforced.
pub type ConceptType = String;

/// Actor convention (OKF §7): `human:<name>`, `process:<name>`, `<producer>/<version>`.
pub type Actor = String;

/// Source credibility signal (OKF §5.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub resource: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<Actor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_count: Option<serde_json::Number>,
    /// YYYY-MM-DD
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageWindow {
    pub from: String,
    pub to: String,
}

/// `generated` field (OKF §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Generated {
    pub by: Actor,
    /// ISO 8601
    pub at: String,
}

/// `verified` entry (OKF §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedEntry {
    pub by: Actor,
    /// ISO 8601
    pub at: String,
}

/// `verified` is either one entry or a list of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Verified {
    One(VerifiedEntry),
    Many(Vec<VerifiedEntry>),
}

/// Lifecycle (OKF §5.4–5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Draft,
    Stable,
    Deprecated,
}

/// Trust tier derived from `verified` (OKF §5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrustTier {
    Unverified,
    MachineConfirmed,
    HumanReviewed,
}

/// Concept frontmatter. `type` is the only required key (OKF §4.1 / §11);
/// every other key is optional and preserved verbatim on round-trip via `extra`.
///
/// The TS value is a plain object, so its JSON keeps the order of the file.
/// `key_order` records that order when the value comes from a parsed file
/// (empty otherwise, meaning the canonical order below), and `Serialize`
/// honours it so `read_file` responses match the TS byte for byte.
///
/// `status` is kept as a string rather than [`Status`]: the file may hold any
/// value, and [`effective_status`](super::okf::concept::effective_status)
/// normalises it the way the TS does.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ConceptFrontmatter {
    pub r#type: ConceptType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<SourceEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_window: Option<UsageWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated: Option<Generated>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<Verified>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// ISO 8601 timestamp after which the concept is considered stale. Kept as
    /// a JSON value because YAML may hold a non-string (e.g. a number).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_after: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
    /// Key order of the source file; see the type docs.
    #[serde(skip)]
    pub key_order: Vec<String>,
}

impl Serialize for ConceptFrontmatter {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_map().serialize(serializer)
    }
}

impl ConceptFrontmatter {
    /// The frontmatter as the JSON object the TS holds, in `key_order` (typed
    /// fields in canonical order, then `extra`, when `key_order` is empty).
    pub fn to_map(&self) -> Map<String, Value> {
        fn put<T: Serialize>(m: &mut Map<String, Value>, key: &str, v: &Option<T>) {
            if let Some(v) = v {
                if let Ok(v) = serde_json::to_value(v) {
                    m.insert(key.to_string(), v);
                }
            }
        }
        let mut m = Map::new();
        m.insert("type".into(), Value::String(self.r#type.clone()));
        put(&mut m, "title", &self.title);
        put(&mut m, "description", &self.description);
        put(&mut m, "resource", &self.resource);
        put(&mut m, "tags", &self.tags);
        put(&mut m, "sources", &self.sources);
        put(&mut m, "usage_window", &self.usage_window);
        put(&mut m, "generated", &self.generated);
        put(&mut m, "verified", &self.verified);
        put(&mut m, "status", &self.status);
        put(&mut m, "stale_after", &self.stale_after);
        for (k, v) in &self.extra {
            m.insert(k.clone(), v.clone());
        }
        if self.key_order.is_empty() {
            return m;
        }
        let mut ordered = Map::new();
        for key in &self.key_order {
            if let Some(v) = m.get(key) {
                ordered.insert(key.clone(), v.clone());
            }
        }
        for (k, v) in m {
            if !ordered.contains_key(&k) {
                ordered.insert(k, v);
            }
        }
        ordered
    }

    /// Build from a JSON object, keeping its key order.
    ///
    /// A typed field is filled only when the value survives a typed round trip
    /// unchanged. Anything else (`title: 5`, tags holding numbers, a `sources`
    /// entry with extra keys) stays in `extra`, so serialising the result
    /// reproduces the object and the TS `typeof` checks behave the same.
    pub fn from_map(map: &Map<String, Value>) -> Self {
        fn take<T: serde::de::DeserializeOwned + Serialize>(
            map: &Map<String, Value>,
            key: &str,
        ) -> Option<T> {
            let v = map.get(key)?;
            let typed: T = serde_json::from_value(v.clone()).ok()?;
            (serde_json::to_value(&typed).ok()? == *v).then_some(typed)
        }
        let r#type = match map.get("type") {
            Some(Value::String(t)) => t.clone(),
            _ => String::new(),
        };
        let mut fm = Self::new(r#type);
        fm.title = take(map, "title");
        fm.description = take(map, "description");
        fm.resource = take(map, "resource");
        fm.tags = take(map, "tags");
        fm.sources = take(map, "sources");
        fm.usage_window = take(map, "usage_window");
        fm.generated = take(map, "generated");
        fm.verified = take(map, "verified");
        fm.status = take(map, "status");
        fm.stale_after = map.get("stale_after").cloned();
        for (k, v) in map {
            let typed = match k.as_str() {
                "type" => true,
                "title" => fm.title.is_some(),
                "description" => fm.description.is_some(),
                "resource" => fm.resource.is_some(),
                "tags" => fm.tags.is_some(),
                "sources" => fm.sources.is_some(),
                "usage_window" => fm.usage_window.is_some(),
                "generated" => fm.generated.is_some(),
                "verified" => fm.verified.is_some(),
                "status" => fm.status.is_some(),
                "stale_after" => true,
                _ => false,
            };
            if !typed {
                fm.extra.insert(k.clone(), v.clone());
            }
        }
        fm.key_order = map.keys().cloned().collect();
        fm
    }
}

impl ConceptFrontmatter {
    /// A frontmatter carrying only `type`.
    pub fn new(concept_type: impl Into<String>) -> Self {
        Self {
            r#type: concept_type.into(),
            title: None,
            description: None,
            resource: None,
            tags: None,
            sources: None,
            usage_window: None,
            generated: None,
            verified: None,
            status: None,
            stale_after: None,
            extra: Map::new(),
            key_order: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Wikilink,
    Markdown,
}

/// A link found in a concept body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConceptLink {
    /// Raw target as written in the source.
    pub target: String,
    /// Display text, when the syntax carries one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub kind: LinkKind,
    /// Resolved concept id, or `null` when the target is external/unresolvable.
    pub resolved: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptDocument {
    /// Concept id = wiki-relative path without the `.md` suffix (OKF §2).
    pub id: String,
    /// Absolute path on disk.
    pub path: String,
    /// Path relative to the bundle root, always `/`-separated.
    pub rel_path: String,
    pub frontmatter: ConceptFrontmatter,
    /// Body with frontmatter removed.
    pub body: String,
    /// Outbound links parsed from the body.
    pub links: Vec<ConceptLink>,
    /// File mtime in milliseconds, used for incremental indexing.
    #[serde(serialize_with = "serialize_js_f64")]
    pub mtime_ms: f64,
}

/// The three layers of the LLM Wiki pattern.
///
/// `skills/`, `loops/` and `AGENTS.md` are *not* layers: they live inside the
/// wiki layer, because they are curated content about the wiki.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Raw,
    Wiki,
    Rag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
    /// Absolute bundle root.
    pub root: String,
    /// Bundle-relative path of the wiki layer: `"wiki"` when a `wiki/`
    /// directory exists, otherwise `""`.
    pub wiki_dir: String,
    pub has_agents_md: bool,
    pub has_index: bool,
    pub has_log: bool,
    pub has_raw: bool,
    pub concept_count: u64,
    /// Concepts failing OKF §11 conformance.
    pub non_conformant_count: u64,
    /// Things that went wrong while opening, none of which prevented it.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    /// Bundle-relative path.
    pub path: String,
    pub title: String,
    /// Plain-text excerpt around the match; the view escapes and highlights it.
    pub snippet: String,
    /// Higher is better.
    #[serde(serialize_with = "serialize_js_f64")]
    pub score: f64,
    pub r#type: String,
    /// Heading trail of the best-matching section.
    pub heading_path: Vec<String>,
    /// PARA class, derived from the path.
    pub para: ParaClass,
}

/// A single retrievable section of a document (`SearchHit` plus two fields).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkHit {
    #[serde(flatten)]
    pub hit: SearchHit,
    /// `<docId>#<ord>`
    pub chunk_id: String,
    /// Full chunk text, for retrieval rather than display.
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    /// Restrict to one OKF `type`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    /// Require every listed tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Restrict to a bundle-relative path prefix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagCount {
    pub tag: String,
    pub count: u64,
}

/// One passage in an assembled retrieval context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedPassage {
    /// Citation anchor, e.g. `topics/note.md#setup`.
    pub anchor: String,
    pub id: String,
    pub path: String,
    pub title: String,
    pub r#type: String,
    pub heading_path: Vec<String>,
    pub text: String,
    #[serde(serialize_with = "serialize_js_f64")]
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalResult {
    pub query: String,
    pub passages: Vec<RetrievedPassage>,
    /// Characters of passage text returned.
    pub used_chars: u64,
    /// True when the budget cut the result short.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    /// Bundle-relative, `/`-separated.
    pub path: String,
    pub r#type: NodeType,
    /// Layer this node belongs to, when it sits inside one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<Layer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

/// Conformance report for a single concept (OKF §11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConformanceIssue {
    pub path: String,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    /// Empty when the file is binary: there is nothing safe to show.
    pub content: String,
    /// True when the file is not text and must not be rendered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    /// Recognised file type, e.g. "SQLite データベース".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    /// Size on disk, so the UI can say something useful about a binary file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    /// Present only for concept documents (i.e. not reserved files).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concept: Option<ConceptDocument>,
    /// Concept ids linking *to* this document.
    pub backlinks: Vec<String>,
    #[serde(serialize_with = "serialize_js_f64")]
    pub mtime_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileResult {
    /// Always `true` (the TS type is the literal `true`).
    pub ok: bool,
    #[serde(serialize_with = "serialize_js_f64")]
    pub mtime_ms: f64,
    /// Conformance errors, if the written file is a non-conformant concept.
    pub warnings: Vec<String>,
}

impl WriteFileResult {
    pub fn new(mtime_ms: f64, warnings: Vec<String>) -> Self {
        Self {
            ok: true,
            mtime_ms,
            warnings,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    /// ISO 8601
    pub at: String,
    pub actor: Actor,
    pub action: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frontmatter_round_trips_unknown_keys_in_order() {
        let source = json!({
            "type": "Concept",
            "title": "T",
            "custom": 1,
            "another": {"a": [1, 2]},
        });
        let fm: ConceptFrontmatter = serde_json::from_value(source.clone()).unwrap();
        assert_eq!(fm.extra.len(), 2);
        let back = serde_json::to_string(&fm).unwrap();
        assert_eq!(
            back,
            r#"{"type":"Concept","title":"T","custom":1,"another":{"a":[1,2]}}"#
        );
    }

    #[test]
    fn optional_fields_are_omitted_and_nulls_kept() {
        let link = ConceptLink {
            target: "a".into(),
            label: None,
            kind: LinkKind::Wikilink,
            resolved: None,
        };
        assert_eq!(
            serde_json::to_string(&link).unwrap(),
            r#"{"target":"a","kind":"wikilink","resolved":null}"#
        );
    }

    #[test]
    fn search_hit_uses_ts_key_order_and_camel_case() {
        let hit = SearchHit {
            id: "a".into(),
            path: "a.md".into(),
            title: "A".into(),
            snippet: "s".into(),
            score: 2.0,
            r#type: "Concept".into(),
            heading_path: vec!["H".into()],
            para: ParaClass::Project,
        };
        let chunk = ChunkHit {
            hit,
            chunk_id: "a#0".into(),
            text: "t".into(),
        };
        assert_eq!(
            serde_json::to_string(&chunk).unwrap(),
            r#"{"id":"a","path":"a.md","title":"A","snippet":"s","score":2,"type":"Concept","headingPath":["H"],"para":"project","chunkId":"a#0","text":"t"}"#
        );
    }

    #[test]
    fn read_file_result_omits_absent_binary_fields() {
        let result = ReadFileResult {
            content: "x".into(),
            binary: None,
            file_type: None,
            byte_length: None,
            concept: None,
            backlinks: vec![],
            mtime_ms: 1754300000123.0,
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"content":"x","backlinks":[],"mtimeMs":1754300000123}"#
        );
    }

    #[test]
    fn trust_tier_and_status_use_ts_strings() {
        assert_eq!(
            serde_json::to_string(&TrustTier::MachineConfirmed).unwrap(),
            "\"machine-confirmed\""
        );
        assert_eq!(
            serde_json::to_string(&Status::Deprecated).unwrap(),
            "\"deprecated\""
        );
    }

    #[test]
    fn verified_accepts_one_or_many() {
        let one: Verified = serde_json::from_str(r#"{"by":"human:kn","at":"2026-01-01"}"#).unwrap();
        assert!(matches!(one, Verified::One(_)));
        let many: Verified =
            serde_json::from_str(r#"[{"by":"human:kn","at":"2026-01-01"}]"#).unwrap();
        assert!(matches!(many, Verified::Many(v) if v.len() == 1));
    }
}
