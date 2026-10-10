//! Context packs: the minimal set of files an agent should read for a task
//! (`src/bun/rag/context-pack.ts`).
//!
//! A pack reuses budgeted retrieval but regroups the passages by document and
//! sizes the budget to the model that will consume it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::shared::js_compat::serialize_js_f64;
use crate::shared::types::{RetrievalResult, RetrievedPassage};

/// Which class of model the pack is for: a cheap "worker" doing delegated
/// reading or an expensive "supervisor" planning or verifying.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextTier {
    Worker,
    Supervisor,
}

impl ContextTier {
    pub fn as_str(self) -> &'static str {
        match self {
            ContextTier::Worker => "worker",
            ContextTier::Supervisor => "supervisor",
        }
    }

    /// Parse `"worker"` / `"supervisor"`; anything else is `None`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "worker" => Some(ContextTier::Worker),
            "supervisor" => Some(ContextTier::Supervisor),
            _ => None,
        }
    }

    /// Budget and passage limit for this tier.
    pub fn defaults(self) -> TierDefaults {
        match self {
            ContextTier::Worker => TIER_DEFAULTS_WORKER,
            ContextTier::Supervisor => TIER_DEFAULTS_SUPERVISOR,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TierDefaults {
    pub budget_chars: i64,
    pub limit: i64,
}

pub const TIER_DEFAULTS_WORKER: TierDefaults = TierDefaults {
    budget_chars: 4000,
    limit: 6,
};
pub const TIER_DEFAULTS_SUPERVISOR: TierDefaults = TierDefaults {
    budget_chars: 12000,
    limit: 12,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackFile {
    pub path: String,
    pub id: String,
    pub title: String,
    pub r#type: String,
    /// One-line summary from the document's own frontmatter, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub passages: Vec<RetrievedPassage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextPackSkill {
    pub name: String,
    pub description: String,
    #[serde(serialize_with = "serialize_js_f64")]
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPack {
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<ContextTier>,
    pub budget_chars: i64,
    pub files: Vec<ContextPackFile>,
    /// Skills that match the task, so procedure travels with context.
    pub skills: Vec<ContextPackSkill>,
    pub used_chars: u64,
    pub truncated: bool,
}

/// Regroup ranked passages by document, keeping each document's first-hit rank.
///
/// `describe` returns the document's frontmatter description when it has a
/// non-blank one.
pub fn group_passages(
    retrieval: &RetrievalResult,
    describe: impl Fn(&str) -> Option<String>,
) -> Vec<ContextPackFile> {
    let mut files: Vec<ContextPackFile> = Vec::new();
    let mut by_id: HashMap<&str, usize> = HashMap::new();

    for passage in &retrieval.passages {
        let at = *by_id.entry(passage.id.as_str()).or_insert_with(|| {
            let description = describe(&passage.id).filter(|d| !d.is_empty());
            files.push(ContextPackFile {
                path: passage.path.clone(),
                id: passage.id.clone(),
                title: passage.title.clone(),
                r#type: passage.r#type.clone(),
                description,
                passages: Vec::new(),
            });
            files.len() - 1
        });
        files[at].passages.push(passage.clone());
    }
    files
}

/// JS `Number.prototype.toFixed(2)`: exact ties round up in magnitude, which
/// Rust's formatter (half to even) does not.
fn to_fixed2(x: f64) -> String {
    if !x.is_finite() {
        return if x.is_nan() {
            "NaN".to_string()
        } else if x > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    let mag = x.abs();
    // Exact ties at two decimals need x = j/8 with j odd (0.125, 0.375, ...);
    // those are representable, so this test is exact.
    let eighths = mag * 8.0;
    let tie = mag < 1.0e15 && eighths.fract() == 0.0 && (eighths as u64) % 2 == 1;
    let body = if tie {
        format!("{:.2}", ((mag * 100.0).floor() + 1.0) / 100.0)
    } else {
        format!("{mag:.2}")
    };
    if x < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// Render a pack as Markdown for an agent.
///
/// The shape mirrors `format_retrieval`, grouped so the agent can decide per
/// file whether the excerpts suffice or the whole file is worth a read.
pub fn format_context_pack(pack: &ContextPack) -> String {
    if pack.files.is_empty() && pack.skills.is_empty() {
        return format!(
            "No context found for: {}\nThe bundle may not cover this yet — check unresolved_links for known gaps.",
            pack.task
        );
    }

    let mut lines: Vec<String> = vec![format!("Context pack for: {}", pack.task)];
    let mut meta: Vec<String> = Vec::new();
    if let Some(tier) = pack.tier {
        meta.push(format!("tier: {}", tier.as_str()));
    }
    meta.push(format!("budget {} chars", pack.budget_chars));
    meta.push(format!("used {}", pack.used_chars));
    meta.push(format!("{} file(s)", pack.files.len()));
    lines.push(meta.join(" · "));
    lines.push(String::new());

    for file in &pack.files {
        lines.push(format!("## `{}` — {} ({})", file.path, file.title, file.r#type));
        if let Some(description) = file.description.as_deref().filter(|d| !d.is_empty()) {
            lines.push(format!("_{description}_"));
        }
        lines.push(String::new());
        for passage in &file.passages {
            let heading = passage.heading_path.join(" › ");
            if !heading.is_empty() {
                lines.push(format!("### {heading}"));
                lines.push(String::new());
            }
            lines.push(format!("anchor: `{}`", passage.anchor));
            lines.push(String::new());
            lines.push(passage.text.clone());
            lines.push(String::new());
        }
    }

    if !pack.skills.is_empty() {
        lines.push("## Matching skills".to_string());
        lines.push(String::new());
        for skill in &pack.skills {
            lines.push(format!(
                "- **{}** ({}): {}",
                skill.name,
                to_fixed2(skill.score),
                skill.description
            ));
        }
        lines.push(String::new());
        lines.push("Open the one you follow with skill_open — do not open them all.".to_string());
        lines.push(String::new());
    }

    if pack.truncated {
        lines.push(
            "_(truncated to fit the budget — raise budget_chars, or read_file the most relevant path)_"
                .to_string(),
        );
    }

    crate::shared::js_compat::js_trim_end(&lines.join("\n")).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed2_matches_js() {
        assert_eq!(to_fixed2(0.125), "0.13");
        assert_eq!(to_fixed2(0.375), "0.38");
        assert_eq!(to_fixed2(1.0), "1.00");
        assert_eq!(to_fixed2(0.0), "0.00");
        assert_eq!(to_fixed2(2.345), "2.35"); // 2.345 is 2.34500000000000019984
        assert_eq!(to_fixed2(1.005), "1.00"); // 1.005 is 1.00499999999999989
        assert_eq!(to_fixed2(-0.125), "-0.13");
    }
}

#[cfg(test)]
mod pack_tests {
    use super::*;
    use crate::rag::fts::{testutil::open_corpus, FtsIndex};
    use crate::rag::retrieve::{retrieve, RetrieveOptions, DEFAULT_BUDGET_CHARS};

    fn pack(i: &FtsIndex, task: &str, tier: Option<ContextTier>) -> ContextPack {
        let d = tier.map_or(
            TierDefaults {
                budget_chars: DEFAULT_BUDGET_CHARS,
                limit: 8,
            },
            ContextTier::defaults,
        );
        let r = retrieve(
            i,
            task,
            &RetrieveOptions {
                budget_chars: Some(d.budget_chars),
                limit: Some(d.limit),
                ..Default::default()
            },
        )
        .unwrap();
        ContextPack {
            task: task.into(),
            tier,
            budget_chars: d.budget_chars,
            files: group_passages(&r, |id| (id == "rag").then(|| "検索の説明".to_string())),
            skills: vec![ContextPackSkill {
                name: "japanese-search".into(),
                description: "手順".into(),
                score: 0.5,
            }],
            used_chars: r.used_chars,
            truncated: r.truncated,
        }
    }

    #[test]
    fn groups_by_file_with_description() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let p = pack(&i, "RAG のチャンク分割とインデックス", None);
        let f = p.files.iter().find(|f| f.id == "rag").unwrap();
        assert_eq!(f.description.as_deref(), Some("検索の説明"));
        assert!(f.passages.iter().all(|x| x.id == "rag"));
        let mut seen = std::collections::HashSet::new();
        assert!(p.files.iter().all(|f| seen.insert(f.id.clone())));
    }

    #[test]
    fn tiers_size_the_budget() {
        assert_eq!(ContextTier::Worker.defaults().budget_chars, 4000);
        assert_eq!(ContextTier::Supervisor.defaults().budget_chars, 12000);
        assert_eq!(ContextTier::parse("manager"), None);
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let p = pack(&i, "設計", Some(ContextTier::Worker));
        assert_eq!(p.budget_chars, 4000);
        assert!(format_context_pack(&p).contains("tier: worker"));
    }

    #[test]
    fn format_renders_paths_anchors_skills() {
        let dir = tempfile::tempdir().unwrap();
        let i = open_corpus(dir.path());
        let s = format_context_pack(&pack(&i, "RAG のチャンク分割", None));
        assert!(s.contains("wiki/rag.md"));
        assert!(s.contains("anchor: `"));
        assert!(s.contains("- **japanese-search** (0.50): 手順"));
        assert!(s.contains("_検索の説明_"));
    }

    #[test]
    fn empty_pack_message() {
        let p = ContextPack {
            task: "量子".into(),
            tier: None,
            budget_chars: 6000,
            files: vec![],
            skills: vec![],
            used_chars: 0,
            truncated: false,
        };
        assert!(format_context_pack(&p).starts_with("No context found for: 量子\n"));
        let j = serde_json::to_string(&p).unwrap();
        assert_eq!(
            j,
            r#"{"task":"量子","budgetChars":6000,"files":[],"skills":[],"usedChars":0,"truncated":false}"#
        );
    }
}
