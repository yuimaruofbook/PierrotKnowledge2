/**
 * The `okf` CLI, and the RMUX command surface it builds.
 *
 * The CLI is generated from the MCP tool table, so what needs testing is the
 * mapping — argument parsing, positional filling, type coercion — plus the
 * exact argv handed to rmux. The rmux commands are asserted as data because
 * rmux may not be installed, and a wrong flag there fails silently inside a
 * pane where nobody is looking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildToolArgs, coerce, parseArgv } from "../src/bun/cli/args";
import {
  agentWorkspacePlan,
  collectPaneOutput,
  defaultPaneShell,
  exportEnv,
  isBrokenInstall,
  jobPlan,
  newSession,
  okfPaneCommand,
  paneSnapshot,
  parseCollected,
  parseSnapshot,
  quoteForPane,
  sendKeys,
  stripAnsi,
  waitPane,
  windowTarget,
} from "../src/bun/cli/rmux";
import { TOOLS } from "../src/bun/mcp/tools";
import { run } from "../src/bun/cli/main";
import { Workspace } from "../src/bun/workspace";
import { removeTempDir } from "./helpers";

describe("argument parsing", () => {
  test("splits positionals from flags", () => {
    const parsed = parseArgv(["search", "設計", "--limit", "5"]);

    expect(parsed.positional).toEqual(["search", "設計"]);
    expect(parsed.flags.limit).toBe("5");
  });

  test("accepts --key=value", () => {
    expect(parseArgv(["--budget_chars=6000"]).flags.budget_chars).toBe("6000");
  });

  test("a bare flag is true", () => {
    expect(parseArgv(["lint", "--json"]).flags.json).toBe(true);
    // A flag followed by another flag must not swallow it.
    expect(parseArgv(["--json", "--quiet"]).flags.json).toBe(true);
    expect(parseArgv(["--json", "--quiet"]).flags.quiet).toBe(true);
  });

  test("everything after -- is positional", () => {
    // Without this, a query starting with a dash is unusable.
    const parsed = parseArgv(["search", "--", "--not-a-flag"]);
    expect(parsed.positional).toEqual(["search", "--not-a-flag"]);
  });
});

describe("coercion to the schema's type", () => {
  test("numbers, booleans and arrays", () => {
    expect(coerce("8", { type: "number" })).toBe(8);
    expect(coerce("false", { type: "boolean" })).toBe(false);
    expect(coerce("true", { type: "boolean" })).toBe(true);
    expect(coerce("a, b ,c", { type: "array" })).toEqual(["a", "b", "c"]);
  });

  test("a value that cannot convert is passed through for the tool to reject", () => {
    expect(coerce("many", { type: "number" })).toBe("many");
  });

  test("Japanese survives untouched", () => {
    expect(coerce("  設計原則  ", { type: "string" })).toBe("  設計原則  ");
  });
});

describe("filling a tool's arguments", () => {
  const search = TOOLS.find((t) => t.name === "search")!;

  test("required arguments can be given positionally", () => {
    const { args, missing } = buildToolArgs(search.inputSchema, {
      positional: ["日本語検索"],
      flags: {},
    });

    expect(args.query).toBe("日本語検索");
    expect(missing).toEqual([]);
  });

  test("flags win over positionals", () => {
    const { args } = buildToolArgs(search.inputSchema, {
      positional: ["ignored"],
      flags: { query: "explicit" },
    });

    expect(args.query).toBe("explicit");
  });

  test("missing required arguments are reported, not guessed", () => {
    const { missing } = buildToolArgs(search.inputSchema, { positional: [], flags: {} });
    expect(missing).toEqual(["query"]);
  });

  test("the CLI's own flags are never passed to a tool", () => {
    const { args } = buildToolArgs(search.inputSchema, {
      positional: ["q"],
      flags: { json: true, bundle: "C:/x" },
    });

    expect(args.json).toBeUndefined();
    expect(args.bundle).toBeUndefined();
  });

  test("unknown flags are ignored rather than sent as junk", () => {
    const { args } = buildToolArgs(search.inputSchema, {
      positional: ["q"],
      flags: { nonsense: "x" },
    });

    expect(args.nonsense).toBeUndefined();
  });

  test("every tool can be reached from the CLI", () => {
    // The CLI is generated from the tool table, so this is really a check that
    // nothing in the table has a shape the mapping cannot express.
    for (const tool of TOOLS) {
      expect(() => buildToolArgs(tool.inputSchema, { positional: [], flags: {} })).not.toThrow();
    }
  });
});

describe("rmux commands", () => {
  test("a session is created detached and sized for an agent", () => {
    // Attaching would block the agent until a human detached it. The size is
    // explicit because a detached session defaults to 80 columns, and both
    // JSON replies and retrieval output routinely exceed that.
    expect(newSession("demo", 200, 50).argv).toEqual([
      "new-session",
      "-d",
      "-s",
      "demo",
      "-x",
      "200",
      "-y",
      "50",
    ]);
  });

  test("send-keys ends with the Enter key name", () => {
    // Without it the text sits on the prompt unexecuted, which reads as a hang.
    const command = sendKeys("demo", "okf info");
    expect(command.argv[command.argv.length - 1]).toBe("Enter");
    expect(command.argv.slice(0, 3)).toEqual(["send-keys", "-t", "demo"]);
  });

  test("a pane is read as JSON rather than as a screenful of text", () => {
    // capture-pane returns the visible screen already wrapped to the pane
    // width, leaving the agent to guess where lines really ended.
    expect(paneSnapshot("demo:main").argv).toEqual([
      "pane-snapshot",
      "-t",
      "demo:main",
      "--json",
    ]);
  });

  test("a job collects the byte stream, not the screen", () => {
    expect(collectPaneOutput("demo:job", 4096).argv).toEqual([
      "collect-pane-output",
      "-t",
      "demo:job",
      "--until-pane-exit",
      "--max-bytes",
      "4096",
      "--json",
    ]);
  });

  test("waiting uses --next-text, never --text", () => {
    // Measured: --text matches content already on screen, including the
    // command line the shell just echoed, so it returns in about a
    // millisecond and reports success before the command has run.
    const command = waitPane("demo:job", { nextText: "DONE", timeout: "120s" });
    expect(command.argv).toEqual([
      "wait-pane",
      "-t",
      "demo:job",
      "--next-text",
      "DONE",
      "--timeout",
      "120s",
      "--json",
    ]);
    expect(command.argv).not.toContain("--text");
  });

  test("a window is addressed explicitly", () => {
    // Without this, send-keys goes to whichever pane happens to be active.
    expect(windowTarget("okf-wiki", "job")).toBe("okf-wiki:job");
  });

  test("quoting follows the shell the pane actually runs", () => {
    expect(quoteForPane("C:/Program Files/x", "posix")).toBe("'C:/Program Files/x'");
    // The POSIX escape for an embedded single quote.
    expect(quoteForPane("it's", "posix")).toBe(`'it'\\''s'`);

    // cmd.exe has no single-quote syntax: POSIX quoting arrives literally and
    // the pane tries to run a program whose name starts with a quote.
    expect(quoteForPane("C:\\Program Files\\x", "cmd")).toBe(`"C:\\Program Files\\x"`);
    expect(quoteForPane("it's", "cmd")).toBe(`"it's"`);
  });

  test("the pane shell is chosen from the platform", () => {
    expect(defaultPaneShell("win32")).toBe("cmd");
    expect(defaultPaneShell("darwin")).toBe("posix");
    expect(defaultPaneShell("linux")).toBe("posix");
  });

  test("setting an environment variable uses each shell's own syntax", () => {
    expect(exportEnv("OKF_BUNDLE", "/home/me/wiki", "posix")).toBe(
      "export OKF_BUNDLE='/home/me/wiki'"
    );
    // cmd has no `export`, and the quotes wrap the whole assignment so that a
    // path with spaces survives.
    expect(exportEnv("OKF_BUNDLE", "C:\\OKF Wiki", "cmd")).toBe(`set "OKF_BUNDLE=C:\\OKF Wiki"`);
  });

  test("a job runs in its own window", () => {
    const job = jobPlan({ session: "demo", command: "okf rebuild-rag" });

    expect(job.target).toBe("demo:job");
    // The command is the window's own process, so the pane exiting means the
    // job finished — not that someone closed a shell.
    expect(job.start.argv).toEqual([
      "new-window",
      "-t",
      "demo",
      "-n",
      "job",
      "okf rebuild-rag",
    ]);
    expect(job.collect.argv).toContain("--until-pane-exit");
    expect(job.cleanup.argv).toEqual(["kill-window", "-t", "demo:job"]);
  });

  test("a compiled binary invokes itself, not a virtual module path", () => {
    // `bun build --compile` makes process.argv[1] a path *inside* the
    // executable. Handing that to `bun run` in a pane fails with "Module not
    // found", so the executable itself has to be the command.
    expect(
      okfPaneCommand({
        entry: "B:/~BUN/root/okf",
        execPath: "C:\\build\\okf.exe",
        shell: "cmd",
      })
    ).toBe(`"C:\\build\\okf.exe"`);

    // Run from source, the entry point is a real file and needs `bun run`.
    expect(
      okfPaneCommand({
        entry: "/dev/My App/main.ts",
        execPath: "/usr/bin/bun",
        shell: "posix",
      })
    ).toBe("bun run '/dev/My App/main.ts'");

    // Windows source run: execPath is bun.exe, so it is still `bun run`.
    expect(
      okfPaneCommand({
        entry: "C:\\dev\\main.ts",
        execPath: "C:\\Users\\me\\.bun\\bin\\bun.exe",
        shell: "cmd",
      })
    ).toBe(`bun run "C:\\dev\\main.ts"`);
  });

  test("send-keys passes the command verbatim", () => {
    // rmux is spawned directly, with no shell in between to strip quotes, so
    // anything added around the command lands on the pane's prompt as text.
    // This is the bug that made every pane report "no such program".
    const command = sendKeys("demo", `okf info --bundle "C:\\OKF Wiki"`);
    expect(command.argv[3]).toBe(`okf info --bundle "C:\\OKF Wiki"`);
  });

  test("the workspace plan quotes every interpolated path, in either shell", () => {
    for (const [shell, quote] of [
      ["posix", "'"],
      ["cmd", `"`],
    ] as const) {
      const plan = agentWorkspacePlan({
        bundle: "C:/Users/me/OKF Wiki",
        okf: `bun run ${quote}C:/dev/My App/cli.ts${quote}`,
        shell,
      });

      // Commands reach a pane two ways now: typed in with send-keys, or given
      // to new-window as the window's own process. Both are shell lines.
      const payloads = plan.commands
        .flatMap((c) =>
          c.argv[0] === "send-keys"
            ? [c.argv[3] as string]
            : c.argv[0] === "new-window" && c.argv.length > 5
              ? [c.argv[5] as string]
              : []
        )
        // The env line quotes the whole `NAME=value` assignment rather than
        // the value alone, which is checked by the exportEnv test instead.
        .filter((p) => !p.includes("OKF_BUNDLE="));

      expect(payloads.length).toBeGreaterThan(0);

      for (const payload of payloads) {
        // Every path with a space in it must be wrapped, or the pane's shell
        // splits it and runs something else.
        for (const spaced of ["C:/Users/me/OKF Wiki", "C:/dev/My App/cli.ts"]) {
          if (payload.includes(spaced)) {
            expect(payload).toContain(`${quote}${spaced}${quote}`);
          }
        }
      }
    }
  });

  test("the plan never sends `export` to a cmd pane", () => {
    // cmd would treat it as an unknown command and the bundle would go unset,
    // leaving every later `okf` call in that pane pointed at the wrong place.
    const plan = agentWorkspacePlan({ bundle: "C:\\OKF Wiki", okf: "okf", shell: "cmd" });
    const payloads = plan.commands.filter((c) => c.argv[0] === "send-keys").map((c) => c.argv[3]);

    expect(payloads.some((p) => p?.includes("OKF_BUNDLE"))).toBe(true);
    expect(payloads.some((p) => p?.includes("export "))).toBe(false);
  });

  test("a broken install is told apart from a missing one", () => {
    // The Windows prebuilt of 0.9.1 reports a version but cannot start a
    // server; telling the user to reinstall the same zip would not help.
    expect(isBrokenInstall("private rmux helper not found under libexec/rmux")).toBe(true);
    // A server that is simply not up yet is normal, not a broken install.
    expect(isBrokenInstall(String.raw`no server running on \\.\pipe\rmux-S-1-5-21`)).toBe(false);
  });

  test("the plan opens the session before using it", () => {
    const plan = agentWorkspacePlan({ bundle: "/b", okf: "okf" });
    expect(plan.commands[0]?.argv[0]).toBe("new-session");
  });

  test("the plan builds windows, never splits", () => {
    // Measured on rmux 0.9.1: `split-window -h` took a 200-column pane to 99,
    // so every line past 99 characters wrapped and the output was shredded.
    const plan = agentWorkspacePlan({ bundle: "/b", okf: "okf" });
    const verbs = plan.commands.map((c) => c.argv[0]);

    expect(verbs).not.toContain("split-window");
    expect(verbs).toContain("new-window");
  });

  test("the plan addresses windows by name rather than the session", () => {
    // `-t <session>` lands on whichever pane is active, which is not something
    // the caller chose.
    const plan = agentWorkspacePlan({ bundle: "/b", okf: "okf" });

    for (const command of plan.commands.filter((c) => c.argv[0] === "send-keys")) {
      expect(command.argv[2]).toContain(":");
    }
  });
});

describe("reading rmux replies", () => {
  test("control sequences are stripped from collected output", () => {
    // collect-pane-output returns the raw byte stream, so it carries whatever
    // the program emitted — including the window-title sequence cmd.exe
    // writes on startup, which would otherwise retarget a real terminal.
    const raw = "\u001B[?25l\u001B[2J\u001B[HBEGIN\r\n\u001B]0;C:\\cmd.exe\u0007END\r\n";
    expect(stripAnsi(raw)).toBe("BEGIN\nEND\n");
  });

  test("a collected job is read into a plain result", () => {
    const reply = JSON.stringify({
      ok: true,
      bytes: 12,
      stored_bytes: 12,
      truncated: false,
      output_utf8_lossy: "概念 : 5 件\r\n",
      pane_exit: { exit_signal: null, exit_status: null, stale: true },
      schema_version: 1,
    });

    const result = parseCollected(reply)!;
    expect(result.ok).toBe(true);
    expect(result.text).toBe("概念 : 5 件\n");
    expect(result.truncated).toBe(false);
    // Null on Windows, always. Callers must not read it as success.
    expect(result.exitStatus).toBeNull();
  });

  test("a real exit status is kept when rmux reports one", () => {
    const reply = JSON.stringify({
      ok: true,
      output_utf8_lossy: "",
      pane_exit: { exit_status: 3, stale: false },
    });
    expect(parseCollected(reply)!.exitStatus).toBe(3);
  });

  test("a snapshot drops the unused part of the screen", () => {
    const reply = JSON.stringify({
      ok: true,
      cols: 200,
      rows: 50,
      lines: ["$ okf info", "概念 : 5 件", "", ""],
      text: "$ okf info\n概念 : 5 件\n\n\n\n",
      schema_version: 1,
    });

    const view = parseSnapshot(reply)!;
    expect(view.text).toBe("$ okf info\n概念 : 5 件");
    expect(view.cols).toBe(200);
  });

  test("output that is not JSON is reported rather than guessed at", () => {
    expect(parseCollected("no server running")).toBeNull();
    expect(parseSnapshot("no server running")).toBeNull();
  });
});

describe("running the CLI", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okf-cli-"));
    workspace = new Workspace({ watch: false });
    await workspace.scaffold(root);
    await workspace.open(root);
    await writeFile(
      join(root, "wiki", "3-resources", "note.md"),
      "---\ntype: Concept\ntitle: 検索対象\n---\n\n# 検索対象\n\nバイグラム索引の話。\n",
      "utf8"
    );
    await workspace.close();
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  test("exit code 0 on success", async () => {
    expect(await run(["info", "--bundle", root])).toBe(0);
  });

  test("exit code 2 when a required argument is missing", async () => {
    expect(await run(["search", "--bundle", root])).toBe(2);
  });

  test("exit code 2 for an unknown command", async () => {
    expect(await run(["no-such-command", "--bundle", root])).toBe(2);
  });

  test("a bundle that does not exist fails rather than inventing one", async () => {
    // Deliberately not testing the "no bundle at all" path here: that falls
    // back to the saved session, which is real machine state, so the outcome
    // would depend on whoever ran the suite last.
    expect(await run(["info", "--bundle", join(root, "no-such-bundle")])).toBe(1);
  });

  test("exit code 1 when the tool itself fails", async () => {
    expect(await run(["read-file", "wiki/missing.md", "--bundle", root])).toBe(1);
  });

  test("aliases resolve to their tool", async () => {
    expect(await run(["lint", "--bundle", root])).toBe(0);
    expect(await run(["gaps", "--bundle", root])).toBe(0);
  });

  test("--help never touches the bundle", async () => {
    // Help must work before anything is configured.
    expect(await run(["search", "--help"])).toBe(0);
  });
});
