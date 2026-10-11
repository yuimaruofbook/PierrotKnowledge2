//! The application core: one open bundle, its search index, and its watcher
//! (`src/bun/workspace.ts`).
//!
//! Both front ends drive this same object, which is what makes human and agent
//! edits symmetric: one write path, one layer check, one index update.
//!
//! The TS is `async` and its watcher fires from a timer. Everything here is
//! synchronous, and watcher events are applied by [`Workspace::poll_watcher`],
//! which the server calls between requests.

use crate::okf::bundle::{
    Bundle, DeleteOptions, DeleteResult, MoveOptions, MoveResult, PromoteOptions, PromoteResult,
    UnresolvedLink, WriteOptions,
};
use crate::okf::error::{OkfError, Result};
use crate::okf::loops::{EndOptions, LoopEndResult, LoopSpace, LoopStartResult, StartOptions};
use crate::okf::nodepath;
use crate::okf::parser::{
    frontmatter_record, parse_yaml, skeleton_concept, ConceptSkeletonOptions,
};
use crate::okf::paths::{Actor, LOOPS_DIR, RAG_DIR, SKILLS_DIR};
use crate::okf::scaffold::{scaffold_bundle, ScaffoldResult};
use crate::okf::skills::SkillSpace;
use crate::rag::context_pack::{
    group_passages, ContextPack, ContextPackKnowhow, ContextPackSkill, ContextTier,
};
use crate::rag::fts::{FtsError, FtsIndex, SearchOptions};
use crate::rag::retrieve::{retrieve, RetrieveOptions, DEFAULT_BUDGET_CHARS};
use crate::shared::js_compat::{js_round, js_trim, locale_compare, serialize_js_f64, utf16_len};
use crate::shared::messages;
use crate::shared::okf::activity::{
    activity_rel_path, filter_activity, summarize_activity as summarize_rows, ActivityFilter,
    ACTIVITY_DIR, ACTIVITY_TITLE, ACTIVITY_TYPE,
};
use crate::shared::okf::base::{
    is_base_path, list_views, render_base_markdown, run_base, validate_base, BaseResult, RunOptions, BASE_EXT,
};
use crate::shared::okf::base_expr::BaseRow;
use crate::shared::okf::concept::{concept_id_from_rel_path, concept_title, is_concept_path};
use crate::shared::okf::frontmatter::split_frontmatter;
use crate::shared::okf::knowhow::{
    derive_description, knowhow_slug_default, KNOWHOW_DIR, KNOWHOW_TITLE, KNOWHOW_TYPE,
};
use crate::shared::okf::lifecycle::{
    lifecycle_of, set_lifecycle_in_document, with_lifecycle, Lifecycle, LifecycleChoice,
};
use crate::shared::okf::daily::{
    daily_id, daily_rel_path, daily_template, daily_title, mark_transferred, pending_task_lines,
};
use crate::shared::okf::links::resolve_link_target;
use crate::shared::okf::loop_::LoopSnapshot;
use crate::shared::okf::para::{reclassify, within_para_depth, ParaClass};
use crate::shared::okf::reserved::{iso_date_of, parse_log_entries, ParsedLogEntry};
use crate::shared::okf::skill_rank::{rank_skills, selection_confidence, Confidence, Rankable};
use crate::shared::okf::workspace_files::{
    next_task_id, open_tasks, render_human_template, Task, TaskFile, TaskStatus,
};
use crate::shared::types::{
    Layer, BundleInfo, ChunkHit, ConceptDocument, ConformanceIssue, FileNode, LinkedFile, ReadFileResult,
    RetrievalResult, SearchFilters, SearchHit, TagCount, WriteFileResult,
};
use crate::watch::BundleWatcher;
use chrono::{DateTime, Local, Utc};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

/// How long a self-inflicted write suppresses watcher events for that path.
/// Long enough to outlast the OS event, short enough that a genuine external
/// edit moments later is still seen.
const SELF_WRITE_GRACE: Duration = Duration::from_millis(750);

/// Called with the bundle-relative paths that changed outside the app.
pub type ExternalChangeHandler = Box<dyn FnMut(&[String], &BundleInfo)>;

/// Receives watcher and reconciliation failures as text.
pub type ErrorHandler = Rc<dyn Fn(&str)>;

#[derive(Default)]
pub struct WorkspaceOptions {
    /// Enable filesystem watching (`None` means on, as in the TS). Off for
    /// one-shot CLI use.
    pub watch: Option<bool>,
    pub on_external_change: Option<ExternalChangeHandler>,
    pub on_error: Option<ErrorHandler>,
}

fn no_bundle() -> OkfError {
    OkfError::message(messages::NO_BUNDLE_OPEN)
}

fn fts_err(error: FtsError) -> OkfError {
    OkfError::message(error.to_string())
}

fn docs_of(bundle: &Bundle) -> Vec<crate::shared::types::ConceptDocument> {
    bundle.all_concepts().into_iter().cloned().collect()
}

#[derive(Debug, Clone, Default)]
pub struct TaskInput {
    pub title: String,
    pub status: Option<TaskStatus>,
    pub para: Option<ParaClass>,
    pub due: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TaskChanges {
    pub status: Option<TaskStatus>,
    pub title: Option<String>,
    pub para: Option<ParaClass>,
    pub due: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConceptListing {
    pub id: String,
    pub path: String,
    pub title: String,
    pub r#type: String,
    /// Only a marked concept carries the key, so an unmarked entry looks as
    /// it always did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<&'static str>,
}

/// `setLifecycle` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetLifecycleResult {
    pub path: String,
    pub lifecycle: LifecycleChoice,
    pub changed: bool,
}

/// One know-how note in a `knowhow_find` answer: titles, descriptions, scores
/// and who recorded it, never the body.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KnowhowRanked {
    pub title: String,
    pub path: String,
    pub description: String,
    pub by: String,
    #[serde(serialize_with = "serialize_js_f64")]
    pub score: f64,
    pub matched: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KnowhowFound {
    pub ranked: Vec<KnowhowRanked>,
    pub confidence: Confidence,
}

/// `summarizeActivity` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityResult {
    pub total: usize,
    pub markdown: String,
    pub saved: Option<String>,
}

struct KnowhowCandidate {
    name: String,
    description: String,
    tags: Vec<String>,
    path: String,
    by: String,
}

impl Rankable for KnowhowCandidate {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn tags(&self) -> &[String] {
        &self.tags
    }
}

struct FollowedLinks {
    linked: Vec<LinkedFile>,
    used_chars: u64,
    truncated: bool,
}

/// A concept tags that are strings, which is all the index and lifecycle
/// read.
fn tags_of(doc: &ConceptDocument) -> Vec<String> {
    doc.frontmatter.string_tags()
}

/// Whether a concept passes the `type` / `tags` / `path_prefix` filters, with
/// the same rules the index applies to searches (so a link or a know-how note
/// is held to what a passage would be).
fn matches_filters(doc: &ConceptDocument, filters: &SearchFilters) -> bool {
    if let Some(kind) = filters.r#type.as_deref().filter(|t| !t.is_empty()) {
        if doc.frontmatter.r#type != kind {
            return false;
        }
    }
    if let Some(prefix) = filters.path_prefix.as_deref().filter(|p| !p.is_empty()) {
        let prefix = prefix.replace(['%', '_'], "").to_ascii_lowercase();
        if !doc.rel_path.to_ascii_lowercase().starts_with(&prefix) {
            return false;
        }
    }
    let tags: Vec<String> = tags_of(doc).iter().map(|t| t.to_ascii_lowercase()).collect();
    filters
        .tags
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .all(|tag| tags.contains(&tag.to_ascii_lowercase()))
}

#[derive(Debug, Clone, Serialize)]
pub struct ActorAudit {
    pub actor: String,
    pub count: usize,
    pub entries: Vec<ParsedLogEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditResult {
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    pub actors: Vec<ActorAudit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetParaResult {
    pub from: String,
    pub to: String,
    pub para: ParaClass,
    pub moved: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexStats {
    pub documents: u64,
    pub chunks: u64,
}

pub struct Workspace {
    options: WorkspaceOptions,
    bundle: Option<Bundle>,
    fts: Option<FtsIndex>,
    skill_space: Option<SkillSpace>,
    loop_space: Option<LoopSpace>,
    watcher: Option<BundleWatcher>,
    self_writes: HashMap<String, Instant>,
}

impl Workspace {
    pub fn new(options: WorkspaceOptions) -> Self {
        Self {
            options,
            bundle: None,
            fts: None,
            skill_space: None,
            loop_space: None,
            watcher: None,
            self_writes: HashMap::new(),
        }
    }

    pub fn is_open(&self) -> bool {
        self.bundle.is_some()
    }

    /// The open bundle, or a clear error naming the fix.
    pub fn require_bundle(&self) -> Result<&Bundle> {
        self.bundle.as_ref().ok_or_else(no_bundle)
    }

    pub fn require_bundle_mut(&mut self) -> Result<&mut Bundle> {
        self.bundle.as_mut().ok_or_else(no_bundle)
    }

    /// The index is created and destroyed with the bundle, so "no index"
    /// always means "no bundle".
    fn require_fts(&self) -> Result<&FtsIndex> {
        self.require_bundle()?;
        self.fts.as_ref().ok_or_else(no_bundle)
    }

    pub fn open(&mut self, path: &str) -> Result<BundleInfo> {
        self.close();

        let mut bundle = Bundle::open(path)?;
        bundle.ensure_reserved_files();

        let mut fts = FtsIndex::new(nodepath::join(&[&bundle.paths.root, RAG_DIR, "fts.sqlite"]));
        fts.open().map_err(fts_err)?;
        fts.sync(&docs_of(&bundle)).map_err(fts_err)?;

        let skill_space = SkillSpace::new(bundle.paths.clone());
        let mut loop_space = LoopSpace::new(bundle.paths.clone());
        // Pick up a loop left open by a previous session, so the one-open-loop
        // rule survives a restart rather than being reset by it.
        let _ = loop_space.resume();
        let info = bundle.info();

        self.bundle = Some(bundle);
        self.fts = Some(fts);
        self.skill_space = Some(skill_space);
        self.loop_space = Some(loop_space);

        if self.options.watch != Some(false) {
            self.start_watching();
        }
        Ok(info)
    }

    pub fn close(&mut self) {
        if let Some(watcher) = self.watcher.as_mut() {
            watcher.stop();
        }
        self.watcher = None;
        if let Some(fts) = self.fts.as_mut() {
            fts.close();
        }
        self.fts = None;
        self.skill_space = None;
        self.loop_space = None;
        self.bundle = None;
        self.self_writes.clear();
    }

    fn report_error(&self, message: &str) {
        if let Some(on_error) = &self.options.on_error {
            on_error(message);
        }
    }

    fn start_watching(&mut self) {
        let Some(bundle) = self.bundle.as_ref() else { return };
        let on_error: ErrorHandler = self
            .options
            .on_error
            .clone()
            .unwrap_or_else(|| Rc::new(|_| {}));
        let mut watcher = BundleWatcher::new(&bundle.paths.root, None, on_error);
        watcher.start();
        self.watcher = Some(watcher);
    }

    fn mark_self_write(&mut self, rel_path: &str) {
        self.self_writes.insert(rel_path.to_string(), Instant::now());
        if let Some(watcher) = self.watcher.as_mut() {
            watcher.ignore_next(rel_path);
        }
    }

    /// Suppress the watcher event for the `log.md` row an operation is about
    /// to append. Every mutating operation writes one, so every one of them
    /// owes this call.
    fn mark_log_write(&mut self) -> Result<()> {
        let bundle = self.require_bundle()?;
        let rel = bundle.paths.to_rel(&bundle.paths.log_md_path());
        self.mark_self_write(&rel);
        Ok(())
    }

    fn is_self_write(&mut self, rel_path: &str) -> bool {
        let Some(at) = self.self_writes.get(rel_path).copied() else {
            return false;
        };
        if at.elapsed() > SELF_WRITE_GRACE {
            self.self_writes.remove(rel_path);
            return false;
        }
        true
    }

    /// Apply watcher events that have settled. The server calls this between
    /// requests.
    pub fn poll_watcher(&mut self) {
        let Some(watcher) = self.watcher.as_mut() else { return };
        let paths = watcher.poll();
        if !paths.is_empty() {
            self.handle_external_change(&paths);
        }
    }

    /// Reconcile the read model and the index with what changed on disk.
    fn handle_external_change(&mut self, paths: &[String]) {
        if self.bundle.is_none() {
            return;
        }
        let external: Vec<String> = paths
            .iter()
            .filter(|p| !self.is_self_write(p))
            .cloned()
            .collect();
        if external.is_empty() {
            return;
        }

        for path in &external {
            let Some(bundle) = self.bundle.as_mut() else { return };
            // skills/ and loops/ are procedures and work logs, not knowledge:
            // the concept scan leaves them out, and the TS refresh forgets to,
            // which would index a loop file as soon as the watcher saw it.
            if bundle.paths.is_subsystem_path(path) {
                continue;
            }
            let id = id_of(bundle, path);
            let before = bundle.get_concept(&id).map(|c| c.id.clone());
            match bundle.refresh(path) {
                Ok(concept) => {
                    let outcome = match (&concept, &before) {
                        (Some(concept), _) => self.fts.as_ref().map(|f| f.upsert(concept)),
                        (None, Some(id)) => self.fts.as_ref().map(|f| f.remove(id)),
                        (None, None) => None,
                    };
                    if let Some(Err(error)) = outcome {
                        self.report_error(&error.to_string());
                    }
                }
                Err(error) => self.report_error(&error.to_string()),
            }
        }

        // A skill edited on disk must be visible to the next request; the
        // catalogue is small, so dropping all of it is cheaper than tracking
        // which entry each path belonged to.
        let prefix = format!("{SKILLS_DIR}/");
        if external.iter().any(|p| p.starts_with(&prefix)) {
            if let Some(skills) = self.skill_space.as_mut() {
                skills.invalidate();
            }
        }

        if let (Some(callback), Some(bundle)) =
            (self.options.on_external_change.as_mut(), self.bundle.as_ref())
        {
            callback(&external, &bundle.info());
        }
    }

    /// Bring a file up from `raw/` into the wiki layer. Human-only by
    /// contract, so there is no `by` parameter.
    pub fn promote(&mut self, from: &str, to: &str, opts: &PromoteOptions) -> Result<PromoteResult> {
        self.require_bundle()?;
        self.mark_self_write(to);
        self.mark_log_write()?;

        let bundle = self.require_bundle_mut()?;
        let result = bundle.promote_from_raw(from, to, opts)?;
        let docs = docs_of(bundle);
        if let Some(fts) = &self.fts {
            fts.sync(&docs).map_err(fts_err)?;
        }
        self.journal("promote", &format!("{} → {}", result.source, result.promoted));
        Ok(result)
    }

    /// Refile a concept under a different PARA class.
    ///
    /// A move, not a metadata edit: the class *is* the folder, so archiving is
    /// something a person can see in the tree and undo by dragging back.
    pub fn set_para(
        &mut self,
        path: &str,
        to: ParaClass,
        by: Actor,
        actor: Option<&str>,
    ) -> Result<SetParaResult> {
        let bundle = self.require_bundle()?;
        let wiki_rel = bundle.paths.to_wiki_rel(&bundle.paths.resolve(path)?);
        let next_wiki_rel = reclassify(&wiki_rel, to);

        if next_wiki_rel == wiki_rel {
            return Ok(SetParaResult {
                from: path.to_string(),
                to: path.to_string(),
                para: to,
                moved: false,
            });
        }

        let next_path = if bundle.paths.wiki_dir.is_empty() {
            next_wiki_rel
        } else {
            format!("{}/{}", bundle.paths.wiki_dir, next_wiki_rel)
        };
        // The default tag matches the caller's kind, so an agent refile is
        // findable with the same 'process:' audit filter as its other writes.
        let default_actor = if by == Actor::Agent { "process:mcp" } else { "human:local" };
        let result = self.move_file(path, &next_path, actor.unwrap_or(default_actor), by)?;
        Ok(SetParaResult {
            from: path.to_string(),
            to: result.moved,
            para: to,
            moved: true,
        })
    }

    pub fn require_loops(&self) -> Result<&LoopSpace> {
        self.require_bundle()?;
        self.loop_space.as_ref().ok_or_else(no_bundle)
    }

    /// The counts a loop compares before and after. Deliberately three numbers
    /// rather than a full inventory: a preflight has to be cheap.
    fn health_snapshot(bundle: &Bundle) -> LoopSnapshot {
        LoopSnapshot {
            concepts: bundle.all_concepts().len() as i64,
            non_conformant: bundle.conformance_issues().len() as i64,
            unresolved_links: bundle.unresolved_links().len() as i64,
        }
    }

    pub fn loop_start(&mut self, options: &StartOptions) -> Result<LoopStartResult> {
        let bundle = self.bundle.as_ref().ok_or_else(no_bundle)?;
        let loops = self.loop_space.as_mut().ok_or_else(no_bundle)?;
        loops.start(options, &|| Self::health_snapshot(bundle))
    }

    pub fn loop_end(&mut self, options: &EndOptions) -> Result<LoopEndResult> {
        let bundle = self.bundle.as_ref().ok_or_else(no_bundle)?;
        let loops = self.loop_space.as_mut().ok_or_else(no_bundle)?;
        loops.end(options, &|| Self::health_snapshot(bundle))
    }

    pub fn loop_note(&mut self, action: &str, detail: &str) -> Result<()> {
        self.require_bundle()?;
        self.loop_space.as_mut().ok_or_else(no_bundle)?.note(action, detail, None)
    }

    /// Journal a change into the open loop, if there is one.
    ///
    /// Writes inside `loops/` are skipped: journalling the journal would
    /// recurse, and the loop file's own history is not part of what the loop
    /// did.
    fn journal(&mut self, action: &str, path: &str) {
        let Some(loops) = self.loop_space.as_mut() else { return };
        if loops.running_loop().is_none() {
            return;
        }
        if path.replace('\\', "/").starts_with(&format!("{LOOPS_DIR}/")) {
            return;
        }
        let _ = loops.note(action, path, None);
    }

    pub fn require_skills(&self) -> Result<&SkillSpace> {
        self.require_bundle()?;
        self.skill_space.as_ref().ok_or_else(no_bundle)
    }

    pub fn require_skills_mut(&mut self) -> Result<&mut SkillSpace> {
        self.require_bundle()?;
        self.skill_space.as_mut().ok_or_else(no_bundle)
    }

    /// Re-read the bundle from disk, e.g. after a source was captured.
    pub fn reload_bundle(&mut self) -> Result<()> {
        let bundle = self.bundle.as_mut().ok_or_else(no_bundle)?;
        bundle.reload();
        if let Some(fts) = &self.fts {
            fts.sync(&docs_of(bundle)).map_err(fts_err)?;
        }
        Ok(())
    }

    pub fn info(&self) -> Option<BundleInfo> {
        self.bundle.as_ref().map(Bundle::info)
    }

    pub fn scaffold(&self, path: &str) -> Result<ScaffoldResult> {
        scaffold_bundle(path)
    }

    pub fn list_dir(&self, path: &str, recursive: bool) -> Result<Vec<FileNode>> {
        self.require_bundle()?.list_dir(path, recursive)
    }

    pub fn read_file(&mut self, path: &str) -> Result<ReadFileResult> {
        self.require_bundle_mut()?.read_file(path)
    }

    pub fn write_file(&mut self, path: &str, content: &str, opts: &WriteOptions) -> Result<WriteFileResult> {
        self.require_bundle()?;
        self.mark_self_write(path);

        let bundle = self.bundle.as_mut().ok_or_else(no_bundle)?;
        let outcome = bundle.write_file(path, content, opts)?;
        if let (Some(concept), Some(fts)) = (&outcome.concept, &self.fts) {
            fts.upsert(concept).map_err(fts_err)?;
        }

        // The log row is our own write too; do not bounce it back to the UI.
        if opts.log != Some(false) {
            self.mark_log_write()?;
        }

        let action = if opts.action.as_deref() == Some("create") { "create" } else { "write" };
        self.journal(action, path);

        Ok(outcome.result)
    }

    pub fn search(&self, query: &str, options: &SearchOptions) -> Result<Vec<SearchHit>> {
        self.require_fts()?.search(query, options).map_err(fts_err)
    }

    pub fn search_chunks(&self, query: &str, options: &SearchOptions) -> Result<Vec<ChunkHit>> {
        self.require_fts()?.search_chunks(query, options).map_err(fts_err)
    }

    /// Assemble budgeted, cited context for an agent.
    ///
    /// `link_depth` is applied here rather than in the index: following a link
    /// needs the concept graph, which only the bundle has.
    pub fn retrieve(&self, query: &str, options: &RetrieveOptions) -> Result<RetrievalResult> {
        let mut result = retrieve(self.require_fts()?, query, options).map_err(fts_err)?;

        let depth = options.link_depth.unwrap_or(0);
        if depth <= 0 || result.passages.is_empty() {
            return Ok(result);
        }

        let budget = options.budget_chars.unwrap_or(DEFAULT_BUDGET_CHARS).max(1);
        let mut seen: HashSet<&str> = HashSet::new();
        let start: Vec<String> = result
            .passages
            .iter()
            .filter(|p| seen.insert(p.id.as_str()))
            .map(|p| p.id.clone())
            .collect();
        let reached = self.follow_links(
            &start,
            depth,
            budget - result.used_chars as i64,
            &options.filters,
        )?;
        result.linked = Some(reached.linked);
        result.used_chars += reached.used_chars;
        result.truncated = result.truncated || reached.truncated;
        Ok(result)
    }

    /// Walk outgoing links from some files, up to `depth` hops, collecting
    /// each file once as a pointer: path, title and the one-line description.
    ///
    /// Pointers, not bodies, because the point is to show what else is nearby
    /// at a cost the budget can bound; the cost of an entry is its title plus
    /// its description, and the walk stops at the first one that no longer
    /// fits. Filters apply to what is shown: a hidden file (DEAD, past the
    /// PARA depth, outside `type` / `tags` / `path_prefix`) is not listed and not walked through, but is still marked
    /// seen so it is judged once.
    fn follow_links(
        &self,
        start_ids: &[String],
        depth: i64,
        budget_left: i64,
        filters: &SearchFilters,
    ) -> Result<FollowedLinks> {
        let bundle = self.require_bundle()?;
        // Resolved against the ids that exist now, not the `resolved` recorded
        // when each page was parsed: a link written before its target existed
        // stays unresolved there until the next reload.
        let ids = bundle.concept_ids();
        let mut seen: HashSet<String> = start_ids.iter().cloned().collect();
        let mut linked: Vec<LinkedFile> = Vec::new();
        let mut used: u64 = 0;
        let mut frontier: Vec<String> = start_ids.to_vec();

        for hops in 1..=depth {
            let mut next: Vec<String> = Vec::new();
            for id in &frontier {
                let Some(from) = bundle.get_concept(id) else { continue };

                for link in &from.links {
                    let Some(target) = resolve_link_target(&link.target, &from.id, Some(&ids))
                        .and_then(|r| bundle.get_concept(&r))
                    else {
                        continue;
                    };
                    if !seen.insert(target.id.clone()) {
                        continue;
                    }

                    if filters.include_dead != Some(true)
                        && lifecycle_of(&tags_of(target)) == LifecycleChoice::Set(Lifecycle::Dead)
                    {
                        continue;
                    }
                    if !matches_filters(target, filters) {
                        continue;
                    }
                    if let Some(para_depth) = filters.para_depth {
                        if !within_para_depth(&target.id, para_depth) {
                            continue;
                        }
                    }

                    let title = concept_title(&target.id, &target.frontmatter);
                    let description = target
                        .frontmatter
                        .description
                        .as_deref()
                        .filter(|d| !js_trim(d).is_empty())
                        .map(str::to_string);
                    let cost =
                        (utf16_len(&title) + description.as_deref().map_or(0, utf16_len)) as u64;
                    if used as i64 + cost as i64 > budget_left {
                        return Ok(FollowedLinks { linked, used_chars: used, truncated: true });
                    }

                    used += cost;
                    linked.push(LinkedFile {
                        path: target.rel_path.clone(),
                        id: target.id.clone(),
                        title,
                        r#type: target.frontmatter.r#type.clone(),
                        description,
                        hops: hops as u32,
                        from: from.rel_path.clone(),
                    });
                    next.push(target.id.clone());
                }
            }
            frontier = next;
        }

        Ok(FollowedLinks { linked, used_chars: used, truncated: false })
    }

    /// Assemble a context pack: the minimal file set for a task, plus the
    /// skills that match it, sized to the model tier that will consume it.
    pub fn context_pack(
        &mut self,
        task: &str,
        options: &RetrieveOptions,
        tier: Option<ContextTier>,
    ) -> Result<ContextPack> {
        let (default_budget, default_limit) = match tier {
            Some(tier) => {
                let d = tier.defaults();
                (d.budget_chars, d.limit)
            }
            None => (DEFAULT_BUDGET_CHARS, 8),
        };
        let budget_chars = options.budget_chars.unwrap_or(default_budget);

        let retrieval = self.retrieve(
            task,
            &RetrieveOptions {
                budget_chars: Some(budget_chars),
                limit: Some(options.limit.unwrap_or(default_limit)),
                ..options.clone()
            },
        )?;

        let bundle = self.require_bundle()?;
        let files = group_passages(&retrieval, |id| {
            let description = bundle.get_concept(id)?.frontmatter.description.as_deref()?;
            (!js_trim(description).is_empty()).then(|| description.to_string())
        });

        let found = self.require_skills_mut()?.find(task, Some(3));

        // Know-how sits outside PARA, so it counts as a resource: a narrow
        // `para_depth` that stops short of resources leaves it out with the
        // rest. It follows the caller's filters like any other file, and each
        // entry is paid for from the same budget as the passages (title +
        // description, as a linked pointer is), so the pack never outgrows
        // `budget_chars`.
        let mut knowhow: Vec<ContextPackKnowhow> = Vec::new();
        let mut used_chars = retrieval.used_chars;
        let mut truncated = retrieval.truncated;
        if options.filters.para_depth.is_none_or(|depth| within_para_depth(KNOWHOW_DIR, depth)) {
            let found = self.knowhow_find(
                task,
                3,
                options.filters.include_dead == Some(true),
                &options.filters,
            )?;
            for r in found.ranked {
                let cost = (utf16_len(&r.title) + utf16_len(&r.description)) as i64;
                if used_chars as i64 + cost > budget_chars {
                    truncated = true;
                    break;
                }
                used_chars += cost as u64;
                knowhow.push(ContextPackKnowhow {
                    title: r.title,
                    description: r.description,
                    path: r.path,
                    by: r.by,
                    score: r.score,
                });
            }
        }

        Ok(ContextPack {
            task: task.to_string(),
            tier,
            budget_chars,
            files,
            skills: found
                .ranked
                .iter()
                .map(|r| ContextPackSkill {
                    name: r.name.clone(),
                    description: r.description.clone(),
                    score: r.score,
                })
                .collect(),
            knowhow,
            linked: retrieval.linked.unwrap_or_default(),
            used_chars,
            truncated,
        })
    }

    /// Group log.md rows by actor: who, human or which model, changed what.
    ///
    /// Rows the parser cannot read (hand-written prose, which section 9
    /// allows) are simply absent, so this reports what the log records.
    pub fn audit_changes(&self, since: Option<&str>, actor: Option<&str>) -> Result<AuditResult> {
        let log = self.require_bundle()?.read_log();

        let mut entries = parse_log_entries(&log);
        if let Some(since) = since.filter(|s| !s.is_empty()) {
            entries.retain(|e| e.date.encode_utf16().ge(since.encode_utf16()));
        }
        if let Some(actor) = actor.filter(|a| !a.is_empty()) {
            entries.retain(|e| e.actor.contains(actor));
        }

        let total = entries.len();
        let mut by_actor: IndexMap<String, Vec<ParsedLogEntry>> = IndexMap::new();
        for entry in entries {
            by_actor.entry(entry.actor.clone()).or_default().push(entry);
        }

        let mut actors: Vec<ActorAudit> = by_actor
            .into_iter()
            .map(|(actor, entries)| ActorAudit { actor, count: entries.len(), entries })
            .collect();
        actors.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| locale_compare(&a.actor, &b.actor)));

        Ok(AuditResult {
            total,
            since: since.filter(|s| !s.is_empty()).map(str::to_string),
            actors,
        })
    }

    // ---- bases -------------------------------------------------------------------

    /// Every `.base` file with the views it offers, or why it cannot be read.
    pub fn base_list(&mut self) -> Result<Vec<Value>> {
        let mut paths: Vec<String> = Vec::new();
        {
            let bundle = self.require_bundle()?;
            fn walk(nodes: &[FileNode], out: &mut Vec<String>) {
                for node in nodes {
                    match &node.children {
                        Some(children) => walk(children, out),
                        None => {
                            if node.name.to_lowercase().ends_with(BASE_EXT) {
                                out.push(node.path.clone());
                            }
                        }
                    }
                }
            }
            walk(&bundle.list_dir(&bundle.paths.wiki_dir, true)?, &mut paths);
        }
        paths.sort_by(|a, b| locale_compare(a, b));

        let mut out = Vec::new();
        for path in paths {
            let Ok(text) = self.read_base_text(&path) else { continue };
            let mut entry = serde_json::Map::new();
            entry.insert("path".into(), Value::String(path));
            let Some(value) = parse_yaml(&text) else {
                entry.insert("views".into(), Value::Array(Vec::new()));
                entry.insert("error".into(), Value::String("the content is not valid YAML".into()));
                out.push(Value::Object(entry));
                continue;
            };
            let views = list_views(&value)
                .into_iter()
                .map(|(name, kind)| {
                    let mut v = serde_json::Map::new();
                    v.insert("name".into(), Value::String(name));
                    v.insert("type".into(), Value::String(kind));
                    Value::Object(v)
                })
                .collect();
            entry.insert("views".into(), Value::Array(views));
            let errors = validate_base(&value).errors;
            if !errors.is_empty() {
                entry.insert("error".into(), Value::String(errors.join("; ")));
            }
            out.push(Value::Object(entry));
        }
        Ok(out)
    }

    /// The text of one `.base` file. A missing file is an error; bad YAML is not.
    fn read_base_text(&mut self, path: &str) -> Result<String> {
        if !is_base_path(path) {
            return Err(OkfError::message("'path' must end in .base"));
        }
        let bundle = self.require_bundle_mut()?;
        bundle.paths.resolve(path)?; // a path outside the bundle fails here, with the usual message
        match bundle.read_file(path) {
            Ok(file) if file.binary != Some(true) => Ok(file.content),
            _ => Err(OkfError::message(format!("{path} not found"))),
        }
    }

    /// One view of a base over the bundle's concepts. Reads the file afresh every time.
    pub fn base_query(&mut self, path: &str, view: Option<&str>, limit: Option<usize>) -> Result<(BaseResult, String)> {
        let text = self.read_base_text(path)?;
        let Some(value) = parse_yaml(&text) else {
            return Err(OkfError::message("the content is not valid YAML"));
        };
        let rows: Vec<BaseRow> = self
            .require_bundle()?
            .all_concepts()
            .into_iter()
            .map(|doc| BaseRow {
                path: doc.rel_path.clone(),
                wiki_path: format!("{}.md", doc.id),
                id: doc.id.clone(),
                mtime_ms: doc.mtime_ms,
                frontmatter: doc.frontmatter.to_map(),
                links: doc.links.iter().map(|l| (l.target.clone(), l.resolved.clone())).collect(),
            })
            .collect();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_millis() as f64);
        let result = run_base(&value, &rows, &RunOptions { view, limit, now }).map_err(OkfError::message)?;
        let markdown = render_base_markdown(&result);
        Ok((result, markdown))
    }

    /// Validate, then write exactly the text given: unknown keys and the
    /// author's formatting survive because nothing is re-serialised. Returns
    /// the warnings.
    pub fn base_write(&mut self, path: &str, content: &str, by: Actor, actor: Option<&str>) -> Result<Vec<String>> {
        if !is_base_path(path) {
            return Err(OkfError::message("'path' must end in .base"));
        }
        {
            let bundle = self.require_bundle()?;
            let abs = bundle.paths.resolve(path)?;
            let rel = bundle.paths.to_rel(&abs);
            if bundle.paths.layer_of(&rel) != Some(Layer::Wiki) {
                return Err(OkfError::message(format!("A .base file must live under wiki/: {path}")));
            }
            // In a flat bundle the wiki layer is the whole folder, so the layer check alone
            // would let a base into .okf/, .git/ or any other hidden place.
            if rel.split('/').any(|segment| segment == ".." || segment.starts_with('.')) {
                return Err(OkfError::message(format!("A .base file cannot live in a hidden folder: {path}")));
            }
        }
        let Some(value) = parse_yaml(content) else {
            return Err(OkfError::message("Invalid base, nothing written: the content is not valid YAML"));
        };
        let found = validate_base(&value);
        if !found.errors.is_empty() {
            return Err(OkfError::message(format!(
                "Invalid base, nothing written: {}",
                found.errors.join("; ")
            )));
        }
        self.write_file(
            path,
            content,
            &WriteOptions { by: Some(by), actor: actor.map(str::to_string), ..Default::default() },
        )?;
        Ok(found.warnings)
    }

    pub fn tags(&self) -> Result<Vec<TagCount>> {
        self.require_fts()?.tags().map_err(fts_err)
    }

    pub fn types(&self) -> Result<Vec<TagCount>> {
        self.require_fts()?.types().map_err(fts_err)
    }

    /// Every concept id and title, for the quick switcher.
    pub fn list_concepts(&self) -> Result<Vec<ConceptListing>> {
        let mut list: Vec<ConceptListing> = self
            .require_bundle()?
            .all_concepts()
            .into_iter()
            .map(|doc| ConceptListing {
                id: doc.id.clone(),
                path: doc.rel_path.clone(),
                title: match doc.frontmatter.title.as_deref() {
                    Some(t) if !js_trim(t).is_empty() => t.to_string(),
                    _ => doc.id.clone(),
                },
                r#type: doc.frontmatter.r#type.clone(),
                // Listed even when DEAD: this is the inventory, and a retired
                // note must stay visible here to be found and revived.
                lifecycle: match lifecycle_of(&tags_of(doc)) {
                    LifecycleChoice::None => None,
                    LifecycleChoice::Set(l) => Some(l.as_str()),
                },
            })
            .collect();
        list.sort_by(|a, b| locale_compare(&a.id, &b.id));
        Ok(list)
    }

    // ---- lifecycle -----------------------------------------------------------

    /// Mark a concept Product or DEAD, or clear the mark.
    ///
    /// An edit of the frontmatter `tags` through the normal write path, so the
    /// layer rules, the log row and the reindex all apply. Nothing is moved or
    /// deleted: DEAD only changes what search and packs show by default.
    pub fn set_lifecycle(
        &mut self,
        path: &str,
        to: LifecycleChoice,
        actor: &str,
    ) -> Result<SetLifecycleResult> {
        let file = self.require_bundle_mut()?.read_file(path)?;
        if file.binary == Some(true) || file.concept.is_none() {
            return Err(OkfError::message(format!(
                "{path} is not a concept document, so it has no tags to change"
            )));
        }

        let split = split_frontmatter(&file.content);
        // The frontmatter as written, never the defaulted one: rewriting a
        // block that could not be read would replace it with a guess.
        let Some(record) = frontmatter_record(split.yaml.as_deref()) else {
            return Err(OkfError::message(format!(
                "{path} has no readable YAML frontmatter mapping; add one before setting a lifecycle"
            )));
        };

        let current: Vec<Value> = match record.get("tags") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items.clone(),
            Some(_) => return Err(OkfError::message(format!("tags in {path} is not a list"))),
        };

        let next = with_lifecycle(&current, to);
        if next == current {
            return Ok(SetLifecycleResult { path: path.to_string(), lifecycle: to, changed: false });
        }

        // Only the `tags` lines change: a whole-block rewrite would drop the
        // author's comments and re-quote values like `version: 1.10`.
        let Some(edited) = set_lifecycle_in_document(&file.content, &current, to) else {
            return Err(OkfError::message(format!(
                "tags in {path} are written in a form that cannot be edited safely; change them by hand"
            )));
        };

        self.write_file(
            path,
            &edited,
            &WriteOptions {
                by: Some(Actor::Agent),
                actor: Some(actor.to_string()),
                action: Some("write".into()),
                note: Some(format!("lifecycle: {}", to.as_str())),
                ..Default::default()
            },
        )?;
        Ok(SetLifecycleResult { path: path.to_string(), lifecycle: to, changed: true })
    }

    // ---- know-how --------------------------------------------------------------

    /// Create a wiki sub-folder's index.md on first use, without a watcher
    /// echo.
    fn ensure_folder(&mut self, dir: &str, title: &str) -> Result<()> {
        let created = self.require_bundle()?.ensure_folder_index(dir, title);
        if let Some(rel) = created {
            self.mark_self_write(&rel);
        }
        Ok(())
    }

    /// Bundle-relative path for a wiki-relative one.
    fn wiki_path(&self, wiki_rel: &str) -> Result<String> {
        let wiki_dir = &self.require_bundle()?.paths.wiki_dir;
        Ok(if wiki_dir.is_empty() {
            wiki_rel.to_string()
        } else {
            format!("{wiki_dir}/{wiki_rel}")
        })
    }

    /// Record a lesson for the agents that come next.
    ///
    /// One file per lesson under `knowhow/`, named for its title; a repeated
    /// title gets a numbered name rather than overwriting what another agent
    /// wrote. `by` is stored beside `generated.by` so the lesson source is a
    /// first-class field a reader can filter on.
    pub fn knowhow_add(
        &mut self,
        title: &str,
        body: &str,
        tags: &[String],
        actor: &str,
    ) -> Result<String> {
        self.require_bundle()?;
        self.ensure_folder(KNOWHOW_DIR, KNOWHOW_TITLE)?;

        let slug = knowhow_slug_default(title);
        let mut path = self.wiki_path(&format!("{KNOWHOW_DIR}/{slug}.md"))?;
        let mut n = 2;
        while self.require_bundle()?.exists(&path)? {
            path = self.wiki_path(&format!("{KNOWHOW_DIR}/{slug}-{n}.md"))?;
            n += 1;
        }

        let description = derive_description(body);
        let content = skeleton_concept(&ConceptSkeletonOptions {
            r#type: KNOWHOW_TYPE.to_string(),
            title: Some(title.to_string()),
            description: (!description.is_empty()).then_some(description),
            tags: tags.to_vec(),
            body: Some(body.to_string()),
            generated_by: Some(actor.to_string()),
            extra: vec![("by".to_string(), actor.to_string())],
            now: None,
        });
        self.write_file(
            &path,
            &content,
            &WriteOptions {
                by: Some(Actor::Agent),
                actor: Some(actor.to_string()),
                action: Some("create".into()),
                ..Default::default()
            },
        )?;
        Ok(path)
    }

    /// Rank recorded know-how against a task, as `skill_find` ranks skills.
    ///
    /// Cheap by design: titles, descriptions, scores and who recorded each,
    /// no bodies. DEAD lessons are retired and not offered unless asked for.
    /// The candidates are put in id order first so equal scores break the
    /// same way on every run.
    pub fn knowhow_find(
        &self,
        task: &str,
        limit: i64,
        include_dead: bool,
        filters: &SearchFilters,
    ) -> Result<KnowhowFound> {
        let prefix = format!("{KNOWHOW_DIR}/");
        let mut docs: Vec<&ConceptDocument> = self
            .require_bundle()?
            .all_concepts()
            .into_iter()
            .filter(|doc| doc.id.starts_with(&prefix))
            .filter(|doc| {
                include_dead || lifecycle_of(&tags_of(doc)) != LifecycleChoice::Set(Lifecycle::Dead)
            })
            .filter(|doc| matches_filters(doc, filters))
            .collect();
        docs.sort_by(|a, b| locale_compare(&a.id, &b.id));

        let candidates: Vec<KnowhowCandidate> = docs
            .into_iter()
            .map(|doc| KnowhowCandidate {
                name: concept_title(&doc.id, &doc.frontmatter),
                description: doc.frontmatter.description.clone().unwrap_or_default(),
                tags: tags_of(doc),
                path: doc.rel_path.clone(),
                by: match doc.frontmatter.extra.get("by").and_then(Value::as_str) {
                    Some(by) => by.to_string(),
                    None => doc
                        .frontmatter
                        .generated
                        .as_ref()
                        .map(|g| g.by.clone())
                        .unwrap_or_default(),
                },
            })
            .collect();

        let ranked = rank_skills(task, &candidates, Some(limit.clamp(1, 20) as usize));
        Ok(KnowhowFound {
            confidence: selection_confidence(&ranked),
            ranked: ranked
                .iter()
                .map(|r| KnowhowRanked {
                    title: r.skill.name.clone(),
                    path: r.skill.path.clone(),
                    description: r.skill.description.clone(),
                    by: r.skill.by.clone(),
                    score: js_round(r.score * 100.0) / 100.0,
                    matched: r.matched.clone(),
                })
                .collect(),
        })
    }

    // ---- activity ----------------------------------------------------------------

    /// Summarise log.md as a page whose every line cites a log row.
    ///
    /// With `save` it is also written as an `ActivitySummary` concept through
    /// the normal write path, so it is searchable, logged and attributable
    /// like any other page. Nothing is written when no row matched: an empty
    /// summary would only be a file that claims nothing.
    pub fn summarize_activity(
        &mut self,
        filter: &ActivityFilter,
        by: Option<&str>,
        save: bool,
    ) -> Result<ActivityResult> {
        let bundle = self.require_bundle()?;
        let source = bundle.paths.to_rel(&bundle.paths.log_md_path());
        let entries = filter_activity(&parse_log_entries(&bundle.read_log()), filter);
        let Some(summary) = summarize_rows(&entries, filter, &source) else {
            return Ok(ActivityResult { total: 0, markdown: String::new(), saved: None });
        };

        let markdown = format!("# {}\n\n{}", summary.title, summary.body);
        if !save {
            return Ok(ActivityResult { total: summary.total, markdown, saved: None });
        }

        let actor_filter = filter.actor.as_deref().filter(|a| !a.is_empty());
        // Whoever ran the tool is credited; the actor filter only narrows the rows.
        let actor = by.map(js_trim).filter(|b| !b.is_empty()).unwrap_or("process:okf").to_string();
        let path = self.wiki_path(&activity_rel_path(&summary.from, &summary.to, actor_filter))?;
        let existed = self.require_bundle()?.exists(&path)?;

        self.ensure_folder(ACTIVITY_DIR, ACTIVITY_TITLE)?;
        let content = skeleton_concept(&ConceptSkeletonOptions {
            r#type: ACTIVITY_TYPE.to_string(),
            title: Some(summary.title.clone()),
            description: Some(summary.description.clone()),
            tags: vec!["activity".to_string()],
            body: Some(summary.body.clone()),
            generated_by: Some(actor.clone()),
            extra: Vec::new(),
            now: None,
        });
        self.write_file(
            &path,
            &content,
            &WriteOptions {
                by: Some(Actor::Agent),
                actor: Some(actor),
                action: Some(if existed { "write" } else { "create" }.into()),
                ..Default::default()
            },
        )?;
        Ok(ActivityResult { total: summary.total, markdown, saved: Some(path) })
    }

    pub fn unresolved_links(&self) -> Result<Vec<UnresolvedLink>> {
        Ok(self.require_bundle()?.unresolved_links())
    }

    pub fn create_directory(&self, path: &str, by: Actor) -> Result<()> {
        self.require_bundle()?.create_directory(path, by)
    }

    /// Move or rename, rewriting inbound links.
    ///
    /// The whole affected set is reindexed rather than just the moved file,
    /// because rewriting a link changes the body of every referring document.
    pub fn move_file(&mut self, from: &str, to: &str, actor: &str, by: Actor) -> Result<MoveResult> {
        self.require_bundle()?;
        self.mark_self_write(from);
        self.mark_self_write(to);
        self.mark_log_write()?;

        let bundle = self.bundle.as_mut().ok_or_else(no_bundle)?;
        let result = bundle.move_path(
            from,
            to,
            &MoveOptions { actor: Some(actor.to_string()), by: Some(by) },
        )?;
        for path in &result.updated {
            self.mark_self_write(path);
        }
        self.journal("move", &format!("{from} → {to}"));

        let docs = docs_of(self.require_bundle()?);
        self.require_fts()?.rebuild(&docs).map_err(fts_err)?;
        Ok(result)
    }

    pub fn delete(&mut self, path: &str, actor: &str, by: Actor) -> Result<DeleteResult> {
        self.require_bundle()?;
        self.mark_self_write(path);
        self.mark_log_write()?;

        let bundle = self.bundle.as_mut().ok_or_else(no_bundle)?;
        let result = bundle.delete_path(
            path,
            &DeleteOptions { actor: Some(actor.to_string()), by: Some(by), ..Default::default() },
        )?;
        let docs = docs_of(bundle);
        self.require_fts()?.rebuild(&docs).map_err(fts_err)?;
        self.journal("delete", path);
        Ok(result)
    }

    pub fn resolve_link(&self, from: &str, target: &str) -> Result<Option<String>> {
        Ok(self.require_bundle()?.resolve_link(from, target))
    }

    pub fn rebuild_index(&mut self) -> Result<usize> {
        let bundle = self.require_bundle()?;
        let rel = bundle.paths.to_rel(&bundle.paths.index_md_path());
        self.mark_self_write(&rel);
        self.require_bundle_mut()?.rebuild_index_md()
    }

    pub fn rebuild_rag(&mut self) -> Result<usize> {
        let bundle = self.bundle.as_mut().ok_or_else(no_bundle)?;
        bundle.reload();
        let docs = docs_of(bundle);
        self.require_fts()?.rebuild(&docs).map_err(fts_err)
    }

    pub fn conformance_issues(&self) -> Result<Vec<ConformanceIssue>> {
        Ok(self.require_bundle()?.conformance_issues())
    }

    /// Index statistics, for status display and diagnostics.
    pub fn index_stats(&self) -> Result<IndexStats> {
        let fts = self.require_fts()?;
        Ok(IndexStats {
            documents: fts.document_count().map_err(fts_err)?,
            chunks: fts.chunk_count().map_err(fts_err)?,
        })
    }

    pub fn read_agents_md(&self) -> Result<Option<String>> {
        Ok(self.require_bundle()?.read_agents_md())
    }

    // ---- orientation files -------------------------------------------------

    pub fn read_map(&self) -> Result<String> {
        self.require_bundle()?.read_map()
    }

    pub fn read_human(&self) -> Result<Option<String>> {
        Ok(self.require_bundle()?.read_human())
    }

    /// Create `human.md` from the template, or return what is already there.
    pub fn ensure_human(&mut self) -> Result<String> {
        if let Some(existing) = self.require_bundle()?.read_human() {
            return Ok(existing);
        }
        let template = render_human_template();
        self.write_human(&template)?;
        Ok(template)
    }

    pub fn write_human(&mut self, content: &str) -> Result<()> {
        let bundle = self.require_bundle()?;
        let rel = bundle.paths.to_rel(&bundle.paths.human_md_path());
        self.mark_self_write(&rel);
        self.require_bundle()?.write_human(content)
    }

    // ---- daily notes --------------------------------------------------------

    fn daily_path(bundle: &Bundle, date: &DateTime<Local>) -> String {
        let wiki_rel = daily_rel_path(date);
        if bundle.paths.wiki_dir.is_empty() {
            wiki_rel
        } else {
            format!("{}/{}", bundle.paths.wiki_dir, wiki_rel)
        }
    }

    /// Today's note, created from the template if it does not exist yet.
    ///
    /// Returns the bundle-relative path either way, so a caller can open it
    /// without caring which happened.
    pub fn open_daily(&mut self, date: Option<DateTime<Local>>) -> Result<(String, bool)> {
        let date = date.unwrap_or_else(Local::now);
        let rel_path = Self::daily_path(self.require_bundle()?, &date);

        if self.require_bundle_mut()?.read_file(&rel_path).is_ok() {
            return Ok((rel_path, false));
        }

        let content = skeleton_concept(&ConceptSkeletonOptions {
            r#type: "Daily".into(),
            title: Some(daily_title(&date)),
            body: Some(daily_template()),
            generated_by: Some("human:local".into()),
            now: Some(date.with_timezone(&Utc)),
            ..Default::default()
        });
        self.write_file(
            &rel_path,
            &content,
            &WriteOptions {
                actor: Some("human:local".into()),
                action: Some("create".into()),
                ..Default::default()
            },
        )?;
        Ok((rel_path, true))
    }

    /// Move unchecked task lines out of a daily note and into `Task.md`.
    ///
    /// Idempotent by construction: each transferred line is checked off and
    /// stamped with the id it became, and checked lines are never picked up
    /// again.
    pub fn collect_daily_tasks(&mut self, date: Option<DateTime<Local>>) -> Result<Vec<Task>> {
        let date = date.unwrap_or_else(Local::now);
        let rel_path = Self::daily_path(self.require_bundle()?, &date);

        let Ok(file) = self.require_bundle_mut()?.read_file(&rel_path) else {
            return Ok(Vec::new());
        };
        if file.binary == Some(true) {
            return Ok(Vec::new());
        }

        let pending = pending_task_lines(&file.content);
        if pending.is_empty() {
            return Ok(Vec::new());
        }

        // One write of Task.md for the whole note, rather than one per line.
        let note = format!("{} のノートから", daily_id(&date));
        let created = self.add_tasks(
            &pending
                .iter()
                .map(|item| TaskInput {
                    title: item.text.clone(),
                    note: Some(note.clone()),
                    ..Default::default()
                })
                .collect::<Vec<_>>(),
        )?;

        let mut body = file.content;
        for (at, item) in pending.iter().enumerate() {
            body = mark_transferred(&body, item.line, &created[at].id);
        }

        // 'process:', not a bare 'agent': the transfer is automated whichever
        // front end asked for it.
        self.write_file(
            &rel_path,
            &body,
            &WriteOptions {
                by: Some(Actor::Agent),
                actor: Some("process:task-collect".into()),
                action: Some("update".into()),
                ..Default::default()
            },
        )?;
        Ok(created)
    }

    pub fn list_tasks(&self, status: Option<TaskStatus>) -> Result<Vec<Task>> {
        let file = self.require_bundle()?.read_task_file();
        // The default is open work only. Finished tasks are the bulk of the
        // file and are almost never what the caller wanted.
        Ok(match status {
            None => open_tasks(&file),
            Some(status) => file.tasks.into_iter().filter(|t| t.status == status).collect(),
        })
    }

    pub fn add_task(&mut self, input: TaskInput) -> Result<Task> {
        Ok(self.add_tasks(&[input])?.remove(0))
    }

    /// Add several tasks in one read-modify-write of `Task.md`.
    ///
    /// Ids are allocated against the list as it grows, so a batch cannot
    /// collide with itself.
    pub fn add_tasks(&mut self, inputs: &[TaskInput]) -> Result<Vec<Task>> {
        let mut file = self.require_bundle()?.read_task_file();

        let mut created = Vec::new();
        for input in inputs {
            let mut task = Task::new(
                next_task_id(&file.tasks),
                js_trim(&input.title),
                input.status.unwrap_or(TaskStatus::Todo),
            );
            task.para = input.para;
            task.due = input.due.clone().filter(|s| !s.is_empty());
            task.note = input.note.clone().filter(|s| !s.is_empty());
            file.tasks.insert(0, task.clone());
            created.push(task);
        }

        self.write_task_file(&file)?;
        Ok(created)
    }

    /// Write `Task.md`, suppressing the watcher event for our own write.
    fn write_task_file(&mut self, file: &TaskFile) -> Result<()> {
        let bundle = self.require_bundle()?;
        let rel = bundle.paths.to_rel(&bundle.paths.task_md_path());
        self.mark_self_write(&rel);
        self.require_bundle()?.write_task_file(file)
    }

    /// Change a task's state or fields.
    ///
    /// Completing one stamps the date and bumps the all-time count, so the
    /// heading stays honest even after old entries age out of the file.
    pub fn update_task(&mut self, id: &str, changes: &TaskChanges) -> Result<Option<Task>> {
        let mut file = self.require_bundle()?.read_task_file();

        let Some(at) = file.tasks.iter().position(|t| t.id == id) else {
            return Ok(None);
        };
        let wanted = file.tasks[at].id.clone();
        let task = &mut file.tasks[at];
        let was_done = task.status == TaskStatus::Done;

        if let Some(title) = &changes.title {
            task.title = js_trim(title).to_string();
        }
        if let Some(para) = changes.para {
            task.para = Some(para);
        }
        if let Some(due) = &changes.due {
            task.due = Some(due.clone());
        }
        if let Some(note) = &changes.note {
            task.note = Some(note.clone());
        }

        let mut done_delta: i64 = 0;
        if let Some(status) = changes.status {
            if status != task.status {
                task.status = status;
                if status == TaskStatus::Done {
                    task.done = Some(iso_date_of(&Local::now()));
                    done_delta = 1;
                } else if was_done {
                    task.done = None;
                    done_delta = -1;
                }
            }
        }
        file.done_ever = (file.done_ever as i64 + done_delta).max(0) as u64;

        // Newest completions first, so the kept window holds the recent ones.
        file.tasks.sort_by(|a, b| {
            locale_compare(b.done.as_deref().unwrap_or(""), a.done.as_deref().unwrap_or(""))
        });

        self.write_task_file(&file)?;
        Ok(file.tasks.into_iter().find(|t| t.id == wanted))
    }
}

/// Concept id for a bundle-relative path, or `""` for non-concept files.
fn id_of(bundle: &Bundle, rel_path: &str) -> String {
    if !is_concept_path(rel_path) {
        return String::new();
    }
    match bundle.paths.resolve(rel_path) {
        Ok(abs) => concept_id_from_rel_path(&bundle.paths.to_wiki_rel(&abs)),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "workspace_features_tests.rs"]
mod features_tests;
