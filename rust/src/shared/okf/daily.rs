//! Daily notes: one dated page per day, and the task lines written in it
//! (`src/shared/okf/daily.ts`).
//!
//! A daily note is a capture surface: you write without deciding where anything
//! belongs. They live in `wiki/daily/` and are ordinary concepts, so "what did
//! I decide last Tuesday" is answerable.
//!
//! The task half exists because a requirement written into a day's notes is
//! invisible tomorrow. An unchecked item under the tasks heading is a *request*
//! to put it in `Task.md`; once it has been, the line is checked off and stamped
//! with the id, which makes the transfer idempotent.
//!
//! Dates are local (a day is a local idea). Functions take anything with
//! calendar fields, so callers pass `chrono::Local::now()` where the TS used
//! its `new Date()` default.

use crate::shared::js_compat::{js_regex, js_trim, split_crlf};
use chrono::{Datelike, Weekday};
use regex::Regex;
use std::sync::LazyLock;

pub const DAILY_DIR: &str = "daily";

/// Heading whose unchecked items become tasks.
pub const DAILY_TASK_HEADING: &str = "## タスク";

/// `2026-08-04`. Local date, because a day is a local idea.
pub fn daily_id(date: &impl Datelike) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// Wiki-relative path of a day's note.
pub fn daily_rel_path(date: &impl Datelike) -> String {
    format!("{DAILY_DIR}/{}.md", daily_id(date))
}

static DAILY_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(^|/)daily/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$").unwrap());

/// True for a path that is a daily note, so callers need not re-derive it.
pub fn is_daily_path(wiki_rel_path: &str) -> bool {
    DAILY_PATH_RE.is_match(&wiki_rel_path.replace('\\', "/"))
}

fn weekday_name(date: &impl Datelike) -> &'static str {
    match date.weekday() {
        Weekday::Sun => "日",
        Weekday::Mon => "月",
        Weekday::Tue => "火",
        Weekday::Wed => "水",
        Weekday::Thu => "木",
        Weekday::Fri => "金",
        Weekday::Sat => "土",
    }
}

/// `2026-08-04（火）`: the weekday matters when scanning back through days.
pub fn daily_title(date: &impl Datelike) -> String {
    format!("{}（{}）", daily_id(date), weekday_name(date))
}

/// The body of a new daily note.
///
/// Headings rather than an empty page: a blank note gets filled with whatever
/// shape the day happens to take, and next week none of them match. The task
/// heading is first because it is the one an agent acts on.
pub fn daily_template() -> String {
    [
        DAILY_TASK_HEADING,
        "",
        "<!-- 未チェックの項目は Task.md に取り込まれ、取り込み後に [x] と ID が付きます -->",
        "",
        "- [ ] ",
        "",
        "## メモ",
        "",
        "",
        "## 今日わかったこと",
        "",
        "<!-- あとで概念として切り出す価値があるものはここに -->",
        "",
    ]
    .join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyTaskLine {
    /// 0-based index into the note's lines.
    pub line: usize,
    /// The task text, without the checkbox.
    pub text: String,
}

static TASK_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^(<S>*)-<S>*\[( |x|X)\]<S>*(<DOT>*)$"));
static H2_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^##<S>"));

/// Unchecked items under the task heading.
///
/// Scoped to that one section on purpose: checklists appear all over notes
/// (packing lists, test steps, things already done) and hoovering up every
/// checkbox would fill `Task.md` with things nobody asked to track. Empty items
/// are skipped so the template's own placeholder never becomes a task named "".
pub fn pending_task_lines(raw: &str) -> Vec<DailyTaskLine> {
    let mut out = Vec::new();
    let mut in_section = false;

    for (i, line) in split_crlf(raw).into_iter().enumerate() {
        if H2_RE.is_match(line) {
            in_section = js_trim(line) == DAILY_TASK_HEADING;
            continue;
        }
        if !in_section {
            continue;
        }

        let Some(caps) = TASK_LINE_RE.captures(line) else {
            continue;
        };
        if &caps[2] != " " {
            continue;
        }
        let text = js_trim(&caps[3]);
        if text.is_empty() {
            continue;
        }

        out.push(DailyTaskLine {
            line: i,
            text: text.to_string(),
        });
    }

    out
}

/// Check off a transferred line and record the id it became.
///
/// Writing the id back keeps the daily note worth reading later: "I said I
/// would do this" and "it is tracked as T-0012" are different facts, and only
/// the second one survives in `Task.md`.
///
/// Like the original, the result is joined with `\n` even if the input used
/// CRLF.
pub fn mark_transferred(raw: &str, line: usize, task_id: &str) -> String {
    let mut lines: Vec<String> = split_crlf(raw).into_iter().map(str::to_string).collect();
    let Some(target) = lines.get(line) else {
        return raw.to_string();
    };

    let Some(caps) = TASK_LINE_RE.captures(target) else {
        return raw.to_string();
    };
    let indent = caps[1].to_string();
    let text = js_trim(&caps[3]).to_string();

    lines[line] = format!("{indent}- [x] {text} → {task_id}");
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, NaiveDate, TimeZone};

    fn note() -> String {
        [
            "# 2026-08-04（火）",
            "",
            DAILY_TASK_HEADING,
            "",
            "- [ ] 議事録を wiki に取り込む",
            "- [x] 資料を集める → T-0011",
            "- [ ] ",
            "",
            "## メモ",
            "",
            "持ち物:",
            "- [ ] 充電器",
            "- [ ] 鍵",
        ]
        .join("\n")
    }

    // ---- naming a day ----

    #[test]
    fn the_id_is_the_local_date_not_utc() {
        // `new Date("2026-08-04")` is UTC midnight, which is 2026-08-03 anywhere
        // west of Greenwich: the note would be filed under the wrong day.
        let local_morning = Local.with_ymd_and_hms(2026, 8, 4, 1, 30, 0).unwrap();
        assert_eq!(daily_id(&local_morning), "2026-08-04");

        let local_late_night = Local.with_ymd_and_hms(2026, 8, 4, 23, 45, 0).unwrap();
        assert_eq!(daily_id(&local_late_night), "2026-08-04");
    }

    #[test]
    fn the_path_lives_under_daily() {
        let day = NaiveDate::from_ymd_opt(2026, 8, 4).unwrap();
        assert_eq!(daily_rel_path(&day), "daily/2026-08-04.md");
    }

    #[test]
    fn the_title_carries_the_weekday() {
        // 2026-08-04 is a Tuesday. Scanning back through days is much easier with it.
        let day = NaiveDate::from_ymd_opt(2026, 8, 4).unwrap();
        assert_eq!(daily_title(&day), "2026-08-04（火）");
        let sunday = NaiveDate::from_ymd_opt(2026, 8, 2).unwrap();
        assert_eq!(daily_title(&sunday), "2026-08-02（日）");
    }

    #[test]
    fn a_daily_note_is_recognisable_from_its_path_alone() {
        assert!(is_daily_path("daily/2026-08-04.md"));
        assert!(is_daily_path("wiki/daily/2026-08-04.md"));
        assert!(is_daily_path("wiki\\daily\\2026-08-04.MD"));
        assert!(!is_daily_path("daily/notes.md"));
        assert!(!is_daily_path("3-resources/2026-08-04.md"));
        assert!(!is_daily_path("mydaily/2026-08-04.md"));
    }

    // ---- finding task lines ----

    #[test]
    fn only_unchecked_items_under_the_task_heading_count() {
        let found = pending_task_lines(&note());
        let texts: Vec<&str> = found.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(texts, ["議事録を wiki に取り込む"]);
    }

    #[test]
    fn checklists_in_other_sections_are_left_alone() {
        // A packing list is not a work item.
        assert!(!pending_task_lines(&note())
            .iter()
            .any(|f| f.text.contains("充電器")));
    }

    #[test]
    fn the_templates_empty_placeholder_never_becomes_a_task() {
        assert!(pending_task_lines(&daily_template()).is_empty());
    }

    #[test]
    fn a_transferred_line_is_ticked_and_stamped_with_its_id() {
        let note = note();
        let found = pending_task_lines(&note);
        let after = mark_transferred(&note, found[0].line, "T-0042");

        assert!(after.contains("- [x] 議事録を wiki に取り込む → T-0042"));
        // And is no longer pending, which is what makes a second run a no-op.
        assert!(pending_task_lines(&after).is_empty());
    }

    #[test]
    fn line_numbers_are_zero_based_and_crlf_is_tolerated() {
        let crlf = "## タスク\r\n\r\n- [ ] one\r\n- [ ] two\r\n";
        let found = pending_task_lines(crlf);
        assert_eq!(
            found
                .iter()
                .map(|f| (f.line, f.text.as_str()))
                .collect::<Vec<_>>(),
            [(2, "one"), (3, "two")]
        );
    }

    #[test]
    fn mark_transferred_keeps_indent_and_ignores_bad_lines() {
        let raw = "## タスク\n  - [ ] indented\nplain";
        assert_eq!(
            mark_transferred(raw, 1, "T-0001"),
            "## タスク\n  - [x] indented → T-0001\nplain"
        );
        assert_eq!(mark_transferred(raw, 2, "T-0001"), raw);
        assert_eq!(mark_transferred(raw, 9, "T-0001"), raw);
    }
}
