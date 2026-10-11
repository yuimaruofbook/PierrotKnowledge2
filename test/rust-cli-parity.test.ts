/**
 * The Rust `okf` CLI answers exactly as the TypeScript one does.
 *
 * The same script of command lines is run through both — `bun run
 * src/bun/cli/main.ts …` and the release binary — each against its own copy of
 * the same scaffolded bundle, with HOME / APPDATA / XDG pointed at its own
 * empty sandbox so neither can see (or touch) the real user's settings,
 * session or tool configs. Stdout, stderr and the exit code must match
 * byte for byte once the parts that differ by nature are masked (see
 * `normalize`): where the bundle and the sandbox are, the clock, and the
 * command a tmux pane uses to call this very program.
 *
 * Nothing here ever applies anything: `update` stops at the safety check (no
 * network), `uninstall` only prints its plan, and rmux is limited to the
 * read-only subcommands. `ui` is exercised only on its no-bundle usage error:
 * with a bundle it would start a server.
 *
 * Skipped when the Rust binary has not been built (`cargo build --release
 * --manifest-path rust/Cargo.toml`), or point `OKF_RUST_CLI` at one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { TOOLS } from "../src/bun/mcp/tools";
import { removeTempDir } from "./helpers";

const RUST_CLI =
  process.env.OKF_RUST_CLI ??
  resolve("rust", "target", "release", process.platform === "win32" ? "okf.exe" : "okf");
const TS_CLI = resolve("src", "bun", "cli", "main.ts");
const ROOT = resolve(".");

/** One command line. `<BUNDLE>` and `<HOME>` stand for each side's own paths. */
interface Step {
  args: string[];
  env?: Record<string, string>;
}

const step = (...args: string[]): Step => ({ args });
/** A command that targets the bundle. */
const onBundle = (...args: string[]): Step => ({ args: [...args, "--bundle", "<BUNDLE>"] });

const NOTE =
  "---\ntype: Entity\ntitle: Gamma\ntags: [parity]\n---\n\n# Gamma\n\n[[alpha]] と [[nowhere]]。日本語の検索。\n";

/** Help, usage errors and aliases: nothing here opens a bundle. */
const HELP_STEPS: Step[] = [
  step(),
  step("--help"),
  step("help"),
  step("HELP"),
  step("help", "search"),
  step("search", "--help"),
  step("--help", "search"),
  step("help", "no-such-tool"),
  step("frobnicate"),
  step("Frobnicate", "--json"),
  // Every tool has a help page, and so does every alias; a tool added to the
  // MCP table is covered the day it is added.
  ...TOOLS.map((tool) => step(tool.name.replace(/_/g, "-"), "--help")),
  ...["find", "ask", "ls", "lint", "gaps", "agents", "map", "who", "tasks", "todo", "today", "para", "archive"].map(
    (alias) => step(alias, "--help")
  ),
  // No bundle anywhere (the sandbox has no saved session and no OKF_BUNDLE).
  step("info"),
  step("search", "x"),
  step("mcp-config"),
  step("rmux", "plan"),
  step("rmux", "setup"),
  step("ui"),
  step("ui", "--port", "0"),
  step("serve", "--help"),
];

const READ_STEPS: Step[] = [
  onBundle("info"),
  onBundle("info", "--json"),
  onBundle("info", "--json", "true"),
  onBundle("search", "知識"),
  onBundle("search", "alpha", "--limit", "3"),
  onBundle("search", "alpha", "--limit=1", "--json"),
  onBundle("search", "--query", "alpha", "--type", "Concept", "--path_prefix", "wiki/"),
  onBundle("search", "zzzzqqq"),
  onBundle("ask", "日本語の検索"),
  onBundle("retrieve", "alpha", "--limit", "2", "--budget_chars", "200", "--expand_neighbours"),
  onBundle("retrieve", "alpha", "--expand_neighbours", "false", "--tags", "parity"),
  onBundle("retrieve", "alpha", "--limit", "many"),
  onBundle("context-pack", "Alpha について調べる"),
  onBundle("context-pack", "x", "--tier", "bogus"),
  onBundle("context-pack", "--task", "Alpha を調べる", "--tier", "supervisor", "--budget_chars", "500"),
  onBundle("ls"),
  onBundle("ls", "wiki", "--recursive"),
  onBundle("ls", "--path", "wiki", "--recursive", "true"),
  onBundle("ls", "../"),
  onBundle("list-files", "--path", "nope"),
  onBundle("list-concepts"),
  onBundle("list-tags", "--json"),
  onBundle("backlinks", "alpha"),
  onBundle("backlinks"),
  onBundle("read-file", "wiki/alpha.md"),
  onBundle("read-file", "wiki/missing.md"),
  onBundle("read-file", "wiki/missing.md", "--json"),
  onBundle("read-file", "../outside.md"),
  onBundle("lint"),
  onBundle("lint", "--json"),
  onBundle("check-conformance"),
  onBundle("gaps"),
  onBundle("map"),
  onBundle("who"),
  onBundle("agents"),
  onBundle("read-agents-md", "--json"),
  onBundle("tasks"),
  onBundle("tasks", "--status", "bogus"),
  onBundle("para"),
  onBundle("para", "--para", "bogus"),
  onBundle("find", "週次の点検をしたい"),
  onBundle("skill-find", "--task", "zzzz"),
  onBundle("skill-list"),
  onBundle("skill-open", "nope"),
  onBundle("skill-open", "okf-ingest"),
  onBundle("skill-read", "okf-ingest", "reference.md"),
  onBundle("skill-read", "okf-ingest", "../../AGENTS.md"),
  onBundle("loop-list"),
  onBundle("audit-changes"),
  onBundle("audit-changes", "--since", "bad"),
  onBundle("bundle-info"),
  // Usage errors: missing arguments name the flags and print the tool's help.
  onBundle("search"),
  onBundle("read-file"),
  onBundle("move-file", "wiki/a.md"),
  onBundle("create-concept"),
  onBundle("write-file", "--path", "wiki/x.md"),
  onBundle("skill-read", "okf-ingest"),
  onBundle("no-such-command"),
  { args: ["info", "--bundle", "<BUNDLE>/no-such-bundle"] },
  { args: ["search", "alpha", "--json", "--quiet", "--version", "--bundle", "<BUNDLE>", "--bogus", "flag"] },
  { args: ["search", "--bundle", "<BUNDLE>", "--", "--alpha"] },
  // The bundle can also come from the environment.
  { args: ["info"], env: { OKF_BUNDLE: "<BUNDLE>" } },
  { args: ["Info", "--bundle", "", "--json"], env: { OKF_BUNDLE: "<BUNDLE>" } },
];

/** Writes, with the reads that see them. Both bundles take the same changes. */
const WRITE_STEPS: Step[] = [
  onBundle("write-file", "wiki/gamma.md", "--content", NOTE),
  onBundle("write-file", "wiki/gamma.md", "--content", NOTE, "--note", "again", "--actor", "process:parity"),
  onBundle("write-file", "raw/forbidden.md", "--content", "x"),
  onBundle("write-file", "wiki/nofm.md", "--content", "no frontmatter"),
  onBundle("write-file", "--path", "wiki/dash.md", "--content", "---\ntype: Concept\ntitle: Dash\n---\n\n# Dash\n"),
  onBundle(
    "create-concept",
    "wiki/beta.md",
    "--type",
    "Concept",
    "--title",
    "Beta",
    "--description",
    "二つ目の概念",
    "--tags",
    '["parity","テスト"]',
    "--body",
    "[[alpha]] を参照する。",
    "--actor",
    "process:parity"
  ),
  onBundle("create-concept", "wiki/beta.md", "--type", "Concept"),
  onBundle("create-concept", "x.txt", "--type", "Concept"),
  onBundle("read-file", "wiki/beta.md"),
  onBundle("backlinks", "beta"),
  onBundle("gaps"),
  onBundle("lint", "--json"),
  onBundle("archive", "wiki/beta.md", "--para", "archive"),
  onBundle("archive", "wiki/beta.md", "--para", "bogus"),
  onBundle("para"),
  onBundle("para", "--para", "archive", "--json"),
  onBundle("move-file", "wiki/gamma.md", "wiki/topic/gamma.md"),
  onBundle("move-file", "wiki/nope.md", "wiki/b.md"),
  onBundle("delete-file", "wiki/topic/gamma.md"),
  onBundle("delete-file", "wiki/index.md"),
  onBundle("delete-file", "wiki/nope.md"),
  onBundle("todo", "パリティを確かめる", "--status", "doing", "--para", "project", "--due", "2026-12-31", "--note", "一行"),
  onBundle("add-task", "second"),
  onBundle("add-task", ""),
  onBundle("update-task", "T-0001", "--status", "done"),
  onBundle("update-task", "T-9999", "--status", "done"),
  onBundle("tasks"),
  onBundle("tasks", "--status", "done", "--json"),
  onBundle("today", "--date", "2026-08-04"),
  onBundle("today", "--date", "yesterday"),
  onBundle("collect-daily-tasks", "--date", "2026-08-04"),
  onBundle("loop-start", "--goal", "Keep the wiki tidy every week", "--actor", "process:parity"),
  onBundle("loop-note", "--detail", "looked at alpha"),
  onBundle("loop-end", "--outcome", "done for now"),
  onBundle("loop-list"),
  onBundle("loop-read", "keep-the-wiki-tidy-every-week"),
  onBundle("loop-read", "nope"),
  onBundle("audit-changes"),
  onBundle("audit-changes", "--actor", "process:parity", "--json"),
  onBundle("read-file", "wiki/log.md"),
  onBundle("rebuild-index"),
  onBundle("rebuild-rag", "--json"),
  onBundle("search", "Beta", "--tags", "parity"),
  onBundle("search", "日本語"),
  onBundle("info"),
];

const NOTE_HEAD = "---\ntype: Concept\ntitle: Head\ndescription: the entry point\n---\n\n# Head\n\nzebu pasture rotation plan. See [[mid]] and [[retired]].\n";
const NOTE_MID = "---\ntype: Concept\ntitle: Mid\ndescription: the middle step\n---\n\n# Mid\n\nSecret body text. Next is [[tail]].\n";
const NOTE_TAIL = "---\ntype: Concept\ntitle: Tail\ndescription: the far end\n---\n\n# Tail\n\nthe end\n";
const NOTE_RETIRED = "---\ntype: Concept\ntitle: Retired\ntags: [kiwi, DEAD]\n---\n\n# Retired\n\nkiwi orchard survey notes\n";
const NOTE_LIVE = "---\ntype: Concept\ntitle: Live\ntags: [kiwi]\n---\n\n# Live\n\nkiwi orchard survey notes\n";

/** Lifecycle, context range, activity summaries and know-how, as the CLI exposes them. */
const FEATURE_STEPS: Step[] = [
  onBundle("write-file", "wiki/head.md", "--content", NOTE_HEAD),
  onBundle("write-file", "wiki/mid.md", "--content", NOTE_MID),
  onBundle("write-file", "wiki/tail.md", "--content", NOTE_TAIL),
  onBundle("write-file", "wiki/retired.md", "--content", NOTE_RETIRED),
  onBundle("write-file", "wiki/live.md", "--content", NOTE_LIVE),
  onBundle("search", "kiwi"),
  onBundle("search", "kiwi", "--include_dead"),
  onBundle("search", "kiwi", "--include_dead", "false"),
  onBundle("search", "kiwi", "--tags", '["DEAD"]', "--include_dead", "true", "--json"),
  onBundle("set-lifecycle", "wiki/live.md", "dead", "--actor", "process:parity"),
  onBundle("set-lifecycle", "wiki/live.md", "dead"),
  onBundle("set-lifecycle", "wiki/live.md", "product"),
  onBundle("set-lifecycle", "--path", "wiki/live.md", "--lifecycle", "none"),
  onBundle("set-lifecycle", "wiki/live.md", "alive"),
  onBundle("set-lifecycle", "wiki/live.md"),
  onBundle("set-lifecycle"),
  onBundle("set-lifecycle", "--help"),
  onBundle("list-concepts"),
  onBundle("retrieve", "zebu pasture rotation plan", "--link_depth", "2"),
  onBundle("retrieve", "zebu pasture rotation plan", "--para_depth", "1", "--link_depth", "1"),
  onBundle("retrieve", "zebu pasture rotation plan", "--para_depth", "9"),
  onBundle("retrieve", "zebu pasture rotation plan", "--link_depth", "many"),
  onBundle("context-pack", "zebu pasture rotation plan", "--link_depth", "1", "--tier", "worker"),
  onBundle("context-pack", "zebu pasture rotation plan", "--link_depth", "3"),
  onBundle("context-pack", "kiwi orchard survey notes", "--include_dead"),
  onBundle("context-pack", "kiwi orchard survey notes", "--para_depth", "2", "--json"),
  onBundle("knowhow-add", "Quote Windows paths", "Quote any path with spaces before passing it to a shell command.", "process:claude-code", "--tags", '["windows","shell"]'),
  onBundle("knowhow-add", "--title", "Quote Windows paths", "--body", "second one", "--actor", "process:codex"),
  onBundle("knowhow-add", "only a title"),
  onBundle("knowhow-add", "t", "b"),
  onBundle("knowhow-add"),
  onBundle("knowhow-find", "quote windows path spaces shell"),
  onBundle("knowhow-find", "--task", "quote windows path spaces shell", "--limit", "1", "--json"),
  onBundle("knowhow-find", "zzzzqqq"),
  onBundle("knowhow-find"),
  onBundle("read-file", "wiki/knowhow/quote-windows-paths.md"),
  onBundle("context-pack", "quote windows path spaces shell command"),
  onBundle("summarize-activity"),
  onBundle("summarize-activity", "--json"),
  onBundle("summarize-activity", "--actor", "process:claude-code"),
  onBundle("summarize-activity", "--since", "bad"),
  onBundle("summarize-activity", "--since", "2999-01-01"),
  onBundle("summarize-activity", "--since", "2030-01-02", "--until", "2030-01-01"),
  onBundle("summarize-activity", "--save", "--actor", "process:parity"),
  onBundle("summarize-activity", "--save", "--since", "2020-01-01", "--until", "2999-12-31"),
  onBundle("read-file", "wiki/activity/2020-01-01_2999-12-31.md"),
  onBundle("list-files", "wiki/activity"),
  onBundle("audit-changes", "--actor", "process:parity"),
  onBundle("--help"),
];

const NOTE_ITEM_A = "---\ntype: Concept\ntitle: Apple\nprice: 1.5\ntags: [Product]\n---\n\n# Apple\n";
const NOTE_ITEM_B = "---\ntype: Concept\ntitle: Banana\nprice: 12\ntags: [DEAD]\n---\n\n# Banana\n";
const BASE_TEXT =
  'filters: file.hasTag("Product") || file.hasTag("DEAD")\nformulas:\n  big: price > 5\nviews:\n  - type: table\n    name: Items\n    order: [title, price, formula.big]\n    sort: [{property: price, direction: DESC}]\n    summaries: {price: Sum}\n  - type: cards\n    name: Cards\n    groupBy: formula.big\n';

/** Bases, as the CLI exposes them. */
const BASE_STEPS: Step[] = [
  onBundle("write-file", "wiki/items/a.md", "--content", NOTE_ITEM_A),
  onBundle("write-file", "wiki/items/b.md", "--content", NOTE_ITEM_B),
  onBundle("base-list"),
  onBundle("base-list", "--json"),
  onBundle("base-write", "wiki/bases/items.base", "--content", BASE_TEXT, "--actor", "process:parity"),
  onBundle("base-write", "--path", "wiki/bases/bad.base", "--content", "filters: 'a ='"),
  onBundle("base-write", "wiki/bases/bad.base"),
  onBundle("base-write"),
  onBundle("base-list"),
  onBundle("base-query", "wiki/bases/items.base"),
  onBundle("base-query", "--path", "wiki/bases/items.base", "--view", "Cards", "--json"),
  onBundle("base-query", "wiki/bases/items.base", "--view", "Items", "--limit", "1"),
  onBundle("base-query", "wiki/bases/items.base", "--limit", "0"),
  onBundle("base-query", "wiki/bases/items.base", "--view", "Nope"),
  onBundle("base-query", "wiki/bases/missing.base"),
  onBundle("base-query", "wiki/alpha.md"),
  onBundle("base-query"),
  onBundle("base-query", "--help"),
  onBundle("base-write", "--help"),
  onBundle("base-list", "--help"),
  onBundle("read-file", "wiki/bases/items.base"),
  onBundle("--help"),
];

const CONFIG_STEPS: Step[] = [
  ...["json", "toml", "opencode", "yaml", "command"].map((format) => onBundle("mcp-config", "--format", format)),
  onBundle("mcp-config"),
  onBundle("mcp-config", "--format"),
  onBundle("mcp-config", "--format", "xml"),
  { args: ["mcp-config", "--format", "command"], env: { OKF_BUNDLE: "<BUNDLE>" } },
  onBundle("mcp-config", "--json"),
];

/** Read-only or dry-run only: nothing here starts, kills or writes a session. */
const RMUX_STEPS: Step[] = [
  onBundle("rmux", "plan"),
  onBundle("rmux", "plan", "--session", "parity-session"),
  onBundle("rmux", "plan", "--session"),
  { args: ["rmux", "plan"], env: { OKF_BUNDLE: "<BUNDLE>" } },
  onBundle("rmux", "bogus"),
  onBundle("rmux", "run"),
  onBundle("rmux", "send"),
  step("rmux", "status"),
  step("rmux", "doctor"),
  step("rmux", "windows", "--session", "parity-session-not-there"),
];

/** Offline only: the install is real, but nothing is downloaded or applied. */
const INSTALL_STEPS: Step[] = [
  // A bundle inside the install folder makes the update refuse before any
  // network is touched.
  { args: ["update"], env: { OKF_BUNDLE: `${ROOT}/inside-the-install` } },
  { args: ["Update", "--apply"], env: { OKF_BUNDLE: `${ROOT}/inside-the-install` } },
  { args: ["uninstall"], env: { OKF_BUNDLE: "<BUNDLE>" } },
  { args: ["Uninstall", "--purge-settings"], env: { OKF_BUNDLE: "<BUNDLE>" } },
  { args: ["uninstall"], env: { OKF_BUNDLE: `${ROOT}/inside-the-install` } },
  { args: ["uninstall"] },
];

interface Side {
  name: "ts" | "rust";
  command: string[];
  bundle: string;
  home: string;
}

interface Outcome {
  stdout: string;
  stderr: string;
  code: number;
}

function expand(text: string, side: Side): string {
  return text.split("<BUNDLE>").join(side.bundle).split("<HOME>").join(side.home);
}

function envFor(side: Side, extra: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Nothing of the real user's configuration leaks in.
    if (value !== undefined && !/^(OKF_|XDG_|APPDATA$|LOCALAPPDATA$|HOME$|USERPROFILE$|HOMEDRIVE$|HOMEPATH$)/i.test(key)) {
      base[key] = value;
    }
  }
  const home = side.home;
  return {
    ...base,
    // Bun may live under the real home; keep it findable.
    PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    ...Object.fromEntries(Object.entries(extra ?? {}).map(([k, v]) => [k, expand(v, side)])),
  };
}

async function runSide(side: Side, one: Step, stdin = ""): Promise<Outcome> {
  const proc = Bun.spawn([...side.command, ...one.args.map((arg) => expand(arg, side))], {
    cwd: ROOT,
    env: envFor(side, one.env),
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 90_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, code };
}

/**
 * Mask what differs between two honest runs.
 *
 *  - the bundle and the sandbox home: each side has its own temp folder;
 *  - clocks (`HH:MM:SS`, ISO timestamps): the two runs are a moment apart;
 *  - the command a pane uses to call this program: `bun run "<main.ts>"` for
 *    the TypeScript CLI, the quoted path of the executable for the Rust one.
 */
function normalize(text: string, side: Side): string {
  const paneCommand =
    side.name === "ts"
      ? [`bun run "${TS_CLI}"`, `bun run '${TS_CLI}'`]
      : [`"${RUST_CLI}"`, `'${RUST_CLI}'`];
  let result = text;
  for (const command of paneCommand) result = result.split(command).join("<OKF>");
  for (const [path, token] of [
    [side.bundle, "<BUNDLE>"],
    [side.home, "<HOME>"],
  ] as const) {
    for (const form of [JSON.stringify(path).slice(1, -1), path.replace(/\\/g, "/"), path]) {
      result = result.split(form).join(token);
    }
  }
  return result
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TIME>")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<CLOCK>");
}

async function makeSide(name: Side["name"], command: string[], sandbox: string): Promise<Side> {
  const bundle = join(sandbox, `${name}-bundle`);
  const home = join(sandbox, `${name}-home`);
  await mkdir(bundle, { recursive: true });
  await mkdir(home, { recursive: true });
  await scaffoldBundle(bundle);
  await writeFile(
    join(bundle, "wiki", "alpha.md"),
    "---\ntype: Concept\ntitle: Alpha\ndescription: 最初の概念\ntags: [parity]\n---\n\n# Alpha\n\n日本語の検索ができる知識。\n\n## 詳細\n\nalpha の詳しい説明。\n",
    "utf8"
  );
  return { name, command, bundle, home };
}

const ready = existsSync(RUST_CLI);
if (!ready) console.log(`  (Rust CLI not built at ${RUST_CLI} — CLI parity test skipped)`);

describe.skipIf(!ready)("Rust okf CLI parity", () => {
  let sandbox: string;
  let ts: Side;
  let rust: Side;

  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "okf-cli-parity-"));
    ts = await makeSide("ts", [process.execPath, "run", TS_CLI], sandbox);
    rust = await makeSide("rust", [RUST_CLI], sandbox);
  });

  afterAll(async () => {
    await removeTempDir(sandbox);
  });

  /** Run a script through both sides (concurrently: they share nothing) and compare. */
  async function compare(script: Step[]): Promise<number> {
    for (const one of script) {
      const [expected, actual] = await Promise.all([runSide(ts, one), runSide(rust, one)]);
      const label = `okf ${one.args.join(" ")}${one.env ? `  env=${JSON.stringify(one.env)}` : ""}`;
      for (const channel of ["stdout", "stderr"] as const) {
        expect(`${label} [${channel}]\n${normalize(actual[channel], rust)}`).toBe(
          `${label} [${channel}]\n${normalize(expected[channel], ts)}`
        );
      }
      expect(`${label} [exit]\n${actual.code}`).toBe(`${label} [exit]\n${expected.code}`);
    }
    return script.length;
  }

  test("help, per-tool help, aliases and usage errors", async () => {
    expect(await compare(HELP_STEPS)).toBeGreaterThan(60);
  }, 300_000);

  test("read commands, flag coercion and argument errors", async () => {
    expect(await compare(READ_STEPS)).toBeGreaterThan(60);
  }, 300_000);

  test("write commands leave both bundles the same", async () => {
    expect(await compare(WRITE_STEPS)).toBeGreaterThan(40);
  }, 300_000);

  test("lifecycle, context range, know-how and activity commands", async () => {
    expect(await compare(FEATURE_STEPS)).toBeGreaterThan(40);
  }, 300_000);

  test("base commands", async () => {
    expect(await compare(BASE_STEPS)).toBeGreaterThan(15);
  }, 300_000);

  test("mcp-config in every format", async () => {
    expect(await compare(CONFIG_STEPS)).toBeGreaterThan(5);
  }, 120_000);

  test("rmux plan and the read-only subcommands", async () => {
    expect(await compare(RMUX_STEPS)).toBeGreaterThan(8);
  }, 120_000);

  test("update refuses before the network; uninstall prints its plan", async () => {
    expect(await compare(INSTALL_STEPS)).toBeGreaterThan(4);
  }, 120_000);

  test("serve is handed to Bun and answers on stdio like the TS CLI", async () => {
    const hello = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`;
    const one = { args: ["serve"], env: { OKF_BUNDLE: "<BUNDLE>" } };
    const [expected, actual] = await Promise.all([runSide(ts, one, hello), runSide(rust, one, hello)]);
    expect(normalize(actual.stdout, rust)).toBe(normalize(expected.stdout, ts));
    expect(actual.code).toBe(expected.code);
    expect(actual.stdout).toContain('"tools"');
  }, 60_000);

  test("without Bun, ui and serve say so and exit 1 (as the launchers do)", async () => {
    const empty = join(sandbox, "empty-path");
    await mkdir(empty, { recursive: true });
    for (const command of ["ui", "serve"]) {
      const proc = Bun.spawn([RUST_CLI, command, "--bundle", rust.bundle], {
        cwd: ROOT,
        env: { ...envFor(rust, undefined), PATH: empty, Path: empty },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stdout).toBe("");
      expect(stderr.trim()).toBe("Bun が見つかりません。https://bun.sh からインストールしてください。");
      expect(code).toBe(1);
    }
  }, 30_000);
});
