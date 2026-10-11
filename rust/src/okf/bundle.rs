//! The OKF bundle (`src/bun/okf/bundle.ts`): an on-disk directory tree, loaded
//! into a concept map and a link graph.
//!
//! File over app: nothing here caches authoritatively. The maps are a read
//! model that can be rebuilt from disk at any moment, which is what makes an
//! external edit (human in another editor, or an agent over MCP)
//! indistinguishable from one made in the UI.
//!
//! The TS is `async`; every method here is synchronous and keeps the TS name
//! in snake case.

use super::error::{self, now_iso, OkfError, Result};
use super::migrate::{migrate_layout, MigrationResult};
use super::nodepath;
use super::parser::{concept_links, parse_concept, parse_frontmatter_map, ParseConceptOptions};
use super::paths::{is_contained, same_path, to_posix, Actor, BundlePaths, RAW_DIR, WIKI_DIR};
use crate::shared::binary::inspect;
use crate::shared::js_compat::{ends_with_ascii_ci, locale_compare};
use crate::shared::messages;
use crate::shared::okf::concept::{
    basename_of, check_conformance, concept_id_from_rel_path, concept_title, is_concept_path,
    is_reserved_filename,
};
use crate::shared::okf::frontmatter::{join_frontmatter, split_frontmatter, Eol};
use crate::shared::okf::links::{build_backlinks, resolve_link_target};
use crate::shared::okf::relation_edit::{rebase_own_relations, relations_after_move};
use crate::shared::okf::rename::{rebase_own_links, rewrite_links};
use crate::shared::okf::reserved::{
    empty_log_md, insert_log_entry, read_okf_version, render_index_md, IndexEntry, IndexOptions,
    IndexSection, OKF_VERSION,
};
use crate::shared::okf::workspace_files::{
    parse_tasks, render_map, render_tasks, TaskFile,
};
use crate::shared::types::{
    BundleInfo, ConceptDocument, ConceptFrontmatter, ConformanceIssue, FileNode, LinkKind, LogEntry,
    NodeType, ReadFileResult, WriteFileResult,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

/// A path that does not exist yet, by appending `-2`, `-3` ... when needed.
/// Re-importing the same page should add a copy, never replace the first.
fn unique_path(abs: &str) -> String {
    if !error::path_exists(abs) {
        return abs.to_string();
    }

    // `abs.lastIndexOf(".")` and `lastIndexOf(sep)` over UTF-16 units; only
    // their relative order matters, which byte offsets preserve.
    let dot = abs.rfind('.');
    let sep = abs.rfind(nodepath::SEP);
    let has_ext = match (dot, sep) {
        (Some(d), Some(s)) => d > s,
        (Some(_), None) => true,
        _ => false,
    };
    let (stem, ext) = if has_ext {
        abs.split_at(dot.unwrap_or(abs.len()))
    } else {
        (abs, "")
    };

    for n in 2..1000 {
        let candidate = format!("{stem}-{n}{ext}");
        if !error::path_exists(&candidate) {
            return candidate;
        }
    }
    format!("{stem}-{}{ext}", chrono::Utc::now().timestamp_millis())
}

/// The part of a filesystem error worth showing.
///
/// Node repeats the absolute path inside the message, and the caller has
/// already put the path in front of it. `ENOENT: no such file or directory` is
/// what is left, which is the part that says what to fix.
fn reason_of(error: &OkfError) -> String {
    use crate::shared::js_compat::js_regex;
    use regex::Regex;
    use std::sync::LazyLock;
    static TAIL: LazyLock<Regex> =
        LazyLock::new(|| js_regex(r",<S>*(?:open|mkdir|unlink|rename|stat)<S>+'[^']*'<S>*$"));
    TAIL.replace(&error.to_string(), "").into_owned()
}

/// `TextDecoder("utf-8").decode(bytes)`: lossy, and a leading BOM is dropped.
fn decode_utf8(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// Strings in the `tags` frontmatter value, the way `tagCounts` reads it:
/// anything that is an array, keeping the non-empty string elements.
fn tags_of(frontmatter: &ConceptFrontmatter) -> Vec<String> {
    if let Some(tags) = &frontmatter.tags {
        return tags.iter().filter(|t| !t.is_empty()).cloned().collect();
    }
    match frontmatter.extra.get("tags") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|t| t.as_str())
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// Options of [`Bundle::write_file`].
#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    pub actor: Option<String>,
    /// `false` skips the `log.md` entry; anything else logs.
    pub log: Option<bool>,
    pub action: Option<String>,
    pub note: Option<String>,
    pub by: Option<Actor>,
}

/// `WriteFileResult & { concept? }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WriteOutcome {
    #[serde(flatten)]
    pub result: WriteFileResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concept: Option<ConceptDocument>,
}

#[derive(Debug, Clone, Default)]
pub struct MoveOptions {
    pub actor: Option<String>,
    pub by: Option<Actor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    pub moved: String,
    pub updated: Vec<String>,
    pub link_count: usize,
    /// Relation entries that now point nowhere because their text could not be edited safely.
    pub dangling_relations: Vec<DanglingRelation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DanglingRelation {
    pub path: String,
    pub kind: String,
    pub target: String,
}

#[derive(Debug, Clone, Default)]
pub struct PromoteOptions {
    pub actor: Option<String>,
    /// Defaults to `true`: the original stays in `raw/`.
    pub keep_source: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromoteResult {
    pub promoted: String,
    pub source: String,
    pub kept: bool,
}

#[derive(Debug, Clone, Default)]
pub struct DeleteOptions {
    pub actor: Option<String>,
    /// Defaults to `true`.
    pub recursive: Option<bool>,
    pub by: Option<Actor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub deleted: String,
    pub broken_links_from: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    pub actor: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportResult {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnresolvedLink {
    pub from: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
}

pub struct Bundle {
    pub paths: BundlePaths,

    concepts: IndexMap<String, ConceptDocument>,
    backlinks: HashMap<String, Vec<String>>,
    conformance: IndexMap<String, Vec<String>>,

    /// What the layout migration moved on open, if anything.
    pub migration: MigrationResult,

    /// Non-fatal problems from the last open.
    warnings: Vec<String>,
}

impl Bundle {
    /// Open a directory as a bundle.
    ///
    /// A `wiki/` subdirectory switches on the full three-layer layout; without
    /// one the directory *is* the wiki layer, so an existing folder of
    /// Markdown can be opened untouched.
    pub fn open(root: &str) -> Result<Bundle> {
        let abs_root = nodepath::resolve1(root);
        if !error::is_directory(&abs_root) {
            return Err(OkfError::message(messages::not_a_directory(&abs_root)));
        }
        let wiki_dir = if error::is_directory(&nodepath::join(&[&abs_root, WIKI_DIR])) {
            WIKI_DIR
        } else {
            ""
        };
        let paths = BundlePaths::new(&abs_root, wiki_dir);

        // Bundles written before the layout was corrected keep AGENTS.md,
        // skills/ and loops/ at the root. Fix them on open rather than making
        // the user do it: the alternative is an app that silently cannot see
        // its own skills.
        let migration = migrate_layout(&paths).ok();

        let mut bundle = Bundle {
            paths,
            concepts: IndexMap::new(),
            backlinks: HashMap::new(),
            conformance: IndexMap::new(),
            migration: MigrationResult::default(),
            warnings: Vec::new(),
        };
        if let Some(m) = migration {
            bundle.migration = m;
        }
        bundle.reload();
        Ok(bundle)
    }

    pub fn root(&self) -> &str {
        &self.paths.root
    }

    /// Re-read every concept from disk and rebuild the graph.
    pub fn reload(&mut self) {
        let mut found: Vec<ConceptDocument> = Vec::new();
        let mut conformance: IndexMap<String, Vec<String>> = IndexMap::new();
        self.walk(&self.paths.wiki_root(), &mut found, &mut conformance);

        // Two passes: wikilinks can only be resolved once every id is known.
        let known_ids: HashSet<String> = found.iter().map(|d| d.id.clone()).collect();
        for doc in &mut found {
            doc.links = concept_links(&doc.frontmatter, &doc.body, &doc.id, Some(&known_ids), &self.paths.wiki_dir);
        }

        let mut concepts = IndexMap::new();
        for doc in found {
            concepts.insert(doc.id.clone(), doc);
        }
        self.concepts = concepts;
        self.conformance = conformance;
        self.rebuild_backlinks();
    }

    fn rebuild_backlinks(&mut self) {
        let graph: BTreeMap<String, Vec<_>> = self
            .concepts
            .iter()
            .map(|(id, doc)| (id.clone(), doc.links.clone()))
            .collect();
        self.backlinks = build_backlinks(&graph);
    }

    fn walk(
        &self,
        dir: &str,
        out: &mut Vec<ConceptDocument>,
        conformance: &mut IndexMap<String, Vec<String>>,
    ) {
        let Ok(entries) = error::read_dir(dir) else {
            return;
        };

        for entry in entries {
            // Dot-directories cover `.rag`, `.git`, `.obsidian` and friends in one rule.
            if entry.name.starts_with('.') {
                continue;
            }
            let abs = nodepath::join(&[dir, &entry.name]);

            if entry.is_dir {
                if entry.name == RAW_DIR && nodepath::dirname(&abs) == self.paths.root {
                    continue;
                }
                // skills/ and loops/ are wiki content but not knowledge.
                // Scanning them as concepts would put procedures and work logs
                // into the same search results as facts.
                if self.paths.is_subsystem_path(&self.paths.to_rel(&abs)) {
                    continue;
                }
                self.walk(&abs, out, conformance);
                continue;
            }

            if !entry.is_file || !ends_with_ascii_ci(&entry.name, ".md") {
                continue;
            }

            let rel_path = self.paths.to_rel(&abs);
            // Unreadable file: skip rather than fail the whole open.
            let Ok(raw) = error::read_text(&abs) else {
                continue;
            };
            let Ok(meta) = error::stat(&abs) else {
                continue;
            };
            let mtime_ms = error::mtime_ms(&meta);

            let report = check_conformance(&self.paths.to_wiki_rel(&abs), &raw);
            if !report.ok {
                conformance.insert(rel_path.clone(), report.errors);
            }

            // is_concept_path also excludes AGENTS.md, which now lives in wiki/.
            if is_concept_path(&entry.name) {
                out.push(parse_concept(ParseConceptOptions {
                    id: concept_id_from_rel_path(&self.paths.to_wiki_rel(&abs)),
                    rel_path,
                    abs_path: abs,
                    raw,
                    mtime_ms: Some(mtime_ms),
                    known_ids: None,
                    wiki_dir: "",
                }));
            }
        }
    }

    pub fn info(&self) -> BundleInfo {
        BundleInfo {
            root: self.paths.root.clone(),
            wiki_dir: self.paths.wiki_dir.clone(),
            has_agents_md: error::path_exists(&self.paths.agents_md_path()),
            has_index: error::path_exists(&self.paths.index_md_path()),
            has_log: error::path_exists(&self.paths.log_md_path()),
            has_raw: error::is_directory(&self.paths.raw_root()),
            concept_count: self.concepts.len() as u64,
            non_conformant_count: self.conformance.len() as u64,
            warnings: self.warnings.clone(),
        }
    }

    /// Every concept, in the order the TS `Map` iterates them.
    pub fn all_concepts(&self) -> Vec<&ConceptDocument> {
        self.concepts.values().collect()
    }

    pub fn get_concept(&self, id: &str) -> Option<&ConceptDocument> {
        self.concepts.get(id)
    }

    pub fn concept_ids(&self) -> HashSet<String> {
        self.concepts.keys().cloned().collect()
    }

    pub fn backlinks_of(&self, id: &str) -> Vec<String> {
        self.backlinks.get(id).cloned().unwrap_or_default()
    }

    pub fn conformance_issues(&self) -> Vec<ConformanceIssue> {
        let mut issues: Vec<ConformanceIssue> = self
            .conformance
            .iter()
            .map(|(path, errors)| ConformanceIssue {
                path: path.clone(),
                errors: errors.clone(),
            })
            .collect();
        issues.sort_by(|a, b| locale_compare(&a.path, &b.path));
        issues
    }

    /// Resolve a raw link target written inside `from` to a concept id.
    pub fn resolve_link(&self, from: &str, target: &str) -> Option<String> {
        resolve_link_target(target, from, Some(&self.concept_ids()))
    }

    pub fn list_dir(&self, rel: &str, recursive: bool) -> Result<Vec<FileNode>> {
        let dir = self.paths.resolve(rel)?;
        let Ok(entries) = error::read_dir(&dir) else {
            return Ok(Vec::new());
        };

        let mut nodes: Vec<FileNode> = Vec::new();
        for entry in entries {
            // Every dot-directory is hidden, `.rag/` included. It holds SQLite
            // files that are meaningless to read and actively harmful to open,
            // and it rebuilds from Layer 2: there is nothing in it to browse.
            if entry.name.starts_with('.') {
                continue;
            }

            let child_rel = if rel.is_empty() {
                entry.name.clone()
            } else {
                format!("{}/{}", to_posix(rel), entry.name)
            };
            let layer = self.paths.layer_of(&child_rel);
            let mut node = FileNode {
                name: entry.name.clone(),
                path: child_rel.clone(),
                r#type: if entry.is_dir { NodeType::Dir } else { NodeType::File },
                layer,
                children: None,
            };
            if entry.is_dir && recursive {
                node.children = Some(self.list_dir(&child_rel, true)?);
            }
            nodes.push(node);
        }

        nodes.sort_by(|a, b| {
            if a.r#type != b.r#type {
                return if a.r#type == NodeType::Dir {
                    Ordering::Less
                } else {
                    Ordering::Greater
                };
            }
            locale_compare(&a.name, &b.name)
        });
        Ok(nodes)
    }

    /// Whether a path exists. Only "not found" means no: any other fault
    /// (permissions, a file where a folder should be) is an error, so a caller
    /// choosing a free name never overwrites on a guess.
    pub fn exists(&self, rel_path: &str) -> Result<bool> {
        let abs = self.paths.resolve(rel_path)?;
        match error::stat(&abs) {
            Ok(_) => Ok(true),
            Err(e) if e.code == "ENOENT" => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub fn read_file(&mut self, rel_path: &str) -> Result<ReadFileResult> {
        let abs = self.paths.resolve(rel_path)?;
        let bytes = error::read_bytes(&abs)?;
        let mtime_ms = error::mtime_ms(&error::stat(&abs)?);
        let rel = self.paths.to_rel(&abs);

        // Decoding a SQLite database as UTF-8 fills the editor with
        // replacement characters that are indistinguishable from an encoding
        // fault. Report the file for what it is instead.
        let check = inspect(&bytes);
        if check.binary {
            return Ok(ReadFileResult {
                content: String::new(),
                binary: Some(true),
                file_type: check.file_type.map(str::to_string),
                byte_length: Some(bytes.len() as u64),
                concept: None,
                backlinks: Vec::new(),
                mtime_ms,
            });
        }

        let content = decode_utf8(&bytes);

        if !is_concept_path(&rel) {
            return Ok(ReadFileResult {
                content,
                binary: None,
                file_type: None,
                byte_length: None,
                concept: None,
                backlinks: Vec::new(),
                mtime_ms,
            });
        }

        let known_ids = self.concept_ids();
        let concept = parse_concept(ParseConceptOptions {
            id: concept_id_from_rel_path(&self.paths.to_wiki_rel(&abs)),
            rel_path: rel,
            abs_path: abs,
            raw: content.clone(),
            mtime_ms: Some(mtime_ms),
            known_ids: Some(&known_ids),
            wiki_dir: &self.paths.wiki_dir,
        });
        self.index_concept(concept.clone());

        Ok(ReadFileResult {
            content,
            binary: None,
            file_type: None,
            byte_length: None,
            backlinks: self.backlinks_of(&concept.id),
            concept: Some(concept),
            mtime_ms,
        })
    }

    /// Write a file and keep the read model in step.
    ///
    /// Layer rules are enforced here rather than at each call site, so the UI
    /// and the MCP server cannot drift apart on what an agent is allowed to
    /// touch.
    pub fn write_file(&mut self, rel_path: &str, content: &str, opts: &WriteOptions) -> Result<WriteOutcome> {
        let abs = self.paths.assert_writable(rel_path, opts.by.unwrap_or_default())?;
        error::mkdir_p(&nodepath::dirname(&abs))?;
        error::write_text(&abs, content)?;

        let mtime_ms = error::mtime_ms(&error::stat(&abs)?);
        let rel = self.paths.to_rel(&abs);

        // Keep the conformance report in step with the write, so a
        // bundle-wide check reflects what is on disk rather than what was
        // there at open time.
        let report = check_conformance(&self.paths.to_wiki_rel(&abs), content);
        if report.ok {
            self.conformance.shift_remove(&rel);
        } else {
            self.conformance.insert(rel.clone(), report.errors.clone());
        }

        let mut concept: Option<ConceptDocument> = None;
        if is_concept_path(&rel) {
            let known_ids = self.concept_ids();
            let parsed = parse_concept(ParseConceptOptions {
                id: concept_id_from_rel_path(&self.paths.to_wiki_rel(&abs)),
                rel_path: rel.clone(),
                abs_path: abs.clone(),
                raw: content.to_string(),
                mtime_ms: Some(mtime_ms),
                known_ids: Some(&known_ids),
                wiki_dir: &self.paths.wiki_dir,
            });
            self.index_concept(parsed.clone());
            concept = Some(parsed);
        }

        if opts.log != Some(false) {
            self.append_log(&LogEntry {
                at: now_iso(),
                actor: opts.actor.clone().unwrap_or_else(|| "human:local".into()),
                action: opts.action.clone().unwrap_or_else(|| "write".into()),
                path: rel,
                note: opts.note.clone().filter(|n| !n.is_empty()),
            })?;
        }

        Ok(WriteOutcome {
            result: WriteFileResult::new(mtime_ms, report.errors),
            concept,
        })
    }

    /// Refresh a single path from disk after an external change.
    pub fn refresh(&mut self, rel_path: &str) -> Result<Option<ConceptDocument>> {
        let abs = self.paths.resolve(rel_path)?;
        let rel = self.paths.to_rel(&abs);

        if !error::path_exists(&abs) {
            let id = concept_id_from_rel_path(&self.paths.to_wiki_rel(&abs));
            self.concepts.shift_remove(&id);
            self.conformance.shift_remove(&rel);
            self.rebuild_backlinks();
            return Ok(None);
        }

        if !ends_with_ascii_ci(&rel, ".md") {
            return Ok(None);
        }

        let content = error::read_text(&abs)?;
        let report = check_conformance(&self.paths.to_wiki_rel(&abs), &content);
        if report.ok {
            self.conformance.shift_remove(&rel);
        } else {
            self.conformance.insert(rel.clone(), report.errors);
        }

        if !is_concept_path(&rel) {
            return Ok(None);
        }

        let known_ids = self.concept_ids();
        let concept = parse_concept(ParseConceptOptions {
            id: concept_id_from_rel_path(&self.paths.to_wiki_rel(&abs)),
            rel_path: rel,
            abs_path: abs.clone(),
            raw: content,
            mtime_ms: Some(error::mtime_ms(&error::stat(&abs)?)),
            known_ids: Some(&known_ids),
            wiki_dir: &self.paths.wiki_dir,
        });
        self.index_concept(concept.clone());
        Ok(Some(concept))
    }

    fn index_concept(&mut self, concept: ConceptDocument) {
        self.concepts.insert(concept.id.clone(), concept);
        self.rebuild_backlinks();
    }

    /// Create a directory inside the bundle.
    pub fn create_directory(&self, rel_path: &str, by: Actor) -> Result<()> {
        let abs = self.paths.assert_writable(rel_path, by)?;
        error::mkdir_p(&abs)?;
        Ok(())
    }

    /// Move or rename a file, updating every link that pointed at it.
    ///
    /// Returns the documents that were rewritten, so the caller can reindex
    /// them. A rename that silently broke inbound links would be worse than no
    /// rename at all, so this is one operation rather than a move plus a
    /// manual fixup.
    pub fn move_path(&mut self, from_rel: &str, to_rel: &str, opts: &MoveOptions) -> Result<MoveResult> {
        let by = opts.by.unwrap_or_default();
        // Crossing layers is a curation decision with its own rule;
        // `assert_writable` only answers "may this path be edited".
        self.paths.assert_movable(from_rel, to_rel, by)?;

        let from_abs = self.paths.resolve(from_rel)?;
        let to_abs = self.paths.assert_writable(to_rel, by)?;

        if !error::path_exists(&from_abs) {
            return Err(OkfError::message(messages::not_found(from_rel)));
        }
        if error::path_exists(&to_abs) {
            return Err(OkfError::message(messages::already_exists(to_rel)));
        }

        let was_concept = is_concept_path(&self.paths.to_rel(&from_abs));
        let old_id = concept_id_from_rel_path(&self.paths.to_wiki_rel(&from_abs));
        let new_id = concept_id_from_rel_path(&self.paths.to_wiki_rel(&to_abs));

        // Link resolution has to use the pre-move id set, because that is what
        // made each existing link point where it does.
        let known_ids = self.concept_ids();
        let mut updated: Vec<String> = Vec::new();
        let mut dangling_relations: Vec<DanglingRelation> = Vec::new();
        let mut link_count = 0usize;

        if was_concept && is_concept_path(&self.paths.to_rel(&to_abs)) && old_id != new_id {
            // The moved document's own relative links are rebased before it
            // moves, while its old location is still the anchor they were
            // written against.
            let source = error::read_text(&from_abs)?;
            let frontmatter = parse_frontmatter_map(split_frontmatter(&source).yaml.as_deref());
            let own = rebase_own_relations(
                &source,
                frontmatter.get("relations"),
                &old_id,
                &new_id,
                &known_ids,
                &self.paths.wiki_dir,
            );
            let split = split_frontmatter(&own.raw);
            let rebased = rebase_own_links(&split.body, &old_id, &new_id, &known_ids);
            if rebased.count > 0 || own.count > 0 {
                let text = match (&split.yaml, rebased.count > 0) {
                    (_, false) => own.raw.clone(),
                    (None, true) => rebased.body.clone(),
                    (Some(yaml), true) => join_frontmatter(yaml, &rebased.body, Eol::Lf),
                };
                error::write_text(&from_abs, &text)?;
                link_count += rebased.count + own.count;
            }
            let new_rel = self.paths.to_rel(&to_abs);
            for (kind, target) in own.unsafe_entries {
                dangling_relations.push(DanglingRelation { path: new_rel.clone(), kind, target });
            }
        }

        error::mkdir_p(&nodepath::dirname(&to_abs))?;
        error::rename(&from_abs, &to_abs)?;

        if was_concept && old_id != new_id {
            let candidates: Vec<(String, String, String)> = self
                .concepts
                .iter()
                .filter(|(id, doc)| {
                    **id != old_id
                        && doc.links.iter().any(|l| l.resolved.as_deref() == Some(old_id.as_str()))
                })
                .map(|(id, doc)| (id.clone(), doc.path.clone(), doc.rel_path.clone()))
                .collect();

            for (id, path, rel_path) in candidates {
                let source = error::read_text(&path)?;
                // Typed relations first: they are edited in the frontmatter text
                // in place, and whatever cannot be is reported rather than left
                // silent.
                let frontmatter = parse_frontmatter_map(split_frontmatter(&source).yaml.as_deref());
                let moved = relations_after_move(
                    &source,
                    frontmatter.get("relations"),
                    &id,
                    &old_id,
                    &new_id,
                    &known_ids,
                    &self.paths.wiki_dir,
                );
                for (kind, target) in moved.unsafe_entries {
                    dangling_relations.push(DanglingRelation { path: rel_path.clone(), kind, target });
                }
                let split = split_frontmatter(&moved.raw);
                let result = rewrite_links(&split.body, &id, &old_id, &new_id, &known_ids);
                if result.count == 0 && moved.count == 0 {
                    continue;
                }

                let text = match &split.yaml {
                    _ if result.count == 0 => moved.raw.clone(),
                    None => result.body.clone(),
                    Some(yaml) => join_frontmatter(yaml, &result.body, Eol::Lf),
                };
                error::write_text(&path, &text)?;
                updated.push(rel_path);
                link_count += result.count + moved.count;
            }
        }

        self.reload();

        if let Some(actor) = &opts.actor {
            self.append_log(&LogEntry {
                at: now_iso(),
                actor: actor.clone(),
                action: "move".into(),
                path: format!("{} \u{2192} {}", self.paths.to_rel(&from_abs), self.paths.to_rel(&to_abs)),
                note: (link_count > 0).then(|| format!("{link_count} link(s) updated")),
            })?;
        }

        Ok(MoveResult {
            moved: self.paths.to_rel(&to_abs),
            updated,
            link_count,
            dangling_relations,
        })
    }

    /// Bring a file up from `raw/` into the wiki layer.
    ///
    /// This is the curation step made explicit. By default the original stays
    /// where it is and the new file records where it came from: `raw/` is the
    /// record of what was actually received, and a wiki page whose source has
    /// been moved away cannot be checked against it.
    ///
    /// `keep_source: Some(false)` performs a true move, for the case where
    /// something simply landed in the wrong place.
    pub fn promote_from_raw(&mut self, from_rel: &str, to_rel: &str, opts: &PromoteOptions) -> Result<PromoteResult> {
        let keep = opts.keep_source != Some(false);

        // Promotion is human-only; `assert_movable` is where that is decided.
        self.paths.assert_movable(from_rel, to_rel, Actor::Human)?;

        let from_abs = self.paths.resolve(from_rel)?;
        if self.paths.layer_of(&self.paths.to_rel(&from_abs)) != Some(crate::shared::types::Layer::Raw) {
            // A distinct error: the file may well exist, it is just not promotable.
            return Err(OkfError::message(messages::promote_only_from_raw(from_rel)));
        }
        if !error::path_exists(&from_abs) {
            return Err(OkfError::message(messages::not_found(from_rel)));
        }

        let to_abs = unique_path(&self.paths.assert_writable(to_rel, Actor::Human)?);
        error::mkdir_p(&nodepath::dirname(&to_abs))?;

        if keep {
            error::copy_file(&from_abs, &to_abs)?;
        } else {
            error::rename(&from_abs, &to_abs)?;
        }

        let promoted = self.paths.to_rel(&to_abs);
        self.append_log(&LogEntry {
            at: now_iso(),
            actor: opts.actor.clone().unwrap_or_else(|| "human:local".into()),
            action: if keep { "promote-copy" } else { "promote" }.into(),
            path: promoted.clone(),
            note: Some(format!("from {}", self.paths.to_rel(&from_abs))),
        })?;

        self.refresh(&promoted)?;
        Ok(PromoteResult {
            promoted,
            source: self.paths.to_rel(&from_abs),
            kept: keep,
        })
    }

    /// Delete a file or directory.
    ///
    /// Inbound links are reported rather than rewritten: there is no correct
    /// target to point them at, and quietly stripping them would destroy the
    /// record that something used to be there.
    pub fn delete_path(&mut self, rel_path: &str, opts: &DeleteOptions) -> Result<DeleteResult> {
        let abs = self.paths.assert_writable(rel_path, opts.by.unwrap_or_default())?;
        let rel = self.paths.to_rel(&abs);

        if is_reserved_filename(basename_of(&rel)) {
            return Err(OkfError::message(messages::reserved_cannot_delete(&rel)));
        }
        // The reserved-file check above only sees the basename of the target,
        // so without this a recursive delete of a layer root would take
        // index.md and log.md, and everything else, with it in one call.
        // Compared with `same_path`, not `==`: on Windows and macOS `WIKI` and
        // `wiki` are the same directory, so a case-sensitive check is one an
        // agent walks around.
        let roots = [
            self.paths.root.clone(),
            self.paths.wiki_root(),
            self.paths.raw_root(),
            self.paths.rag_root(),
        ];
        if roots.iter().any(|root| same_path(&abs, root)) {
            let shown = if rel.is_empty() { "." } else { rel.as_str() };
            return Err(OkfError::message(messages::layer_root_cannot_delete(shown)));
        }
        if !error::path_exists(&abs) {
            return Err(OkfError::message(messages::not_found(rel_path)));
        }

        let id = concept_id_from_rel_path(&self.paths.to_wiki_rel(&abs));
        let broken_links_from = if is_concept_path(&rel) {
            self.backlinks_of(&id)
        } else {
            Vec::new()
        };

        error::remove(&abs, opts.recursive.unwrap_or(true))?;
        self.reload();

        if let Some(actor) = &opts.actor {
            self.append_log(&LogEntry {
                at: now_iso(),
                actor: actor.clone(),
                action: "delete".into(),
                path: rel.clone(),
                note: (!broken_links_from.is_empty())
                    .then(|| format!("{} inbound link(s) now broken", broken_links_from.len())),
            })?;
        }

        Ok(DeleteResult {
            deleted: rel,
            broken_links_from,
        })
    }

    /// Capture a new source file into Layer 1.
    ///
    /// `raw/` is immutable in the sense that matters: a source, once captured,
    /// is never altered or replaced. Capturing a *new* one is how material
    /// gets in at all, so this is the one narrow way to write there, and it
    /// refuses to overwrite, choosing a fresh name instead, so no previously
    /// captured source can be lost.
    pub fn import_to_raw(&self, rel_path: &str, content: &str, opts: &ImportOptions) -> Result<ImportResult> {
        let abs = self.paths.resolve(rel_path)?;
        if !is_contained(&self.paths.raw_root(), &abs) {
            return Err(OkfError::message(messages::import_outside_raw(rel_path)));
        }

        let unique = unique_path(&abs);
        error::mkdir_p(&nodepath::dirname(&unique))?;
        error::write_text(&unique, content)?;

        let rel = self.paths.to_rel(&unique);
        self.append_log(&LogEntry {
            at: now_iso(),
            actor: opts.actor.clone().unwrap_or_else(|| "process:import".into()),
            action: "create".into(),
            path: rel.clone(),
            note: opts.note.clone().filter(|n| !n.is_empty()),
        })?;

        Ok(ImportResult { path: rel })
    }

    /// Every tag in the bundle with its usage count, in first-seen order.
    pub fn tag_counts(&self) -> IndexMap<String, u64> {
        let mut counts: IndexMap<String, u64> = IndexMap::new();
        for doc in self.concepts.values() {
            for tag in tags_of(&doc.frontmatter) {
                *counts.entry(tag).or_insert(0) += 1;
            }
        }
        counts
    }

    /// Concepts whose wikilinks, or typed relations, point at ids that do not
    /// exist yet. A relation says which kind it was.
    pub fn unresolved_links(&self) -> Vec<UnresolvedLink> {
        let mut out = Vec::new();
        for doc in self.concepts.values() {
            for link in &doc.links {
                if link.resolved.is_some() {
                    continue;
                }
                match link.kind {
                    LinkKind::Wikilink => out.push(UnresolvedLink {
                        from: doc.id.clone(),
                        target: link.target.clone(),
                        relation: None,
                    }),
                    LinkKind::Relation => out.push(UnresolvedLink {
                        from: doc.id.clone(),
                        target: link.target.clone(),
                        relation: link.relation.clone(),
                    }),
                    LinkKind::Markdown => {}
                }
            }
        }
        out
    }

    /// Create `index.md` and `log.md` if absent. Never overwrites.
    ///
    /// Never fatal, either. These two files are a convenience, an entry point
    /// and a history, and the folder's actual contents are readable without
    /// them, so a name that cannot be written must not cost the user the
    /// whole bundle. Failures are collected into `warnings` and surfaced in
    /// [`info`](Self::info).
    pub fn ensure_reserved_files(&mut self) {
        self.warnings = Vec::new();

        if let Err(e) = error::mkdir_p(&self.paths.wiki_root()) {
            self.warnings.push(messages::reserved_file_not_created(
                &self.paths.wiki_root(),
                &reason_of(&OkfError::from(e)),
            ));
            return;
        }

        let index_path = self.paths.index_md_path();
        self.ensure_reserved_file(&index_path, |bundle| bundle.render_index());
        let log_path = self.paths.log_md_path();
        self.ensure_reserved_file(&log_path, |_| empty_log_md("Log"));
    }

    /// Create a wiki sub-folder with an `index.md` if it has none.
    ///
    /// For folders that appeared after a bundle was made (know-how,
    /// activity): a bundle scaffolded earlier gets them on the first write
    /// instead of needing a migration. Returns the index's bundle-relative
    /// path when it was created. Never fatal, for the same reason
    /// `ensure_reserved_files` is not.
    pub fn ensure_folder_index(&self, dir: &str, title: &str) -> Option<String> {
        let index = nodepath::join(&[&self.paths.wiki_root(), dir, "index.md"]);
        if error::path_exists(&index) {
            return None;
        }
        let parent = nodepath::join(&[&self.paths.wiki_root(), dir]);
        error::mkdir_p(&parent).ok()?;
        error::write_text(&index, &render_index_md(title, &[], &IndexOptions::default())).ok()?;
        Some(self.paths.to_rel(&index))
    }

    fn ensure_reserved_file(&mut self, abs: &str, render: impl FnOnce(&Bundle) -> String) {
        if error::path_exists(abs) {
            return;
        }
        let content = render(self);
        if let Err(e) = error::write_text(abs, &content) {
            self.warnings
                .push(messages::reserved_file_not_created(abs, &reason_of(&OkfError::from(e))));
        }
    }

    /// Build the bundle-root `index.md` (OKF section 8).
    ///
    /// Concepts are grouped into sections by their top-level directory, which
    /// is what "progressive disclosure" means here: the reader sees the shape
    /// of the bundle before any individual page. Links use the
    /// bundle-absolute form the spec recommends, so they survive a document
    /// moving within its directory.
    fn render_index(&self) -> String {
        let mut docs: Vec<&ConceptDocument> = self.concepts.values().collect();
        docs.sort_by(|a, b| locale_compare(&a.id, &b.id));

        let mut grouped: IndexMap<String, IndexSection> = IndexMap::new();
        for doc in docs {
            let heading = match doc.id.find('/') {
                Some(i) => doc.id[..i].to_string(),
                None => "Concepts".to_string(),
            };
            let section = grouped.entry(heading.clone()).or_insert_with(|| IndexSection {
                heading,
                entries: Vec::new(),
            });
            let description = doc
                .frontmatter
                .description
                .as_ref()
                .filter(|d| !crate::shared::js_compat::js_trim(d).is_empty())
                .cloned();
            section.entries.push(IndexEntry {
                href: format!("/{}.md", doc.id),
                title: concept_title(&doc.id, &doc.frontmatter),
                description,
            });
        }

        // Root-level concepts first, then subdirectories alphabetically.
        let mut sections: Vec<IndexSection> = grouped.into_values().collect();
        sections.sort_by(|a, b| {
            if a.heading == "Concepts" {
                return Ordering::Less;
            }
            if b.heading == "Concepts" {
                return Ordering::Greater;
            }
            locale_compare(&a.heading, &b.heading)
        });

        render_index_md(
            basename_of(&self.paths.root),
            &sections,
            &IndexOptions {
                okf_version: Some(OKF_VERSION.to_string()),
            },
        )
    }

    /// Regenerate `index.md` from the current concept set.
    pub fn rebuild_index_md(&mut self) -> Result<usize> {
        self.reload();
        let content = self.render_index();
        error::mkdir_p(&self.paths.wiki_root())?;
        error::write_text(&self.paths.index_md_path(), &content)?;
        Ok(self.concepts.len())
    }

    /// The `okf_version` declared by the bundle-root `index.md`, if any.
    pub fn read_okf_version(&self) -> Option<String> {
        error::read_text(&self.paths.index_md_path())
            .ok()
            .and_then(|text| read_okf_version(&text))
    }

    /// Record one entry in `log.md` (OKF section 9).
    ///
    /// The format is date-grouped and newest-first, so this is a
    /// read-modify-write rather than an append: a new entry goes at the *top*
    /// of today's section. Cost is bounded by the log's size, which is the
    /// price of a format a human can actually read.
    pub fn append_log(&self, entry: &LogEntry) -> Result<()> {
        let path = self.paths.log_md_path();
        error::mkdir_p(&self.paths.wiki_root())?;

        let existing = error::read_text(&path).unwrap_or_else(|_| empty_log_md("Log"));
        error::write_text(&path, &insert_log_entry(&existing, entry))?;
        Ok(())
    }

    /// The change log, or an empty one when it has not been written yet.
    pub fn read_log(&self) -> String {
        error::read_text(&self.paths.log_md_path()).unwrap_or_else(|_| empty_log_md("Log"))
    }

    pub fn read_agents_md(&self) -> Option<String> {
        error::read_text(&self.paths.agents_md_path())
            // Bundles written before the layout was corrected keep it at the
            // root. Refusing to read it would silently strip an agent of its
            // contract.
            .or_else(|_| error::read_text(&self.paths.legacy_agents_md_path()))
            .ok()
    }

    // ---- orientation files -------------------------------------------------

    /// The routing table, regenerated on read when it is missing.
    ///
    /// Written rather than returned in memory so the file exists for a human
    /// to open, and because the next reader should not have to generate it
    /// again.
    pub fn read_map(&self) -> Result<String> {
        let previous = error::read_text(&self.paths.map_md_path()).ok();

        // Always re-render: the generated half describes the layout this build
        // implements, so a stale MAP would send an agent to the wrong place.
        // The user's own half is carried through untouched.
        let rendered = render_map(previous.as_deref());
        if previous.as_deref() != Some(rendered.as_str()) {
            let map_path = self.paths.map_md_path();
            error::mkdir_p(&nodepath::dirname(&map_path))?;
            error::write_text(&map_path, &rendered)?;
        }
        Ok(rendered)
    }

    pub fn read_human(&self) -> Option<String> {
        error::read_text(&self.paths.human_md_path()).ok()
    }

    pub fn write_human(&self, content: &str) -> Result<()> {
        let path = self.paths.human_md_path();
        error::mkdir_p(&nodepath::dirname(&path))?;
        error::write_text(&path, content)?;
        Ok(())
    }

    pub fn read_task_file(&self) -> TaskFile {
        match error::read_text(&self.paths.task_md_path()) {
            Ok(text) => parse_tasks(&text),
            Err(_) => TaskFile {
                tasks: Vec::new(),
                done_ever: 0,
            },
        }
    }

    pub fn write_task_file(&self, file: &TaskFile) -> Result<()> {
        let path = self.paths.task_md_path();
        error::mkdir_p(&nodepath::dirname(&path))?;
        error::write_text(&path, &render_tasks(file))?;
        Ok(())
    }
}
