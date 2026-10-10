//! Picking the right skill for a request, locally and for free
//! (`src/shared/okf/skill-rank.ts`).
//!
//! Descriptions are the one thing always in context, so their cost grows with
//! every skill added. Ranking here first means the agent sees a handful of
//! scored candidates instead of the whole catalogue, at no token cost.
//!
//! Scoring is BM25-shaped but deliberately simplified: a skill catalogue is tens
//! of documents, and what decides quality is CJK handling and field weighting,
//! not the saturation curve.

use super::text::{bigrams, contains_cjk, is_cjk};
use crate::shared::js_compat::locale_compare;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// What ranking needs to read from a skill.
pub trait Rankable {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn when(&self) -> &[String] {
        &[]
    }
    fn tags(&self) -> &[String] {
        &[]
    }
}

/// A plain implementation of [`Rankable`], mirroring the TS `RankableSkill`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RankableSkill {
    pub name: String,
    pub description: String,
    pub when: Vec<String>,
    pub tags: Vec<String>,
}

impl Rankable for RankableSkill {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn when(&self) -> &[String] {
        &self.when
    }
    fn tags(&self) -> &[String] {
        &self.tags
    }
}

impl Rankable for super::skill::SkillDocument {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn when(&self) -> &[String] {
        &self.when
    }
    fn tags(&self) -> &[String] {
        &self.tags
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RankedSkill<'a, T> {
    pub skill: &'a T,
    pub score: f64,
    /// Query terms that actually matched, so a choice can be explained.
    pub matched: Vec<String>,
}

/// Field weights.
///
/// `when` outranks `description` on purpose: `when` is written as the words a
/// *request* would use, whereas a description is written to be read. A hit on
/// the vocabulary someone actually typed is stronger evidence than a hit on
/// explanatory prose.
const WEIGHT_NAME: f64 = 6.0;
const WEIGHT_WHEN: f64 = 4.0;
const WEIGHT_TAG: f64 = 3.0;
const WEIGHT_DESCRIPTION: f64 = 1.0;

/// Saturation: the fourth mention of a term says little the first did not.
const K1: f64 = 1.2;

static SPLIT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());

/// Split text into comparable terms.
///
/// Latin words are lowercased whole; CJK runs become overlapping bigrams, the
/// same trick the full-text index uses, so `知識ベース` matches inside
/// `知識ベースの設計` without a morphological analyser.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut cjk_run = String::new();
    let mut latin_run = String::new();

    fn flush_cjk(run: &mut String, terms: &mut Vec<String>) {
        if !run.is_empty() {
            terms.extend(bigrams(run));
            run.clear();
        }
    }
    fn flush_latin(run: &mut String, terms: &mut Vec<String>) {
        if !run.is_empty() {
            terms.push(std::mem::take(run));
        }
    }

    for word in SPLIT_RE.split(&text.to_lowercase()) {
        if word.is_empty() {
            continue;
        }
        if !contains_cjk(word) {
            terms.push(word.to_string());
            continue;
        }
        // A word may mix scripts with no separator (`Notion取り込み`), so walk it
        // character by character and keep each script's run whole: emitting the
        // Latin part per-character would make `notion` unmatchable.
        for c in word.chars() {
            if is_cjk(c) {
                flush_latin(&mut latin_run, &mut terms);
                cjk_run.push(c);
            } else {
                flush_cjk(&mut cjk_run, &mut terms);
                latin_run.push(c);
            }
        }
        flush_cjk(&mut cjk_run, &mut terms);
        flush_latin(&mut latin_run, &mut terms);
    }

    terms
}

fn field_score(
    query_terms: &[String],
    field_text: &str,
    weight: f64,
    matched: &mut Vec<String>,
) -> f64 {
    if field_text.is_empty() {
        return 0.0;
    }
    let field_terms = tokenize(field_text);
    if field_terms.is_empty() {
        return 0.0;
    }

    let mut counts: HashMap<&str, u32> = HashMap::new();
    for term in &field_terms {
        *counts.entry(term).or_insert(0) += 1;
    }

    let mut score = 0.0;
    for term in query_terms {
        let Some(&count) = counts.get(term.as_str()) else {
            continue;
        };
        if !matched.contains(term) {
            matched.push(term.clone());
        }
        // Saturating term frequency, normalised by field length so a long
        // description cannot outrank a precise `when` entry by sheer volume.
        let count = count as f64;
        let tf = (count * (K1 + 1.0)) / (count + K1);
        score += (weight * tf) / (field_terms.len() as f64).sqrt();
    }
    score
}

/// Rank skills against a request.
///
/// Skills that match nothing are dropped rather than returned with score 0:
/// handing an agent an irrelevant candidate invites it to load one, and a wrong
/// `skill_open` costs more than an empty result does. Ties on score fall back to
/// name order (`localeCompare`, see [`locale_compare`]).
pub fn rank_skills<'a, T: Rankable>(
    task: &str,
    skills: &'a [T],
    limit: Option<usize>,
) -> Vec<RankedSkill<'a, T>> {
    let mut seen = HashSet::new();
    let query_terms: Vec<String> = tokenize(task)
        .into_iter()
        .filter(|t| seen.insert(t.clone()))
        .collect();
    if query_terms.is_empty() {
        return vec![];
    }

    let mut ranked: Vec<RankedSkill<'a, T>> = Vec::new();

    for skill in skills {
        let mut matched: Vec<String> = Vec::new();
        let mut score = 0.0;

        // The name is an identifier, so its hyphens are word boundaries.
        score += field_score(
            &query_terms,
            &skill.name().replace('-', " "),
            WEIGHT_NAME,
            &mut matched,
        );
        score += field_score(
            &query_terms,
            &skill.when().join(" "),
            WEIGHT_WHEN,
            &mut matched,
        );
        score += field_score(
            &query_terms,
            &skill.tags().join(" "),
            WEIGHT_TAG,
            &mut matched,
        );
        score += field_score(
            &query_terms,
            skill.description(),
            WEIGHT_DESCRIPTION,
            &mut matched,
        );

        if score <= 0.0 {
            continue;
        }

        // Reward breadth of match: two distinct query terms hitting is a much
        // better signal than one term hitting twice.
        let coverage = matched.len() as f64 / query_terms.len() as f64;
        ranked.push(RankedSkill {
            skill,
            score: score * (0.5 + 0.5 * coverage),
            matched,
        });
    }

    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| locale_compare(a.skill.name(), b.skill.name()))
    });
    match limit.filter(|n| *n > 0) {
        Some(n) => ranked.into_iter().take(n).collect(),
        None => ranked,
    }
}

/// How confident the top choice is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

/// Decide how confident the top choice is.
///
/// Used to tell an agent whether it can just take the first result or should
/// look at the alternatives. A clear winner means one `skill_open`; a tie means
/// the agent should read the two descriptions before spending on a body.
pub fn selection_confidence<T>(ranked: &[RankedSkill<'_, T>]) -> Confidence {
    let Some(top) = ranked.first() else {
        return Confidence::Low;
    };
    let Some(second) = ranked.get(1) else {
        return if top.score >= 1.0 {
            Confidence::High
        } else {
            Confidence::Medium
        };
    };
    let margin = (top.score - second.score) / top.score;
    if margin >= 0.4 {
        Confidence::High
    } else if margin >= 0.15 {
        Confidence::Medium
    } else {
        Confidence::Low
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(name: &str, description: &str, when: &[&str], tags: &[&str]) -> RankableSkill {
        RankableSkill {
            name: name.into(),
            description: description.into(),
            when: when.iter().map(|s| s.to_string()).collect(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn catalogue() -> Vec<RankableSkill> {
        vec![
            skill(
                "okf-ingest",
                "raw/ の資料を wiki/ に取り込んで整理する手順。",
                &["取り込み", "ingest", "議事録"],
                &["workflow"],
            ),
            skill(
                "japanese-search",
                "日本語で検索が効かないときの調べ方。",
                &["検索", "search", "ヒットしない"],
                &["search"],
            ),
            skill(
                "conformance-audit",
                "OKF v0.2 準拠を条文ごとに監査する。",
                &["準拠", "conformance"],
                &["quality"],
            ),
        ]
    }

    fn top_name(task: &str, skills: &[RankableSkill]) -> Option<String> {
        rank_skills(task, skills, None)
            .first()
            .map(|r| r.skill.name.clone())
    }

    // ---- tokenizing for selection ----

    #[test]
    fn japanese_becomes_overlapping_bigrams_so_it_matches_inside_a_phrase() {
        assert!(tokenize("知識ベース").contains(&"知識".to_string()));
        assert!(tokenize("知識ベースの設計").contains(&"知識".to_string()));
    }

    #[test]
    fn mixed_scripts_split_at_the_boundary() {
        let terms = tokenize("Notion取り込み");
        assert!(terms.contains(&"notion".to_string()));
        assert!(terms.contains(&"取り".to_string()));
    }

    #[test]
    fn latin_words_are_lowercased_whole() {
        assert_eq!(tokenize("Ingest SOURCES"), ["ingest", "sources"]);
    }

    #[test]
    fn mixed_script_word_order_is_preserved() {
        assert_eq!(
            tokenize("Notion取り込みAPI"),
            ["notion", "取り", "り込", "込み", "api"]
        );
    }

    // ---- ranking skills ----

    #[test]
    fn picks_the_ingest_skill_for_a_japanese_ingest_request() {
        assert_eq!(
            top_name(
                "Notion からエクスポートした議事録を取り込みたい",
                &catalogue()
            )
            .as_deref(),
            Some("okf-ingest")
        );
    }

    #[test]
    fn picks_the_search_skill_for_a_japanese_search_complaint() {
        assert_eq!(
            top_name("検索してもヒットしない", &catalogue()).as_deref(),
            Some("japanese-search")
        );
    }

    #[test]
    fn works_in_english_too() {
        assert_eq!(
            top_name("ingest sources into the wiki", &catalogue()).as_deref(),
            Some("okf-ingest")
        );
        assert_eq!(
            top_name("audit conformance", &catalogue()).as_deref(),
            Some("conformance-audit")
        );
    }

    #[test]
    fn skills_that_match_nothing_are_dropped_not_returned_with_score_zero() {
        // Returning an irrelevant candidate invites a wasted skill_open.
        assert!(rank_skills("天気はどうですか", &catalogue(), None).is_empty());
    }

    #[test]
    fn an_empty_task_matches_nothing() {
        assert!(rank_skills("", &catalogue(), None).is_empty());
        assert!(rank_skills("   ", &catalogue(), None).is_empty());
    }

    #[test]
    fn limit_caps_the_candidate_list() {
        let skills = catalogue();
        let ranked = rank_skills("取り込み 検索 準拠", &skills, Some(2));
        assert!(ranked.len() <= 2);
    }

    #[test]
    fn reports_which_terms_matched_so_the_choice_can_be_explained() {
        let skills = catalogue();
        let ranked = rank_skills("ingest", &skills, None);
        assert!(ranked[0].matched.contains(&"ingest".to_string()));
    }

    #[test]
    fn a_when_hit_outranks_a_description_hit() {
        // `when` holds the words a request uses; descriptions are explanatory prose.
        let candidates = vec![
            skill("by-description", "議事録を扱います", &[], &[]),
            skill("by-when", "無関係な説明文", &["議事録"], &[]),
        ];
        assert_eq!(top_name("議事録", &candidates).as_deref(), Some("by-when"));
    }

    #[test]
    fn equal_scores_fall_back_to_name_order() {
        let candidates = vec![
            skill("b-skill", "same", &[], &[]),
            skill("a-skill", "same", &[], &[]),
        ];
        let names: Vec<&str> = rank_skills("same", &candidates, None)
            .iter()
            .map(|r| r.skill.name.as_str())
            .collect();
        assert_eq!(names, ["a-skill", "b-skill"]);
    }

    // ---- selection confidence ----

    fn ranked_scores(scores: &[f64]) -> (Vec<RankableSkill>, Vec<f64>) {
        (
            scores
                .iter()
                .map(|s| skill(&format!("s{s}"), "", &[], &[]))
                .collect(),
            scores.to_vec(),
        )
    }

    fn confidence(scores: &[f64]) -> Confidence {
        let (skills, scores) = ranked_scores(scores);
        let ranked: Vec<RankedSkill<'_, RankableSkill>> = skills
            .iter()
            .zip(scores)
            .map(|(skill, score)| RankedSkill {
                skill,
                score,
                matched: vec!["x".to_string()],
            })
            .collect();
        selection_confidence(&ranked)
    }

    #[test]
    fn a_clear_winner_is_high_confidence() {
        assert_eq!(confidence(&[10.0, 2.0]), Confidence::High);
    }

    #[test]
    fn a_near_tie_is_low_confidence_so_the_agent_should_compare() {
        assert_eq!(confidence(&[10.0, 9.5]), Confidence::Low);
    }

    #[test]
    fn nothing_found_is_low_confidence() {
        assert_eq!(confidence(&[]), Confidence::Low);
    }

    #[test]
    fn a_single_strong_result_is_high_confidence() {
        assert_eq!(confidence(&[5.0]), Confidence::High);
        assert_eq!(confidence(&[0.5]), Confidence::Medium);
    }

    #[test]
    fn a_middling_margin_is_medium_confidence() {
        assert_eq!(confidence(&[10.0, 7.0]), Confidence::Medium);
    }
}
