/**
 * RMUX integration.
 *
 * RMUX is a Rust terminal multiplexer built for agents. It speaks tmux's
 * command surface, but the part that matters here is its own extensions —
 * `pane-snapshot`, `collect-pane-output`, `wait-pane` — which return JSON with
 * a schema version instead of a screenful of text an agent has to scrape.
 *
 * What it buys this app is the thing MCP cannot give an agent: **a place for
 * work that outlives a single tool call.** A `retrieve` returns in
 * milliseconds, but reindexing a large bundle, or a local-model agent run, does
 * not — and an MCP call that blocks for minutes is a call that times out. Those
 * belong in a window the agent can start, leave, and come back to.
 *
 * Three findings from running this against rmux 0.9.1 shaped the design, and
 * each is recorded at the function it constrains:
 *
 *   1. `split-window` halves the pane width (measured: 200 → 99 columns), so
 *      output wraps and an agent reads shredded text. Windows stay full width.
 *      This module therefore builds **windows, never splits.**
 *   2. `capture-pane` returns the *visible screen*, already wrapped to the pane
 *      width. `collect-pane-output` returns the byte stream, unwrapped and
 *      including what has scrolled away.
 *   3. `pane_exit.exit_status` is null on Windows, so **a job's exit code is
 *      not observable**; its output is the only signal.
 *
 * Commands are built as data and tested as data, so the argv mapping is
 * verifiable without rmux installed.
 */

/** Default session name. One session holds all of this app's agent work. */
export const RMUX_SESSION = "okf-wiki";

/** Window that holds the interactive shell an agent types into. */
export const MAIN_WINDOW = "main";
/** Window that tails `log.md`. */
export const WATCH_WINDOW = "watch";
/** Window a blocking job runs in, one job at a time. */
export const JOB_WINDOW = "job";

/**
 * Size for a detached session.
 *
 * A detached session defaults to 80×24, which is where the wrapping problem
 * starts: `okf retrieve` output and JSON both exceed 80 columns constantly. No
 * terminal has to display this, so the only cost of a wide session is buffer.
 */
export const AGENT_COLS = 200;
export const AGENT_ROWS = 50;

/** Default ceiling for a collected job's output. */
export const MAX_COLLECT_BYTES = 1_000_000;

export interface RmuxCommand {
  /** Argument vector, ready to spawn. */
  argv: string[];
  /** What this step is for, shown when the plan is printed. */
  purpose: string;
}

/**
 * Which shell a pane runs, because quoting is not portable between them.
 *
 * This is not a hypothetical distinction. rmux starts a pane with the platform
 * default — `cmd.exe` on Windows — so POSIX quoting sent there arrives
 * literally: the pane tries to run a program named `'bun` and reports that it
 * does not exist. Quoting has to match the shell that will actually read it.
 */
export type PaneShell = "posix" | "cmd";

/** The shell rmux will start in a new pane on this platform. */
export function defaultPaneShell(platform: string = process.platform): PaneShell {
  return platform === "win32" ? "cmd" : "posix";
}

/**
 * Quote a path for use *inside* a command the pane will run.
 *
 * This is not for the command as a whole — `sendKeys` passes that verbatim.
 * It is for the paths interpolated into it, which reach the pane's shell and
 * are subject to its rules: an unquoted `C:\OKF Wiki` splits at the space and
 * the pane runs something else. POSIX shells take single quotes with the
 * `'\''` escape; `cmd.exe` has no single-quote syntax at all and uses double
 * quotes, doubling an embedded one. A Windows path cannot contain `"`, so the
 * escape there is a formality rather than a real case.
 */
export function quoteForPane(command: string, shell: PaneShell = defaultPaneShell()): string {
  if (shell === "cmd") return `"${command.replace(/"/g, `""`)}"`;
  return `'${command.replace(/'/g, `'\\''`)}'`;
}

/**
 * Set an environment variable for the rest of the pane's session.
 *
 * `export` is POSIX-only; `cmd.exe` uses `set`, and the quotes go around the
 * whole assignment rather than the value so a path with spaces survives.
 */
export function exportEnv(
  name: string,
  value: string,
  shell: PaneShell = defaultPaneShell()
): string {
  if (shell === "cmd") return `set ${quoteForPane(`${name}=${value}`, shell)}`;
  return `export ${name}=${quoteForPane(value, shell)}`;
}

/**
 * The command a pane should use to invoke this same CLI.
 *
 * Two cases, and the difference is not cosmetic. Run from source, the entry
 * point is a real `.ts` file that needs `bun run`. Compiled with
 * `bun build --compile`, `process.argv[1]` is a *virtual* path inside the
 * executable (`B:/~BUN/root/okf`) — handing that to `bun run` in a pane fails
 * with "Module not found", because the module exists only inside the binary.
 * There the executable itself is the command.
 *
 * The two are told apart by `process.execPath`, which is `bun` when Bun runs
 * our source and the compiled binary otherwise. Note that testing the entry
 * point with `existsSync` does *not* work: Bun's virtual filesystem answers
 * true for the embedded path, so that check silently picks the broken branch.
 */
export function okfPaneCommand(options: {
  entry: string | undefined;
  execPath: string;
  shell?: PaneShell;
}): string {
  const shell = options.shell ?? defaultPaneShell();
  const runtime = options.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";

  // Anything other than Bun itself means we are the compiled executable.
  if (!/^bun(\.exe)?$/.test(runtime)) return quoteForPane(options.execPath, shell);

  return options.entry ? `bun run ${quoteForPane(options.entry, shell)}` : "okf";
}

/**
 * Whether rmux failed because its own install is incomplete.
 *
 * Not hypothetical: the Windows prebuilt of 0.9.1 ships `rmux.exe` without the
 * private helper it needs, so `rmux -V` reports a version while every command
 * that spawns the server fails. "Not installed" and "installed but broken" are
 * fixed differently, so they are told apart rather than both reading as
 * "rmux is unhappy".
 */
export function isBrokenInstall(output: string): boolean {
  return /libexec|helper not found/i.test(output);
}

/** Address a window explicitly, e.g. `okf-wiki:job`. */
export function windowTarget(session: string, window: string): string {
  return `${session}:${window}`;
}

// ---------------------------------------------------------------------------
// Sessions and windows
// ---------------------------------------------------------------------------

/**
 * Start a detached session sized for an agent rather than for a screen.
 *
 * `-d` so the session outlives the process that created it: an agent that
 * attached would block until a human detached it.
 */
export function newSession(
  session = RMUX_SESSION,
  cols = AGENT_COLS,
  rows = AGENT_ROWS
): RmuxCommand {
  return {
    argv: ["new-session", "-d", "-s", session, "-x", String(cols), "-y", String(rows)],
    purpose: `セッション ${session} を作成（デタッチ、${cols}×${rows}）`,
  };
}

/** Ask whether a session exists, so setup can be repeated safely. */
export function hasSession(session = RMUX_SESSION): RmuxCommand {
  return { argv: ["has-session", "-t", session], purpose: `${session} の有無を確認` };
}

/**
 * Add a window — deliberately not a split.
 *
 * Measured on rmux 0.9.1: `split-window -h` took a 200-column pane to 99, so
 * every line of output past 99 characters wrapped. A window is full width, and
 * nothing here is meant to be looked at side by side anyway.
 */
export function newWindow(session: string, name: string, command?: string): RmuxCommand {
  const argv = ["new-window", "-t", session, "-n", name];
  if (command) argv.push(command);
  return { argv, purpose: `ウィンドウ ${name} を作成${command ? `: ${command}` : ""}` };
}

export function killWindow(target: string): RmuxCommand {
  return { argv: ["kill-window", "-t", target], purpose: `ウィンドウ ${target} を終了` };
}

export function killSession(session = RMUX_SESSION): RmuxCommand {
  return { argv: ["kill-session", "-t", session], purpose: `セッション ${session} を終了` };
}

export function listSessions(): RmuxCommand {
  return { argv: ["list-sessions"], purpose: "セッション一覧" };
}

export function listWindows(session = RMUX_SESSION): RmuxCommand {
  return { argv: ["list-windows", "-t", session], purpose: `${session} のウィンドウ一覧` };
}

/**
 * Type a command into a pane and press Enter.
 *
 * The trailing literal `Enter` is rmux's key name, not part of the command —
 * without it the text sits on the prompt unexecuted, which looks like a hang.
 */
export function sendKeys(target: string, command: string): RmuxCommand {
  return {
    // The command is one argv element and rmux types it verbatim, so it must
    // NOT be quoted here: we spawn rmux directly, with no shell in between to
    // strip the quotes again. Quoting here put a literal `'bun run '\''…` on
    // the pane's prompt, and the pane reported no such program.
    argv: ["send-keys", "-t", target, command, "Enter"],
    purpose: `${target} で実行: ${command}`,
  };
}

// ---------------------------------------------------------------------------
// Reading a pane
// ---------------------------------------------------------------------------

/**
 * Read a pane as structured JSON.
 *
 * Preferred over `capture-pane -p`, which prints the visible screen already
 * wrapped to the pane width and leaves the agent to guess where lines really
 * ended. The snapshot carries `lines`, a single `text`, the cursor and the
 * region, under a `schema_version`.
 */
export function paneSnapshot(target: string): RmuxCommand {
  return { argv: ["pane-snapshot", "-t", target, "--json"], purpose: `${target} の内容を取得` };
}

/**
 * Block until the pane's command exits, then return everything it wrote.
 *
 * This is the primitive a blocking job is built on. Unlike a snapshot it is
 * the byte stream rather than the screen, so nothing is lost to scrollback or
 * wrapping — and it ends exactly when the command does, with no polling and no
 * sentinel to inject into the user's command line.
 */
export function collectPaneOutput(target: string, maxBytes = MAX_COLLECT_BYTES): RmuxCommand {
  return {
    argv: [
      "collect-pane-output",
      "-t",
      target,
      "--until-pane-exit",
      "--max-bytes",
      String(maxBytes),
      "--json",
    ],
    purpose: `${target} の終了を待って出力を収集`,
  };
}

export interface WaitOptions {
  /** Text that must appear *after* the call — not already on screen. */
  nextText?: string;
  /** Wait for output to stop changing. */
  quiet?: boolean;
  /** How long counts as quiet, e.g. "2s". */
  stableFor?: string;
  /** Wait for the pane's command to exit. */
  paneExit?: boolean;
  /** Give up after this, e.g. "120s". */
  timeout?: string;
}

/**
 * Wait for a pane to reach a state.
 *
 * Note `--text` matches content that is *already* there, including the command
 * line the shell just echoed — asking for a marker that way returns in about a
 * millisecond and reports success before the command has run. `--next-text`
 * takes a baseline first, which is what makes it usable as a completion check.
 */
export function waitPane(target: string, options: WaitOptions = {}): RmuxCommand {
  const argv = ["wait-pane", "-t", target];
  if (options.nextText) argv.push("--next-text", options.nextText);
  if (options.quiet) argv.push("--quiet");
  if (options.stableFor) argv.push("--stable-for", options.stableFor);
  if (options.paneExit) argv.push("--pane-exit");
  if (options.timeout) argv.push("--timeout", options.timeout);
  argv.push("--json");
  return { argv, purpose: `${target} の状態を待つ` };
}

export function capabilities(): RmuxCommand {
  return { argv: ["capabilities", "--json"], purpose: "rmux の対応機能" };
}

export function diagnose(): RmuxCommand {
  return { argv: ["diagnose", "--json"], purpose: "rmux の状態を診断" };
}

// ---------------------------------------------------------------------------
// Reading what rmux returned
// ---------------------------------------------------------------------------

/**
 * Remove terminal control sequences from collected output.
 *
 * `collect-pane-output` returns the raw byte stream, so it carries the escape
 * codes the program emitted — cursor moves, screen clears, the window-title
 * sequence `cmd.exe` writes on startup. Left in, they corrupt an agent's view
 * of the output and can retarget a terminal the text is later printed to.
 */
export function stripAnsi(text: string): string {
  return (
    text
      // OSC (e.g. window title): ESC ] … BEL or ESC \
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
      // CSI and other escape sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B[[\]()#;?]*[0-9;]*[A-Za-z]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
  );
}

export interface CollectedOutput {
  ok: boolean;
  text: string;
  bytes: number;
  truncated: boolean;
  /**
   * Null whenever rmux could not observe the exit — which on Windows is
   * always, since `pane_exit.stale` is set and no status is reported. Callers
   * must not treat null as success.
   */
  exitStatus: number | null;
}

/** Read a `collect-pane-output --json` reply. */
export function parseCollected(raw: string): CollectedOutput | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const paneExit = data.pane_exit as { exit_status?: number | null } | null | undefined;
  const status = paneExit?.exit_status;

  return {
    ok: data.ok === true,
    text: stripAnsi(typeof data.output_utf8_lossy === "string" ? data.output_utf8_lossy : ""),
    bytes: typeof data.bytes === "number" ? data.bytes : 0,
    truncated: data.truncated === true,
    exitStatus: typeof status === "number" ? status : null,
  };
}

export interface PaneView {
  ok: boolean;
  text: string;
  cols: number;
  rows: number;
}

/** Read a `pane-snapshot --json` reply. */
export function parseSnapshot(raw: string): PaneView | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const lines = Array.isArray(data.lines) ? (data.lines as string[]) : [];
  const text = typeof data.text === "string" ? data.text : lines.join("\n");

  return {
    ok: data.ok === true,
    // Trailing blank lines are the unused part of the screen, never content.
    text: text.replace(/\n+$/, ""),
    cols: typeof data.cols === "number" ? data.cols : 0,
    rows: typeof data.rows === "number" ? data.rows : 0,
  };
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

export interface WorkspacePlan {
  session: string;
  commands: RmuxCommand[];
}

/**
 * The session an agent gets to work in.
 *
 * Two windows, not the three-way split this used to build. The split was the
 * cause of the unreadable output rather than a convenience: it left each pane
 * under 100 columns, so every JSON reply and most retrieval output wrapped.
 * Windows are full width and cost nothing when nobody is watching.
 *
 *   main   — a shell with OKF_BUNDLE already set
 *   watch  — `okf watch`, a live tail of every write from either side
 *
 * Jobs get their own window on demand; see `jobPlan`.
 */
export function agentWorkspacePlan(options: {
  bundle: string;
  session?: string;
  /** Path to the `okf` entry point, so windows call the same build. */
  okf: string;
  /** Defaults to this platform's pane shell; overridden in tests. */
  shell?: PaneShell;
}): WorkspacePlan {
  const session = options.session ?? RMUX_SESSION;
  const shell = options.shell ?? defaultPaneShell();
  const bundle = quoteForPane(options.bundle, shell);

  return {
    session,
    commands: [
      newSession(session),
      // The first window already exists; name it rather than adding one.
      { argv: ["rename-window", "-t", session, MAIN_WINDOW], purpose: `最初のウィンドウを命名` },
      sendKeys(windowTarget(session, MAIN_WINDOW), exportEnv("OKF_BUNDLE", options.bundle, shell)),
      // A tail of log.md is the cheapest possible "what just happened": every
      // write from either side lands there, so the window shows human and
      // agent edits in one stream.
      newWindow(session, WATCH_WINDOW, `${options.okf} watch --bundle ${bundle}`),
      // Leave the agent looking at the shell, not at the log tail.
      { argv: ["select-window", "-t", windowTarget(session, MAIN_WINDOW)], purpose: `main を選択` },
    ],
  };
}

/**
 * Run one command to completion in its own window.
 *
 * A fresh window per job keeps a long job's output away from the shell an
 * agent is typing into, and gives `collect-pane-output` a pane whose exit
 * means "this job finished" rather than "someone closed the shell".
 */
export function jobPlan(options: {
  session?: string;
  window?: string;
  command: string;
  maxBytes?: number;
}): { target: string; start: RmuxCommand; collect: RmuxCommand; cleanup: RmuxCommand } {
  const session = options.session ?? RMUX_SESSION;
  const window = options.window ?? JOB_WINDOW;
  const target = windowTarget(session, window);

  return {
    target,
    start: newWindow(session, window, options.command),
    collect: collectPaneOutput(target, options.maxBytes),
    // The window is gone once its command exits, but a job killed part way
    // through would otherwise hold the name and collide with the next one.
    cleanup: killWindow(target),
  };
}

/** Render a plan as the commands a person could paste, for the dry run. */
export function renderPlan(plan: WorkspacePlan): string {
  return plan.commands
    .map((command) => `  rmux ${command.argv.join(" ")}\n      # ${command.purpose}`)
    .join("\n");
}
