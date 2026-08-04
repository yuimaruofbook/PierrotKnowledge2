/**
 * Drive the MCP server with a realistic agent workload and sample its memory.
 *
 * Idle numbers flatter a server: nothing is allocated until something is asked
 * of it. What matters operationally is what happens while an agent is actually
 * searching, retrieving and writing — and what the process settles back to
 * afterwards, because a server that never returns memory will not survive a
 * day of use.
 *
 * The mix below is what one ingest-and-answer cycle looks like through the
 * tools an agent really calls, taken from AGENTS.md's prescribed order.
 *
 *   bun run scripts/bench/workload.ts <bundle> [cycles] [--exe <path>]
 */

import { spawn } from "child_process";
import { resolve } from "path";

const args = process.argv.slice(2);
const bundle = args[0];
const cycles = Number(args[1] ?? 20);
const exeFlag = args.indexOf("--exe");
const exe = exeFlag === -1 ? null : args[exeFlag + 1];

if (!bundle) {
  console.error("usage: workload.ts <bundle> [cycles] [--exe <compiled>]");
  process.exit(2);
}

const child = exe
  ? spawn(exe, [], { env: { ...process.env, OKF_BUNDLE: resolve(bundle) }, stdio: ["pipe", "pipe", "pipe"] })
  : spawn("bun", ["run", resolve(import.meta.dir, "../../src/bun/mcp/standalone.ts")], {
      env: { ...process.env, OKF_BUNDLE: resolve(bundle) },
      stdio: ["pipe", "pipe", "pipe"],
    });

let buffer = "";
let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();

child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  let nl = buffer.indexOf("\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\n");
    if (!line) continue;
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown };
      if (typeof message.id === "number") pending.get(message.id)?.(message.result);
    } catch {
      // Servers that log to stdout are not fatal here.
    }
  }
});

function call(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((done) => {
    pending.set(id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const tool = (name: string, args: Record<string, unknown> = {}) =>
  call("tools/call", { name, arguments: args });

/** Resident set of the server process, via the OS rather than self-report. */
async function rssMb(): Promise<number> {
  const proc = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      // Silent when the process has already exited: the sampler races the
      // shutdown at the end of a run, and an error there is noise, not data.
      `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).WorkingSet64`,
    ],
    { stdout: "pipe", stderr: "ignore" }
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if (!out) return 0;
  return Math.round((Number(out) / 1024 / 1024) * 10) / 10;
}

const samples: number[] = [];
const sampler = setInterval(() => void rssMb().then((mb) => { if (mb > 0) samples.push(mb); }), 400);

await call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "bench", version: "1" },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const afterStart = await rssMb();

const QUERIES = [
  "設計原則について教えて",
  "取り込み手順はどうなっている",
  "日本語検索の仕組み",
  "レイヤー分離の根拠",
  "出典管理の方法",
];

const started = Date.now();

for (let n = 0; n < cycles; n++) {
  // The order AGENTS.md prescribes: contract, loop, skill, then work.
  await tool("read_agents_md");
  await tool("loop_start", { goal: `ベンチ実行 ${n}`, name: "bench-loop", actor: "process:bench" });
  await tool("skill_find", { task: QUERIES[n % QUERIES.length] as string });
  await tool("skill_open", { name: "okf-ingest" });

  // Retrieval is the expensive path: it assembles passages under a budget.
  for (const query of QUERIES) {
    await tool("retrieve", { query, limit: 8, budget_chars: 6000 });
    await tool("search", { query, limit: 20 });
  }

  await tool("list_concepts");
  await tool("unresolved_links");
  await tool("read_file", { path: "wiki/section-00/note-0000.md" });

  await tool("create_concept", {
    path: `wiki/bench/generated-${n}.md`,
    type: "Concept",
    title: `生成 ${n}`,
    body: "ベンチマークで生成された概念です。\n\n[[note-0001]] を参照。",
  });

  await tool("loop_end", { outcome: `cycle ${n} 完了` });

  if (n % 5 === 4) await tool("rebuild_index");
}

const elapsed = (Date.now() - started) / 1000;
const underLoad = samples.length ? Math.max(...samples) : afterStart;

// Let it idle, so we can see whether memory is returned or merely grows.
await Bun.sleep(8000);
const afterIdle = await rssMb();

clearInterval(sampler);
child.kill();

const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;

console.log(
  JSON.stringify(
    {
      mode: exe ? "compiled binary" : "bun run",
      cycles,
      toolCalls: nextId - 1,
      seconds: Math.round(elapsed * 10) / 10,
      callsPerSecond: Math.round(((nextId - 1) / elapsed) * 10) / 10,
      rssMb: {
        afterStartup: afterStart,
        meanUnderLoad: Math.round(mean * 10) / 10,
        peak: underLoad,
        afterIdle,
      },
    },
    null,
    2
  )
);
