//! Text normalisation for search (`src/shared/okf/text.ts`).
//!
//! SQLite's `unicode61` tokenizer cannot segment Japanese and `trigram` cannot
//! match anything shorter than three characters, so CJK runs are expanded into
//! overlapping bigrams at index time and query time both.
//!
//! [`Highlight`] offsets are **UTF-16 code units** into the (whitespace
//! collapsed) text, exactly as in JS, and [`make_snippet`] widths are UTF-16
//! units too.

use crate::shared::js_compat::{
    from_utf16, index_of16, is_js_space, js_regex, js_trim, slice16, to_utf16, utf16_len,
};
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::LazyLock;

/// Characters that need n-gram treatment: kana, kanji, and the CJK extensions.
/// Deliberately excludes CJK punctuation (U+3000..U+303F), which should
/// separate words rather than join them.
fn is_cjk_char(c: char) -> bool {
    matches!(
        c as u32,
        0x3040..=0x309f // hiragana
        | 0x30a0..=0x30ff // katakana
        | 0x31f0..=0x31ff // katakana phonetic extensions
        | 0x3400..=0x4dbf // CJK extension A
        | 0x4e00..=0x9fff // CJK unified ideographs
        | 0xf900..=0xfaff // CJK compatibility ideographs
        | 0xff66..=0xff9f // halfwidth katakana
    )
}

/// `isCjk(char)`: whether a single character is kana or kanji.
pub fn is_cjk(c: char) -> bool {
    is_cjk_char(c)
}

pub fn contains_cjk(text: &str) -> bool {
    text.chars().any(is_cjk_char)
}

/// Overlapping bigrams of a CJK run; a single character is emitted as itself.
///
/// Works in UTF-16 units like the original; CJK characters are all in the BMP,
/// so for the intended input this is the same as slicing by `char`.
pub fn bigrams(run: &str) -> Vec<String> {
    let units = to_utf16(run);
    if units.len() <= 1 {
        return if units.is_empty() {
            vec![]
        } else {
            vec![run.to_string()]
        };
    }
    (0..units.len() - 1)
        .map(|i| from_utf16(&units[i..i + 2]))
        .collect()
}

static NON_ALNUM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());

/// Convert text into the form actually stored in the FTS index.
///
/// Latin text passes through lowercased and is tokenised normally; CJK runs
/// become space-separated bigrams. Everything that is not a letter or number
/// becomes a separator, mirroring what `unicode61` does when it tokenizes, so a
/// query token never keeps a trailing `?` or `,` that the indexed word lacks.
pub fn normalize_for_index(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let lower = text.to_lowercase();

    let mut expanded = String::with_capacity(lower.len() * 2);
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if !run.is_empty() {
            out.push(' ');
            out.push_str(&bigrams(run).join(" "));
            out.push(' ');
            run.clear();
        }
    };
    for c in lower.chars() {
        if is_cjk_char(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut expanded);
            expanded.push(c);
        }
    }
    flush(&mut run, &mut expanded);

    NON_ALNUM_RE
        .replace_all(&expanded, " ")
        .trim_matches(' ')
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QueryTerm {
    /// The term as the user typed it, for highlighting.
    pub raw: String,
    /// FTS5 tokens this term expands to.
    pub tokens: Vec<String>,
    pub cjk: bool,
}

static QUERY_TERM_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r#""([^"]+)"|(<NS>+)"#));

/// Split user input into terms, keeping quoted phrases together.
pub fn parse_query_terms(query: &str) -> Vec<QueryTerm> {
    let mut terms = Vec::new();
    for caps in QUERY_TERM_RE.captures_iter(query) {
        let raw = js_trim(
            caps.get(1)
                .or_else(|| caps.get(2))
                .map_or("", |m| m.as_str()),
        );
        if raw.is_empty() {
            continue;
        }
        let cjk = contains_cjk(raw);
        let tokens: Vec<String> = normalize_for_index(raw)
            .split(' ')
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .collect();
        if !tokens.is_empty() {
            terms.push(QueryTerm {
                raw: raw.to_string(),
                tokens,
                cjk,
            });
        }
    }
    terms
}

/// How strictly a query should be interpreted.
///
/// `Phrase`: every term must appear, and a multi-bigram term must appear
/// contiguously. Right for *locating* a page from a term you know.
///
/// `Loose`: any token may match, with BM25 doing the ranking. Right for
/// *retrieval*, where the input is a natural-language question.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum QueryMode {
    #[default]
    Phrase,
    Loose,
}

/// Build an FTS5 MATCH expression.
///
/// Every token is quoted, which neutralises the FTS5 operators (`NEAR`, `OR`,
/// `-`, `:`). A single CJK character has no bigram to match, so it becomes a
/// prefix query against the bigrams that start with it. Token length checks use
/// UTF-16 length, as JS `.length`.
pub fn build_match_query(query: &str, mode: QueryMode) -> Option<String> {
    let terms = parse_query_terms(query);
    if terms.is_empty() {
        return None;
    }

    if mode == QueryMode::Loose {
        // Every bigram becomes an independent clause. Recall comes from the OR;
        // precision comes from BM25 favouring documents that match more of them.
        let mut seen = HashSet::new();
        let mut clauses = Vec::new();
        for term in &terms {
            for token in &term.tokens {
                if seen.insert(token.as_str()) {
                    clauses.push(if utf16_len(token) == 1 {
                        format!("\"{token}\"*")
                    } else {
                        format!("\"{token}\"")
                    });
                }
            }
        }
        return if clauses.is_empty() {
            None
        } else {
            Some(clauses.join(" OR "))
        };
    }

    let mut clauses = Vec::new();
    for term in &terms {
        if term.cjk && term.tokens.len() == 1 && utf16_len(&term.tokens[0]) == 1 {
            clauses.push(format!("\"{}\"*", term.tokens[0]));
            continue;
        }
        // A multi-token term is a phrase: the bigrams must be adjacent, not
        // merely both present.
        if term.tokens.len() > 1 {
            clauses.push(format!("\"{}\"", term.tokens.join(" ")));
            continue;
        }
        clauses.push(format!("\"{}\"", term.tokens[0]));
    }
    Some(clauses.join(" AND "))
}

/// Whether a token carries meaning rather than grammar.
///
/// A bigram made only of hiragana is almost always particles or inflection
/// (はど, どう, てい, いる); counting those as evidence makes a long question
/// look mostly unmatched. Misfires on genuinely hiragana words like 「もの」,
/// which are low-information anyway.
pub fn is_content_token(token: &str) -> bool {
    // JS: /^[぀-ゟー]+$/ (an empty token is "content", as in JS).
    let hiragana_only = !token.is_empty()
        && token
            .chars()
            .all(|c| matches!(c as u32, 0x3040..=0x309f | 0x30fc));
    !hiragana_only
}

/// A span in UTF-16 code units, `end` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Highlight {
    pub start: usize,
    pub end: usize,
}

/// Locate query terms inside the original text, case-insensitively.
///
/// Offsets are found in the *lowercased* text and applied to the original, as
/// the TS does (they can drift for the few characters whose lowercase has a
/// different length).
pub fn find_highlights(text: &str, terms: &[QueryTerm]) -> Vec<Highlight> {
    let haystack = to_utf16(&text.to_lowercase());
    let mut spans = Vec::new();

    for term in terms {
        let needle = to_utf16(&term.raw.to_lowercase());
        if needle.is_empty() {
            continue;
        }
        let mut from = 0;
        while let Some(at) = index_of16(&haystack, &needle, from) {
            spans.push(Highlight {
                start: at,
                end: at + needle.len(),
            });
            from = at + needle.len();
            if spans.len() > 64 {
                break;
            }
        }
    }

    merge_spans(spans)
}

fn merge_spans(mut spans: Vec<Highlight>) -> Vec<Highlight> {
    if spans.is_empty() {
        return spans;
    }
    spans.sort_by_key(|s| s.start); // stable, like JS
    let mut merged = vec![spans[0]];
    for span in &spans[1..] {
        let last = merged.last_mut().expect("merged is never empty");
        if span.start <= last.end {
            last.end = last.end.max(span.end);
        } else {
            merged.push(*span);
        }
    }
    merged
}

#[derive(Debug, Clone, Default)]
pub struct SnippetOptions {
    /// UTF-16 units of context to show (default 160).
    pub width: Option<usize>,
    /// Marker inserted around matches (default U+0001 / U+0002, which the view
    /// turns into highlight tags).
    pub open: Option<String>,
    pub close: Option<String>,
    /// Default `…`.
    pub ellipsis: Option<String>,
}

/// Collapse every run of JS white space to one space, then trim.
fn flatten_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            in_space = true;
        } else {
            if in_space {
                out.push(' ');
                in_space = false;
            }
            out.push(c);
        }
    }
    if in_space {
        out.push(' ');
    }
    js_trim(&out).to_string()
}

/// Build a snippet centred on the first match.
///
/// Generated here rather than with SQLite's `snippet()` because the indexed text
/// is bigram-expanded, so `snippet()` would return a stream of bigrams instead
/// of readable prose.
pub fn make_snippet(text: &str, query: &str, options: &SnippetOptions) -> String {
    let width = options.width.unwrap_or(160);
    let open = options.open.as_deref().unwrap_or("\u{1}");
    let close = options.close.as_deref().unwrap_or("\u{2}");
    let ellipsis = options.ellipsis.as_deref().unwrap_or("…");

    let flat = flatten_whitespace(text);
    if flat.is_empty() {
        return String::new();
    }
    let flat16 = to_utf16(&flat);

    let spans = find_highlights(&flat, &parse_query_terms(query));
    if spans.is_empty() {
        return if flat16.len() <= width {
            flat
        } else {
            format!("{}{ellipsis}", from_utf16(slice16(&flat16, 0, width)))
        };
    }

    let first = spans[0];
    let pad = ((width as i64 - (first.end - first.start) as i64).div_euclid(2)).max(0) as usize;
    let start = first.start.saturating_sub(pad);
    let end = flat16.len().min(start + width);

    let mut out = String::new();
    let mut cursor = start;
    for span in &spans {
        if span.end <= start || span.start >= end {
            continue;
        }
        let from = span.start.max(start);
        let to = span.end.min(end);
        out.push_str(&from_utf16(slice16(&flat16, cursor, from)));
        out.push_str(open);
        out.push_str(&from_utf16(slice16(&flat16, from, to)));
        out.push_str(close);
        cursor = to;
    }
    out.push_str(&from_utf16(slice16(&flat16, cursor, end)));

    format!(
        "{}{out}{}",
        if start > 0 { ellipsis } else { "" },
        if end < flat16.len() { ellipsis } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(open: &str, close: &str, width: usize) -> SnippetOptions {
        SnippetOptions {
            width: Some(width),
            open: Some(open.into()),
            close: Some(close.into()),
            ellipsis: None,
        }
    }

    // ---- CJK detection ----

    #[test]
    fn recognises_kana_and_kanji_not_latin() {
        assert!(contains_cjk("軽量"));
        assert!(contains_cjk("ノート"));
        assert!(contains_cjk("ひらがな"));
        assert!(!contains_cjk("lightweight"));
        assert!(!contains_cjk(""));
    }

    // ---- bigrams ----

    #[test]
    fn produces_overlapping_pairs() {
        assert_eq!(bigrams("知識ベース"), ["知識", "識ベ", "ベー", "ース"]);
    }

    #[test]
    fn a_single_character_is_emitted_as_itself() {
        assert_eq!(bigrams("知"), ["知"]);
        assert!(bigrams("").is_empty());
    }

    // ---- normalizeForIndex ----

    #[test]
    fn expands_cjk_runs_and_lowercases_latin() {
        assert_eq!(normalize_for_index("知識ベース"), "知識 識ベ ベー ース");
        assert_eq!(normalize_for_index("Hello World"), "hello world");
    }

    #[test]
    fn keeps_mixed_text_usable_on_both_sides() {
        let out = normalize_for_index("RAG と知識ベース");
        assert!(out.contains("rag"));
        assert!(out.contains("知識"));
    }

    #[test]
    fn cjk_punctuation_separates_rather_than_joins() {
        // 「、」 must not produce a bigram spanning two unrelated words.
        assert!(!normalize_for_index("軽量、設計").contains("量設"));
    }

    #[test]
    fn punctuation_becomes_a_separator() {
        assert_eq!(normalize_for_index("What is OKF?, yes"), "what is okf yes");
    }

    // ---- buildMatchQuery ----

    #[test]
    fn returns_none_for_empty_input() {
        assert_eq!(build_match_query("   ", QueryMode::Phrase), None);
    }

    #[test]
    fn quotes_every_term_neutralising_fts5_operators() {
        let bare_op = Regex::new(r"(^|\s)(OR|NEAR|NOT)(\s|\()").unwrap();
        for query in ["\"", "a OR b", "NEAR(x", "-x", "a:b", "*"] {
            if let Some(m) = build_match_query(query, QueryMode::Phrase) {
                // `a OR b` becomes `"a" AND "or" AND "b"`: never a bare OR.
                assert!(!bare_op.is_match(&m), "{query:?} -> {m}");
            }
        }
    }

    #[test]
    fn a_two_character_japanese_word_becomes_one_bigram_phrase() {
        assert_eq!(
            build_match_query("軽量", QueryMode::Phrase).as_deref(),
            Some("\"軽量\"")
        );
    }

    #[test]
    fn a_longer_japanese_word_becomes_an_adjacency_phrase() {
        // A phrase, not AND: the bigrams must be adjacent.
        assert_eq!(
            build_match_query("知識ベース", QueryMode::Phrase).as_deref(),
            Some("\"知識 識ベ ベー ース\"")
        );
    }

    #[test]
    fn a_single_japanese_character_becomes_a_prefix_query() {
        assert_eq!(
            build_match_query("軽", QueryMode::Phrase).as_deref(),
            Some("\"軽\"*")
        );
    }

    #[test]
    fn multiple_terms_are_anded() {
        assert_eq!(
            build_match_query("軽量 設計", QueryMode::Phrase).as_deref(),
            Some("\"軽量\" AND \"設計\"")
        );
    }

    #[test]
    fn loose_mode_ors_every_distinct_token() {
        assert_eq!(
            build_match_query("知識 知識ベ", QueryMode::Loose).as_deref(),
            Some("\"知識\" OR \"識ベ\"")
        );
        assert_eq!(
            build_match_query("軽", QueryMode::Loose).as_deref(),
            Some("\"軽\"*")
        );
    }

    // ---- parseQueryTerms ----

    #[test]
    fn keeps_a_quoted_phrase_together() {
        let terms = parse_query_terms("\"hello world\" other");
        let raws: Vec<&str> = terms.iter().map(|t| t.raw.as_str()).collect();
        assert_eq!(raws, ["hello world", "other"]);
    }

    #[test]
    fn an_unterminated_quote_falls_back_to_a_bare_word() {
        let terms = parse_query_terms("\"abc def");
        let raws: Vec<&str> = terms.iter().map(|t| t.raw.as_str()).collect();
        assert_eq!(raws, ["\"abc", "def"]);
    }

    // ---- content tokens ----

    #[test]
    fn hiragana_only_tokens_are_not_content() {
        assert!(!is_content_token("はど"));
        assert!(!is_content_token("ー"));
        assert!(is_content_token("知識"));
        assert!(is_content_token("abc"));
    }

    // ---- makeSnippet ----

    #[test]
    fn centres_on_the_match_and_marks_it() {
        let text = format!("{} needle {}", "x".repeat(300), "y".repeat(300));
        let snippet = make_snippet(&text, "needle", &opts("<mark>", "</mark>", 80));
        assert!(snippet.contains("<mark>needle</mark>"));
        assert!(utf16_len(&snippet) < 140);
    }

    #[test]
    fn works_for_japanese() {
        let snippet = make_snippet("これは軽量なノートアプリです", "軽量", &opts("[", "]", 160));
        assert!(snippet.contains("[軽量]"));
    }

    #[test]
    fn falls_back_to_a_head_excerpt_when_nothing_matches() {
        assert_eq!(
            make_snippet("abc def", "zzz", &SnippetOptions::default()),
            "abc def"
        );
    }

    #[test]
    fn collapses_whitespace_so_a_snippet_stays_one_line() {
        assert!(!make_snippet("a\n\n  b", "a", &SnippetOptions::default()).contains('\n'));
    }

    #[test]
    fn default_markers_are_control_characters_the_view_turns_into_tags() {
        assert_eq!(
            make_snippet("hello needle world", "needle", &SnippetOptions::default()),
            "hello \u{1}needle\u{2} world"
        );
    }

    #[test]
    fn truncates_a_head_excerpt_with_an_ellipsis_in_utf16_units() {
        let text = "あ".repeat(200);
        let snippet = make_snippet(&text, "zzz", &SnippetOptions::default());
        assert_eq!(snippet, format!("{}…", "あ".repeat(160)));
    }

    #[test]
    fn offsets_count_utf16_units_for_astral_characters() {
        // "😀" is two UTF-16 units, so the span for "ab" starts at 3 ("😀 ").
        let spans = find_highlights("😀 ab", &parse_query_terms("ab"));
        assert_eq!(spans, vec![Highlight { start: 3, end: 5 }]);
    }

    #[test]
    fn overlapping_highlights_merge() {
        let spans = find_highlights("abcd", &parse_query_terms("\"abc\" \"bcd\""));
        assert_eq!(spans, vec![Highlight { start: 0, end: 4 }]);
    }
}
