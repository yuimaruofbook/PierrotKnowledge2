//! OKF v0.2 concept rules: identity, reserved files, conformance, trust
//! (`src/shared/okf/concept.ts`).

use super::frontmatter::{read_scalar, split_frontmatter};
use super::workspace_files::is_workspace_filename;
use crate::shared::js_compat::{ends_with_ascii_ci, js_trim};
use crate::shared::messages;
use crate::shared::types::{ConceptFrontmatter, Status, TrustTier, Verified, VerifiedEntry};
use chrono::{DateTime, Datelike, Local};
use serde_json::Value;

/// Reserved filenames carry no frontmatter and are not concepts (OKF §3).
pub const RESERVED_FILENAMES: [&str; 2] = ["index.md", "log.md"];

/// The agent contract. Lives in the wiki layer but is not knowledge.
///
/// Kept apart from [`RESERVED_FILENAMES`] on purpose: OKF §3 reserves exactly
/// `index.md` and `log.md`, and `AGENTS.md` is the LLM Wiki pattern's schema
/// file, not part of the format.
pub const CONTRACT_FILENAME: &str = "agents.md";

pub const DEFAULT_CONCEPT_TYPE: &str = "Concept";

pub fn is_reserved_filename(name: &str) -> bool {
    RESERVED_FILENAMES.contains(&name.to_lowercase().as_str())
}

pub fn basename_of(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// True when a path denotes a concept document.
///
/// Excludes the OKF reserved files, the agent contract and the orientation
/// files (`MAP.md`, `human.md`, `Task.md`): none of them is knowledge, and
/// indexing them would put instructions, a changelog and someone's task list
/// into the same results as facts.
pub fn is_concept_path(path: &str) -> bool {
    let name = basename_of(path).to_lowercase();
    ends_with_ascii_ci(path, ".md")
        && !is_reserved_filename(&name)
        && name != CONTRACT_FILENAME
        && !is_workspace_filename(&name)
}

/// Concept id = path without the `.md` suffix, normalised to `/` (OKF §2).
pub fn concept_id_from_rel_path(rel_path: &str) -> String {
    let normalized = rel_path.replace('\\', "/");
    if ends_with_ascii_ci(&normalized, ".md") {
        normalized[..normalized.len() - 3].to_string()
    } else {
        normalized
    }
}

pub fn rel_path_from_concept_id(id: &str) -> String {
    format!("{}.md", id.replace('\\', "/"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConformanceResult {
    pub ok: bool,
    pub errors: Vec<String>,
}

/// Check a document against OKF §11.
///
/// §11 requires exactly three things: parseable frontmatter on every
/// non-reserved `.md`, a non-empty `type` in it, and reserved files following
/// §8/§9. Nothing else is grounds for rejection.
///
/// `bundle_rel_path` must be relative to the *bundle root* (the wiki layer),
/// since the root `index.md` is the one reserved file permitted to carry
/// frontmatter: an `okf_version` key, and only that (§8).
pub fn check_conformance(bundle_rel_path: &str, raw: &str) -> ConformanceResult {
    let mut errors: Vec<String> = Vec::new();
    let yaml = split_frontmatter(raw).yaml;
    let path = bundle_rel_path.replace('\\', "/");
    let path = path.trim_start_matches('/');

    // The contract file and the orientation files are prose and tables for
    // agents, not concepts: nothing to check.
    let basename = basename_of(path).to_lowercase();
    if basename == CONTRACT_FILENAME || is_workspace_filename(&basename) {
        return ConformanceResult {
            ok: true,
            errors: vec![],
        };
    }

    if is_reserved_filename(basename_of(path)) {
        let Some(yaml) = yaml else {
            return ConformanceResult {
                ok: true,
                errors: vec![],
            };
        };

        // §8: the bundle-root index.md MAY carry okf_version. Anywhere else, and
        // for any other key, frontmatter on a reserved file is non-conformant.
        if path == "index.md" {
            let extra: Vec<String> = top_level_keys(&yaml)
                .into_iter()
                .filter(|key| key != "okf_version")
                .collect();
            if !extra.is_empty() {
                errors.push(messages::root_index_extra_keys(&extra));
            }
        } else {
            errors.push(messages::RESERVED_HAS_FRONTMATTER.to_string());
        }

        return ConformanceResult {
            ok: errors.is_empty(),
            errors,
        };
    }

    let Some(yaml) = yaml else {
        return ConformanceResult {
            ok: false,
            errors: vec![messages::MISSING_FRONTMATTER.to_string()],
        };
    };

    if read_scalar(&yaml, "type").is_none_or(|t| t.is_empty()) {
        errors.push(messages::MISSING_TYPE.to_string());
    }

    ConformanceResult {
        ok: errors.is_empty(),
        errors,
    }
}

/// Top-level keys of a frontmatter block, without a full YAML parse.
fn top_level_keys(yaml: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for line in crate::shared::js_compat::split_crlf(yaml) {
        let mut chars = line.char_indices();
        let Some((_, first)) = chars.next() else {
            continue;
        };
        if !(first.is_ascii_alphabetic() || first == '_') {
            continue;
        }
        let mut end = line.len();
        for (i, c) in chars {
            if !(c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                end = i;
                break;
            }
        }
        let rest = line[end..].trim_start_matches([' ', '\t']);
        if rest.starts_with(':') {
            keys.push(line[..end].to_string());
        }
    }
    keys
}

pub fn derive_trust_tier(verified: Option<&Verified>) -> TrustTier {
    let list: &[VerifiedEntry] = match verified {
        None => return TrustTier::Unverified,
        Some(Verified::One(entry)) => std::slice::from_ref(entry),
        Some(Verified::Many(entries)) => entries,
    };
    if list.is_empty() {
        return TrustTier::Unverified;
    }
    if list.iter().any(|v| v.by.starts_with("human:")) {
        return TrustTier::HumanReviewed;
    }
    TrustTier::MachineConfirmed
}

pub fn effective_status(frontmatter: &ConceptFrontmatter) -> Status {
    match frontmatter.status.as_deref() {
        Some("draft") => Status::Draft,
        Some("deprecated") => Status::Deprecated,
        _ => Status::Stable,
    }
}

/// Staleness per OKF §5.5: a concept is stale when `today >= stale_after`.
///
/// `stale_after` is an absolute `YYYY-MM-DD` date, not a TTL, so this is a
/// plain date comparison independent of when the concept was read. Compared as
/// local dates rather than instants so a concept goes stale at the start of the
/// named day in the reader's terms.
pub fn is_stale(frontmatter: &ConceptFrontmatter, now: &DateTime<Local>) -> bool {
    stale_after_reached(frontmatter.stale_after.as_ref(), now)
}

/// [`is_stale`] on the raw `stale_after` value, which may be any JSON type.
pub fn stale_after_reached(stale_after: Option<&Value>, now: &DateTime<Local>) -> bool {
    let Some(Value::String(stale_after)) = stale_after else {
        return false;
    };
    let trimmed = js_trim(stale_after);
    if trimmed.is_empty() {
        return false;
    }

    // `.slice(0, 10)` then `/^\d{4}-\d{2}-\d{2}$/`: ten ASCII characters in shape.
    let day: String = trimmed.chars().take(10).collect();
    let shaped = day.len() == 10
        && day.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    if !shaped {
        return false;
    }

    to_iso_day(now) >= day
}

fn to_iso_day(date: &DateTime<Local>) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

pub fn concept_title(id: &str, frontmatter: &ConceptFrontmatter) -> String {
    match frontmatter.title.as_deref() {
        Some(title) if !js_trim(title).is_empty() => title.to_string(),
        _ => basename_of(id).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::okf::reserved::{render_index_md, IndexOptions, OKF_VERSION};
    use chrono::{NaiveDate, TimeZone, Utc};
    use serde_json::json;

    fn local_noon(day: &str) -> DateTime<Local> {
        let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap();
        Local
            .from_local_datetime(&date.and_hms_opt(12, 0, 0).unwrap())
            .unwrap()
    }

    fn fm_with_stale(value: Option<Value>) -> ConceptFrontmatter {
        let mut fm = ConceptFrontmatter::new("C");
        fm.stale_after = value;
        fm
    }

    // ---- conformance ----

    #[test]
    fn accepts_a_concept_with_a_non_empty_type() {
        assert!(check_conformance("wiki/a.md", "---\ntype: Concept\n---\nbody").ok);
    }

    #[test]
    fn rejects_a_concept_without_frontmatter() {
        let result = check_conformance("wiki/a.md", "# no frontmatter");
        assert!(!result.ok);
        assert_eq!(result.errors[0], messages::MISSING_FRONTMATTER);
    }

    #[test]
    fn rejects_an_empty_type() {
        let result = check_conformance("wiki/a.md", "---\ntype:\n---\n");
        assert!(!result.ok);
        assert_eq!(result.errors, [messages::MISSING_TYPE]);
    }

    #[test]
    fn requires_reserved_files_to_have_no_frontmatter() {
        assert!(check_conformance("wiki/index.md", "# Index\n").ok);
        assert!(!check_conformance("wiki/log.md", "---\ntype: X\n---\n").ok);
    }

    #[test]
    fn a_root_index_carrying_okf_version_is_conformant() {
        // §8 grants exactly one exception to "reserved files have no frontmatter".
        let md = render_index_md(
            "B",
            &[],
            &IndexOptions {
                okf_version: Some(OKF_VERSION.into()),
            },
        );
        assert!(check_conformance("index.md", &md).ok);
    }

    #[test]
    fn the_exception_applies_only_at_the_bundle_root() {
        let md = render_index_md(
            "B",
            &[],
            &IndexOptions {
                okf_version: Some(OKF_VERSION.into()),
            },
        );
        assert!(!check_conformance("sub/index.md", &md).ok);
    }

    #[test]
    fn the_exception_covers_only_the_okf_version_key() {
        assert!(!check_conformance("index.md", "---\ntype: Concept\n---\n").ok);
        let result = check_conformance("index.md", "---\nokf_version: 0.2\ntitle: X\n---\n");
        assert!(!result.ok);
        assert_eq!(
            result.errors,
            [messages::root_index_extra_keys(&["title".to_string()])]
        );
    }

    #[test]
    fn reserved_files_without_frontmatter_are_conformant_anywhere() {
        assert!(check_conformance("index.md", "# Index\n").ok);
        assert!(check_conformance("deep/sub/log.md", "# Log\n").ok);
    }

    #[test]
    fn a_concept_carrying_only_type_is_fully_conformant() {
        assert!(check_conformance("a.md", "---\ntype: Concept\n---\n").ok);
    }

    #[test]
    fn unknown_types_and_extra_keys_are_not_grounds_for_rejection() {
        let raw = "---\ntype: SomethingNovel\nunknown_key: 1\n---\nbody";
        assert!(check_conformance("a.md", raw).ok);
    }

    #[test]
    fn orientation_and_contract_files_are_never_checked() {
        assert!(check_conformance("wiki/AGENTS.md", "no frontmatter").ok);
        assert!(check_conformance("Task.md", "no frontmatter").ok);
    }

    // ---- identity ----

    #[test]
    fn strips_the_extension_and_normalises_separators() {
        assert_eq!(
            concept_id_from_rel_path("topics\\deep\\note.md"),
            "topics/deep/note"
        );
        assert_eq!(concept_id_from_rel_path("NOTE.MD"), "NOTE");
        assert_eq!(rel_path_from_concept_id("a\\b"), "a/b.md");
    }

    #[test]
    fn concept_paths_exclude_non_knowledge_files() {
        assert!(is_concept_path("wiki/1-projects/real-note.md"));
        assert!(!is_concept_path("wiki/index.md"));
        assert!(!is_concept_path("wiki/AGENTS.md"));
        assert!(!is_concept_path("wiki/MAP.md"));
        assert!(!is_concept_path("wiki/note.txt"));
    }

    // ---- trust and lifecycle ----

    fn entry(by: &str) -> VerifiedEntry {
        VerifiedEntry {
            by: by.into(),
            at: "2026-01-01".into(),
        }
    }

    #[test]
    fn derives_the_tier_from_who_verified() {
        assert_eq!(derive_trust_tier(None), TrustTier::Unverified);
        assert_eq!(
            derive_trust_tier(Some(&Verified::Many(vec![]))),
            TrustTier::Unverified
        );
        assert_eq!(
            derive_trust_tier(Some(&Verified::One(entry("process:ci")))),
            TrustTier::MachineConfirmed
        );
        assert_eq!(
            derive_trust_tier(Some(&Verified::Many(vec![
                entry("process:ci"),
                entry("human:kn")
            ]))),
            TrustTier::HumanReviewed
        );
    }

    #[test]
    fn staleness_compares_against_stale_after() {
        let now = Utc
            .with_ymd_and_hms(2026, 6, 1, 0, 0, 0)
            .unwrap()
            .with_timezone(&Local);
        assert!(is_stale(
            &fm_with_stale(Some(json!("2026-01-01T00:00:00Z"))),
            &now
        ));
        assert!(!is_stale(
            &fm_with_stale(Some(json!("2027-01-01T00:00:00Z"))),
            &now
        ));
        assert!(!is_stale(&fm_with_stale(Some(json!("not a date"))), &now));
        assert!(!is_stale(&fm_with_stale(None), &now));
    }

    #[test]
    fn stale_on_and_after_the_named_day() {
        // §5.5 defines staleness as `today >= stale_after`.
        let fm = fm_with_stale(Some(json!("2026-08-01")));
        assert!(is_stale(&fm, &local_noon("2026-08-01")));
        assert!(is_stale(&fm, &local_noon("2026-08-02")));
    }

    #[test]
    fn not_stale_before_it() {
        let fm = fm_with_stale(Some(json!("2026-08-01")));
        assert!(!is_stale(&fm, &local_noon("2026-07-31")));
    }

    #[test]
    fn absent_or_unparseable_stale_after_is_never_stale() {
        let now = local_noon("2026-08-01");
        assert!(!is_stale(&fm_with_stale(None), &now));
        assert!(!is_stale(&fm_with_stale(Some(json!("soon"))), &now));
        assert!(!stale_after_reached(Some(&json!(42)), &now));
    }

    #[test]
    fn effective_status_defaults_to_stable() {
        let mut fm = ConceptFrontmatter::new("C");
        assert_eq!(effective_status(&fm), Status::Stable);
        fm.status = Some("draft".into());
        assert_eq!(effective_status(&fm), Status::Draft);
        fm.status = Some("deprecated".into());
        assert_eq!(effective_status(&fm), Status::Deprecated);
        fm.status = Some("whatever".into());
        assert_eq!(effective_status(&fm), Status::Stable);
    }

    #[test]
    fn title_falls_back_to_the_basename() {
        let mut fm = ConceptFrontmatter::new("C");
        assert_eq!(concept_title("topics/note", &fm), "note");
        fm.title = Some("   ".into());
        assert_eq!(concept_title("topics/note", &fm), "note");
        fm.title = Some(" Hello ".into());
        assert_eq!(concept_title("topics/note", &fm), " Hello ");
    }
}
