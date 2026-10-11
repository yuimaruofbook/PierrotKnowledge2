//! Activity summaries: log.md rows, regrouped so every line can be traced back
//! (`src/shared/okf/activity.ts`).
//!
//! `audit_changes` answers "who changed what" as data. A summary answers it as
//! a page a person can read and an agent can cite, built only from log rows:
//! every line carries the date and path of the row it came from, and a line
//! that is not in the log is not in the summary.

use super::reserved::ParsedLogEntry;
use crate::shared::js_compat::{js_trim, js_trim_end, locale_compare};
use indexmap::IndexMap;

/// Where saved summaries live, inside the wiki layer.
pub const ACTIVITY_DIR: &str = "activity";

/// The concept type a saved summary carries.
pub const ACTIVITY_TYPE: &str = "ActivitySummary";

/// Heading of the folder's `index.md`.
pub const ACTIVITY_TITLE: &str = "Activity";

#[derive(Debug, Clone, Default)]
pub struct ActivityFilter {
    /// ISO date; rows before it are left out.
    pub since: Option<String>,
    /// ISO date; rows after it are left out.
    pub until: Option<String>,
    /// Substring filter on the actor, as `audit_changes` does.
    pub actor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivitySummary {
    pub title: String,
    /// One-line description for the saved concept's frontmatter.
    pub description: String,
    /// The effective range, taken from the rows when a bound was not given.
    pub from: String,
    pub to: String,
    pub total: usize,
    /// Markdown body, without the H1 (a saved concept adds its own).
    pub body: String,
}

/// `text.replace(/[\r\n]+/g, " ").trim()`
fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_break = false;
    for c in text.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            in_break = false;
            out.push(c);
        }
    }
    js_trim(&out).to_string()
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|s| !s.is_empty())
}

/// Rows inside the filter, in the log's own (newest-first) order.
pub fn filter_activity(entries: &[ParsedLogEntry], filter: &ActivityFilter) -> Vec<ParsedLogEntry> {
    entries
        .iter()
        .filter(|e| {
            non_empty(&filter.since).is_none_or(|since| e.date.as_str() >= since)
                && non_empty(&filter.until).is_none_or(|until| e.date.as_str() <= until)
                && non_empty(&filter.actor).is_none_or(|actor| e.actor.contains(actor))
        })
        .cloned()
        .collect()
}

/// Summarise rows already filtered by [`filter_activity`]; `None` when empty.
///
/// Ordering is fixed so two runs over the same log print the same page:
/// actors by row count then name, files by path, a file's rows in log order,
/// action totals by count then name.
pub fn summarize_activity(
    entries: &[ParsedLogEntry],
    filter: &ActivityFilter,
    source: &str,
) -> Option<ActivitySummary> {
    let first_entry = entries.first()?;

    let mut first = first_entry.date.as_str();
    let mut last = first;
    for entry in entries {
        if entry.date.as_str() < first {
            first = entry.date.as_str();
        }
        if entry.date.as_str() > last {
            last = entry.date.as_str();
        }
    }
    let from = non_empty(&filter.since).unwrap_or(first).to_string();
    let to = non_empty(&filter.until).unwrap_or(last).to_string();

    let mut by_action: IndexMap<&str, usize> = IndexMap::new();
    let mut by_actor: IndexMap<&str, IndexMap<&str, Vec<&ParsedLogEntry>>> = IndexMap::new();
    let mut files: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for entry in entries {
        *by_action.entry(entry.kind.as_str()).or_insert(0) += 1;
        files.insert(entry.path.as_str());
        by_actor
            .entry(entry.actor.as_str())
            .or_default()
            .entry(entry.path.as_str())
            .or_default()
            .push(entry);
    }

    let count = |rows: &IndexMap<&str, Vec<&ParsedLogEntry>>| rows.values().map(Vec::len).sum::<usize>();

    let mut lines: Vec<String> = vec![
        format!(
            "Source: `{source}` · {} entries · {} actor(s) · {} file(s)",
            entries.len(),
            by_actor.len(),
            files.len()
        ),
        String::new(),
    ];
    // The filter is kept in the body: it is the only record of what the page
    // was narrowed to once the file name has been shortened.
    if let Some(actor) = non_empty(&filter.actor) {
        lines.push(format!("Actor filter: {}", one_line(actor)));
        lines.push(String::new());
    }
    lines.push("## Totals by action".to_string());
    lines.push(String::new());

    let mut actions: Vec<(&str, usize)> = by_action.into_iter().collect();
    actions.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_compare(a.0, b.0)));
    for (action, n) in actions {
        lines.push(format!("* {action}: {n}"));
    }
    lines.push(String::new());

    let mut actors: Vec<(&str, IndexMap<&str, Vec<&ParsedLogEntry>>)> = by_actor.into_iter().collect();
    actors.sort_by(|a, b| count(&b.1).cmp(&count(&a.1)).then_with(|| locale_compare(a.0, b.0)));
    for (actor, actor_files) in actors {
        lines.push(format!("## {} ({})", one_line(actor), count(&actor_files)));
        lines.push(String::new());
        let mut paths: Vec<(&str, Vec<&ParsedLogEntry>)> = actor_files.into_iter().collect();
        paths.sort_by(|a, b| locale_compare(a.0, b.0));
        for (path, rows) in paths {
            lines.push(format!("### `{path}`"));
            lines.push(String::new());
            for row in rows {
                let note = match row.note.as_deref().filter(|n| !n.is_empty()) {
                    Some(note) => format!(" — {}", one_line(note)),
                    None => String::new(),
                };
                lines.push(format!("* {} · {} · `{}`{note}", row.date, row.kind, row.path));
            }
            lines.push(String::new());
        }
    }

    let actor_suffix = match non_empty(&filter.actor) {
        Some(actor) => format!(" ({})", one_line(actor)),
        None => String::new(),
    };
    Some(ActivitySummary {
        title: format!("Activity {from} → {to}{actor_suffix}"),
        description: format!("{} log entries from {from} to {to}", entries.len()),
        from,
        to,
        total: entries.len(),
        body: js_trim_end(&lines.join("\n")).to_string(),
    })
}

/// FNV-1a over the UTF-8 bytes, as 8 hex digits: short, and the same in every port.
fn short_hash(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.bytes() {
        hash = (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// The filename part for an actor filter: ASCII, with no `:` (illegal on
/// Windows).
///
/// When that squeezes the filter (a colon, Japanese letters, a cut at 40), two
/// different filters could land on one file and overwrite each other, so a
/// hash of the exact filter is appended.
fn actor_slug(actor: &str) -> String {
    let mut slug = String::new();
    let mut pending = false;
    for c in actor.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            if pending {
                slug.push('-');
            }
            pending = false;
            slug.push(c);
        } else {
            pending = true;
        }
    }
    // A trailing run of separators becomes one dash; the dashes at either end
    // are trimmed, then the cap is applied, then trailing dashes again.
    if pending {
        slug.push('-');
    }
    let trimmed = slug.trim_matches('-');
    let capped: String = trimmed.chars().take(40).collect();
    let slug = capped.trim_end_matches('-');
    if slug == actor {
        slug.to_string()
    } else if slug.is_empty() {
        short_hash(actor)
    } else {
        format!("{slug}-{}", short_hash(actor))
    }
}

/// Wiki-relative path of a saved summary: `activity/<from>_<to>[_<actor>].md`.
pub fn activity_rel_path(from: &str, to: &str, actor: Option<&str>) -> String {
    let slug = actor.map(actor_slug).unwrap_or_default();
    let suffix = if slug.is_empty() { String::new() } else { format!("_{slug}") };
    format!("{ACTIVITY_DIR}/{from}_{to}{suffix}.md")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::okf::reserved::parse_log_entries;

    const LOG: &str = "# Log\n\n## 2026-09-03\n\n* **Update**: `wiki/b.md` by process:codex. second pass\n* **Creation**: `wiki/c.md` by process:claude-code.\n\n## 2026-09-02\n\n* **Update**: `wiki/a.md` by process:claude-code. fixed typo\n* **Move**: `wiki/x.md → wiki/y.md` by human:local.\n\n## 2026-09-01\n\n* **Creation**: `wiki/a.md` by process:claude-code.\n";

    #[test]
    fn groups_by_actor_then_file_citing_date_and_path() {
        let entries = parse_log_entries(LOG);
        let summary = summarize_activity(&entries, &ActivityFilter::default(), "wiki/log.md").unwrap();
        assert_eq!(summary.title, "Activity 2026-09-01 → 2026-09-03");
        assert_eq!(summary.total, 5);
        let expected = [
            "Source: `wiki/log.md` · 5 entries · 3 actor(s) · 4 file(s)",
            "",
            "## Totals by action",
            "",
            "* Creation: 2",
            "* Update: 2",
            "* Move: 1",
            "",
            "## process:claude-code (3)",
            "",
            "### `wiki/a.md`",
            "",
            "* 2026-09-02 · Update · `wiki/a.md` — fixed typo",
            "* 2026-09-01 · Creation · `wiki/a.md`",
            "",
            "### `wiki/c.md`",
            "",
            "* 2026-09-03 · Creation · `wiki/c.md`",
            "",
            "## human:local (1)",
            "",
            "### `wiki/x.md → wiki/y.md`",
            "",
            "* 2026-09-02 · Move · `wiki/x.md → wiki/y.md`",
            "",
            "## process:codex (1)",
            "",
            "### `wiki/b.md`",
            "",
            "* 2026-09-03 · Update · `wiki/b.md` — second pass",
        ]
        .join("\n");
        assert_eq!(summary.body, expected);
    }

    #[test]
    fn filters_by_range_and_actor() {
        let entries = parse_log_entries(LOG);
        let filter = ActivityFilter {
            since: Some("2026-09-02".into()),
            until: Some("2026-09-02".into()),
            actor: Some("claude".into()),
        };
        let some = filter_activity(&entries, &filter);
        assert_eq!(some.len(), 1);
        assert_eq!(
            summarize_activity(&some, &filter, "s").unwrap().title,
            "Activity 2026-09-02 → 2026-09-02 (claude)"
        );
        let none = ActivityFilter { since: Some("2027-01-01".into()), ..Default::default() };
        assert!(filter_activity(&entries, &none).is_empty());
        assert!(summarize_activity(&[], &ActivityFilter::default(), "s").is_none());
    }

    #[test]
    fn saved_paths_are_dates_plus_a_filename_safe_actor() {
        assert_eq!(activity_rel_path("2026-09-01", "2026-09-03", None), "activity/2026-09-01_2026-09-03.md");
        assert_eq!(
            activity_rel_path("2026-09-01", "2026-09-03", Some("process:claude-code")),
            "activity/2026-09-01_2026-09-03_process-claude-code-041f4214.md"
        );
        assert_eq!(activity_rel_path("a", "b", Some("::")), "activity/a_b_980630f5.md");
        assert_eq!(activity_rel_path("a", "b", Some("--x--")), "activity/a_b_x-61f25c1f.md");
        // Nothing is lost in the name, so no hash is needed.
        assert_eq!(activity_rel_path("a", "b", Some("codex")), "activity/a_b_codex.md");
    }

    #[test]
    fn two_different_actor_filters_never_share_a_file() {
        let long = "x".repeat(61);
        let filters = ["process:codex", "process-codex", "process codex", "\u{7530}\u{4e2d}", "\u{4f50}\u{85e4}", &"x".repeat(60), long.as_str()];
        let paths: Vec<String> = filters.iter().map(|f| activity_rel_path("2026-09-01", "2026-09-03", Some(f))).collect();
        let unique: std::collections::HashSet<&String> = paths.iter().collect();
        assert_eq!(unique.len(), filters.len());
        // A Japanese filter has no ASCII letters at all: the hash alone names it.
        assert_eq!(activity_rel_path("a", "b", Some("\u{7530}\u{4e2d}")), "activity/a_b_d6109b19.md");
        assert_eq!(
            activity_rel_path("a", "b", Some(long.as_str())),
            "activity/a_b_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-2b4be337.md"
        );
    }

    #[test]
    fn the_actor_filter_is_recorded_in_the_body() {
        let entries = parse_log_entries(LOG);
        let filter = ActivityFilter { actor: Some("codex".into()), ..Default::default() };
        let rows = filter_activity(&entries, &filter);
        assert!(summarize_activity(&rows, &filter, "wiki/log.md").unwrap().body.contains("Actor filter: codex"));
        let none = ActivityFilter::default();
        assert!(!summarize_activity(&rows, &none, "wiki/log.md").unwrap().body.contains("Actor filter"));
    }
}
