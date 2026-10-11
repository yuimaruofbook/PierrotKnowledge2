//! `okf` — the command-line surface, for agents (`src/bun/cli/main.ts`).
//!
//! Built on the MCP tool table rather than beside it: every tool becomes a
//! subcommand automatically, so the two can never disagree about what exists.
//!
//! Never interactive; `--json` prints machine-readable output; errors go to
//! stderr; exit codes mean something: 0 ok, 1 tool error, 2 usage error.
//!
//! `ui` and `serve` are the Bun server and stay TypeScript: [`delegate_to_bun`]
//! runs the TS CLI with the same argv.

use crate::cli::args::{build_tool_args, parse_argv, FlagValue, ParsedArgs, ToolSchema};
use crate::cli::rmux::{
    agent_workspace_plan, capabilities, diagnose, has_session, is_broken_install, job_plan, kill_session,
    list_sessions, list_windows, native_pane_shell, okf_pane_command, pane_snapshot, parse_collected,
    parse_snapshot, render_plan, send_keys, window_target, RmuxCommand, MAIN_WINDOW, RMUX_SESSION, WATCH_WINDOW,
};
use crate::connect::targets::{
    bun_command, find_install_root, headless_binary_path, render_server_config, resolve_command,
    server_command_line, ConfigFormat,
};
use crate::mcp::tools::{call_tool, TOOLS};
use crate::okf::nodepath;
use crate::shared::app::APP_NAME;
use crate::shared::js_compat::{
    from_utf16, is_js_line_terminator, is_js_space, is_js_space16, js_number, js_trim, slice16, to_utf16, utf16_len,
};
use crate::state::load_session;
use crate::uninstall::{apply_uninstall, launcher_paths_for, plan_uninstall, UninstallAction, UninstallOptions};
use crate::update::{
    apply_update, check_safe_to_update, decide_update, digest_matches, download_and_hash, fetch_latest_release,
    find_install_dir, read_installed, rollback, stale_compiled_artifacts, write_install_record,
    FindInstallDirOptions, GithubSource, InstalledInfo, ReleaseInfo, MANIFEST_NAME,
};
use crate::update_zip::{extract_zip, read_manifest_from_zip};
use crate::workspace::{Workspace, WorkspaceOptions};
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Command, Stdio};

const EXIT_OK: i32 = 0;
const EXIT_TOOL_ERROR: i32 = 1;
const EXIT_USAGE: i32 = 2;

// ---------------------------------------------------------------------------
// Output. stdout and stderr are flushed per call so that their interleaving
// through a shared pipe matches the order of the calls, as it does in the TS.
// ---------------------------------------------------------------------------

fn out(text: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

fn err(text: &str) {
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(text.as_bytes());
    let _ = stderr.write_all(b"\n");
    let _ = stderr.flush();
}

/// How to type this command, in the shell the user is actually in.
fn self_name() -> String {
    format!("{}{APP_NAME}", if cfg!(windows) { ".\\" } else { "./" })
}

const REBUILD_HINT: &str = "  bun install\n  bun run build:view       # 画面（Web UI）\n  bun run build:headless   # エージェントが起動する MCP サーバー（使っている場合）";

fn command_name(tool: &str) -> String {
    tool.replace('_', "-")
}

/// Shorter names for the things an agent reaches for constantly.
const ALIASES: [(&str, &str); 13] = [
    ("find", "skill_find"),
    ("ask", "retrieve"),
    ("ls", "list_files"),
    ("lint", "check_conformance"),
    ("gaps", "unresolved_links"),
    ("agents", "read_agents_md"),
    ("map", "read_map"),
    ("who", "read_human"),
    ("tasks", "list_tasks"),
    ("todo", "add_task"),
    ("today", "daily_note"),
    ("para", "list_para"),
    ("archive", "set_para"),
];

fn resolve_tool(name: &str) -> Option<&'static Value> {
    let wanted = ALIASES
        .iter()
        .find(|(alias, _)| *alias == name)
        .map(|(_, tool)| (*tool).to_string())
        .unwrap_or_else(|| name.replace('-', "_"));
    TOOLS.iter().find(|tool| tool["name"].as_str() == Some(wanted.as_str()))
}

/// How the command list is grouped in `--help`. Hand-ordered, by what you are
/// trying to do; a test asserts every tool appears in exactly one group.
pub const COMMAND_GROUPS: [(&str, &[&str]); 11] = [
    (
        "知識を読む",
        &["retrieve", "context_pack", "search", "read_file", "list_concepts", "list_tags", "backlinks"],
    ),
    ("知識を書く", &["create_concept", "write_file", "move_file", "delete_file"]),
    ("方向づけ", &["read_map", "system_map", "read_human", "list_tasks", "add_task", "update_task"]),
    ("デイリーノート", &["daily_note", "collect_daily_tasks"]),
    ("PARA", &["list_para", "set_para", "set_lifecycle"]),
    ("スキル", &["skill_find", "skill_list", "skill_open", "skill_read"]),
    ("ノウハウ", &["knowhow_find", "knowhow_add"]),
    ("ベース（一覧・集計ビュー）", &["base_list", "base_query", "base_write"]),
    (
        "関係図・グラフ",
        &["canvas_list", "canvas_read", "canvas_write", "canvas_from_links", "graph_schema"],
    ),
    ("ループ", &["loop_list", "loop_start", "loop_note", "loop_end", "loop_read"]),
    (
        "点検",
        &[
            "check_conformance",
            "audit_changes",
            "summarize_activity",
            "unresolved_links",
            "rebuild_index",
            "rebuild_rag",
        ],
    ),
];

/// Tools deliberately kept out of `--help`: implied by `--bundle`, or plumbing
/// the CLI already exposes under a friendlier name.
pub const UNLISTED_TOOLS: [&str; 7] = [
    "open_bundle",
    "bundle_info",
    "list_files",
    "read_agents_md",
    "write_human",
    "loop_define",
    "create_directory",
];

/// `String.prototype.padEnd` (counts UTF-16 units).
fn pad_end(text: &str, width: usize) -> String {
    let len = utf16_len(text);
    if len >= width {
        text.to_string()
    } else {
        format!("{text}{}", " ".repeat(width - len))
    }
}

fn usage() -> String {
    let platform_prefix = if cfg!(windows) { ".\\" } else { "./" };
    let mut lines: Vec<String> = vec![
        format!("okf — {APP_NAME} のコマンドライン"),
        String::new(),
        format!("  {} <コマンド> [引数] [--flag 値]", self_name()),
        "  okf <コマンド> …                （短縮形。他ツールと衝突しうるので非推奨）".to_string(),
        String::new(),
        format!("  先頭の {platform_prefix} は必須です"),
        "  （インストール先は PATH に入っていません）".to_string(),
        String::new(),
        "共通フラグ:".to_string(),
        "  --bundle <path>   対象バンドル（既定: $OKF_BUNDLE、なければ前回開いたもの）".to_string(),
        "  --json            機械可読な JSON で出力する".to_string(),
        "  --help            そのコマンドの引数を表示する".to_string(),
        String::new(),
    ];

    for (label, tools) in COMMAND_GROUPS {
        lines.push(format!("{label}:"));
        for name in tools {
            let Some(tool) = TOOLS.iter().find(|t| t["name"].as_str() == Some(name)) else { continue };
            lines.push(format!(
                "  {} {}",
                pad_end(&command_name(name), 20),
                first_sentence(tool["description"].as_str().unwrap_or(""))
            ));
        }
        lines.push(String::new());
    }

    for fixed in [
        "その他:",
        "  ui                   ブラウザに UI を出す（常駐 135 MB・推奨）",
        "  Update               新しいリリースを確認する（--apply で適用）",
        "  Uninstall            削除の計画を表示する（--apply で実行）",
        "  serve                MCP サーバーとして起動（ヘッドレス・常駐 85 MB）",
        "  mcp-config           他のツールに貼る MCP 設定を出力する",
        "                       （--format json | toml | opencode | yaml | command）",
        "  watch                log.md を追尾して変更を表示する",
        "  info                 バンドルの概要",
        "  rmux <サブコマンド>  エージェント用の rmux セッション（下記）",
        "",
        "rmux:",
        "  rmux setup           作業セッションを作る（main / watch、再実行しても安全）",
        "  rmux plan            実行されるコマンドを表示するだけ（何もしない）",
        "  rmux run <コマンド>  専用ウィンドウで実行し、終了まで待って出力を返す",
        "  rmux send <コマンド> main ウィンドウに投げるだけ（待たない）",
        "  rmux capture         ウィンドウの内容を読む（--window <名前>）",
        "  rmux status          セッション一覧",
        "  rmux windows         ウィンドウ一覧",
        "  rmux doctor          rmux の対応機能を表示する",
        "  rmux kill            セッションを終了する",
        "",
    ] {
        lines.push(fixed.to_string());
    }
    lines.push(format!(
        "エイリアス: {}",
        ALIASES.iter().map(|(a, t)| format!("{a}={}", command_name(t))).collect::<Vec<_>>().join(", ")
    ));

    lines.join("\n")
}

/// The first sentence of a description, cut to fit a 76-column listing.
/// Lengths and cuts are in UTF-16 units, as the JS counts them.
fn first_sentence(text: &str) -> String {
    let units = to_utf16(text);
    // `text.search(/(?<=[.。])\s/)`
    let cut = (1..units.len()).find(|&i| is_js_space16(units[i]) && matches!(units[i - 1], 0x2e | 0x3002));
    let sentence: &[u16] = match cut {
        None => &units,
        Some(i) => slice16(&units, 0, i + 1),
    };
    if sentence.len() > 76 {
        format!("{}…", from_utf16(slice16(sentence, 0, 73)))
    } else {
        js_trim(&from_utf16(sentence)).to_string()
    }
}

fn tool_help(tool: &Value) -> String {
    let name = tool["name"].as_str().unwrap_or("");
    let schema = &tool["inputSchema"];
    let required: Vec<&str> = schema["required"]
        .as_array()
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let mut lines: Vec<String> = vec![
        format!("okf {} — {}", command_name(name), tool["title"].as_str().unwrap_or("undefined")),
        String::new(),
        tool["description"].as_str().unwrap_or("undefined").to_string(),
        String::new(),
    ];

    let properties = schema["properties"].as_object().filter(|p| !p.is_empty());
    match properties {
        None => lines.push("引数はありません。".to_string()),
        Some(properties) => {
            lines.push("引数:".to_string());
            for (key, property) in properties {
                let mark = if required.contains(&key.as_str()) { "*" } else { " " };
                let kind = property["type"].as_str().map(|t| format!("<{t}>")).unwrap_or_default();
                lines.push(format!(
                    "{}{}",
                    pad_end(&format!("  {mark} --{key} {kind}"), 30),
                    property["description"].as_str().unwrap_or("")
                ));
            }
            if !required.is_empty() {
                lines.push(String::new());
                lines.push("* は必須。必須引数は順番に位置引数としても渡せます。".to_string());
            }
        }
    }

    lines.join("\n")
}

/// Which bundle to act on: `--bundle`, then `OKF_BUNDLE`, then whatever the app
/// had open last.
fn resolve_bundle(parsed: &ParsedArgs) -> Option<String> {
    if let Some(FlagValue::Str(flag)) = parsed.flag("bundle") {
        if !flag.is_empty() {
            return Some(nodepath::resolve1(flag));
        }
    }
    if let Some(env) = std::env::var("OKF_BUNDLE").ok().filter(|v| !v.is_empty()) {
        return Some(nodepath::resolve1(&env));
    }
    load_session().bundle_path.filter(|p| !p.is_empty()).map(|p| nodepath::resolve1(&p))
}

fn known_bundles() -> Vec<String> {
    let mut bundles = Vec::new();
    if let Some(path) = load_session().bundle_path.filter(|p| !p.is_empty()) {
        bundles.push(path);
    }
    if let Some(env) = std::env::var("OKF_BUNDLE").ok().filter(|v| !v.is_empty()) {
        bundles.push(env);
    }
    bundles
}

// ---------------------------------------------------------------------------
// rmux
// ---------------------------------------------------------------------------

const INSTALL_HINT: &str =
    "  irm https://rmux.io/install.ps1 | iex     # 事前ビルド（Windows x64）\n  cargo install rmux --locked              # ソースからビルド";

struct RmuxOutcome {
    ok: bool,
    output: String,
}

/// Run an rmux command, translating its two failure modes into advice.
fn run_rmux(command: &RmuxCommand) -> RmuxOutcome {
    let spawned = Command::new(resolve_command("rmux")).args(&command.argv).stdin(Stdio::null()).output();
    let result = match spawned {
        Ok(result) => result,
        Err(_) => {
            return RmuxOutcome { ok: false, output: format!("rmux が見つかりません。インストール:\n{INSTALL_HINT}") }
        }
    };

    let combined = format!("{}{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
    let output = js_trim(&combined).to_string();
    let ok = result.status.success();

    if !ok && is_broken_install(&output) {
        return RmuxOutcome {
            ok: false,
            output: format!(
                "rmux は入っていますが、補助バイナリが欠けています:\n  {output}\n\n事前ビルド版の既知の欠落です。ソースからビルドし直してください:\n  cargo install rmux --locked"
            ),
        };
    }

    RmuxOutcome { ok, output }
}

fn pane_okf() -> String {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    okf_pane_command(None, &exe, native_pane_shell())
}

fn handle_rmux(parsed: &ParsedArgs, bundle: Option<&str>) -> i32 {
    let sub = parsed.positional.get(1).map(String::as_str).unwrap_or("status");
    let rest: Vec<String> = parsed.positional.iter().skip(2).cloned().collect();
    let session = match parsed.flag("session") {
        Some(FlagValue::Str(s)) => s.clone(),
        _ => RMUX_SESSION.to_string(),
    };
    let okf = pane_okf();
    let as_json = parsed.flag("json").is_some_and(FlagValue::is_true);

    if sub == "plan" || sub == "setup" {
        let Some(bundle) = bundle else {
            err("バンドルが指定されていません（--bundle か OKF_BUNDLE）");
            return EXIT_USAGE;
        };
        let plan = agent_workspace_plan(bundle, Some(&session), &okf, native_pane_shell());

        if sub == "plan" {
            // A dry run, because `setup` starts processes on the user's machine.
            out(&format!("rmux セッション \"{}\" を次の手順で作ります:\n", plan.session));
            out(&render_plan(&plan));
            return EXIT_OK;
        }

        // Repeating setup must not build a second copy of the workspace.
        if run_rmux(&has_session(&session)).ok {
            out(&format!("セッション \"{session}\" は既にあります。"));
            out(&format!("接続: rmux attach-session -t {session}"));
            return EXIT_OK;
        }

        for command in &plan.commands {
            let result = run_rmux(command);
            if !result.ok {
                err(&format!("失敗: rmux {}\n{}", command.argv.join(" "), result.output));
                return EXIT_TOOL_ERROR;
            }
        }
        out(&format!("セッション \"{}\" を作成しました（{MAIN_WINDOW} / {WATCH_WINDOW}）。", plan.session));
        out(&format!("接続: rmux attach-session -t {}", plan.session));
        return EXIT_OK;
    }

    if sub == "run" {
        return rmux_run(&session, &okf, &rest, as_json, parsed);
    }
    if sub == "send" {
        return rmux_send(&session, &okf, &rest);
    }
    if sub == "capture" {
        return rmux_capture(&session, parsed, as_json);
    }

    let command = match sub {
        "kill" => kill_session(&session),
        "status" => list_sessions(),
        "windows" => list_windows(&session),
        "diagnose" => diagnose(),
        "doctor" => capabilities(),
        _ => {
            err(&format!("不明な rmux サブコマンド: {sub}"));
            err("使えるもの: setup, plan, run, send, capture, status, windows, doctor, diagnose, kill");
            return EXIT_USAGE;
        }
    };

    let result = run_rmux(&command);
    out(if result.output.is_empty() { "(出力なし)" } else { &result.output });
    if result.ok {
        EXIT_OK
    } else {
        EXIT_TOOL_ERROR
    }
}

/// Run an `okf` command to completion in its own window and print its output.
fn rmux_run(session: &str, okf: &str, args: &[String], as_json: bool, parsed: &ParsedArgs) -> i32 {
    if args.is_empty() {
        err("実行するコマンドがありません: okf rmux run <コマンド> [引数]");
        return EXIT_USAGE;
    }

    let max_bytes = match parsed.flag("max_bytes") {
        Some(FlagValue::Str(s)) => Some(js_number(s)),
        _ => None,
    }
    .filter(|n| n.is_finite())
    .map(|n| if n <= 0.0 { 0 } else { n as u64 });

    let job = job_plan(Some(session), None, &format!("{okf} {}", args.join(" ")), max_bytes);

    let started = run_rmux(&job.start);
    if !started.ok {
        err(&format!("ジョブを開始できません:\n{}", started.output));
        return EXIT_TOOL_ERROR;
    }

    let collected = run_rmux(&job.collect);
    // The window is normally gone with its command; this clears a job that was
    // killed part way through and would otherwise hold the name.
    run_rmux(&job.cleanup);

    if !collected.ok {
        err(&format!("出力を収集できません:\n{}", collected.output));
        return EXIT_TOOL_ERROR;
    }

    let Some(output) = parse_collected(&collected.output) else {
        err(&format!("rmux の応答を解釈できません:\n{}", collected.output));
        return EXIT_TOOL_ERROR;
    };

    if as_json {
        out(&pretty(&json!({
            "ok": output.ok,
            "command": args.join(" "),
            "output": output.text,
            "bytes": output.bytes,
            "truncated": output.truncated,
            // Passed through as null rather than assumed: rmux does not
            // observe a pane's exit status on Windows.
            "exit_status": output.exit_status,
        })));
    } else {
        let text = output.text.trim_end_matches(|c| is_js_space(c) || is_js_line_terminator(c));
        out(if text.is_empty() { "(出力なし)" } else { text });
        if output.truncated {
            err(&format!("\n（出力が {} バイトで打ち切られました）", output.bytes));
        }
    }

    if output.ok {
        EXIT_OK
    } else {
        EXIT_TOOL_ERROR
    }
}

/// Start a command in the shell window and return immediately.
fn rmux_send(session: &str, okf: &str, args: &[String]) -> i32 {
    if args.is_empty() {
        err("送るコマンドがありません: okf rmux send <コマンド> [引数]");
        return EXIT_USAGE;
    }

    let target = window_target(session, MAIN_WINDOW);
    let result = run_rmux(&send_keys(&target, &format!("{okf} {}", args.join(" "))));
    if !result.ok {
        err(&result.output);
        return EXIT_TOOL_ERROR;
    }

    out(&format!("{target} に送信しました。出力: okf rmux capture"));
    EXIT_OK
}

/// Read a window's current contents.
fn rmux_capture(session: &str, parsed: &ParsedArgs, as_json: bool) -> i32 {
    let window = match parsed.flag("window") {
        Some(FlagValue::Str(w)) => w.as_str(),
        _ => MAIN_WINDOW,
    };
    let target = window_target(session, window);

    let result = run_rmux(&pane_snapshot(&target));
    if !result.ok {
        err(&result.output);
        return EXIT_TOOL_ERROR;
    }

    let Some(view) = parse_snapshot(&result.output) else {
        err(&format!("rmux の応答を解釈できません:\n{}", result.output));
        return EXIT_TOOL_ERROR;
    };

    if as_json {
        out(&pretty(&json!({
            "ok": view.ok,
            "target": target,
            "cols": view.cols,
            "rows": view.rows,
            "output": view.text,
        })));
    } else {
        out(if view.text.is_empty() { "(出力なし)" } else { &view.text });
    }

    if view.ok {
        EXIT_OK
    } else {
        EXIT_TOOL_ERROR
    }
}

/// `JSON.stringify(value, null, 2)`
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("values built here are serialisable")
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/// `Number.prototype.toFixed(digits)` for non-negative finite values: ties
/// round up, which Rust's own formatting (half to even) does not.
fn to_fixed(value: f64, digits: usize) -> String {
    // A double's decimal expansion is finite, so asking for more digits than
    // the value can have gives its exact expansion to round by hand.
    let exact = format!("{value:.80}");
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    let round_up = fraction.as_bytes().get(digits).is_some_and(|d| *d >= b'5');
    if round_up {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let text = String::from_utf8(kept).expect("ascii digits");
    if digits == 0 {
        text
    } else {
        let split = text.len() - digits;
        format!("{}.{}", &text[..split], &text[split..])
    }
}

/// Update from the newest GitHub release. Nothing is written without
/// `--apply`, and even then only after the download has been verified against
/// the digest GitHub computed.
fn run_update(parsed: &ParsedArgs) -> i32 {
    let Some(install_dir) = find_install_dir(&FindInstallDirOptions::default()) else {
        err("インストール先を特定できませんでした。アプリのフォルダで実行してください。");
        return EXIT_TOOL_ERROR;
    };
    update_flow(parsed, &install_dir, &|| fetch_latest_release(&GithubSource::default_source()))
}

/// The update flow proper. The release lookup is a parameter so that a test
/// can answer from a local server; the rest is what `okf update` does.
fn update_flow(
    parsed: &ParsedArgs,
    install_dir: &str,
    fetch: &dyn Fn() -> Result<Option<ReleaseInfo>, String>,
) -> i32 {

    // Rollback is its own path: it needs none of the checks below.
    if parsed.flag_set("rollback") {
        let dir = match parsed.flag("rollback") {
            Some(FlagValue::Str(s)) => s.clone(),
            _ => "true".to_string(),
        };
        return match rollback(install_dir, &dir) {
            Ok(restored) => {
                out(&format!("{} 件を戻しました: {}", restored.len(), restored.join(", ")));
                out(&format!("\n次に実行してください:\n{REBUILD_HINT}"));
                EXIT_OK
            }
            Err(error) => fail(&error),
        };
    }

    let installed = match read_installed(install_dir) {
        Ok(installed) => installed,
        Err(error) => return fail(&error),
    };
    out(&format!(
        "インストール済み : {}{}",
        installed.version,
        installed.tag.as_deref().filter(|t| !t.is_empty()).map(|t| format!(" ({t})")).unwrap_or_default()
    ));

    // The bundle must not live inside what is about to be replaced.
    let bundles = known_bundles();
    let bundle_refs: Vec<&str> = bundles.iter().map(String::as_str).collect();
    let safety = check_safe_to_update(install_dir, &bundle_refs);
    if !safety.ok {
        err(&format!("\n中止します。\n\n{}", safety.problems.join("\n\n")));
        return EXIT_TOOL_ERROR;
    }

    let release = match fetch() {
        Ok(release) => release,
        Err(error) => return fail(&error),
    };
    let Some(mut release) = release else {
        err("リリース情報を取得できませんでした。");
        return EXIT_TOOL_ERROR;
    };

    out(&format!(
        "公開されている   : {} ({})",
        if release.name.is_empty() { &release.tag } else { &release.name },
        release.published_at
    ));
    out(&format!(
        "アセット         : {} {} MB",
        release.asset_name,
        to_fixed(release.asset_size as f64 / 1_048_576.0, 1)
    ));
    out(&format!("digest           : {}\n", release.digest.as_deref().unwrap_or("なし")));

    if !js_trim(&release.notes).is_empty() {
        // What actually changed, before deciding whether to take it. Truncated
        // unless asked for in full.
        let full = parsed.flag("notes").is_some_and(FlagValue::is_true);
        let notes = js_trim(&release.notes.replace("\r\n", "\n")).to_string();
        let note_lines: Vec<&str> = notes.split('\n').collect();
        let shown = if full { notes.clone() } else { note_lines.iter().take(24).copied().collect::<Vec<_>>().join("\n") };

        out(&"─".repeat(60));
        out(&shown);
        if !full && note_lines.len() > 24 {
            out(&format!("\n… 全文は --notes、または {}", release.html_url));
        }
        out(&format!("{}\n", "─".repeat(60)));
    }

    let Some(digest) = release.digest.clone().filter(|d| !d.is_empty()) else {
        err("digest が無いため検証できません。中止します。");
        return EXIT_TOOL_ERROR;
    };

    let staging = nodepath::join(&[install_dir, ".okf-update"]);
    if let Err(error) = std::fs::create_dir_all(&staging) {
        return fail(&error.to_string());
    }
    let archive = nodepath::join(&[
        &staging,
        if release.asset_name.is_empty() { "release.zip" } else { &release.asset_name },
    ]);

    out("ダウンロード中…");
    let mut last_shown = 0u64;
    let mut progress = |got: u64, total: u64| {
        let pct = if total > 0 { ((got as f64 / total as f64) * 100.0).floor() as u64 } else { 0 };
        if pct >= last_shown + 10 {
            last_shown = pct;
            err(&format!("  {pct}%"));
        }
    };
    let (sha256, bytes) = match download_and_hash(&release.asset_url, &archive, Some(&mut progress)) {
        Ok(done) => done,
        Err(error) => return fail(&error),
    };

    if !digest_matches(Some(&digest), &sha256) {
        let _ = std::fs::remove_dir_all(&staging);
        err(&format!(
            "\n検証に失敗しました。ダウンロードを破棄します。\n  期待: {digest}\n  実際: sha256:{sha256}"
        ));
        return EXIT_TOOL_ERROR;
    }
    out(&format!("検証 OK ({} MB)\n", to_fixed(bytes as f64 / 1_048_576.0, 1)));

    // The version lives in the archive, not in the tag.
    release.version = read_manifest_from_zip(&archive, MANIFEST_NAME).and_then(|m| m.version);

    let verdict = decide_update(&installed, &release);
    out(&format!("判定: {} — {}\n", verdict.action(), verdict.reason()));

    if verdict.action() != "update" {
        let _ = std::fs::remove_dir_all(&staging);
        return if verdict.action() == "up-to-date" { EXIT_OK } else { EXIT_TOOL_ERROR };
    }

    if !parsed.flag_set("apply") {
        out("適用するには次を実行してください:");
        out(&format!("  {} Update --apply", self_name()));
        out(&format!("（ダウンロード済み: {archive}）"));
        return EXIT_OK;
    }

    out("展開中…");
    let extracted = nodepath::join(&[&staging, "extracted"]);
    let staged_root = match extract_zip(&archive, &extracted) {
        Ok(root) => root,
        Err(error) => return fail(&error),
    };

    out("適用中…");
    let result = match apply_update(install_dir, &staged_root, None) {
        Ok(result) => result,
        Err(error) => return fail(&error),
    };
    let record = InstalledInfo {
        version: release.version.clone().unwrap_or_else(|| installed.version.clone()),
        tag: Some(release.tag.clone()),
        published_at: Some(release.published_at.clone()),
    };
    if let Err(error) = write_install_record(install_dir, &record) {
        return fail(&error);
    }

    out(&format!("\n完了。置き換えた項目: {}", result.replaced.join(", ")));
    out(&format!("旧版の退避先       : {}", result.backup_dir));
    out(&format!("\n次に実行してください:\n{REBUILD_HINT}"));

    // The failure this prevents: an update that appears to do nothing. `build/`
    // is not replaced by an update, and compiled artefacts are preferred over
    // the source that was just replaced.
    let stale = stale_compiled_artifacts(install_dir);
    if !stale.is_empty() {
        out("\n⚠ 次のバイナリは古いままです。再ビルドするまで、更新後のコードは動きません:");
        for artefact in &stale {
            out(&format!("  {}", artefact.path));
            out(&format!("    → {}", artefact.rebuild));
        }
    }

    out(&format!("\n問題があれば戻せます:\n  {} Update --rollback \"{}\"", self_name(), result.backup_dir));
    out(&format!("\n次回以降のアップデートは `{} Update` と入力してください。", self_name()));
    EXIT_OK
}

/// A failure the TS lets escape as an exception (and so as a stack trace);
/// here it is one line on stderr.
fn fail(message: &str) -> i32 {
    err(message);
    EXIT_TOOL_ERROR
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

/// Show, and optionally carry out, what removing this application involves.
/// The install folder itself is never deleted here.
fn run_uninstall(parsed: &ParsedArgs) -> i32 {
    let Some(install_dir) = find_install_dir(&FindInstallDirOptions::default()) else {
        err("インストール先を特定できませんでした。アプリのフォルダで実行してください。");
        return EXIT_TOOL_ERROR;
    };

    let plan = plan_uninstall(&UninstallOptions {
        install_dir,
        known_bundles: known_bundles(),
        purge_settings: parsed.flag("purge_settings").is_some_and(FlagValue::is_true),
        launcher_paths: launcher_paths_for(APP_NAME, None),
    });

    if !plan.blockers.is_empty() {
        err(&format!("中止します。\n\n{}", plan.blockers.join("\n\n")));
        return EXIT_TOOL_ERROR;
    }

    // Survivors first. This is the answer to the only question that matters.
    out("残るもの（削除しません）:");
    if plan.preserved.is_empty() {
        out("  （なし）");
    }
    for path in &plan.preserved {
        out(&format!("  ✅ {path}"));
    }

    out("\n削除・変更するもの:");
    if plan.items.is_empty() {
        out("  （なし）");
    }
    for item in &plan.items {
        out(&format!("  {}  {}", if item.action == UninstallAction::Remove { "削除" } else { "編集" }, item.what));
        out(&format!("        {}", item.path));
    }

    out(&format!(
        "\nアプリのフォルダは削除しません:\n  {}\n  実行中のプログラム自身は消せないため、アプリを終了してから手で削除してください。",
        plan.install_dir
    ));

    if !parsed.flag_set("apply") {
        out(&format!("\n実行するには:\n  {} Uninstall --apply", self_name()));
        out("設定も消すなら --purge-settings を付けてください。");
        return EXIT_OK;
    }

    let result = match apply_uninstall(&plan) {
        Ok(result) => result,
        Err(error) => return fail(&error),
    };

    out(&format!("\n完了: {} 件", result.done.len()));
    for what in &result.done {
        out(&format!("  {what}"));
    }
    if !result.backups.is_empty() {
        out("\n他ツールの設定は、変更前に退避しています:");
        for backup in &result.backups {
            out(&format!("  {backup}"));
        }
    }
    if !result.failed.is_empty() {
        err("\n失敗:");
        for failure in &result.failed {
            err(&format!("  {}\n    {}", failure.path, failure.reason));
        }
    }

    out(&format!("\n最後に、アプリを終了してからこのフォルダを削除してください:\n  {}", plan.install_dir));
    if result.failed.is_empty() {
        EXIT_OK
    } else {
        EXIT_TOOL_ERROR
    }
}

// ---------------------------------------------------------------------------
// mcp-config
// ---------------------------------------------------------------------------

/// The directory this install lives in, for the places that need "the project".
fn project_root() -> String {
    if let Some(root) = find_install_root(None) {
        return root;
    }
    // Compiled to build/cli/okf.exe -> root (the TS falls back to its own
    // source tree the same way).
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    nodepath::resolve(&[&nodepath::dirname(&exe), "..", ".."])
}

/// Print the MCP entry for a host this app has no target for.
fn print_mcp_config(parsed: &ParsedArgs, bundle: Option<&str>) -> i32 {
    let Some(bundle) = bundle else {
        err("バンドルが指定されていません（--bundle か OKF_BUNDLE）");
        return EXIT_USAGE;
    };

    let root = project_root();
    let asked = match parsed.flag("format") {
        Some(FlagValue::Str(s)) => s.as_str(),
        _ => "json",
    };

    let rendered = match asked {
        "json" => render_server_config(ConfigFormat::McpJson, &root, bundle).map_err(|e| e.to_string()),
        "toml" => render_server_config(ConfigFormat::CodexToml, &root, bundle).map_err(|e| e.to_string()),
        "opencode" => render_server_config(ConfigFormat::OpencodeJson, &root, bundle).map_err(|e| e.to_string()),
        "yaml" => render_server_config(ConfigFormat::HermesYaml, &root, bundle).map_err(|e| e.to_string()),
        "command" => Ok(server_command_line(&root, bundle)),
        _ => {
            err(&format!("未対応の形式です: {asked}"));
            err("  --format json | toml | opencode | yaml | command");
            return EXIT_USAGE;
        }
    };
    let rendered = match rendered {
        Ok(text) => text,
        Err(error) => return fail(&error),
    };

    out(&rendered);

    // Everything after this is guidance, so it goes to stderr: piping the
    // command into a config file must not pick it up.
    if asked == "command" {
        err(&format!("\nOKF_BUNDLE={}", bundle.replace('\\', "/")));
    }
    if !Path::new(&headless_binary_path(&root)).exists() {
        err("\n※ ヘッドレスの実行ファイルが未ビルドのため、bun 経由の起動になっています。\n  `bun run build:headless` を実行すると、Bun のインストールに依存しない形になります。");
    }

    EXIT_OK
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

/// Follow `log.md`, which is where every write from either side lands.
/// Polling rather than watching: this runs inside an rmux pane for hours.
fn watch(workspace: &Workspace) -> i32 {
    let log_path = match workspace.require_bundle() {
        Ok(bundle) => bundle.paths.log_md_path(),
        Err(error) => return fail(&error.to_string()),
    };
    let size_of = |path: &str| std::fs::metadata(path).ok().map(|m| m.len());
    let mut last_size = size_of(&log_path).unwrap_or(0);

    out(&format!("{log_path} を追尾しています。Ctrl+C で終了。"));

    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let Some(size) = size_of(&log_path) else { continue };
        if size <= last_size {
            last_size = size;
            continue;
        }
        // The appended bytes only. (The TS slices the decoded text by a byte
        // count, which re-prints earlier text once the log holds non-ASCII.)
        if let Ok(mut file) = std::fs::File::open(&log_path) {
            let mut added = Vec::new();
            if file.seek(SeekFrom::Start(last_size)).is_ok()
                && file.take(size - last_size).read_to_end(&mut added).is_ok()
            {
                let mut stdout = std::io::stdout().lock();
                let _ = stdout.write_all(String::from_utf8_lossy(&added).as_bytes());
                let _ = stdout.flush();
            }
        }
        last_size = size;
    }
}

// ---------------------------------------------------------------------------
// ui / serve: the Bun server stays TypeScript
// ---------------------------------------------------------------------------

/// Commands that run on the TypeScript implementation (Bun) because they are
/// the Bun server itself.
pub const BUN_COMMANDS: [&str; 2] = ["ui", "serve"];

/// The TS CLI entry point of this install: `src/bun/cli/main.ts` in the
/// nearest enclosing install tree of the executable or the working directory.
fn find_ts_entry() -> Option<String> {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    for start in [nodepath::dirname(&exe), cwd] {
        let mut dir = nodepath::resolve1(&start);
        for _hop in 0..8 {
            let entry = nodepath::join(&[&dir, "src", "bun", "cli", "main.ts"]);
            if Path::new(&entry).is_file() {
                return Some(entry);
            }
            let parent = nodepath::dirname(&dir);
            if parent == dir {
                break;
            }
            dir = parent;
        }
    }
    None
}

const BUN_MISSING: &str = "Bun が見つかりません。https://bun.sh からインストールしてください。";

/// Run the TS CLI with the same argv and inherited stdio; its exit code is ours.
fn delegate_to_bun(argv: &[String]) -> i32 {
    let Some(entry) = find_ts_entry() else {
        err("この機能は TypeScript 版（Bun）で動きますが、src/bun/cli/main.ts が見つかりません。");
        return EXIT_TOOL_ERROR;
    };
    let status = Command::new(bun_command())
        .arg("run")
        .arg(&entry)
        .args(argv)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    match status {
        Ok(status) => status.code().unwrap_or(EXIT_TOOL_ERROR),
        Err(_) => {
            err(BUN_MISSING);
            EXIT_TOOL_ERROR
        }
    }
}

// ---------------------------------------------------------------------------

/// Run the CLI and return its exit code.
pub fn run<S: AsRef<str>>(argv: &[S]) -> i32 {
    let argv_owned: Vec<String> = argv.iter().map(|a| a.as_ref().to_string()).collect();
    let parsed = parse_argv(&argv_owned);
    // Lower-cased because the documented spelling is `PierrotKnowledge2 Update`,
    // which reads as a proper noun and a verb rather than as a flag.
    let command = parsed.positional.first().map(|c| c.to_lowercase());
    let wants_json = match parsed.flag("json") {
        Some(FlagValue::Bool(true)) => true,
        Some(FlagValue::Str(s)) => s == "true",
        _ => false,
    };

    if command.is_none() || parsed.flag("help").is_some_and(FlagValue::is_true) || command.as_deref() == Some("help") {
        let tool = command.as_deref().filter(|c| *c != "help").and_then(resolve_tool);
        out(&match tool {
            Some(tool) => tool_help(tool),
            None => usage(),
        });
        return if command.is_some() { EXIT_OK } else { EXIT_USAGE };
    }
    let command = command.expect("checked above");

    let bundle = resolve_bundle(&parsed);

    if command == "rmux" {
        return handle_rmux(&parsed, bundle.as_deref());
    }
    if BUN_COMMANDS.contains(&command.as_str()) {
        return delegate_to_bun(&argv_owned);
    }
    if command == "update" {
        return run_update(&parsed);
    }
    if command == "uninstall" {
        return run_uninstall(&parsed);
    }
    if command == "mcp-config" {
        return print_mcp_config(&parsed, bundle.as_deref());
    }

    let tool = resolve_tool(&command);
    let is_info = command == "info";
    if tool.is_none() && !is_info && command != "watch" {
        err(&format!("不明なコマンド: {command}"));
        err("`okf --help` で一覧を表示します。");
        return EXIT_USAGE;
    }

    let Some(bundle) = bundle else {
        err("バンドルが指定されていません。--bundle <path> を渡すか、OKF_BUNDLE を設定してください。");
        return EXIT_USAGE;
    };

    let mut workspace = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    if let Err(error) = workspace.open(&bundle) {
        err(&error.to_string());
        return EXIT_TOOL_ERROR;
    }

    let code = run_on_workspace(&mut workspace, &command, tool, is_info, wants_json, &parsed);
    workspace.close();
    code
}

fn run_on_workspace(
    workspace: &mut Workspace,
    command: &str,
    tool: Option<&Value>,
    is_info: bool,
    wants_json: bool,
    parsed: &ParsedArgs,
) -> i32 {
    if command == "watch" {
        return watch(workspace);
    }

    if is_info {
        let info = workspace.info();
        if wants_json {
            out(&pretty(&serde_json::to_value(&info).expect("info is serialisable")));
        } else {
            let (root, concepts, non_conformant) = match &info {
                Some(i) => (i.root.clone(), i.concept_count.to_string(), i.non_conformant_count.to_string()),
                None => ("undefined".into(), "undefined".into(), "undefined".into()),
            };
            out(&format!("bundle : {root}"));
            out(&format!("概念   : {concepts} 件"));
            out(&format!("非準拠 : {non_conformant} 件"));
        }
        return EXIT_OK;
    }

    let tool = tool.expect("a non-info, non-watch command has a tool");
    let name = tool["name"].as_str().unwrap_or("");

    // positional[0] is the command itself; only what follows is an argument.
    let tool_parsed = ParsedArgs {
        positional: parsed.positional.iter().skip(1).cloned().collect(),
        flags: parsed.flags.clone(),
    };
    let (args, missing) = build_tool_args(&ToolSchema::from_json(&tool["inputSchema"]), &tool_parsed);
    if !missing.is_empty() {
        err(&format!("引数が足りません: {}", missing.iter().map(|m| format!("--{m}")).collect::<Vec<_>>().join(", ")));
        err("");
        err(&tool_help(tool));
        return EXIT_USAGE;
    }

    let result = call_tool(workspace, name, &args);

    if wants_json {
        // Tool output is already JSON for the structured tools; wrapping it
        // keeps one predictable envelope for every command.
        out(&pretty(&json!({ "ok": !result.is_error, "tool": name, "output": result.text })));
    } else if result.is_error {
        err(&result.text);
    } else {
        out(&result.text);
    }

    if result.is_error {
        EXIT_TOOL_ERROR
    } else {
        EXIT_OK
    }
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
