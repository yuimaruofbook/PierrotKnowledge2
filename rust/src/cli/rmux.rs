//! RMUX integration (`src/bun/cli/rmux.ts`).
//!
//! RMUX is a Rust terminal multiplexer built for agents. It speaks tmux's
//! command surface, but the part that matters here is its own extensions
//! (`pane-snapshot`, `collect-pane-output`, `wait-pane`), which return JSON
//! with a schema version instead of a screenful of text an agent has to scrape.
//!
//! What it buys this app is a place for work that outlives a single tool call:
//! a `retrieve` returns in milliseconds, but reindexing a large bundle does
//! not, and an MCP call that blocks for minutes is a call that times out.
//!
//! Three findings from running this against rmux 0.9.1 shaped the design:
//!
//! 1. `split-window` halves the pane width (measured: 200 -> 99 columns), so
//!    output wraps and an agent reads shredded text. Windows stay full width:
//!    this module builds **windows, never splits.**
//! 2. `capture-pane` returns the *visible screen*, already wrapped to the pane
//!    width. `collect-pane-output` returns the byte stream, unwrapped.
//! 3. `pane_exit.exit_status` is null on Windows, so **a job's exit code is
//!    not observable**; its output is the only signal.
//!
//! Commands are built as data and tested as data, so the argv mapping is
//! verifiable without rmux installed.

use crate::connect::jsjson::js_number_string;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// Default session name. One session holds all of this app's agent work.
pub const RMUX_SESSION: &str = "okf-wiki";
/// Window that holds the interactive shell an agent types into.
pub const MAIN_WINDOW: &str = "main";
/// Window that tails `log.md`.
pub const WATCH_WINDOW: &str = "watch";
/// Window a blocking job runs in, one job at a time.
pub const JOB_WINDOW: &str = "job";

/// Size for a detached session. A detached session defaults to 80x24, which is
/// where the wrapping problem starts; no terminal has to display this, so the
/// only cost of a wide session is buffer.
pub const AGENT_COLS: u32 = 200;
pub const AGENT_ROWS: u32 = 50;

/// Default ceiling for a collected job's output.
pub const MAX_COLLECT_BYTES: u64 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RmuxCommand {
    /// Argument vector, ready to spawn.
    pub argv: Vec<String>,
    /// What this step is for, shown when the plan is printed.
    pub purpose: String,
}

fn cmd(argv: &[&str], purpose: String) -> RmuxCommand {
    RmuxCommand { argv: argv.iter().map(|a| a.to_string()).collect(), purpose }
}

/// Which shell a pane runs, because quoting is not portable between them.
///
/// rmux starts a pane with the platform default (`cmd.exe` on Windows), so
/// POSIX quoting sent there arrives literally: the pane tries to run a program
/// named `'bun` and reports that it does not exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneShell {
    Posix,
    Cmd,
}

/// The shell rmux will start in a new pane on `platform` (a Node
/// `process.platform` string such as `win32`, `darwin`, `linux`).
pub fn default_pane_shell(platform: &str) -> PaneShell {
    if platform == "win32" {
        PaneShell::Cmd
    } else {
        PaneShell::Posix
    }
}

/// [`default_pane_shell`] for the machine this runs on.
pub fn native_pane_shell() -> PaneShell {
    if cfg!(windows) {
        PaneShell::Cmd
    } else {
        PaneShell::Posix
    }
}

/// Quote a path for use *inside* a command the pane will run.
///
/// Not for the command as a whole (`send_keys` passes that verbatim) but for
/// the paths interpolated into it, which reach the pane's shell and are
/// subject to its rules. POSIX shells take single quotes with the `'\''`
/// escape; `cmd.exe` has no single-quote syntax and uses double quotes,
/// doubling an embedded one.
pub fn quote_for_pane(command: &str, shell: PaneShell) -> String {
    match shell {
        PaneShell::Cmd => format!("\"{}\"", command.replace('"', "\"\"")),
        PaneShell::Posix => format!("'{}'", command.replace('\'', "'\\''")),
    }
}

/// Set an environment variable for the rest of the pane's session. `export` is
/// POSIX-only; `cmd.exe` uses `set`, and the quotes go around the whole
/// assignment rather than the value so a path with spaces survives.
pub fn export_env(name: &str, value: &str, shell: PaneShell) -> String {
    match shell {
        PaneShell::Cmd => format!("set {}", quote_for_pane(&format!("{name}={value}"), shell)),
        PaneShell::Posix => format!("export {name}={}", quote_for_pane(value, shell)),
    }
}

/// The command a pane should use to invoke this same CLI.
///
/// A compiled binary invokes itself (its entry point, if any, is a virtual
/// path nothing else can open); only Bun running our source needs
/// `bun run <entry>`. The two are told apart by the executable's file name.
pub fn okf_pane_command(entry: Option<&str>, exec_path: &str, shell: PaneShell) -> String {
    let runtime = exec_path.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();

    // Anything other than Bun itself means we are the compiled executable.
    if runtime != "bun" && runtime != "bun.exe" {
        return quote_for_pane(exec_path, shell);
    }

    match entry.filter(|e| !e.is_empty()) {
        Some(entry) => format!("bun run {}", quote_for_pane(entry, shell)),
        None => "okf".to_string(),
    }
}

/// Whether rmux failed because its own install is incomplete: the Windows
/// prebuilt of 0.9.1 ships `rmux.exe` without the private helper it needs, so
/// `rmux -V` reports a version while every command that spawns the server
/// fails. "Not installed" and "installed but broken" are fixed differently.
pub fn is_broken_install(output: &str) -> bool {
    static BROKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)libexec|helper not found").unwrap());
    BROKEN.is_match(output)
}

/// Address a window explicitly, e.g. `okf-wiki:job`.
pub fn window_target(session: &str, window: &str) -> String {
    format!("{session}:{window}")
}

// ---------------------------------------------------------------------------
// Sessions and windows
// ---------------------------------------------------------------------------

/// Start a detached session sized for an agent rather than for a screen. `-d`
/// so the session outlives the process that created it.
pub fn new_session(session: &str, cols: u32, rows: u32) -> RmuxCommand {
    cmd(
        &["new-session", "-d", "-s", session, "-x", &cols.to_string(), "-y", &rows.to_string()],
        format!("セッション {session} を作成（デタッチ、{cols}×{rows}）"),
    )
}

/// [`new_session`] with the default name and size.
pub fn new_session_default() -> RmuxCommand {
    new_session(RMUX_SESSION, AGENT_COLS, AGENT_ROWS)
}

/// Ask whether a session exists, so setup can be repeated safely.
pub fn has_session(session: &str) -> RmuxCommand {
    cmd(&["has-session", "-t", session], format!("{session} の有無を確認"))
}

/// Add a window; deliberately not a split.
pub fn new_window(session: &str, name: &str, command: Option<&str>) -> RmuxCommand {
    let mut argv = vec!["new-window", "-t", session, "-n", name];
    if let Some(command) = command.filter(|c| !c.is_empty()) {
        argv.push(command);
    }
    let suffix = command.filter(|c| !c.is_empty()).map(|c| format!(": {c}")).unwrap_or_default();
    cmd(&argv, format!("ウィンドウ {name} を作成{suffix}"))
}

pub fn kill_window(target: &str) -> RmuxCommand {
    cmd(&["kill-window", "-t", target], format!("ウィンドウ {target} を終了"))
}

pub fn kill_session(session: &str) -> RmuxCommand {
    cmd(&["kill-session", "-t", session], format!("セッション {session} を終了"))
}

pub fn list_sessions() -> RmuxCommand {
    cmd(&["list-sessions"], "セッション一覧".to_string())
}

pub fn list_windows(session: &str) -> RmuxCommand {
    cmd(&["list-windows", "-t", session], format!("{session} のウィンドウ一覧"))
}

/// Type a command into a pane and press Enter.
///
/// The trailing literal `Enter` is rmux's key name, not part of the command:
/// without it the text sits on the prompt unexecuted, which looks like a hang.
/// The command is one argv element and rmux types it verbatim, so it must NOT
/// be quoted here: we spawn rmux directly, with no shell in between to strip
/// the quotes again.
pub fn send_keys(target: &str, command: &str) -> RmuxCommand {
    cmd(&["send-keys", "-t", target, command, "Enter"], format!("{target} で実行: {command}"))
}

// ---------------------------------------------------------------------------
// Reading a pane
// ---------------------------------------------------------------------------

/// Read a pane as structured JSON, in preference to `capture-pane -p`, which
/// prints the visible screen already wrapped to the pane width.
pub fn pane_snapshot(target: &str) -> RmuxCommand {
    cmd(&["pane-snapshot", "-t", target, "--json"], format!("{target} の内容を取得"))
}

/// Block until the pane's command exits, then return everything it wrote: the
/// byte stream rather than the screen, ending exactly when the command does.
pub fn collect_pane_output(target: &str, max_bytes: u64) -> RmuxCommand {
    cmd(
        &[
            "collect-pane-output",
            "-t",
            target,
            "--until-pane-exit",
            "--max-bytes",
            &max_bytes.to_string(),
            "--json",
        ],
        format!("{target} の終了を待って出力を収集"),
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WaitOptions {
    /// Text that must appear *after* the call, not already on screen.
    pub next_text: Option<String>,
    /// Wait for output to stop changing.
    pub quiet: bool,
    /// How long counts as quiet, e.g. "2s".
    pub stable_for: Option<String>,
    /// Wait for the pane's command to exit.
    pub pane_exit: bool,
    /// Give up after this, e.g. "120s".
    pub timeout: Option<String>,
}

/// Wait for a pane to reach a state.
///
/// `--text` matches content that is *already* there, including the command
/// line the shell just echoed, so it returns in about a millisecond and
/// reports success before the command has run. `--next-text` takes a baseline
/// first, which is what makes it usable as a completion check.
pub fn wait_pane(target: &str, options: &WaitOptions) -> RmuxCommand {
    let mut argv: Vec<String> = vec!["wait-pane".into(), "-t".into(), target.into()];
    if let Some(text) = options.next_text.as_deref().filter(|t| !t.is_empty()) {
        argv.push("--next-text".into());
        argv.push(text.into());
    }
    if options.quiet {
        argv.push("--quiet".into());
    }
    if let Some(stable) = options.stable_for.as_deref().filter(|t| !t.is_empty()) {
        argv.push("--stable-for".into());
        argv.push(stable.into());
    }
    if options.pane_exit {
        argv.push("--pane-exit".into());
    }
    if let Some(timeout) = options.timeout.as_deref().filter(|t| !t.is_empty()) {
        argv.push("--timeout".into());
        argv.push(timeout.into());
    }
    argv.push("--json".into());
    RmuxCommand { argv, purpose: format!("{target} の状態を待つ") }
}

pub fn capabilities() -> RmuxCommand {
    cmd(&["capabilities", "--json"], "rmux の対応機能".to_string())
}

pub fn diagnose() -> RmuxCommand {
    cmd(&["diagnose", "--json"], "rmux の状態を診断".to_string())
}

// ---------------------------------------------------------------------------
// Reading what rmux returned
// ---------------------------------------------------------------------------

/// Remove terminal control sequences from collected output.
///
/// `collect-pane-output` returns the raw byte stream, so it carries the escape
/// codes the program emitted: cursor moves, screen clears, the window-title
/// sequence `cmd.exe` writes on startup. Left in, they corrupt an agent's view
/// of the output and can retarget a terminal the text is later printed to.
pub fn strip_ansi(text: &str) -> String {
    static OSC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)\x1B\].*?(?:\x07|\x1B\\)").unwrap());
    static CSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1B[\[\]()#;?]*[0-9;]*[A-Za-z]").unwrap());
    let without_osc = OSC.replace_all(text, "");
    let without_csi = CSI.replace_all(&without_osc, "");
    without_csi.replace("\r\n", "\n").replace('\r', "\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectedOutput {
    pub ok: bool,
    pub text: String,
    pub bytes: u64,
    pub truncated: bool,
    /// `None` whenever rmux could not observe the exit, which on Windows is
    /// always, since `pane_exit.stale` is set and no status is reported.
    /// Callers must not treat `None` as success.
    pub exit_status: Option<i64>,
}

/// A JS number held in JSON, as a whole number when it is one.
fn whole(value: Option<&Value>) -> Option<i64> {
    value?.as_f64().map(|x| x as i64)
}

/// Read a `collect-pane-output --json` reply. `None` when it is not JSON.
pub fn parse_collected(raw: &str) -> Option<CollectedOutput> {
    let data: Value = serde_json::from_str(raw).ok()?;
    // `null` is the one non-object the TS would crash on; treat it as unreadable.
    if data.is_null() {
        return None;
    }

    let status = whole(data.get("pane_exit").and_then(|p| p.get("exit_status")));
    Some(CollectedOutput {
        ok: data.get("ok") == Some(&Value::Bool(true)),
        text: strip_ansi(data.get("output_utf8_lossy").and_then(Value::as_str).unwrap_or("")),
        bytes: whole(data.get("bytes")).map_or(0, |b| b.max(0) as u64),
        truncated: data.get("truncated") == Some(&Value::Bool(true)),
        exit_status: status,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneView {
    pub ok: bool,
    pub text: String,
    pub cols: u32,
    pub rows: u32,
}

/// `String(value)` for the elements `Array.prototype.join` would convert.
fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), js_number_string),
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(js_to_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Read a `pane-snapshot --json` reply. `None` when it is not JSON.
pub fn parse_snapshot(raw: &str) -> Option<PaneView> {
    let data: Value = serde_json::from_str(raw).ok()?;
    if data.is_null() {
        return None;
    }

    let lines: Vec<String> = data
        .get("lines")
        .and_then(Value::as_array)
        .map(|l| l.iter().map(js_to_string).collect())
        .unwrap_or_default();
    let text = match data.get("text").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => lines.join("\n"),
    };

    let dim = |key: &str| whole(data.get(key)).map_or(0, |n| n.clamp(0, u32::MAX as i64) as u32);
    Some(PaneView {
        ok: data.get("ok") == Some(&Value::Bool(true)),
        // Trailing blank lines are the unused part of the screen, never content.
        text: text.trim_end_matches('\n').to_string(),
        cols: dim("cols"),
        rows: dim("rows"),
    })
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePlan {
    pub session: String,
    pub commands: Vec<RmuxCommand>,
}

/// The session an agent gets to work in.
///
/// Two windows, not a three-way split (the split left each pane under 100
/// columns, so every JSON reply wrapped):
///
/// * `main`  - a shell with `OKF_BUNDLE` already set
/// * `watch` - `okf watch`, a live tail of every write from either side
///
/// Jobs get their own window on demand; see [`job_plan`]. `okf` is the path to
/// the CLI entry point, so windows call the same build.
pub fn agent_workspace_plan(bundle: &str, session: Option<&str>, okf: &str, shell: PaneShell) -> WorkspacePlan {
    let session = session.unwrap_or(RMUX_SESSION);
    let quoted_bundle = quote_for_pane(bundle, shell);
    let main = window_target(session, MAIN_WINDOW);

    WorkspacePlan {
        session: session.to_string(),
        commands: vec![
            new_session(session, AGENT_COLS, AGENT_ROWS),
            // The first window already exists; name it rather than adding one.
            cmd(&["rename-window", "-t", session, MAIN_WINDOW], "最初のウィンドウを命名".to_string()),
            send_keys(&main, &export_env("OKF_BUNDLE", bundle, shell)),
            // A tail of log.md is the cheapest possible "what just happened".
            new_window(session, WATCH_WINDOW, Some(&format!("{okf} watch --bundle {quoted_bundle}"))),
            // Leave the agent looking at the shell, not at the log tail.
            cmd(&["select-window", "-t", &main], "main を選択".to_string()),
        ],
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobPlan {
    pub target: String,
    pub start: RmuxCommand,
    pub collect: RmuxCommand,
    pub cleanup: RmuxCommand,
}

/// Run one command to completion in its own window.
///
/// A fresh window per job keeps a long job's output away from the shell an
/// agent is typing into, and gives `collect-pane-output` a pane whose exit
/// means "this job finished" rather than "someone closed the shell".
pub fn job_plan(session: Option<&str>, window: Option<&str>, command: &str, max_bytes: Option<u64>) -> JobPlan {
    let session = session.unwrap_or(RMUX_SESSION);
    let window = window.unwrap_or(JOB_WINDOW);
    let target = window_target(session, window);

    JobPlan {
        start: new_window(session, window, Some(command)),
        collect: collect_pane_output(&target, max_bytes.unwrap_or(MAX_COLLECT_BYTES)),
        // The window is gone once its command exits, but a job killed part way
        // through would otherwise hold the name and collide with the next one.
        cleanup: kill_window(&target),
        target,
    }
}

/// Render a plan as the commands a person could paste, for the dry run.
pub fn render_plan(plan: &WorkspacePlan) -> String {
    plan.commands
        .iter()
        .map(|c| format!("  rmux {}\n      # {}", c.argv.join(" "), c.purpose))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    // ---- commands

    #[test]
    fn a_session_is_created_detached_and_sized_for_an_agent() {
        assert_eq!(
            new_session("demo", 200, 50).argv,
            s(&["new-session", "-d", "-s", "demo", "-x", "200", "-y", "50"])
        );
        assert_eq!(new_session_default().argv[3], "okf-wiki");
        assert_eq!(new_session("demo", 200, 50).purpose, "セッション demo を作成（デタッチ、200×50）");
    }

    #[test]
    fn send_keys_ends_with_the_enter_key_name() {
        let command = send_keys("demo", "okf info");
        assert_eq!(command.argv.last().unwrap(), "Enter");
        assert_eq!(command.argv[..3], s(&["send-keys", "-t", "demo"])[..]);
    }

    #[test]
    fn a_pane_is_read_as_json_rather_than_as_a_screenful_of_text() {
        assert_eq!(pane_snapshot("demo:main").argv, s(&["pane-snapshot", "-t", "demo:main", "--json"]));
    }

    #[test]
    fn a_job_collects_the_byte_stream_not_the_screen() {
        assert_eq!(
            collect_pane_output("demo:job", 4096).argv,
            s(&["collect-pane-output", "-t", "demo:job", "--until-pane-exit", "--max-bytes", "4096", "--json"])
        );
    }

    #[test]
    fn waiting_uses_next_text_never_text() {
        let command = wait_pane(
            "demo:job",
            &WaitOptions { next_text: Some("DONE".into()), timeout: Some("120s".into()), ..Default::default() },
        );
        assert_eq!(
            command.argv,
            s(&["wait-pane", "-t", "demo:job", "--next-text", "DONE", "--timeout", "120s", "--json"])
        );
        assert!(!command.argv.contains(&"--text".to_string()));

        let all = wait_pane(
            "t",
            &WaitOptions {
                next_text: None,
                quiet: true,
                stable_for: Some("2s".into()),
                pane_exit: true,
                timeout: None,
            },
        );
        assert_eq!(all.argv, s(&["wait-pane", "-t", "t", "--quiet", "--stable-for", "2s", "--pane-exit", "--json"]));
    }

    #[test]
    fn a_window_is_addressed_explicitly() {
        assert_eq!(window_target("okf-wiki", "job"), "okf-wiki:job");
    }

    #[test]
    fn quoting_follows_the_shell_the_pane_actually_runs() {
        assert_eq!(quote_for_pane("C:/Program Files/x", PaneShell::Posix), "'C:/Program Files/x'");
        assert_eq!(quote_for_pane("it's", PaneShell::Posix), "'it'\\''s'");
        assert_eq!(quote_for_pane("C:\\Program Files\\x", PaneShell::Cmd), "\"C:\\Program Files\\x\"");
        assert_eq!(quote_for_pane("it's", PaneShell::Cmd), "\"it's\"");
        assert_eq!(quote_for_pane("say \"hi\"", PaneShell::Cmd), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn the_pane_shell_is_chosen_from_the_platform() {
        assert_eq!(default_pane_shell("win32"), PaneShell::Cmd);
        assert_eq!(default_pane_shell("darwin"), PaneShell::Posix);
        assert_eq!(default_pane_shell("linux"), PaneShell::Posix);
    }

    #[test]
    fn setting_an_environment_variable_uses_each_shells_own_syntax() {
        assert_eq!(export_env("OKF_BUNDLE", "/home/me/wiki", PaneShell::Posix), "export OKF_BUNDLE='/home/me/wiki'");
        assert_eq!(export_env("OKF_BUNDLE", "C:\\OKF Wiki", PaneShell::Cmd), "set \"OKF_BUNDLE=C:\\OKF Wiki\"");
    }

    #[test]
    fn a_job_runs_in_its_own_window() {
        let job = job_plan(Some("demo"), None, "okf rebuild-rag", None);
        assert_eq!(job.target, "demo:job");
        assert_eq!(job.start.argv, s(&["new-window", "-t", "demo", "-n", "job", "okf rebuild-rag"]));
        assert!(job.collect.argv.contains(&"--until-pane-exit".to_string()));
        assert!(job.collect.argv.contains(&"1000000".to_string()));
        assert_eq!(job.cleanup.argv, s(&["kill-window", "-t", "demo:job"]));
    }

    #[test]
    fn a_compiled_binary_invokes_itself_not_a_virtual_module_path() {
        assert_eq!(
            okf_pane_command(Some("B:/~BUN/root/okf"), "C:\\build\\okf.exe", PaneShell::Cmd),
            "\"C:\\build\\okf.exe\""
        );
        assert_eq!(
            okf_pane_command(Some("/dev/My App/main.ts"), "/usr/bin/bun", PaneShell::Posix),
            "bun run '/dev/My App/main.ts'"
        );
        assert_eq!(
            okf_pane_command(Some("C:\\dev\\main.ts"), "C:\\Users\\me\\.bun\\bin\\bun.exe", PaneShell::Cmd),
            "bun run \"C:\\dev\\main.ts\""
        );
        assert_eq!(okf_pane_command(None, "/usr/bin/bun", PaneShell::Posix), "okf");
        assert_eq!(okf_pane_command(Some(""), "/usr/bin/BUN", PaneShell::Posix), "okf");
    }

    #[test]
    fn send_keys_passes_the_command_verbatim() {
        let command = send_keys("demo", "okf info --bundle \"C:\\OKF Wiki\"");
        assert_eq!(command.argv[3], "okf info --bundle \"C:\\OKF Wiki\"");
    }

    #[test]
    fn the_workspace_plan_quotes_every_interpolated_path_in_either_shell() {
        for (shell, quote) in [(PaneShell::Posix, "'"), (PaneShell::Cmd, "\"")] {
            let okf = format!("bun run {quote}C:/dev/My App/cli.ts{quote}");
            let plan = agent_workspace_plan("C:/Users/me/OKF Wiki", None, &okf, shell);

            // Commands reach a pane two ways: typed in with send-keys, or given
            // to new-window as the window's own process.
            let payloads: Vec<&String> = plan
                .commands
                .iter()
                .filter_map(|c| match c.argv[0].as_str() {
                    "send-keys" => Some(&c.argv[3]),
                    "new-window" if c.argv.len() > 5 => Some(&c.argv[5]),
                    _ => None,
                })
                // The env line quotes the whole `NAME=value` assignment.
                .filter(|p| !p.contains("OKF_BUNDLE="))
                .collect();
            assert!(!payloads.is_empty());

            for payload in payloads {
                for spaced in ["C:/Users/me/OKF Wiki", "C:/dev/My App/cli.ts"] {
                    if payload.contains(spaced) {
                        assert!(payload.contains(&format!("{quote}{spaced}{quote}")), "{payload}");
                    }
                }
            }
        }
    }

    #[test]
    fn the_plan_never_sends_export_to_a_cmd_pane() {
        let plan = agent_workspace_plan("C:\\OKF Wiki", None, "okf", PaneShell::Cmd);
        let payloads: Vec<&String> =
            plan.commands.iter().filter(|c| c.argv[0] == "send-keys").map(|c| &c.argv[3]).collect();
        assert!(payloads.iter().any(|p| p.contains("OKF_BUNDLE")));
        assert!(!payloads.iter().any(|p| p.contains("export ")));
    }

    #[test]
    fn a_broken_install_is_told_apart_from_a_missing_one() {
        assert!(is_broken_install("private rmux helper not found under libexec/rmux"));
        assert!(!is_broken_install(r"no server running on \\.\pipe\rmux-S-1-5-21"));
        assert!(is_broken_install("LIBEXEC missing"));
    }

    #[test]
    fn the_plan_opens_the_session_before_using_it() {
        let plan = agent_workspace_plan("/b", None, "okf", PaneShell::Posix);
        assert_eq!(plan.commands[0].argv[0], "new-session");
        assert_eq!(plan.session, "okf-wiki");
    }

    #[test]
    fn the_plan_builds_windows_never_splits() {
        let plan = agent_workspace_plan("/b", None, "okf", PaneShell::Posix);
        let verbs: Vec<&str> = plan.commands.iter().map(|c| c.argv[0].as_str()).collect();
        assert!(!verbs.contains(&"split-window"));
        assert!(verbs.contains(&"new-window"));
    }

    #[test]
    fn the_plan_addresses_windows_by_name_rather_than_the_session() {
        let plan = agent_workspace_plan("/b", None, "okf", PaneShell::Posix);
        for command in plan.commands.iter().filter(|c| c.argv[0] == "send-keys") {
            assert!(command.argv[2].contains(':'));
        }
    }

    #[test]
    fn the_dry_run_prints_each_step_with_its_purpose() {
        let plan = agent_workspace_plan("/b", Some("demo"), "okf", PaneShell::Posix);
        let text = render_plan(&plan);
        assert!(text.starts_with("  rmux new-session -d -s demo -x 200 -y 50\n      # セッション demo を作成"));
        assert_eq!(text.matches("\n  rmux ").count(), 4);
    }

    // ---- reading rmux replies

    #[test]
    fn control_sequences_are_stripped_from_collected_output() {
        let raw = "\u{1B}[?25l\u{1B}[2J\u{1B}[HBEGIN\r\n\u{1B}]0;C:\\cmd.exe\u{7}END\r\n";
        assert_eq!(strip_ansi(raw), "BEGIN\nEND\n");
        // The other OSC terminator, and a lone carriage return.
        assert_eq!(strip_ansi("a\u{1B}]0;t\u{1B}\\b\rc"), "ab\nc");
    }

    #[test]
    fn a_collected_job_is_read_into_a_plain_result() {
        let reply = r#"{"ok":true,"bytes":12,"stored_bytes":12,"truncated":false,"output_utf8_lossy":"概念 : 5 件\r\n","pane_exit":{"exit_signal":null,"exit_status":null,"stale":true},"schema_version":1}"#;
        let result = parse_collected(reply).unwrap();
        assert!(result.ok);
        assert_eq!(result.text, "概念 : 5 件\n");
        assert_eq!(result.bytes, 12);
        assert!(!result.truncated);
        // None on Windows, always. Callers must not read it as success.
        assert_eq!(result.exit_status, None);
    }

    #[test]
    fn a_real_exit_status_is_kept_when_rmux_reports_one() {
        let reply = r#"{"ok":true,"output_utf8_lossy":"","pane_exit":{"exit_status":3,"stale":false}}"#;
        assert_eq!(parse_collected(reply).unwrap().exit_status, Some(3));
    }

    #[test]
    fn missing_or_mistyped_fields_fall_back_quietly() {
        let result = parse_collected(r#"{"ok":"yes","bytes":"many","truncated":1,"pane_exit":null}"#).unwrap();
        assert_eq!(
            result,
            CollectedOutput { ok: false, text: String::new(), bytes: 0, truncated: false, exit_status: None }
        );
        assert_eq!(parse_collected("[]").unwrap().text, "");
    }

    #[test]
    fn a_snapshot_drops_the_unused_part_of_the_screen() {
        let reply = r#"{"ok":true,"cols":200,"rows":50,"lines":["$ okf info","概念 : 5 件","",""],"text":"$ okf info\n概念 : 5 件\n\n\n\n","schema_version":1}"#;
        let view = parse_snapshot(reply).unwrap();
        assert_eq!(view.text, "$ okf info\n概念 : 5 件");
        assert_eq!(view.cols, 200);
        assert_eq!(view.rows, 50);
        assert!(view.ok);
    }

    #[test]
    fn a_snapshot_without_text_joins_its_lines() {
        let view = parse_snapshot(r#"{"ok":true,"lines":["a",null,3,""]}"#).unwrap();
        assert_eq!(view.text, "a\n\n3");
        assert_eq!((view.cols, view.rows), (0, 0));
    }

    #[test]
    fn output_that_is_not_json_is_reported_rather_than_guessed_at() {
        assert_eq!(parse_collected("no server running"), None);
        assert_eq!(parse_snapshot("no server running"), None);
        assert_eq!(parse_snapshot("null"), None);
    }
}
