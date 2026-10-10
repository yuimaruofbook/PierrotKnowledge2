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
use crate::okf::parser::{skeleton_concept, ConceptSkeletonOptions};
use crate::okf::paths::{Actor, LOOPS_DIR, RAG_DIR, SKILLS_DIR};
use crate::okf::scaffold::{scaffold_bundle, ScaffoldResult};
use crate::okf::skills::SkillSpace;
use crate::rag::context_pack::{
    group_passages, ContextPack, ContextPackSkill, ContextTier,
};
use crate::rag::fts::{FtsError, FtsIndex, SearchOptions};
use crate::rag::retrieve::{retrieve, RetrieveOptions, DEFAULT_BUDGET_CHARS};
use crate::shared::js_compat::{js_trim, locale_compare};
use crate::shared::messages;
use crate::shared::okf::concept::{concept_id_from_rel_path, is_concept_path};
use crate::shared::okf::daily::{
    daily_id, daily_rel_path, daily_template, daily_title, mark_transferred, pending_task_lines,
};
use crate::shared::okf::loop_::LoopSnapshot;
use crate::shared::okf::para::{reclassify, ParaClass};
use crate::shared::okf::reserved::{iso_date_of, parse_log_entries, ParsedLogEntry};
use crate::shared::okf::workspace_files::{
    next_task_id, open_tasks, render_human_template, Task, TaskFile, TaskStatus,
};
use crate::shared::types::{
    BundleInfo, ChunkHit, ConformanceIssue, FileNode, ReadFileResult, RetrievalResult, SearchHit,
    TagCount, WriteFileResult,
};
use crate::watch::BundleWatcher;
use chrono::{DateTime, Local, Utc};
use indexmap::IndexMap;
use serde::Serialize;
use std::collections::HashMap;
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
    pub fn retrieve(&self, query: &str, options: &RetrieveOptions) -> Result<RetrievalResult> {
        retrieve(self.require_fts()?, query, options).map_err(fts_err)
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
            used_chars: retrieval.used_chars,
            truncated: retrieval.truncated,
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
            })
            .collect();
        list.sort_by(|a, b| locale_compare(&a.id, &b.id));
        Ok(list)
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
