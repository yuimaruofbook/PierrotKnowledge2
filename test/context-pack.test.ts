/**
 * Context packs over a real bundle.
 *
 * The claims under test are the economic ones: a pack groups by file so an
 * agent plans in files rather than fragments, and the tier sizes the budget so
 * a small local model and a frontier model are each handed what fits them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Workspace } from "../src/bun/workspace";
import { TIER_DEFAULTS, formatContextPack } from "../src/bun/rag/context-pack";
import { DEFAULT_BUDGET_CHARS } from "../src/bun/rag/retrieve";
import { callTool } from "../src/bun/mcp/tools";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

async function note(rel: string, frontmatter: string, body: string): Promise<void> {
  const abs = join(root, "wiki", rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, `---\n${frontmatter}\n---\n\n${body}`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-pack-test-"));
  await mkdir(join(root, "wiki"), { recursive: true });

  await note(
    "search-design.md",
    "type: Concept\ntitle: 検索設計\ndescription: 日本語検索をバイグラムで実現する設計\ntags: [search]",
    [
      "# 検索設計",
      "",
      "## バイグラム索引",
      "",
      "日本語検索はバイグラム索引で実現する。unicode61 では分かち書きできない。",
      "",
      "## BM25 ランキング",
      "",
      "検索結果は BM25 でランキングし、タイトルに重みを付ける。",
    ].join("\n")
  );

  await note(
    "ingest.md",
    "type: Playbook\ntitle: 取り込み手順",
    ["# 取り込み手順", "", "raw/ の資料を検索できる形で wiki/ に取り込む。"].join("\n")
  );

  const dir = join(root, "wiki", "skills", "japanese-search");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: japanese-search",
      "description: 日本語検索がヒットしないときの調べ方。",
      "when: [検索, search, バイグラム]",
      "---",
      "",
      "# 手順",
    ].join("\n"),
    "utf8"
  );

  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("workspace.contextPack", () => {
  test("groups passages by file and carries the frontmatter description", async () => {
    const pack = await workspace.contextPack("日本語検索のバイグラム索引はどうなっている");

    const file = pack.files.find((f) => f.id === "search-design");
    expect(file).toBeDefined();
    expect(file!.description).toBe("日本語検索をバイグラムで実現する設計");
    // Both matching sections of the same document sit under one file entry.
    expect(file!.passages.length).toBeGreaterThanOrEqual(1);
    for (const passage of file!.passages) expect(passage.id).toBe("search-design");
  });

  test("tiers size the budget: worker small, supervisor broad", async () => {
    const worker = await workspace.contextPack("検索 バイグラム", { tier: "worker" });
    const supervisor = await workspace.contextPack("検索 バイグラム", { tier: "supervisor" });
    const untiered = await workspace.contextPack("検索 バイグラム");

    expect(worker.budgetChars).toBe(TIER_DEFAULTS.worker.budgetChars);
    expect(supervisor.budgetChars).toBe(TIER_DEFAULTS.supervisor.budgetChars);
    expect(untiered.budgetChars).toBe(DEFAULT_BUDGET_CHARS);
    expect(worker.budgetChars).toBeLessThan(supervisor.budgetChars);
    expect(worker.tier).toBe("worker");
  });

  test("an explicit budget overrides the tier default", async () => {
    const pack = await workspace.contextPack("検索 バイグラム", {
      tier: "supervisor",
      budgetChars: 100,
    });
    expect(pack.budgetChars).toBe(100);
    expect(pack.usedChars).toBeLessThanOrEqual(100);
  });

  test("matching skills ride along with the context", async () => {
    const pack = await workspace.contextPack("日本語の検索がヒットしない");
    expect(pack.skills.map((s) => s.name)).toContain("japanese-search");
  });

  test("a task the bundle does not cover returns an empty pack, not noise", async () => {
    const pack = await workspace.contextPack("量子コンピュータの誤り訂正");
    expect(pack.files).toEqual([]);
  });
});

describe("formatContextPack", () => {
  test("renders paths, anchors and skills for the agent", async () => {
    const pack = await workspace.contextPack("日本語検索のバイグラム索引");
    const rendered = formatContextPack(pack);

    expect(rendered).toContain("wiki/search-design.md");
    expect(rendered).toContain("anchor: `");
    expect(rendered).toContain("japanese-search");
  });
});

describe("context_pack tool", () => {
  test("returns a formatted pack", async () => {
    const result = await callTool(workspace, "context_pack", {
      task: "日本語検索のバイグラム索引",
      tier: "worker",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("tier: worker");
    expect(result.content[0]!.text).toContain("wiki/search-design.md");
  });

  test("rejects an unknown tier instead of guessing", async () => {
    const result = await callTool(workspace, "context_pack", {
      task: "検索",
      tier: "manager",
    });
    expect(result.isError).toBe(true);
  });

  test("requires a task", async () => {
    const result = await callTool(workspace, "context_pack", { task: "  " });
    expect(result.isError).toBe(true);
  });
});
