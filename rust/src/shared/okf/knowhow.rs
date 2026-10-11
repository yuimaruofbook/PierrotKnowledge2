//! Know-how: short lessons one agent leaves for the next
//! (`src/shared/okf/knowhow.ts`).
//!
//! Lighter than a skill. A skill is a procedure you open and follow; a
//! know-how note is one thing learned the hard way, small enough that a
//! context pack can offer the best three by title alone. Each carries who
//! recorded it, so a reader can weigh a lesson by its source.

use super::concept::is_concept_path;
use crate::shared::js_compat::{is_js_space, split_crlf};
use regex::Regex;
use std::sync::LazyLock;

/// Where know-how lives, inside the wiki layer.
pub const KNOWHOW_DIR: &str = "knowhow";

/// The concept type of a know-how note.
pub const KNOWHOW_TYPE: &str = "Knowhow";

/// Heading of the folder's `index.md`.
pub const KNOWHOW_TITLE: &str = "Know-how";

/// Longest derived description, in code points.
const DESCRIPTION_MAX: usize = 140;

static NON_WORD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}\p{M}]+").unwrap());

/// Windows device names: a file with one of these stems cannot be created there.
static DEVICE_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$").unwrap());

/// A filename stem from a title.
///
/// Unlike a loop name this keeps letters and digits of any script: the notes
/// are written in Japanese as often as English, and an ASCII-only slug would
/// collapse every Japanese title into the same fallback.
///
/// A stem that would make the file something other than a plain concept
/// (`index`, `log`, `agents`, `map`, `human`, `task`: reserved or workspace
/// files, never indexed) or a Windows device name gets `-note` appended.
pub fn knowhow_slug(title: &str, max: usize) -> String {
    let dashed = NON_WORD_RE.replace_all(&title.to_lowercase(), "-").into_owned();
    let trimmed = dashed.trim_matches('-');
    let capped: String = trimmed.chars().take(max).collect();
    let slug = capped.trim_end_matches('-');
    let stem = if slug.is_empty() { KNOWHOW_DIR } else { slug };
    if !is_concept_path(&format!("{stem}.md")) || DEVICE_NAME_RE.is_match(stem) {
        format!("{stem}-note")
    } else {
        stem.to_string()
    }
}

/// [`knowhow_slug`] with the TS default `max` of 60.
pub fn knowhow_slug_default(title: &str) -> String {
    knowhow_slug(title, 60)
}

/// One line summarising a body: its first meaningful line, markers stripped.
///
/// Know-how is added with a title and a body only, but the pack and
/// `knowhow_find` show descriptions, so one is derived.
pub fn derive_description(body: &str) -> String {
    for raw in split_crlf(body) {
        let stripped = raw.trim_start_matches(|c: char| matches!(c, '#' | '>' | '*' | '-') || is_js_space(c));
        let line = stripped
            .split(is_js_space)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if line.is_empty() {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        return if chars.len() > DESCRIPTION_MAX {
            format!("{}…", chars[..DESCRIPTION_MAX].iter().collect::<String>())
        } else {
            line
        };
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_keep_letters_of_any_script_and_fall_back_to_the_folder_name() {
        assert_eq!(knowhow_slug_default("Windows: path  separators!"), "windows-path-separators");
        assert_eq!(knowhow_slug_default("日本語のパス問題"), "日本語のパス問題");
        assert_eq!(knowhow_slug_default("!!!"), "knowhow");
        assert_eq!(knowhow_slug_default(&"a".repeat(100)).chars().count(), 60);
        assert_eq!(knowhow_slug("ab-cd", 3), "ab");
    }

    #[test]
    fn reserved_basenames_and_device_names_get_a_note_suffix() {
        // index/log are OKF-reserved, agents is the contract, map/human/task are workspace files.
        for title in ["index", "Index", "log", "agents", "map", "human", "task", "CON", "prn", "Aux", "nul", "COM1", "lpt9"] {
            assert_eq!(knowhow_slug_default(title), format!("{}-note", title.to_lowercase()));
        }
        for title in ["tasks", "console", "com10", "index of things", "logbook"] {
            assert!(!knowhow_slug_default(title).ends_with("-note"), "{title}");
        }
    }

    #[test]
    fn the_description_is_the_first_meaningful_line_trimmed() {
        assert_eq!(derive_description("\n\n## Heading\n- use   forward slashes\nmore"), "Heading");
        assert_eq!(derive_description("  > quoted   lesson here  "), "quoted lesson here");
        assert_eq!(derive_description("***\n"), "");
        let long = derive_description(&"x".repeat(200));
        assert_eq!(long.chars().count(), 141);
        assert!(long.ends_with('…'));
        assert_eq!(derive_description("a\r\nb"), "a");
    }
}
