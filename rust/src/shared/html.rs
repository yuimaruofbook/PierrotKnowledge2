//! Recognising HTML, so captured material can be stored as HTML
//! (`src/shared/html.ts`, plus `looksLikeMarkdown` from `src/shared/paste.ts`).

use crate::shared::js_compat::js_trim;
use regex::Regex;
use std::sync::LazyLock;

/// Escape text for insertion into markup.
pub fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Markdown signals strong enough to mean "this text is already Markdown".
static MARKDOWN_SIGNALS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?m)^```",
        r"(?m)^#{1,6}\s+\S",
        r"\[[^\]]*\]\([^)]*\)",
        r"(?m)^\s*[-*+]\s+\[[ xX]\]",
        r"(?m)^\s*>\s+\S",
        r"\[\[[^\]]+\]\]",
        r"(?s)\A---\r?\n.*?\r?\n---",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("valid regex"))
    .collect()
});

pub fn looks_like_markdown(text: &str) -> bool {
    MARKDOWN_SIGNALS.iter().any(|re| re.is_match(text))
}

static DOCUMENT_SIGNAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]").expect("valid regex"));
static PREAMBLE_NOISE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A(?:\s|<\?(?s:.)*?\?>|<!--(?s:.)*?-->)+").expect("valid regex"));
const BLOCK_TAGS: &str =
    "p|div|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|h[1-6]|article|section|main|header|footer|nav|aside|blockquote|pre|figure";
static BLOCK_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)<({BLOCK_TAGS})\b[^>]*>")).expect("valid regex"));
static CLOSING_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)</({BLOCK_TAGS})\s*>")).expect("valid regex"));

/// How far in the document signal is looked for, in characters.
const PREAMBLE_CHARS: usize = 1024;
const BLOCK_TAGS_REQUIRED: usize = 3;

/// Whether text should be treated as HTML rather than Markdown: a document
/// signal near the top, or enough block structure and no Markdown.
pub fn looks_like_html(text: &str) -> bool {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return false;
    }
    let rest = PREAMBLE_NOISE.replace(trimmed, "");
    let preamble: String = rest.chars().take(PREAMBLE_CHARS).collect();
    if DOCUMENT_SIGNAL.is_match(&preamble) {
        return true;
    }
    if BLOCK_TAG.find_iter(trimmed).count() < BLOCK_TAGS_REQUIRED || !CLOSING_BLOCK.is_match(trimmed) {
        return false;
    }
    !looks_like_markdown(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_documents_fragments_and_notes() {
        assert!(looks_like_html("<!-- c -->\n<!DOCTYPE html><p>x</p>"));
        assert!(looks_like_html("<div><p>a</p><p>b</p></div>"));
        assert!(!looks_like_html("# Title\n<div><p>a</p><p>b</p></div>"));
        assert!(!looks_like_html("plain text with <br> in it"));
        assert!(!looks_like_html("   "));
    }

    #[test]
    fn escapes_markup() {
        assert_eq!(escape_html(r#"<a href="x">'&'</a>"#), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    }
}
