//! What setup and the one-touch update need from an install, so neither has
//! to start Bun: `init-bundle` (`scripts/init-bundle.ts`), `connect-agent`
//! (`scripts/connect-agent.ts`), the `--confirm` question and `--rebuild`.

use crate::connect::targets::{connect_all_targets, connect_target, find_target, ConnectAllOptions, ConnectOptions, TargetKind};
use crate::native_binary::{download_native_binary, install_binary, latest_version};
use crate::shared::app::APP_NAME;
use crate::shared::update::compare_versions;
use crate::okf::nodepath;
use crate::okf::scaffold::scaffold_bundle;
use crate::shared::connect_types::BulkConnectStatus;
use crate::update::{stale_compiled_artifacts, GithubSource};
use crate::workspace::{Workspace, WorkspaceOptions};
use std::io::{BufRead, Write};
use std::path::Path;

/// Whether a console answer is consent. Only an explicit yes: a stray Enter
/// or a closed console must leave the machine as it was.
pub fn is_consent(answer: Option<&str>) -> bool {
    answer.is_some_and(|a| matches!(a.trim().to_lowercase().as_str(), "y" | "yes" | "はい"))
}

/// Ask once, for the `--confirm` mode that UPDATE.bat and UNINSTALL.bat use.
pub fn ask_consent(question: &str) -> bool {
    print!("{question} [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let read = std::io::stdin().lock().read_line(&mut line).ok().filter(|&n| n > 0).map(|_| line.as_str());
    let yes = is_consent(read);
    if !yes {
        println!("何も変更せずに終了します。");
    }
    yes
}

/// Create (or top up) a bundle and index it, so the first launch is instant.
pub fn init_bundle(target: &str) -> Result<(), String> {
    let root = nodepath::resolve1(target);
    let scaffold = scaffold_bundle(&root).map_err(|e| e.to_string())?;
    if scaffold.created.is_empty() {
        println!("    Bundle already set up — nothing to add");
    } else {
        println!("    Created: {}", scaffold.created.join(", "));
    }
    let mut workspace = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    let info = workspace.open(&root).map_err(|e| e.to_string())?;
    // Scaffolding writes index.md before the concepts exist, and `open` will
    // not overwrite it, so without this the starter index lists nothing.
    let rows = workspace.rebuild_index().map_err(|e| e.to_string())?;
    let stats = workspace.index_stats().map_err(|e| e.to_string())?;
    println!("    Indexed {rows} concept(s), {} chunk(s) at {}", stats.chunks, info.root);
    if info.non_conformant_count > 0 {
        println!("    {} document(s) do not meet OKF v0.2 — see the app", info.non_conformant_count);
    }
    workspace.close();
    Ok(())
}

/// Register the bundle's MCP server with one host, or with every host found
/// (`--all`). The exit code counts only genuine failures.
pub fn connect_agent(target_id: &str, bundle: &str, project_root: &str) -> i32 {
    let bundle_root = nodepath::resolve1(bundle);
    if target_id == "--all" {
        let outcomes = connect_all_targets(&ConnectAllOptions {
            project_root,
            bundle_root: &bundle_root,
            include_missing: false,
            targets: None,
            probe_installed: None,
        });
        for o in &outcomes {
            match o.status {
                BulkConnectStatus::Skipped => {}
                BulkConnectStatus::Manual => {
                    let how = if o.snippet == Some(true) { "次の JSON を貼り付けてください" } else { "次のコマンドを実行してください" };
                    println!("  {}: {how}", o.label);
                    let command = o.command.as_deref().unwrap_or("");
                    println!("{}", command.lines().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n"));
                }
                BulkConnectStatus::Failed => eprintln!("  {}: {}", o.label, o.reason.as_deref().unwrap_or("")),
                BulkConnectStatus::Connected | BulkConnectStatus::Unchanged => {
                    let note = if o.status == BulkConnectStatus::Unchanged { " (既に設定済み)" } else { "" };
                    println!("  {}: {}{note}", o.label, o.path);
                }
            }
        }
        let count = |s: BulkConnectStatus| outcomes.iter().filter(|o| o.status == s).count();
        println!(
            "\n  {} 件を設定しました（未インストール {} 件は対象外）",
            count(BulkConnectStatus::Connected) + count(BulkConnectStatus::Unchanged),
            count(BulkConnectStatus::Skipped)
        );
        return i32::from(outcomes.iter().any(|o| o.status == BulkConnectStatus::Failed));
    }

    let target = match find_target(target_id) {
        Ok(target) => target,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    if target.kind != TargetKind::McpHost {
        // A no-op success, so a caller looping over every runtime need not special-case them.
        println!("{} is a model server — nothing to configure", target.label);
        return 0;
    }
    match connect_target(&ConnectOptions { target_id, project_root, bundle_root: &bundle_root, target: None }) {
        Ok(result) => {
            let suffix = if result.unchanged {
                " (既に設定済み)".to_string()
            } else {
                result.backup.map(|b| format!(" (backup: {b})")).unwrap_or_default()
            };
            println!("{}{suffix}", result.path);
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

/// Bring `build/` level with freshly installed source: the view ships
/// prebuilt in the release, so only the binaries built here before are
/// replaced, by the verified Rust builds for `version`. Each runs even when
/// another fails. Returns whether everything is current.
pub fn rebuild_native(install_dir: &str, version: &str) -> bool {
    let source = GithubSource::default_source();
    let mut ok = true;
    let exe = if cfg!(windows) { ".exe" } else { "" };
    for artefact in stale_compiled_artifacts(install_dir) {
        let bin = if artefact.path.contains("headless") { "okf-mcp" } else { "okf" };
        let staged = format!("{}.download{exe}", &artefact.path[..artefact.path.len() - exe.len()]);
        println!("\n▶ {bin} {version} を取得: {}", artefact.path);
        let done = download_native_binary(&source, bin, version, &staged).and_then(|()| install_binary(&staged, &artefact.path));
        if let Err(reason) = done {
            ok = false;
            eprintln!("  失敗: {reason}\n  開発環境なら次でビルドできます: {}", artefact.rebuild);
        }
    }
    if !Path::new(&nodepath::join(&[install_dir, "src", "mainview", "dist", "index.html"])).is_file() {
        ok = false;
        eprintln!("\n⚠ このリリースには画面のビルドが入っていません。次を実行してください:\n  bun install\n  bun run build:view");
    }
    if ok {
        println!("\nビルドまで完了しました。アプリを開き直すと新しい版で動きます。");
    }
    ok
}

// ---------------------------------------------------------------------------
// Standalone install: `okf` alone is the application. The page and the icon
// are compiled in, MCP hosts start `okf serve`, and these two commands are
// what setup scripts and an updater archive used to be.
// ---------------------------------------------------------------------------

/// The running binary and the folder it is in.
fn exe_and_dir() -> Result<(String, String), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let dir = nodepath::dirname(&exe);
    Ok((exe, dir))
}

/// A folder a file can really be written into. Creating it is not proof: a
/// Documents junction whose target is gone reports success and stores nothing.
fn writable_dir(path: &str) -> bool {
    let probe = nodepath::join(&[path, ".okf-write-test"]);
    std::fs::create_dir_all(path).is_ok() && std::fs::write(&probe, "ok").is_ok() && std::fs::remove_file(&probe).is_ok()
}

/// Where a first bundle goes: Documents when it works, else the home folder.
fn default_bundle_dir(home: &str) -> Option<String> {
    let mut roots = vec![nodepath::join(&[home, "Documents"])];
    if let Some(onedrive) = std::env::var("OneDrive").ok().filter(|v| !v.is_empty()) {
        roots.push(nodepath::join(&[&onedrive, "Documents"]));
    }
    roots.push(home.to_string());
    // Only the app folder is ours to create, never a missing Documents.
    roots.into_iter().filter(|r| Path::new(r).is_dir()).map(|r| nodepath::join(&[&r, APP_NAME])).find(|c| writable_dir(c))
}

/// A Desktop icon that runs `okf ui --bundle <bundle>`. Returns its path.
/// Names match what `uninstall` looks for (`launcher_paths_on`).
#[cfg(windows)]
fn create_shortcut(exe: &str, dir: &str, bundle: &str, icon: Option<&str>, _home: &str) -> Result<String, String> {
    // .lnk files are written through COM, and PowerShell is the COM client
    // every Windows has. Values travel as environment variables, so no path
    // needs quoting. WindowStyle 7: the console is the server, kept minimised.
    const SCRIPT: &str = "$l=Join-Path ([Environment]::GetFolderPath('Desktop')) ($env:OKF_NAME+'.lnk');$s=(New-Object -ComObject WScript.Shell).CreateShortcut($l);$s.TargetPath=$env:OKF_EXE;$s.Arguments=$env:OKF_ARGS;$s.WorkingDirectory=$env:OKF_DIR;$s.WindowStyle=7;if($env:OKF_ICON){$s.IconLocation=$env:OKF_ICON};$s.Save();$l";
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("OKF_NAME", APP_NAME)
        .env("OKF_EXE", exe)
        .env("OKF_ARGS", format!("ui --bundle \"{bundle}\""))
        .env("OKF_DIR", dir)
        .env("OKF_ICON", icon.unwrap_or(""))
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(unix)]
fn write_executable(path: &str, content: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, content).map_err(|e| format!("{path}: {e}"))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("{path}: {e}"))
}

#[cfg(target_os = "macos")]
fn create_shortcut(exe: &str, _dir: &str, bundle: &str, _icon: Option<&str>, home: &str) -> Result<String, String> {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let desktop = crate::uninstall::desktop_directories(home)
        .into_iter()
        .find(|d| Path::new(d).is_dir())
        .ok_or("デスクトップが見つかりません")?;
    let path = nodepath::join(&[&desktop, &format!("{APP_NAME}.command")]);
    write_executable(&path, &format!("#!/usr/bin/env bash\nexec {} ui --bundle {}\n", quote(exe), quote(bundle)))?;
    Ok(path)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn create_shortcut(exe: &str, _dir: &str, bundle: &str, icon: Option<&str>, home: &str) -> Result<String, String> {
    // Always in the app menu; on the Desktop too when there is one (servers,
    // WSL and some tiling desktops have none).
    let field = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME}\nComment=OKF v0.2 local knowledge base for humans and agents\nExec=\"{}\" ui --bundle \"{}\"\nIcon={}\nTerminal=true\nCategories=Office;Utility;\n",
        field(exe),
        field(bundle),
        icon.unwrap_or("")
    );
    let apps = nodepath::join(&[home, ".local", "share", "applications"]);
    std::fs::create_dir_all(&apps).map_err(|e| format!("{apps}: {e}"))?;
    let menu = nodepath::join(&[&apps, "okf-wiki.desktop"]);
    write_executable(&menu, &entry)?;
    let Some(desktop) = crate::uninstall::desktop_directories(home).into_iter().find(|d| Path::new(d).is_dir()) else {
        return Ok(menu);
    };
    let path = nodepath::join(&[&desktop, "okf-wiki.desktop"]);
    write_executable(&path, &entry)?;
    // Newer GNOME refuses to run a .desktop file it does not trust.
    let _ = std::process::Command::new("gio")
        .args(["set", path.as_str(), "metadata::trusted", "true"])
        .stderr(std::process::Stdio::null())
        .status();
    Ok(path)
}

/// `okf setup`: a starter bundle, a Desktop icon and (with `--connect`) every
/// agent host found. Safe to re-run; nothing already present is overwritten.
pub fn setup(bundle: Option<&str>, shortcut: bool, connect: bool) -> i32 {
    let (exe, dir) = match exe_and_dir() {
        Ok(found) => found,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let home = std::env::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let Some(bundle) = bundle.map(String::from).or_else(|| default_bundle_dir(&home)) else {
        eprintln!("バンドルを置ける場所が見つかりません。--bundle <path> で指定してください。");
        return 1;
    };
    let bundle = nodepath::resolve1(&bundle);

    println!("==> 知識バンドル: {bundle}");
    if let Err(error) = init_bundle(&bundle) {
        eprintln!("{error}");
        return 1;
    }

    // Uninstall finds bundles through the session. Never repoint an existing one.
    if crate::state::load_session().bundle_path.is_none_or(|p| p.is_empty()) {
        crate::state::update_session(&crate::state::SessionState { bundle_path: Some(bundle.clone()), ..Default::default() });
    }

    let (icon_name, icon_bytes) =
        if cfg!(windows) { ("icon.ico", crate::embedded::ICON_ICO) } else { ("icon.png", crate::embedded::ICON_PNG) };
    let icon = Some(nodepath::join(&[&dir, icon_name]))
        .filter(|path| !icon_bytes.is_empty() && std::fs::write(path, icon_bytes).is_ok());

    if shortcut {
        match create_shortcut(&exe, &dir, &bundle, icon.as_deref(), &home) {
            Ok(path) => println!("==> ショートカット: {path}"),
            Err(error) => eprintln!("    ショートカットを作成できませんでした: {error}"),
        }
    }

    let mut code = 0;
    if connect {
        println!("==> エージェントに登録");
        code = connect_agent("--all", &bundle, &dir);
    }

    println!("\n  起動:     \"{exe}\" ui --bundle \"{bundle}\"");
    println!("  更新:     \"{exe}\" update --apply");
    println!("  削除:     \"{exe}\" uninstall");
    if !connect {
        println!("  エージェント（Claude Code, Codex など）に登録: \"{exe}\" setup --connect");
    }
    code
}

/// `okf update` for a standalone install: replace this binary with the newest
/// release's, verified against GitHub's digest and test-started first. A
/// running copy is parked as `.old` and keeps working until it exits.
pub fn self_update(apply: bool, confirm: bool) -> i32 {
    let source = GithubSource::default_source();
    let current = crate::VERSION;
    let latest = match latest_version(&source) {
        Ok(version) => version,
        Err(reason) => {
            eprintln!("最新リリースを確認できませんでした: {reason}");
            return 1;
        }
    };
    if compare_versions(Some(&latest), Some(current)) != Some(1) {
        println!("最新です（{current}）。");
        return 0;
    }
    println!("新しい版があります: {current} → {latest}");
    println!("  https://github.com/{}/{}/releases/latest", source.owner, source.repo);
    if !(apply || confirm && ask_consent("\n更新しますか？")) {
        if !confirm {
            println!("\n実行するには:\n  okf update --apply");
        }
        return 0;
    }

    let (exe, _) = match exe_and_dir() {
        Ok(found) => found,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let staged = format!("{}.download{suffix}", exe.strip_suffix(suffix).unwrap_or(&exe));
    match download_native_binary(&source, "okf", &latest, &staged).and_then(|()| install_binary(&staged, &exe)) {
        Ok(()) => {
            println!("\n{latest} に更新しました。アプリを開き直すと新しい版で動きます。");
            0
        }
        Err(reason) => {
            eprintln!("更新できませんでした: {reason}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_bundle_goes_to_documents_and_falls_back_to_home() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().to_string_lossy().into_owned();
        // No Documents: the home folder itself, never a conjured Documents.
        assert_eq!(default_bundle_dir(&root), Some(nodepath::join(&[&root, APP_NAME])));
        assert!(!home.path().join("Documents").exists());
        std::fs::create_dir(home.path().join("Documents")).unwrap();
        assert_eq!(default_bundle_dir(&root), Some(nodepath::join(&[&root, "Documents", APP_NAME])));
    }

    #[test]
    fn only_an_explicit_yes_is_consent() {
        for yes in ["y", "Y", " yes ", "はい"] {
            assert!(is_consent(Some(yes)), "{yes}");
        }
        for no in ["", "n", "ok", "yes please"] {
            assert!(!is_consent(Some(no)), "{no}");
        }
        assert!(!is_consent(None));
    }

    #[test]
    fn init_bundle_scaffolds_and_indexes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("b").to_string_lossy().into_owned();
        init_bundle(&root).unwrap();
        assert!(Path::new(&root).join("wiki/index.md").is_file());
        assert!(Path::new(&root).join(".rag").is_dir());
        // Idempotent.
        init_bundle(&root).unwrap();
    }
}
