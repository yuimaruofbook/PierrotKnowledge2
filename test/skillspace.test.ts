/**
 * SkillSpace against a real bundle on disk.
 *
 * The claim being tested is the economic one: listing many skills must not
 * read their bodies, and the MCP surface must keep the tiers separate. A
 * regression there is invisible in behaviour and only shows up as a context
 * window filling with procedures nobody asked for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Workspace } from "../src/bun/workspace";
import { callTool } from "../src/bun/mcp/tools";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

async function skill(name: string, frontmatter: string, body: string): Promise<void> {
  // skills/ lives inside the wiki layer.
  const dir = join(root, "wiki", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-skill-test-"));
  await mkdir(join(root, "wiki"), { recursive: true });

  await skill(
    "okf-ingest",
    [
      "name: okf-ingest",
      "description: raw/ の資料を wiki/ に取り込んで整理する手順。議事録やエクスポートを扱うとき。",
      "when: [取り込み, ingest, 議事録, エクスポート]",
      "tags: [ingest, workflow]",
    ].join("\n"),
    ["# 取り込み手順", "", "1. read_agents_md を呼ぶ", "2. search で重複を確認する"].join("\n")
  );

  await skill(
    "japanese-search",
    [
      "name: japanese-search",
      "description: 日本語で検索がヒットしないときの調べ方と直し方。",
      "when: [検索, search, ヒットしない, バイグラム]",
      "tags: [search]",
    ].join("\n"),
    ["# 日本語検索", "", "CJK はバイグラムで索引している。"].join("\n")
  );

  // A supporting file, to prove it is listed but not loaded.
  await writeFile(
    join(root, "wiki", "skills", "okf-ingest", "reference.md"),
    "# 詳細な参照\n\nここに長い手順が入る。",
    "utf8"
  );

  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

const textOf = (result: { content: Array<{ text: string }> }) => result.content[0]?.text ?? "";

describe("discovery", () => {
  test("lists skills with their cost, and never their bodies", async () => {
    const summaries = await workspace.requireSkills().summaries();

    expect(summaries.map((s) => s.name)).toEqual(["japanese-search", "okf-ingest"]);
    expect(summaries[1]?.bodyTokens).toBeGreaterThan(0);
    // The economic contract: a summary carries no procedure text.
    expect(JSON.stringify(summaries)).not.toContain("read_agents_md");
  });

  test("lists supporting files without reading them", async () => {
    const summaries = await workspace.requireSkills().summaries();
    const ingest = summaries.find((s) => s.name === "okf-ingest");

    expect(ingest?.resources).toEqual(["reference.md"]);
    expect(JSON.stringify(summaries)).not.toContain("詳細な参照");
  });

  test("a skill with no description is not listed — it can never be selected", async () => {
    await skill("no-description", "name: no-description", "body");
    workspace.requireSkills().invalidate();

    const names = (await workspace.requireSkills().summaries()).map((s) => s.name);
    expect(names).not.toContain("no-description");
  });

  test("an empty SkillSpace is not an error", async () => {
    const empty = await mkdtemp(join(tmpdir(), "okf-skill-empty-"));
    await mkdir(join(empty, "wiki"), { recursive: true });
    const other = new Workspace({ watch: false });
    await other.open(empty);

    expect(await other.requireSkills().summaries()).toEqual([]);

    await other.close();
    await removeTempDir(empty);
  });
});

describe("selection", () => {
  test("finds the ingest skill from a Japanese request", async () => {
    const result = await workspace.requireSkills().find("Notion のエクスポートを取り込みたい");

    expect(result.ranked[0]?.name).toBe("okf-ingest");
    expect(result.topTokens).toBeGreaterThan(0);
  });

  test("finds the search skill from a Japanese complaint", async () => {
    const result = await workspace.requireSkills().find("日本語で検索してもヒットしない");

    expect(result.ranked[0]?.name).toBe("japanese-search");
  });

  test("returns nothing rather than a bad guess", async () => {
    expect((await workspace.requireSkills().find("今日の天気")).ranked).toEqual([]);
  });
});

describe("loading", () => {
  test("open returns the body and the resource names", async () => {
    const skill = await workspace.requireSkills().open("okf-ingest");

    expect(skill.body).toContain("read_agents_md");
    expect(skill.resources).toEqual(["reference.md"]);
  });

  test("a resource is read only when asked for by name", async () => {
    const resource = await workspace.requireSkills().readResource("okf-ingest", "reference.md");

    expect(resource.content).toContain("詳細な参照");
  });

  test("an unknown skill fails clearly", async () => {
    try {
      await workspace.requireSkills().open("nope");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("nope");
    }
  });

  test("a resource path cannot escape the skill folder", async () => {
    // Skill bodies are content, and content that names a file is a traversal
    // vector like any other.
    for (const attack of ["../japanese-search/SKILL.md", "../../wiki/index.md", "..\\..\\AGENTS.md"]) {
      try {
        await workspace.requireSkills().readResource("okf-ingest", attack);
        throw new Error(`should have refused: ${attack}`);
      } catch (error) {
        expect((error as Error).message).toContain("okf-ingest");
      }
    }
  });

  test("a skill name cannot escape the skills folder", async () => {
    try {
      await workspace.requireSkills().open("../wiki");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toBeTruthy();
    }
  });
});

describe("the MCP surface", () => {
  test("skill_find returns candidates and confidence, no bodies", async () => {
    const result = await callTool(workspace, "skill_find", { task: "議事録を取り込む" });
    const payload = JSON.parse(textOf(result));

    expect(payload.ranked[0].name).toBe("okf-ingest");
    expect(payload.confidence).toBeTruthy();
    expect(textOf(result)).not.toContain("read_agents_md");
  });

  test("skill_find explains itself when nothing matches", async () => {
    const result = await callTool(workspace, "skill_find", { task: "今日の天気" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("skill_list");
  });

  test("skill_list stays cheap", async () => {
    const result = await callTool(workspace, "skill_list", {});

    expect(textOf(result)).toContain("okf-ingest");
    expect(textOf(result)).not.toContain("read_agents_md");
  });

  test("skill_open is the only tool that returns a procedure", async () => {
    const result = await callTool(workspace, "skill_open", { name: "okf-ingest" });

    expect(textOf(result)).toContain("read_agents_md");
    // It must also tell the agent what else it could read, without reading it.
    expect(textOf(result)).toContain("reference.md");
    expect(textOf(result)).not.toContain("詳細な参照");
  });

  test("skill_read fetches one named resource", async () => {
    const result = await callTool(workspace, "skill_read", {
      name: "okf-ingest",
      path: "reference.md",
    });

    expect(textOf(result)).toContain("詳細な参照");
  });

  test("a traversal through skill_read is reported as an error", async () => {
    const result = await callTool(workspace, "skill_read", {
      name: "okf-ingest",
      path: "../../AGENTS.md",
    });

    expect(result.isError).toBe(true);
  });

  test("skill_find requires a task", async () => {
    expect((await callTool(workspace, "skill_find", {})).isError).toBe(true);
  });
});

describe("the layer contract", () => {
  test("skills live inside the wiki layer", async () => {
    const paths = workspace.requireBundle().paths;

    expect(paths.layerOf("wiki/skills/okf-ingest/SKILL.md")).toBe("wiki");
    expect(paths.layerOf("wiki/index.md")).toBe("wiki");
    // …but are not scanned as concepts.
    expect(paths.isSubsystemPath("wiki/skills/okf-ingest/SKILL.md")).toBe(true);
  });

  test("skills are writable — they are authored, not derived", async () => {
    // raw/ and .rag/ are refused; skills/ must not be.
    expect(() => workspace.requireBundle().paths.assertWritable("skills/x/SKILL.md")).not.toThrow();
  });
});
