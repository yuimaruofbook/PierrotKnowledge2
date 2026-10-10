//! Subsequence fuzzy matching, for the quick switcher and link autocomplete
//! (`src/shared/fuzzy.ts`).
//!
//! Matching runs over UTF-16 units to reproduce the JS offsets (`indexOf`,
//! `at = found + 1`) and the `text.length` tie-break exactly.

use super::js_compat::{index_of16, to_utf16, utf16_len};

/// Default result cap of `rankByFuzzy`.
pub const DEFAULT_RANK_LIMIT: usize = 50;

/// Score `text` against `query`, or `None` when the query is not a subsequence.
///
/// Returning `None` rather than a low score means non-matches are filtered out
/// instead of being ranked to the bottom of a long list.
pub fn fuzzy_score(text: &str, query: &str) -> Option<f64> {
    if query.is_empty() {
        return Some(0.0);
    }

    let haystack = to_utf16(&text.to_lowercase());
    let needle = query.to_lowercase();

    let mut score: i64 = 0;
    let mut at: usize = 0;
    let mut run: i64 = 0;
    let mut buf = [0u16; 2];

    for ch in needle.chars() {
        if ch == ' ' {
            continue;
        }
        let units: &[u16] = ch.encode_utf16(&mut buf);
        let found = index_of16(&haystack, units, at)?;

        // Reward adjacency: a contiguous run is far more likely to be what was meant.
        if found == at && at > 0 {
            run += 1;
        } else {
            run = 0;
        }
        score += 1 + run * 2;

        // Reward landing on a word or path boundary.
        let boundary = found == 0 || matches!(haystack[found - 1], 0x2F | 0x2D | 0x20); // '/', '-', ' '
        if boundary {
            score += 3;
        }

        at = found + 1;
    }

    // Break ties towards shorter targets.
    Some(score as f64 - utf16_len(text) as f64 * 0.01)
}

/// Rank items by the best score across several projections of each.
///
/// Stable, like JS `Array.prototype.sort`, so equal scores keep input order.
pub fn rank_by_fuzzy<'a, T>(
    items: &'a [T],
    query: &str,
    fields: impl Fn(&T) -> Vec<String>,
    limit: usize,
) -> Vec<&'a T> {
    let mut ranked: Vec<(&T, f64)> = Vec::new();

    for item in items {
        let best = fields(item)
            .iter()
            .filter_map(|field| fuzzy_score(field, query))
            .fold(f64::NEG_INFINITY, f64::max);
        if best > f64::NEG_INFINITY {
            ranked.push((item, best));
        }
    }

    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked
        .into_iter()
        .take(limit)
        .map(|(item, _)| item)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- ported from test/keymap.test.ts ("fuzzyScore") ----

    #[test]
    fn matches_a_subsequence() {
        assert!(fuzzy_score("topics/design", "tdes").is_some());
    }

    #[test]
    fn rejects_a_non_subsequence() {
        assert_eq!(fuzzy_score("topics/design", "zzz"), None);
    }

    #[test]
    fn prefers_contiguous_matches() {
        let contiguous = fuzzy_score("design", "des").unwrap();
        let scattered = fuzzy_score("d-e-s-ign", "des").unwrap();
        assert!(contiguous > scattered);
    }

    #[test]
    fn prefers_a_shorter_target_on_a_tie() {
        assert!(fuzzy_score("abc", "abc").unwrap() > fuzzy_score("abcdefghij", "abc").unwrap());
    }

    #[test]
    fn is_case_insensitive() {
        assert!(fuzzy_score("Design", "des").is_some());
    }

    #[test]
    fn empty_query_scores_zero() {
        assert_eq!(fuzzy_score("anything", ""), Some(0.0));
    }

    #[test]
    fn non_subsequence_is_none() {
        assert_eq!(fuzzy_score("abc", "acb"), None);
    }

    #[test]
    fn adjacency_and_boundaries_are_rewarded() {
        // a(1+3 boundary) then b adjacent: run=1 -> 1+2 ; text length 2 -> -0.02
        let s = fuzzy_score("ab", "ab").unwrap();
        assert!((s - (4.0 + 3.0 - 0.02)).abs() < 1e-9, "{s}");
        // Shorter targets win ties.
        assert!(fuzzy_score("ab", "a").unwrap() > fuzzy_score("abcdef", "a").unwrap());
    }

    #[test]
    fn ranks_and_limits() {
        let items = vec!["topics/alpha", "beta", "alphabet"];
        let ranked = rank_by_fuzzy(&items, "alp", |s| vec![s.to_string()], 50);
        assert_eq!(ranked.len(), 2);
        // Both start a word; the shorter target wins the tie-break.
        assert_eq!(*ranked[0], "alphabet");
        assert_eq!(
            rank_by_fuzzy(&items, "alp", |s| vec![s.to_string()], 1).len(),
            1
        );
    }
}
