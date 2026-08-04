/**
 * One-touch connection to the agent runtimes people actually use.
 *
 * The six targets are not one kind of thing, and pretending otherwise is the
 * main trap here:
 *
 *   - Claude Code, Codex, opencode and Hermes are **MCP hosts**. Connecting
 *     means writing an entry into a config file they already own, each in a
 *     different format and location.
 *   - Ollama and llama.cpp are **model servers**. They speak OpenAI-compatible
 *     HTTP and have no idea what MCP is, so nothing to configure on their side
 *     — instead this app runs the tool loop itself (see `agent/loop.ts`) and
 *     just needs to know where they are.
 *
 * Every format below was checked against the vendor's own documentation or,
 * for Codex, against a real config file — not recalled.
 */

import { appDataPath } from "../app-paths";
import { homedir, platform } from "os";
import { existsSync } from "fs";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { messages } from "../../shared/messages";
import type { BulkConnectOutcome } from "../../shared/connect-types";
import { mergeCodexToml, mergeHermesYaml, mergeMcpJson, mergeOpencodeJson, type StdioServer } from "./merge";

export type TargetKind = "mcp-host" | "model-server";

/**
 * The config dialect a host expects.
 *
 * Held on the target rather than switched on its id, because it used to be
 * decided in two places — a switch when applying and a ternary chain when
 * previewing — and adding a host meant remembering both. Several hosts share a
 * dialect (Claude Code and Antigravity are both plain `mcpServers` JSON), so
 * the format is the thing worth naming, not the tool.
 */
export type ConfigFormat = "mcp-json" | "codex-toml" | "opencode-json" | "hermes-yaml";

const MERGERS: Record<ConfigFormat, (existing: string | null, name: string, server: StdioServer) => string> = {
  "mcp-json": mergeMcpJson,
  "codex-toml": mergeCodexToml,
  "opencode-json": mergeOpencodeJson,
  "hermes-yaml": mergeHermesYaml,
};

export interface ConnectTarget {
  id: string;
  label: string;
  kind: TargetKind;
  /** Where the config lives, for showing the user before anything is written. */
  configPath: (bundleRoot: string) => string;
  /** Executable that indicates the tool is installed. */
  probe?: string;
  /** Default endpoint, for model servers. */
  endpoint?: string;
  /** Which config dialect to write. Absent for model servers. */
  format?: ConfigFormat;
  /**
   * A command for the user to run, when writing the file ourselves would be
   * wrong.
   *
   * Claude Code user scope is the case: it lives in `~/.claude.json`, which
   * also holds per-project state and server toggles. Hand-merging into a file
   * that big to add one entry risks breaking a working install, and the vendor
   * documents `claude mcp add` as the way in. Showing the command is both
   * safer and supported.
   */
  setupCommand?: (bundleRoot: string, serverCommand: string) => string;
  /**
   * Connect by running the tool's own CLI instead of editing its config.
   *
   * Preferred whenever the vendor ships one. Hermes is the case that forced it:
   * its config is not where the file-writing path assumed (`~/.hermes/`), it is
   * `%LOCALAPPDATA%\hermes\config.yaml` on Windows, `mcp_servers` is nested
   * rather than top-level, and each server carries a per-tool enable list. An
   * entry hand-merged into the wrong file in the wrong shape is not a
   * connection, and looks exactly like one.
   *
   * `hermes mcp add` also connects to the server and discovers its tools, so it
   * validates the thing we are writing — something no amount of careful YAML
   * can do.
   */
  cli?: (server: StdioServer, name: string) => CliInvocation;
  /**
   * Undo `cli`, for uninstall.
   *
   * A target connected through a CLI cannot be disconnected by editing the
   * file: the tool keeps per-server state beside the entry — enabled tools,
   * OAuth tokens — and deleting the entry alone leaves that behind.
   */
  cliRemove?: (name: string) => CliInvocation;
  note: string;
}

export interface CliInvocation {
  command: string;
  args: string[];
  /** Fed to the process's stdin, for a prompt with no flag to skip it. */
  stdin?: string;
}

const home = homedir();

/**
 * XDG-style config root.
 *
 * opencode follows XDG on every platform, including Windows, so this does not
 * branch to `%APPDATA%` the way a Windows-native tool would.
 */
function xdgConfig(): string {
  return process.env.XDG_CONFIG_HOME || join(home, ".config");
}

/**
 * Where Hermes keeps its config.
 *
 * Read off a real v0.20.0 install, which reported saving to
 * `~/AppData\Local\hermes/config.yaml` — not the `~/.hermes/config.yaml` this
 * used to write to. That older path exists on some machines and Hermes ignores
 * it entirely, which is why a connection could be "written" and never appear
 * in `hermes mcp list`.
 *
 * Shown to the user, not written to: `hermes mcp add` decides for itself, so
 * being wrong here costs a wrong label rather than a lost connection.
 */
function hermesConfigPath(): string {
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(local, "hermes", "config.yaml");
  }
  return join(home, ".hermes", "config.yaml");
}

export const CONNECT_TARGETS: readonly ConnectTarget[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "mcp-host",
    format: "mcp-json",
    // Project scope: dropping `.mcp.json` in the bundle means running `claude`
    // from the bundle just works, and nothing global is touched.
    configPath: (bundleRoot) => join(bundleRoot, ".mcp.json"),
    probe: "claude",
    // Verified with `claude mcp list`: a project-scope server shows as
    // "Pending approval" until the first `claude` in that folder asks. Saying
    // so here stops that reading as a failed connection.
    note: "バンドル内に .mcp.json を作ります。バンドルのフォルダで claude を起動し、初回の承認プロンプトで許可してください。",
  },
  {
    id: "codex",
    label: "Codex",
    kind: "mcp-host",
    format: "codex-toml",
    configPath: () => join(home, ".codex", "config.toml"),
    probe: "codex",
    note: "~/.codex/config.toml に [mcp_servers.okf-wiki] を追記します。他の設定は変更しません。",
  },
  {
    id: "opencode",
    label: "opencode",
    kind: "mcp-host",
    format: "opencode-json",
    configPath: () => join(xdgConfig(), "opencode", "opencode.json"),
    probe: "opencode",
    note: "~/.config/opencode/opencode.json の mcp に追記します。",
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    kind: "mcp-host",
    // No `format`: Hermes owns this file and its own CLI writes it. Verified
    // against v0.20.0 — `hermes mcp add` connected, discovered all 39 tools
    // and enabled them, and `hermes mcp list` shows the result.
    configPath: () => hermesConfigPath(),
    probe: "hermes",
    cli: (server, name) => ({
      command: "hermes",
      args: [
        "mcp",
        "add",
        name,
        "--command",
        server.command,
        ...Object.entries(server.env ?? {}).flatMap(([key, value]) => [
          "--env",
          `${key}=${value}`,
        ]),
        // `hermes mcp add --help`: "--args ... must be the last option".
        ...(server.args?.length ? ["--args", ...server.args] : []),
      ],
      /*
       * It asks, and there is no flag to stop it asking.
       *
       * One question on a first run — "Enable all N tools?" — and two when the
       * name is already registered, because "Overwrite?" comes first. A single
       * "y" answered the wrong one on every re-run: the overwrite went
       * through, the enable prompt got EOF, and Hermes cancelled having
       * changed nothing. Reconnecting is the common case, so both are answered
       * and the spare line is read by nobody.
       */
      stdin: "y\ny\n",
    }),
    // `hermes mcp remove` also clears the OAuth tokens it stored, which taking
    // the YAML entry out by hand would leave behind.
    cliRemove: (name) => ({ command: "hermes", args: ["mcp", "remove", name], stdin: "y\n" }),
    note: "hermes mcp add で登録します（Hermes が接続を検証し、ツールを有効化します）。反映は次のセッションからです。",
  },
  {
    id: "ollama",
    label: "Ollama",
    kind: "model-server",
    configPath: () => registryPathFor("runtimes.json"),
    probe: "ollama",
    endpoint: "http://localhost:11434/v1",
    note: "MCP クライアントではないため、本アプリ内蔵のエージェントから使います。tools 対応モデルが必要です。",
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    kind: "model-server",
    configPath: () => registryPathFor("runtimes.json"),
    probe: "llama-server",
    endpoint: "http://localhost:8080/v1",
    // Verified against llama.cpp's own server README: tool calling is behind
    // --jinja, and a user who misses that sees the model ignore every tool.
    note: "llama-server を --jinja 付きで起動してください（このフラグが無いとツール呼び出しが効きません）。",
  },
  {
    // lmstudio.ai's own docs: the server listens on 1234 and the
    // /v1/chat/completions contract is identical to OpenAI's. No API key —
    // access control is the loopback bind, which is why this needs none here.
    id: "lmstudio",
    label: "LM Studio",
    kind: "model-server",
    configPath: () => registryPathFor("runtimes.json"),
    probe: "lms",
    endpoint: "http://localhost:1234/v1",
    note: "LM Studio でモデルを読み込み、Server タブで「Start Server」を押してください。認証は不要です（ループバック限定）。",
  },
  {
    // vLLM's own tool-calling docs: automatic tool choice is off unless BOTH
    // --enable-auto-tool-choice and a --tool-call-parser are given, and the
    // parser depends on the model. Without them the model ignores every tool,
    // which looks like this app being broken rather than a missing flag.
    id: "vllm",
    label: "vLLM",
    kind: "model-server",
    configPath: () => registryPathFor("runtimes.json"),
    probe: "vllm",
    endpoint: "http://localhost:8000/v1",
    note: "vllm serve <model> --enable-auto-tool-choice --tool-call-parser <パーサ> で起動してください。両方指定しないとツール呼び出しが無視されます（パーサはモデル依存: llama3_json, hermes など）。",
  },
  {
    // antigravity.google/docs/mcp: `mcpServers`, the same shape Claude Code
    // uses. The global file lives under ~/.gemini because the CLI and the IDE
    // share one agent harness.
    id: "antigravity",
    label: "Antigravity",
    kind: "mcp-host",
    format: "mcp-json",
    configPath: () => join(home, ".gemini", "config", "mcp_config.json"),
    probe: "antigravity",
    note: "~/.gemini/config/mcp_config.json に追記します。IDE と CLI で共有される全体設定です。",
  },
  {
    // The workspace-scoped file from the same docs. Preferred for the same
    // reason Claude Code's project scope is: nothing global is touched, and
    // running the CLI from the bundle just works.
    id: "antigravity-cli",
    label: "Antigravity CLI（このバンドルのみ）",
    kind: "mcp-host",
    format: "mcp-json",
    configPath: (bundleRoot) => join(bundleRoot, ".agents", "mcp_config.json"),
    probe: "antigravity",
    note: "バンドル内の .agents/mcp_config.json を作ります。プロジェクトスコープなので、あなたの全体設定には一切触れません。",
  },
  {
    // cursor.com/docs/context/mcp: `.cursor/mcp.json` for a project,
    // `~/.cursor/mcp.json` for everywhere, both plain `mcpServers`.
    id: "cursor",
    label: "Cursor（このバンドルのみ）",
    kind: "mcp-host",
    format: "mcp-json",
    configPath: (bundleRoot) => join(bundleRoot, ".cursor", "mcp.json"),
    probe: "cursor",
    note: "バンドル内の .cursor/mcp.json を作ります。バンドルを Cursor で開いたときに有効です。",
  },
  {
    // The global one. Also the scope that survives an orchestrator running
    // Cursor's agent from somewhere that is not the bundle.
    id: "cursor-user",
    label: "Cursor（全プロジェクト）",
    kind: "mcp-host",
    format: "mcp-json",
    configPath: () => join(home, ".cursor", "mcp.json"),
    probe: "cursor",
    note: "~/.cursor/mcp.json に追記します。どのフォルダを開いていても使えます。",
  },
  {
    /**
     * Claude Code, but reachable from any directory.
     *
     * Needed because of how orchestrators actually run agents. Orca gives each
     * agent its own git worktree, so an agent never has the knowledge bundle
     * as its working directory and a project-scoped `.mcp.json` there is never
     * found. User scope is the only scope that survives that.
     *
     * Not written by this app: Claude Code keeps user-scoped servers in
     * `~/.claude.json`, which also holds per-project state and per-server
     * toggles. Merging into it to add one entry risks breaking a working
     * install, and `claude mcp add` is the documented way in.
     */
    id: "claude-code-user",
    label: "Claude Code（全プロジェクト / Orca 向け）",
    kind: "mcp-host",
    configPath: () => join(home, ".claude.json"),
    probe: "claude",
    setupCommand: (bundleRoot, serverCommand) =>
      `claude mcp add ${SERVER_NAME} --scope user --env OKF_BUNDLE=${quoteArg(bundleRoot)} -- ${serverCommand}`,
    note:
      "Orca のように作業ディレクトリが変わる環境ではこちらを使ってください。" +
      "~/.claude.json はプロジェクト状態も持つファイルなので、本アプリは書き換えず、実行するコマンドを表示します。",
  },
];

/**
 * The server as one shell command, for hosts configured by their own CLI.
 *
 * Built from the same spec the config writers use, so the two cannot describe
 * different servers.
 */
export function serverCommandLine(projectRoot: string, bundleRoot: string): string {
  const spec = serverSpecFor(projectRoot, bundleRoot);
  return [spec.command, ...(spec.args ?? [])].map(quoteArg).join(" ");
}

/** Wrap an argument for a shell only when it needs it. */
function quoteArg(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Our own settings live beside the MCP server registry. */
function registryPathFor(file: string): string {
  return appDataPath(file);
}

export function findTarget(id: string): ConnectTarget {
  const target = CONNECT_TARGETS.find((t) => t.id === id);
  if (!target) throw new Error(messages.connectUnknownTarget(id));
  return target;
}

/** Whether the tool's executable is on PATH. */
export async function isInstalled(target: ConnectTarget): Promise<boolean> {
  if (!target.probe) return false;
  const which = platform() === "win32" ? "where" : "which";
  try {
    const proc = Bun.spawn([which, target.probe], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Where `bun run build:headless` puts the self-contained server. */
export function headlessBinaryPath(projectRoot: string): string {
  return join(
    projectRoot,
    "build",
    "headless",
    platform() === "win32" ? "okf-mcp.exe" : "okf-mcp"
  );
}

/**
 * The installation this process is actually running out of.
 *
 * `resolve(import.meta.dir, "..", "..")` is right only when the code runs from
 * a source checkout. Inside a compiled binary or an ASAR, `import.meta.dir` is
 * a *virtual* path — Bun uses `B:\~BUN\root\` on Windows — so that arithmetic
 * produced `B:/` and the connection panel wrote agents a command pointing at
 * `B:/src/bun/mcp/standalone.ts`. The config looked right, the agent host
 * failed to spawn anything, and nothing said why.
 *
 * So: look for a directory that genuinely contains the server, from the module
 * and from the executable both. `process.execPath` is a real path in every
 * packaging, which is what makes the second start worth having.
 *
 * Returns null when this installation cannot host the server at all — a
 * packaged app with no source and no headless build beside it. Writing a
 * command into someone's config in that state is worse than saying so.
 */
export function findInstallRoot(startPoints?: readonly string[]): string | null {
  const starts = startPoints ?? [import.meta.dir, dirname(process.execPath)];

  for (const start of starts) {
    let dir = resolve(start);
    // Deep enough for build/dev-<platform>/<App>/bin, and bounded so a virtual
    // root cannot spin.
    for (let hop = 0; hop < 8; hop++) {
      if (existsSync(join(dir, "src", "bun", "mcp", "standalone.ts"))) return dir;
      if (existsSync(headlessBinaryPath(dir))) return dir;

      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

/**
 * How this app should be launched as an MCP server.
 *
 * Prefers the compiled headless binary when it has been built. That is the
 * whole point of headless mode: an agent gets the same `Workspace` without the
 * window, and the window is where most of the memory goes. It also needs no
 * Bun on PATH, which matters because the agent host — not us — spawns it.
 *
 * Falls back to `bun run` so a checkout that has not built anything still
 * connects.
 */
export function serverSpecFor(projectRoot: string, bundleRoot: string): StdioServer {
  const binary = headlessBinaryPath(projectRoot);
  const env = { OKF_BUNDLE: bundleRoot.replace(/\\/g, "/") };

  if (existsSync(binary)) {
    return { command: binary.replace(/\\/g, "/"), args: [], env };
  }

  return {
    command: "bun",
    args: ["run", join(projectRoot, "src", "bun", "mcp", "standalone.ts").replace(/\\/g, "/")],
    env,
  };
}

/** Render a CLI invocation the way a user would type it. */
export function formatInvocation(invocation: CliInvocation): string {
  const quote = (part: string) => (/\s/.test(part) ? `"${part}"` : part);
  return [invocation.command, ...invocation.args].map(quote).join(" ");
}

/**
 * Run the tool's own connect command.
 *
 * Output is captured rather than inherited: it is a wall of discovered tool
 * descriptions on success, and the one line that matters on failure. Only the
 * failure is shown, and it is shown verbatim — the tool knows why better than
 * a guess here would.
 */
async function runConnectCli(label: string, invocation: CliInvocation): Promise<void> {
  const proc = Bun.spawn([invocation.command, ...invocation.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (invocation.stdin) proc.stdin.write(invocation.stdin);
  await proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  // Exit code alone is not enough: `hermes mcp add` answers the enable prompt
  // with "Cancelled." and still exits 0 when it cannot read a reply.
  const output = `${stdout}\n${stderr}`;
  if (code !== 0 || /Cancelled\.?\s*$/.test(output.trim())) {
    throw new Error(
      messages.connectCliFailed(label, formatInvocation(invocation), output.trim().slice(-400))
    );
  }
}

export interface ConnectResult {
  target: string;
  path: string;
  /** Where the previous version was moved, when there was one. */
  backup?: string;
  /** True when the file did not exist before. */
  created: boolean;
  /** True when the config already said this and nothing was written. */
  unchanged?: boolean;
}

const SERVER_NAME = "okf-wiki";

/**
 * Write the connection into the target's config.
 *
 * Always takes a backup first. These are other tools' files, and a merge that
 * goes wrong should cost the user a rename, not their settings.
 */
export async function connectTarget(options: {
  targetId: string;
  projectRoot: string;
  bundleRoot: string;
  /**
   * The already-resolved target.
   *
   * Saves a lookup for a caller that is walking the catalogue, and lets a test
   * drive this with a target pointing somewhere harmless — without it, testing
   * the bulk path would mean writing into the developer's own
   * `~/.codex/config.toml`.
   */
  target?: ConnectTarget;
}): Promise<ConnectResult> {
  const target = options.target ?? findTarget(options.targetId);
  const path = target.configPath(options.bundleRoot);
  const server = serverSpecFor(options.projectRoot, options.bundleRoot);

  // The tool's own CLI, when it has one. It writes its own file, in its own
  // shape, wherever it actually keeps it — and reports failure honestly.
  if (target.cli) {
    await runConnectCli(target.label, target.cli(server, SERVER_NAME));
    return { target: target.id, path, created: false };
  }

  const existing = await readFile(path, "utf8").catch(() => null);

  const merge = target.format ? MERGERS[target.format] : undefined;
  // Model servers have nothing to configure on their side.
  if (!merge) throw new Error(messages.connectUnknownTarget(options.targetId));
  const next = merge(existing, SERVER_NAME, server);

  // Already says exactly this. Writing would only mint another backup, and
  // Claude Code's config lives *inside* the bundle — so a `-Connect` on every
  // setup run would leave `.mcp.json.okf-backup-<timestamp>` piling up in the
  // user's knowledge folder for a change that was never made.
  if (existing === next) {
    return { target: target.id, path, created: false, unchanged: true };
  }

  let backup: string | undefined;
  if (existing !== null) {
    backup = `${path}.okf-backup-${Date.now()}`;
    await rename(path, backup);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");

  return {
    target: target.id,
    path,
    ...(backup ? { backup } : {}),
    created: existing === null,
  };
}

/**
 * Register this bundle with every agent on the machine, in one action.
 *
 * The point of the button this backs: a knowledge base is only worth having if
 * whatever you happen to be working in can read it, and connecting eight hosts
 * one at a time is how people end up with it wired into two of them.
 *
 * Three rules make the sweep safe to press without reading anything first:
 *
 *   - **Only MCP hosts.** Ollama and friends have nothing on their side to
 *     configure, so they are not in the report at all — listing them as
 *     "skipped" would imply something failed.
 *   - **Only tools that are actually here**, unless asked otherwise. Writing
 *     `~/.cursor/mcp.json` on a machine with no Cursor leaves litter for a
 *     connection nobody can use. `includeMissing` exists because a real
 *     install whose CLI is not on PATH is common enough — Cursor on Windows —
 *     that the sweep must not be the only way in.
 *   - **A host we deliberately do not write is reported, not skipped.**
 *     Claude Code user scope is the one that survives an orchestrator running
 *     agents from a worktree, so silently leaving it out would drop the case
 *     that matters most; its command comes back for the user to run.
 *
 * One failure never stops the rest. These are eight unrelated files, and a
 * Codex config that cannot be read is no reason to leave Cursor unconnected.
 */
export async function connectAllTargets(options: {
  projectRoot: string;
  bundleRoot: string;
  /** Write configs for hosts whose executable was not found on PATH too. */
  includeMissing?: boolean;
  /** The catalogue to sweep. Overridable so tests stay out of the real home. */
  targets?: readonly ConnectTarget[];
  /** How to decide a tool is present. Overridable for the same reason. */
  probeInstalled?: (target: ConnectTarget) => Promise<boolean>;
}): Promise<BulkConnectOutcome[]> {
  const targets = (options.targets ?? CONNECT_TARGETS).filter((t) => t.kind === "mcp-host");
  const probe = options.probeInstalled ?? isInstalled;
  const outcomes: BulkConnectOutcome[] = [];

  // Sequential on purpose: `hermes mcp add` spawns a process that connects to
  // the server and answers prompts on stdin, and two targets sharing a config
  // file would race for the same `.okf-backup-<timestamp>` name.
  for (const target of targets) {
    const path = target.configPath(options.bundleRoot);
    const base = { target: target.id, label: target.label, path };

    if (target.setupCommand) {
      outcomes.push({
        ...base,
        status: "manual",
        command: target.setupCommand(
          options.bundleRoot,
          serverCommandLine(options.projectRoot, options.bundleRoot)
        ),
      });
      continue;
    }

    if (!options.includeMissing && !(await probe(target))) {
      outcomes.push({ ...base, status: "skipped", reason: messages.connectNotInstalled(target.label) });
      continue;
    }

    try {
      const result = await connectTarget({
        targetId: target.id,
        projectRoot: options.projectRoot,
        bundleRoot: options.bundleRoot,
        target,
      });
      outcomes.push({
        ...base,
        status: result.unchanged ? "unchanged" : "connected",
        path: result.path,
        ...(result.backup ? { backup: result.backup } : {}),
      });
    } catch (cause) {
      outcomes.push({
        ...base,
        status: "failed",
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return outcomes;
}

/**
 * The connection entry on its own, in one host's dialect.
 *
 * For a tool this app has no target for — anything local that speaks MCP but
 * is not one of the nine — where the answer is a snippet to paste rather than
 * a file to edit. Built from `serverSpecFor` like everything else, so a
 * pasted config and a written one cannot describe different servers: the
 * hand-written copy in `setup.ps1` had drifted to the `bun run` form and went
 * on recommending it long after the compiled binary became the right answer.
 */
export function renderServerConfig(
  format: ConfigFormat,
  projectRoot: string,
  bundleRoot: string
): string {
  return MERGERS[format](null, SERVER_NAME, serverSpecFor(projectRoot, bundleRoot));
}

/** Preview the exact bytes that `connectTarget` would write. */
export async function previewTarget(options: {
  targetId: string;
  projectRoot: string;
  bundleRoot: string;
}): Promise<{ path: string; content: string }> {
  const target = findTarget(options.targetId);
  const path = target.configPath(options.bundleRoot);
  const server = serverSpecFor(options.projectRoot, options.bundleRoot);

  // Nothing to diff for a CLI target — what gets previewed is the command that
  // will run, which is the honest answer to "what are you about to do".
  if (target.cli) {
    return { path, content: formatInvocation(target.cli(server, SERVER_NAME)) };
  }

  const existing = await readFile(path, "utf8").catch(() => null);
  const merge = target.format ? MERGERS[target.format] : undefined;
  const content = merge ? merge(existing, SERVER_NAME, server) : "";

  return { path, content };
}
