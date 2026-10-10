//! Naming files captured from outside the bundle (`src/shared/okf/capture.ts`).
//!
//! Dropping a file onto the window takes what is already on disk (a saved page,
//! an export, a transcript) into `raw/`. The name is the untrusted part: it
//! comes from another filesystem and is the only thing about a dropped file that
//! could reach for a path of its own, so it is reduced to a bare filename here.
//! The bundle still refuses to write outside `raw/`; this exists so that check
//! is never the only one.

use crate::shared::js_compat::{from_utf16, is_js_space, js_trim, to_utf16};
use regex::Regex;
use std::sync::LazyLock;

/// What is removed from an outside filename: control characters, both path
/// separators, and the characters Windows rejects in a name. Control characters
/// use `\p{Cc}` rather than a range so the class contains no range hyphen.
static UNSAFE_CHARS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[\p{Cc}\\/:*?"<>|]"#).unwrap());

/// Bound on the stored name, in UTF-16 units: long enough that ordinary titles
/// survive whole, short enough to stay clear of the 255-byte limit once a `-2`
/// collision suffix is added and the name is encoded as UTF-8.
const MAX_NAME: usize = 120;

/// Used when the name reduces to nothing, or to nothing but dots.
const FALLBACK: &str = "captured";

/// Largest file that may be captured through a drop, in bytes.
///
/// The limit is the transport, not the disk: the content crosses the RPC socket
/// as one JSON message, so a dropped video would stall the UI's connection.
pub const MAX_CAPTURE_BYTES: u64 = 8 * 1024 * 1024;

/// Reduce an outside filename to a safe one, keeping it recognisable.
///
/// Japanese, spaces and hyphens are all left alone: the name is how the file
/// gets found again. Only what a path or a filesystem would take badly is removed.
pub fn captured_file_name(name: &str) -> String {
    // Everything before the last separator is a directory the drop does not get
    // to choose, including `..`, which is why this comes first.
    let base = name.rsplit(['\\', '/']).next().unwrap_or("");

    let stripped = UNSAFE_CHARS.replace_all(base, "");
    // `.replace(/\s+/g, " ")`
    let mut spaced = String::with_capacity(stripped.len());
    let mut in_space = false;
    for c in stripped.chars() {
        if is_js_space(c) {
            if !in_space {
                spaced.push(' ');
            }
            in_space = true;
        } else {
            in_space = false;
            spaced.push(c);
        }
    }
    // `.replace(/^[.\s]+|[.\s]+$/g, "").trim()`
    let cleaned = js_trim(spaced.trim_matches(|c: char| c == '.' || is_js_space(c)));

    if cleaned.is_empty() {
        return FALLBACK.to_string();
    }
    let units = to_utf16(cleaned);
    if units.len() <= MAX_NAME {
        return cleaned.to_string();
    }

    // Truncating blindly would take the extension with it, and the extension is
    // what decides how the file is read back and rendered.
    let dot = units.iter().rposition(|&u| u == b'.' as u16);
    let ext: &[u16] = match dot {
        Some(d) if d > 0 => &units[d..],
        _ => &[],
    };
    let stem = if ext.is_empty() {
        &units[..]
    } else {
        &units[..dot.unwrap_or(0)]
    };

    let keep = MAX_NAME.saturating_sub(ext.len()).max(1).min(stem.len());
    format!("{}{}", from_utf16(&stem[..keep]), from_utf16(ext))
}

/// Where a captured file lands: the `raw/` inbox, under its own name.
pub fn capture_path_for(name: &str) -> String {
    format!("raw/{}", captured_file_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::js_compat::utf16_len;

    #[test]
    fn keeps_the_name_the_file_already_had() {
        // The whole point of dropping a file in is finding it again by its name.
        assert_eq!(
            captured_file_name("2026-08-08-記事.html"),
            "2026-08-08-記事.html"
        );
        assert_eq!(captured_file_name("notes.md"), "notes.md");
    }

    #[test]
    fn takes_the_basename_whatever_separator_was_used() {
        assert_eq!(captured_file_name("folder/sub/page.html"), "page.html");
        assert_eq!(captured_file_name("C:\\Users\\me\\page.html"), "page.html");
    }

    #[test]
    fn cannot_climb_out_with_dots() {
        assert_eq!(captured_file_name("../../etc/passwd"), "passwd");
        assert_eq!(captured_file_name(".."), "captured");
        assert_eq!(captured_file_name("..."), "captured");
    }

    #[test]
    fn strips_what_a_filesystem_rejects() {
        assert_eq!(captured_file_name("a:b*c?d\"e<f>g|h.html"), "abcdefgh.html");
        assert_eq!(captured_file_name("bell\u{7}.html"), "bell.html");
    }

    #[test]
    fn falls_back_when_nothing_usable_is_left() {
        assert_eq!(captured_file_name(""), "captured");
        assert_eq!(captured_file_name("   "), "captured");
        assert_eq!(captured_file_name("///"), "captured");
    }

    #[test]
    fn does_not_leave_a_hidden_file_or_a_trailing_dot() {
        // A leading dot hides the capture; a trailing one is invalid on Windows.
        assert_eq!(captured_file_name(".env"), "env");
        assert_eq!(captured_file_name("report."), "report");
    }

    #[test]
    fn bounds_the_length_without_losing_the_extension() {
        let long = format!("{}.html", "あ".repeat(300));
        let named = captured_file_name(&long);
        assert!(utf16_len(&named) <= 120);
        assert!(named.ends_with(".html"));
        assert_eq!(utf16_len(&named), 120);
    }

    #[test]
    fn collapses_internal_whitespace() {
        assert_eq!(captured_file_name("a \t  b.md"), "a b.md");
    }

    #[test]
    fn lands_in_the_raw_inbox() {
        assert_eq!(capture_path_for("記事.html"), "raw/記事.html");
    }

    #[test]
    fn a_name_reaching_for_another_layer_cannot_get_there() {
        assert_eq!(capture_path_for("../wiki/AGENTS.md"), "raw/AGENTS.md");
    }
}
