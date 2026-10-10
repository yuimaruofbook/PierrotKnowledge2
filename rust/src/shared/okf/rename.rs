//! Rewriting links when a concept moves (`src/shared/okf/rename.ts`).
//!
//! Renaming a page is only safe if every reference follows it; without this a
//! rename silently breaks the graph. Rewrites operate on the source text so
//! formatting, spacing and link style are preserved: a `[[wikilink]]` stays a
//! wikilink, a relative Markdown link stays relative to its own directory.

use super::links::{resolve_link_target, Masked};
use crate::shared::js_compat::{js_regex, js_trim};
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RenameEdit {
    /// Concept id of the document being edited.
    pub id: String,
    /// Rewritten body.
    pub body: String,
    /// How many references changed.
    pub count: usize,
}

/// Result of a rewrite: the new body and how many references changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewritten {
    pub body: String,
    pub count: usize,
}

/// Relative path from one concept id's directory to another concept id.
pub fn relative_id_path(from_id: &str, to_id: &str) -> String {
    let from_all: Vec<&str> = from_id.split('/').collect();
    let from_parts = &from_all[..from_all.len() - 1];
    let mut to_parts: Vec<&str> = to_id.split('/').collect();
    let to_name = to_parts.pop().unwrap_or("");

    let mut common = 0;
    while common < from_parts.len()
        && common < to_parts.len()
        && from_parts[common] == to_parts[common]
    {
        common += 1;
    }

    let up = from_parts.len() - common;
    let down = &to_parts[common..];
    let mut segments: Vec<&str> = vec![".."; up];
    segments.extend_from_slice(down);
    segments.push(to_name);
    let path = segments.join("/");

    // A bare name would read as a sibling anyway, but an explicit `./` makes the
    // intent unambiguous to both readers and other Markdown tools.
    if up == 0 && down.is_empty() {
        format!("./{path}")
    } else {
        path
    }
}

/// Wikilinks here keep the `#fragment` and `|label` parts (with their
/// punctuation) in their own groups so they can be re-emitted verbatim.
static WIKILINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[\[([^\[\]|#]+)((?:#[^\[\]|]*)?)((?:\|[^\[\]]*)?)\]\]").unwrap()
});

static MDLINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(r#"(!?)\[([^\]]*)\]\(<S>*<?([^)<><WS>]+)>?((?:<S>+"[^"]*")?)<S>*\)"#)
});

struct Edit {
    start: usize,
    end: usize,
    text: String,
}

/// Apply edits to the original text, last offset first so earlier offsets stay
/// valid (stable sort, like JS).
fn apply_edits(body: &str, mut edits: Vec<Edit>) -> String {
    edits.sort_by_key(|e| std::cmp::Reverse(e.start));
    let mut next = body.to_string();
    for edit in edits {
        next.replace_range(edit.start..edit.end, &edit.text);
    }
    next
}

fn fragment_of(target: &str) -> String {
    match target.find('#') {
        Some(_) => {
            let parts: Vec<&str> = target.split('#').skip(1).collect();
            format!("#{}", parts.join("#"))
        }
        None => String::new(),
    }
}

/// Rewrite every link in `body` that resolves to `old_id` so it points at `new_id`.
///
/// `known_ids` must describe the state *before* the move, so that the same
/// resolution rules that made a link point at the old id are used to decide
/// whether it needs updating.
pub fn rewrite_links(
    body: &str,
    from_id: &str,
    old_id: &str,
    new_id: &str,
    known_ids: &HashSet<String>,
) -> Rewritten {
    if old_id == new_id {
        return Rewritten {
            body: body.to_string(),
            count: 0,
        };
    }

    let mk = Masked::new(body);
    let mut count = 0;

    // Edits are collected against the masked copy and applied to the original by
    // offset, so links inside fenced code are never touched.
    let mut edits: Vec<Edit> = Vec::new();

    for caps in WIKILINK_RE.captures_iter(&mk.text) {
        let target = mk.group(&caps, 1);
        let target = js_trim(&target);
        if resolve_link_target(target, from_id, Some(known_ids)).as_deref() != Some(old_id) {
            continue;
        }

        let fragment = mk.group(&caps, 2);
        let label = mk.group(&caps, 3);
        // A bare `[[old]]` with no label would silently change its displayed
        // text on rename, so the old name is preserved as an explicit label.
        let keeps_label = if label.is_empty() {
            format!("|{target}")
        } else {
            label.to_string()
        };
        let whole = caps.get(0).expect("group 0 always present");

        edits.push(Edit {
            start: whole.start(),
            end: whole.end(),
            text: format!("[[{new_id}{fragment}{keeps_label}]]"),
        });
        count += 1;
    }

    for caps in MDLINK_RE.captures_iter(&mk.text) {
        if caps.get(1).is_some_and(|m| !m.as_str().is_empty()) {
            continue; // image embed
        }
        let target = mk.group(&caps, 3);
        let target = js_trim(&target);
        if resolve_link_target(target, from_id, Some(known_ids)).as_deref() != Some(old_id) {
            continue;
        }

        let next = format!(
            "{}.md{}",
            relative_id_path(from_id, new_id),
            fragment_of(target)
        );
        let whole = caps.get(0).expect("group 0 always present");
        edits.push(Edit {
            start: whole.start(),
            end: whole.end(),
            text: format!("[{}]({next}{})", mk.group(&caps, 2), mk.group(&caps, 4)),
        });
        count += 1;
    }

    if edits.is_empty() {
        return Rewritten {
            body: body.to_string(),
            count: 0,
        };
    }
    Rewritten {
        body: apply_edits(body, edits),
        count,
    }
}

fn dir_of(id: &str) -> String {
    let parts: Vec<&str> = id.split('/').collect();
    parts[..parts.len() - 1].join("/")
}

/// Rewrite a document's *own* relative links after it moves.
///
/// Its wikilinks are unaffected (they address ids, not paths), but every
/// relative Markdown link was written from the old directory and would
/// otherwise point somewhere else, or nowhere.
pub fn rebase_own_links(
    body: &str,
    old_id: &str,
    new_id: &str,
    known_ids: &HashSet<String>,
) -> Rewritten {
    if dir_of(old_id) == dir_of(new_id) {
        return Rewritten {
            body: body.to_string(),
            count: 0,
        };
    }

    let mk = Masked::new(body);
    let mut edits: Vec<Edit> = Vec::new();
    let mut count = 0;

    for caps in MDLINK_RE.captures_iter(&mk.text) {
        if caps.get(1).is_some_and(|m| !m.as_str().is_empty()) {
            continue;
        }
        let target = mk.group(&caps, 3);
        let target = js_trim(&target);
        let Some(resolved) = resolve_link_target(target, old_id, Some(known_ids)) else {
            continue;
        };
        if resolved == old_id {
            continue;
        }

        let next = format!(
            "{}.md{}",
            relative_id_path(new_id, &resolved),
            fragment_of(target)
        );
        let whole = caps.get(0).expect("group 0 always present");
        edits.push(Edit {
            start: whole.start(),
            end: whole.end(),
            text: format!("[{}]({next}{})", mk.group(&caps, 2), mk.group(&caps, 4)),
        });
        count += 1;
    }

    if edits.is_empty() {
        return Rewritten {
            body: body.to_string(),
            count: 0,
        };
    }
    Rewritten {
        body: apply_edits(body, edits),
        count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> HashSet<String> {
        ["a", "topics/b", "topics/deep/c", "other"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    // ---- relativeIdPath ----

    #[test]
    fn same_directory_is_explicitly_relative() {
        // An explicit "./" reads unambiguously to both people and Markdown tools.
        assert_eq!(relative_id_path("topics/b", "topics/x"), "./x");
    }

    #[test]
    fn upwards() {
        assert_eq!(relative_id_path("topics/deep/c", "a"), "../../a");
    }

    #[test]
    fn downwards() {
        assert_eq!(relative_id_path("a", "topics/deep/c"), "topics/deep/c");
    }

    #[test]
    fn root_to_root_is_explicitly_relative() {
        assert_eq!(relative_id_path("a", "other"), "./other");
    }

    // ---- rewriteLinks ----

    #[test]
    fn updates_a_wikilink_and_keeps_the_displayed_text() {
        let r = rewrite_links(
            "see [[topics/b]] here",
            "a",
            "topics/b",
            "topics/z",
            &known(),
        );
        assert_eq!(r.count, 1);
        // Without the preserved label the rendered text would silently change.
        assert_eq!(r.body, "see [[topics/z|topics/b]] here");
    }

    #[test]
    fn keeps_an_existing_label() {
        let r = rewrite_links("[[topics/b|Bee]]", "a", "topics/b", "topics/z", &known());
        assert_eq!(r.body, "[[topics/z|Bee]]");
    }

    #[test]
    fn preserves_a_fragment() {
        let r = rewrite_links("[[topics/b#setup]]", "a", "topics/b", "topics/z", &known());
        assert!(r.body.contains("topics/z#setup"));
    }

    #[test]
    fn updates_a_relative_markdown_link_staying_relative() {
        let r = rewrite_links(
            "see [B](./topics/b.md)",
            "a",
            "topics/b",
            "topics/deep/z",
            &known(),
        );
        assert_eq!(r.count, 1);
        assert_eq!(r.body, "see [B](topics/deep/z.md)");
    }

    #[test]
    fn rewrites_relative_to_the_linking_document() {
        let r = rewrite_links("[A](../a.md)", "topics/b", "a", "moved/a", &known());
        assert_eq!(r.body, "[A](../moved/a.md)");
    }

    #[test]
    fn leaves_links_to_other_documents_alone() {
        let source = "[[other]] and [C](./topics/deep/c.md)";
        let r = rewrite_links(source, "a", "topics/b", "topics/z", &known());
        assert_eq!(r.count, 0);
        assert_eq!(r.body, source);
    }

    #[test]
    fn never_touches_links_inside_fenced_code() {
        let source = "```\n[[topics/b]]\n```\nreal [[topics/b]]";
        let r = rewrite_links(source, "a", "topics/b", "topics/z", &known());
        assert_eq!(r.count, 1);
        assert!(r.body.contains("```\n[[topics/b]]\n```"));
        assert!(r.body.contains("[[topics/z|topics/b]]"));
    }

    #[test]
    fn ignores_image_embeds() {
        let r = rewrite_links(
            "![pic](./topics/b.md)",
            "a",
            "topics/b",
            "topics/z",
            &known(),
        );
        assert_eq!(r.count, 0);
    }

    #[test]
    fn a_no_op_rename_changes_nothing() {
        assert_eq!(
            rewrite_links("[[topics/b]]", "a", "topics/b", "topics/b", &known()).count,
            0
        );
    }

    #[test]
    fn rewrites_every_occurrence() {
        let r = rewrite_links(
            "[[topics/b]] then [B](./topics/b.md) then [[topics/b|x]]",
            "a",
            "topics/b",
            "z",
            &known(),
        );
        assert_eq!(r.count, 3);
    }

    #[test]
    fn multibyte_text_around_links_survives_offset_edits() {
        let r = rewrite_links(
            "日本語 [[topics/b]] 😀 [B](./topics/b.md) 終",
            "a",
            "topics/b",
            "z",
            &known(),
        );
        assert_eq!(r.body, "日本語 [[z|topics/b]] 😀 [B](./z.md) 終");
    }

    #[test]
    fn code_inside_a_label_is_written_back_blanked_per_utf16_unit() {
        // The TS re-emits the label from the code-masked copy, so inline code in
        // a label turns into spaces: one per UTF-16 unit (日 = 1, 😀 = 2, `` = 1 each).
        let mut ids = known();
        ids.insert("a".into());
        let r = rewrite_links("[x `日😀` y](./topics/b.md)", "a", "topics/b", "z", &ids);
        assert_eq!(r.body, "[x       y](./z.md)");
        assert_eq!(r.count, 1);
    }

    // ---- rebaseOwnLinks ----

    #[test]
    fn rewrites_the_moved_documents_own_relative_links() {
        // `a` links to topics/b; moving `a` into topics/ makes `./topics/b.md` wrong.
        let r = rebase_own_links("[B](./topics/b.md)", "a", "topics/a", &known());
        assert_eq!(r.count, 1);
        assert_eq!(r.body, "[B](./b.md)");
    }

    #[test]
    fn does_nothing_when_the_directory_is_unchanged() {
        assert_eq!(
            rebase_own_links("[B](./topics/b.md)", "a", "renamed", &known()).count,
            0
        );
    }

    #[test]
    fn leaves_wikilinks_alone_they_address_ids_not_paths() {
        let r = rebase_own_links("[[topics/b]]", "a", "deep/a", &known());
        assert_eq!(r.count, 0);
        assert_eq!(r.body, "[[topics/b]]");
    }

    #[test]
    fn leaves_external_links_alone() {
        assert_eq!(
            rebase_own_links("[x](https://example.com)", "a", "deep/a", &known()).count,
            0
        );
    }
}
