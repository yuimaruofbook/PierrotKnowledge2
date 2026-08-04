/**
 * One-touch connection to other agent runtimes.
 *
 * These functions edit files that belong to other tools and hold settings the
 * user cares about, so the property under test is mostly "everything else
 * survived" rather than "our entry appeared".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  mergeCodexToml,
  mergeHermesYaml,
  mergeMcpJson,
  mergeOpencodeJson,
  type StdioServer,
} from "../src/bun/connect/merge";
import {
  CONNECT_TARGETS,
  findTarget,
  headlessBinaryPath,
  serverSpecFor,
  connectAllTargets,
  connectTarget,
  findInstallRoot,
  formatInvocation,
  renderServerConfig,
  type ConnectTarget,
} from "../src/bun/connect/targets";
import { removeTempDir } from "./helpers";

const SERVER: StdioServer = {
  command: "bun",
  args: ["run", "C:/proj/src/bun/mcp/standalone.ts"],
  env: { OKF_BUNDLE: "C:/notes" },
};

describe("Claude Code (.mcp.json)", () => {
  test("creates the file when absent", () => {
    const parsed = JSON.parse(mergeMcpJson(null, "okf-wiki", SERVER));

    expect(parsed.mcpServers["okf-wiki"].command).toBe("bun");
    expect(parsed.mcpServers["okf-wiki"].env.OKF_BUNDLE).toBe("C:/notes");
  });

  test("keeps other servers and other top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: { notion: { command: "npx", args: ["-y", "notion"] } },
      somethingElse: { keep: true },
    });

    const parsed = JSON.parse(mergeMcpJson(existing, "okf-wiki", SERVER));

    expect(parsed.mcpServers.notion.command).toBe("npx");
    expect(parsed.somethingElse.keep).toBe(true);
    expect(parsed.mcpServers["okf-wiki"]).toBeTruthy();
  });

  test("replaces our own entry rather than duplicating it", () => {
    const once = mergeMcpJson(null, "okf-wiki", SERVER);
    const twice = mergeMcpJson(once, "okf-wiki", SERVER);

    expect(Object.keys(JSON.parse(twice).mcpServers)).toEqual(["okf-wiki"]);
  });

  test("a corrupt file does not stop the connection", () => {
    // The caller holds a backup; refusing here would leave the user with a
    // broken config and no server.
    expect(JSON.parse(mergeMcpJson("{not json", "okf-wiki", SERVER)).mcpServers["okf-wiki"]).toBeTruthy();
  });
});

describe("opencode (opencode.json)", () => {
  test("uses the mcp key, a type discriminator and a single command array", () => {
    const parsed = JSON.parse(mergeOpencodeJson(null, "okf-wiki", SERVER));
    const entry = parsed.mcp["okf-wiki"];

    expect(entry.type).toBe("local");
    expect(entry.command).toEqual(["bun", "run", "C:/proj/src/bun/mcp/standalone.ts"]);
    expect(entry.enabled).toBe(true);
    // opencode calls it `environment`, not `env`.
    expect(entry.environment.OKF_BUNDLE).toBe("C:/notes");
    expect(entry.env).toBeUndefined();
  });

  test("keeps existing servers and settings", () => {
    const existing = JSON.stringify({
      model: "anthropic/claude-sonnet-5",
      mcp: { other: { type: "local", command: ["x"] } },
    });

    const parsed = JSON.parse(mergeOpencodeJson(existing, "okf-wiki", SERVER));

    expect(parsed.model).toBe("anthropic/claude-sonnet-5");
    expect(parsed.mcp.other.command).toEqual(["x"]);
  });
});

describe("Codex (config.toml)", () => {
  // Shaped after a real config: model settings, another MCP server, and
  // per-project tables that must survive untouched.
  const existing = [
    'personality = "pragmatic"',
    'model = "gpt-5.6-terra"',
    "",
    "[mcp_servers.pencil]",
    'command = "c:\\\\tools\\\\pencil.exe"',
    'args = [ "--app", "antigravity" ]',
    "",
    "[windows]",
    'sandbox = "elevated"',
    "",
    "[projects.'C:\\Users\\me']",
    'trust_level = "trusted"',
    "",
  ].join("\n");

  test("appends our table without disturbing anything else", () => {
    const merged = mergeCodexToml(existing, "okf-wiki", SERVER);

    expect(merged).toContain('personality = "pragmatic"');
    expect(merged).toContain("[mcp_servers.pencil]");
    expect(merged).toContain("[windows]");
    expect(merged).toContain("[projects.'C:\\Users\\me']");
    expect(merged).toContain("[mcp_servers.okf-wiki]");
    expect(merged).toContain('command = "bun"');
  });

  test("replaces our table on a second run instead of duplicating it", () => {
    const once = mergeCodexToml(existing, "okf-wiki", SERVER);
    const twice = mergeCodexToml(once, "okf-wiki", SERVER);

    expect(twice.match(/\[mcp_servers\.okf-wiki\]/g)).toHaveLength(1);
    // And the table that follows ours must still be there.
    expect(twice).toContain("[windows]");
  });

  test("a second run changes nothing at all", () => {
    // Not just "no duplicate table": byte-identical. Connecting is something
    // setup does on every run, and a merge that keeps nibbling at the file
    // leaves the user a new .okf-backup- on each one, for edits they never
    // made. A blank line before our table was being eaten each time.
    const once = mergeCodexToml(existing, "okf-wiki", SERVER);
    const twice = mergeCodexToml(once, "okf-wiki", SERVER);
    const thrice = mergeCodexToml(twice, "okf-wiki", SERVER);

    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  test("the blank lines around our table are left alone", () => {
    const withOurs = [
      "[general]",
      'model = "x"',
      "",
      "[mcp_servers.okf-wiki]",
      'command = "old"',
      "args = []",
      "",
      "[windows]",
      "shell = true",
      "",
    ].join("\n");

    const merged = mergeCodexToml(withOurs, "okf-wiki", SERVER);

    expect(merged).toContain('model = "x"\n\n[mcp_servers.okf-wiki]');
    expect(merged).toContain("\n\n[windows]");
  });

  test("replacing our table does not swallow the next one", () => {
    const withOurs = [
      "[mcp_servers.okf-wiki]",
      'command = "old"',
      'args = []',
      "",
      "[mcp_servers.keep-me]",
      'command = "npx"',
      "",
    ].join("\n");

    const merged = mergeCodexToml(withOurs, "okf-wiki", SERVER);

    expect(merged).toContain("[mcp_servers.keep-me]");
    expect(merged).not.toContain('command = "old"');
  });

  test("escapes Windows paths so the TOML stays valid", () => {
    const merged = mergeCodexToml(null, "okf-wiki", {
      command: "C:\\Program Files\\bun\\bun.exe",
      args: [],
    });

    expect(merged).toContain('command = "C:\\\\Program Files\\\\bun\\\\bun.exe"');
  });

  test("creates a usable file from nothing", () => {
    expect(mergeCodexToml(null, "okf-wiki", SERVER)).toStartWith("[mcp_servers.okf-wiki]");
  });
});

describe("hermes-yaml merging (format retained; Hermes uses its CLI)", () => {
  test("adds under mcp_servers and keeps the rest", () => {
    const existing = ["model: hermes-4", "mcp_servers:", "  fs:", "    command: npx", ""].join("\n");

    const merged = mergeHermesYaml(existing, "okf-wiki", SERVER);

    expect(merged).toContain("model: hermes-4");
    expect(merged).toContain("fs:");
    expect(merged).toContain("okf-wiki:");
    expect(merged).toContain("OKF_BUNDLE");
  });

  test("is idempotent", () => {
    const once = mergeHermesYaml(null, "okf-wiki", SERVER);
    const twice = mergeHermesYaml(once, "okf-wiki", SERVER);

    expect(twice.match(/okf-wiki:/g)).toHaveLength(1);
  });
});

describe("the target catalogue", () => {
  test("covers every runtime that has been asked for", () => {
    expect(CONNECT_TARGETS.map((t) => t.id).sort()).toEqual([
      "antigravity",
      "antigravity-cli",
      "claude-code",
      "claude-code-user",
      "codex",
      "cursor",
      "cursor-user",
      "hermes",
      "llamacpp",
      "lmstudio",
      "ollama",
      "opencode",
      "vllm",
    ]);
  });

  test("Orca: the user-scope host offers a command, not a file write", () => {
    // Orca gives each agent its own git worktree, so an agent never has the
    // bundle as its working directory and a project-scoped .mcp.json there is
    // never found. User scope is the only one that survives that — and
    // ~/.claude.json also holds project state, so it is not ours to rewrite.
    const target = findTarget("claude-code-user");

    expect(target.format).toBeUndefined();
    expect(target.setupCommand).toBeDefined();

    const command = target.setupCommand!("C:/notes", "okf-mcp.exe");
    expect(command).toContain("--scope user");
    expect(command).toContain("OKF_BUNDLE=");
  });

  test("a bundle path with spaces is quoted in the command", () => {
    const command = findTarget("claude-code-user").setupCommand!(
      "C:/Users/me/My Notes",
      "okf-mcp.exe"
    );
    // Unquoted, the shell would split it and the server would open the wrong
    // folder — or none at all.
    expect(command).toContain('"C:/Users/me/My Notes"');
  });

  test("every MCP host names the dialect it wants, and no model server does", () => {
    // The format used to be decided by a switch when applying and a ternary
    // chain when previewing; adding a host meant remembering both. Holding it
    // on the target is what keeps those from drifting apart.
    for (const target of CONNECT_TARGETS) {
      if (target.kind !== "mcp-host") {
        expect(target.format).toBeUndefined();
        continue;
      }
      // A host is configured exactly one way, never none and never two:
      // a file we merge into, a command we run for the user, or a command we
      // hand them to run. Two would mean the preview and the apply could
      // disagree about which one happened.
      const ways = [target.format, target.cli, target.setupCommand].filter(Boolean);
      expect(ways).toHaveLength(1);
    }
  });

  test("separates MCP hosts from model servers", () => {
    const kind = (id: string) => findTarget(id).kind;

    expect(kind("claude-code")).toBe("mcp-host");
    expect(kind("codex")).toBe("mcp-host");
    expect(kind("opencode")).toBe("mcp-host");
    expect(kind("hermes")).toBe("mcp-host");
    // These two speak OpenAI HTTP, not MCP — the distinction drives the UI.
    expect(kind("ollama")).toBe("model-server");
    expect(kind("llamacpp")).toBe("model-server");
  });

  test("model servers carry a default endpoint", () => {
    // Ports from each vendor own docs, not recalled.
    expect(findTarget("ollama").endpoint).toContain("11434");
    expect(findTarget("llamacpp").endpoint).toContain("8080");
    expect(findTarget("lmstudio").endpoint).toContain("1234");
    expect(findTarget("vllm").endpoint).toContain("8000");
  });

  test("vLLM warns that tool calling needs two flags", () => {
    // With only one of them the model ignores every tool, which reads as this
    // app being broken rather than a missing flag.
    const note = findTarget("vllm").note;
    expect(note).toContain("--enable-auto-tool-choice");
    expect(note).toContain("--tool-call-parser");
  });

  test("Antigravity writes the documented mcpServers shape", () => {
    expect(findTarget("antigravity").format).toBe("mcp-json");
    expect(findTarget("antigravity-cli").format).toBe("mcp-json");
  });

  test("Antigravity CLI is scoped to the bundle, the global one is not", () => {
    // Project scope touches nothing the user has set up globally.
    const slash = (p: string) => p.replace(/\\/g, "/");

    const scoped = findTarget("antigravity-cli").configPath("C:/bundles/mine");
    expect(slash(scoped)).toBe("C:/bundles/mine/.agents/mcp_config.json");

    const global_ = findTarget("antigravity").configPath("C:/bundles/mine");
    expect(slash(global_)).toContain(".gemini/config/mcp_config.json");
  });

  test("llama.cpp's note warns about --jinja", () => {
    // Without it the model silently ignores every tool.
    expect(findTarget("llamacpp").note).toContain("--jinja");
  });

  test("Claude Code is configured inside the bundle, not globally", () => {
    // Project scope keeps the user's global agent settings untouched.
    const path = findTarget("claude-code").configPath("C:/notes").replace(/\\/g, "/");

    expect(path).toBe("C:/notes/.mcp.json");
  });

  test("the other hosts are configured in their own home directories", () => {
    for (const id of ["codex", "opencode", "hermes"]) {
      const path = findTarget(id).configPath("C:/notes").replace(/\\/g, "/");
      expect(path).not.toContain("C:/notes");
    }
  });

  test("an unknown target is refused", () => {
    expect(() => findTarget("nope")).toThrow();
  });

  test("the server spec pins the bundle so no open_bundle round trip is needed", () => {
    // No headless binary under this fake root, so it falls back to bun run.
    const spec = serverSpecFor("C:/proj-with-no-build", "C:/notes");

    expect(spec.command).toBe("bun");
    expect(spec.args[1]).toContain("standalone.ts");
    expect(spec.env?.OKF_BUNDLE).toBe("C:/notes");
  });

  test("the headless binary is preferred once it has been built", () => {
    // Agent hosts spawn this themselves, so it must not require Bun on PATH.
    const repo = resolve(import.meta.dir, "..");
    const binary = headlessBinaryPath(repo);

    if (!existsSync(binary)) {
      // `bun run build:headless` has not been run in this checkout.
      expect(serverSpecFor(repo, "C:/notes").command).toBe("bun");
      return;
    }

    const spec = serverSpecFor(repo, "C:/notes");
    expect(spec.command).toContain("okf-mcp");
    expect(spec.args).toEqual([]);
    expect(spec.env?.OKF_BUNDLE).toBe("C:/notes");
  });
});

/**
 * The file-writing layer, not the merge.
 *
 * Claude Code's config is the one that lives inside the bundle, which makes it
 * the right target to pin this on: a backup written here lands among the
 * user's notes.
 */
describe("connectTarget", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-connect-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  const connect = () =>
    connectTarget({ targetId: "claude-code", projectRoot: resolve("."), bundleRoot: dir });

  test("writes the config the first time", async () => {
    const result = await connect();

    expect(result.created).toBe(true);
    expect(result.backup).toBeUndefined();
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  test("a second run writes nothing and takes no backup", async () => {
    await connect();
    const before = await readFile(join(dir, ".mcp.json"), "utf8");

    const result = await connect();

    expect(result.unchanged).toBe(true);
    expect(result.backup).toBeUndefined();
    expect(await readFile(join(dir, ".mcp.json"), "utf8")).toBe(before);
    // Nothing but the config itself: no .okf-backup- among the user's notes.
    expect((await readdir(dir)).filter((f) => f.includes("okf-backup"))).toEqual([]);
  });

  test("a genuine change still takes a backup", async () => {
    await connect();
    await writeFile(join(dir, ".mcp.json"), '{\n  "mcpServers": {}\n}\n', "utf8");

    const result = await connect();

    expect(result.unchanged).toBeUndefined();
    expect(result.backup).toBeTruthy();
    expect((await readdir(dir)).some((f) => f.includes("okf-backup"))).toBe(true);
  });
});

/**
 * The one-touch sweep behind "すべてのエージェントに登録".
 *
 * Driven with a fake catalogue on purpose. The real one writes into
 * `~/.codex/config.toml`, `~/.cursor/mcp.json` and `~/.gemini/…` — a test that
 * used it would edit the settings of whoever ran `bun test`.
 */
describe("connectAllTargets", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-bulk-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  /** A host whose config lives inside the bundle, so nothing global is touched. */
  const host = (id: string, file: string): ConnectTarget => ({
    id,
    label: id,
    kind: "mcp-host",
    format: "mcp-json",
    configPath: (bundleRoot) => join(bundleRoot, file),
    probe: id,
    note: "",
  });

  const sweep = (
    targets: readonly ConnectTarget[],
    options: { includeMissing?: boolean; installed?: (target: ConnectTarget) => boolean } = {}
  ) =>
    connectAllTargets({
      projectRoot: resolve("."),
      bundleRoot: dir,
      targets,
      probeInstalled: async (target) => options.installed?.(target) ?? true,
      ...(options.includeMissing ? { includeMissing: true } : {}),
    });

  test("writes every installed host in one call", async () => {
    const report = await sweep([host("a", "a.json"), host("b", "b.json")]);

    expect(report.map((r) => r.status)).toEqual(["connected", "connected"]);
    expect(existsSync(join(dir, "a.json"))).toBe(true);
    expect(existsSync(join(dir, "b.json"))).toBe(true);
  });

  test("a second sweep reports 変更なし and leaves no backups", async () => {
    // Pressing the button again is how a moved bundle gets re-pointed, so it
    // has to be free of consequences when nothing has actually changed.
    const targets = [host("a", "a.json"), host("b", "b.json")];
    await sweep(targets);

    const report = await sweep(targets);

    expect(report.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
    expect((await readdir(dir)).filter((f) => f.includes("okf-backup"))).toEqual([]);
  });

  test("a tool that is not on this machine is skipped, with a reason", async () => {
    const report = await sweep([host("here", "here.json"), host("gone", "gone.json")], {
      installed: (target) => target.id === "here",
    });

    expect(report[1]?.status).toBe("skipped");
    expect(report[1]?.reason).toContain("gone");
    // Not written: a config for a tool that is not installed is litter, and it
    // would report as connected forever after.
    expect(existsSync(join(dir, "gone.json"))).toBe(false);
  });

  test("includeMissing writes for a tool the probe could not see", async () => {
    // Cursor on Windows is usually installed and usually invisible to `where`.
    const report = await sweep([host("cursor", "cursor.json")], {
      installed: () => false,
      includeMissing: true,
    });

    expect(report[0]?.status).toBe("connected");
    expect(existsSync(join(dir, "cursor.json"))).toBe(true);
  });

  test("a host we must not write is reported with its command, not skipped", async () => {
    // Claude Code user scope: the one that survives an orchestrator running
    // agents from a worktree, so leaving it out of the report would drop the
    // case that matters most.
    const manual: ConnectTarget = {
      id: "manual-host",
      label: "manual-host",
      kind: "mcp-host",
      configPath: () => join(dir, "never.json"),
      setupCommand: (bundleRoot) => `some-cli add --bundle ${bundleRoot}`,
      note: "",
    };

    const report = await sweep([manual]);

    expect(report[0]?.status).toBe("manual");
    expect(report[0]?.command).toContain(dir);
    expect(existsSync(join(dir, "never.json"))).toBe(false);
  });

  test("one failure does not stop the rest", async () => {
    // Eight unrelated files: a config that cannot be written is no reason to
    // leave the other agents unconnected.
    await mkdir(join(dir, "blocked.json"), { recursive: true });

    const report = await sweep([host("blocked", "blocked.json"), host("fine", "fine.json")]);

    expect(report[0]?.status).toBe("failed");
    expect(report[0]?.reason).toBeTruthy();
    expect(report[1]?.status).toBe("connected");
    expect(existsSync(join(dir, "fine.json"))).toBe(true);
  });

  test("model servers are left out of the report entirely", async () => {
    // Ollama has nothing on its side to configure, so listing it as skipped
    // would imply something went wrong. Nothing is installed here, so the real
    // catalogue is safe to sweep — every host skips or reports a command.
    const report = await connectAllTargets({
      projectRoot: resolve("."),
      bundleRoot: dir,
      probeInstalled: async () => false,
    });

    const ids = report.map((r) => r.target);
    for (const id of ["ollama", "llamacpp", "lmstudio", "vllm"]) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toContain("codex");
    expect(report.every((r) => r.status === "skipped" || r.status === "manual")).toBe(true);
    // And it wrote nothing anywhere, including inside the bundle.
    expect(await readdir(dir)).toEqual([]);
  });
});

/**
 * The snippet for a host this app has no target for.
 *
 * Local machines run more MCP-capable tools than the nine with one-press
 * targets, and the answer for those is a config to paste. It has to name the
 * same server the one-press path writes: the hand-written copy in `setup.ps1`
 * did not, and kept recommending `bun run …/standalone.ts` long after the
 * compiled binary became the right answer.
 */
describe("renderServerConfig", () => {
  const projectRoot = "C:/proj-with-no-build";
  const bundleRoot = "C:/notes";

  test("the plain mcpServers shape most hosts take", () => {
    const parsed = JSON.parse(renderServerConfig("mcp-json", projectRoot, bundleRoot));

    expect(parsed.mcpServers["okf-wiki"].env.OKF_BUNDLE).toBe("C:/notes");
  });

  test("each dialect renders in its own shape", () => {
    expect(renderServerConfig("codex-toml", projectRoot, bundleRoot)).toContain(
      "[mcp_servers.okf-wiki]"
    );
    // opencode calls it `environment`, and takes one command array.
    const opencode = JSON.parse(renderServerConfig("opencode-json", projectRoot, bundleRoot));
    expect(opencode.mcp["okf-wiki"].environment.OKF_BUNDLE).toBe("C:/notes");
    expect(renderServerConfig("hermes-yaml", projectRoot, bundleRoot)).toContain("okf-wiki:");
  });

  test("it describes the same server the one-press connection writes", () => {
    // The property that matters. Two implementations of "how do you start
    // this server" is how the generated file drifted from the written one.
    const spec = serverSpecFor(projectRoot, bundleRoot);
    const parsed = JSON.parse(renderServerConfig("mcp-json", projectRoot, bundleRoot));
    const entry = parsed.mcpServers["okf-wiki"];

    expect(entry.command).toBe(spec.command);
    expect(entry.args).toEqual(spec.args);
    expect(entry.env).toEqual(spec.env);
  });

  test("it carries no existing config into the snippet", () => {
    // Rendered from nothing, so pasting it cannot bring another machine's
    // servers along.
    const parsed = JSON.parse(renderServerConfig("mcp-json", projectRoot, bundleRoot));

    expect(Object.keys(parsed.mcpServers)).toEqual(["okf-wiki"]);
  });
});

/**
 * Where the server actually lives.
 *
 * Configs on a real machine were found pointing at
 * `B:/src/bun/mcp/standalone.ts` and `C:/Users/<me>/AppData/src/bun/mcp/…`.
 * Both came from `resolve(import.meta.dir, "..", "..")`, which is only a
 * project root when the code runs from source: packaged, `import.meta.dir` is
 * a virtual path (`B:\~BUN\root\…` under Bun). The config looked plausible and
 * no agent host could ever spawn the server.
 */
describe("findInstallRoot", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-install-"));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  test("finds a checkout by its server source", async () => {
    await mkdir(join(dir, "src", "bun", "mcp"), { recursive: true });
    await writeFile(join(dir, "src", "bun", "mcp", "standalone.ts"), "", "utf8");

    expect(findInstallRoot([join(dir, "src", "bun", "mcp")])).toBe(dir);
  });

  test("walks up from a nested executable", async () => {
    await mkdir(join(dir, "src", "bun", "mcp"), { recursive: true });
    await writeFile(join(dir, "src", "bun", "mcp", "standalone.ts"), "", "utf8");
    const exe = join(dir, "build", "dev-win-x64", "App", "bin");
    await mkdir(exe, { recursive: true });

    expect(findInstallRoot([exe])).toBe(dir);
  });

  test("accepts an install that only has the headless binary", async () => {
    await mkdir(dirname(headlessBinaryPath(dir)), { recursive: true });
    await writeFile(headlessBinaryPath(dir), "", "utf8");

    expect(findInstallRoot([join(dir, "build", "headless")])).toBe(dir);
  });

  test("returns null for a virtual root rather than inventing a path", () => {
    // What `import.meta.dir` looks like inside a compiled binary.
    expect(findInstallRoot(["B:/~BUN/root/okf-wiki"])).toBeNull();
  });

  test("the second start point is used when the first is virtual", async () => {
    await mkdir(join(dir, "src", "bun", "mcp"), { recursive: true });
    await writeFile(join(dir, "src", "bun", "mcp", "standalone.ts"), "", "utf8");

    expect(findInstallRoot(["B:/~BUN/root/okf-wiki", dir])).toBe(dir);
  });
});

/**
 * Hermes registers through its own CLI.
 *
 * Writing its YAML by hand was wrong three ways at once, all invisible: the
 * file is `%LOCALAPPDATA%\hermes\config.yaml` on Windows and not
 * `~/.hermes/config.yaml`, `mcp_servers` is nested rather than top-level, and
 * every server carries a per-tool enable list. `hermes mcp add` writes all of
 * that, and connects to the server first to check it works.
 */
describe("Hermes Agent (its own CLI)", () => {
  const hermes = findTarget("hermes");

  test("connects with a command, not a merge", () => {
    expect(hermes.cli).toBeTruthy();
    // A format would send it back down the hand-merge path.
    expect(hermes.format).toBeUndefined();
  });

  test("builds the documented invocation", () => {
    const invocation = hermes.cli!(SERVER, "okf-wiki");

    expect(invocation.command).toBe("hermes");
    expect(invocation.args.slice(0, 3)).toEqual(["mcp", "add", "okf-wiki"]);
    expect(invocation.args[invocation.args.indexOf("--command") + 1]).toBe(SERVER.command);
    expect(invocation.args).toContain("OKF_BUNDLE=C:/notes");
  });

  test("puts --args last, as its help demands", () => {
    const { args } = hermes.cli!(SERVER, "okf-wiki");
    const at = args.indexOf("--args");

    expect(at).toBeGreaterThan(-1);
    expect(args.slice(at + 1)).toEqual(SERVER.args!);
    expect(args.slice(at + 1).some((a) => a.startsWith("--"))).toBe(false);
  });

  test("omits --args when the server takes none", () => {
    const { args } = hermes.cli!({ command: "okf-mcp.exe", args: [] }, "okf-wiki");

    expect(args).not.toContain("--args");
  });

  test("answers both prompts, not just the first", () => {
    // One question on a first run ("Enable all N tools?"), and two when the
    // name already exists, because "Overwrite?" comes first. Reconnecting is
    // the common case, and a single "y" answered the wrong one: the overwrite
    // went through, the enable prompt hit EOF, and Hermes cancelled having
    // changed nothing.
    expect(hermes.cli!(SERVER, "okf-wiki").stdin).toBe("y\ny\n");
  });

  test("can undo itself", () => {
    const invocation = hermes.cliRemove!("okf-wiki");

    expect(invocation.command).toBe("hermes");
    expect(invocation.args).toEqual(["mcp", "remove", "okf-wiki"]);
    expect(invocation.stdin).toBe("y\n");
  });

  test("its config path is the one Hermes actually reads", () => {
    const path = hermes.configPath("");

    if (process.platform === "win32") {
      // Verified against a real v0.20.0 install, which reported saving to
      // ~/AppData\Local\hermes/config.yaml.
      expect(path.toLowerCase()).toContain("appdata");
      expect(path.toLowerCase()).toContain("local");
    }
    expect(path.endsWith("config.yaml")).toBe(true);
  });

  test("renders the command for the preview pane", () => {
    const text = formatInvocation(hermes.cli!(SERVER, "okf-wiki"));

    expect(text).toStartWith("hermes mcp add okf-wiki");
    expect(text).toContain("--env OKF_BUNDLE=C:/notes");
  });
});
