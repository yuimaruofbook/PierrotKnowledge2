//! The two reserved files, `index.md` (OKF §8) and `log.md` (OKF §9)
//! (`src/shared/okf/reserved.ts`).
//!
//! Both are plain Markdown with no frontmatter (the one exception the spec
//! allows is an `okf_version` key on the bundle-root `index.md`). Neither uses a
//! table: §8 specifies sectioned bullet lists and §9 date-grouped prose
//! entries, newest first, so a person can read and hand-edit them.

use super::frontmatter::{join_frontmatter, split_frontmatter, Eol};
use crate::shared::js_compat::{encode_uri, is_js_line_terminator, js_regex, js_trim, js_trim_end};
use crate::shared::types::LogEntry;
use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

pub const OKF_VERSION: &str = "0.2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    /// Link target, normally the bundle-absolute form (§6).
    pub href: String,
    pub title: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexSection {
    pub heading: String,
    pub entries: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexOptions {
    pub okf_version: Option<String>,
}

/// Collapse CR/LF runs to one space (`/[\r\n]+/g`).
fn collapse_breaks(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_break = false;
    for c in value.chars() {
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
    out
}

/// Escape text used inside a Markdown link label.
fn escape_label(value: &str) -> String {
    let escaped = value.replace('[', "\\[").replace(']', "\\]");
    js_trim(&collapse_breaks(&escaped)).to_string()
}

/// Collapse a description to a single line; the entry format is one bullet.
fn one_line(value: &str) -> String {
    js_trim(&collapse_breaks(value)).to_string()
}

/// Render an `index.md` (§8).
///
/// `okf_version` is emitted only for the bundle root, which is the sole place
/// the spec permits frontmatter on a reserved file.
pub fn render_index_md(title: &str, sections: &[IndexSection], options: &IndexOptions) -> String {
    let title = one_line(title);
    let mut lines: Vec<String> = vec![
        format!(
            "# {}",
            if title.is_empty() {
                "Knowledge Bundle"
            } else {
                &title
            }
        ),
        String::new(),
    ];

    for section in sections {
        if section.entries.is_empty() {
            continue;
        }
        lines.push(format!("## {}", one_line(&section.heading)));
        lines.push(String::new());
        for entry in &section.entries {
            let description = match entry.description.as_deref().filter(|d| !d.is_empty()) {
                Some(d) => format!(" - {}", one_line(d)),
                None => String::new(),
            };
            lines.push(format!(
                "* [{}]({}){description}",
                escape_label(&entry.title),
                encode_uri(&entry.href)
            ));
        }
        lines.push(String::new());
    }

    let body = lines.join("\n");
    match options.okf_version.as_deref().filter(|v| !v.is_empty()) {
        Some(version) => join_frontmatter(&format!("okf_version: {version}"), &body, Eol::Lf),
        None => body,
    }
}

pub fn empty_index_md(title: &str, options: &IndexOptions) -> String {
    render_index_md(title, &[], options)
}

/// Read `okf_version` from a bundle-root `index.md`, if declared.
pub fn read_okf_version(index_md: &str) -> Option<String> {
    let yaml = split_frontmatter(index_md).yaml?;
    if yaml.is_empty() {
        return None;
    }
    // /^okf_version[ \t]*:[ \t]*(.+)$/m, with JS multiline line breaks.
    let value = yaml.split(is_js_line_terminator).find_map(|line| {
        let rest = line.strip_prefix("okf_version")?;
        let rest = rest.trim_start_matches([' ', '\t']).strip_prefix(':')?;
        // `.+` needs one character, but the `[ \t]*` before it may give one back.
        (!rest.is_empty()).then_some(rest)
    })?;
    let value = js_trim(value);
    let value = value.strip_prefix(['"', '\'']).unwrap_or(value);
    let value = value.strip_suffix(['"', '\'']).unwrap_or(value);
    Some(value.to_string())
}

// ---- log.md (§9) ----

/// Conventional leading word for a log entry. Not required by the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogKind {
    Creation,
    Update,
    Deprecation,
    Initialization,
    Move,
    Deletion,
}

impl LogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Creation => "Creation",
            Self::Update => "Update",
            Self::Deprecation => "Deprecation",
            Self::Initialization => "Initialization",
            Self::Move => "Move",
            Self::Deletion => "Deletion",
        }
    }
}

static DATE_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^## ([0-9]{4}-[0-9]{2}-[0-9]{2})[ \t]*$").unwrap());

pub fn empty_log_md(heading: &str) -> String {
    format!("# {heading}\n")
}

fn ymd(date: &impl Datelike) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// Best-effort `new Date(string)` for the ISO 8601 forms this app produces.
///
/// A date-only string is UTC midnight and a date-time with no offset is local
/// time, as in JS. Forms only the legacy JS parser accepts (`Aug 1 2026`, ...)
/// are not supported and read as invalid.
fn parse_js_date(at: &str) -> Option<DateTime<Local>> {
    let at = js_trim(at);
    if let Ok(parsed) = DateTime::parse_from_rfc3339(at) {
        return Some(parsed.with_timezone(&Local));
    }
    // `2026-08-01T12:00:00.123+0900`-style offsets without a colon.
    if let Ok(parsed) = DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S%.f%z") {
        return Some(parsed.with_timezone(&Local));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(at, format) {
            return Local.from_local_datetime(&naive).earliest();
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(at, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().with_timezone(&Local));
    }
    None
}

/// ISO 8601 `YYYY-MM-DD` for a timestamp (§9 requires this heading form).
///
/// The *local* day, for the same reason daily notes use it: a day is a local
/// idea. Slicing the UTC ISO string filed a morning JST write under yesterday's
/// heading. An unparseable timestamp reads as "now", as in the original.
pub fn iso_date(at: &str) -> String {
    ymd(&parse_js_date(at).unwrap_or_else(Local::now))
}

/// [`iso_date`] for an already-parsed timestamp.
pub fn iso_date_of<Tz: TimeZone>(at: &DateTime<Tz>) -> String {
    ymd(&at.with_timezone(&Local))
}

/// Map an action onto the conventional bold leading word.
pub fn log_kind_of(action: &str) -> LogKind {
    match action {
        "create" => LogKind::Creation,
        "move" => LogKind::Move,
        "delete" => LogKind::Deletion,
        "deprecate" => LogKind::Deprecation,
        "init" => LogKind::Initialization,
        _ => LogKind::Update,
    }
}

/// Render one log entry as a prose bullet (§9).
///
/// The actor is carried in the prose rather than a column, because the format
/// is a list of sentences, not a table.
pub fn format_log_entry(entry: &LogEntry) -> String {
    let kind = log_kind_of(&entry.action);
    let note = match entry.note.as_deref().filter(|n| !n.is_empty()) {
        Some(n) => format!(" {}", one_line(n)),
        None => String::new(),
    };
    format!(
        "* **{}**: `{}` by {}.{note}",
        kind.as_str(),
        one_line(&entry.path),
        one_line(&entry.actor)
    )
}

/// Insert an entry into `log.md`, newest first (§9).
///
/// Entries are grouped under `## YYYY-MM-DD` headings in descending date order,
/// so a new entry is *prepended* to today's section, creating it just below the
/// title if today has no entries yet. A read-modify-write rather than an
/// append; the format requires it.
pub fn insert_log_entry(existing: &str, entry: &LogEntry) -> String {
    let date = iso_date(&entry.at);
    let bullet = format_log_entry(entry);

    let source = if js_trim(existing).is_empty() {
        empty_log_md("Log")
    } else {
        existing.to_string()
    };
    let mut lines: Vec<String> = js_trim_end(&source)
        .split('\n')
        .map(str::to_string)
        .collect();

    // Find today's heading, or the first date heading that today should precede.
    let mut today_at: Option<usize> = None;
    let mut insert_section_at: Option<usize> = None;

    for (i, line) in lines.iter().enumerate() {
        let Some(heading) = DATE_HEADING_RE.captures(line) else {
            continue;
        };
        let found = &heading[1];
        if found == date {
            today_at = Some(i);
            break;
        }
        if found < date.as_str() {
            insert_section_at = Some(i);
            break;
        }
    }

    if let Some(today_at) = today_at {
        // Newest first within the day: the bullet goes directly under the heading.
        let mut at = today_at + 1;
        while at < lines.len() && js_trim(&lines[at]).is_empty() {
            at += 1;
        }
        lines.insert(at, bullet);
        return format!("{}\n", lines.join("\n"));
    }

    let section = [format!("## {date}"), String::new(), bullet, String::new()];

    if let Some(at) = insert_section_at {
        lines.splice(at..at, section);
        return format!("{}\n", lines.join("\n"));
    }

    // No later section to sit above: append after the title (and any preamble).
    let at = lines
        .iter()
        .position(|line| line.starts_with("# "))
        .map_or(0, |t| t + 1);
    let spacer = lines.get(at).is_some_and(|l| !js_trim(l).is_empty());
    let mut insertion: Vec<String> = Vec::new();
    if spacer {
        insertion.push(String::new());
    }
    insertion.extend(section);
    lines.splice(at..at, insertion);
    format!("{}\n", lines.join("\n"))
}

/// Parse the date headings present in a log, in file order (newest first).
pub fn log_dates(log: &str) -> Vec<String> {
    log.split('\n')
        .filter_map(|line| DATE_HEADING_RE.captures(line).map(|c| c[1].to_string()))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedLogEntry {
    /// The `## YYYY-MM-DD` section the entry sits under.
    pub date: String,
    /// The bold leading word, e.g. "Creation" or "Update".
    pub kind: String,
    pub path: String,
    pub actor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// One rendered bullet, inverted. The lazy actor match plus the end anchor lets
/// an actor contain dots (`process:fable-5.1`): the regex only accepts a split
/// where what follows the period is either a spaced note or nothing.
static LOG_BULLET_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(r"^\*<S>+\*\*([^*]+)\*\*:<S>*`([^`]+)`<S>+by<S>+(<DOT>+?)\.(?:<S>+(<DOT>+))?$")
});

/// Parse `log.md` back into entries, newest first (the file's own order).
///
/// Provenance is only auditable if the log can be read by machine as well as by
/// eye. Hand-written bullets that do not match the format are skipped, not
/// errors: §9 allows free prose.
pub fn parse_log_entries(log: &str) -> Vec<ParsedLogEntry> {
    let mut out = Vec::new();
    let mut date = String::new();

    for line in log.split('\n') {
        if let Some(heading) = DATE_HEADING_RE.captures(line) {
            date = heading[1].to_string();
            continue;
        }
        if date.is_empty() {
            continue; // a bullet above the first date heading has no date
        }

        let Some(bullet) = LOG_BULLET_RE.captures(line) else {
            continue;
        };
        out.push(ParsedLogEntry {
            date: date.clone(),
            kind: bullet[1].to_string(),
            path: bullet[2].to_string(),
            actor: bullet[3].to_string(),
            note: bullet
                .get(4)
                .map(|m| m.as_str().to_string())
                .filter(|n| !n.is_empty()),
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::okf::concept::check_conformance;
    use chrono::Utc;

    fn entry(at: &str, path: &str, action: &str) -> LogEntry {
        LogEntry {
            at: at.into(),
            actor: "human:kn".into(),
            action: action.into(),
            path: path.into(),
            note: None,
        }
    }

    fn write_entry(at: &str, path: &str) -> LogEntry {
        entry(at, path, "write")
    }

    fn section(heading: &str, entries: Vec<IndexEntry>) -> IndexSection {
        IndexSection {
            heading: heading.into(),
            entries,
        }
    }

    fn item(href: &str, title: &str, description: Option<&str>) -> IndexEntry {
        IndexEntry {
            href: href.into(),
            title: title.into(),
            description: description.map(Into::into),
        }
    }

    // ---- index.md (OKF §8) ----

    #[test]
    fn renders_sectioned_bullet_entries_not_a_table() {
        let md = render_index_md(
            "Bundle",
            &[section(
                "Concepts",
                vec![item("/a.md", "Alpha", Some("first"))],
            )],
            &IndexOptions::default(),
        );
        assert!(md.contains("## Concepts"));
        assert!(md.contains("* [Alpha](/a.md) - first"));
        assert!(!md.contains('|'));
    }

    #[test]
    fn omits_the_description_when_there_is_none() {
        let md = render_index_md(
            "B",
            &[section("Concepts", vec![item("/a.md", "A", None)])],
            &IndexOptions::default(),
        );
        assert!(md.contains("* [A](/a.md)"));
        assert!(!md.contains(" - "));
    }

    #[test]
    fn uses_the_bundle_absolute_link_form_the_spec_recommends() {
        let md = render_index_md(
            "B",
            &[section("topics", vec![item("/topics/x.md", "X", None)])],
            &IndexOptions::default(),
        );
        assert!(md.contains("](/topics/x.md)"));
    }

    #[test]
    fn skips_empty_sections() {
        let md = render_index_md("B", &[section("Empty", vec![])], &IndexOptions::default());
        assert!(!md.contains("## Empty"));
    }

    #[test]
    fn escapes_brackets_in_a_title() {
        let md = render_index_md(
            "B",
            &[section("C", vec![item("/a.md", "A [draft]", None)])],
            &IndexOptions::default(),
        );
        assert!(md.contains("A \\[draft\\]"));
    }

    #[test]
    fn collapses_a_multi_line_description_onto_one_bullet() {
        let md = render_index_md(
            "B",
            &[section("C", vec![item("/a.md", "A", Some("one\ntwo"))])],
            &IndexOptions::default(),
        );
        assert!(md.contains("* [A](/a.md) - one two"));
    }

    #[test]
    fn carries_okf_version_only_when_asked() {
        assert!(!render_index_md("B", &[], &IndexOptions::default()).contains("okf_version"));

        let rooted = render_index_md(
            "B",
            &[],
            &IndexOptions {
                okf_version: Some(OKF_VERSION.into()),
            },
        );
        assert!(rooted.starts_with("---"));
        assert_eq!(read_okf_version(&rooted).as_deref(), Some(OKF_VERSION));
    }

    #[test]
    fn read_okf_version_returns_none_when_absent() {
        assert_eq!(read_okf_version("# Index\n"), None);
    }

    #[test]
    fn read_okf_version_strips_quotes() {
        assert_eq!(
            read_okf_version("---\nokf_version: \"0.2\"\n---\n").as_deref(),
            Some("0.2")
        );
    }

    #[test]
    fn index_layout_is_byte_exact() {
        let md = render_index_md(
            "Bundle",
            &[section(
                "Concepts",
                vec![item("/a b.md", "Alpha", Some("first"))],
            )],
            &IndexOptions {
                okf_version: Some("0.2".into()),
            },
        );
        assert_eq!(
            md,
            "---\nokf_version: 0.2\n---\n\n# Bundle\n\n## Concepts\n\n* [Alpha](/a%20b.md) - first\n"
        );
        assert_eq!(
            empty_index_md("", &IndexOptions::default()),
            "# Knowledge Bundle\n"
        );
    }

    // ---- reserved-file conformance (OKF §8, §11) is covered in concept.rs ----

    // ---- log.md (OKF §9) ----

    #[test]
    fn groups_entries_under_iso_8601_date_headings() {
        let log = insert_log_entry("", &write_entry("2026-08-01T12:00:00Z", "a.md"));
        assert!(log.contains("## 2026-08-01"));
        assert_eq!(log_dates(&log), ["2026-08-01"]);
    }

    #[test]
    fn entries_are_prose_bullets_with_the_conventional_leading_word() {
        assert!(
            format_log_entry(&write_entry("2026-08-01T12:00:00Z", "a.md")).contains("**Update**")
        );
        assert!(
            format_log_entry(&entry("2026-08-01T12:00:00Z", "a.md", "create"))
                .contains("**Creation**")
        );
        assert!(
            format_log_entry(&entry("2026-08-01T12:00:00Z", "a.md", "move")).contains("**Move**")
        );
        assert!(
            format_log_entry(&entry("2026-08-01T12:00:00Z", "a.md", "delete"))
                .contains("**Deletion**")
        );
    }

    #[test]
    fn an_entry_names_the_path_and_the_actor() {
        let line = format_log_entry(&write_entry("2026-08-01T12:00:00Z", "wiki/a.md"));
        assert!(line.contains("wiki/a.md"));
        assert!(line.contains("human:kn"));
        assert_eq!(line, "* **Update**: `wiki/a.md` by human:kn.");
    }

    #[test]
    fn date_sections_are_newest_first() {
        let mut log = insert_log_entry("", &write_entry("2026-07-30T12:00:00Z", "old.md"));
        log = insert_log_entry(&log, &write_entry("2026-08-01T12:00:00Z", "new.md"));
        assert_eq!(log_dates(&log), ["2026-08-01", "2026-07-30"]);
    }

    #[test]
    fn a_middle_date_lands_between_existing_sections() {
        let mut log = insert_log_entry("", &write_entry("2026-07-30T12:00:00Z", "a.md"));
        log = insert_log_entry(&log, &write_entry("2026-08-05T12:00:00Z", "b.md"));
        log = insert_log_entry(&log, &write_entry("2026-08-01T12:00:00Z", "c.md"));
        assert_eq!(log_dates(&log), ["2026-08-05", "2026-08-01", "2026-07-30"]);
    }

    #[test]
    fn within_a_day_the_newest_entry_comes_first() {
        let mut log = insert_log_entry("", &write_entry("2026-08-01T12:00:00Z", "first.md"));
        log = insert_log_entry(&log, &write_entry("2026-08-01T12:00:00Z", "second.md"));

        let bullets: Vec<&str> = log.split('\n').filter(|l| l.starts_with("* ")).collect();
        assert!(bullets[0].contains("second.md"));
        assert!(bullets[1].contains("first.md"));
        assert_eq!(log_dates(&log), ["2026-08-01"]);
    }

    #[test]
    fn the_title_is_never_duplicated() {
        let mut log = insert_log_entry("", &write_entry("2026-08-01T12:00:00Z", "a.md"));
        log = insert_log_entry(&log, &write_entry("2026-08-02T12:00:00Z", "b.md"));
        assert_eq!(log.lines().filter(|l| l.starts_with("# ")).count(), 1);
    }

    #[test]
    fn starting_from_an_existing_empty_log_keeps_one_title() {
        let log = insert_log_entry(
            &empty_log_md("Log"),
            &write_entry("2026-08-01T12:00:00Z", "a.md"),
        );
        assert_eq!(log.lines().filter(|l| l.starts_with("# ")).count(), 1);
        assert!(log.contains("## 2026-08-01"));
    }

    #[test]
    fn a_log_with_entries_stays_conformant() {
        let log = insert_log_entry("", &write_entry("2026-08-01T12:00:00Z", "a.md"));
        assert!(check_conformance("log.md", &log).ok);
    }

    #[test]
    fn log_layout_is_byte_exact() {
        let log = insert_log_entry("", &write_entry("2026-08-01T12:00:00", "a.md"));
        // Faithful to the TS: no blank line after the title when the log was
        // empty, and a doubled trailing newline.
        assert_eq!(
            log,
            "# Log\n## 2026-08-01\n\n* **Update**: `a.md` by human:kn.\n\n"
        );
    }

    #[test]
    fn iso_date_reduces_a_timestamp_to_the_date_heading_form() {
        assert_eq!(iso_date("2026-08-01T12:00:00Z"), "2026-08-01");
        assert_eq!(
            iso_date_of(&Utc.with_ymd_and_hms(2026, 1, 2, 12, 0, 0).unwrap()),
            "2026-01-02"
        );
    }

    #[test]
    fn iso_date_uses_the_local_day() {
        // A date-time without an offset is local time, so the day is unchanged.
        assert_eq!(iso_date("2026-08-01T00:30:00"), "2026-08-01");
        assert_eq!(iso_date("2026-08-01T23:30:00"), "2026-08-01");
    }

    #[test]
    fn parse_log_entries_inverts_format_log_entry() {
        let mut e = entry("2026-08-01T12:00:00Z", "wiki/a.md", "create");
        e.actor = "process:fable-5.1".into();
        e.note = Some("first draft".into());
        let log = insert_log_entry("", &e);

        let parsed = parse_log_entries(&log);
        assert_eq!(
            parsed,
            vec![ParsedLogEntry {
                date: "2026-08-01".into(),
                kind: "Creation".into(),
                path: "wiki/a.md".into(),
                actor: "process:fable-5.1".into(),
                note: Some("first draft".into()),
            }]
        );
    }

    // ---- ported from test/audit.test.ts ("parseLogEntries") ----

    #[test]
    fn round_trips_what_insert_log_entry_wrote_dotted_actors_included() {
        let mut log = String::new();
        log = insert_log_entry(
            &log,
            &LogEntry {
                at: "2026-09-01T12:00:00Z".into(),
                actor: "process:fable-5.1".into(),
                action: "create".into(),
                path: "wiki/a.md".into(),
                note: None,
            },
        );
        log = insert_log_entry(
            &log,
            &LogEntry {
                at: "2026-09-02T12:00:00Z".into(),
                actor: "human:local".into(),
                action: "write".into(),
                path: "wiki/b.md".into(),
                note: Some("typo fixed".into()),
            },
        );

        let entry =
            |date: &str, kind: &str, path: &str, actor: &str, note: Option<&str>| ParsedLogEntry {
                date: date.into(),
                kind: kind.into(),
                path: path.into(),
                actor: actor.into(),
                note: note.map(Into::into),
            };
        assert_eq!(
            parse_log_entries(&log),
            vec![
                entry(
                    "2026-09-02",
                    "Update",
                    "wiki/b.md",
                    "human:local",
                    Some("typo fixed")
                ),
                entry(
                    "2026-09-01",
                    "Creation",
                    "wiki/a.md",
                    "process:fable-5.1",
                    None
                ),
            ]
        );
    }

    #[test]
    fn skips_hand_written_prose_instead_of_failing_the_audit() {
        let log = [
            "# Log",
            "",
            "## 2026-09-01",
            "",
            "* 手で書いたメモ。書式は自由。",
            "* **Update**: `wiki/x.md` by human:local.",
            "",
        ]
        .join("\n");

        let entries = parse_log_entries(&log);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "wiki/x.md");
    }

    #[test]
    fn parse_log_entries_skips_free_prose_and_undated_bullets() {
        let log = "# Log\n\n* **Update**: `x.md` by a.\n\n## 2026-08-01\n\nsome prose\n* **Move**: `b.md` by human:kn.\n";
        let parsed = parse_log_entries(log);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, "b.md");
        assert_eq!(parsed[0].note, None);
    }
}
