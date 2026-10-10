//! Removing this application, without removing what it was holding
//! (`src/bun/uninstall.ts`).
//!
//! Uninstalling is the most dangerous thing here. The knowledge bundle is
//! ordinary files in an ordinary folder, and a folder is exactly what an
//! uninstaller deletes, so the entire design is about making that impossible
//! rather than merely unlikely:
//!
//! * **Nothing is deleted without applying the plan.** The default is a plan.
//! * **Bundles are named in the plan as things that will survive**, so the
//!   user sees their notes are safe before agreeing to anything.
//! * **A bundle inside the install directory aborts the whole operation.**
//!   There, removing the app *is* removing the notes.
//! * **The install directory is not deleted by this code at all.** The user
//!   deletes it, after the app has stopped.
//!
//! What it does do is the part a person cannot easily do by hand: take our
//! entry back out of every agent host's config. Left behind, each of those
//! reports a broken MCP server on every launch.

use crate::app_paths::{app_data_path, app_data_read_paths};
use crate::connect::targets::{
    connect_targets, run_invocation, CliInvocation, ConfigFormat, ConnectTarget, SERVER_NAME,
};
use crate::okf::error as fsx;
use crate::okf::nodepath;
use crate::shared::js_compat::{js_regex, js_trim};
use crate::shared::update::is_inside;
use std::collections::HashSet;
use std::fs;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UninstallAction {
    /// Delete.
    Remove,
    /// Take our entry out and leave the file.
    Edit,
    /// Ask the tool to undo its own registration. A tool that registered us
    /// through its own CLI keeps state beside the config entry (enabled tool
    /// lists, OAuth tokens), and deleting the entry by hand leaves it behind.
    Run,
}

impl UninstallAction {
    /// The TS `action` string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Remove => "remove",
            Self::Edit => "edit",
            Self::Run => "run",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallItem {
    /// What it is, in the user's terms.
    pub what: String,
    pub path: String,
    pub action: UninstallAction,
    /// For `Run`: the command, and anything its prompt needs on stdin.
    pub command: Option<CliInvocation>,
    /// Which dialect to edit, carried from the plan rather than re-derived when
    /// applying: re-deriving meant matching a config path back to a target,
    /// and a near miss edits the wrong file or silently does nothing.
    pub format: Option<ConfigFormat>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallPlan {
    /// Things this will act on.
    pub items: Vec<UninstallItem>,
    /// Paths that will be left exactly as they are, and said so out loud.
    pub preserved: Vec<String>,
    /// Reasons the whole thing must not proceed.
    pub blockers: Vec<String>,
    /// The folder the user deletes by hand once the app has stopped.
    pub install_dir: String,
}

#[derive(Debug, Clone, Default)]
pub struct UninstallOptions {
    pub install_dir: String,
    /// Every bundle this app knows about.
    pub known_bundles: Vec<String>,
    /// Also remove the session and the MCP server registry.
    pub purge_settings: bool,
    /// Desktop and menu launchers, when any exist.
    pub launcher_paths: Vec<String>,
}

/// Whether there is anything at this path to act on.
///
/// `lstat`, not `stat`: these paths are about to be unlinked, and a dead
/// symlink (the pre-0.5.0 macOS launcher) must still count as there.
fn exists(path: &str) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Whether a target keeps its config inside the knowledge bundle.
///
/// Asked of the target rather than declared on it, so a bundle-scoped host
/// added later cannot be missed by forgetting a flag. Two probes: a path that
/// changes with the bundle root is one that lives under it.
fn is_bundle_scoped(target: &ConnectTarget) -> bool {
    target.config_path("/okf-probe-a") != target.config_path("/okf-probe-b")
}

/// Work out what would happen, touching nothing.
pub fn plan_uninstall(options: &UninstallOptions) -> UninstallPlan {
    plan_uninstall_with(options, connect_targets())
}

/// [`plan_uninstall`] over an explicit catalogue, so tests stay out of the
/// real home directory.
pub fn plan_uninstall_with(options: &UninstallOptions, targets: &[ConnectTarget]) -> UninstallPlan {
    let mut items: Vec<UninstallItem> = Vec::new();
    let mut preserved: Vec<String> = Vec::new();
    let mut blockers: Vec<String> = Vec::new();

    // The bundles. Named first and named as survivors, because that is the
    // question anyone uninstalling this actually has.
    //
    // Deduplicated on a normalised form: the same folder arrives twice, once
    // from the saved session and once from OKF_BUNDLE, differing only in slash
    // direction.
    let mut seen: HashSet<String> = HashSet::new();
    for bundle in &options.known_bundles {
        if bundle.is_empty() {
            continue;
        }
        let key = bundle.replace('\\', "/").trim_end_matches('/').to_lowercase();
        if !seen.insert(key) {
            continue;
        }

        if is_inside(&options.install_dir, bundle) {
            blockers.push(format!(
                "知識バンドルがアプリのフォルダ内にあります: {bundle}\n  アプリを消すとノートも消えます。先に外（例: ドキュメント）へ移動してください。"
            ));
            continue;
        }
        preserved.push(bundle.clone());
    }

    // Every bundle, not just the first: three of the targets keep their config
    // *inside* the bundle, so which bundle we ask about decides which
    // registrations get cleaned up. Relative roots are skipped, since a
    // relative path would resolve against the process's own directory.
    let bundle_roots: Vec<&str> = options
        .known_bundles
        .iter()
        .map(String::as_str)
        .filter(|b| !b.is_empty() && nodepath::is_absolute(b))
        .collect();
    let mut seen_configs: HashSet<String> = HashSet::new();

    for target in targets {
        // A target whose path does not depend on the bundle still has to be
        // swept once, which is what the empty-string case is for.
        let roots: Vec<&str> = if is_bundle_scoped(target) {
            bundle_roots.clone()
        } else {
            vec![bundle_roots.first().copied().unwrap_or("")]
        };

        for root in roots {
            let path = target.config_path(root);
            // The same file can be named by two targets, or by two bundles.
            if !seen_configs.insert(path.clone()) {
                continue;
            }

            if let Some(cli_remove) = &target.cli_remove {
                // Only if we are actually in there: `hermes mcp remove` on an
                // absent server is a failure, and a plan that always fails is
                // worse than one that leaves nothing behind.
                let existing = fsx::read_text(&path).ok();
                if !existing.as_deref().is_some_and(|t| t.contains(SERVER_NAME)) {
                    continue;
                }
                items.push(UninstallItem {
                    what: format!("{} の設定から MCP エントリを削除", target.label),
                    path,
                    action: UninstallAction::Run,
                    command: Some(cli_remove(SERVER_NAME)),
                    format: None,
                });
                continue;
            }

            let Some(format) = target.format else { continue };
            if !exists(&path) {
                continue;
            }
            let existing = fsx::read_text(&path).ok();
            if format.remove(existing.as_deref(), SERVER_NAME).is_none() {
                continue;
            }
            items.push(UninstallItem {
                what: format!("{} の設定から MCP エントリを削除", target.label),
                path,
                action: UninstallAction::Edit,
                command: None,
                format: Some(format),
            });
        }
    }

    for launcher in &options.launcher_paths {
        if !exists(launcher) {
            continue;
        }
        items.push(UninstallItem {
            what: "ランチャー / ショートカット".into(),
            path: launcher.clone(),
            action: UninstallAction::Remove,
            command: None,
            format: None,
        });
    }

    // The script setup writes for the desktop shortcuts to run. It lives inside
    // the install directory, which the user deletes by hand, but it is listed so
    // the plan accounts for everything setup created.
    let launch_script = nodepath::join(&[&options.install_dir, ".launch-ui.sh"]);
    if exists(&launch_script) {
        items.push(UninstallItem {
            what: "起動スクリプト".into(),
            path: launch_script,
            action: UninstallAction::Remove,
            command: None,
            format: None,
        });
    }

    // App data holds the session pointer and the registry of external MCP
    // servers. Neither is knowledge, but the registry is work the user did, so
    // it goes only when asked.
    for file in ["session.json", "mcp-servers.json", "runtimes.json"] {
        let path = app_data_path(file);
        if !exists(&path) {
            continue;
        }
        if options.purge_settings {
            items.push(UninstallItem {
                what: format!("設定 ({file})"),
                path,
                action: UninstallAction::Remove,
                command: None,
                format: None,
            });
        } else {
            preserved.push(path);
        }
    }

    UninstallPlan { items, preserved, blockers, install_dir: options.install_dir.clone() }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UninstallResult {
    pub done: Vec<String>,
    pub failed: Vec<UninstallFailure>,
    /// Backups taken before editing someone else's config.
    pub backups: Vec<String>,
}

/// `rm(path, { recursive: true, force: true })`.
fn remove_force(path: &str) -> Result<(), String> {
    let Ok(meta) = fs::symlink_metadata(path) else { return Ok(()) };
    let result = if meta.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Carry out a plan.
///
/// Every config this edits belongs to another tool, so each one is moved aside
/// first, the same courtesy connecting extends, for the same reason.
pub fn apply_uninstall(plan: &UninstallPlan) -> Result<UninstallResult, String> {
    if !plan.blockers.is_empty() {
        return Err(format!("中止しました:\n{}", plan.blockers.join("\n")));
    }

    let mut result = UninstallResult::default();

    for item in &plan.items {
        let outcome = (|| -> Result<bool, String> {
            match item.action {
                UninstallAction::Remove => {
                    // Recursive because a launcher is not always a file: the
                    // macOS `.app` from a pre-0.5.0 install is a directory.
                    remove_force(&item.path)?;
                    Ok(true)
                }
                UninstallAction::Run => {
                    let Some(command) = &item.command else { return Ok(false) };
                    let out = run_invocation(command)?;
                    if out.code != 0 {
                        let stderr = js_trim(&out.stderr);
                        return Err(if stderr.is_empty() { item.what.clone() } else { stderr.to_string() });
                    }
                    Ok(true)
                }
                UninstallAction::Edit => {
                    let Some(format) = item.format else { return Ok(false) };
                    let existing = fsx::read_text(&item.path).map_err(|e| e.to_string())?;
                    let Some(next) = format.remove(Some(&existing), SERVER_NAME) else {
                        return Ok(false);
                    };
                    let backup = format!("{}.okf-backup-{}", item.path, now_ms());
                    fsx::rename(&item.path, &backup).map_err(|e| e.to_string())?;
                    // Another tool's config: a failed write must not leave it
                    // with none, so the original goes back where it was.
                    if let Err(error) = fsx::write_text(&item.path, &next) {
                        let _ = fsx::rename(&backup, &item.path);
                        return Err(error.to_string());
                    }
                    result.backups.push(backup);
                    Ok(true)
                }
            }
        })();

        match outcome {
            Ok(true) => result.done.push(item.what.clone()),
            Ok(false) => {}
            Err(reason) => result.failed.push(UninstallFailure { path: item.path.clone(), reason }),
        }
    }

    Ok(result)
}

/// Every launcher `setup` might have created, on this platform.
///
/// More than one candidate per platform because setup has branched over time
/// and an install predating this version is still an install: macOS now always
/// writes a `.command`, but a symlinked `.app` exists on any machine set up
/// before the desktop build was removed at 0.5.0, and Linux gets a `.desktop`
/// file on the Desktop *and* a copy in the applications menu. The Linux files
/// are still named `okf-wiki.desktop` in older setups, so both names are
/// looked for.
pub fn launcher_paths_for(app_name: &str, desktop_dirs: Option<&[String]>) -> Vec<String> {
    let home = std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok());
    let Some(home) = home.filter(|h| !h.is_empty()) else { return Vec::new() };

    let desktops: Vec<String> = match desktop_dirs {
        Some(dirs) if !dirs.is_empty() => dirs.to_vec(),
        _ => desktop_directories(&home),
    };
    launcher_paths_on(std::env::consts::OS, &home, app_name, &desktops)
}

/// [`launcher_paths_for`] for an explicit platform (`windows`, `macos`, other).
pub fn launcher_paths_on(os: &str, home: &str, app_name: &str, desktops: &[String]) -> Vec<String> {
    if os == "windows" {
        return desktops
            .iter()
            .map(|d| nodepath::join(&[d, &format!("{app_name}.lnk")]))
            .collect();
    }
    if os == "macos" {
        return desktops
            .iter()
            .flat_map(|d| {
                [
                    nodepath::join(&[d, &format!("{app_name}.app")]),
                    nodepath::join(&[d, &format!("{app_name}.command")]),
                ]
            })
            .collect();
    }

    let applications = nodepath::join(&[home, ".local", "share", "applications"]);
    let mut paths: Vec<String> = desktops
        .iter()
        .flat_map(|d| {
            [
                nodepath::join(&[d, "okf-wiki.desktop"]),
                nodepath::join(&[d, &format!("{app_name}.desktop")]),
            ]
        })
        .collect();
    paths.push(nodepath::join(&[&applications, "okf-wiki.desktop"]));
    paths.push(nodepath::join(&[&applications, &format!("{app_name}.desktop")]));
    paths
}

/// Every directory that might be the desktop, current setting first.
///
/// `~/Desktop` is only the desktop on an English-locale machine: a Japanese
/// GNOME puts it at `~/デスクトップ`. All candidates are returned rather than
/// just the configured one, because the setting can have changed since the
/// launcher was written, and every path here is only ever probed for existence
/// before being touched.
pub fn desktop_directories(home: &str) -> Vec<String> {
    desktop_directories_with(
        home,
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("XDG_DESKTOP_DIR").ok().as_deref(),
    )
}

/// [`desktop_directories`] with the two environment variables passed in.
pub fn desktop_directories_with(home: &str, xdg_config_home: Option<&str>, xdg_desktop_dir: Option<&str>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut add = |dir: Option<String>| {
        if let Some(dir) = dir.filter(|d| !d.is_empty()) {
            if !found.contains(&dir) {
                found.push(dir);
            }
        }
    };

    add(read_xdg_desktop_dir(home, xdg_config_home));
    add(xdg_desktop_dir.map(String::from));
    add(Some(nodepath::join(&[home, "Desktop"])));
    found
}

/// The desktop from `user-dirs.dirs`, read rather than shelled out to:
/// `xdg-user-dir` is a binary that minimal installs do not carry, but the file
/// it reads is plain text and always present when the setting exists.
fn read_xdg_desktop_dir(home: &str, xdg_config_home: Option<&str>) -> Option<String> {
    let config = match xdg_config_home {
        Some(c) => c.to_string(),
        None => nodepath::join(&[home, ".config"]),
    };
    let text = fsx::read_text(&nodepath::join(&[&config, "user-dirs.dirs"])).ok()?;

    let line = js_regex(r#"(?m)^<S>*XDG_DESKTOP_DIR<S>*=<S>*"([^"]*)""#);
    let raw = line.captures(&text)?.get(1)?.as_str().trim_end_matches('/').to_string();
    if raw.is_empty() {
        return None;
    }

    // The file writes the home-relative form as `$HOME/Desktop`. Rejoined
    // rather than concatenated so the result carries this platform's separator.
    if let Some(rest) = raw.strip_prefix("$HOME") {
        if rest.is_empty() || rest.starts_with('/') {
            return Some(nodepath::join(&[home, rest.trim_start_matches('/')]));
        }
    }
    Some(raw)
}

/// Every app-data location, including the pre-rename one.
pub fn app_data_locations(file: &str) -> Vec<String> {
    app_data_read_paths(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connect::merge::{
        merge_hermes_yaml, merge_mcp_json, merge_opencode_json, remove_from_codex_toml,
        remove_from_hermes_yaml, remove_from_mcp_json, remove_from_opencode_json, StdioServer,
    };
    use crate::connect::targets::TargetKind;

    fn server() -> StdioServer {
        StdioServer::new("bun", &["run", "C:/proj/standalone.ts"], &[("OKF_BUNDLE", "C:/notes")])
    }

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    // ---- taking our entry back out (the merge module's removers)

    #[test]
    fn mcp_json_ours_goes_everything_else_stays() {
        let existing = r#"{"mcpServers":{"notion":{"command":"npx","args":["-y","notion"]},"okf-wiki":{"command":"old"}},"otherSetting":{"keep":true}}"#;
        let parsed = json(&remove_from_mcp_json(Some(existing), "okf-wiki").unwrap());
        assert!(parsed["mcpServers"].get("okf-wiki").is_none());
        assert_eq!(parsed["mcpServers"]["notion"]["command"], "npx");
        assert_eq!(parsed["otherSetting"]["keep"], true);
    }

    #[test]
    fn mcp_json_the_key_itself_goes_when_it_only_held_ours() {
        let once = merge_mcp_json(None, "okf-wiki", &server()).unwrap();
        let parsed = json(&remove_from_mcp_json(Some(&once), "okf-wiki").unwrap());
        assert!(parsed.get("mcpServers").is_none());
    }

    #[test]
    fn a_round_trip_leaves_the_users_own_settings_exactly_as_they_were() {
        type Merge = fn(Option<&str>, &str, &StdioServer) -> Result<String, crate::connect::merge::MergeError>;
        type Remove = fn(Option<&str>, &str) -> Option<String>;
        let pairs: [(Merge, Remove); 2] = [
            (merge_mcp_json, remove_from_mcp_json),
            (merge_opencode_json, remove_from_opencode_json),
        ];
        for (merge, remove) in pairs {
            let before = "{\n  \"keep\": 1,\n  \"other\": {\n    \"a\": 2\n  }\n}\n";
            let after = json(&remove(Some(&merge(Some(before), "okf-wiki", &server()).unwrap()), "okf-wiki").unwrap());
            assert_eq!(after["keep"], 1);
            assert_eq!(after["other"], json(r#"{"a":2}"#));
            assert!(!after.to_string().contains("okf-wiki"));
        }
    }

    #[test]
    fn opencodes_schema_hint_is_left_behind_deliberately() {
        let merged = merge_opencode_json(Some(r#"{"keep":1}"#), "okf-wiki", &server()).unwrap();
        let after = json(&remove_from_opencode_json(Some(&merged), "okf-wiki").unwrap());
        assert!(after.get("$schema").is_some());
        assert!(after.get("mcp").is_none());
    }

    #[test]
    fn codex_our_table_goes_and_the_next_one_survives() {
        let existing = [
            "model = \"gpt-5.6-terra\"", "", "[mcp_servers.okf-wiki]", "command = \"bun\"", "",
            "[mcp_servers.keep-me]", "command = \"npx\"", "", "[windows]", "sandbox = \"elevated\"", "",
        ]
        .join("\n");
        let next = remove_from_codex_toml(Some(&existing), "okf-wiki").unwrap();
        assert!(!next.contains("[mcp_servers.okf-wiki]"));
        assert!(next.contains("[mcp_servers.keep-me]"));
        assert!(next.contains("[windows]"));
        assert!(next.contains("model = \"gpt-5.6-terra\""));
    }

    #[test]
    fn codex_comments_survive_because_it_is_text_surgery() {
        let existing = ["# my notes", "model = \"x\"", "", "[mcp_servers.okf-wiki]", "command = \"bun\"", ""].join("\n");
        assert!(remove_from_codex_toml(Some(&existing), "okf-wiki").unwrap().contains("# my notes"));
    }

    #[test]
    fn hermes_ours_goes_the_other_server_stays() {
        let existing = merge_hermes_yaml(
            Some("model: hermes-4\nmcp_servers:\n  fs:\n    command: npx\n"),
            "okf-wiki",
            &server(),
        )
        .unwrap();
        let next = remove_from_hermes_yaml(Some(&existing), "okf-wiki").unwrap();
        assert!(next.contains("fs:"));
        assert!(!next.contains("okf-wiki"));
        assert!(next.contains("hermes-4"));
    }

    #[test]
    fn a_file_that_never_had_our_entry_is_left_alone() {
        assert_eq!(remove_from_mcp_json(Some(r#"{"mcpServers":{"notion":{}}}"#), "okf-wiki"), None);
        assert_eq!(remove_from_codex_toml(Some("model = \"x\""), "okf-wiki"), None);
        assert_eq!(remove_from_hermes_yaml(Some("model: hermes-4"), "okf-wiki"), None);
        assert_eq!(remove_from_opencode_json(Some(r#"{"mcp":{"other":{}}}"#), "okf-wiki"), None);
    }

    #[test]
    fn an_empty_or_missing_file_is_not_an_error() {
        assert_eq!(remove_from_mcp_json(None, "okf-wiki"), None);
        assert_eq!(remove_from_codex_toml(Some(""), "okf-wiki"), None);
    }

    // ---- planning

    fn install_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("package.json"), "{\"name\":\"x\"}").unwrap();
        dir
    }

    fn opts(install: &tempfile::TempDir, bundles: &[&str]) -> UninstallOptions {
        UninstallOptions {
            install_dir: install.path().to_string_lossy().into_owned(),
            known_bundles: bundles.iter().map(|b| b.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_bundle_is_listed_as_surviving_not_as_being_removed() {
        let install = install_dir();
        let plan = plan_uninstall_with(&opts(&install, &["C:/Users/me/Documents/Notes"]), &[]);
        assert!(plan.preserved.contains(&"C:/Users/me/Documents/Notes".to_string()));
        assert!(!plan.items.iter().any(|i| i.path == "C:/Users/me/Documents/Notes"));
        assert!(plan.blockers.is_empty());
    }

    #[test]
    fn a_bundle_inside_the_install_directory_blocks_everything() {
        let install = install_dir();
        let inside = nodepath::join(&[&install.path().to_string_lossy(), "my-notes"]);
        let plan = plan_uninstall_with(&opts(&install, &[&inside]), &[]);
        assert_eq!(plan.blockers.len(), 1);
        assert!(plan.blockers[0].contains("my-notes"));
        assert!(!plan.preserved.iter().any(|p| p.contains("my-notes")));

        let err = apply_uninstall(&plan).unwrap_err();
        assert!(err.starts_with("中止しました:\n"));
        assert!(err.contains("my-notes"));
    }

    #[test]
    fn the_same_bundle_given_twice_is_listed_once() {
        let install = install_dir();
        let plan = plan_uninstall_with(&opts(&install, &["C:/Users/me/Notes", "C:\\Users\\me\\Notes"]), &[]);
        assert_eq!(plan.preserved.iter().filter(|p| p.to_lowercase().ends_with("notes")).count(), 1);
    }

    #[test]
    fn settings_survive_unless_asked_for() {
        let install = install_dir();
        // Against the real catalogue, as the TS does: planning only reads.
        let plan = plan_uninstall(&opts(&install, &[]));
        assert!(!plan.items.iter().any(|i| i.what.starts_with("設定 (")));
        assert!(!plan.items.iter().any(|i| i.action == UninstallAction::Remove && i.path.ends_with("session.json")));
    }

    #[test]
    fn the_install_directory_is_never_an_item_to_delete() {
        let install = install_dir();
        let plan = plan_uninstall(&opts(&install, &["C:/Users/me/Notes"]));
        assert!(!plan.items.iter().any(|i| i.path == install.path().to_string_lossy()));
        assert_eq!(plan.install_dir, install.path().to_string_lossy());
    }

    fn bundle_scoped_catalogue() -> Vec<ConnectTarget> {
        let mut claude = ConnectTarget::new("c", "Claude Code", TargetKind::McpHost, |b| nodepath::join(&[b, ".mcp.json"]));
        claude.format = Some(ConfigFormat::McpJson);
        let mut cursor = ConnectTarget::new("u", "Cursor", TargetKind::McpHost, |b| nodepath::join(&[b, ".cursor", "mcp.json"]));
        cursor.format = Some(ConfigFormat::McpJson);
        vec![claude, cursor]
    }

    #[test]
    fn every_bundle_is_swept_not_just_the_first() {
        let install = install_dir();
        let b1 = tempfile::tempdir().unwrap();
        let b2 = tempfile::tempdir().unwrap();
        for b in [&b1, &b2] {
            fs::write(b.path().join(".mcp.json"), merge_mcp_json(None, "okf-wiki", &server()).unwrap()).unwrap();
        }
        let (p1, p2) = (b1.path().to_string_lossy().into_owned(), b2.path().to_string_lossy().into_owned());
        let plan = plan_uninstall_with(&opts(&install, &[&p1, &p2]), &bundle_scoped_catalogue());

        let paths: Vec<&str> = plan.items.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(paths, [nodepath::join(&[&p1, ".mcp.json"]), nodepath::join(&[&p2, ".mcp.json"])]);
        assert!(plan.items.iter().all(|i| i.action == UninstallAction::Edit && i.format == Some(ConfigFormat::McpJson)));
    }

    #[test]
    fn with_no_known_bundle_a_relative_path_is_not_swept() {
        let install = install_dir();
        let plan = plan_uninstall_with(&opts(&install, &[]), &bundle_scoped_catalogue());
        assert!(plan.items.is_empty());
        // A relative bundle is skipped as a root too.
        let plan = plan_uninstall_with(&opts(&install, &["relative/notes"]), &bundle_scoped_catalogue());
        assert!(plan.items.is_empty());
        assert!(plan.preserved.contains(&"relative/notes".to_string()));
    }

    #[test]
    fn a_config_without_our_entry_is_not_planned() {
        let install = install_dir();
        let b = tempfile::tempdir().unwrap();
        fs::write(b.path().join(".mcp.json"), "{\"mcpServers\":{\"notion\":{}}}").unwrap();
        let root = b.path().to_string_lossy().into_owned();
        let plan = plan_uninstall_with(&opts(&install, &[&root]), &bundle_scoped_catalogue());
        assert!(plan.items.is_empty());
    }

    #[test]
    fn launchers_and_the_launch_script_are_listed_only_when_present() {
        let install = install_dir();
        let launcher = install.path().join("shortcut.lnk");
        fs::write(&launcher, "").unwrap();
        fs::write(install.path().join(".launch-ui.sh"), "").unwrap();
        let mut o = opts(&install, &[]);
        o.launcher_paths = vec![launcher.to_string_lossy().into_owned(), "/no/such/launcher.lnk".into()];
        let plan = plan_uninstall_with(&o, &[]);

        let whats: Vec<&str> = plan.items.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(whats, ["ランチャー / ショートカット", "起動スクリプト"]);
    }

    // ---- applying (against temp files only)

    #[test]
    fn applying_an_edit_backs_the_config_up_and_removes_only_our_entry() {
        let install = install_dir();
        let b = tempfile::tempdir().unwrap();
        let config = b.path().join(".mcp.json");
        let before = merge_mcp_json(
            Some("{\"mcpServers\":{\"notion\":{\"command\":\"npx\"}},\"keep\":1}"),
            "okf-wiki",
            &server(),
        )
        .unwrap();
        fs::write(&config, &before).unwrap();
        let root = b.path().to_string_lossy().into_owned();

        let plan = plan_uninstall_with(&opts(&install, &[&root]), &bundle_scoped_catalogue());
        let result = apply_uninstall(&plan).unwrap();

        assert_eq!(result.done, ["Claude Code の設定から MCP エントリを削除"]);
        assert!(result.failed.is_empty());
        assert_eq!(result.backups.len(), 1);
        assert_eq!(fs::read_to_string(&result.backups[0]).unwrap(), before);
        let after = json(&fs::read_to_string(&config).unwrap());
        assert!(after["mcpServers"].get("okf-wiki").is_none());
        assert_eq!(after["mcpServers"]["notion"]["command"], "npx");
        assert_eq!(after["keep"], 1);
    }

    #[test]
    fn applying_a_remove_deletes_files_and_directories_and_tolerates_absence() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.lnk");
        let app = dir.path().join("X.app");
        fs::write(&file, "").unwrap();
        fs::create_dir_all(app.join("Contents")).unwrap();
        fs::write(app.join("Contents").join("f"), "").unwrap();
        let item = |p: &std::path::Path| UninstallItem {
            what: p.file_name().unwrap().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            action: UninstallAction::Remove,
            command: None,
            format: None,
        };
        let plan = UninstallPlan {
            items: vec![item(&file), item(&app), item(&dir.path().join("gone"))],
            preserved: vec![],
            blockers: vec![],
            install_dir: String::new(),
        };
        let result = apply_uninstall(&plan).unwrap();
        assert_eq!(result.done.len(), 3);
        assert!(!file.exists() && !app.exists());
    }

    #[test]
    fn a_run_item_that_cannot_start_is_a_failure_not_a_crash() {
        let plan = UninstallPlan {
            items: vec![UninstallItem {
                what: "Hermes".into(),
                path: "/x".into(),
                action: UninstallAction::Run,
                command: Some(CliInvocation { command: "okf-no-such-tool-xyz".into(), args: vec![], stdin: None }),
                format: None,
            }],
            preserved: vec![],
            blockers: vec![],
            install_dir: String::new(),
        };
        let result = apply_uninstall(&plan).unwrap();
        assert!(result.done.is_empty());
        assert_eq!(result.failed.len(), 1);
        assert!(result.failed[0].reason.contains("okf-no-such-tool-xyz"));
    }

    #[test]
    fn an_edit_of_an_unreadable_file_is_reported_and_the_rest_continue() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good.json");
        fs::write(&good, merge_mcp_json(None, "okf-wiki", &server()).unwrap()).unwrap();
        let edit = |p: &std::path::Path| UninstallItem {
            what: "edit".into(),
            path: p.to_string_lossy().into_owned(),
            action: UninstallAction::Edit,
            command: None,
            format: Some(ConfigFormat::McpJson),
        };
        let plan = UninstallPlan {
            items: vec![edit(&dir.path().join("missing.json")), edit(&good)],
            preserved: vec![],
            blockers: vec![],
            install_dir: String::new(),
        };
        let result = apply_uninstall(&plan).unwrap();
        assert_eq!(result.failed.len(), 1);
        assert!(result.failed[0].reason.starts_with("ENOENT"));
        assert_eq!(result.done.len(), 1);
    }

    // ---- the launchers setup wrote

    #[test]
    fn a_localised_desktop_is_searched_not_just_desktop() {
        // A Japanese GNOME puts the desktop at ~/デスクトップ. Setup asks
        // xdg-user-dir and writes there; an uninstall that only knows
        // ~/Desktop leaves a menu entry pointing at an application that is gone.
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".config");
        fs::create_dir_all(&config).unwrap();
        fs::write(
            config.join("user-dirs.dirs"),
            "# generated\nXDG_DESKTOP_DIR=\"$HOME/デスクトップ\"\nXDG_MUSIC_DIR=\"$HOME/音楽\"\n",
        )
        .unwrap();
        let h = home.path().to_string_lossy().into_owned();

        let dirs = desktop_directories_with(&h, None, None);
        assert_eq!(dirs[0], nodepath::join(&[&h, "デスクトップ"]));
        // The English default stays in the list: the setting may have changed.
        assert!(dirs.iter().any(|d| d.ends_with("Desktop")));

        let paths = launcher_paths_on("linux", &h, "PierrotKnowledge2", &dirs);
        assert!(paths.iter().any(|p| p.contains("デスクトップ")));
    }

    #[test]
    fn no_user_dirs_falls_back_to_desktop() {
        let home = nodepath::join(&[&std::env::temp_dir().to_string_lossy(), "okf-no-such-home"]);
        let dirs = desktop_directories_with(&home, None, None);
        assert!(dirs.contains(&nodepath::join(&[&home, "Desktop"])));
    }

    #[test]
    fn xdg_desktop_dir_from_the_environment_and_absolute_values_are_kept() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("cfg");
        fs::create_dir_all(&config).unwrap();
        fs::write(config.join("user-dirs.dirs"), "XDG_DESKTOP_DIR=\"/mnt/desk/\"\n").unwrap();
        let h = home.path().to_string_lossy().into_owned();
        let dirs = desktop_directories_with(&h, Some(&config.to_string_lossy()), Some("/env/desk"));
        assert_eq!(dirs[0], "/mnt/desk");
        assert_eq!(dirs[1], "/env/desk");
        assert_eq!(dirs.len(), 3);
    }

    #[test]
    fn launcher_candidates_per_platform() {
        let desks = vec!["D".to_string()];
        let join = |a: &str, b: &str| nodepath::join(&[a, b]);
        assert_eq!(launcher_paths_on("windows", "H", "App", &desks), [join("D", "App.lnk")]);
        assert_eq!(
            launcher_paths_on("macos", "H", "App", &desks),
            [join("D", "App.app"), join("D", "App.command")]
        );
        let linux = launcher_paths_on("linux", "H", "App", &desks);
        assert_eq!(linux.len(), 4);
        assert!(linux[0].ends_with("okf-wiki.desktop") && linux[1].ends_with("App.desktop"));
        assert!(linux[2].contains("applications"));
    }
}
