//! Prebuilt Rust binaries from a GitHub release (`src/bun/native-binary.ts`).
//!
//! What lets an install run without Bun: setup and `Update --rebuild` fetch
//! the build for this platform and version that `.github/workflows/native.yml`
//! attached, and install it only if it matches the digest GitHub computed.

use crate::update::{digest_matches, download_and_hash, GithubSource, ReleaseAsset};
use serde_json::Value;
use std::fs;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GITHUB_API: &str = "https://api.github.com";

/// This machine's platform, by the names the workflow's assets use.
pub fn native_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("windows-x64"),
        ("windows", "aarch64") => Some("windows-arm64"),
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

pub fn native_asset_name(bin: &str, plat: &str) -> String {
    format!("{bin}-{plat}{}", if plat.starts_with("windows") { ".exe" } else { "" })
}

/// Releases have been tagged `V0.5.2`; `bun run release` recommends `v…`.
pub fn release_tags_for(version: &str) -> [String; 2] {
    [format!("V{version}"), format!("v{version}")]
}

/// The named asset, only if GitHub reported a digest to verify it against.
pub fn pick_native_asset<'a>(assets: &'a [ReleaseAsset], name: &str) -> Option<&'a ReleaseAsset> {
    assets.iter().find(|a| {
        a.name.as_deref() == Some(name)
            && a.browser_download_url.as_deref().is_some_and(|u| !u.is_empty())
            && a.digest.as_deref().is_some_and(|d| !d.is_empty())
    })
}

fn release_assets(source: &GithubSource, version: &str) -> Vec<ReleaseAsset> {
    // A setup on a black-holed network has to fall back, not hang.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(15)))
        .build()
        .into();
    for tag in release_tags_for(version) {
        let url = format!("{GITHUB_API}/repos/{}/{}/releases/tags/{tag}", source.owner, source.repo);
        let Ok(mut response) = agent
            .get(&url)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
            .call()
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        // A captive portal answers 200 with HTML; that is "no release", not a crash.
        let Some(body) = response.body_mut().read_to_string().ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
        else {
            continue;
        };
        return body
            .get("assets")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(ReleaseAsset::from_json).collect())
            .unwrap_or_default();
    }
    Vec::new()
}

/// The newest release's version, from its tag (`v1.2.3` or `V1.2.3`).
pub fn latest_version(source: &GithubSource) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(15)))
        .build()
        .into();
    let url = format!("{GITHUB_API}/repos/{}/{}/releases/latest", source.owner, source.repo);
    let mut response = agent
        .get(&url)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28")
        .call()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let body: Value = response
        .body_mut()
        .read_to_string()
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or("GitHub の応答を読めませんでした")?;
    let tag = body.get("tag_name").and_then(Value::as_str).unwrap_or("");
    let version = tag.trim_start_matches(['v', 'V']);
    crate::shared::update::parse_version(Some(version))
        .map(|_| version.to_string())
        .ok_or_else(|| format!("リリースのタグが版として読めません: {tag}"))
}

/// Whether the binary starts on this machine. The digest proves it is the
/// file the release published, not that this system can run it (a Linux
/// build against a newer glibc fails only when spawned). The server exits 0
/// on end of input; the CLI on `help`.
fn starts_here(path: &str, bin: &str) -> bool {
    // Windows Defender holds a freshly written executable while it scans it.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut command = Command::new(path);
        if bin == "okf" {
            command.arg("help");
        }
        let spawned = command.env("OKF_BUNDLE", "").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
        match spawned {
            Ok(mut child) => {
                let until = Instant::now() + Duration::from_secs(10);
                while Instant::now() < until {
                    if let Ok(Some(status)) = child.try_wait() {
                        return status.success();
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                let _ = child.kill();
                return false;
            }
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return false,
        }
    }
}

/// Download the prebuilt `bin` for this machine and `version` to `to`.
/// Every `Err` is a reason to fall back, never a half-written file.
pub fn download_native_binary(source: &GithubSource, bin: &str, version: &str, to: &str) -> Result<(), String> {
    let plat = native_platform()
        .ok_or_else(|| format!("{}-{} 向けのビルド済みバイナリはありません", std::env::consts::OS, std::env::consts::ARCH))?;
    let name = native_asset_name(bin, plat);
    let assets = release_assets(source, version);
    let asset = pick_native_asset(&assets, &name).ok_or_else(|| format!("リリース {version} に {name} がありません"))?;

    let result = (|| {
        let (sha256, _) = download_and_hash(asset.browser_download_url.as_deref().unwrap_or(""), to, None)?;
        if !digest_matches(asset.digest.as_deref(), &sha256) {
            return Err(format!("{name} のハッシュが一致しません（破損または改ざんの可能性）"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(to, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        if !starts_here(to, bin) {
            return Err(format!("{name} がこのマシンで起動しません"));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(to);
    }
    result
}

/// Move `staged` over `target`, parking a running `target` as `<target>.old`.
///
/// Windows will not overwrite a running executable but will rename one: the
/// process using it keeps its image and the next start gets the new build.
/// The parked copy is removed by the next install that can.
pub fn install_binary(staged: &str, target: &str) -> Result<(), String> {
    let parked = format!("{target}.old");
    let _ = fs::remove_file(&parked);
    if fs::rename(staged, target).is_ok() {
        return Ok(());
    }
    fs::rename(target, &parked).map_err(|e| format!("{target} を置き換えられません（使用中）: {e}"))?;
    // An antivirus or indexer can hold the new file for a moment.
    let mut failure = String::new();
    for _ in 0..5 {
        match fs::rename(staged, target) {
            Ok(()) => return Ok(()),
            Err(e) => failure = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Never leave hosts with nothing to start; if even that fails, say where
    // the working binary went.
    match fs::rename(&parked, target) {
        Ok(()) => Err(failure),
        Err(_) => Err(format!("{failure}\n  元の実行ファイルは {parked} にあります。{target} に名前を戻してください。")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn names_assets_as_the_workflow_does() {
        assert_eq!(native_asset_name("okf", "windows-x64"), "okf-windows-x64.exe");
        assert_eq!(native_asset_name("okf-mcp", "linux-x64"), "okf-mcp-linux-x64");
        assert_eq!(release_tags_for("0.8.2"), ["V0.8.2".to_string(), "v0.8.2".to_string()]);
    }

    #[test]
    fn only_an_asset_with_a_digest_is_picked() {
        let mut bare = ReleaseAsset::named("okf-linux-x64");
        bare.browser_download_url = Some("https://x/okf".into());
        assert!(pick_native_asset(std::slice::from_ref(&bare), "okf-linux-x64").is_none());
        let mut signed = bare.clone();
        signed.digest = Some("sha256:00".into());
        assert!(pick_native_asset(&[bare, signed], "okf-linux-x64").is_some_and(|a| a.digest.is_some()));
    }

    #[test]
    fn install_replaces_and_clears_a_parked_copy() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("okf").to_string_lossy().into_owned();
        let staged = dir.path().join("okf.new").to_string_lossy().into_owned();
        fs::write(&target, "old").unwrap();
        fs::write(format!("{target}.old"), "stale").unwrap();
        fs::write(&staged, "new").unwrap();
        install_binary(&staged, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(!Path::new(&format!("{target}.old")).exists());
    }
}
