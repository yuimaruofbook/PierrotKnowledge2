//! YAML frontmatter framing (`src/shared/okf/frontmatter.ts`).
//!
//! Splitting and re-joining are kept separate from YAML *parsing* so callers
//! that only need the body never pull in a YAML library.

use crate::shared::js_compat::{is_js_line_terminator, js_trim};
use regex::Regex;
use std::sync::LazyLock;

static FRONTMATTER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)").unwrap());

/// Line ending detected in a source, used to round-trip faithfully.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eol {
    Lf,
    CrLf,
}

impl Eol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "\n",
            Self::CrLf => "\r\n",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitDocument {
    /// Frontmatter source, without the `---` fences. `None` when absent.
    pub yaml: Option<String>,
    /// Document body with the frontmatter block removed.
    pub body: String,
    /// Line ending detected in the source.
    pub eol: Eol,
}

pub fn detect_eol(raw: &str) -> Eol {
    if raw.contains("\r\n") {
        Eol::CrLf
    } else {
        Eol::Lf
    }
}

/// Split a raw file into frontmatter and body.
///
/// A leading UTF-8 BOM is tolerated: editors add one silently and it would
/// otherwise make the `---` fence unmatchable.
pub fn split_frontmatter(raw: &str) -> SplitDocument {
    let eol = detect_eol(raw);
    let text = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    match FRONTMATTER_RE.captures(text) {
        None => SplitDocument {
            yaml: None,
            body: text.to_string(),
            eol,
        },
        Some(caps) => {
            let whole = caps.get(0).expect("group 0 always present");
            SplitDocument {
                yaml: Some(caps.get(1).map_or("", |m| m.as_str()).to_string()),
                body: text[whole.end()..].to_string(),
                eol,
            }
        }
    }
}

pub fn has_frontmatter(raw: &str) -> bool {
    split_frontmatter(raw).yaml.is_some()
}

/// Re-attach a frontmatter block to a body.
pub fn join_frontmatter(yaml: &str, body: &str, eol: Eol) -> String {
    let eol = eol.as_str();
    let yaml = yaml
        .strip_suffix("\r\n")
        .or_else(|| yaml.strip_suffix('\n'))
        .unwrap_or(yaml);
    let block = ["---", yaml, "---", ""].join(eol);
    format!("{block}{eol}{}", body.trim_start_matches(['\r', '\n']))
}

/// Read a single scalar key straight out of frontmatter source.
///
/// Used for conformance checks and cheap metadata reads where a full YAML parse
/// is not worth it. Only top-level, unquoted-or-quoted scalars. Equivalent to
/// `/^key[ \t]*:[ \t]*(.*)$/m`, where JS multiline `^`/`$`/`.` treat `\r`,
/// U+2028 and U+2029 as line breaks as well as `\n`.
pub fn read_scalar(yaml: &str, key: &str) -> Option<String> {
    let line = yaml.split(is_js_line_terminator).find_map(|line| {
        let rest = line.strip_prefix(key)?;
        let rest = rest.trim_start_matches([' ', '\t']).strip_prefix(':')?;
        Some(rest.trim_start_matches([' ', '\t']))
    })?;
    let value = js_trim(line);
    if value.is_empty() || value == "|" || value == ">" {
        return None;
    }
    Some(strip_quotes(value).to_string())
}

fn strip_quotes(value: &str) -> &str {
    let first = value.chars().next();
    if let Some(q @ ('"' | '\'')) = first {
        if value.len() > 1 && value.ends_with(q) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_normal_document() {
        let doc = split_frontmatter("---\ntype: Concept\n---\n\n# Title\n");
        assert_eq!(doc.yaml.as_deref(), Some("type: Concept"));
        // The body is preserved verbatim, blank line included.
        assert_eq!(doc.body, "\n# Title\n");
    }

    #[test]
    fn returns_none_yaml_when_there_is_no_frontmatter() {
        assert_eq!(split_frontmatter("# Just a heading").yaml, None);
    }

    #[test]
    fn tolerates_crlf_and_reports_the_line_ending() {
        let doc = split_frontmatter("---\r\ntype: Note\r\n---\r\nbody\r\n");
        assert_eq!(doc.yaml.as_deref(), Some("type: Note"));
        assert_eq!(doc.eol, Eol::CrLf);
    }

    #[test]
    fn tolerates_a_bom() {
        assert_eq!(
            split_frontmatter("\u{FEFF}---\ntype: Note\n---\nbody")
                .yaml
                .as_deref(),
            Some("type: Note")
        );
    }

    #[test]
    fn does_not_treat_a_horizontal_rule_as_frontmatter() {
        assert_eq!(split_frontmatter("text\n\n---\n\nmore").yaml, None);
    }

    #[test]
    fn round_trips_through_join_frontmatter() {
        let raw = join_frontmatter("type: Concept", "# Body\n", Eol::Lf);
        assert_eq!(
            split_frontmatter(&raw).yaml.as_deref(),
            Some("type: Concept")
        );
        assert_eq!(split_frontmatter(&raw).body.trim_start(), "# Body\n");
    }

    #[test]
    fn join_uses_the_requested_line_ending_and_trims_leading_breaks() {
        assert_eq!(
            join_frontmatter("a: 1\n", "\r\n\nbody", Eol::CrLf),
            "---\r\na: 1\r\n---\r\n\r\nbody"
        );
    }

    #[test]
    fn reads_quoted_and_unquoted_values() {
        assert_eq!(
            read_scalar("type: \"My Type\"", "type").as_deref(),
            Some("My Type")
        );
        assert_eq!(
            read_scalar("type: Concept", "type").as_deref(),
            Some("Concept")
        );
    }

    #[test]
    fn returns_none_for_an_empty_or_block_value() {
        assert_eq!(read_scalar("type:", "type"), None);
        assert_eq!(read_scalar("type: |", "type"), None);
    }

    #[test]
    fn read_scalar_only_matches_whole_keys_at_line_start() {
        assert_eq!(read_scalar("subtype: x", "type"), None);
        assert_eq!(
            read_scalar("title: a\ntype: B", "type").as_deref(),
            Some("B")
        );
        assert_eq!(read_scalar("typed: x", "type"), None);
    }
}
