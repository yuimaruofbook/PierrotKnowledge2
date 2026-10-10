/**
 * The Rust headless server answers exactly as the TypeScript one does.
 *
 * Agents only ever see the MCP surface, so that is what is compared: the same
 * script of calls goes to both servers over stdio, each against its own copy
 * of the same bundle, and every response must match once the parts that differ
 * by nature — the temp folder's path, clocks — are masked.
 *
 * Skipped when the Rust binary has not been built (`cargo build --release
 * --manifest-path rust/Cargo.toml`), or point `OKF_RUST_MCP` at one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { removeTempDir } from "./helpers";

const RUST_BINARY =
  process.env.OKF_RUST_MCP ??
  resolve("rust", "target", "release", process.platform === "win32" ? "okf-mcp.exe" : "okf-mcp");
const TS_SERVER = resolve("src", "bun", "mcp", "standalone.ts");

/** The calls both servers receive, in order. Writes come before the reads that would see them. */
const SCRIPT: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["bundle_info", {}],
  ["read_map", {}],
  ["read_agents_md", {}],
  ["read_human", {}],
  ["list_files", {}],
  ["list_files", { path: "wiki", recursive: true }],
  ["list_concepts", {}],
  ["list_tags", {}],
  ["search", { query: "知識" }],
  ["search", { query: "alpha", limit: 3 }],
  ["retrieve", { query: "日本語の検索" }],
  ["context_pack", { task: "Alpha について調べる" }],
  ["read_file", { path: "wiki/alpha.md" }],
  ["read_file", { path: "wiki/missing.md" }],
  ["backlinks", { id: "alpha" }],
  ["unresolved_links", {}],
  ["check_conformance", {}],
  ["create_concept", {
    path: "wiki/beta.md",
    type: "Concept",
    title: "Beta",
    description: "二つ目の概念",
    tags: ["parity", "テスト"],
    body: "[[alpha]] を参照する。",
    actor: "process:parity",
  }],
  ["write_file", { path: "wiki/gamma.md", content: "---\ntype: Entity\ntitle: Gamma\n---\n\n# Gamma\n\n[[beta]] と [[nowhere]]\n" }],
  ["write_file", { path: "raw/forbidden.md", content: "x" }],
  ["backlinks", { id: "beta" }],
  ["unresolved_links", {}],
  ["set_para", { path: "wiki/beta.md", para: "project" }],
  ["list_para", {}],
  ["list_para", { para: "project" }],
  ["move_file", { from: "wiki/gamma.md", to: "wiki/topic/gamma.md", actor: "process:parity" }],
  ["create_directory", { path: "wiki/empty" }],
  ["delete_file", { path: "wiki/topic/gamma.md", actor: "process:parity" }],
  ["add_task", { title: "パリティを確かめる", status: "doing", para: "project", due: "2026-12-31", note: "一行" }],
  ["add_task", { title: "second" }],
  ["update_task", { id: "T-0001", status: "done" }],
  ["update_task", { id: "T-9999", status: "done" }],
  ["list_tasks", {}],
  ["daily_note", { date: "2026-08-04" }],
  ["collect_daily_tasks", { date: "2026-08-04" }],
  ["skill_list", {}],
  ["skill_find", { task: "週次の点検をしたい" }],
  ["skill_open", { name: "nope" }],
  ["loop_list", {}],
  ["loop_define", { goal: "Keep the wiki tidy every week", name: "tidy" }],
  ["loop_start", { name: "tidy", actor: "process:parity" }],
  ["loop_note", { detail: "looked at alpha" }],
  ["loop_end", { outcome: "done for now" }],
  ["loop_read", { name: "tidy" }],
  ["audit_changes", {}],
  ["rebuild_index", {}],
  ["rebuild_rag", {}],
  ["search", { query: "Beta", tags: ["parity"] }],
  ["no_such_tool", {}],
];

/**
 * Error paths, argument coercion and every tool's less-travelled branches.
 * Runs after SCRIPT against the state it left. `<BUNDLE>` stands for each
 * server's own bundle path.
 */
const SCRIPT_MORE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["write_human", { content: "" }],
  ["write_human", { content: "   " }],
  ["write_human", { content: "# 私\n\n短く話す。\n" }],
  ["read_human", {}],
  ["list_tasks", { status: "bogus" }],
  ["list_tasks", { status: "done" }],
  ["list_tasks", { status: "doing" }],
  ["list_tasks", { status: null }],
  ["add_task", { title: "" }],
  ["add_task", { title: "x", status: "weird" }],
  ["add_task", { title: "x", para: "nope" }],
  ["add_task", { title: "  padded  ", due: "2026-09-01", note: 5 }],
  ["update_task", {}],
  ["update_task", { id: "T-0002", title: "renamed", para: "area", note: "n", due: "2026-10-01", status: "doing" }],
  ["update_task", { id: "T-0001", status: "todo" }],
  ["update_task", { id: "T-0002", para: "zzz" }],
  ["update_task", { id: "T-0002", status: "bad" }],
  ["list_tasks", {}],
  ["list_tasks", { status: "done" }],
  ["daily_note", {}],
  ["daily_note", { date: "2026-02-30" }],
  ["daily_note", { date: "yesterday" }],
  ["daily_note", { date: "0026-01-01" }],
  ["collect_daily_tasks", { date: "bad" }],
  ["collect_daily_tasks", { date: "2031-01-01" }],
  ["write_file", { path: "wiki/daily/2026-09-09.md", content: "---\ntype: Daily\ntitle: d\n---\n\n## タスク\n\n- [ ] one\n  - [ ] nested\n- [x] finished\n- [ ]\n- [ ] two\n\n## 他\n\n- [ ] not a task\n" }],
  ["collect_daily_tasks", { date: "2026-09-09" }],
  ["collect_daily_tasks", { date: "2026-09-09" }],
  ["read_file", { path: "wiki/daily/2026-09-09.md" }],
  ["list_tasks", {}],
  ["retrieve", {}],
  ["retrieve", { query: "alpha", limit: 2, budget_chars: 200, expand_neighbours: true, type: "Concept", tags: ["parity"], path_prefix: "wiki/" }],
  ["retrieve", { query: "zzzzqqq" }],
  ["context_pack", {}],
  ["context_pack", { task: "x", tier: "bogus" }],
  ["context_pack", { task: "Alpha を調べる", tier: "worker" }],
  ["context_pack", { task: "Alpha を調べる", tier: "supervisor", budget_chars: 500, limit: 2 }],
  ["context_pack", { task: "zzzzqqq" }],
  ["search", {}],
  ["search", { query: "zzzzqqq" }],
  ["search", { query: "alpha", type: "Concept", path_prefix: "wiki/", limit: 1 }],
  ["list_files", { path: "../" }],
  ["list_files", { path: "nope" }],
  ["list_files", { recursive: true }],
  ["list_files", { path: "wiki", recursive: "yes" }],
  ["read_file", {}],
  ["read_file", { path: "wiki/log.md" }],
  ["read_file", { path: "wiki/index.md" }],
  ["read_file", { path: "../outside.md" }],
  ["write_file", {}],
  ["write_file", { path: "wiki/delta.md", content: "no frontmatter" }],
  ["write_file", { path: "wiki/eps.md", content: "---\ntype: Concept\ngenerated:\n  by: h\n---\n\nbody" }],
  ["write_file", { path: "wiki/n.md", content: "---\ntype: Concept\n---\nx", note: "hello", actor: "process:x" }],
  ["write_file", { path: "wiki/skills/zz/SKILL.md", content: "---\nname: zz\ndescription: zz skill\n---\nbody" }],
  ["write_file", { path: "wiki/index.md", content: "# not allowed?" }],
  ["list_concepts", {}],
  ["check_conformance", {}],
  ["create_concept", {}],
  ["create_concept", { path: "a.md" }],
  ["create_concept", { path: "x.txt", type: "Concept" }],
  ["create_concept", { path: "wiki/1-projects/proj.md", type: "Project" }],
  ["list_concepts", {}],
  ["check_conformance", {}],
  ["backlinks", {}],
  ["backlinks", { id: "nope" }],
  ["move_file", {}],
  ["move_file", { from: "raw/x.md", to: "wiki/x.md" }],
  ["move_file", { from: "wiki/nope.md", to: "wiki/b.md" }],
  ["move_file", { from: "wiki/alpha.md", to: "wiki/2-areas/alpha.md" }],
  ["move_file", { from: "wiki/n.md", to: "wiki/n.md" }],
  ["delete_file", {}],
  ["delete_file", { path: "wiki/index.md" }],
  ["delete_file", { path: "wiki/nope.md" }],
  ["delete_file", { path: "wiki/2-areas/alpha.md" }],
  ["create_directory", {}],
  ["create_directory", { path: "raw/x" }],
  ["set_para", {}],
  ["set_para", { path: "wiki/beta.md", para: "bogus" }],
  ["set_para", { path: "wiki/beta.md", para: "archive" }],
  ["set_para", { path: "wiki/missing.md", para: "area" }],
  ["list_para", { para: "bogus" }],
  ["list_para", {}],
  ["audit_changes", { since: "bad" }],
  ["audit_changes", { since: "2020-01-01", actor: "process:" }],
  ["audit_changes", { actor: "nobody" }],
  ["skill_find", {}],
  ["skill_find", { task: "ingest notes into the wiki", limit: 1 }],
  ["skill_find", { task: "zzzz" }],
  ["skill_list", {}],
  ["skill_open", {}],
  ["skill_open", { name: "okf-ingest" }],
  ["skill_read", { name: "okf-ingest", path: "reference.md" }],
  ["skill_read", { name: "okf-ingest", path: "../../AGENTS.md" }],
  ["skill_read", { name: "okf-ingest", path: "nope.md" }],
  ["skill_read", {}],
  ["list_concepts", {}],
  ["check_conformance", {}],
  ["loop_note", { detail: "nothing running" }],
  ["loop_end", {}],
  ["loop_start", {}],
  ["loop_start", { name: "ghost" }],
  ["loop_define", { goal: "Ingest new meeting notes into the wiki" }],
  ["list_concepts", {}],
  ["check_conformance", {}],
  ["loop_start", { goal: "Ingest new meeting notes into the wiki" }],
  ["loop_start", { name: "tidy" }],
  ["write_file", { path: "wiki/journaled.md", content: "---\ntype: Concept\n---\nj" }],
  ["move_file", { from: "wiki/journaled.md", to: "wiki/journaled2.md" }],
  ["delete_file", { path: "wiki/journaled2.md" }],
  ["loop_note", {}],
  ["loop_note", { detail: "d", action: "decide" }],
  ["loop_define", { goal: "x", name: "Bad Name" }],
  ["loop_define", {}],
  ["loop_define", { goal: "Check things", name: "checker", skill: "wiki-lint", checks: ["one", "two", 3] }],
  ["write_file", { path: "wiki/broken.md", content: "no frontmatter at all" }],
  ["loop_end", { outcome: "regressed on purpose" }],
  ["loop_list", {}],
  ["loop_read", { name: "ingest-new-meeting-notes-into-the-wiki" }],
  ["loop_read", {}],
  ["loop_read", { name: "nope" }],
  ["loop_start", { name: "checker", actor: "process:parity" }],
  ["loop_end", { status: "abandoned" }],
  ["loop_read", { name: "checker" }],
  ["rebuild_index", {}],
  ["read_file", { path: "wiki/index.md" }],
  ["open_bundle", {}],
  ["open_bundle", { path: "<BUNDLE>" }],
  ["bundle_info", {}],
  ["list_concepts", {}],
  ["open_bundle", { path: "<BUNDLE>/nope" }],
  ["bundle_info", {}],
  ["read_map", {}],
  ["search", { query: "alpha" }],
  ["loop_list", {}],
  ["skill_list", {}],
  ["list_tasks", {}],
  ["context_pack", { task: "x" }],
];

/** Replace `<BUNDLE>` in string arguments with this server's bundle path. */
function withBundle<T>(value: T, bundle: string): T {
  return JSON.parse(JSON.stringify(value).split("<BUNDLE>").join(JSON.stringify(bundle).slice(1, -1)));
}

async function makeBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okf-parity-"));
  await scaffoldBundle(root);
  await writeFile(
    join(root, "wiki", "alpha.md"),
    "---\ntype: Concept\ntitle: Alpha\ndescription: 最初の概念\ntags: [parity]\n---\n\n# Alpha\n\n日本語の検索ができる知識。\n\n## 詳細\n\nalpha の詳しい説明。\n",
    "utf8"
  );
  return root;
}

/** One server over stdio, answering requests in order. */
class StdioClient {
  private buffer = "";
  private waiting: Array<(line: string) => void> = [];
  private lines: string[] = [];
  private nextId = 1;

  constructor(private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const waiter = this.waiting.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    }
  }

  private next(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolveLine) => this.waiting.push(resolveLine));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await this.proc.stdin.flush();
    return JSON.parse(await this.next());
  }

  /** Send a line as is and read one response. */
  async raw(line: string): Promise<unknown> {
    this.proc.stdin.write(`${line}\n`);
    await this.proc.stdin.flush();
    return JSON.parse(await this.next());
  }

  /** Send a line that must not be answered. */
  notifyRaw(line: string): void {
    this.proc.stdin.write(`${line}\n`);
  }

  notify(method: string): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async close(): Promise<void> {
    await this.proc.stdin.end();
    this.proc.kill();
    await this.proc.exited;
  }
}

function spawnServer(command: string[], bundle: string): StdioClient {
  return new StdioClient(
    Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OKF_BUNDLE: bundle },
    })
  );
}

/** Mask what differs between two honest runs: where the bundle is, and when. */
function normalize(value: unknown, bundle: string): string {
  const forward = bundle.replace(/\\/g, "/");
  const escapedBack = JSON.stringify(bundle).slice(1, -1);
  return JSON.stringify(value, null, 2)
    .split(escapedBack).join("<BUNDLE>")
    .split(forward).join("<BUNDLE>")
    .replace(/okf-parity-[A-Za-z0-9]+/g, "<TMP>")
    .replace(/(\\"at\\": \\")\d{2}:\d{2}:\d{2}/g, "$1<CLOCK>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TIME>")
    .replace(/("\w*(?:mtime|Mtime|At|Ms|ms|elapsed|duration)\w*":\s*)\d+(\.\d+)?/g, "$1<N>")
    .replace(/(\\"\w*(?:mtime|Mtime|At|Ms|ms|elapsed|duration)\w*\\":\s*)\d+(\.\d+)?/g, "$1<N>");
}

const ready = existsSync(RUST_BINARY);
if (!ready) console.log(`  (Rust MCP binary not built at ${RUST_BINARY} — parity test skipped)`);

describe.skipIf(!ready)("Rust headless server parity", () => {
  let tsBundle: string;
  let rustBundle: string;
  let ts: StdioClient;
  let rust: StdioClient;

  beforeAll(async () => {
    tsBundle = await makeBundle();
    rustBundle = await makeBundle();
    ts = spawnServer([process.execPath, "run", TS_SERVER], tsBundle);
    rust = spawnServer([RUST_BINARY], rustBundle);
    const init = {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "parity", version: "0" },
    };
    await ts.request("initialize", init);
    await rust.request("initialize", init);
    ts.notify("notifications/initialized");
    rust.notify("notifications/initialized");
  });

  afterAll(async () => {
    await ts?.close();
    await rust?.close();
    await removeTempDir(tsBundle);
    await removeTempDir(rustBundle);
  });

  test("initialize negotiates the same protocol for every version a client may ask", async () => {
    for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "1999-01-01"]) {
      const params = { protocolVersion, capabilities: {}, clientInfo: { name: "p", version: "0" } };
      expect(normalize(await rust.request("initialize", params), rustBundle)).toBe(
        normalize(await ts.request("initialize", params), tsBundle)
      );
    }
  });

  test("tools/list is identical", async () => {
    expect(normalize(await rust.request("tools/list", {}), rustBundle)).toBe(
      normalize(await ts.request("tools/list", {}), tsBundle)
    );
  });

  test("unknown methods fail the same way", async () => {
    expect(normalize(await rust.request("nope/nope", {}), rustBundle)).toBe(
      normalize(await ts.request("nope/nope", {}), tsBundle)
    );
  });

  test("every scripted tool call answers identically", async () => {
    let calls = 0;
    for (const [name, args] of [...SCRIPT, ...SCRIPT_MORE]) {
      const expected = normalize(
        await ts.request("tools/call", { name, arguments: withBundle(args, tsBundle) }),
        tsBundle
      );
      const actual = normalize(
        await rust.request("tools/call", { name, arguments: withBundle(args, rustBundle) }),
        rustBundle
      );
      expect(`${name} ${JSON.stringify(args)}\n${actual}`).toBe(
        `${name} ${JSON.stringify(args)}\n${expected}`
      );
      calls += 1;
      // The TS watcher indexes a loop file as a concept whenever it happens to
      // see one change (its refresh forgets that loops/ is not knowledge), and
      // whether it does depends on the platform's rename events. The Rust
      // server leaves loops/ out, as the layer contract says. Wait out the
      // debounce, then reload both from disk so that quirk cannot decide what
      // the next call sees.
      if (/^loop_(define|start|note|end)$/.test(name)) {
        await Bun.sleep(400);
        await ts.request("tools/call", { name: "rebuild_rag", arguments: {} });
        await rust.request("tools/call", { name: "rebuild_rag", arguments: {} });
      }
    }
    expect(calls).toBeGreaterThan(150);
  }, 120_000);

  test("malformed and unusual JSON-RPC messages are handled the same", async () => {
    const lines = [
      "not json",
      '{"jsonrpc":"2.0","id":7}',
      '{"jsonrpc":"2.0","id":8,"method":42}',
      '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{}}',
      '{"jsonrpc":"2.0","id":"str-id","method":"ping"}',
      '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"read_map","arguments":[1]}}',
      '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"read_map","arguments":null}}',
      '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":5}}',
      '{"jsonrpc":"2.0","id":13,"method":"initialize"}',
      '{"jsonrpc":"2.0","id":14,"method":"initialize","params":{"protocolVersion":7}}',
      '{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}',
      '{"jsonrpc":"2.0","id":1.5,"method":"ping"}',
      '{"jsonrpc":"2.0","id":0,"method":"ping"}',
      '  {"jsonrpc":"2.0","id":15,"method":"tools/list"}  ',
    ];
    for (const line of lines) {
      expect(normalize(await rust.raw(line), rustBundle)).toBe(normalize(await ts.raw(line), tsBundle));
    }

    // These draw no response at all; the ping that follows proves nothing extra was written.
    for (const silent of [
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":null,"method":"ping"}',
      '{"jsonrpc":"2.0","id":null}',
      "[1,2]",
      "42",
      "",
      '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"bundle_info"}}',
    ]) {
      rust.notifyRaw(silent);
      ts.notifyRaw(silent);
      const ping = '{"jsonrpc":"2.0","id":"after","method":"ping"}';
      expect(normalize(await rust.raw(ping), rustBundle)).toBe(normalize(await ts.raw(ping), tsBundle));
    }
  });

  test("edits made outside the server are picked up by the watcher", async () => {
    await ts.request("tools/call", { name: "open_bundle", arguments: { path: tsBundle } });
    await rust.request("tools/call", { name: "open_bundle", arguments: { path: rustBundle } });
    const seen = async (query: string) => [
      normalize(await ts.request("tools/call", { name: "search", arguments: { query } }), tsBundle),
      normalize(await rust.request("tools/call", { name: "search", arguments: { query } }), rustBundle),
    ];
    const externalNote = (word: string) =>
      `---\ntype: Concept\ntitle: External\n---\n\n# External\n\n${word} swims here.\n`;

    for (const bundle of [tsBundle, rustBundle]) {
      await writeFile(join(bundle, "wiki", "external.md"), externalNote("zebrafish"), "utf8");
    }
    await Bun.sleep(900);
    const [tsFound, rustFound] = await seen("zebrafish");
    expect(tsFound).toContain("external");
    expect(rustFound).toBe(tsFound);

    for (const bundle of [tsBundle, rustBundle]) {
      await writeFile(join(bundle, "wiki", "external.md"), externalNote("narwhal"), "utf8");
    }
    await Bun.sleep(900);
    const [tsOld, rustOld] = await seen("zebrafish");
    expect(rustOld).toBe(tsOld);
    const [tsNarwhal, rustNarwhal] = await seen("narwhal");
    expect(tsNarwhal).toContain("external");
    expect(rustNarwhal).toBe(tsNarwhal);

    for (const bundle of [tsBundle, rustBundle]) await rm(join(bundle, "wiki", "external.md"));
    await Bun.sleep(900);
    const [tsGone, rustGone] = await seen("narwhal");
    expect(tsGone).toContain("No matches");
    expect(rustGone).toBe(tsGone);
  }, 30_000);
});
