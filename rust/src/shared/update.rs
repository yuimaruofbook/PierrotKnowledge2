//! The rules an update has to satisfy before anything is written to disk
//! (`src/shared/update.ts`).
//!
//! Pure and apart from the download so they can be tested without a network or
//! filesystem. Each rule exists because getting it wrong destroys something:
//! knowledge must never live in the install directory, an older version must
//! never be installed, and the download must match the digest GitHub computed.

use super::js_compat::{js_regex, js_trim};
use serde::{Deserialize, Serialize};

/// A release as this app cares about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub tag: String,
    /// Human title of the release.
    pub name: String,
    /// The release notes, as Markdown.
    pub notes: String,
    /// The page a person would open to read this release.
    pub html_url: String,
    pub published_at: String,
    /// From the artifact's own manifest, not the tag. `None` when it has none.
    pub version: Option<String>,
    pub asset_name: String,
    pub asset_url: String,
    pub asset_size: u64,
    /// `sha256:<hex>` as GitHub reports it, or `None` if it did not.
    pub digest: Option<String>,
}

/// What is installed now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledInfo {
    pub version: String,
    /// Tag of the release this came from, when it came from one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// `published_at` of that release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum UpdateVerdict {
    Update { reason: String },
    UpToDate { reason: String },
    Refuse { reason: String },
}

impl UpdateVerdict {
    pub fn reason(&self) -> &str {
        match self {
            Self::Update { reason } | Self::UpToDate { reason } | Self::Refuse { reason } => reason,
        }
    }

    /// The TS `action` string.
    pub fn action(&self) -> &'static str {
        match self {
            Self::Update { .. } => "update",
            Self::UpToDate { .. } => "up-to-date",
            Self::Refuse { .. } => "refuse",
        }
    }
}

/// `1.2.3` -> `[1,2,3]`. Anything unparseable yields `None` rather than a guess.
///
/// Components too large for `u64` saturate; no real version is that large.
pub fn parse_version(value: Option<&str>) -> Option<[u64; 3]> {
    let value = value.filter(|v| !v.is_empty())?;
    let re = js_regex(r"^v?(<D>+)\.(<D>+)\.(<D>+)");
    let caps = re.captures(js_trim(value))?;
    let part = |i: usize| caps[i].parse::<u64>().unwrap_or(u64::MAX);
    Some([part(1), part(2), part(3)])
}

/// -1, 0 or 1. `None` for either side means "cannot be compared".
pub fn compare_versions(a: Option<&str>, b: Option<&str>) -> Option<i32> {
    let left = parse_version(a)?;
    let right = parse_version(b)?;
    for i in 0..3 {
        if left[i] != right[i] {
            return Some(if left[i] > right[i] { 1 } else { -1 });
        }
    }
    Some(0)
}

/// Decide what to do, given what is installed and what is published.
///
/// The publish date is only consulted when both sides carry the same version,
/// the state this project is actually in today. It is a transitional allowance
/// and still requires the remote to be strictly newer.
pub fn decide_update(installed: &InstalledInfo, release: &ReleaseInfo) -> UpdateVerdict {
    if release.digest.as_deref().is_none_or(str::is_empty) {
        return UpdateVerdict::Refuse {
            reason: "リリースに digest がありません。改竄の検出ができないため中止します。GitHub にアップロードし直すと付与されます。".to_string(),
        };
    }

    let order = compare_versions(release.version.as_deref(), Some(&installed.version));

    match order {
        Some(1) => UpdateVerdict::Update {
            reason: format!(
                "{} → {}",
                installed.version,
                release.version.as_deref().unwrap_or_default()
            ),
        },
        Some(-1) => UpdateVerdict::Refuse {
            reason: format!(
                "公開されている {} は、いま入っている {} より古いバージョンです。巻き戻すと現在の作業が失われるため中止します。",
                release.version.as_deref().unwrap_or_default(),
                installed.version
            ),
        },
        Some(_) => {
            // Same version. Only a strictly newer publish date is worth taking,
            // and only because tags cannot currently be ordered.
            let newer = installed
                .published_at
                .as_deref()
                .is_some_and(|installed_at| release.published_at.as_str() > installed_at);

            if newer {
                UpdateVerdict::Update {
                    reason: format!(
                        "バージョンは同じ ({}) ですが、公開日時が新しいものです ({} → {})",
                        release.version.as_deref().unwrap_or_default(),
                        installed.published_at.as_deref().unwrap_or_default(),
                        release.published_at
                    ),
                }
            } else {
                UpdateVerdict::UpToDate { reason: format!("最新です ({})", installed.version) }
            }
        }
        // One side has no parseable version. Refusing is the safe answer:
        // without a version there is no way to tell an upgrade from a downgrade.
        None => UpdateVerdict::Refuse {
            reason: format!(
                "バージョンを比較できないため中止します（リリース: {} / インストール済み: {}）。\n  リリースの zip に okf-release.json が必要です。`bun run release --version x.y.z` で\n  作った zip を添付し直してください。タグ名ではなくこのファイルの version で判定します。",
                release.version.as_deref().unwrap_or("なし"),
                installed.version
            ),
        },
    }
}

/// Whether a path sits inside another.
///
/// Used to prove a bundle is not inside the install directory, so a sibling
/// whose name merely starts with the same characters is *not* inside.
pub fn is_inside(parent: &str, child: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let a = norm(parent);
    let b = norm(child);
    b == a || b.starts_with(&format!("{a}/"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SafetyCheck {
    pub ok: bool,
    pub problems: Vec<String>,
}

/// Refuse to update when doing so would overwrite knowledge.
///
/// The one configuration that turns an update into data loss is a bundle kept
/// inside the application directory, so it is detected rather than hoped against.
pub fn check_safe_to_update(install_dir: &str, known_bundles: &[&str]) -> SafetyCheck {
    let mut problems = Vec::new();

    for bundle in known_bundles {
        if bundle.is_empty() {
            continue;
        }
        if is_inside(install_dir, bundle) {
            problems.push(format!(
                "知識バンドルがアプリのフォルダ内にあります: {bundle}\n  更新はアプリのフォルダを置き換えるため、このままではノートが消えます。\n  バンドルを外（例: ドキュメント）へ移してからやり直してください。"
            ));
        }
    }

    SafetyCheck {
        ok: problems.is_empty(),
        problems,
    }
}

/// Read `sha256:<hex>` into just the lowercase hex, or `None` when it is not that.
pub fn sha256_from_digest(digest: Option<&str>) -> Option<String> {
    let digest = js_trim(digest.filter(|d| !d.is_empty())?);
    // ASCII-only case folding, as JS `/i` without the `u` flag.
    let (prefix, hex) = (digest.get(..7)?, digest.get(7..)?);
    if !prefix.eq_ignore_ascii_case("sha256:") {
        return None;
    }
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(f: impl FnOnce(&mut ReleaseInfo)) -> ReleaseInfo {
        let mut r = ReleaseInfo {
            tag: "v0.3.0".into(),
            name: "v0.3.0".into(),
            notes: "# 変更点\n\n- なにか".into(),
            html_url: "https://example.invalid/releases/v0.3.0".into(),
            published_at: "2026-08-03T12:00:00Z".into(),
            version: Some("0.3.0".into()),
            asset_name: "app.zip".into(),
            asset_url: "https://example.invalid/app.zip".into(),
            asset_size: 1,
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        };
        f(&mut r);
        r
    }

    fn installed(f: impl FnOnce(&mut InstalledInfo)) -> InstalledInfo {
        let mut i = InstalledInfo {
            version: "0.2.0".into(),
            tag: None,
            published_at: Some("2026-08-03T09:00:00Z".into()),
        };
        f(&mut i);
        i
    }

    #[test]
    fn parses_only_real_versions() {
        assert_eq!(parse_version(Some("1.2.3")), Some([1, 2, 3]));
        assert_eq!(parse_version(Some("v0.2.0")), Some([0, 2, 0]));
        // The tags this project has actually used are not versions.
        assert_eq!(parse_version(Some("2026/0803")), None);
        assert_eq!(parse_version(Some("20260802")), None);
        assert_eq!(parse_version(Some("PierrotKnowledge2")), None);
        assert_eq!(parse_version(None), None);
    }

    #[test]
    fn orders_by_component_not_lexically() {
        assert_eq!(compare_versions(Some("0.10.0"), Some("0.9.0")), Some(1));
        assert_eq!(compare_versions(Some("1.0.0"), Some("1.0.0")), Some(0));
        assert_eq!(compare_versions(Some("0.2.0"), Some("0.3.0")), Some(-1));
    }

    #[test]
    fn an_unparseable_version_compares_to_nothing() {
        assert_eq!(compare_versions(Some("2026/0803"), Some("0.2.0")), None);
    }

    #[test]
    fn a_newer_version_is_taken() {
        assert_eq!(
            decide_update(&installed(|_| {}), &release(|_| {})).action(),
            "update"
        );
    }

    #[test]
    fn an_older_version_is_refused_not_installed() {
        let verdict = decide_update(
            &installed(|i| i.version = "0.3.0".into()),
            &release(|r| r.version = Some("0.2.0".into())),
        );
        assert_eq!(verdict.action(), "refuse");
        assert!(verdict.reason().contains("古い"));
    }

    #[test]
    fn the_same_version_with_a_newer_publish_date_is_taken() {
        let verdict = decide_update(
            &installed(|i| {
                i.version = "0.2.0".into();
                i.published_at = Some("2026-08-03T09:00:00Z".into());
            }),
            &release(|r| {
                r.version = Some("0.2.0".into());
                r.published_at = "2026-08-03T12:00:00Z".into();
            }),
        );
        assert_eq!(verdict.action(), "update");
    }

    #[test]
    fn the_same_version_and_an_older_publish_date_is_already_current() {
        let verdict = decide_update(
            &installed(|i| {
                i.version = "0.2.0".into();
                i.published_at = Some("2026-08-03T12:00:00Z".into());
            }),
            &release(|r| {
                r.version = Some("0.2.0".into());
                r.published_at = "2026-08-03T09:00:00Z".into();
            }),
        );
        assert_eq!(verdict.action(), "up-to-date");
        assert_eq!(verdict.reason(), "最新です (0.2.0)");
    }

    #[test]
    fn no_digest_means_no_install() {
        let verdict = decide_update(&installed(|_| {}), &release(|r| r.digest = None));
        assert_eq!(verdict.action(), "refuse");
        assert!(verdict.reason().contains("digest"));
    }

    #[test]
    fn an_unversioned_release_is_refused_rather_than_guessed_at() {
        let verdict = decide_update(&installed(|_| {}), &release(|r| r.version = None));
        assert_eq!(verdict.action(), "refuse");
        assert!(verdict.reason().contains("okf-release.json"));
    }

    #[test]
    fn verdict_serializes_with_action_first() {
        let verdict = UpdateVerdict::UpToDate { reason: "x".into() };
        assert_eq!(
            serde_json::to_string(&verdict).unwrap(),
            r#"{"action":"up-to-date","reason":"x"}"#
        );
    }

    #[test]
    fn a_bundle_inside_the_install_directory_blocks_the_update() {
        let check = check_safe_to_update(
            "C:/apps/PierrotKnowledge2",
            &["C:/apps/PierrotKnowledge2/my-notes"],
        );
        assert!(!check.ok);
        assert!(check.problems[0].contains("my-notes"));
    }

    #[test]
    fn a_bundle_elsewhere_is_fine() {
        let check = check_safe_to_update(
            "C:/apps/PierrotKnowledge2",
            &["C:/Users/me/Documents/OKF Wiki"],
        );
        assert!(check.ok);
    }

    #[test]
    fn a_sibling_that_merely_shares_a_prefix_is_not_inside() {
        assert!(!is_inside(
            "C:/apps/PierrotKnowledge2",
            "C:/apps/PierrotKnowledge2-notes"
        ));
        assert!(is_inside(
            "C:/apps/PierrotKnowledge2",
            "C:/apps/PierrotKnowledge2/wiki"
        ));
    }

    #[test]
    fn case_and_separators_do_not_defeat_the_check_on_windows() {
        assert!(is_inside("C:/apps/App", "c:\\apps\\app\\wiki"));
    }

    #[test]
    fn a_digest_in_another_algorithm_is_not_accepted_as_sha256() {
        assert_eq!(
            sha256_from_digest(Some(&format!("md5:{}", "a".repeat(32)))),
            None
        );
        assert_eq!(sha256_from_digest(Some("sha256:tooshort")), None);
    }

    #[test]
    fn a_sha256_digest_yields_lowercase_hex() {
        let hex = "AB".repeat(32);
        assert_eq!(
            sha256_from_digest(Some(&format!(" SHA256:{hex} "))),
            Some(hex.to_lowercase())
        );
        assert_eq!(sha256_from_digest(None), None);
    }
}
