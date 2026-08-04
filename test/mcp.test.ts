/**
 * MCP protocol conformance.
 *
 * The transport is the part most easily got wrong in a way no unit test of the
 * tools would catch: a server that frames responses incorrectly, or answers a
 * notification, looks fine locally and is unusable from a real client.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { messages } from "../src/shared/messages";
import { removeTempDir } from "./helpers";
import { tmpdir } from "os";
import { join } from "path";
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  handleMessage,
  negotiateProtocol,
  runStdioServer,
} from "../src/bun/mcp/stdio";
import { TOOLS, callTool } from "../src/bun/mcp/tools";
import { Workspace } from "../src/bun/workspace";

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-mcp-test-"));
  await mkdir(join(root, "wiki"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "# Agent contract\nRead me first.\n", "utf8");
  await writeFile(
    join(root, "wiki", "alpha.md"),
    "---\ntype: Concept\ntitle: Alpha\n---\n\nsearchable-token here\n",
    "utf8"
  );
  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("JSON-RPC envelope", () => {
  test("initialize advertises tools and echoes a supported protocol", async () => {
    const response = await handleMessage(workspace, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
    });
  });

  test("negotiation falls back to our newest version", () => {
    expect(negotiateProtocol("1999-01-01")).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateProtocol(undefined)).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateProtocol("2024-11-05")).toBe("2024-11-05");
  });

  test("notifications are never answered", async () => {
    expect(
      await handleMessage(workspace, { jsonrpc: "2.0", method: "notifications/initialized" })
    ).toBeNull();
    expect(await handleMessage(workspace, { jsonrpc: "2.0", method: "ping" })).toBeNull();
  });

  test("ping with an id is answered", async () => {
    const response = await handleMessage(workspace, { jsonrpc: "2.0", id: 7, method: "ping" });
    expect(response).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  test("an unknown method is a JSON-RPC error, not a crash", async () => {
    const response = await handleMessage(workspace, { jsonrpc: "2.0", id: 2, method: "nope" });
    expect(response).toMatchObject({ id: 2, error: { code: -32601 } });
  });

  test("tools/list returns schemas for every tool", async () => {
    const response = (await handleMessage(workspace, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    })) as { result: { tools: typeof TOOLS } };

    expect(response.result.tools).toHaveLength(TOOLS.length);
    for (const tool of response.result.tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

describe("stdio framing", () => {
  test("emits one JSON object per line and no headers", async () => {
    const lines: string[] = [];
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];

    // Deliberately split mid-message: a real client's writes do not align to
    // message boundaries, and a naive reader drops or corrupts the split one.
    const payload = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const midpoint = Math.floor(payload.length / 2);
    const encoder = new TextEncoder();
    const input = (async function* () {
      yield encoder.encode(payload.slice(0, midpoint));
      yield encoder.encode(payload.slice(midpoint));
    })();

    await runStdioServer(workspace, { input, write: (line) => lines.push(line) });

    expect(lines).toHaveLength(2); // the notification is not answered
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(line).not.toContain("Content-Length");
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line.trimEnd()).not.toContain("\n");
    }
  });

  test("a malformed line yields a parse error and the stream continues", async () => {
    const lines: string[] = [];
    const encoder = new TextEncoder();
    const input = (async function* () {
      yield encoder.encode(`not json\n${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`);
    })();

    await runStdioServer(workspace, { input, write: (line) => lines.push(line) });

    expect(JSON.parse(lines[0]!)).toMatchObject({ error: { code: -32700 } });
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 9 });
  });
});

describe("tools", () => {
  const textOf = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

  test("read_agents_md returns the contract", async () => {
    const result = await callTool(workspace, "read_agents_md", {});
    expect(textOf(result)).toContain("Read me first");
  });

  test("read_agents_md explains the defaults when the file is missing", async () => {
    await rm(join(root, "wiki", "AGENTS.md"));
    const result = await callTool(workspace, "read_agents_md", {});
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("OKF v0.2 defaults");
  });

  test("search finds a concept", async () => {
    const result = await callTool(workspace, "search", { query: "searchable-token" });
    expect(textOf(result)).toContain("alpha");
  });

  test("search reports no matches as text, not an error", async () => {
    const result = await callTool(workspace, "search", { query: "zzzznotpresent" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("No matches");
  });

  test("create_concept produces a conformant file", async () => {
    const result = await callTool(workspace, "create_concept", {
      path: "wiki/new-page.md",
      type: "Playbook",
      title: "New Page",
      actor: "process:test",
    });
    expect(result.isError).toBeUndefined();

    const read = await workspace.readFile("wiki/new-page.md");
    expect(read.concept?.frontmatter.type).toBe("Playbook");
    expect(read.concept?.frontmatter.generated).toMatchObject({ by: "process:test" });
    expect(workspace.conformanceIssues()).toEqual([]);
  });

  test("create_concept rejects an empty type", async () => {
    const result = await callTool(workspace, "create_concept", { path: "wiki/x.md", type: "" });
    expect(result.isError).toBe(true);
  });

  test("write_file into raw/ is refused with an explanation", async () => {
    // raw/ is the human's inbox. An agent writing there would be inventing a
    // source, so the refusal says whose job it is rather than just "denied".
    const result = await callTool(workspace, "write_file", {
      path: "raw/thing.md",
      content: "x",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("人間");
  });

  test("write_file cannot escape the bundle", async () => {
    const result = await callTool(workspace, "write_file", {
      path: "../../escaped.md",
      content: "x",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("バンドルの外");
  });

  test("write_file surfaces conformance warnings", async () => {
    const result = await callTool(workspace, "write_file", {
      path: "wiki/loose.md",
      content: "# no frontmatter",
    });
    expect(textOf(result)).toContain("OKF warnings");
  });

  test("check_conformance reports offenders", async () => {
    await workspace.writeFile("wiki/loose.md", "# no frontmatter");
    const result = await callTool(workspace, "check_conformance", {});
    expect(textOf(result)).toContain("wiki/loose.md");
  });

  test("an unknown tool is an error result, not a throw", async () => {
    const result = await callTool(workspace, "does_not_exist", {});
    expect(result.isError).toBe(true);
  });

  test("tools operate without a bundle instead of crashing", async () => {
    const empty = new Workspace({ watch: false });
    const result = await callTool(empty, "search", { query: "x" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(messages.noBundleOpen);
  });
});
