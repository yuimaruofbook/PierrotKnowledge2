/**
 * Importing from an external MCP server.
 *
 * Driven against this project's own server over real pipes, so the whole path
 * is exercised — spawn, handshake, tool call, and the file that lands in
 * `raw/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { Bundle } from "../src/bun/okf/bundle";
import { Connections, importPathFor, toFileName, wrapImported } from "../src/bun/connections";
import { registryPath, saveServers, SERVER_PRESETS } from "../src/bun/mcp/registry";
import { VAULT_PLACEHOLDER } from "../src/shared/mcp-types";
import { removeTempDir } from "./helpers";

const SERVER_ENTRY = resolve(import.meta.dir, "..", "src", "bun", "mcp", "standalone.ts");

describe("naming captured sources", () => {
  test("keeps Japanese titles readable", () => {
    expect(toFileName("設計メモ")).toBe("設計メモ");
  });

  test("strips characters a filesystem rejects", () => {
    expect(toFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
  });

  test("falls back when nothing usable is left", () => {
    expect(toFileName("///")).toBe("untitled");
    expect(toFileName("")).toBe("untitled");
  });

  test("does not produce a leading dot or trailing space", () => {
    expect(toFileName("  ..hidden  ")).toBe("hidden");
  });

  test("builds a dated path under the server's folder", () => {
    const path = importPathFor("notion", "設計メモ", new Date("2026-08-01T09:00:00Z"));
    expect(path).toBe("raw/notion/2026-08-01-設計メモ.md");
  });
});

describe("provenance header", () => {
  test("records where the text came from", () => {
    const out = wrapImported({
      title: "設計メモ",
      serverLabel: "Notion",
      tool: "fetch",
      args: { id: "abc" },
      body: "本文です。",
      now: new Date("2026-08-01T09:00:00Z"),
    });

    expect(out).toContain("# 設計メモ");
    expect(out).toContain("取り込み元: Notion");
    expect(out).toContain("`fetch`");
    expect(out).toContain("2026-08-01T09:00:00.000Z");
    expect(out).toContain("本文です。");
  });
});

/** Spawning a server and completing a handshake takes seconds, not milliseconds. */
const SPAWN_TIMEOUT_MS = 30_000;

describe("importing through a live connection", () => {
  let bundleRoot: string;
  let sourceBundle: string;
  let sandbox: string;
  let bundle: Bundle;
  let connections: Connections;
  let originalAppData: string | undefined;
  let originalXdg: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "okf-conn-cfg-"));
    originalAppData = process.env.APPDATA;
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalHome = process.env.HOME;
    process.env.APPDATA = sandbox;
    process.env.XDG_CONFIG_HOME = sandbox;
    process.env.HOME = sandbox;

    // The "external" server is another OKF bundle, which gives us real tools
    // returning real text without depending on a third-party package.
    sourceBundle = await mkdtemp(join(tmpdir(), "okf-source-"));
    await mkdir(join(sourceBundle, "wiki"), { recursive: true });
    await writeFile(join(sourceBundle, "AGENTS.md"), "# 外部の契約\n取り込み対象。\n", "utf8");

    bundleRoot = await mkdtemp(join(tmpdir(), "okf-dest-"));
    await mkdir(join(bundleRoot, "wiki"), { recursive: true });
    await mkdir(join(bundleRoot, "raw"), { recursive: true });
    bundle = await Bundle.open(bundleRoot);

    await mkdir(dirname(registryPath()), { recursive: true });
    await saveServers([
      {
        id: "external",
        label: "外部バンドル",
        command: process.execPath,
        args: ["run", SERVER_ENTRY],
        env: { OKF_BUNDLE: sourceBundle },
      },
    ]);

    connections = new Connections();
    await connections.refresh();
  }, SPAWN_TIMEOUT_MS);

  afterEach(async () => {
    await connections.closeAll();
    process.env.APPDATA = originalAppData;
    process.env.XDG_CONFIG_HOME = originalXdg;
    process.env.HOME = originalHome;
    await removeTempDir(sandbox);
    await removeTempDir(sourceBundle);
    await removeTempDir(bundleRoot);
  }, SPAWN_TIMEOUT_MS);

  test("reports a registered server as disconnected until asked", async () => {
    const [status] = await connections.status();
    expect(status).toMatchObject({ id: "external", label: "外部バンドル", connected: false });
  }, SPAWN_TIMEOUT_MS);

  test("connects and lists the remote tools", async () => {
    const status = await connections.connect("external");
    expect(status.connected).toBe(true);
    expect(status.toolCount).toBeGreaterThan(0);

    const tools = await connections.listTools("external");
    expect(tools.map((t) => t.name)).toContain("read_agents_md");
  }, SPAWN_TIMEOUT_MS);

  test("captures a tool result into raw/", async () => {
    await connections.connect("external");
    const result = await connections.importFromTool(bundle, {
      serverId: "external",
      tool: "read_agents_md",
      args: {},
      title: "外部の契約",
    });

    expect(result.path).toMatch(/^raw\/external\/\d{4}-\d{2}-\d{2}-外部の契約\.md$/);

    const written = await readFile(join(bundleRoot, result.path), "utf8");
    expect(written).toContain("取り込み対象。"); // the remote content, verbatim
    expect(written).toContain("取り込み元: 外部バンドル");
  }, SPAWN_TIMEOUT_MS);

  test("re-importing adds a copy instead of replacing the first", async () => {
    await connections.connect("external");
    const opts = { serverId: "external", tool: "read_agents_md", args: {}, title: "同じ名前" };

    const first = await connections.importFromTool(bundle, opts);
    const second = await connections.importFromTool(bundle, opts);

    // A captured source is never overwritten — that is what makes raw/ trustworthy.
    expect(second.path).not.toBe(first.path);
    expect(second.path).toContain("-2.md");
    expect(await readFile(join(bundleRoot, first.path), "utf8")).toContain("取り込み対象。");
  }, SPAWN_TIMEOUT_MS);

  test("the capture is recorded in log.md", async () => {
    await connections.connect("external");
    await connections.importFromTool(bundle, {
      serverId: "external",
      tool: "read_agents_md",
      args: {},
      title: "記録テスト",
    });

    const log = await readFile(join(bundleRoot, "wiki", "log.md"), "utf8");
    expect(log).toContain("process:external");
    expect(log).toContain("raw/external/");
  }, SPAWN_TIMEOUT_MS);

  test("a failing remote tool is reported, not written", async () => {
    await connections.connect("external");

    let thrown: Error | null = null;
    try {
      await connections.importFromTool(bundle, {
        serverId: "external",
        tool: "no_such_tool",
        args: {},
      });
    } catch (error) {
      thrown = error as Error;
    }

    // The remote failure must surface, and nothing may be captured from it.
    expect(thrown?.message).toContain("no_such_tool");
    expect(await connections.status()).toHaveLength(1);
  }, SPAWN_TIMEOUT_MS);

  test("calling before connecting is refused clearly", async () => {
    await expect(connections.listTools("external")).rejects.toThrow(/接続していません/);
  }, SPAWN_TIMEOUT_MS);

  test("an unregistered server is named in the error", async () => {
    await expect(connections.connect("nope")).rejects.toThrow(/nope/);
  }, SPAWN_TIMEOUT_MS);

  test("disconnect releases the child process", async () => {
    await connections.connect("external");
    await connections.disconnect("external");

    const [status] = await connections.status();
    expect(status?.connected).toBe(false);
  }, SPAWN_TIMEOUT_MS);
});

describe("the raw/ layer contract", () => {
  let root: string;
  let bundle: Bundle;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okf-raw-test-"));
    await mkdir(join(root, "wiki"), { recursive: true });
    await mkdir(join(root, "raw"), { recursive: true });
    bundle = await Bundle.open(root);
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  test("import may create inside raw/", async () => {
    const { path } = await bundle.importToRaw("raw/notion/a.md", "内容");
    expect(path).toBe("raw/notion/a.md");
  });

  test("import refuses anywhere outside raw/", async () => {
    // The narrow capability must not become a general write hole.
    await expect(bundle.importToRaw("wiki/a.md", "x")).rejects.toThrow(/raw\//);
    await expect(bundle.importToRaw("AGENTS.md", "x")).rejects.toThrow(/raw\//);
  });

  test("import cannot escape the bundle", async () => {
    await expect(bundle.importToRaw("../escaped.md", "x")).rejects.toThrow();
  });

  test("an agent cannot edit a captured source", async () => {
    // The user may edit their own inbox; an agent may not rewrite the record
    // of what was actually received.
    await bundle.importToRaw("raw/a.md", "原本");
    await expect(bundle.writeFile("raw/a.md", "書き換え", { by: "agent" })).rejects.toThrow(
      /人間/
    );
    expect(await readFile(join(root, "raw", "a.md"), "utf8")).toBe("原本");
  });
});

describe("ready-made connections", () => {
  test("every preset names a runnable command and a distinct id", () => {
    const ids = SERVER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const preset of SERVER_PRESETS) {
      expect(preset.command).toBeTruthy();
      expect(preset.label).toBeTruthy();
      // Every one is a note explaining what the user still has to supply.
      expect(preset.note.length).toBeGreaterThan(10);
    }
  });

  test("no preset ships a credential", () => {
    // A template with a real token in it would be a trap, and a plausible
    // fake one would be worse.
    for (const preset of SERVER_PRESETS) {
      for (const value of Object.values(preset.env ?? {})) {
        expect(value).toBe("");
      }
    }
  });

  test("Obsidian imports read-only, and asks for the vault path", () => {
    const obsidian = SERVER_PRESETS.find((p) => p.id === "obsidian");
    expect(obsidian).toBeDefined();

    // `mcp-obsidian` reads and searches; `obsidian-mcp` also writes. Moving
    // notes *out* needs no writes, so the one that cannot touch the vault is
    // the right default.
    expect(obsidian!.args).toEqual(["-y", "mcp-obsidian", VAULT_PLACEHOLDER]);

    // The placeholder must be obviously unusable: a plausible default path
    // would fail as "no such directory" and read as a bug in this app.
    expect(VAULT_PLACEHOLDER).not.toMatch(/^[A-Za-z]:|^\//);
    expect(obsidian!.note).toContain(VAULT_PLACEHOLDER);
  });
});

/**
 * A credential the entry declares but has not been given.
 *
 * The Notion preset ships `NOTION_TOKEN: ""` to mean "paste yours here".
 * Connecting with it still empty used to succeed: npx downloaded the server,
 * the handshake completed, the panel said connected and listed 24 tools — and
 * every call came back as the service's own 401 JSON. From the user's side
 * that is "cannot connect to Notion", with nothing naming a token.
 */
describe("a server whose credential is still blank", () => {
  let sandbox: string;
  let connections: Connections;
  let originalAppData: string | undefined;
  let originalXdg: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "okf-creds-"));
    originalAppData = process.env.APPDATA;
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalHome = process.env.HOME;
    process.env.APPDATA = sandbox;
    process.env.XDG_CONFIG_HOME = sandbox;
    process.env.HOME = sandbox;

    await mkdir(dirname(registryPath()), { recursive: true });
    const notion = SERVER_PRESETS.find((p) => p.id === "notion")!;
    const { note: _note, ...entry } = notion;
    await saveServers([entry]);

    connections = new Connections();
    await connections.refresh();
  });

  afterEach(async () => {
    await connections.closeAll();
    process.env.APPDATA = originalAppData;
    process.env.XDG_CONFIG_HOME = originalXdg;
    process.env.HOME = originalHome;
    await removeTempDir(sandbox);
  });

  test("is reported before the user clicks connect", async () => {
    const [status] = await connections.status();

    expect(status?.connected).toBe(false);
    expect(status?.error).toContain("NOTION_TOKEN");
    // The fix is an edit to a file, so the message says which file.
    expect(status?.error).toContain(registryPath());
  });

  test("refuses to connect, naming the key", async () => {
    await expect(connections.connect("notion")).rejects.toThrow(/NOTION_TOKEN/);
  });

  test("fails fast rather than downloading the server first", async () => {
    const started = Date.now();
    await connections.connect("notion").catch(() => {});
    // npx fetching a package takes seconds; this must not get that far.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a filled-in credential is not treated as missing", async () => {
    const notion = SERVER_PRESETS.find((p) => p.id === "notion")!;
    const { note: _note, ...entry } = notion;
    await saveServers([{ ...entry, env: { NOTION_TOKEN: "ntn_something" } }]);
    await connections.refresh();

    const [status] = await connections.status();
    expect(status?.error).toBeUndefined();
  });

  test("a server that needs no credentials is unaffected", async () => {
    await saveServers([{ id: "plain", label: "Plain", command: "echo" }]);
    await connections.refresh();

    const [status] = await connections.status();
    expect(status?.error).toBeUndefined();
  });
});
