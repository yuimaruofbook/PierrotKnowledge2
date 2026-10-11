//! Retrieval: turning a query into context an agent can actually use
//! (`src/bun/rag/retrieve.ts`).
//!
//! `search` answers "which pages match". Retrieval answers "what should I put
//! in the model's context": passages are deduplicated, kept within a budget,
//! and carry a citation so the answer can be traced back to a file.
//!
//! Lengths and budgets are counted in UTF-16 code units, as JS `.length`.

use std::collections::{HashMap, HashSet};

use crate::rag::fts::{FtsIndex, FtsResult, SearchOptions};
use crate::shared::js_compat::{
    from_utf16, index_of16, is_js_space16, slice16, to_utf16, utf16_len,
};
use crate::shared::okf::{
    chunk_anchor, is_content_token, normalize_for_index, parse_query_terms, QueryMode,
};
use crate::shared::types::{
    ChunkHit, LinkedFile, RetrievalResult, RetrievedPassage, SearchFilters,
};

/// Default character budget (UTF-16 units; deliberately not tokens).
pub const DEFAULT_BUDGET_CHARS: i64 = 6000;

/// Cap on passages taken from any one document.
const MAX_PASSAGES_PER_DOC: usize = 3;

/// Content tokens a passage must share with the query to be kept.
const DEFAULT_MIN_CONTENT_MATCHES: i64 = 2;

#[derive(Debug, Clone, Default)]
pub struct RetrieveOptions {
    pub filters: SearchFilters,
    /// Maximum passages to return (default 8, clamped to 1..=50).
    pub limit: Option<i64>,
    /// Character budget across all passages (default [`DEFAULT_BUDGET_CHARS`]).
    pub budget_chars: Option<i64>,
    /// Include neighbouring chunks of a hit for continuity.
    pub expand_neighbours: bool,
    /// Content tokens a passage must share with the query (default 2).
    pub min_content_matches: Option<i64>,
    /// Links to follow from the retrieved files (0-2). Applied by
    /// `Workspace::retrieve`, which has the link graph; the index-level
    /// function ignores it.
    pub link_depth: Option<i64>,
}

/// Retrieve passages for a query.
///
/// Chunks are ranked individually but capped per document, which keeps a long
/// page from crowding out a short one that answers the question better.
pub fn retrieve(
    index: &FtsIndex,
    query: &str,
    options: &RetrieveOptions,
) -> FtsResult<RetrievalResult> {
    let limit = options.limit.unwrap_or(8).clamp(1, 50);
    // An explicit budget is honoured as given.
    let budget = options.budget_chars.unwrap_or(DEFAULT_BUDGET_CHARS).max(1) as usize;

    let mut filters = SearchFilters::default();
    if let Some(t) = options.filters.r#type.as_ref().filter(|t| !t.is_empty()) {
        filters.r#type = Some(t.clone());
    }
    if let Some(tags) = options.filters.tags.as_ref().filter(|t| !t.is_empty()) {
        filters.tags = Some(tags.clone());
    }
    if let Some(p) = options.filters.path_prefix.as_ref().filter(|p| !p.is_empty()) {
        filters.path_prefix = Some(p.clone());
    }
    if options.filters.include_dead == Some(true) {
        filters.include_dead = Some(true);
    }
    filters.para_depth = options.filters.para_depth;

    let empty = || RetrievalResult {
        query: query.to_string(),
        passages: Vec::new(),
        linked: None,
        used_chars: 0,
        truncated: false,
    };

    // Retrieval takes a question, not a term: loose matching keeps recall up and
    // lets BM25 decide which passages actually answer it.
    let hits = index.search_chunks(
        query,
        &SearchOptions {
            filters,
            limit: Some(limit * 4),
            group_by_document: false,
            mode: Some(QueryMode::Loose),
        },
    )?;
    if hits.is_empty() {
        return Ok(empty());
    }

    let relevant = filter_by_coverage(
        hits,
        query,
        options
            .min_content_matches
            .unwrap_or(DEFAULT_MIN_CONTENT_MATCHES),
    );
    if relevant.is_empty() {
        return Ok(empty());
    }

    let selected = select_passages(relevant, limit as usize);
    let expanded = if options.expand_neighbours {
        with_neighbours(index, selected)?
    } else {
        selected
    };

    let mut passages = Vec::new();
    let mut used_chars = 0usize;
    let mut truncated = false;

    for hit in expanded {
        if budget <= used_chars {
            truncated = true;
            break;
        }
        let remaining = budget - used_chars;

        // Trim at a paragraph edge rather than mid-sentence when the budget bites.
        let full_len = utf16_len(&hit.text);
        let text = if full_len <= remaining {
            hit.text.clone()
        } else {
            trim_to_budget(&hit.text, remaining)
        };
        let text_len = utf16_len(&text);
        if text_len < full_len {
            truncated = true;
        }
        if text.is_empty() {
            truncated = true;
            break;
        }

        let heading = hit.hit.heading_path.last().map_or("", String::as_str);
        passages.push(RetrievedPassage {
            anchor: chunk_anchor(&hit.hit.id, heading),
            id: hit.hit.id,
            path: hit.hit.path,
            title: hit.hit.title,
            r#type: hit.hit.r#type,
            heading_path: hit.hit.heading_path,
            text,
            score: hit.hit.score,
        });
        used_chars += text_len;
    }

    Ok(RetrievalResult {
        query: query.to_string(),
        passages,
        linked: None,
        used_chars: used_chars as u64,
        truncated,
    })
}

/// Drop passages that share too little with the query, measured over the same
/// normalised content tokens the index uses.
fn filter_by_coverage(hits: Vec<ChunkHit>, query: &str, min_matches: i64) -> Vec<ChunkHit> {
    if min_matches <= 0 {
        return hits;
    }

    let mut wanted: Vec<String> = Vec::new();
    let mut wanted_set: HashSet<String> = HashSet::new();
    for term in parse_query_terms(query) {
        for token in term.tokens {
            if is_content_token(&token) && wanted_set.insert(token.clone()) {
                wanted.push(token);
            }
        }
    }
    // A query of pure grammar has nothing to check against; let BM25 decide.
    if wanted.is_empty() {
        return hits;
    }

    let needed = (min_matches as usize).min(wanted.len());

    hits.into_iter()
        .filter(|hit| {
            let heading = hit.hit.heading_path.join(" ");
            let joined = [hit.hit.title.as_str(), heading.as_str(), hit.text.as_str()]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" ");
            let normalized = normalize_for_index(&joined);
            let haystack: HashSet<&str> = normalized.split(' ').collect();
            let mut found = 0;
            for token in &wanted {
                if haystack.contains(token.as_str()) {
                    found += 1;
                }
                if found >= needed {
                    return true;
                }
            }
            false
        })
        .collect()
}

fn select_passages(hits: Vec<ChunkHit>, limit: usize) -> Vec<ChunkHit> {
    let mut per_doc: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();

    for hit in hits {
        let taken = per_doc.entry(hit.hit.id.clone()).or_insert(0);
        if *taken >= MAX_PASSAGES_PER_DOC {
            continue;
        }
        *taken += 1;
        out.push(hit);
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// Pull in the chunk on either side of each hit, restoring enough continuity
/// for a model to read the passage as prose rather than a fragment.
fn with_neighbours(index: &FtsIndex, hits: Vec<ChunkHit>) -> FtsResult<Vec<ChunkHit>> {
    let mut seen: HashSet<String> = hits.iter().map(|h| h.chunk_id.clone()).collect();
    let mut out = Vec::new();

    for hit in hits {
        let siblings = index.chunks_of(&hit.hit.id)?;
        let Some(at) = siblings.iter().position(|c| c.chunk_id == hit.chunk_id) else {
            out.push(hit);
            continue;
        };

        let score = hit.hit.score;
        for offset in [-1i64, 0, 1] {
            let i = at as i64 + offset;
            if i < 0 || i as usize >= siblings.len() {
                continue;
            }
            let sibling = &siblings[i as usize];
            if offset != 0 && seen.contains(&sibling.chunk_id) {
                continue;
            }
            seen.insert(sibling.chunk_id.clone());
            if offset == 0 {
                out.push(hit.clone());
            } else {
                let mut copy = sibling.clone();
                copy.hit.score = score;
                out.push(copy);
            }
        }
    }
    Ok(out)
}

/// JS `lastIndexOf` over UTF-16 units; `-1` when absent.
fn last_index_of16(haystack: &[u16], needle: &[u16]) -> i64 {
    let mut found = -1i64;
    let mut from = 0usize;
    while let Some(i) = index_of16(haystack, needle, from) {
        found = i as i64;
        from = i + 1;
        if from > haystack.len() {
            break;
        }
    }
    found
}

fn trim_to_budget(text: &str, budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    let units = to_utf16(text);
    let slice = slice16(&units, 0, budget);
    let break_at = [
        last_index_of16(slice, &to_utf16("\n\n")),
        last_index_of16(slice, &to_utf16("。")),
        last_index_of16(slice, &to_utf16(". ")),
    ]
    .into_iter()
    .max()
    .unwrap_or(-1);
    // Only honour the break if it keeps most of the budget; otherwise a single
    // long paragraph would be discarded entirely.
    let end = if (break_at as f64) > budget as f64 * 0.5 {
        break_at as usize
    } else {
        slice.len()
    };
    let mut cut = &slice[..end];
    while let Some(&last) = cut.last() {
        if is_js_space16(last) {
            cut = &cut[..cut.len() - 1];
        } else {
            break;
        }
    }
    from_utf16(cut)
}

/// Human-readable location of a passage.
///
/// A document's H1 usually repeats its frontmatter title, which would render as
/// "検索の仕組み › 検索の仕組み › 日本語対応"; consecutive duplicates collapse.
pub fn passage_location(passage: &RetrievedPassage) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in std::iter::once(passage.title.as_str())
        .chain(passage.heading_path.iter().map(String::as_str))
    {
        if !segment.is_empty() && Some(&segment) != parts.last() {
            parts.push(segment);
        }
    }
    parts.join(" › ")
}

/// Render the files reached by following links: path, title and the one-line
/// description, with the hop count and the file each came from so the chain
/// can be walked back. Shared by retrieval and context packs.
pub fn format_linked(linked: &[LinkedFile]) -> String {
    let mut lines = vec![
        "## Linked files (descriptions only - read_file to open one)".to_string(),
        String::new(),
    ];
    for file in linked {
        let description = match file.description.as_deref().filter(|d| !d.is_empty()) {
            Some(d) => format!(": {d}"),
            None => String::new(),
        };
        lines.push(format!(
            "- `{}` — {} ({}) · hop {} from `{}`{description}",
            file.path, file.title, file.r#type, file.hops, file.from
        ));
    }
    lines.join("\n")
}

/// Render a retrieval result as Markdown for an agent.
pub fn format_retrieval(result: &RetrievalResult) -> String {
    if result.passages.is_empty() {
        return format!("No passages found for: {}", result.query);
    }

    let parts: Vec<String> = result
        .passages
        .iter()
        .map(|passage| {
            [
                format!("### {}", passage_location(passage)),
                format!(
                    "source: `{}` · anchor: `{}` · type: {}",
                    passage.path, passage.anchor, passage.r#type
                ),
                String::new(),
                passage.text.clone(),
            ]
            .join("\n")
        })
        .collect();

    let header = format!(
        "Retrieved {} passage(s) for: {}",
        result.passages.len(),
        result.query
    );
    let linked = match result.linked.as_deref().filter(|l| !l.is_empty()) {
        Some(linked) => format!("\n\n{}", format_linked(linked)),
        None => String::new(),
    };
    let footer = if result.truncated {
        "\n\n_(truncated to fit the context budget — narrow the query or raise budget_chars for more)_"
    } else {
        ""
    };

    format!("{header}\n\n{}{linked}{footer}", parts.join("\n\n---\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rag::fts::testutil::open_corpus;

    fn go(i: &FtsIndex, q: &str, o: &RetrieveOptions) -> RetrievalResult {
        retrieve(i, q, o).unwrap()
    }

    #[test]
    fn returns_sections_with_anchors() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let r = go(&i, "チャンク分割の方法", &Default::default());
        let p = &r.passages[0];
        assert!(p.anchor.contains(".md#"));
        assert_eq!(p.path, "wiki/rag.md");
        assert!(p.text.contains("見出し"));
    }

    #[test]
    fn budget_is_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let generous = go(&i, "設計", &Default::default());
        assert!(generous.used_chars > 0);
        assert!(!generous.truncated);
        let cap = generous.used_chars / 2;
        let capped = go(
            &i,
            "設計",
            &RetrieveOptions {
                budget_chars: Some(cap as i64),
                ..Default::default()
            },
        );
        assert!(capped.used_chars <= cap);
        assert!(capped.truncated);
    }

    #[test]
    fn per_doc_cap_and_filters() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let r = go(
            &i,
            "設計",
            &RetrieveOptions {
                limit: Some(10),
                ..Default::default()
            },
        );
        let mut per: HashMap<&str, usize> = HashMap::new();
        for p in &r.passages {
            *per.entry(&p.id).or_default() += 1;
        }
        assert!(per.values().all(|n| *n <= 3));

        let r = go(
            &i,
            "分割",
            &RetrieveOptions {
                filters: SearchFilters {
                    r#type: Some("Playbook".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        assert!(r.passages.iter().all(|p| p.r#type == "Playbook"));
    }

    #[test]
    fn empty_and_nonsense_results() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let r = go(&i, "まったく存在しない語句xyzzy", &Default::default());
        assert!(r.passages.is_empty());
        assert!(format_retrieval(&r).contains("No passages found"));
    }

    #[test]
    fn formats_with_source_and_anchor() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let text = format_retrieval(&go(&i, "BM25", &Default::default()));
        assert!(text.contains("wiki/rag.md"));
        assert!(text.contains("anchor:"));
    }

    #[test]
    fn natural_language_questions() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let r = go(&i, "チャンクはどう分割している？", &Default::default());
        assert!(r.passages.iter().any(|p| p.id == "rag"));
        let r = go(&i, "how does the app stay small?", &Default::default());
        assert!(r.passages.iter().any(|p| p.id == "english"));
    }

    #[test]
    fn location_collapses_repeated_title() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let r = go(&i, "チャンク分割", &Default::default());
        assert_eq!(passage_location(&r.passages[0]), "RAG構成 › チャンク分割");
    }

    #[test]
    fn neighbour_expansion_adds_sections() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let one = RetrieveOptions {
            limit: Some(1),
            ..Default::default()
        };
        let plain = go(&i, "チャンク分割", &one);
        let expanded = go(
            &i,
            "チャンク分割",
            &RetrieveOptions {
                expand_neighbours: true,
                ..one
            },
        );
        assert!(expanded.passages.len() > plain.passages.len());
    }

    #[test]
    fn trim_to_budget_prefers_paragraph_edge() {
        let t = "あいうえお。かきくけこ。さしすせそ";
        assert_eq!(trim_to_budget(t, 13), "あいうえお。かきくけこ");
        assert_eq!(trim_to_budget("abcdefghij", 4), "abcd");
    }
}
