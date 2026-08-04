/**
 * The built-in agent loop.
 *
 * The loop's mechanics are tested against a stub server so they run anywhere
 * and deterministically. There is also one test against a real Ollama, skipped
 * when none is running — the protocol details that bite (tool_call ordering,
 * the shape a thinking model returns) are exactly the ones a stub would get
 * wrong in the same way the implementation does.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalAgent, toChatTools, truncateResult, LOCAL_AGENT_TOOLS } from "../src/bun/agent/loop";
import { OpenAiCompatClient } from "../src/bun/agent/openai";
import { Workspace } from "../src/bun/workspace";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

/** Canned responses, served in order, recording what was sent. */
function stubServer(turns: unknown[]) {
  const received: Array<Record<string, unknown>> = [];
  let index = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "stub-model" }] });
      }
      received.push((await request.json()) as Record<string, unknown>);
      const turn = turns[Math.min(index++, turns.length - 1)];
      return Response.json(turn);
    },
  });

  return { server, received, url: `http://localhost:${server.port}/v1` };
}

const assistant = (content: string, toolCalls?: unknown[]) => ({
  choices: [
    {
      message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls ? "tool_calls" : "stop",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-agent-test-"));
  await mkdir(join(root, "wiki"), { recursive: true });
  await mkdir(join(root, "wiki", "skills", "okf-ingest"), { recursive: true });

  await writeFile(
    join(root, "wiki", "skills", "okf-ingest", "SKILL.md"),
    [
      "---",
      "name: okf-ingest",
      "description: raw/ の資料を wiki/ に取り込む手順。議事録やエクスポートを扱うとき。",
      "when: [取り込み, ingest, 議事録]",
      "---",
      "",
      "# 手順",
      "",
      "1. search で重複を確認する",
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    join(root, "wiki", "design.md"),
    "---\ntype: Concept\ntitle: 設計原則\n---\n\n# 設計原則\n\nローカルの Markdown が正本。\n",
    "utf8"
  );

  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("tool schemas offered to a local model", () => {
  test("only the curated subset is exposed", () => {
    const tools = toChatTools(LOCAL_AGENT_TOOLS);

    expect(tools.map((t) => t.function.name)).toEqual([...LOCAL_AGENT_TOOLS]);
    // A local model degrades as the list grows, so the full surface is not sent.
    expect(tools.length).toBeLessThan(12);
  });

  test("skill_find comes first, because order sways smaller models", () => {
    expect(toChatTools(LOCAL_AGENT_TOOLS)[0]?.function.name).toBe("skill_find");
  });

  test("descriptions are trimmed to their first sentence", () => {
    const find = toChatTools(["skill_find"])[0];

    expect(find?.function.description.length).toBeLessThan(120);
    expect(find?.function.description).toContain("skill");
  });

  test("unknown names are skipped rather than throwing", () => {
    expect(toChatTools(["no-such-tool", "search"]).map((t) => t.function.name)).toEqual(["search"]);
  });
});

describe("truncating tool results", () => {
  test("short results pass through untouched", () => {
    expect(truncateResult("short", 100)).toBe("short");
  });

  test("long results keep both ends", () => {
    // Retrieval puts its citations at the end; cutting the tail loses them.
    const text = `START${"x".repeat(500)}END`;
    const cut = truncateResult(text, 100);

    expect(cut).toStartWith("START");
    expect(cut).toEndWith("END");
    expect(cut).toContain("省略");
    expect(cut.length).toBeLessThan(text.length);
  });
});

describe("the loop", () => {
  test("executes a tool call and feeds the result back", async () => {
    const { server, received, url } = stubServer([
      assistant("", [call("c1", "skill_find", { task: "議事録を取り込む" })]),
      assistant("okf-ingest を使ってください。"),
    ]);

    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");
    const result = await agent.run({ task: "議事録を取り込みたい", model: "stub-model" });

    expect(result.answer).toContain("okf-ingest");
    expect(result.steps[0]?.name).toBe("skill_find");
    expect(result.steps[0]?.result).toContain("okf-ingest");
    expect(result.stopReason).toBe("done");

    // The second request must carry the assistant turn and then the tool result.
    const second = received[1] as { messages: Array<{ role: string; tool_call_id?: string }> };
    const roles = second.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(second.messages[3]?.tool_call_id).toBe("c1");

    server.stop(true);
  });

  test("no skill body is sent until the model asks for one", async () => {
    const { server, received, url } = stubServer([
      assistant("", [call("c1", "skill_find", { task: "取り込み" })]),
      assistant("わかりました。"),
    ]);

    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");
    await agent.run({ task: "取り込みたい", model: "stub-model" });

    // This is the whole economic claim: skill_find's answer contains no procedure.
    expect(JSON.stringify(received)).not.toContain("search で重複を確認する");

    server.stop(true);
  });

  test("skill_open is what brings the procedure in", async () => {
    const { server, received, url } = stubServer([
      assistant("", [call("c1", "skill_open", { name: "okf-ingest" })]),
      assistant("手順に従います。"),
    ]);

    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");
    await agent.run({ task: "取り込みたい", model: "stub-model" });

    expect(JSON.stringify(received)).toContain("search で重複を確認する");

    server.stop(true);
  });

  test("a failing tool is reported to the model, not thrown", async () => {
    const { server, url } = stubServer([
      assistant("", [call("c1", "skill_open", { name: "does-not-exist" })]),
      assistant("そのスキルはありませんでした。"),
    ]);

    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");
    const result = await agent.run({ task: "x", model: "stub-model" });

    expect(result.steps[0]?.isError).toBe(true);
    expect(result.answer).toContain("ありません");

    server.stop(true);
  });

  test("malformed tool arguments are handed back for correction", async () => {
    const { server, url } = stubServer([
      assistant("", [{ id: "c1", type: "function", function: { name: "search", arguments: "{broken" } }]),
      assistant("直しました。"),
    ]);

    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");
    const result = await agent.run({ task: "x", model: "stub-model" });

    expect(result.steps[0]?.isError).toBe(true);
    expect(result.steps[0]?.result).toContain("JSON");

    server.stop(true);
  });

  test("a model that never stops is cut off at the round limit", async () => {
    const { server, url } = stubServer([assistant("", [call("c", "skill_find", { task: "x" })])]);

    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");
    const result = await agent.run({ task: "x", model: "stub-model", maxRounds: 3 });

    expect(result.rounds).toBe(3);
    expect(result.stopReason).toBe("round-limit");

    server.stop(true);
  });

  test("the token budget stops the run", async () => {
    const { server, url } = stubServer([assistant("", [call("c", "skill_find", { task: "x" })])]);

    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");
    const result = await agent.run({ task: "x", model: "stub-model", tokenBudget: 150 });

    expect(result.stopReason).toBe("budget");
    expect(result.rounds).toBeLessThan(8);

    server.stop(true);
  });

  test("steps are reported as they happen", async () => {
    const { server, url } = stubServer([
      assistant("", [call("c1", "search", { query: "設計" })]),
      assistant("done"),
    ]);

    const seen: string[] = [];
    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");
    await agent.run({
      task: "x",
      model: "stub-model",
      onStep: (step) => seen.push(step.name ?? step.kind),
    });

    expect(seen).toEqual(["search", "message"]);

    server.stop(true);
  });

  test("an unreachable server names the URL", async () => {
    const agent = new LocalAgent(
      workspace,
      new OpenAiCompatClient("http://localhost:1/v1", "Ollama"),
      "Ollama"
    );

    try {
      await agent.run({ task: "x", model: "m" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("localhost:1");
    }
  });

  test("a model the server does not have is caught before the first round", async () => {
    const { server, url } = stubServer([assistant("hi")]);
    const agent = new LocalAgent(workspace, new OpenAiCompatClient(url, "stub"), "stub");

    try {
      await agent.check("not-installed");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("not-installed");
    }

    server.stop(true);
  });
});

// ---- against a real local model server ----

const OLLAMA = "http://localhost:11434";
const ollamaUp = await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false);

const ollamaModel = ollamaUp
  ? await fetch(`${OLLAMA}/api/tags`)
      .then((r) => r.json() as Promise<{ models?: Array<{ name: string; capabilities?: string[] }> }>)
      .then((data) => data.models?.find((m) => m.capabilities?.includes("tools"))?.name ?? null)
      .catch(() => null)
  : null;

describe.skipIf(!ollamaModel)("against a real Ollama", () => {
  test("a local model picks the skill and the loop executes it", async () => {
    const agent = new LocalAgent(
      workspace,
      new OpenAiCompatClient(`${OLLAMA}/v1`, "Ollama"),
      "Ollama"
    );

    const result = await agent.run({
      task: "議事録を取り込みたい。使える手順はある？",
      model: ollamaModel as string,
      maxRounds: 4,
    });

    // The claim: a 4B local model, given only descriptions, routes correctly.
    const toolsUsed = result.steps.filter((s) => s.kind === "tool").map((s) => s.name);
    expect(toolsUsed.length).toBeGreaterThan(0);
    expect(toolsUsed).toContain("skill_find");
    expect(result.promptTokens).toBeGreaterThan(0);
  }, 180_000);
});

afterAll(() => {
  if (!ollamaModel) console.log("  (Ollama not available — live agent test skipped)");
});
