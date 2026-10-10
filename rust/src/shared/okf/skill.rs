//! Skills: reusable procedure documents an agent loads only when it needs them
//! (`src/shared/okf/skill.ts`).
//!
//! A Skill is a folder under `skills/` holding a `SKILL.md`. The frontmatter
//! carries `name` and `description`; everything else is prose. `description` is
//! the *only* part always in context, so it is a routing key, not a summary,
//! and the body is free to be long because it is paid for only when chosen.

use super::frontmatter::split_frontmatter;
use super::para::{parse_para_class, ParaClass, DEFAULT_PARA};
use crate::shared::js_compat::{js_regex, js_trim, js_trim_start, utf16_len};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::LazyLock;

/// Filename inside a skill folder. Fixed, so discovery needs no config.
pub const SKILL_FILE: &str = "SKILL.md";

/// Typed view of a `SKILL.md` header.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFrontmatter {
    pub name: String,
    pub description: String,
    /// Extra trigger terms for selection: the vocabulary a *request* would
    /// actually use (synonyms, product names, the Japanese for an English term).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Tools this skill expects to use. Advisory only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    /// Folder name, and the id used everywhere.
    pub name: String,
    /// Grouping folder, e.g. `ingest`. Empty when the skill is uncategorised.
    pub category: String,
    /// PARA class. Archived skills are kept but never suggested.
    pub para: ParaClass,
    pub description: String,
    pub when: Vec<String>,
    pub tags: Vec<String>,
    pub allowed_tools: Vec<String>,
    /// SKILL.md body, without frontmatter. Loaded on demand.
    pub body: String,
    /// Problems that do not stop the skill from loading.
    pub warnings: Vec<String>,
}

/// A skill reduced to what selection needs. This is the cheap surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    /// Grouping folder, e.g. `ingest`. Empty when uncategorised.
    pub category: String,
    pub para: ParaClass,
    pub description: String,
    pub tags: Vec<String>,
    /// Rough cost of `skill_open` on this skill, so a budget can be planned.
    pub body_tokens: u64,
    /// Extra files in the folder, relative to it. Not loaded until asked for.
    pub resources: Vec<String>,
}

static NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").unwrap());

/// Longest a description may be (UTF-16 units) before it stops being cheap to
/// keep in context.
pub const MAX_DESCRIPTION_LENGTH: usize = 400;

/// Estimate tokens without a tokenizer.
///
/// Deliberately crude, and crude in the safe direction: CJK counts as roughly a
/// token per character and Latin as a token per four, which overshoots slightly
/// for both. A budget built on an overshoot degrades by loading one skill fewer;
/// one built on an undershoot blows the context window.
pub fn estimate_tokens(text: &str) -> u64 {
    let mut cjk: u64 = 0;
    let mut other: u64 = 0;
    for c in text.chars() {
        // CJK ideographs, kana, and the Hangul/compatibility ranges around them.
        if matches!(
            c as u32,
            0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff
        ) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    (cjk as f64 + other as f64 / 4.0).ceil() as u64
}

/// A value from the flat header: a scalar string or a list of strings.
#[derive(Debug, Clone, PartialEq, Eq)]
enum YamlValue {
    Scalar(String),
    List(Vec<String>),
}

fn string_list(value: Option<&YamlValue>) -> Vec<String> {
    match value {
        Some(YamlValue::Scalar(s)) => s
            .split(',')
            .map(|part| js_trim(part).to_string())
            .filter(|part| !part.is_empty())
            .collect(),
        Some(YamlValue::List(items)) => items
            .iter()
            .filter(|item| !js_trim(item).is_empty())
            .map(|item| js_trim(item).to_string())
            .collect(),
        None => vec![],
    }
}

fn scalar(value: Option<&YamlValue>) -> Option<&str> {
    match value {
        Some(YamlValue::Scalar(s)) => Some(s),
        _ => None,
    }
}

/// Parse a `SKILL.md`.
///
/// Never fails. A malformed skill still loads with warnings attached, for the
/// same reason OKF §11 forbids rejecting a concept over optional fields: a
/// half-written skill in a folder the user is actively editing must not take
/// down discovery for every other skill beside it.
pub fn parse_skill(raw: &str, folder_name: &str, category: &str) -> SkillDocument {
    let split = split_frontmatter(raw);
    let mut warnings: Vec<String> = Vec::new();

    let record = match &split.yaml {
        None => {
            warnings.push("frontmatter がありません".to_string());
            HashMap::new()
        }
        // Skills use a flat key/value frontmatter, so a line parser is enough and
        // keeps this module free of a YAML dependency. (The TS wraps this in a
        // try/catch that its parser can never trigger.)
        Some(yaml) => parse_simple_yaml(yaml),
    };

    let declared_name = js_trim(scalar(record.get("name")).unwrap_or("")).to_string();
    let description = js_trim(scalar(record.get("description")).unwrap_or("")).to_string();

    if declared_name.is_empty() {
        warnings.push("name がありません（フォルダ名を使います）".to_string());
    } else if declared_name != folder_name {
        warnings.push(format!(
            "name ({declared_name}) がフォルダ名 ({folder_name}) と一致しません"
        ));
    }

    let name = if declared_name.is_empty() {
        folder_name.to_string()
    } else {
        declared_name
    };
    if !NAME_RE.is_match(&name) {
        warnings.push("name は英小文字・数字・ハイフンのみ使えます".to_string());
    }

    let description_len = utf16_len(&description);
    if description.is_empty() {
        warnings.push("description がありません — このスキルは選択されません".to_string());
    } else if description_len > MAX_DESCRIPTION_LENGTH {
        warnings.push(format!(
            "description が長すぎます ({description_len} 文字 > {MAX_DESCRIPTION_LENGTH})"
        ));
    }

    SkillDocument {
        name,
        category: category.to_string(),
        // Skills carry PARA in frontmatter rather than in their path: their
        // folders already encode a category, and a second axis on the tree would
        // make every skill four folders deep.
        para: parse_para_class(scalar(record.get("para")).unwrap_or("")).unwrap_or(DEFAULT_PARA),
        description,
        when: string_list(record.get("when")),
        tags: string_list(record.get("tags")),
        // Hyphenated in the file to match the Agent Skills convention people
        // already have in their editors; camelCase inside the code.
        allowed_tools: string_list(
            record
                .get("allowed-tools")
                .or_else(|| record.get("allowedTools")),
        ),
        body: js_trim(&split.body).to_string(),
        warnings,
    }
}

static KEY_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^([A-Za-z0-9_-]+)<S>*:<S>*(<DOT>*)$"));
static ITEM_LINE_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^<S>*-<S>+(<DOT>*)$"));

/// A minimal YAML reader for flat frontmatter.
///
/// Handles `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines,
/// which is the whole of what a skill header is allowed to be. Anything deeper
/// belongs in the body.
fn parse_simple_yaml(yaml: &str) -> HashMap<String, YamlValue> {
    let mut out = HashMap::new();
    let lines = crate::shared::js_compat::split_crlf(yaml);

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;

        if js_trim(line).is_empty() || js_trim_start(line).starts_with('#') {
            continue;
        }
        // Only top-level keys; indented lines are handled as list items below.
        if line
            .chars()
            .next()
            .is_some_and(crate::shared::js_compat::is_js_space)
        {
            continue;
        }

        let Some(caps) = KEY_LINE_RE.captures(line) else {
            continue;
        };
        let key = caps[1].to_string();
        let rest = js_trim(&caps[2]);

        if !rest.is_empty() {
            out.insert(key, parse_scalar_or_flow_list(rest));
            continue;
        }

        // `key:` with the values on following `- item` lines.
        let mut items = Vec::new();
        while let Some(next) = lines.get(i) {
            let Some(item) = ITEM_LINE_RE.captures(next) else {
                break;
            };
            items.push(unquote(js_trim(&item[1])).to_string());
            i += 1;
        }
        out.insert(key, YamlValue::List(items));
    }

    out
}

fn parse_scalar_or_flow_list(text: &str) -> YamlValue {
    if text.starts_with('[') && text.ends_with(']') && text.len() >= 2 {
        return YamlValue::List(
            text[1..text.len() - 1]
                .split(',')
                .map(|part| unquote(js_trim(part)).to_string())
                .filter(|part| !part.is_empty())
                .collect(),
        );
    }
    YamlValue::Scalar(unquote(text).to_string())
}

fn unquote(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        return &text[1..text.len() - 1];
    }
    text
}

/// Fields [`serialize_skill`] writes.
#[derive(Debug, Clone, Default)]
pub struct SkillSource {
    pub name: String,
    pub description: String,
    pub para: Option<ParaClass>,
    pub when: Vec<String>,
    pub tags: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub body: String,
}

impl From<&SkillDocument> for SkillSource {
    fn from(doc: &SkillDocument) -> Self {
        Self {
            name: doc.name.clone(),
            description: doc.description.clone(),
            para: Some(doc.para),
            when: doc.when.clone(),
            tags: doc.tags.clone(),
            allowed_tools: doc.allowed_tools.clone(),
            body: doc.body.clone(),
        }
    }
}

/// Render a skill back to `SKILL.md` source.
pub fn serialize_skill(skill: &SkillSource) -> String {
    let mut lines = vec![
        format!("name: {}", skill.name),
        format!("description: {}", skill.description),
    ];
    // Only written when it is not the default, so a plain skill stays plain.
    if let Some(para) = skill.para.filter(|p| *p != DEFAULT_PARA) {
        lines.push(format!("para: {}", para.as_str()));
    }
    if !skill.when.is_empty() {
        lines.push(format!("when: [{}]", skill.when.join(", ")));
    }
    if !skill.tags.is_empty() {
        lines.push(format!("tags: [{}]", skill.tags.join(", ")));
    }
    if !skill.allowed_tools.is_empty() {
        lines.push(format!(
            "allowed-tools: [{}]",
            skill.allowed_tools.join(", ")
        ));
    }
    let mut all = vec!["---".to_string()];
    all.extend(lines);
    all.extend([
        "---".to_string(),
        String::new(),
        js_trim(&skill.body).to_string(),
        String::new(),
    ]);
    all.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SKILL: &str = "---\nname: okf-ingest\ndescription: raw/ の資料を wiki/ に取り込んで整理する手順。\nwhen: [取り込み, ingest, 議事録]\ntags: [ingest, workflow]\nallowed-tools: [read_file, write_file]\n---\n\n# 取り込み手順\n\n1. read_agents_md を呼ぶ\n";

    #[test]
    fn reads_the_routing_fields_and_the_body() {
        let skill = parse_skill(SKILL, "okf-ingest", "");

        assert_eq!(skill.name, "okf-ingest");
        assert_eq!(
            skill.description,
            "raw/ の資料を wiki/ に取り込んで整理する手順。"
        );
        assert_eq!(skill.when, ["取り込み", "ingest", "議事録"]);
        assert_eq!(skill.tags, ["ingest", "workflow"]);
        assert_eq!(skill.allowed_tools, ["read_file", "write_file"]);
        assert!(skill.body.starts_with("# 取り込み手順"));
        assert!(skill.warnings.is_empty());
    }

    #[test]
    fn accepts_block_lists_as_well_as_flow_lists() {
        let skill = parse_skill(
            "---\nname: a-skill\ndescription: テスト\nwhen:\n  - 取り込み\n  - \"引用符つき\"\n---\n\nbody",
            "a-skill",
            "",
        );
        assert_eq!(skill.when, ["取り込み", "引用符つき"]);
    }

    #[test]
    fn a_skill_with_no_frontmatter_still_loads_with_a_warning() {
        // A half-written skill must not break discovery for the ones beside it.
        let skill = parse_skill("just a body", "draft", "");

        assert_eq!(skill.name, "draft");
        assert_eq!(skill.body, "just a body");
        assert!(skill.warnings.join(",").contains("frontmatter"));
    }

    #[test]
    fn warns_when_name_disagrees_with_the_folder() {
        let skill = parse_skill("---\nname: other\ndescription: x\n---\n", "actual", "");

        assert_eq!(skill.name, "other");
        assert_eq!(
            skill.warnings,
            ["name (other) がフォルダ名 (actual) と一致しません"]
        );
    }

    #[test]
    fn warns_about_a_description_too_long_to_keep_in_context() {
        let long = "あ".repeat(MAX_DESCRIPTION_LENGTH + 1);
        let skill = parse_skill(
            &format!("---\nname: x\ndescription: {long}\n---\n"),
            "x",
            "",
        );

        assert_eq!(
            skill.warnings,
            ["description が長すぎます (401 文字 > 400)"]
        );
    }

    #[test]
    fn warns_about_a_name_that_cannot_be_used_as_an_id() {
        let skill = parse_skill("---\nname: Bad Name\ndescription: x\n---\n", "Bad Name", "");
        assert!(skill.warnings.join(",").contains("英小文字"));
    }

    #[test]
    fn warns_about_a_missing_description_and_name() {
        let skill = parse_skill("---\ntags: a\n---\n", "folder", "cat");
        assert_eq!(
            skill.warnings,
            [
                "name がありません（フォルダ名を使います）",
                "description がありません — このスキルは選択されません"
            ]
        );
        assert_eq!(skill.category, "cat");
        assert_eq!(skill.tags, ["a"]);
    }

    #[test]
    fn round_trips_through_serialize() {
        let skill = parse_skill(SKILL, "okf-ingest", "");
        let again = parse_skill(
            &serialize_skill(&SkillSource::from(&skill)),
            "okf-ingest",
            "",
        );

        assert_eq!(again.description, skill.description);
        assert_eq!(again.when, skill.when);
        assert_eq!(again.allowed_tools, skill.allowed_tools);
        assert_eq!(again.body, skill.body);
    }

    #[test]
    fn serialize_layout_is_byte_exact_and_omits_the_default_para() {
        let text = serialize_skill(&SkillSource {
            name: "a-b".into(),
            description: "d".into(),
            para: Some(ParaClass::Resource),
            when: vec!["x".into(), "y".into()],
            body: "\nbody\n".into(),
            ..Default::default()
        });
        assert_eq!(
            text,
            "---\nname: a-b\ndescription: d\nwhen: [x, y]\n---\n\nbody\n"
        );

        let archived = serialize_skill(&SkillSource {
            name: "a".into(),
            description: "d".into(),
            para: Some(ParaClass::Archive),
            ..Default::default()
        });
        assert!(archived.contains("para: archive\n"));
    }

    #[test]
    fn comma_separated_scalars_become_lists() {
        let skill = parse_skill(
            "---\nname: a\ndescription: d\nwhen: x, y ,, z\n---\n",
            "a",
            "",
        );
        assert_eq!(skill.when, ["x", "y", "z"]);
    }

    #[test]
    fn para_is_read_from_the_frontmatter() {
        let skill = parse_skill(
            "---\nname: a\ndescription: d\npara: 4-archive\n---\n",
            "a",
            "",
        );
        assert_eq!(skill.para, ParaClass::Archive);
    }

    // ---- estimating cost ----

    #[test]
    fn japanese_costs_far_more_per_character_than_english() {
        // The whole budget story depends on not treating these as equal.
        let ja = estimate_tokens("日本語のテキスト");
        let en = estimate_tokens("english text here");
        assert!(ja > en);
        assert_eq!(ja, 8);
        assert_eq!(en, 5);
    }

    #[test]
    fn empty_text_is_free() {
        assert_eq!(estimate_tokens(""), 0);
    }
}
