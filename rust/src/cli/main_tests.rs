//! Port of the "command list" and "running the CLI" sections of
//! `test/cli.test.ts`, plus checks on the pieces of the help text that are
//! computed (JS string semantics).

use super::*;
use std::collections::HashSet;

// ---- the command list

#[test]
fn every_tool_is_either_grouped_or_explicitly_unlisted() {
    let listed: HashSet<&str> = COMMAND_GROUPS.iter().flat_map(|(_, names)| names.iter().copied()).collect();
    let missing: Vec<&str> = TOOLS
        .iter()
        .filter_map(|t| t["name"].as_str())
        .filter(|name| !listed.contains(name) && !UNLISTED_TOOLS.contains(name))
        .collect();
    assert!(missing.is_empty(), "{missing:?}");
}

#[test]
fn no_group_names_a_tool_that_does_not_exist() {
    let known: HashSet<&str> = TOOLS.iter().filter_map(|t| t["name"].as_str()).collect();
    let stale: Vec<&str> = COMMAND_GROUPS
        .iter()
        .flat_map(|(_, names)| names.iter().copied())
        .chain(UNLISTED_TOOLS)
        .filter(|name| !known.contains(name))
        .collect();
    assert!(stale.is_empty(), "{stale:?}");
}

#[test]
fn a_tool_is_listed_in_exactly_one_group() {
    let mut seen: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (_, names) in COMMAND_GROUPS {
        for name in names {
            *seen.entry(name).or_default() += 1;
        }
    }
    let repeated: Vec<_> = seen.iter().filter(|(_, count)| **count > 1).collect();
    assert!(repeated.is_empty(), "{repeated:?}");
}

#[test]
fn every_alias_points_at_a_real_tool() {
    for (alias, tool) in ALIASES {
        assert_eq!(resolve_tool(alias).unwrap()["name"], tool, "{alias}");
    }
    assert_eq!(resolve_tool("skill-find").unwrap()["name"], "skill_find");
    assert!(resolve_tool("no-such-command").is_none());
}

// ---- help text

#[test]
fn usage_lists_every_grouped_tool_under_its_hyphenated_name() {
    let text = usage();
    for (label, names) in COMMAND_GROUPS {
        assert!(text.contains(&format!("{label}:")));
        for name in names {
            assert!(text.contains(&format!("  {} ", command_name(name))), "{name}");
        }
    }
    assert!(text.contains("エイリアス: find=skill-find, ask=retrieve,"));
}

#[test]
fn a_sentence_ends_at_a_full_stop_followed_by_space() {
    assert_eq!(first_sentence("One. Two."), "One.");
    assert_eq!(first_sentence("日本語。 次の文"), "日本語。");
    assert_eq!(first_sentence("no stop here"), "no stop here");
    assert_eq!(first_sentence("trailing space "), "trailing space");
}

#[test]
fn a_long_sentence_is_cut_to_73_units_and_an_ellipsis() {
    assert_eq!(first_sentence(&"a".repeat(80)), format!("{}…", "a".repeat(73)));
    // 76 units is still short enough.
    assert_eq!(first_sentence(&"b".repeat(76)).len(), 76);
    // Lengths are UTF-16 units: each astral character counts twice, so 39 of
    // them (78 units) are too long and are cut after 36 whole characters plus
    // one lone surrogate (73 units), which decodes to U+FFFD.
    let cut = first_sentence(&"😀".repeat(39));
    assert_eq!(cut, format!("{}\u{fffd}…", "😀".repeat(36)));
}

#[test]
fn pad_end_counts_utf16_units() {
    assert_eq!(pad_end("ab", 5), "ab   ");
    assert_eq!(pad_end("あい", 5), "あい   ");
    assert_eq!(pad_end("longer than width", 3), "longer than width");
}

#[test]
fn to_fixed_rounds_ties_up_like_javascript() {
    assert_eq!(to_fixed(0.25, 1), "0.3");
    assert_eq!(to_fixed(0.35, 1), "0.3"); // 0.35 is below the tie in binary
    assert_eq!(to_fixed(285.0, 1), "285.0");
    assert_eq!(to_fixed(9.96, 1), "10.0");
    assert_eq!(to_fixed(0.0, 1), "0.0");
    assert_eq!(to_fixed(2.5, 0), "3");
}

#[test]
fn tool_help_marks_required_arguments_and_explains_positionals() {
    let help = tool_help(resolve_tool("search").unwrap());
    assert!(help.starts_with("okf search — "));
    assert!(help.contains("引数:"));
    assert!(help.contains("  * --query <string>"));
    assert!(help.ends_with("* は必須。必須引数は順番に位置引数としても渡せます。"));
    assert!(tool_help(resolve_tool("read_map").unwrap()).ends_with("引数はありません。"));
}

#[test]
fn only_ui_and_serve_are_handed_to_bun() {
    assert_eq!(BUN_COMMANDS, ["ui", "serve"]);
}

// ---- running the CLI

struct Fixture {
    _dir: tempfile::TempDir,
    root: String,
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new().prefix("okf-cli-").tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let mut workspace = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    workspace.scaffold(&root).unwrap();
    workspace.open(&root).unwrap();
    std::fs::write(
        dir.path().join("wiki").join("3-resources").join("note.md"),
        "---\ntype: Concept\ntitle: 検索対象\n---\n\n# 検索対象\n\nバイグラム索引の話。\n",
    )
    .unwrap();
    workspace.close();
    Fixture { _dir: dir, root }
}

#[test]
fn exit_code_0_on_success() {
    let f = fixture();
    assert_eq!(run(&["info", "--bundle", &f.root]), 0);
}

#[test]
fn exit_code_2_when_a_required_argument_is_missing() {
    let f = fixture();
    assert_eq!(run(&["search", "--bundle", &f.root]), 2);
}

#[test]
fn exit_code_2_for_an_unknown_command() {
    let f = fixture();
    assert_eq!(run(&["no-such-command", "--bundle", &f.root]), 2);
}

#[test]
fn a_bundle_that_does_not_exist_fails_rather_than_inventing_one() {
    // Deliberately not testing the "no bundle at all" path: that falls back to
    // the saved session, which is real machine state.
    let f = fixture();
    let missing = format!("{}/no-such-bundle", f.root);
    assert_eq!(run(&["info", "--bundle", &missing]), 1);
}

#[test]
fn exit_code_1_when_the_tool_itself_fails() {
    let f = fixture();
    assert_eq!(run(&["read-file", "wiki/missing.md", "--bundle", &f.root]), 1);
}

#[test]
fn aliases_resolve_to_their_tool() {
    let f = fixture();
    assert_eq!(run(&["lint", "--bundle", &f.root]), 0);
    assert_eq!(run(&["gaps", "--bundle", &f.root]), 0);
}

#[test]
fn help_never_touches_the_bundle() {
    // Help must work before anything is configured.
    assert_eq!(run(&["search", "--help"]), 0);
    assert_eq!(run(&["help"]), 0);
    assert_eq!(run(&["help", "--json"]), 0);
    // No command at all is a usage error, but still prints the help.
    assert_eq!(run::<&str>(&[]), 2);
}

#[test]
fn json_and_positional_arguments_reach_the_tool() {
    let f = fixture();
    assert_eq!(run(&["search", "検索対象", "--limit", "3", "--json", "--bundle", &f.root]), 0);
    assert_eq!(run(&["info", "--json", "--bundle", &f.root]), 0);
}

#[test]
fn a_write_through_the_cli_lands_in_the_bundle() {
    let f = fixture();
    let content = "---\ntype: Concept\ntitle: Via\n---\n\n# Via\n";
    assert_eq!(run(&["write-file", "wiki/via-cli.md", "--content", content, "--bundle", &f.root]), 0);
    assert!(std::path::Path::new(&f.root).join("wiki").join("via-cli.md").exists());
}

#[test]
fn mcp_config_formats_exit_zero_and_reject_unknown_ones() {
    let f = fixture();
    for format in ["json", "toml", "opencode", "yaml", "command"] {
        assert_eq!(run(&["mcp-config", "--format", format, "--bundle", &f.root]), 0, "{format}");
    }
    assert_eq!(run(&["mcp-config", "--format", "xml", "--bundle", &f.root]), 2);
}

#[test]
fn rmux_plan_is_a_dry_run_and_bad_subcommands_are_usage_errors() {
    let f = fixture();
    assert_eq!(run(&["rmux", "plan", "--bundle", &f.root]), 0);
    assert_eq!(run(&["rmux", "bogus", "--bundle", &f.root]), 2);
    assert_eq!(run(&["rmux", "run", "--bundle", &f.root]), 2);
    assert_eq!(run(&["rmux", "send", "--bundle", &f.root]), 2);
}

// ---- update, against a local server (never the network, never --apply)

mod update_flow_against_a_local_server {
    use super::*;
    use crate::update::fetch_latest_release_from;
    use sha2::{Digest, Sha256};
    use std::net::TcpListener;

    /// A one-entry, uncompressed ZIP holding `okf-release.json`.
    fn release_zip(version: &str) -> Vec<u8> {
        let name = b"pkg/okf-release.json";
        let data = format!("{{\"version\":\"{version}\"}}");
        let data = data.as_bytes();
        let mut zip = Vec::new();
        let le16 = |v: u16| v.to_le_bytes();
        let le32 = |v: u32| v.to_le_bytes();

        zip.extend_from_slice(&le32(0x0403_4b50));
        zip.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // version, flags, method 0, time, date
        zip.extend_from_slice(&le32(0)); // crc (not checked by the manifest reader)
        zip.extend_from_slice(&le32(data.len() as u32));
        zip.extend_from_slice(&le32(data.len() as u32));
        zip.extend_from_slice(&le16(name.len() as u16));
        zip.extend_from_slice(&le16(0));
        zip.extend_from_slice(name);
        zip.extend_from_slice(data);

        let directory_at = zip.len();
        zip.extend_from_slice(&le32(0x0201_4b50));
        zip.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        zip.extend_from_slice(&le32(0));
        zip.extend_from_slice(&le32(data.len() as u32));
        zip.extend_from_slice(&le32(data.len() as u32));
        zip.extend_from_slice(&le16(name.len() as u16));
        zip.extend_from_slice(&[0; 8]); // extra, comment, disk, internal attrs
        zip.extend_from_slice(&le32(0)); // external attrs
        zip.extend_from_slice(&le32(0)); // local header offset
        zip.extend_from_slice(name);
        let directory_size = zip.len() - directory_at;

        zip.extend_from_slice(&le32(0x0605_4b50));
        zip.extend_from_slice(&[0; 4]);
        zip.extend_from_slice(&le16(1));
        zip.extend_from_slice(&le16(1));
        zip.extend_from_slice(&le32(directory_size as u32));
        zip.extend_from_slice(&le32(directory_at as u32));
        zip.extend_from_slice(&le16(0));
        zip
    }

    /// Serve the release JSON and the archive until the process ends.
    fn serve(archive: Vec<u8>, advertised_digest: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let api = base.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut request = [0u8; 4096];
                let n = stream.read(&mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..n]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let (content_type, body): (&str, Vec<u8>) = if path.ends_with("/releases/latest") {
                    let release = json!({
                        "tag_name": "V9.9.9",
                        "name": "V9.9.9",
                        "body": "一行目\r\n二行目",
                        "html_url": format!("{api}/release"),
                        "published_at": "2026-01-02T03:04:05Z",
                        "assets": [{
                            "name": "App-9.9.9.zip",
                            "size": archive.len(),
                            "browser_download_url": format!("{api}/dl.zip"),
                            "digest": advertised_digest,
                        }],
                    });
                    ("application/json", release.to_string().into_bytes())
                } else {
                    ("application/zip", archive.clone())
                };
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        base
    }

    fn install_dir(version: &str) -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix("okf-update-").tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), format!("{{\"name\":\"app\",\"version\":\"{version}\"}}")).unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        dir
    }

    fn sha256(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn update(install: &str, base: &str, flags: &[&str]) -> i32 {
        let mut argv = vec!["update"];
        argv.extend_from_slice(flags);
        let parsed = parse_argv(&argv);
        let source = GithubSource { owner: "o".into(), repo: "r".into() };
        update_flow(&parsed, install, &|| fetch_latest_release_from(base, &source))
    }

    #[test]
    fn a_newer_release_is_downloaded_and_verified_but_not_applied_without_apply() {
        let archive = release_zip("9.9.9");
        let base = serve(archive.clone(), format!("sha256:{}", sha256(&archive)));
        let install = install_dir("1.0.0");
        let dir = install.path().to_string_lossy().into_owned();

        assert_eq!(update(&dir, &base, &[]), 0);

        // Downloaded and kept for `--apply`; nothing of the install changed.
        assert!(install.path().join(".okf-update").join("App-9.9.9.zip").exists());
        assert!(!install.path().join(".okf-backup").exists());
        let package = std::fs::read_to_string(install.path().join("package.json")).unwrap();
        assert!(package.contains("1.0.0"));
    }

    #[test]
    fn an_up_to_date_install_cleans_up_its_download() {
        let archive = release_zip("1.0.0");
        let base = serve(archive.clone(), format!("sha256:{}", sha256(&archive)));
        let install = install_dir("1.0.0");

        assert_eq!(update(&install.path().to_string_lossy(), &base, &["--notes"]), 0);
        assert!(!install.path().join(".okf-update").exists());
    }

    #[test]
    fn a_digest_mismatch_discards_the_download_and_fails() {
        let archive = release_zip("9.9.9");
        let base = serve(archive, format!("sha256:{}", "0".repeat(64)));
        let install = install_dir("1.0.0");

        assert_eq!(update(&install.path().to_string_lossy(), &base, &["--apply"]), 1);
        assert!(!install.path().join(".okf-update").exists());
        assert!(!install.path().join(".okf-backup").exists());
    }

    #[test]
    fn a_release_without_a_digest_is_refused() {
        let archive = release_zip("9.9.9");
        let base = serve(archive, String::new());
        let install = install_dir("1.0.0");

        // An empty digest is "no digest": nothing is downloaded.
        assert_eq!(update(&install.path().to_string_lossy(), &base, &[]), 1);
        assert!(!install.path().join(".okf-update").exists());
    }

    #[test]
    fn an_unreachable_server_is_one_line_and_exit_1() {
        let install = install_dir("1.0.0");
        assert_eq!(update(&install.path().to_string_lossy(), "http://127.0.0.1:9", &[]), 1);
    }
}
