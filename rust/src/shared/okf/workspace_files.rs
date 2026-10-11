//! The three orientation files: `MAP.md`, `human.md`, `Task.md`
//! (`src/shared/okf/workspace-files.ts`).
//!
//! They sit at the bundle root, **beside** the three layers. They answer the
//! questions an agent has *before* it knows anything: who am I working for, what
//! am I supposed to be doing, and where does everything live. `MAP.md` is a
//! small routing table rendered from code (so it cannot drift from the layout),
//! `Task.md` is queryable (open work is a handful of lines; history is
//! unbounded), and `human.md` is deliberately not parsed.

use super::para::{parse_para_class, ParaClass, PARA_ORDER};
use crate::shared::js_compat::{js_regex, js_trim_end, split_crlf};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

pub const MAP_FILE: &str = "MAP.md";
pub const HUMAN_FILE: &str = "human.md";
pub const TASK_FILE: &str = "Task.md";
/// Beside MAP.md and reserved like it; see `systemmap.rs`.
pub const SYSTEMMAP_FILE: &str = "SYSTEMMAP.md";

/// Lowercase basenames of the wiki-layer files that are not concepts.
///
/// Kept apart from OKF's reserved set on purpose: OKF §3 reserves exactly
/// `index.md` and `log.md`.
pub const WORKSPACE_FILENAMES: [&str; 4] = ["map.md", "human.md", "task.md", "systemmap.md"];

pub fn is_workspace_filename(name: &str) -> bool {
    WORKSPACE_FILENAMES.contains(&name.to_lowercase().as_str())
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Doing,
    Todo,
    Done,
}

/// A task. JSON key order follows the order `parseTasks` assigns them in a
/// normally rendered line (`para`, `due`, `done`, then `note`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    /// `T-0007`. Stable across edits so notes and commits can refer to it.
    pub id: String,
    pub title: String,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub para: Option<ParaClass>,
    /// ISO date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    /// ISO date the task was completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<String>,
    /// One line of detail, indented under the item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Task {
    pub fn new(id: impl Into<String>, title: impl Into<String>, status: TaskStatus) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            status,
            para: None,
            due: None,
            done: None,
            note: None,
        }
    }
}

/// Completed tasks kept in the file. Finished work is worth a little memory and
/// not much; the count of everything ever completed is kept in the heading.
pub const KEPT_DONE_TASKS: usize = 25;

const SECTION_DOING: &str = "## 進行中";
const SECTION_TODO: &str = "## 未着手";
const SECTION_DONE: &str = "## 完了";

/// Status comes from the section a task sits in, not from the checkbox.
const SECTION_STATUS: [(&str, TaskStatus); 3] = [
    (SECTION_DOING, TaskStatus::Doing),
    (SECTION_TODO, TaskStatus::Todo),
    (SECTION_DONE, TaskStatus::Done),
];

static TASK_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^<S>*-<S>*\[( |x|X)\]<S>*(T-<D>{4})<S>+(<DOT>*)$"));
static ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^T-([0-9]{4})$").unwrap());
static DUE_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^期限<S>*(<NS>+)"));
static DONE_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^完了<S>*(<NS>+)"));
static TOTAL_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"全<S>*([0-9]+)<S>*件"));
static NOTE_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^<S>{4,}<NS>"));
static H2_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^##<S>"));

pub fn format_task_id(n: u64) -> String {
    format!("T-{n:04}")
}

/// The next free id, so two agents appending do not collide on a number.
pub fn next_task_id(tasks: &[Task]) -> String {
    let mut highest = 0u64;
    for task in tasks {
        if let Some(caps) = ID_RE.captures(&task.id) {
            highest = highest.max(caps[1].parse().unwrap_or(0));
        }
    }
    format_task_id(highest + 1)
}

/// Render one task.
///
/// Metadata rides on the same line separated by `·`, which keeps a task to one
/// line in every renderer while staying trivially parseable. The checkbox is
/// only ever `[ ]` or `[x]`; "doing" is expressed by the section.
fn render_task(task: &Task) -> String {
    let mut parts = vec![task.title.clone()];
    // The PARA class round-trips as its own name, which `parse_para_class`
    // reads back directly.
    if let Some(para) = task.para {
        parts.push(para.as_str().to_string());
    }
    if let Some(due) = task.due.as_deref().filter(|d| !d.is_empty()) {
        parts.push(format!("期限 {due}"));
    }
    if let Some(done) = task.done.as_deref().filter(|d| !d.is_empty()) {
        parts.push(format!("完了 {done}"));
    }

    let check = if task.status == TaskStatus::Done {
        "x"
    } else {
        " "
    };
    let head = format!("- [{check}] {} {}", task.id, parts.join(" · "));
    match task.note.as_deref().filter(|n| !n.is_empty()) {
        Some(note) => format!("{head}\n      {note}"),
        None => head,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFile {
    pub tasks: Vec<Task>,
    /// Completed tasks ever, including those aged out of the file.
    pub done_ever: u64,
}

pub fn render_tasks(file: &TaskFile) -> String {
    let mut lines: Vec<String> = [
        "# タスク",
        "",
        "<!--",
        "  okf のタスクツールが読み書きします。手で編集しても構いません。",
        "  状態は見出しで決まります（チェックボックスではありません）。",
        "  ID は書き換えないでください。",
        "-->",
        "",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    let kept: Vec<&Task> = file
        .tasks
        .iter()
        .filter(|t| t.status == TaskStatus::Done)
        .take(KEPT_DONE_TASKS)
        .collect();
    let dropped = file.done_ever.saturating_sub(kept.len() as u64);

    for (heading, status) in SECTION_STATUS {
        let in_section: Vec<&Task> = if status == TaskStatus::Done {
            kept.clone()
        } else {
            file.tasks.iter().filter(|t| t.status == status).collect()
        };

        if status == TaskStatus::Done && file.done_ever > 0 {
            lines.push(format!(
                "{heading}（直近 {} 件 / 全 {} 件）",
                kept.len(),
                file.done_ever
            ));
        } else {
            lines.push(heading.to_string());
        }
        lines.push(String::new());

        if in_section.is_empty() {
            lines.push(
                if status == TaskStatus::Done {
                    "まだありません。"
                } else {
                    "なし。"
                }
                .to_string(),
            );
            lines.push(String::new());
            continue;
        }

        for task in in_section {
            lines.push(render_task(task));
        }
        lines.push(String::new());
    }

    if dropped > 0 {
        lines.push(format!(
            "<!-- 古い完了 {dropped} 件は件数のみ保持しています。 -->"
        ));
        lines.push(String::new());
    }

    lines.join("\n")
}

/// Read a task file back.
///
/// Tolerant on purpose: this file is meant to be edited by hand, so anything
/// that is not a recognisable task line is skipped rather than treated as an
/// error. Losing a user's prose to a strict parser would be far worse than
/// ignoring a line.
pub fn parse_tasks(raw: &str) -> TaskFile {
    let mut tasks: Vec<Task> = Vec::new();
    let mut status: Option<TaskStatus> = None;
    let mut done_ever: u64 = 0;
    let mut saw_done_heading = false;

    let lines = split_crlf(raw);
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;

        if let Some((_, heading_status)) = SECTION_STATUS.iter().find(|(h, _)| line.starts_with(h))
        {
            status = Some(*heading_status);
            if *heading_status == TaskStatus::Done {
                saw_done_heading = true;
                // `## 完了（直近 3 件 / 全 41 件）`
                if let Some(total) = TOTAL_RE.captures(line) {
                    done_ever = total[1].parse().unwrap_or(u64::MAX);
                }
            }
            continue;
        }
        // Any other heading ends the current section, so stray prose below a
        // user-added section is never read as tasks.
        if H2_RE.is_match(line) {
            status = None;
            continue;
        }

        let Some(caps) = TASK_LINE_RE.captures(line) else {
            continue;
        };
        let Some(status) = status else { continue };

        let id = caps[2].to_string();
        let fields: Vec<&str> = caps[3]
            .split('·')
            .map(crate::shared::js_compat::js_trim)
            .collect();
        // The heading wins over the checkbox: a `[x]` under 未着手 is a typo, and
        // trusting it would move a task nobody finished into the done pile.
        let mut task = Task::new(id, fields[0], status);

        for field in &fields[1..] {
            if let Some(para) = parse_para_class(field) {
                task.para = Some(para);
                continue;
            }
            if let Some(due) = DUE_RE.captures(field) {
                task.due = Some(due[1].to_string());
                continue;
            }
            if let Some(done) = DONE_RE.captures(field) {
                task.done = Some(done[1].to_string());
            }
        }

        // A note is the indented line directly beneath the task.
        if let Some(next) = lines.get(i) {
            if NOTE_RE.is_match(next) && !TASK_LINE_RE.is_match(next) {
                task.note = Some(crate::shared::js_compat::js_trim(next).to_string());
                i += 1;
            }
        }

        tasks.push(task);
    }

    let done_count = tasks
        .iter()
        .filter(|t| t.status == TaskStatus::Done)
        .count() as u64;
    TaskFile {
        tasks,
        // Without the heading there is nothing to trust but what is in the file.
        done_ever: if saw_done_heading {
            done_ever.max(done_count)
        } else {
            done_count
        },
    }
}

/// Open work, in the order it should be looked at.
pub fn open_tasks(file: &TaskFile) -> Vec<Task> {
    let rank = |s: TaskStatus| match s {
        TaskStatus::Doing => 0,
        TaskStatus::Todo => 1,
        TaskStatus::Done => 2,
    };
    let mut open: Vec<Task> = file
        .tasks
        .iter()
        .filter(|t| t.status != TaskStatus::Done)
        .cloned()
        .collect();
    open.sort_by_key(|t| rank(t.status)); // stable, like JS
    open
}

// ---------------------------------------------------------------------------
// MAP
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MapEntry {
    /// What the reader is trying to find out.
    pub question: &'static str,
    /// Bundle-relative location.
    pub r#where: &'static str,
    /// The cheapest tool that answers it.
    pub tool: &'static str,
    /// Who may write there.
    pub writable: &'static str,
}

/// The routing table, as data. The single source of truth for MAP.md's
/// generated half, so the file cannot describe a layout the code does not
/// implement.
pub const MAP_ENTRIES: [MapEntry; 11] = [
    MapEntry {
        question: "利用者のこと（呼び方・進め方・制約）",
        r#where: HUMAN_FILE,
        tool: "read_human",
        writable: "人間 / エージェント",
    },
    MapEntry {
        question: "いま何をやるか",
        r#where: TASK_FILE,
        tool: "list_tasks",
        writable: "人間 / エージェント",
    },
    MapEntry {
        question: "今日のこと（書き留め・その日のタスク）",
        r#where: "wiki/daily/YYYY-MM-DD.md",
        tool: "daily_note",
        writable: "人間 / エージェント",
    },
    MapEntry {
        question: "このバンドルの規約",
        r#where: "wiki/AGENTS.md",
        tool: "read_agents_md",
        writable: "人間",
    },
    MapEntry {
        question: "手順（やり方が決まっている作業）",
        r#where: "wiki/skills/",
        tool: "skill_find",
        writable: "人間 / エージェント",
    },
    MapEntry {
        question: "繰り返す作業の設計",
        r#where: "wiki/loops/",
        tool: "loop_list",
        writable: "人間 / エージェント",
    },
    MapEntry {
        question: "システムの全体像・拡張のしかた",
        r#where: SYSTEMMAP_FILE,
        tool: "system_map",
        writable: "人間 / エージェント",
    },
    MapEntry {
        question: "概念の関係図・型付き関係・グラフスキーマ",
        r#where: "wiki/graph/",
        tool: "canvas_list / graph_schema",
        writable: "人間 / エージェント",
    },
    MapEntry {
        question: "知識（事実・調べたこと）",
        r#where: "wiki/1-projects … 4-archive",
        tool: "retrieve / search",
        writable: "人間 / エージェント",
    },
    MapEntry {
        question: "取り込んだ生データ",
        r#where: "raw/",
        tool: "list_files",
        writable: "人間のみ",
    },
    MapEntry {
        question: "検索索引",
        r#where: ".rag/",
        tool: "(自動生成)",
        writable: "—",
    },
];

/// Everything below this line survives regeneration.
pub const MAP_USER_MARKER: &str = "<!-- okf:user-rules -->";

fn map_user_default() -> String {
    [
        MAP_USER_MARKER,
        "",
        "## このバンドル固有のルール",
        "",
        "ここから下は自動生成されません。独自の置き場所の決まりがあれば書いてください。",
        "",
    ]
    .join("\n")
}

/// Render MAP.md, keeping whatever the user wrote below the marker.
///
/// Regenerating must never cost someone their own notes, so the generated half
/// stops at the marker and the rest is carried through untouched.
pub fn render_map(previous: Option<&str>) -> String {
    let mut lines: Vec<String> = [
        "# MAP — どこに何があるか",
        "",
        "**最初にこれを読んでください。** 目的の情報がある 1 ファイルだけを開けば済み、",
        "探すために読み回る必要がなくなります。",
        "",
        "| 知りたいこと | 場所 | 呼ぶもの | 書ける人 |",
        "|---|---|---|---|",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    for entry in &MAP_ENTRIES {
        lines.push(format!(
            "| {} | `{}` | `{}` | {} |",
            entry.question, entry.r#where, entry.tool, entry.writable
        ));
    }

    // One line, not the rule itself. MAP is read on every session and its whole
    // value is being cheap; the reasoning lives in AGENTS.md.
    for line in [
        "",
        "## 規則",
        "",
        "- デイリーノートの `## タスク` に未チェック項目があれば `collect_daily_tasks`",
        "  を呼び、`Task.md` へ移す（詳細は `wiki/AGENTS.md` §3）",
        "",
        "## 層の決まり",
        "",
        "- `raw/` は生データ。**エージェントは書けません**（人間は置けます）",
        "- `wiki/` が正典。エージェントも人間も書けます",
        "- `.rag/` は導出物。手で触らないでください",
        "",
        "## 優先順位（PARA）",
        "",
    ] {
        lines.push(line.to_string());
    }

    for para in PARA_ORDER {
        lines.push(format!("- **{}** — {}", para.as_str(), para.description()));
    }

    lines.push(String::new());
    lines.push("---".to_string());
    lines.push(String::new());

    let user_part = match previous.and_then(|p| p.find(MAP_USER_MARKER).map(|at| &p[at..])) {
        Some(rest) => js_trim_end(rest).to_string(),
        None => js_trim_end(&map_user_default()).to_string(),
    };
    lines.push(user_part);

    format!("{}\n", lines.join("\n"))
}

// ---------------------------------------------------------------------------
// human.md
// ---------------------------------------------------------------------------

/// The starting point for `human.md`.
///
/// Written as prompts rather than empty headings: a blank section invites
/// nothing, and an unfilled file is worth less than no file at all because an
/// agent still pays to read it.
pub fn render_human_template() -> String {
    [
        "# 利用者について",
        "",
        "<!--",
        "  エージェントが最初に読む情報です。短く保ってください。",
        "  ここに書いたことは毎回読まれます — 長いほど毎回のコストになります。",
        "-->",
        "",
        "## 基本",
        "",
        "- 呼び方:",
        "- 役割・専門:",
        "- 使う言語: 日本語",
        "- タイムゾーン:",
        "",
        "## 進め方の好み",
        "",
        "- 例: 結論から先に。前置きは不要",
        "- 例: 不明点は推測せず確認する",
        "",
        "## 制約・やらないこと",
        "",
        "- 例: このマシンから外部に送信しない",
        "",
        "## いまの文脈",
        "",
        "- 取り組んでいること:",
        "- 期限があるもの:",
        "",
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::okf::concept::is_concept_path;
    use crate::shared::okf::skill::estimate_tokens;

    fn sample() -> TaskFile {
        let mut doing = Task::new("T-0003", "RMUX 連携を検証する", TaskStatus::Doing);
        doing.para = Some(ParaClass::Project);
        let mut due = Task::new("T-0004", "human.md を書く", TaskStatus::Todo);
        due.due = Some("2026-08-31".into());
        let mut noted = Task::new("T-0005", "取り込み手順を直す", TaskStatus::Todo);
        noted.note = Some("raw/ の議事録から".into());
        let mut done = Task::new("T-0002", "rmux をインストールする", TaskStatus::Done);
        done.done = Some("2026-08-03".into());
        TaskFile {
            done_ever: 3,
            tasks: vec![doing, due, noted, done],
        }
    }

    // ---- task file round trip ----

    #[test]
    fn every_field_survives_render_then_parse() {
        let sample = sample();
        let back = parse_tasks(&render_tasks(&sample));

        assert_eq!(back.tasks.len(), sample.tasks.len());
        for original in &sample.tasks {
            let parsed = back.tasks.iter().find(|t| t.id == original.id);
            assert_eq!(parsed, Some(original));
        }
    }

    #[test]
    fn the_all_time_completed_count_survives() {
        // Without this the heading would reset every rewrite and the count
        // would silently shrink as old entries aged out.
        assert_eq!(parse_tasks(&render_tasks(&sample())).done_ever, 3);
    }

    #[test]
    fn status_comes_from_the_section_not_the_checkbox() {
        // A stray `[x]` under 未着手 is a typo; trusting it would move a task
        // nobody finished into the done pile.
        let file = parse_tasks("# タスク\n\n## 未着手\n\n- [x] T-0009 まだ終わっていない");
        assert_eq!(file.tasks[0].status, TaskStatus::Todo);
    }

    #[test]
    fn prose_under_a_users_own_heading_is_not_read_as_tasks() {
        let file = parse_tasks(
            &[
                "## 未着手",
                "",
                "- [ ] T-0001 本物のタスク",
                "",
                "## メモ",
                "",
                "- [ ] T-0002 これは例であってタスクではない",
            ]
            .join("\n"),
        );
        let ids: Vec<&str> = file.tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["T-0001"]);
    }

    #[test]
    fn a_hand_written_line_that_is_not_a_task_is_skipped_not_lost() {
        let file =
            parse_tasks(&["## 未着手", "", "ここに自由に書ける", "- [ ] T-0001 タスク"].join("\n"));
        assert_eq!(file.tasks.len(), 1);
    }

    #[test]
    fn ids_do_not_collide_with_what_is_already_there() {
        assert_eq!(next_task_id(&sample().tasks), "T-0006");
        assert_eq!(next_task_id(&[]), "T-0001");
    }

    #[test]
    fn completed_history_is_bounded() {
        let many = TaskFile {
            done_ever: 100,
            tasks: (0..100)
                .map(|i| {
                    let mut t = Task::new(
                        format!("T-{:04}", i + 1),
                        format!("古い作業 {i}"),
                        TaskStatus::Done,
                    );
                    t.done = Some("2026-01-01".into());
                    t
                })
                .collect(),
        };

        let rendered = render_tasks(&many);
        assert_eq!(parse_tasks(&rendered).tasks.len(), KEPT_DONE_TASKS);
        // The count is kept even though the entries are not.
        assert_eq!(parse_tasks(&rendered).done_ever, 100);
    }

    #[test]
    fn open_work_is_ordered_with_what_is_in_progress_first() {
        let order: Vec<TaskStatus> = open_tasks(&sample()).iter().map(|t| t.status).collect();
        assert_eq!(order[0], TaskStatus::Doing);
        assert!(!order.contains(&TaskStatus::Done));
    }

    #[test]
    fn render_shape_matches_the_ts_layout() {
        let rendered = render_tasks(&sample());
        assert!(rendered.contains("## 進行中\n\n- [ ] T-0003 RMUX 連携を検証する · project\n"));
        assert!(rendered.contains("- [ ] T-0005 取り込み手順を直す\n      raw/ の議事録から\n"));
        assert!(rendered.contains("## 完了（直近 1 件 / 全 3 件）\n\n- [x] T-0002 rmux をインストールする · 完了 2026-08-03\n"));
        assert!(rendered.ends_with("<!-- 古い完了 2 件は件数のみ保持しています。 -->\n"));
        assert!(render_tasks(&TaskFile {
            tasks: vec![],
            done_ever: 0
        })
        .contains("## 完了\n\nまだありません。\n"));
    }

    // ---- MAP ----

    #[test]
    fn regenerating_keeps_what_the_user_wrote() {
        let first = render_map(None);
        let edited = format!("{first}\n私の決まり: 議事録は必ず raw/meetings に置く\n");
        let again = render_map(Some(&edited));

        assert!(again.contains("私の決まり: 議事録は必ず raw/meetings に置く"));
        assert!(again.contains(MAP_USER_MARKER));
    }

    #[test]
    fn every_routed_location_is_named_in_the_rendered_table() {
        let map = render_map(None);
        for entry in &MAP_ENTRIES {
            assert!(map.contains(entry.r#where));
            assert!(map.contains(entry.tool));
        }
    }

    #[test]
    fn the_layer_permissions_are_stated() {
        let map = render_map(None);
        assert!(map.contains("raw/"));
        assert!(map.contains("エージェントは書けません"));
    }

    #[test]
    fn map_lists_para_in_priority_order() {
        let map = render_map(None);
        let project = map.find("- **project**").unwrap();
        let archive = map.find("- **archive**").unwrap();
        assert!(project < archive);
        assert!(map.ends_with(
            "ここから下は自動生成されません。独自の置き場所の決まりがあれば書いてください。\n"
        ));
    }

    // ---- these files are not knowledge ----

    #[test]
    fn they_are_excluded_from_the_concept_scan() {
        assert!(!is_concept_path("wiki/MAP.md"));
        assert!(!is_concept_path("wiki/human.md"));
        assert!(!is_concept_path("wiki/Task.md"));
        assert!(is_concept_path("wiki/1-projects/real-note.md"));
    }

    #[test]
    fn the_check_is_case_insensitive_since_windows_is() {
        assert!(is_workspace_filename("map.md"));
        assert!(is_workspace_filename("TASK.MD"));
        assert!(!is_workspace_filename("mapping.md"));
    }

    // ---- the cost this design is meant to avoid ----

    #[test]
    fn map_is_small_enough_to_always_read_first() {
        assert!(estimate_tokens(&render_map(None)) < 700);
    }

    #[test]
    fn asking_for_open_work_costs_far_less_than_reading_the_file() {
        let mut tasks = vec![
            Task::new("T-0100", "いま進めていること", TaskStatus::Doing),
            Task::new("T-0101", "次にやること", TaskStatus::Todo),
        ];
        for i in 0..40 {
            let mut t = Task::new(
                format!("T-{:04}", i + 1),
                format!("終わった作業 {i}: 経緯と結果をそれなりの長さで書いたもの"),
                TaskStatus::Done,
            );
            t.done = Some("2026-07-01".into());
            tasks.push(t);
        }
        let file = TaskFile {
            done_ever: 60,
            tasks,
        };

        let whole = estimate_tokens(&render_tasks(&file));
        let open = estimate_tokens(
            &open_tasks(&file)
                .iter()
                .map(|t| format!("{} {}", t.id, t.title))
                .collect::<Vec<_>>()
                .join("\n"),
        );

        assert!((open as f64) < whole as f64 / 4.0);
    }

    #[test]
    fn the_human_template_is_a_prompt_not_an_empty_shell() {
        let template = render_human_template();
        assert!(template.contains("呼び方"));
        assert!(template.contains("例:"));
        assert!(estimate_tokens(&template) < 400);
    }
}
