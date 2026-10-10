//! Loops: one file per loop *design*, holding that design's run history
//! (`src/shared/okf/loop.ts`; `loop` is a Rust keyword, hence `loop_`).
//!
//! A loop design is a repeatable unit of agent work, written once and run many
//! times. Each design owns exactly one file and every run of it appends to that
//! file and no other; two designs never share a file, and a run never writes
//! outside its own design's file. A file per *run* would grow without bound, so
//! the unit is the design and history lives inside it, capped: recent runs stay
//! in full detail, older ones collapse to a single line, and beyond that they
//! are dropped with only the total run count kept.
//!
//! Pure; the caller does the filesystem work.

use super::frontmatter::split_frontmatter;
use crate::shared::js_compat::{find_at_line_start, js_number, js_regex, js_trim, split_crlf};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Done,
    Abandoned,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Abandoned => "abandoned",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "running" => Some(Self::Running),
            "done" => Some(Self::Done),
            "abandoned" => Some(Self::Abandoned),
            _ => None,
        }
    }
}

/// Counts that describe the health of the bundle at a point in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSnapshot {
    pub concepts: i64,
    pub non_conformant: i64,
    pub unresolved_links: i64,
}

impl LoopSnapshot {
    pub const ZERO: Self = Self {
        concepts: 0,
        non_conformant: 0,
        unresolved_links: 0,
    };
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunJournalEntry {
    pub at: String,
    pub action: String,
    pub detail: String,
}

/// Pre-rendered deltas, kept when a run has aged into the summary tier.
///
/// A one-line summary cannot carry both snapshots, so once a run is collapsed
/// its `before`/`after` are gone. Without this the next rewrite of the file
/// would re-render it as "未完了": the history would decay every time it was
/// touched, which is worse than dropping it outright.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub concepts: String,
    pub non_conformant: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopRun {
    pub started: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<String>,
    pub status: RunStatus,
    pub before: LoopSnapshot,
    // Field order is the key order of a run parsed from a file (the TS builds
    // the object in that order), which `loop_read` shows verbatim.
    pub journal: Vec<RunJournalEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<LoopSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<RunSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopDesign {
    /// Identifier and filename.
    pub name: String,
    /// What this loop accomplishes, every time it runs.
    pub goal: String,
    /// Skill to follow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    /// What must be true before the run is considered finished.
    pub checks: Vec<String>,
    pub created: String,
    /// Total runs ever, including ones aged out of the history.
    pub runs: i64,
    /// Runs newest first, subject to the caps below.
    pub history: Vec<LoopRun>,
}

/// Runs kept with their full journal.
pub const DETAILED_RUNS: usize = 5;
/// Runs kept as a one-line summary after that.
pub const SUMMARY_RUNS: usize = 25;

const SECTION_DESIGN: &str = "## 設計";
const SECTION_HISTORY: &str = "## 実行履歴";

static NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").unwrap());

pub fn is_valid_loop_name(name: &str) -> bool {
    NAME_RE.is_match(name)
}

/// Turn a goal into a usable loop name (ASCII only; anything else degrades to
/// `"loop"`).
pub fn slugify_loop_name(goal: &str, max: usize) -> String {
    let lower = goal.to_lowercase();
    let mut slug = String::new();
    let mut pending_dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(c);
        } else {
            pending_dash = true;
        }
    }
    slug.truncate(max);
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "loop".to_string()
    } else {
        slug.to_string()
    }
}

/// [`slugify_loop_name`] with the TS default `max` of 40.
pub fn slugify_loop_name_default(goal: &str) -> String {
    slugify_loop_name(goal, 40)
}

fn snapshot_inline(s: &LoopSnapshot) -> String {
    format!(
        "概念 {} / 非準拠 {} / 未解決 {}",
        s.concepts, s.non_conformant, s.unresolved_links
    )
}

fn delta(before: i64, after: i64) -> String {
    let diff = after - before;
    if diff == 0 {
        "±0".to_string()
    } else if diff > 0 {
        format!("+{diff}")
    } else {
        diff.to_string()
    }
}

/// The postflight comparison, which is why a preflight is taken at all.
pub fn render_diff(before: &LoopSnapshot, after: &LoopSnapshot) -> Vec<String> {
    vec![
        format!(
            "- 概念: {} → {} ({})",
            before.concepts,
            after.concepts,
            delta(before.concepts, after.concepts)
        ),
        format!(
            "- OKF 非準拠: {} → {} ({})",
            before.non_conformant,
            after.non_conformant,
            delta(before.non_conformant, after.non_conformant)
        ),
        format!(
            "- 未解決リンク: {} → {} ({})",
            before.unresolved_links,
            after.unresolved_links,
            delta(before.unresolved_links, after.unresolved_links)
        ),
    ]
}

/// Whether a run left the bundle worse than it found it.
///
/// Only non-conformance counts. More unresolved links is normal and usually
/// good: it means the work identified knowledge that is missing, which is the
/// whole point of linking to pages that do not exist yet.
pub fn is_regression(before: &LoopSnapshot, after: &LoopSnapshot) -> bool {
    after.non_conformant > before.non_conformant
}

fn outcome_or(run: &LoopRun, fallback: &str) -> String {
    run.outcome
        .as_deref()
        .map(js_trim)
        .filter(|o| !o.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn render_run_detailed(run: &LoopRun) -> Vec<String> {
    let mut lines = vec![
        format!("### {} — {}", run.started, run.status.as_str()),
        String::new(),
    ];
    lines.push(format!("- 開始: {}", snapshot_inline(&run.before)));

    if let Some(after) = &run.after {
        lines.push(format!(
            "- 終了: {} (概念 {} · 非準拠 {} · 未解決 {})",
            snapshot_inline(after),
            delta(run.before.concepts, after.concepts),
            delta(run.before.non_conformant, after.non_conformant),
            delta(run.before.unresolved_links, after.unresolved_links)
        ));
    }

    if !run.journal.is_empty() {
        lines.push("- 経過:".to_string());
        for entry in &run.journal {
            lines.push(format!(
                "  - `{}` **{}** {}",
                entry.at, entry.action, entry.detail
            ));
        }
    }

    lines.push(format!("- 結果: {}", outcome_or(run, "（未記入）")));
    if let Some(after) = &run.after {
        if is_regression(&run.before, after) {
            lines.push("- ⚠ OKF 非準拠が増えました".to_string());
        }
    }
    lines.push(String::new());
    lines
}

/// Older runs: one line, enough to see the shape of the history.
///
/// The deltas are emitted in a fixed order so the line can be read back and
/// re-emitted unchanged: a summarised run must survive every later rewrite of
/// the file, not decay a little each time.
fn render_run_summary(run: &LoopRun) -> String {
    let concepts = match (&run.summary, &run.after) {
        (Some(s), _) => s.concepts.clone(),
        (None, Some(after)) => delta(run.before.concepts, after.concepts),
        (None, None) => "?".to_string(),
    };
    let non_conformant = match (&run.summary, &run.after) {
        (Some(s), _) => s.non_conformant.clone(),
        (None, Some(after)) => delta(run.before.non_conformant, after.non_conformant),
        (None, None) => "?".to_string(),
    };

    let outcome = run
        .outcome
        .as_deref()
        .map(|o| js_trim(o).split('\n').next().unwrap_or("").to_string())
        .unwrap_or_default();
    let tail = if outcome.is_empty() {
        String::new()
    } else {
        format!(" · {outcome}")
    };
    format!(
        "- `{}` {} · 概念 {concepts} · 非準拠 {non_conformant}{tail}",
        run.started,
        run.status.as_str()
    )
}

pub fn render_loop(design: &LoopDesign) -> String {
    let running = design
        .history
        .iter()
        .any(|run| run.status == RunStatus::Running);

    let mut lines: Vec<String> = vec![
        "---".to_string(),
        format!("loop: {}", design.name),
        format!("goal: {}", design.goal),
    ];
    if let Some(skill) = design.skill.as_deref().filter(|s| !s.is_empty()) {
        lines.push(format!("skill: {skill}"));
    }
    lines.push(format!("created: {}", design.created));
    lines.push(format!("runs: {}", design.runs));
    lines.push(format!(
        "status: {}",
        if running { "running" } else { "idle" }
    ));
    lines.extend([
        "---".to_string(),
        String::new(),
        format!("# {}", design.goal),
        String::new(),
    ]);
    lines.extend([SECTION_DESIGN.to_string(), String::new()]);
    lines.push(format!("- ループ名: `{}`", design.name));
    lines.push(format!(
        "- 使うスキル: {}",
        match design.skill.as_deref().filter(|s| !s.is_empty()) {
            Some(skill) => format!("`{skill}`"),
            None => "（未指定）".to_string(),
        }
    ));
    lines.push("- 完了条件:".to_string());

    if design.checks.is_empty() {
        lines.push("  - （未設定）".to_string());
    } else {
        for check in &design.checks {
            lines.push(format!("  - {check}"));
        }
    }

    lines.extend([String::new(), SECTION_HISTORY.to_string(), String::new()]);

    if design.history.is_empty() {
        lines.push("（まだ実行されていません）".to_string());
        lines.push(String::new());
    } else {
        let detailed = &design.history[..design.history.len().min(DETAILED_RUNS)];
        let summarised: &[LoopRun] = if design.history.len() > DETAILED_RUNS {
            &design.history[DETAILED_RUNS..design.history.len().min(SUMMARY_RUNS)]
        } else {
            &[]
        };

        for run in detailed {
            lines.extend(render_run_detailed(run));
        }

        if !summarised.is_empty() {
            lines.push("### 以前の実行".to_string());
            lines.push(String::new());
            for run in summarised {
                lines.push(render_run_summary(run));
            }
            lines.push(String::new());
        }

        let dropped = design.runs - design.history.len().min(SUMMARY_RUNS) as i64;
        if dropped > 0 {
            lines.push(format!(
                "（さらに {dropped} 回の実行は記録から省略されています）"
            ));
            lines.push(String::new());
        }
    }

    lines.join("\n")
}

static SNAPSHOT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"概念 ([0-9]+) / 非準拠 ([0-9]+) / 未解決 ([0-9]+)").unwrap());

fn parse_snapshot_inline(text: &str) -> Option<LoopSnapshot> {
    let caps = SNAPSHOT_RE.captures(text)?;
    let n = |i: usize| caps[i].parse::<i64>().unwrap_or(i64::MAX);
    Some(LoopSnapshot {
        concepts: n(1),
        non_conformant: n(2),
        unresolved_links: n(3),
    })
}

/// Text under `heading`, up to the next `## ` line, trimmed.
fn section(body: &str, heading: &str) -> String {
    let Some(start) = body.find(heading) else {
        return String::new();
    };
    let after = start + heading.len();
    let rest = &body[after..];
    let end = find_at_line_start(rest, "## ").unwrap_or(rest.len());
    js_trim(&rest[..end]).to_string()
}

static HEADER_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^([A-Za-z_-]+)<S>*:<S>*(<DOT>*)$"));
static CHECKS_HEAD_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^-<S>*完了条件:"));
static CHECK_ITEM_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^<S>{2,}-<S>+(<DOT>*)$"));

/// Read a loop file back.
///
/// Tolerant by design: these are meant to be edited by hand (a person adding a
/// completion check, or correcting an outcome), so a file that no longer parses
/// perfectly must still yield a usable design.
///
/// `runs` is an integer here; a hand-edited fractional value is truncated.
pub fn parse_loop(raw: &str, fallback_name: &str) -> LoopDesign {
    let split = split_frontmatter(raw);
    let body = split.body;
    let mut header: HashMap<String, String> = HashMap::new();

    for line in split_crlf(split.yaml.as_deref().unwrap_or("")) {
        if let Some(caps) = HEADER_LINE_RE.captures(line) {
            header.insert(caps[1].to_string(), js_trim(&caps[2]).to_string());
        }
    }

    let design_text = section(&body, SECTION_DESIGN);
    let mut checks: Vec<String> = Vec::new();
    let mut in_checks = false;
    for line in split_crlf(&design_text) {
        if CHECKS_HEAD_RE.is_match(js_trim(line)) {
            in_checks = true;
            continue;
        }
        if in_checks {
            if let Some(item) = CHECK_ITEM_RE.captures(line) {
                let value = js_trim(&item[1]);
                if !value.is_empty() && value != "（未設定）" {
                    checks.push(value.to_string());
                }
                continue;
            }
            if !js_trim(line).is_empty() {
                in_checks = false;
            }
        }
    }

    let history = parse_history(&section(&body, SECTION_HISTORY));
    // `Number(header.runs)`: absent is NaN, empty is 0, anything unparseable NaN.
    let parsed_runs = header.get("runs").map_or(f64::NAN, |v| js_number(v));

    LoopDesign {
        name: header
            .get("loop")
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| fallback_name.to_string()),
        goal: header.get("goal").cloned().unwrap_or_default(),
        skill: header.get("skill").filter(|v| !v.is_empty()).cloned(),
        checks,
        created: header.get("created").cloned().unwrap_or_default(),
        runs: if parsed_runs.is_finite() {
            parsed_runs as i64
        } else {
            history.len() as i64
        },
        history,
    }
}

static RUN_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^###<S>+(<NS>+)<S>+—<S>+(running|done|abandoned)<S>*$"));
/// The collapsed tail. Fixed field order, so the deltas and the outcome can be
/// told apart even though both may contain the separator.
static RUN_SUMMARY_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^-<S>+`(<NS>+)`<S>+(running|done|abandoned)<S>+·<S>+概念<S>+(<NS>+)<S>+·<S>+非準拠<S>+(<NS>+)(?:<S>+·<S>+(<DOT>*))?$",
    )
});
static JOURNAL_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^<S>+-<S>+`([^`]+)`<S>+\*\*([^*]+)\*\*<S>*(<DOT>*)$"));

fn parse_history(text: &str) -> Vec<LoopRun> {
    let mut runs: Vec<LoopRun> = Vec::new();
    let mut current: Option<LoopRun> = None;

    let flush = |current: &mut Option<LoopRun>, runs: &mut Vec<LoopRun>| {
        if let Some(run) = current.take() {
            runs.push(run);
        }
    };

    for line in split_crlf(text) {
        let trimmed = js_trim(line);

        if let Some(heading) = RUN_HEADING_RE.captures(trimmed) {
            flush(&mut current, &mut runs);
            current = Some(LoopRun {
                started: heading[1].to_string(),
                status: RunStatus::parse(&heading[2]).unwrap_or(RunStatus::Running),
                before: LoopSnapshot::ZERO,
                after: None,
                journal: vec![],
                outcome: None,
                ended: None,
                summary: None,
            });
            continue;
        }

        if let Some(summary) = RUN_SUMMARY_RE.captures(trimmed) {
            flush(&mut current, &mut runs);
            let outcome = summary
                .get(5)
                .map(|m| js_trim(m.as_str()))
                .filter(|o| !o.is_empty());
            runs.push(LoopRun {
                started: summary[1].to_string(),
                status: RunStatus::parse(&summary[2]).unwrap_or(RunStatus::Running),
                before: LoopSnapshot::ZERO,
                after: None,
                journal: vec![],
                outcome: outcome.map(str::to_string),
                ended: None,
                summary: Some(RunSummary {
                    concepts: summary[3].to_string(),
                    non_conformant: summary[4].to_string(),
                }),
            });
            continue;
        }

        let Some(run) = current.as_mut() else {
            continue;
        };

        if trimmed.starts_with("- 開始:") {
            if let Some(before) = parse_snapshot_inline(line) {
                run.before = before;
            }
        } else if trimmed.starts_with("- 終了:") {
            if let Some(after) = parse_snapshot_inline(line) {
                run.after = Some(after);
            }
        } else if let Some(outcome) = trimmed.strip_prefix("- 結果:") {
            let outcome = js_trim(outcome);
            if !outcome.is_empty() && outcome != "（未記入）" {
                run.outcome = Some(outcome.to_string());
            }
        } else if let Some(entry) = JOURNAL_RE.captures(line) {
            run.journal.push(RunJournalEntry {
                at: entry[1].to_string(),
                action: js_trim(&entry[2]).to_string(),
                detail: js_trim(&entry[3]).to_string(),
            });
        }
    }

    flush(&mut current, &mut runs);
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(c: i64, n: i64, u: i64) -> LoopSnapshot {
        LoopSnapshot {
            concepts: c,
            non_conformant: n,
            unresolved_links: u,
        }
    }

    fn design() -> LoopDesign {
        LoopDesign {
            name: "ingest-notes".into(),
            goal: "議事録を取り込む".into(),
            skill: Some("okf-ingest".into()),
            checks: vec![
                "未解決リンクを確認した".into(),
                "index.md を再構築した".into(),
            ],
            created: "2026-08-01T00:00:00Z".into(),
            runs: 2,
            history: vec![
                LoopRun {
                    started: "2026-08-02T14:30:00Z".into(),
                    ended: Some("2026-08-02T14:52:00Z".into()),
                    status: RunStatus::Done,
                    before: snap(42, 0, 7),
                    after: Some(snap(45, 0, 9)),
                    journal: vec![RunJournalEntry {
                        at: "14:35:00".into(),
                        action: "create".into(),
                        detail: "wiki/a.md".into(),
                    }],
                    outcome: Some("3 ページ作成".into()),
                    summary: None,
                },
                LoopRun {
                    started: "2026-08-01T09:00:00Z".into(),
                    ended: None,
                    status: RunStatus::Done,
                    before: snap(40, 0, 5),
                    after: Some(snap(42, 0, 7)),
                    journal: vec![],
                    outcome: Some("2 ページ作成".into()),
                    summary: None,
                },
            ],
        }
    }

    fn finished_run(n: usize) -> LoopRun {
        LoopRun {
            started: format!("2026-08-{:02}T09:00:00Z", (n % 28) + 1),
            ended: None,
            status: RunStatus::Done,
            before: snap(10, 0, 3),
            after: Some(snap(10, 0, 3)),
            journal: vec![RunJournalEntry {
                at: "09:00:00".into(),
                action: "note".into(),
                detail: format!("詳細 {n}"),
            }],
            outcome: Some(format!("run {n}")),
            summary: None,
        }
    }

    // ---- loop names ----

    #[test]
    fn a_goal_becomes_a_usable_name() {
        assert_eq!(
            slugify_loop_name_default("Ingest meeting notes"),
            "ingest-meeting-notes"
        );
    }

    #[test]
    fn japanese_goals_still_yield_a_valid_name() {
        // Japanese cannot survive in an ASCII identifier, so it degrades to a
        // default rather than producing something unusable as a filename.
        assert!(is_valid_loop_name(&slugify_loop_name_default(
            "議事録を取り込む"
        )));
        assert_eq!(slugify_loop_name_default("議事録を取り込む"), "loop");
    }

    #[test]
    fn path_separators_can_never_appear_in_a_name() {
        assert!(!is_valid_loop_name("../escape"));
        assert!(!is_valid_loop_name("a/b"));
        assert!(!is_valid_loop_name("Weekly Lint"));
        assert!(is_valid_loop_name("weekly-lint"));
    }

    #[test]
    fn slugs_are_bounded_and_have_no_dangling_dash() {
        assert_eq!(slugify_loop_name("  Hello,  World!! ", 40), "hello-world");
        assert_eq!(slugify_loop_name("abc def ghi", 4), "abc");
        assert_eq!(slugify_loop_name("日本 a 語 b", 40), "a-b");
    }

    // ---- the design file ----

    #[test]
    fn round_trips_through_render_and_parse() {
        let design = design();
        let again = parse_loop(&render_loop(&design), &design.name);

        assert_eq!(again.goal, design.goal);
        assert_eq!(again.skill.as_deref(), Some("okf-ingest"));
        assert_eq!(again.checks, design.checks);
        assert_eq!(again.runs, 2);
        assert_eq!(again.history.len(), 2);
        assert_eq!(again.history[0].journal, design.history[0].journal);
        assert_eq!(again.history[0].outcome.as_deref(), Some("3 ページ作成"));
        assert_eq!(again.history[0].before, design.history[0].before);
        assert_eq!(again.history[0].after, design.history[0].after);
    }

    #[test]
    fn a_design_that_has_never_run_is_still_valid() {
        let fresh = parse_loop(
            &render_loop(&LoopDesign {
                runs: 0,
                history: vec![],
                ..design()
            }),
            "ingest-notes",
        );
        assert!(fresh.history.is_empty());
        assert_eq!(fresh.runs, 0);
    }

    #[test]
    fn a_hand_edited_file_still_parses() {
        let parsed = parse_loop("---\nloop: x\ngoal: 手で書いた\n---\n\n# 手で書いた\n", "x");
        assert_eq!(parsed.goal, "手で書いた");
        assert!(parsed.history.is_empty());
        assert_eq!(parsed.runs, 0);
    }

    #[test]
    fn only_rising_non_conformance_counts_as_a_regression() {
        let base = snap(10, 0, 3);
        assert!(is_regression(
            &base,
            &LoopSnapshot {
                non_conformant: 1,
                ..base
            }
        ));
        // More unresolved links means gaps were identified: that is the point.
        assert!(!is_regression(
            &base,
            &LoopSnapshot {
                unresolved_links: 9,
                ..base
            }
        ));
    }

    #[test]
    fn render_layout_is_byte_exact() {
        let rendered = render_loop(&design());
        let expected = "---\nloop: ingest-notes\ngoal: 議事録を取り込む\nskill: okf-ingest\ncreated: 2026-08-01T00:00:00Z\nruns: 2\nstatus: idle\n---\n\n# 議事録を取り込む\n\n## 設計\n\n- ループ名: `ingest-notes`\n- 使うスキル: `okf-ingest`\n- 完了条件:\n  - 未解決リンクを確認した\n  - index.md を再構築した\n\n## 実行履歴\n\n### 2026-08-02T14:30:00Z — done\n\n- 開始: 概念 42 / 非準拠 0 / 未解決 7\n- 終了: 概念 45 / 非準拠 0 / 未解決 9 (概念 +3 · 非準拠 ±0 · 未解決 +2)\n- 経過:\n  - `14:35:00` **create** wiki/a.md\n- 結果: 3 ページ作成\n\n### 2026-08-01T09:00:00Z — done\n\n- 開始: 概念 40 / 非準拠 0 / 未解決 5\n- 終了: 概念 42 / 非準拠 0 / 未解決 7 (概念 +2 · 非準拠 ±0 · 未解決 +2)\n- 結果: 2 ページ作成\n";
        assert_eq!(rendered, expected);
    }

    #[test]
    fn a_never_run_design_renders_its_placeholders() {
        let rendered = render_loop(&LoopDesign {
            skill: None,
            checks: vec![],
            runs: 0,
            history: vec![],
            ..design()
        });
        assert!(rendered.contains("- 使うスキル: （未指定）\n- 完了条件:\n  - （未設定）\n"));
        assert!(rendered.ends_with("## 実行履歴\n\n（まだ実行されていません）\n"));
        let parsed = parse_loop(&rendered, "ingest-notes");
        assert!(parsed.checks.is_empty());
        assert_eq!(parsed.skill, None);
    }

    #[test]
    fn a_regression_is_flagged_in_the_run() {
        let mut d = design();
        d.history[0].after = Some(snap(45, 2, 9));
        assert!(render_loop(&d).contains("- ⚠ OKF 非準拠が増えました"));
    }

    #[test]
    fn a_running_run_marks_the_design_running() {
        let mut d = design();
        d.history[0].status = RunStatus::Running;
        d.history[0].after = None;
        assert!(render_loop(&d).contains("status: running"));
        assert!(render_loop(&d).contains("### 2026-08-02T14:30:00Z — running"));
    }

    #[test]
    fn diff_lines_show_the_delta() {
        assert_eq!(
            render_diff(&snap(10, 1, 5), &snap(12, 0, 5)),
            [
                "- 概念: 10 → 12 (+2)",
                "- OKF 非準拠: 1 → 0 (-1)",
                "- 未解決リンク: 5 → 5 (±0)"
            ]
        );
    }

    // ---- bounded history (the pure half of the TS tests) ----

    fn long_design(total: usize) -> LoopDesign {
        let history: Vec<LoopRun> = (0..total).rev().map(finished_run).collect();
        LoopDesign {
            name: "weekly-lint".into(),
            goal: "Weekly lint".into(),
            skill: None,
            checks: vec![],
            created: "2026-08-01T00:00:00Z".into(),
            runs: total as i64,
            history,
        }
    }

    #[test]
    fn runs_beyond_the_cap_are_dropped_but_the_count_survives() {
        let total = SUMMARY_RUNS + 5;
        let raw = render_loop(&long_design(total));
        let parsed = parse_loop(&raw, "weekly-lint");

        assert_eq!(parsed.runs, total as i64);
        // The file must stay readable no matter how long the loop has been in use.
        assert!(parsed.history.len() <= SUMMARY_RUNS);
        assert!(raw.contains("回の実行は記録から省略"));
        assert!(raw.contains("（さらに 5 回の実行は記録から省略されています）"));
    }

    #[test]
    fn only_the_most_recent_runs_keep_their_journal() {
        let total = DETAILED_RUNS + 3;
        let raw = render_loop(&long_design(total));
        let latest = DETAILED_RUNS + 2;
        assert!(raw.contains(&format!("詳細 {latest}")));
        // The oldest run's journal is gone; its one-line summary is not.
        assert!(!raw.contains("詳細 0"));
        assert!(raw.contains("run 0"));
    }

    #[test]
    fn a_summarised_run_does_not_decay_on_later_rewrites() {
        // Push a run past the detail cap, then rewrite several times so its
        // summary line is parsed and re-emitted.
        let mut design = long_design(DETAILED_RUNS + 6);
        let mut raw = render_loop(&design);
        for _ in 0..4 {
            design = parse_loop(&raw, "weekly-lint");
            raw = render_loop(&design);
        }

        // Every summarised run finished, so none of them may read as unfinished.
        assert!(!raw.contains("未完了"));
        assert!(raw.contains("run 0"));

        let oldest = design.history.last().unwrap();
        assert_eq!(oldest.status, RunStatus::Done);
        assert_eq!(oldest.summary.as_ref().unwrap().non_conformant, "±0");
    }

    #[test]
    fn a_file_with_a_long_history_stays_a_reasonable_size() {
        let raw = render_loop(&long_design(SUMMARY_RUNS + 10));
        assert!(raw.len() < 8000, "{}", raw.len());
    }

    #[test]
    fn a_summary_line_keeps_the_first_line_of_the_outcome_only() {
        let mut design = long_design(DETAILED_RUNS + 1);
        design.history[DETAILED_RUNS].outcome = Some("first\nsecond".into());
        let raw = render_loop(&design);
        assert!(raw.contains(" · first\n") || raw.ends_with(" · first"));
        assert!(!raw.contains("second"));
    }

    #[test]
    fn runs_header_follows_javascript_number_rules() {
        assert_eq!(parse_loop("---\nruns:\n---\n", "x").runs, 0);
        assert_eq!(parse_loop("---\nruns: abc\n---\n", "x").runs, 0);
        assert_eq!(parse_loop("---\nruns: 7\n---\n", "x").runs, 7);
        assert_eq!(parse_loop("---\nloop: z\n---\n", "x").name, "z");
        assert_eq!(parse_loop("---\nloop:\n---\n", "x").name, "x");
    }
}
