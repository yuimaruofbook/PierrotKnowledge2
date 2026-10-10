//! LoopSpace: loop designs and their run history, one file per design
//! (`src/bun/okf/loops.ts`).
//!
//! Four guarantees:
//!
//!   1. **One design, one file.** `define()` creates or updates exactly one
//!      file, and a run only ever writes into its own design's file.
//!   2. **One run at a time.** Starting a run while another is in progress is
//!      refused rather than queued.
//!   3. **History is bounded.** Recent runs keep their journal, older ones
//!      collapse to a line, the rest become a count.
//!   4. **A finished run is not rewritten.** Journal entries only ever append
//!      to the run currently in progress.
//!
//! The TS stores a snapshot callback in the constructor. Here `start` and
//! `end` take it as an argument instead, so the caller can borrow its bundle
//! only for the call. The TS serialises appends through a promise chain; these
//! calls are synchronous, so the caller's lock gives the same guarantee.

use super::error::{self, OkfError, Result};
use super::nodepath;
use super::paths::{to_posix, BundlePaths, LOOPS_DIR};
use crate::shared::js_compat::js_trim;
use crate::shared::messages;
use crate::shared::okf::loop_::{
    is_regression, is_valid_loop_name, parse_loop, render_diff, render_loop, slugify_loop_name_default,
    LoopDesign, LoopRun, LoopSnapshot, RunStatus, SUMMARY_RUNS,
};
use chrono::{DateTime, Utc};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LastRun {
    pub started: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SuggestedSkill {
    pub name: String,
    pub description: String,
    #[serde(serialize_with = "crate::shared::js_compat::serialize_js_f64")]
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopStartResult {
    pub name: String,
    pub path: String,
    pub goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    pub checks: Vec<String>,
    pub before: LoopSnapshot,
    /// How this design has gone before, so a run can learn from the last one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<LastRun>,
    pub run_number: i64,
    /// Skills that fit this design, when it does not name one.
    pub suggested: Vec<SuggestedSkill>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopEndResult {
    pub name: String,
    pub path: String,
    pub before: LoopSnapshot,
    pub after: LoopSnapshot,
    pub diff: Vec<String>,
    pub run_number: i64,
    pub regressed: bool,
    /// Completion checks the design declared, for the agent to confirm.
    pub checks: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DefineOptions {
    pub name: Option<String>,
    pub goal: String,
    pub skill: Option<String>,
    pub checks: Option<Vec<String>>,
    pub now: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    pub name: String,
    pub actor: Option<String>,
    pub suggested: Vec<SuggestedSkill>,
    pub now: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default)]
pub struct EndOptions {
    pub outcome: Option<String>,
    /// `Done` when absent; only `Done` and `Abandoned` are meaningful.
    pub status: Option<RunStatus>,
    pub now: Option<DateTime<Utc>>,
}

pub struct LoopSpace {
    paths: BundlePaths,
    /// Design whose run is in progress, if any.
    running: Option<String>,
}

impl LoopSpace {
    pub fn new(paths: BundlePaths) -> Self {
        Self { paths, running: None }
    }

    pub fn running_loop(&self) -> Option<&str> {
        self.running.as_deref()
    }

    pub fn rel_path_of(&self, name: &str) -> String {
        format!("{LOOPS_DIR}/{name}.md")
    }

    fn abs_path_of(&self, name: &str) -> String {
        nodepath::join(&[&self.paths.loops_root(), &format!("{name}.md")])
    }

    /// Names reach here from agents, so they are validated, not trusted.
    fn require_name(&self, name: &str) -> Result<String> {
        let posix = to_posix(js_trim(name));
        let clean = if posix.len() >= 3 && posix[posix.len() - 3..].eq_ignore_ascii_case(".md") {
            posix[..posix.len() - 3].to_string()
        } else {
            posix
        };
        if !is_valid_loop_name(&clean) {
            return Err(OkfError::message(messages::loop_bad_name(name)));
        }
        Ok(clean)
    }

    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = error::read_dir_names(&self.paths.loops_root())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|entry| entry.strip_suffix(".md").map(str::to_string))
            // A README lives here too; only files that could be designs are listed.
            .filter(|name| is_valid_loop_name(name))
            .collect();
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        names
    }

    pub fn read(&self, name: &str) -> Result<LoopDesign> {
        let clean = self.require_name(name)?;
        let abs = self.abs_path_of(&clean);
        if !error::is_file(&abs) {
            return Err(OkfError::message(messages::loop_unknown(&clean)));
        }
        Ok(parse_loop(&error::read_text(&abs)?, &clean))
    }

    pub fn exists(&self, name: &str) -> Result<bool> {
        Ok(error::path_exists(&self.abs_path_of(&self.require_name(name)?)))
    }

    /// Restore the in-progress run after a restart.
    ///
    /// Without it, a restart would silently allow a second run to begin beside
    /// an unfinished one, which is exactly what guarantee 2 exists to stop.
    pub fn resume(&mut self) -> Option<String> {
        for name in self.list() {
            if let Ok(design) = self.read(&name) {
                if design.history.first().is_some_and(|r| r.status == RunStatus::Running) {
                    self.running = Some(name.clone());
                    return Some(name);
                }
            }
        }
        self.running = None;
        None
    }

    /// Create or update a loop design.
    ///
    /// Updating never touches the run history: the design is the plan, the
    /// history is what happened, and editing the plan must not rewrite the past.
    pub fn define(&self, options: &DefineOptions) -> Result<LoopDesign> {
        if js_trim(&options.goal).is_empty() {
            return Err(OkfError::message(messages::LOOP_NEEDS_GOAL));
        }

        let requested = options
            .name
            .as_deref()
            .map(js_trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| slugify_loop_name_default(&options.goal));
        let name = self.require_name(&requested)?;
        let existing = self.read(&name).ok();

        let skill = options
            .skill
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| existing.as_ref().and_then(|e| e.skill.clone()).filter(|s| !s.is_empty()));
        let created = existing
            .as_ref()
            .map(|e| e.created.clone())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| super::error::iso_of(options.now.unwrap_or_else(Utc::now)));

        let mut design = LoopDesign {
            name,
            goal: js_trim(&options.goal).to_string(),
            skill,
            checks: options
                .checks
                .clone()
                .or_else(|| existing.as_ref().map(|e| e.checks.clone()))
                .unwrap_or_default(),
            created,
            runs: existing.as_ref().map_or(0, |e| e.runs),
            history: existing.map(|e| e.history).unwrap_or_default(),
        };

        self.persist(&mut design)?;
        Ok(design)
    }

    /// Begin a run of one design.
    pub fn start(&mut self, options: &StartOptions, snapshot: &dyn Fn() -> LoopSnapshot) -> Result<LoopStartResult> {
        if let Some(running) = &self.running {
            return Err(OkfError::message(messages::loop_already_running(running)));
        }

        let mut design = self.read(&options.name)?;
        // A file edited by hand could leave a run marked running; treat the
        // design as busy rather than starting a second one into the same history.
        if design.history.first().is_some_and(|r| r.status == RunStatus::Running) {
            self.running = Some(design.name.clone());
            return Err(OkfError::message(messages::loop_already_running(&design.name)));
        }

        let before = snapshot();
        let previous = design.history.first().cloned();

        let run = LoopRun {
            started: super::error::iso_of(options.now.unwrap_or_else(Utc::now)),
            ended: None,
            status: RunStatus::Running,
            before,
            after: None,
            journal: Vec::new(),
            outcome: None,
            summary: None,
        };

        design.history.insert(0, run);
        design.runs += 1;
        self.persist(&mut design)?;
        self.running = Some(design.name.clone());

        Ok(LoopStartResult {
            name: design.name.clone(),
            path: self.rel_path_of(&design.name),
            goal: design.goal.clone(),
            skill: design.skill.clone().filter(|s| !s.is_empty()),
            checks: design.checks.clone(),
            before,
            last_run: previous.map(|p| LastRun {
                started: p.started,
                status: p.status.as_str().to_string(),
                outcome: p.outcome.filter(|o| !o.is_empty()),
            }),
            run_number: design.runs,
            suggested: options.suggested.clone(),
        })
    }

    /// Append to the running run's journal. Does nothing when no run is open.
    pub fn note(&mut self, action: &str, detail: &str, now: Option<DateTime<Utc>>) -> Result<()> {
        let Some(running) = self.running.clone() else {
            return Ok(());
        };

        let design = self.read(&running).ok();
        let Some(mut design) = design.filter(|d| d.history.first().is_some_and(|r| r.status == RunStatus::Running))
        else {
            self.running = None;
            return Ok(());
        };

        let at = super::error::iso_of(now.unwrap_or_else(Utc::now))[11..19].to_string();
        if let Some(run) = design.history.first_mut() {
            run.journal.push(crate::shared::okf::loop_::RunJournalEntry {
                at,
                action: action.to_string(),
                detail: detail.to_string(),
            });
        }
        self.persist(&mut design)
    }

    /// Close the running run, recording the postflight and the comparison.
    pub fn end(&mut self, options: &EndOptions, snapshot: &dyn Fn() -> LoopSnapshot) -> Result<LoopEndResult> {
        let Some(running) = self.running.clone() else {
            return Err(OkfError::message(messages::LOOP_NONE_RUNNING));
        };

        let mut design = self.read(&running)?;
        if !design.history.first().is_some_and(|r| r.status == RunStatus::Running) {
            self.running = None;
            return Err(OkfError::message(messages::LOOP_NONE_RUNNING));
        }

        let after = snapshot();
        let (before, regressed, diff) = {
            let run = &mut design.history[0];
            run.after = Some(after);
            run.status = options.status.unwrap_or(RunStatus::Done);
            run.ended = Some(super::error::iso_of(options.now.unwrap_or_else(Utc::now)));
            if let Some(outcome) = options.outcome.as_deref().map(js_trim).filter(|o| !o.is_empty()) {
                run.outcome = Some(outcome.to_string());
            }
            (run.before, is_regression(&run.before, &after), render_diff(&run.before, &after))
        };

        self.persist(&mut design)?;
        self.running = None;

        Ok(LoopEndResult {
            name: design.name.clone(),
            path: self.rel_path_of(&design.name),
            before,
            after,
            diff,
            run_number: design.runs,
            regressed,
            checks: design.checks.clone(),
        })
    }

    /// Write a design out, trimming history to the caps.
    ///
    /// Written to a temporary file and renamed, so an interrupted write cannot
    /// leave a half-rendered design where the history used to be.
    fn persist(&self, design: &mut LoopDesign) -> Result<()> {
        design.history.truncate(SUMMARY_RUNS);

        error::mkdir_p(&self.paths.loops_root())?;
        let abs = self.abs_path_of(&design.name);
        let temp = format!("{abs}.tmp");
        error::write_text(&temp, &render_loop(design))?;
        error::rename(&temp, &abs)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space(dir: &std::path::Path) -> LoopSpace {
        std::fs::create_dir_all(dir.join("wiki")).unwrap();
        LoopSpace::new(BundlePaths::new(dir.to_str().unwrap(), "wiki"))
    }

    fn snap(concepts: i64) -> LoopSnapshot {
        LoopSnapshot {
            concepts,
            non_conformant: 0,
            unresolved_links: 0,
        }
    }

    fn define(s: &LoopSpace, name: &str) -> LoopDesign {
        s.define(&DefineOptions {
            name: Some(name.into()),
            goal: "keep the wiki healthy".into(),
            ..Default::default()
        })
        .unwrap()
    }

    #[test]
    fn define_creates_one_file_and_update_keeps_history() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = space(dir.path());
        define(&s, "weekly");
        s.start(&StartOptions { name: "weekly".into(), ..Default::default() }, &|| snap(1)).unwrap();
        s.end(&EndOptions::default(), &|| snap(2)).unwrap();

        let updated = s
            .define(&DefineOptions {
                name: Some("weekly".into()),
                goal: "new goal".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(updated.goal, "new goal");
        assert_eq!(updated.runs, 1);
        assert_eq!(updated.history.len(), 1);
        assert_eq!(s.list(), vec!["weekly"]);
    }

    #[test]
    fn one_run_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = space(dir.path());
        define(&s, "a");
        define(&s, "b");
        let first = s.start(&StartOptions { name: "a".into(), ..Default::default() }, &|| snap(0)).unwrap();
        assert_eq!(first.run_number, 1);
        let err = s
            .start(&StartOptions { name: "b".into(), ..Default::default() }, &|| snap(0))
            .unwrap_err();
        assert_eq!(err.to_string(), messages::loop_already_running("a"));
    }

    #[test]
    fn notes_append_to_the_running_run_and_end_closes_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = space(dir.path());
        define(&s, "a");
        s.note("ignored", "no run yet", None).unwrap();
        s.start(&StartOptions { name: "a".into(), ..Default::default() }, &|| snap(5)).unwrap();
        s.note("write", "x.md", None).unwrap();
        let ended = s
            .end(&EndOptions { outcome: Some("  ok ".into()), ..Default::default() }, &|| snap(3))
            .unwrap();
        assert_eq!(ended.run_number, 1);
        let design = s.read("a").unwrap();
        assert_eq!(design.history[0].journal.len(), 1);
        assert_eq!(design.history[0].outcome.as_deref(), Some("ok"));
        assert_eq!(design.history[0].status, RunStatus::Done);
        assert_eq!(s.end(&EndOptions::default(), &|| snap(0)).unwrap_err().to_string(), messages::LOOP_NONE_RUNNING);
    }

    #[test]
    fn resume_finds_an_unfinished_run() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = space(dir.path());
        define(&s, "a");
        s.start(&StartOptions { name: "a".into(), ..Default::default() }, &|| snap(0)).unwrap();
        let mut fresh = LoopSpace::new(s.paths.clone());
        assert_eq!(fresh.resume().as_deref(), Some("a"));
        assert!(fresh.start(&StartOptions { name: "a".into(), ..Default::default() }, &|| snap(0)).is_err());
    }

    #[test]
    fn names_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let s = space(dir.path());
        assert!(s.read("../x").is_err());
        assert!(s.define(&DefineOptions { goal: " ".into(), ..Default::default() }).is_err());
        assert!(s.read("missing").unwrap_err().to_string().contains("missing"));
    }
}
