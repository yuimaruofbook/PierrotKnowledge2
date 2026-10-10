//! Splitting a concept body into retrievable chunks (`src/shared/okf/chunk.ts`).
//!
//! Whole-document retrieval is the wrong granularity for RAG: a long page
//! returns mostly irrelevant text and crowds the context window. Headings are
//! the author's own structure, so sections make honest chunks, and each one
//! carries its heading path, which gives a model the context a bare excerpt
//! lacks and gives the reader a citable anchor.
//!
//! Sizes ([`MAX_CHUNK_CHARS`], [`CHUNK_OVERLAP_CHARS`]) and [`Chunk::char_start`]
//! are in **UTF-16 code units**, as the JS `.length` they replace.

use super::links::mask_code;
use crate::shared::js_compat::{
    from_utf16, index_of16, js_regex, js_trim, to_utf16, trim16, utf16_len,
};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

/// Chunks larger than this are split further, at paragraph boundaries.
pub const MAX_CHUNK_CHARS: usize = 1200;
/// Overlap carried into a continuation chunk, so a split cannot orphan a claim.
pub const CHUNK_OVERLAP_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// Position within the document, 0-based.
    pub ord: usize,
    /// Heading trail from the top of the document, outermost first.
    pub heading_path: Vec<String>,
    /// The section's own heading, if it has one.
    pub heading: String,
    /// Chunk text, excluding the heading line itself.
    pub text: String,
    /// Offset of `text` within the body (UTF-16 units), for anchoring back to the source.
    pub char_start: usize,
}

/// `/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/`, with JS `.` semantics (a line
/// ending in `\r` is therefore *not* a heading, as in the original).
static ATX_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^(#{1,6})[ \t]+(<DOT>+?)[ \t]*#*[ \t]*$"));

struct Section {
    heading: String,
    heading_path: Vec<String>,
    body: String,
    char_start: usize,
}

/// Split a body into sections at ATX headings.
///
/// Headings inside fenced code are ignored: a shell comment starting with `#`
/// would otherwise shred a code block into fragments.
fn split_sections(body: &str) -> Vec<Section> {
    let masked = mask_code(body);
    let lines: Vec<&str> = body.split('\n').collect();
    let masked_lines: Vec<&str> = masked.split('\n').collect();

    let mut sections: Vec<Section> = Vec::new();
    let mut trail: Vec<(usize, String)> = Vec::new();

    let mut current = Section {
        heading: String::new(),
        heading_path: vec![],
        body: String::new(),
        char_start: 0,
    };
    let mut offset = 0usize;
    let mut buffer: Vec<&str> = Vec::new();

    fn flush(current: &mut Section, buffer: &mut Vec<&str>, sections: &mut Vec<Section>) {
        current.body = buffer.join("\n");
        if !js_trim(&current.body).is_empty() || !current.heading.is_empty() {
            sections.push(Section {
                heading: current.heading.clone(),
                heading_path: current.heading_path.clone(),
                body: current.body.clone(),
                char_start: current.char_start,
            });
        }
        buffer.clear();
    }

    for (i, line) in lines.iter().enumerate() {
        let masked_match = masked_lines.get(i).and_then(|l| ATX_HEADING_RE.captures(l));

        if let Some(masked_caps) = masked_match {
            flush(&mut current, &mut buffer, &mut sections);
            let level = masked_caps[1].len();
            // The real heading text comes from the unmasked line; the masked
            // copy is only used to decide *whether* this line is a heading.
            let heading = js_trim(
                ATX_HEADING_RE
                    .captures(line)
                    .and_then(|c| c.get(2))
                    .map_or_else(
                        || masked_caps.get(2).map_or("", |m| m.as_str()),
                        |m| m.as_str(),
                    ),
            )
            .to_string();

            while trail.last().is_some_and(|(l, _)| *l >= level) {
                trail.pop();
            }
            trail.push((level, heading.clone()));

            current = Section {
                heading,
                heading_path: trail.iter().map(|(_, h)| h.clone()).collect(),
                body: String::new(),
                char_start: offset + utf16_len(line) + 1,
            };
        } else {
            buffer.push(line);
        }

        offset += utf16_len(line) + 1;
    }

    flush(&mut current, &mut buffer, &mut sections);
    sections
}

/// `text.split(/\n{2,}/)` over UTF-16 units.
fn split_paragraphs(text: &[u16]) -> Vec<&[u16]> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < text.len() {
        if text[i] == 0x0A {
            let run_end = text[i..]
                .iter()
                .position(|&u| u != 0x0A)
                .map_or(text.len(), |n| i + n);
            if run_end - i >= 2 {
                parts.push(&text[start..i]);
                start = run_end;
            }
            i = run_end;
        } else {
            i += 1;
        }
    }
    parts.push(&text[start..]);
    parts
}

/// Split an over-long section at paragraph boundaries, with a little overlap.
fn split_long_section(section: &Section) -> Vec<(String, usize)> {
    let text = to_utf16(&section.body);
    if text.len() <= MAX_CHUNK_CHARS {
        return vec![(section.body.clone(), section.char_start)];
    }

    let mut parts: Vec<(String, usize)> = Vec::new();
    let paragraphs = split_paragraphs(&text);

    let mut buffer: Vec<u16> = Vec::new();
    let mut buffer_start: usize = 0;
    let mut cursor: usize = 0;

    for paragraph in paragraphs {
        let at = index_of16(&text, paragraph, cursor).unwrap_or(cursor);
        cursor = at + paragraph.len();

        if !buffer.is_empty() && buffer.len() + paragraph.len() > MAX_CHUNK_CHARS {
            parts.push((from_utf16(&buffer), section.char_start + buffer_start));
            let tail_from = buffer.len().saturating_sub(CHUNK_OVERLAP_CHARS);
            let tail: Vec<u16> = buffer[tail_from..].to_vec();
            buffer = [&tail[..], &[0x0A, 0x0A], paragraph].concat();
            buffer_start = (at as i64 - tail.len() as i64 - 2).max(0) as usize;
            continue;
        }

        if buffer.is_empty() {
            buffer_start = at;
        }
        buffer = if buffer.is_empty() {
            paragraph.to_vec()
        } else {
            [&buffer[..], &[0x0A, 0x0A], paragraph].concat()
        };
    }

    if !trim16(&buffer).is_empty() {
        parts.push((from_utf16(&buffer), section.char_start + buffer_start));
    }
    parts
}

/// Chunk a concept body.
///
/// A document with no headings yields a single chunk (or several, if it is
/// long), so short notes are never fragmented for no reason.
pub fn chunk_body(body: &str) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut ord = 0;

    for section in split_sections(body) {
        for (part_text, char_start) in split_long_section(&section) {
            let text = js_trim(&part_text);
            if text.is_empty() {
                continue;
            }
            chunks.push(Chunk {
                ord,
                heading_path: section.heading_path.clone(),
                heading: section.heading.clone(),
                text: text.to_string(),
                char_start,
            });
            ord += 1;
        }
    }

    chunks
}

/// Stable id for a chunk within a document.
pub fn chunk_id(doc_id: &str, ord: usize) -> String {
    format!("{doc_id}#{ord}")
}

/// Human-readable location, e.g. `topics/note › Setup › Windows`.
pub fn chunk_label(doc_id: &str, heading_path: &[String]) -> String {
    let mut parts = vec![doc_id];
    parts.extend(heading_path.iter().map(String::as_str));
    parts.join(" › ")
}

/// A citation anchor: `topics/note.md#heading-slug`, matching the anchor a
/// Markdown renderer generates, so the reference resolves in other tools too.
pub fn chunk_anchor(doc_id: &str, heading: &str) -> String {
    if heading.is_empty() {
        return format!("{doc_id}.md");
    }
    format!("{doc_id}.md#{}", slugify_heading(heading))
}

static SLUG_STRIP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[`*_~\[\]()]").unwrap());
static SLUG_DISALLOWED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}-]").unwrap());
static SLUG_WS_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"<S>+"));
static SLUG_DASHES_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-+").unwrap());

pub fn slugify_heading(heading: &str) -> String {
    let lower = heading.to_lowercase();
    let stripped = SLUG_STRIP_RE.replace_all(&lower, "");
    let dashed = SLUG_WS_RE.replace_all(&stripped, "-");
    let allowed = SLUG_DISALLOWED_RE.replace_all(&dashed, "");
    let collapsed = SLUG_DASHES_RE.replace_all(&allowed, "-");
    let no_head = collapsed.strip_prefix('-').unwrap_or(&collapsed);
    no_head.strip_suffix('-').unwrap_or(no_head).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> String {
        [
            "Intro paragraph.",
            "",
            "## Setup",
            "",
            "Install it.",
            "",
            "### Windows",
            "",
            "Use the installer.",
            "",
            "## Usage",
            "",
            "Run it.",
        ]
        .join("\n")
    }

    #[test]
    fn splits_at_headings_and_records_the_heading_path() {
        let chunks = chunk_body(&doc());
        let headings: Vec<&str> = chunks.iter().map(|c| c.heading.as_str()).collect();
        assert_eq!(headings, ["", "Setup", "Windows", "Usage"]);
        assert_eq!(chunks[2].heading_path, ["Setup", "Windows"]);
        assert_eq!(chunks[3].heading_path, ["Usage"]);
    }

    #[test]
    fn chunk_text_excludes_the_heading_line() {
        assert_eq!(chunk_body(&doc())[1].text, "Install it.");
    }

    #[test]
    fn a_document_without_headings_stays_one_chunk() {
        let chunks = chunk_body("Just a short note.");
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].heading_path.is_empty());
    }

    #[test]
    fn headings_inside_fenced_code_do_not_split_the_document() {
        let chunks = chunk_body("Text\n\n```sh\n# not a heading\necho hi\n```\n\nMore");
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn an_over_long_section_is_split_into_several_chunks() {
        let long: Vec<String> = (0..40)
            .map(|i| format!("Paragraph {i} {}", "word ".repeat(20)))
            .collect();
        let chunks = chunk_body(&format!("## Big\n\n{}", long.join("\n\n")));
        assert!(chunks.len() > 1);
        // Every chunk keeps the heading it came from, so context is never lost.
        assert!(chunks.iter().all(|c| c.heading == "Big"));
    }

    #[test]
    fn empty_input_yields_no_chunks() {
        assert!(chunk_body("   \n\n  ").is_empty());
    }

    #[test]
    fn char_start_points_at_the_section_body_in_utf16_units() {
        // "日本😀\n" is 5 UTF-16 units (日, 本, 😀 x2, \n); the heading line is
        // "## A" (4) + newline, so the body starts at 5 + 5 = 10.
        let chunks = chunk_body("日本😀\n## A\nbody");
        assert_eq!(chunks[1].char_start, 5 + 5);
        assert_eq!(chunks[0].char_start, 0);
    }

    #[test]
    fn continuation_chunks_overlap_by_the_configured_tail() {
        let para = |c: char| c.to_string().repeat(700);
        let body = format!("{}\n\n{}", para('a'), para('b'));
        let chunks = chunk_body(&body);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].text, para('a'));
        // 120 trailing units of the previous chunk + "\n\n" + the paragraph.
        assert_eq!(
            chunks[1].text,
            format!("{}\n\n{}", "a".repeat(120), para('b'))
        );
        assert_eq!(chunks[1].char_start, 702 - 120 - 2);
    }

    #[test]
    fn crlf_heading_lines_are_not_headings_like_the_original() {
        // JS `.` does not match `\r`, so `# Title\r` fails the heading regex.
        let chunks = chunk_body("# Title\r\nbody");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].heading, "");
    }

    #[test]
    fn closing_hashes_are_not_part_of_the_heading() {
        let chunks = chunk_body("## Setup ##\ntext");
        assert_eq!(chunks[0].heading, "Setup");
    }

    #[test]
    fn ids_labels_and_anchors() {
        assert_eq!(chunk_id("topics/note", 3), "topics/note#3");
        assert_eq!(
            chunk_label("topics/note", &["Setup".to_string(), "Windows".to_string()]),
            "topics/note › Setup › Windows"
        );
    }

    #[test]
    fn slugs_match_common_markdown_anchor_rules() {
        assert_eq!(slugify_heading("Getting Started"), "getting-started");
        assert_eq!(slugify_heading("`code` and *stars*"), "code-and-stars");
        assert_eq!(slugify_heading("設計 原則"), "設計-原則");
        assert_eq!(slugify_heading("-- a --"), "a");
    }

    #[test]
    fn anchor_falls_back_to_the_file_when_there_is_no_heading() {
        assert_eq!(chunk_anchor("topics/note", ""), "topics/note.md");
        assert_eq!(chunk_anchor("topics/note", "Setup"), "topics/note.md#setup");
    }
}
