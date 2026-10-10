//! One-touch connection to the agent runtimes people actually use
//! (`src/bun/connect/targets.ts`).
//!
//! The targets are not one kind of thing:
//!
//! * Claude Code, Codex, opencode, Hermes and friends are **MCP hosts**:
//!   connecting means writing an entry into a config file they already own, in
//!   a format and place that differs per tool.
//! * Ollama, llama.cpp, LM Studio, vLLM, Strata and Unsloth are **model
//!   servers**: they speak OpenAI-compatible HTTP and have no notion of MCP, so
//!   there is nothing to configure on their side.
//!
//! Every config path, dialect and CLI invocation here is byte-for-byte what the
//! TypeScript writes, so a config written by either implementation is accepted
//! by the other as "unchanged".

use super::merge::{
    merge_codex_toml, merge_hermes_yaml, merge_mcp_json, merge_opencode_json, remove_from_codex_toml,
    remove_from_hermes_yaml, remove_from_mcp_json, remove_from_opencode_json, MergeError, StdioServer,
};
use crate::app_paths::app_data_path;
use crate::okf::error as fs_helpers;
use crate::okf::nodepath;
use crate::shared::connect_types::{BulkConnectOutcome, BulkConnectStatus};
use crate::shared::js_compat::{from_utf16, is_js_space, to_utf16};
use crate::shared::messages;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};

pub const SERVER_NAME: &str = "okf-wiki";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    McpHost,
    ModelServer,
}

impl TargetKind {
    /// The TS `kind` string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::McpHost => "mcp-host",
            Self::ModelServer => "model-server",
        }
    }
}

/// The config dialect a host expects. Several hosts share one (Claude Code and
/// Antigravity are both plain `mcpServers` JSON), so the format is the thing
/// worth naming, not the tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFormat {
    McpJson,
    CodexToml,
    OpencodeJson,
    HermesYaml,
}

impl ConfigFormat {
    /// The TS format id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::McpJson => "mcp-json",
            Self::CodexToml => "codex-toml",
            Self::OpencodeJson => "opencode-json",
            Self::HermesYaml => "hermes-yaml",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        [Self::McpJson, Self::CodexToml, Self::OpencodeJson, Self::HermesYaml]
            .into_iter()
            .find(|f| f.as_str() == id)
    }

    pub fn merge(self, existing: Option<&str>, name: &str, server: &StdioServer) -> Result<String, MergeError> {
        match self {
            Self::McpJson => merge_mcp_json(existing, name, server),
            Self::CodexToml => merge_codex_toml(existing, name, server),
            Self::OpencodeJson => merge_opencode_json(existing, name, server),
            Self::HermesYaml => merge_hermes_yaml(existing, name, server),
        }
    }

    /// Take our entry back out; `None` when there was nothing of ours.
    pub fn remove(self, existing: Option<&str>, name: &str) -> Option<String> {
        match self {
            Self::McpJson => remove_from_mcp_json(existing, name),
            Self::CodexToml => remove_from_codex_toml(existing, name),
            Self::OpencodeJson => remove_from_opencode_json(existing, name),
            Self::HermesYaml => remove_from_hermes_yaml(existing, name),
        }
    }
}

/// What `setup_command` returns, when it is not a shell command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupKind {
    /// A config snippet to paste. Telling the user to "run" a JSON object is the
    /// mistake this exists to prevent.
    Snippet,
}

/// A command run in a child process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliInvocation {
    pub command: String,
    pub args: Vec<String>,
    /// Fed to the process's stdin, for a prompt with no flag to skip it.
    pub stdin: Option<String>,
}

type ConfigPathFn = Arc<dyn Fn(&str) -> String + Send + Sync>;
type SetupFn = Arc<dyn Fn(&str, &str, &StdioServer) -> String + Send + Sync>;
type CliFn = Arc<dyn Fn(&StdioServer, &str) -> CliInvocation + Send + Sync>;
type CliRemoveFn = Arc<dyn Fn(&str) -> CliInvocation + Send + Sync>;

#[derive(Clone)]
pub struct ConnectTarget {
    pub id: String,
    pub label: String,
    pub kind: TargetKind,
    /// Where the config lives, for showing the user before anything is written.
    pub config_path: ConfigPathFn,
    /// Executable that indicates the tool is installed.
    pub probe: Option<String>,
    /// Default endpoint, for model servers.
    pub endpoint: Option<String>,
    /// Environment variable holding the model server's API key. Read at
    /// request time and never written anywhere.
    pub api_key_env: Option<String>,
    /// Which config dialect to write. Absent for model servers.
    pub format: Option<ConfigFormat>,
    /// A command for the user to run, when writing the file ourselves would be
    /// wrong (`~/.claude.json` also holds per-project state). Arguments:
    /// bundle root, server command line, server spec.
    pub setup_command: Option<SetupFn>,
    pub setup_kind: Option<SetupKind>,
    /// Connect by running the tool's own CLI instead of editing its config.
    pub cli: Option<CliFn>,
    /// Undo `cli`, for uninstall.
    pub cli_remove: Option<CliRemoveFn>,
    pub note: String,
}

impl std::fmt::Debug for ConnectTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectTarget")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("format", &self.format)
            .finish_non_exhaustive()
    }
}

impl ConnectTarget {
    pub fn config_path(&self, bundle_root: &str) -> String {
        (self.config_path)(bundle_root)
    }

    /// A target with only the required fields; the rest are `None`.
    pub fn new(
        id: &str,
        label: &str,
        kind: TargetKind,
        config_path: impl Fn(&str) -> String + Send + Sync + 'static,
    ) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind,
            config_path: Arc::new(config_path),
            probe: None,
            endpoint: None,
            api_key_env: None,
            format: None,
            setup_command: None,
            setup_kind: None,
            cli: None,
            cli_remove: None,
            note: String::new(),
        }
    }
}

fn home() -> String {
    std::env::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// XDG-style config root. opencode follows XDG on every platform, including
/// Windows, so this does not branch to `%APPDATA%`.
fn xdg_config() -> String {
    env_nonempty("XDG_CONFIG_HOME").unwrap_or_else(|| nodepath::join(&[&home(), ".config"]))
}

/// Where Hermes keeps its config. Shown to the user, not written to:
/// `hermes mcp add` decides for itself.
fn hermes_config_path() -> String {
    if cfg!(windows) {
        let local = env_nonempty("LOCALAPPDATA")
            .unwrap_or_else(|| nodepath::join(&[&home(), "AppData", "Local"]));
        return nodepath::join(&[&local, "hermes", "config.yaml"]);
    }
    nodepath::join(&[&home(), ".hermes", "config.yaml"])
}

/// Our own settings live beside the MCP server registry.
fn registry_path_for(file: &str) -> String {
    app_data_path(file)
}

fn build_targets() -> Vec<ConnectTarget> {
    use TargetKind::{McpHost, ModelServer};

    let mut t: Vec<ConnectTarget> = Vec::new();

    // Project scope: dropping `.mcp.json` in the bundle means running `claude`
    // from the bundle just works, and nothing global is touched.
    t.push({
        let mut x = ConnectTarget::new("claude-code", "Claude Code", McpHost, |b| nodepath::join(&[b, ".mcp.json"]));
        x.format = Some(ConfigFormat::McpJson);
        x.probe = Some("claude".into());
        x.note = "バンドル内に .mcp.json を作ります。バンドルのフォルダで claude を起動し、初回の承認プロンプトで許可してください。".into();
        x
    });
    t.push({
        let mut x = ConnectTarget::new("codex", "Codex", McpHost, |_| nodepath::join(&[&home(), ".codex", "config.toml"]));
        x.format = Some(ConfigFormat::CodexToml);
        x.probe = Some("codex".into());
        x.note = "~/.codex/config.toml に [mcp_servers.okf-wiki] を追記します。他の設定は変更しません。".into();
        x
    });
    t.push({
        let mut x = ConnectTarget::new("opencode", "opencode", McpHost, |_| {
            nodepath::join(&[&xdg_config(), "opencode", "opencode.json"])
        });
        x.format = Some(ConfigFormat::OpencodeJson);
        x.probe = Some("opencode".into());
        x.note = "~/.config/opencode/opencode.json の mcp に追記します。".into();
        x
    });
    // No `format`: Hermes owns this file and its own CLI writes it.
    t.push({
        let mut x = ConnectTarget::new("hermes", "Hermes Agent", McpHost, |_| hermes_config_path());
        x.probe = Some("hermes".into());
        x.cli = Some(Arc::new(|server, name| {
            let mut args: Vec<String> = vec!["mcp".into(), "add".into(), name.into(), "--command".into(), server.command.clone()];
            for (key, value) in &server.env {
                args.push("--env".into());
                args.push(format!("{key}={value}"));
            }
            // `hermes mcp add --help`: "--args ... must be the last option".
            if !server.args.is_empty() {
                args.push("--args".into());
                args.extend(server.args.iter().cloned());
            }
            // It asks, and there is no flag to stop it asking: one question on
            // a first run and two when the name is already registered
            // ("Overwrite?" comes first). Both are answered; the spare line is
            // read by nobody.
            CliInvocation { command: "hermes".into(), args, stdin: Some("y\ny\n".into()) }
        }));
        // `hermes mcp remove` also clears the OAuth tokens it stored.
        x.cli_remove = Some(Arc::new(|name| CliInvocation {
            command: "hermes".into(),
            args: vec!["mcp".into(), "remove".into(), name.into()],
            stdin: Some("y\n".into()),
        }));
        x.note = "hermes mcp add で登録します（Hermes が接続を検証し、ツールを有効化します）。反映は次のセッションからです。".into();
        x
    });

    let server = |id: &str, label: &str, probe: Option<&str>, endpoint: &str, note: &str| {
        let mut x = ConnectTarget::new(id, label, ModelServer, |_| registry_path_for("runtimes.json"));
        x.probe = probe.map(String::from);
        x.endpoint = Some(endpoint.to_string());
        x.note = note.to_string();
        x
    };
    t.push(server(
        "ollama",
        "Ollama",
        Some("ollama"),
        "http://localhost:11434/v1",
        "MCP クライアントではないため、本アプリ内蔵のエージェントから使います。tools 対応モデルが必要です。",
    ));
    t.push(server(
        "llamacpp",
        "llama.cpp",
        Some("llama-server"),
        "http://localhost:8080/v1",
        "llama-server を --jinja 付きで起動してください（このフラグが無いとツール呼び出しが効きません）。",
    ));
    t.push(server(
        "lmstudio",
        "LM Studio",
        Some("lms"),
        "http://localhost:1234/v1",
        "LM Studio でモデルを読み込み、Server タブで「Start Server」を押してください。認証は不要です（ループバック限定）。",
    ));
    t.push(server(
        "vllm",
        "vLLM",
        Some("vllm"),
        "http://localhost:8000/v1",
        "vllm serve <model> --enable-auto-tool-choice --tool-call-parser <パーサ> で起動してください。両方指定しないとツール呼び出しが無視されます（パーサはモデル依存: llama3_json, hermes など）。",
    ));
    t.push({
        let mut x = server(
            "strata",
            "Strata",
            None,
            "http://127.0.0.1:8080/v1",
            "START-HERE.bat で Strata を起動してください。--api-key を付けて起動した場合は、その値を環境変数 STRATA_API_KEY に設定します。llama.cpp と同じ 8080 番を使うため、同時には起動できません。",
        );
        x.api_key_env = Some("STRATA_API_KEY".into());
        x
    });
    t.push({
        let mut x = server(
            "unsloth",
            "Unsloth Desktop",
            Some("unsloth"),
            "http://127.0.0.1:8888/v1",
            "Unsloth でモデルを読み込み、Settings → API で作成した sk-unsloth-… キーを環境変数 UNSLOTH_API_KEY に設定してください。ポートを変えた場合は既定の 8888 を読み替えてください。",
        );
        x.api_key_env = Some("UNSLOTH_API_KEY".into());
        x
    });

    // Strata's chat page takes servers from `--mcp-config <file with an
    // mcpServers block>`; its own strata-<model>.json is rewritten by setup, so
    // ours is a file of its own.
    t.push({
        let mut x = ConnectTarget::new("strata-mcp", "Strata（チャットの MCP ツール）", McpHost, |_| {
            registry_path_for("strata-mcp.json")
        });
        x.format = Some(ConfigFormat::McpJson);
        x.note = "strata-mcp.json を作ります。run-<model>.bat の serve/server.py の行に --mcp-config <このファイル> を追加し、Strata を再起動してください。チャット画面のみで使えます。".into();
        x
    });
    // Unsloth keeps MCP servers in its SQLite database, which is not ours to
    // write; its import takes the standard mcpServers JSON.
    t.push({
        let mut x = ConnectTarget::new("unsloth-mcp", "Unsloth Desktop（MCP ツール）", McpHost, |_| {
            registry_path_for("unsloth-mcp.json")
        });
        x.probe = Some("unsloth".into());
        x.setup_kind = Some(SetupKind::Snippet);
        x.setup_command = Some(Arc::new(|_bundle, _command, server| {
            merge_mcp_json(None, SERVER_NAME, server).unwrap_or_default()
        }));
        x.note = "Unsloth の設定はデータベースにあるため、本アプリは書き換えません。表示される JSON を Manage MCP servers のインポートに貼り付けてください。".into();
        x
    });
    t.push({
        let mut x = ConnectTarget::new("antigravity", "Antigravity", McpHost, |_| {
            nodepath::join(&[&home(), ".gemini", "config", "mcp_config.json"])
        });
        x.format = Some(ConfigFormat::McpJson);
        x.probe = Some("antigravity".into());
        x.note = "~/.gemini/config/mcp_config.json に追記します。IDE と CLI で共有される全体設定です。".into();
        x
    });
    t.push({
        let mut x = ConnectTarget::new("antigravity-cli", "Antigravity CLI（このバンドルのみ）", McpHost, |b| {
            nodepath::join(&[b, ".agents", "mcp_config.json"])
        });
        x.format = Some(ConfigFormat::McpJson);
        x.probe = Some("antigravity".into());
        x.note = "バンドル内の .agents/mcp_config.json を作ります。プロジェクトスコープなので、あなたの全体設定には一切触れません。".into();
        x
    });
    t.push({
        let mut x = ConnectTarget::new("cursor", "Cursor（このバンドルのみ）", McpHost, |b| {
            nodepath::join(&[b, ".cursor", "mcp.json"])
        });
        x.format = Some(ConfigFormat::McpJson);
        x.probe = Some("cursor".into());
        x.note = "バンドル内の .cursor/mcp.json を作ります。バンドルを Cursor で開いたときに有効です。".into();
        x
    });
    t.push({
        let mut x = ConnectTarget::new("cursor-user", "Cursor（全プロジェクト）", McpHost, |_| {
            nodepath::join(&[&home(), ".cursor", "mcp.json"])
        });
        x.format = Some(ConfigFormat::McpJson);
        x.probe = Some("cursor".into());
        x.note = "~/.cursor/mcp.json に追記します。どのフォルダを開いていても使えます。".into();
        x
    });
    // Claude Code reachable from any directory (Orca gives each agent its own
    // worktree). Not written by this app: `~/.claude.json` also holds
    // per-project state, and `claude mcp add` is the documented way in.
    t.push({
        let mut x = ConnectTarget::new("claude-code-user", "Claude Code（全プロジェクト / Orca 向け）", McpHost, |_| {
            nodepath::join(&[&home(), ".claude.json"])
        });
        x.probe = Some("claude".into());
        x.setup_command = Some(Arc::new(|bundle_root, server_command, _server| {
            format!(
                "claude mcp add {SERVER_NAME} --scope user --env OKF_BUNDLE={} -- {server_command}",
                quote_arg(bundle_root)
            )
        }));
        x.note = "Orca のように作業ディレクトリが変わる環境ではこちらを使ってください。~/.claude.json はプロジェクト状態も持つファイルなので、本アプリは書き換えず、実行するコマンドを表示します。".into();
        x
    });
    t
}

/// The catalogue, in the order the TS lists it.
pub fn connect_targets() -> &'static [ConnectTarget] {
    static TARGETS: OnceLock<Vec<ConnectTarget>> = OnceLock::new();
    TARGETS.get_or_init(build_targets)
}

/// The server as one shell command, for hosts configured by their own CLI.
/// Built from the same spec the config writers use, so the two cannot
/// describe different servers.
pub fn server_command_line(project_root: &str, bundle_root: &str) -> String {
    let spec = server_spec_for(project_root, bundle_root);
    std::iter::once(spec.command.as_str())
        .chain(spec.args.iter().map(String::as_str))
        .map(quote_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Wrap an argument for a shell only when it needs it.
fn quote_arg(value: &str) -> String {
    if value.chars().any(|c| is_js_space(c) || c == '"' || c == '\'') {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

/// The model server's API key, from the variable the target names.
pub fn api_key_for(target: &ConnectTarget) -> String {
    target
        .api_key_env
        .as_deref()
        .and_then(|name| std::env::var(name).ok())
        .unwrap_or_default()
}

pub fn find_target(id: &str) -> Result<&'static ConnectTarget, String> {
    connect_targets()
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| messages::connect_unknown_target(id))
}

/// Whether the tool's executable is on PATH (`where` / `which`).
pub fn is_installed(target: &ConnectTarget) -> bool {
    let Some(probe) = target.probe.as_deref() else { return false };
    let which = if cfg!(windows) { "where" } else { "which" };
    Command::new(which)
        .arg(probe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Where `bun run build:headless` (or the Rust build) puts the self-contained
/// server. The same path for both implementations, so configs written by
/// either agree.
pub fn headless_binary_path(project_root: &str) -> String {
    nodepath::join(&[
        project_root,
        "build",
        "headless",
        if cfg!(windows) { "okf-mcp.exe" } else { "okf-mcp" },
    ])
}

/// The installation this process is actually running out of.
///
/// Looks for a directory that genuinely contains the server, from each start
/// point and walking up. Returns `None` when this installation cannot host the
/// server at all: writing a command into someone's config in that state is
/// worse than saying so. `start_points` defaults to the running executable's
/// directory.
pub fn find_install_root(start_points: Option<&[&str]>) -> Option<String> {
    let default_start: Vec<String> = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
        .into_iter()
        .collect();
    let owned: Vec<&str>;
    let starts: &[&str] = match start_points {
        Some(s) => s,
        None => {
            owned = default_start.iter().map(String::as_str).collect();
            &owned
        }
    };

    for start in starts {
        let mut dir = nodepath::resolve1(start);
        // Deep enough for build/dev-<platform>/<App>/bin, and bounded so a
        // virtual root cannot spin.
        for _hop in 0..8 {
            if Path::new(&nodepath::join(&[&dir, "src", "bun", "mcp", "standalone.ts"])).exists() {
                return Some(dir);
            }
            if Path::new(&headless_binary_path(&dir)).exists() {
                return Some(dir);
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

/// How this app should be launched as an MCP server.
///
/// Prefers the compiled headless binary when it has been built: an agent gets
/// the same workspace without the window and needs no Bun on PATH. Falls back
/// to `bun run` so a checkout that has not built anything still connects.
pub fn server_spec_for(project_root: &str, bundle_root: &str) -> StdioServer {
    let binary = headless_binary_path(project_root);
    let mut env = indexmap::IndexMap::new();
    env.insert("OKF_BUNDLE".to_string(), bundle_root.replace('\\', "/"));

    if Path::new(&binary).exists() {
        return StdioServer { command: binary.replace('\\', "/"), args: Vec::new(), env };
    }
    StdioServer {
        command: bun_command(),
        args: vec![
            "run".into(),
            nodepath::join(&[project_root, "src", "bun", "mcp", "standalone.ts"]).replace('\\', "/"),
        ],
        env,
    }
}

/// How to invoke Bun in a config another program will spawn from.
///
/// An absolute path wherever one can be found, because bare `bun` is only on
/// PATH in a login shell (a GUI-launched agent host on macOS inherits
/// launchd's PATH). The TS uses `process.execPath` when it is running under
/// Bun; this process is not Bun, so the first `bun` on PATH stands in for it.
pub fn bun_command() -> String {
    let exe = if cfg!(windows) { "bun.exe" } else { "bun" };
    if let Some(found) = find_on_path(exe) {
        return found.replace('\\', "/");
    }
    if let Some(home) = env_nonempty("HOME").or_else(|| env_nonempty("USERPROFILE")) {
        let installed = nodepath::join(&[&home, ".bun", "bin", exe]);
        if Path::new(&installed).exists() {
            return installed.replace('\\', "/");
        }
    }
    // Nothing absolute to point at. Bare `bun` still works wherever PATH is
    // inherited, which is every terminal-launched host.
    "bun".to_string()
}

/// The first file called `name` in a PATH directory.
fn find_on_path(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Resolve a bare command name against PATH (with PATHEXT on Windows), the
/// way Bun's spawn does; a name with a separator is used as given.
pub fn resolve_command(command: &str) -> String {
    if command.contains('/') || command.contains('\\') {
        return command.to_string();
    }
    if cfg!(windows) {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let mut names: Vec<String> = vec![command.to_string()];
        names.extend(exts.split(';').filter(|e| !e.is_empty()).map(|e| format!("{command}{e}")));
        for name in names {
            if let Some(found) = find_on_path(&name) {
                return found;
            }
        }
        return command.to_string();
    }
    find_on_path(command).unwrap_or_else(|| command.to_string())
}

/// Render a CLI invocation the way a user would type it.
pub fn format_invocation(invocation: &CliInvocation) -> String {
    let quote = |part: &str| {
        if part.chars().any(is_js_space) {
            format!("\"{part}\"")
        } else {
            part.to_string()
        }
    };
    std::iter::once(invocation.command.as_str())
        .chain(invocation.args.iter().map(String::as_str))
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ")
}

/// What a child process produced.
#[derive(Debug, Clone)]
pub struct ProcessOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run an invocation to completion with piped output, feeding its stdin.
///
/// A missing executable is an error worded like Bun's, which is what reaches
/// the user when the tool is not installed.
pub fn run_invocation(invocation: &CliInvocation) -> Result<ProcessOutput, String> {
    let mut child = Command::new(resolve_command(&invocation.command))
        .args(&invocation.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("Executable not found in $PATH: \"{}\"", invocation.command)
            } else {
                e.to_string()
            }
        })?;

    // Written from a thread: a child that fills its output pipes before
    // reading stdin would otherwise deadlock against us.
    let stdin = child.stdin.take();
    let input = invocation.stdin.clone();
    let writer = std::thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            if let Some(input) = input {
                let _ = stdin.write_all(input.as_bytes());
            }
        }
    });
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();

    Ok(ProcessOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// `String.prototype.slice(-n)` on UTF-16 code units.
fn tail_utf16(text: &str, n: usize) -> String {
    let units = to_utf16(text);
    let start = units.len().saturating_sub(n);
    from_utf16(&units[start..])
}

/// Run the tool's own connect command.
///
/// Output is captured rather than inherited: it is a wall of discovered tool
/// descriptions on success, and the one line that matters on failure. Exit
/// code alone is not enough: `hermes mcp add` answers the enable prompt with
/// "Cancelled." and still exits 0 when it cannot read a reply.
fn run_connect_cli(label: &str, invocation: &CliInvocation) -> Result<(), String> {
    let out = run_invocation(invocation)?;
    let output = format!("{}\n{}", out.stdout, out.stderr);
    let trimmed = crate::shared::js_compat::js_trim(&output);
    let cancelled = trimmed
        .strip_suffix('.')
        .unwrap_or(trimmed)
        .ends_with("Cancelled");
    if out.code != 0 || cancelled {
        return Err(messages::connect_cli_failed(
            label,
            &format_invocation(invocation),
            &tail_utf16(trimmed, 400),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectResult {
    pub target: String,
    pub path: String,
    /// Where the previous version was moved, when there was one.
    pub backup: Option<String>,
    /// True when the file did not exist before.
    pub created: bool,
    /// True when the config already said this and nothing was written.
    pub unchanged: bool,
}

pub struct ConnectOptions<'a> {
    pub target_id: &'a str,
    pub project_root: &'a str,
    pub bundle_root: &'a str,
    /// The already-resolved target: saves a lookup for a caller walking the
    /// catalogue, and lets a test drive this with a target pointing somewhere
    /// harmless.
    pub target: Option<&'a ConnectTarget>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Write the connection into the target's config.
///
/// Always takes a backup first. These are other tools' files, and a merge that
/// goes wrong should cost the user a rename, not their settings.
pub fn connect_target(options: &ConnectOptions) -> Result<ConnectResult, String> {
    let target = match options.target {
        Some(t) => t,
        None => find_target(options.target_id)?,
    };
    let path = target.config_path(options.bundle_root);
    let server = server_spec_for(options.project_root, options.bundle_root);

    // The tool's own CLI, when it has one. It writes its own file, in its own
    // shape, wherever it actually keeps it, and reports failure honestly.
    if let Some(cli) = &target.cli {
        run_connect_cli(&target.label, &cli(&server, SERVER_NAME))?;
        return Ok(ConnectResult {
            target: target.id.clone(),
            path,
            backup: None,
            created: false,
            unchanged: false,
        });
    }

    let existing = fs_helpers::read_text(&path).ok();

    // Model servers have nothing to configure on their side.
    let Some(format) = target.format else {
        return Err(messages::connect_unknown_target(options.target_id));
    };
    let next = format
        .merge(existing.as_deref(), SERVER_NAME, &server)
        .map_err(|e| e.0)?;

    // Already says exactly this. Writing would only mint another backup, and
    // Claude Code's config lives *inside* the bundle.
    if existing.as_deref() == Some(next.as_str()) {
        return Ok(ConnectResult {
            target: target.id.clone(),
            path,
            backup: None,
            created: false,
            unchanged: true,
        });
    }

    let mut backup = None;
    if existing.is_some() {
        let name = format!("{path}.okf-backup-{}", now_ms());
        fs_helpers::rename(&path, &name).map_err(|e| e.to_string())?;
        backup = Some(name);
    }

    // Another tool's config: if the write fails after the original was moved
    // aside, put the original back rather than leave that tool with none.
    let written = fs_helpers::mkdir_p(&nodepath::dirname(&path)).and_then(|_| fs_helpers::write_text(&path, &next));
    if let Err(error) = written {
        if let Some(saved) = &backup {
            let _ = fs_helpers::rename(saved, &path);
        }
        return Err(error.to_string());
    }

    Ok(ConnectResult {
        target: target.id.clone(),
        path,
        backup,
        created: existing.is_none(),
        unchanged: false,
    })
}

pub struct ConnectAllOptions<'a> {
    pub project_root: &'a str,
    pub bundle_root: &'a str,
    /// Write configs for hosts whose executable was not found on PATH too.
    pub include_missing: bool,
    /// The catalogue to sweep. Overridable so tests stay out of the real home.
    pub targets: Option<&'a [ConnectTarget]>,
    /// How to decide a tool is present. Overridable for the same reason.
    pub probe_installed: Option<&'a dyn Fn(&ConnectTarget) -> bool>,
}

/// Register this bundle with every agent on the machine, in one action.
///
/// * Only MCP hosts: model servers have nothing on their side to configure.
/// * Only tools that are actually here, unless `include_missing`.
/// * A host we deliberately do not write is reported (with its command), not
///   skipped. A snippet is only reported where its tool is.
///
/// One failure never stops the rest. Sequential on purpose: `hermes mcp add`
/// answers prompts on stdin, and two targets sharing a config file would race
/// for the same `.okf-backup-<timestamp>` name.
pub fn connect_all_targets(options: &ConnectAllOptions) -> Vec<BulkConnectOutcome> {
    let catalogue = options.targets.unwrap_or_else(|| connect_targets());
    let probe = |target: &ConnectTarget| match options.probe_installed {
        Some(f) => f(target),
        None => is_installed(target),
    };
    let mut outcomes = Vec::new();

    for target in catalogue.iter().filter(|t| t.kind == TargetKind::McpHost) {
        let path = target.config_path(options.bundle_root);
        let base = |status| BulkConnectOutcome {
            target: target.id.clone(),
            label: target.label.clone(),
            status,
            path: path.clone(),
            backup: None,
            command: None,
            snippet: None,
            reason: None,
        };
        let installed = || options.include_missing || probe(target);

        if target.setup_kind == Some(SetupKind::Snippet) && !installed() {
            let mut o = base(BulkConnectStatus::Skipped);
            o.reason = Some(messages::connect_not_installed(&target.label));
            outcomes.push(o);
            continue;
        }

        if let Some(setup) = &target.setup_command {
            let mut o = base(BulkConnectStatus::Manual);
            o.command = Some(setup(
                options.bundle_root,
                &server_command_line(options.project_root, options.bundle_root),
                &server_spec_for(options.project_root, options.bundle_root),
            ));
            if target.setup_kind == Some(SetupKind::Snippet) {
                o.snippet = Some(true);
            }
            outcomes.push(o);
            continue;
        }

        if !installed() {
            let mut o = base(BulkConnectStatus::Skipped);
            o.reason = Some(messages::connect_not_installed(&target.label));
            outcomes.push(o);
            continue;
        }

        match connect_target(&ConnectOptions {
            target_id: &target.id,
            project_root: options.project_root,
            bundle_root: options.bundle_root,
            target: Some(target),
        }) {
            Ok(result) => {
                let mut o = base(if result.unchanged {
                    BulkConnectStatus::Unchanged
                } else {
                    BulkConnectStatus::Connected
                });
                o.path = result.path;
                o.backup = result.backup;
                outcomes.push(o);
            }
            Err(reason) => {
                let mut o = base(BulkConnectStatus::Failed);
                o.reason = Some(reason);
                outcomes.push(o);
            }
        }
    }

    outcomes
}

/// The connection entry on its own, in one host's dialect.
///
/// For a tool this app has no target for, where the answer is a snippet to
/// paste. Built from [`server_spec_for`] like everything else, so a pasted
/// config and a written one cannot describe different servers.
pub fn render_server_config(format: ConfigFormat, project_root: &str, bundle_root: &str) -> Result<String, MergeError> {
    format.merge(None, SERVER_NAME, &server_spec_for(project_root, bundle_root))
}

/// Preview the exact bytes that [`connect_target`] would write.
pub fn preview_target(target_id: &str, project_root: &str, bundle_root: &str) -> Result<(String, String), String> {
    let target = find_target(target_id)?;
    let path = target.config_path(bundle_root);
    let server = server_spec_for(project_root, bundle_root);

    // Nothing to diff for a CLI target: what gets previewed is the command that
    // will run, which is the honest answer to "what are you about to do".
    if let Some(cli) = &target.cli {
        return Ok((path, format_invocation(&cli(&server, SERVER_NAME))));
    }

    let existing = fs_helpers::read_text(&path).ok();
    let content = match target.format {
        Some(format) => format
            .merge(existing.as_deref(), SERVER_NAME, &server)
            .map_err(|e| e.0)?,
        None => String::new(),
    };
    Ok((path, content))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sorted_ids() -> Vec<String> {
        let mut ids: Vec<String> = connect_targets().iter().map(|t| t.id.clone()).collect();
        ids.sort();
        ids
    }

    fn server() -> StdioServer {
        StdioServer::new(
            "bun",
            &["run", "C:/proj/src/bun/mcp/standalone.ts"],
            &[("OKF_BUNDLE", "C:/notes")],
        )
    }

    fn slash(p: &str) -> String {
        p.replace('\\', "/")
    }

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn path_of(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    // ---- the target catalogue

    #[test]
    fn covers_every_runtime_that_has_been_asked_for() {
        assert_eq!(
            sorted_ids(),
            [
                "antigravity", "antigravity-cli", "claude-code", "claude-code-user", "codex", "cursor",
                "cursor-user", "hermes", "llamacpp", "lmstudio", "ollama", "opencode", "strata",
                "strata-mcp", "unsloth", "unsloth-mcp", "vllm"
            ]
        );
    }

    #[test]
    fn catalogue_keeps_the_ts_order() {
        let ids: Vec<&str> = connect_targets().iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "claude-code", "codex", "opencode", "hermes", "ollama", "llamacpp", "lmstudio", "vllm",
                "strata", "unsloth", "strata-mcp", "unsloth-mcp", "antigravity", "antigravity-cli",
                "cursor", "cursor-user", "claude-code-user"
            ]
        );
    }

    #[test]
    fn orca_the_user_scope_host_offers_a_command_not_a_file_write() {
        let target = find_target("claude-code-user").unwrap();
        assert!(target.format.is_none());
        let setup = target.setup_command.as_ref().unwrap();
        let command = setup("C:/notes", "okf-mcp.exe", &server());
        assert!(command.contains("--scope user"));
        assert!(command.contains("OKF_BUNDLE="));
        assert_eq!(
            command,
            "claude mcp add okf-wiki --scope user --env OKF_BUNDLE=C:/notes -- okf-mcp.exe"
        );
    }

    #[test]
    fn a_bundle_path_with_spaces_is_quoted_in_the_command() {
        let setup = find_target("claude-code-user").unwrap().setup_command.as_ref().unwrap();
        let command = setup("C:/Users/me/My Notes", "okf-mcp.exe", &server());
        assert!(command.contains("\"C:/Users/me/My Notes\""));
    }

    #[test]
    fn every_mcp_host_is_configured_exactly_one_way() {
        for target in connect_targets() {
            if target.kind != TargetKind::McpHost {
                assert!(target.format.is_none(), "{}", target.id);
                continue;
            }
            let ways = [target.format.is_some(), target.cli.is_some(), target.setup_command.is_some()];
            assert_eq!(ways.iter().filter(|w| **w).count(), 1, "{}", target.id);
        }
    }

    #[test]
    fn separates_mcp_hosts_from_model_servers() {
        let kind = |id: &str| find_target(id).unwrap().kind;
        for id in ["claude-code", "codex", "opencode", "hermes"] {
            assert_eq!(kind(id), TargetKind::McpHost);
        }
        assert_eq!(kind("ollama"), TargetKind::ModelServer);
        assert_eq!(kind("llamacpp"), TargetKind::ModelServer);
        assert_eq!(TargetKind::McpHost.as_str(), "mcp-host");
    }

    #[test]
    fn model_servers_carry_a_default_endpoint() {
        let endpoint = |id: &str| find_target(id).unwrap().endpoint.clone().unwrap();
        assert!(endpoint("ollama").contains("11434"));
        assert!(endpoint("llamacpp").contains("8080"));
        assert!(endpoint("lmstudio").contains("1234"));
        assert!(endpoint("vllm").contains("8000"));
    }

    #[test]
    fn vllm_warns_that_tool_calling_needs_two_flags() {
        let note = &find_target("vllm").unwrap().note;
        assert!(note.contains("--enable-auto-tool-choice"));
        assert!(note.contains("--tool-call-parser"));
    }

    #[test]
    fn strata_and_unsloth_desktop_are_reachable_as_model_servers() {
        let strata = find_target("strata").unwrap();
        assert_eq!(strata.kind, TargetKind::ModelServer);
        assert_eq!(strata.endpoint.as_deref(), Some("http://127.0.0.1:8080/v1"));
        let unsloth = find_target("unsloth").unwrap();
        assert_eq!(unsloth.kind, TargetKind::ModelServer);
        assert_eq!(unsloth.endpoint.as_deref(), Some("http://127.0.0.1:8888/v1"));
    }

    #[test]
    fn api_keys_come_from_the_environment_never_from_a_file_we_write() {
        assert_eq!(find_target("unsloth").unwrap().api_key_env.as_deref(), Some("UNSLOTH_API_KEY"));
        assert_eq!(find_target("strata").unwrap().api_key_env.as_deref(), Some("STRATA_API_KEY"));
        assert_eq!(find_target("ollama").unwrap().api_key_env, None);
    }

    #[test]
    fn stratas_chat_gets_the_tools_from_a_mcp_servers_file_it_is_pointed_at() {
        let target = find_target("strata-mcp").unwrap();
        assert_eq!(target.kind, TargetKind::McpHost);
        assert_eq!(target.format, Some(ConfigFormat::McpJson));
        assert!(target.config_path("/bundle").contains("strata-mcp.json"));
        assert!(target.note.contains("--mcp-config"));
    }

    #[test]
    fn unsloth_desktop_is_handed_an_mcp_servers_snippet_to_import() {
        let target = find_target("unsloth-mcp").unwrap();
        assert_eq!(target.kind, TargetKind::McpHost);
        assert!(target.format.is_none());
        assert_eq!(target.setup_kind, Some(SetupKind::Snippet));
        assert_eq!(find_target("claude-code-user").unwrap().setup_kind, None);
        let snippet = (target.setup_command.as_ref().unwrap())("C:/notes", "okf-mcp.exe", &server());
        let parsed: serde_json::Value = serde_json::from_str(&snippet).unwrap();
        assert_eq!(parsed["mcpServers"]["okf-wiki"]["command"], "bun");
        assert_eq!(parsed["mcpServers"]["okf-wiki"]["env"]["OKF_BUNDLE"], "C:/notes");
    }

    #[test]
    fn antigravity_writes_the_documented_mcp_servers_shape() {
        assert_eq!(find_target("antigravity").unwrap().format, Some(ConfigFormat::McpJson));
        assert_eq!(find_target("antigravity-cli").unwrap().format, Some(ConfigFormat::McpJson));
    }

    #[test]
    fn antigravity_cli_is_scoped_to_the_bundle_the_global_one_is_not() {
        let scoped = find_target("antigravity-cli").unwrap().config_path("C:/bundles/mine");
        assert_eq!(slash(&scoped), "C:/bundles/mine/.agents/mcp_config.json");
        let global = find_target("antigravity").unwrap().config_path("C:/bundles/mine");
        assert!(slash(&global).contains(".gemini/config/mcp_config.json"));
    }

    #[test]
    fn llamacpps_note_warns_about_jinja() {
        assert!(find_target("llamacpp").unwrap().note.contains("--jinja"));
    }

    #[test]
    fn claude_code_is_configured_inside_the_bundle_not_globally() {
        let path = slash(&find_target("claude-code").unwrap().config_path("C:/notes"));
        assert_eq!(path, "C:/notes/.mcp.json");
    }

    #[test]
    fn the_other_hosts_are_configured_in_their_own_home_directories() {
        for id in ["codex", "opencode", "hermes"] {
            let path = slash(&find_target(id).unwrap().config_path("C:/notes"));
            assert!(!path.contains("C:/notes"), "{id}: {path}");
        }
    }

    #[test]
    fn an_unknown_target_is_refused() {
        assert_eq!(find_target("nope").unwrap_err(), messages::connect_unknown_target("nope"));
    }

    // ---- the server spec

    #[test]
    fn the_server_spec_pins_the_bundle_so_no_open_bundle_round_trip_is_needed() {
        // No headless binary under this fake root, so it falls back to bun run.
        let spec = server_spec_for("C:/proj-with-no-build", "C:/notes");
        assert_eq!(spec.command, bun_command());
        assert!(spec.args[1].contains("standalone.ts"));
        assert_eq!(spec.env.get("OKF_BUNDLE").map(String::as_str), Some("C:/notes"));
    }

    #[test]
    fn backslashes_in_the_bundle_become_slashes() {
        let spec = server_spec_for("C:/proj-with-no-build", "C:\\Users\\me\\Notes");
        assert_eq!(spec.env.get("OKF_BUNDLE").map(String::as_str), Some("C:/Users/me/Notes"));
    }

    #[test]
    fn the_headless_binary_is_preferred_once_it_has_been_built() {
        let dir = tmp();
        let root = path_of(&dir);
        let binary = headless_binary_path(&root);
        fs::create_dir_all(nodepath::dirname(&binary)).unwrap();
        fs::write(&binary, "").unwrap();

        let spec = server_spec_for(&root, "C:/notes");
        assert!(spec.command.contains("okf-mcp"));
        assert_eq!(spec.command, binary.replace('\\', "/"));
        assert!(spec.args.is_empty());
        assert_eq!(spec.env.get("OKF_BUNDLE").map(String::as_str), Some("C:/notes"));
    }

    #[test]
    fn the_headless_path_is_the_one_the_ts_uses() {
        let path = slash(&headless_binary_path("C:/proj"));
        assert_eq!(
            path,
            if cfg!(windows) { "C:/proj/build/headless/okf-mcp.exe" } else { "C:/proj/build/headless/okf-mcp" }
        );
    }

    // ---- connect_target

    fn connect(dir: &tempfile::TempDir) -> Result<ConnectResult, String> {
        connect_target(&ConnectOptions {
            target_id: "claude-code",
            project_root: &path_of(dir),
            bundle_root: &path_of(dir),
            target: None,
        })
    }

    #[test]
    fn writes_the_config_the_first_time() {
        let dir = tmp();
        let result = connect(&dir).unwrap();
        assert!(result.created);
        assert_eq!(result.backup, None);
        assert!(dir.path().join(".mcp.json").exists());
    }

    #[test]
    fn a_second_run_writes_nothing_and_takes_no_backup() {
        let dir = tmp();
        connect(&dir).unwrap();
        let before = fs::read_to_string(dir.path().join(".mcp.json")).unwrap();

        let result = connect(&dir).unwrap();

        assert!(result.unchanged);
        assert_eq!(result.backup, None);
        assert_eq!(fs::read_to_string(dir.path().join(".mcp.json")).unwrap(), before);
        let backups = fs::read_dir(dir.path()).unwrap().filter(|e| {
            e.as_ref().unwrap().file_name().to_string_lossy().contains("okf-backup")
        });
        assert_eq!(backups.count(), 0);
    }

    #[test]
    fn a_genuine_change_still_takes_a_backup() {
        let dir = tmp();
        connect(&dir).unwrap();
        fs::write(dir.path().join(".mcp.json"), "{\n  \"mcpServers\": {}\n}\n").unwrap();

        let result = connect(&dir).unwrap();

        assert!(!result.unchanged);
        let backup = result.backup.unwrap();
        assert!(Path::new(&backup).exists());
        assert!(backup.contains(".okf-backup-"));
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{\n  \"mcpServers\": {}\n}\n");
    }

    #[test]
    fn a_config_we_cannot_read_is_not_overwritten() {
        let dir = tmp();
        fs::write(dir.path().join(".mcp.json"), "{ // comment\n}").unwrap();
        let err = connect(&dir).unwrap_err();
        assert!(err.contains("失われる"), "{err}");
        assert_eq!(fs::read_to_string(dir.path().join(".mcp.json")).unwrap(), "{ // comment\n}");
    }

    #[test]
    fn model_servers_cannot_be_connected() {
        let dir = tmp();
        let err = connect_target(&ConnectOptions {
            target_id: "ollama",
            project_root: &path_of(&dir),
            bundle_root: &path_of(&dir),
            target: None,
        })
        .unwrap_err();
        assert_eq!(err, messages::connect_unknown_target("ollama"));
    }

    // ---- connect_all_targets

    fn host(id: &str, file: &str) -> ConnectTarget {
        let file = file.to_string();
        let mut t = ConnectTarget::new(id, id, TargetKind::McpHost, move |b| nodepath::join(&[b, &file]));
        t.format = Some(ConfigFormat::McpJson);
        t.probe = Some(id.to_string());
        t
    }

    fn sweep(
        dir: &tempfile::TempDir,
        targets: &[ConnectTarget],
        include_missing: bool,
        installed: &dyn Fn(&ConnectTarget) -> bool,
    ) -> Vec<BulkConnectOutcome> {
        connect_all_targets(&ConnectAllOptions {
            project_root: &path_of(dir),
            bundle_root: &path_of(dir),
            include_missing,
            targets: Some(targets),
            probe_installed: Some(installed),
        })
    }

    fn statuses(report: &[BulkConnectOutcome]) -> Vec<BulkConnectStatus> {
        report.iter().map(|r| r.status).collect()
    }

    #[test]
    fn writes_every_installed_host_in_one_call() {
        let dir = tmp();
        let report = sweep(&dir, &[host("a", "a.json"), host("b", "b.json")], false, &|_| true);
        assert_eq!(statuses(&report), [BulkConnectStatus::Connected, BulkConnectStatus::Connected]);
        assert!(dir.path().join("a.json").exists());
        assert!(dir.path().join("b.json").exists());
    }

    #[test]
    fn a_second_sweep_reports_unchanged_and_leaves_no_backups() {
        let dir = tmp();
        let targets = [host("a", "a.json"), host("b", "b.json")];
        sweep(&dir, &targets, false, &|_| true);
        let report = sweep(&dir, &targets, false, &|_| true);
        assert_eq!(statuses(&report), [BulkConnectStatus::Unchanged, BulkConnectStatus::Unchanged]);
        assert!(fs::read_dir(dir.path())
            .unwrap()
            .all(|e| !e.unwrap().file_name().to_string_lossy().contains("okf-backup")));
    }

    #[test]
    fn a_tool_that_is_not_on_this_machine_is_skipped_with_a_reason() {
        let dir = tmp();
        let report = sweep(
            &dir,
            &[host("here", "here.json"), host("gone", "gone.json")],
            false,
            &|t| t.id == "here",
        );
        assert_eq!(report[1].status, BulkConnectStatus::Skipped);
        assert!(report[1].reason.as_deref().unwrap().contains("gone"));
        assert!(!dir.path().join("gone.json").exists());
    }

    #[test]
    fn include_missing_writes_for_a_tool_the_probe_could_not_see() {
        let dir = tmp();
        let report = sweep(&dir, &[host("cursor", "cursor.json")], true, &|_| false);
        assert_eq!(report[0].status, BulkConnectStatus::Connected);
        assert!(dir.path().join("cursor.json").exists());
    }

    #[test]
    fn a_host_we_must_not_write_is_reported_with_its_command_not_skipped() {
        let dir = tmp();
        let never = nodepath::join(&[&path_of(&dir), "never.json"]);
        let mut manual = ConnectTarget::new("manual-host", "manual-host", TargetKind::McpHost, move |_| never.clone());
        manual.setup_command = Some(Arc::new(|b, _, _| format!("some-cli add --bundle {b}")));

        let report = sweep(&dir, &[manual], false, &|_| true);

        assert_eq!(report[0].status, BulkConnectStatus::Manual);
        assert!(report[0].command.as_deref().unwrap().contains(&path_of(&dir)));
        assert!(!dir.path().join("never.json").exists());
    }

    #[test]
    fn a_snippet_to_paste_is_reported_only_when_its_tool_is_here() {
        let dir = tmp();
        let never = nodepath::join(&[&path_of(&dir), "never.json"]);
        let mut snippet = ConnectTarget::new("snippet-host", "snippet-host", TargetKind::McpHost, move |_| never.clone());
        snippet.probe = Some("snippet-host".into());
        snippet.setup_kind = Some(SetupKind::Snippet);
        snippet.setup_command = Some(Arc::new(|_, _, _| "{ \"mcpServers\": {} }".to_string()));

        let absent = sweep(&dir, std::slice::from_ref(&snippet), false, &|_| false);
        assert_eq!(absent[0].status, BulkConnectStatus::Skipped);

        let present = sweep(&dir, std::slice::from_ref(&snippet), false, &|_| true);
        assert_eq!(present[0].status, BulkConnectStatus::Manual);
        assert_eq!(present[0].snippet, Some(true));
        assert!(!dir.path().join("never.json").exists());
    }

    #[test]
    fn one_failure_does_not_stop_the_rest() {
        let dir = tmp();
        fs::create_dir_all(dir.path().join("blocked.json")).unwrap();
        let report = sweep(&dir, &[host("blocked", "blocked.json"), host("fine", "fine.json")], false, &|_| true);
        assert_eq!(report[0].status, BulkConnectStatus::Failed);
        assert!(!report[0].reason.as_deref().unwrap().is_empty());
        assert_eq!(report[1].status, BulkConnectStatus::Connected);
        assert!(dir.path().join("fine.json").exists());
    }

    #[test]
    fn model_servers_are_left_out_of_the_report_entirely() {
        // Nothing is installed here, so the real catalogue is safe to sweep:
        // every host skips or reports a command.
        let dir = tmp();
        let report = connect_all_targets(&ConnectAllOptions {
            project_root: &path_of(&dir),
            bundle_root: &path_of(&dir),
            include_missing: false,
            targets: None,
            probe_installed: Some(&|_| false),
        });
        let ids: Vec<&str> = report.iter().map(|r| r.target.as_str()).collect();
        for id in ["ollama", "llamacpp", "lmstudio", "vllm", "strata", "unsloth"] {
            assert!(!ids.contains(&id), "{id}");
        }
        assert!(ids.contains(&"codex"));
        assert!(report
            .iter()
            .all(|r| matches!(r.status, BulkConnectStatus::Skipped | BulkConnectStatus::Manual)));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    // ---- render_server_config

    const PROJECT: &str = "C:/proj-with-no-build";
    const BUNDLE: &str = "C:/notes";

    #[test]
    fn render_gives_the_plain_mcp_servers_shape() {
        let text = render_server_config(ConfigFormat::McpJson, PROJECT, BUNDLE).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["mcpServers"]["okf-wiki"]["env"]["OKF_BUNDLE"], "C:/notes");
        assert_eq!(parsed["mcpServers"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn each_dialect_renders_in_its_own_shape() {
        assert!(render_server_config(ConfigFormat::CodexToml, PROJECT, BUNDLE)
            .unwrap()
            .contains("[mcp_servers.okf-wiki]"));
        let opencode: serde_json::Value =
            serde_json::from_str(&render_server_config(ConfigFormat::OpencodeJson, PROJECT, BUNDLE).unwrap()).unwrap();
        assert_eq!(opencode["mcp"]["okf-wiki"]["environment"]["OKF_BUNDLE"], "C:/notes");
        assert!(render_server_config(ConfigFormat::HermesYaml, PROJECT, BUNDLE)
            .unwrap()
            .contains("okf-wiki:"));
    }

    #[test]
    fn render_describes_the_same_server_the_one_press_connection_writes() {
        let spec = server_spec_for(PROJECT, BUNDLE);
        let parsed: serde_json::Value =
            serde_json::from_str(&render_server_config(ConfigFormat::McpJson, PROJECT, BUNDLE).unwrap()).unwrap();
        let entry = &parsed["mcpServers"]["okf-wiki"];
        assert_eq!(entry["command"], spec.command.as_str());
        assert_eq!(entry["args"], serde_json::json!(spec.args));
        assert_eq!(entry["env"]["OKF_BUNDLE"], "C:/notes");
    }

    // ---- find_install_root

    #[test]
    fn finds_a_checkout_by_its_server_source() {
        let dir = tmp();
        let root = path_of(&dir);
        let mcp = dir.path().join("src").join("bun").join("mcp");
        fs::create_dir_all(&mcp).unwrap();
        fs::write(mcp.join("standalone.ts"), "").unwrap();
        assert_eq!(find_install_root(Some(&[&mcp.to_string_lossy()])), Some(nodepath::resolve1(&root)));
    }

    #[test]
    fn walks_up_from_a_nested_executable() {
        let dir = tmp();
        let mcp = dir.path().join("src").join("bun").join("mcp");
        fs::create_dir_all(&mcp).unwrap();
        fs::write(mcp.join("standalone.ts"), "").unwrap();
        let exe = dir.path().join("build").join("dev-win-x64").join("App").join("bin");
        fs::create_dir_all(&exe).unwrap();
        assert_eq!(
            find_install_root(Some(&[&exe.to_string_lossy()])),
            Some(nodepath::resolve1(&path_of(&dir)))
        );
    }

    #[test]
    fn accepts_an_install_that_only_has_the_headless_binary() {
        let dir = tmp();
        let root = path_of(&dir);
        let binary = headless_binary_path(&root);
        fs::create_dir_all(nodepath::dirname(&binary)).unwrap();
        fs::write(&binary, "").unwrap();
        let start = nodepath::join(&[&root, "build", "headless"]);
        assert_eq!(find_install_root(Some(&[&start])), Some(nodepath::resolve1(&root)));
    }

    /// Bun's virtual root: `B:/~BUN/root` on Windows, `/$bunfs/root` elsewhere.
    /// The Windows spelling is a *relative* path on POSIX, which resolves into
    /// the working directory — this repository — and is found there.
    const VIRTUAL_ROOT: &str = if cfg!(windows) { "B:/~BUN/root/okf-wiki" } else { "/$bunfs/root/okf-wiki" };

    #[test]
    fn returns_none_for_a_virtual_root_rather_than_inventing_a_path() {
        assert_eq!(find_install_root(Some(&[VIRTUAL_ROOT])), None);
    }

    #[test]
    fn the_second_start_point_is_used_when_the_first_is_virtual() {
        let dir = tmp();
        let mcp = dir.path().join("src").join("bun").join("mcp");
        fs::create_dir_all(&mcp).unwrap();
        fs::write(mcp.join("standalone.ts"), "").unwrap();
        let root = path_of(&dir);
        assert_eq!(
            find_install_root(Some(&[VIRTUAL_ROOT, &root])),
            Some(nodepath::resolve1(&root))
        );
    }

    // ---- Hermes (its own CLI)

    fn hermes() -> &'static ConnectTarget {
        find_target("hermes").unwrap()
    }

    #[test]
    fn hermes_connects_with_a_command_not_a_merge() {
        assert!(hermes().cli.is_some());
        assert!(hermes().format.is_none());
    }

    #[test]
    fn hermes_builds_the_documented_invocation() {
        let invocation = (hermes().cli.as_ref().unwrap())(&server(), "okf-wiki");
        assert_eq!(invocation.command, "hermes");
        assert_eq!(&invocation.args[..3], ["mcp", "add", "okf-wiki"]);
        let at = invocation.args.iter().position(|a| a == "--command").unwrap();
        assert_eq!(invocation.args[at + 1], "bun");
        assert!(invocation.args.contains(&"OKF_BUNDLE=C:/notes".to_string()));
    }

    #[test]
    fn hermes_puts_args_last_as_its_help_demands() {
        let args = (hermes().cli.as_ref().unwrap())(&server(), "okf-wiki").args;
        let at = args.iter().position(|a| a == "--args").unwrap();
        assert_eq!(args[at + 1..], server().args[..]);
        assert!(!args[at + 1..].iter().any(|a| a.starts_with("--")));
    }

    #[test]
    fn hermes_omits_args_when_the_server_takes_none() {
        let args = (hermes().cli.as_ref().unwrap())(&StdioServer::new("okf-mcp.exe", &[], &[]), "okf-wiki").args;
        assert!(!args.contains(&"--args".to_string()));
    }

    #[test]
    fn hermes_answers_both_prompts_not_just_the_first() {
        assert_eq!(
            (hermes().cli.as_ref().unwrap())(&server(), "okf-wiki").stdin.as_deref(),
            Some("y\ny\n")
        );
    }

    #[test]
    fn hermes_can_undo_itself() {
        let invocation = (hermes().cli_remove.as_ref().unwrap())("okf-wiki");
        assert_eq!(invocation.command, "hermes");
        assert_eq!(invocation.args, ["mcp", "remove", "okf-wiki"]);
        assert_eq!(invocation.stdin.as_deref(), Some("y\n"));
    }

    #[test]
    fn hermes_config_path_is_the_one_hermes_actually_reads() {
        let path = hermes().config_path("");
        if cfg!(windows) {
            assert!(path.to_lowercase().contains("appdata"));
            assert!(path.to_lowercase().contains("local"));
        }
        assert!(path.ends_with("config.yaml"));
    }

    #[test]
    fn hermes_renders_the_command_for_the_preview_pane() {
        let text = format_invocation(&(hermes().cli.as_ref().unwrap())(&server(), "okf-wiki"));
        assert!(text.starts_with("hermes mcp add okf-wiki"));
        assert!(text.contains("--env OKF_BUNDLE=C:/notes"));
    }

    #[test]
    fn format_invocation_quotes_only_parts_with_whitespace() {
        let inv = CliInvocation {
            command: "x".into(),
            args: vec!["a b".into(), "c".into()],
            stdin: None,
        };
        assert_eq!(format_invocation(&inv), "x \"a b\" c");
    }

    #[test]
    fn a_missing_cli_is_reported_in_bun_words() {
        let inv = CliInvocation {
            command: "okf-no-such-tool-xyz".into(),
            args: vec![],
            stdin: None,
        };
        assert_eq!(
            run_invocation(&inv).unwrap_err(),
            "Executable not found in $PATH: \"okf-no-such-tool-xyz\""
        );
    }

    #[test]
    fn preview_of_a_cli_target_is_the_command() {
        let (_, content) = preview_target("hermes", "C:/proj-with-no-build", "C:/notes").unwrap();
        assert!(content.starts_with("hermes mcp add okf-wiki"));
    }
}
