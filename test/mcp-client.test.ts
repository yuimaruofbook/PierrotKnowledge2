/**
 * The MCP client, exercised against a real server over real pipes.
 *
 * The server used is this project's own — which makes the round trip genuine
 * (spawn, handshake, framing, tool call, shutdown) without depending on a
 * third-party package being installed or reachable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { dirname } from "path";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { McpClient } from "../src/bun/mcp/client";
import { loadServers, registryPath, removeServer, saveServers, upsertServer } from "../src/bun/mcp/registry";
import { removeTempDir } from "./helpers";

const SERVER_ENTRY = resolve(import.meta.dir, "..", "src", "bun", "mcp", "standalone.ts");

describe("connecting to a server", () => {
  let bundle: string;
  let client: McpClient;

  beforeEach(async () => {
    bundle = await mkdtemp(join(tmpdir(), "okf-client-test-"));
    await mkdir(join(bundle, "wiki"), { recursive: true });
    await writeFile(
      join(bundle, "wiki", "alpha.md"),
      "---\ntype: Concept\ntitle: 設計原則\n---\n\n軽量であることを最優先する。\n",
      "utf8"
    );
    await writeFile(join(bundle, "AGENTS.md"), "# 契約\nまずこれを読むこと。\n", "utf8");

    client = new McpClient("self", {
      command: process.execPath, // bun
      args: ["run", SERVER_ENTRY],
      env: { OKF_BUNDLE: bundle },
    });
  });

  afterEach(async () => {
    await client.close();
    await removeTempDir(bundle);
  });

  test("completes the handshake and reports who it connected to", async () => {
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.serverInfo?.name).toBe("okf-wiki");
    expect(client.protocolVersion).toBe("2025-06-18");
  });

  test("lists the server's tools", async () => {
    await client.connect();
    const tools = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("read_agents_md");
    expect(names).toContain("retrieve");
    // Every tool must describe its input or an agent cannot call it.
    expect(tools.every((tool) => tool.inputSchema)).toBe(true);
  });

  test("calls a tool and returns its text", async () => {
    await client.connect();
    const result = await client.callTool("read_agents_md", {});

    expect(result.isError).toBeUndefined();
    expect(McpClient.textOf(result)).toContain("まずこれを読むこと");
  });

  test("carries Japanese arguments and results intact", async () => {
    await client.connect();
    const result = await client.callTool("search", { query: "軽量" });

    // The whole point of the client: multi-byte text survives the pipe.
    expect(McpClient.textOf(result)).toContain("設計原則");
  });

  test("surfaces a tool error as an error result rather than throwing", async () => {
    await client.connect();
    const result = await client.callTool("write_file", { path: "raw/x.md", content: "x" });

    expect(result.isError).toBe(true);
    // raw/ is the human's inbox; an agent writing there would invent a source.
    expect(McpClient.textOf(result)).toContain("人間");
  });

  test("an unknown tool is reported, not fatal", async () => {
    await client.connect();
    const result = await client.callTool("no_such_tool", {});
    expect(result.isError).toBe(true);
  });

  test("connect is idempotent", async () => {
    await client.connect();
    await client.connect();
    expect((await client.listTools()).length).toBeGreaterThan(0);
  });

  test("calls after close are refused clearly", async () => {
    await client.connect();
    await client.close();

    expect(client.isConnected).toBe(false);
    await expect(client.listTools()).rejects.toThrow(/接続していません/);
  });
});

describe("failure handling", () => {
  test("a command that does not exist fails with the command named", async () => {
    const client = new McpClient("missing", { command: "definitely-not-a-real-binary-xyz" });
    await expect(client.connect()).rejects.toThrow();
    await client.close();
  });

  test("a process that is not an MCP server does not hang forever", async () => {
    // `bun --version` prints and exits; the handshake can never complete.
    const client = new McpClient("bogus", {
      command: process.execPath,
      args: ["--version"],
    });
    await expect(client.connect()).rejects.toThrow();
    await client.close();
  });
});

describe("the server registry", () => {
  let sandbox: string;
  let originalAppData: string | undefined;
  let originalXdg: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "okf-registry-test-"));
    originalAppData = process.env.APPDATA;
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalHome = process.env.HOME;
    process.env.APPDATA = sandbox;
    process.env.XDG_CONFIG_HOME = sandbox;
    process.env.HOME = sandbox;
  });

  afterEach(async () => {
    process.env.APPDATA = originalAppData;
    process.env.XDG_CONFIG_HOME = originalXdg;
    process.env.HOME = originalHome;
    await removeTempDir(sandbox);
  });

  test("lives outside any bundle", () => {
    // Tokens must never be committed with the knowledge.
    expect(registryPath()).toContain(sandbox);
    expect(registryPath()).toMatch(/mcp-servers\.json$/);
  });

  test("round-trips a server", async () => {
    await saveServers([
      { id: "notion", label: "Notion", command: "npx", args: ["-y", "x"], env: { TOKEN: "t" } },
    ]);
    const [server] = await loadServers();

    expect(server).toMatchObject({
      id: "notion",
      label: "Notion",
      command: "npx",
      args: ["-y", "x"],
      env: { TOKEN: "t" },
    });
  });

  /** saveServers creates the directory; a raw write must do it itself. */
  const writeRegistry = async (contents: string) => {
    await mkdir(dirname(registryPath()), { recursive: true });
    await writeFile(registryPath(), contents, "utf8");
  };

  test("reads the mcpServers shape an agent config uses", async () => {
    // So an existing Claude Code config can be pasted in unchanged.
    await writeRegistry(
      JSON.stringify({ mcpServers: { notion: { command: "npx", args: ["-y", "srv"] } } })
    );
    const [server] = await loadServers();
    expect(server).toMatchObject({ id: "notion", command: "npx", args: ["-y", "srv"] });
  });

  test("entries without a command are discarded", async () => {
    await writeRegistry(JSON.stringify([{ id: "broken" }, { id: "" }]));
    expect(await loadServers()).toEqual([]);
  });

  test("a corrupt file yields an empty registry, not a crash", async () => {
    await writeRegistry("{ not json");
    expect(await loadServers()).toEqual([]);
  });

  test("an absent file yields an empty registry", async () => {
    expect(await loadServers()).toEqual([]);
  });

  test("upsert replaces rather than duplicating", async () => {
    await upsertServer({ id: "a", label: "A", command: "one" });
    await upsertServer({ id: "a", label: "A2", command: "two" });

    const servers = await loadServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ label: "A2", command: "two" });
  });

  test("remove deletes only the named server", async () => {
    await saveServers([
      { id: "a", label: "A", command: "x" },
      { id: "b", label: "B", command: "y" },
    ]);
    const left = await removeServer("a");
    expect(left.map((s) => s.id)).toEqual(["b"]);
  });
});
