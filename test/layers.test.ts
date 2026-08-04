/**
 * The three-layer contract, and moving data between layers.
 *
 * An earlier version put `AGENTS.md`, `skills/` and `loops/` at the bundle
 * root, which turned three layers into five. These tests pin the corrected
 * shape — and the migration that repairs bundles written under the old one,
 * because that migration touches real user data and gets exactly one chance.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Workspace } from "../src/bun/workspace";
import { callTool } from "../src/bun/mcp/tools";
import { migrateLayout } from "../src/bun/okf/migrate";
import { BundlePaths } from "../src/bun/okf/paths";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

const exists = async (p: string) => !!(await stat(p).catch(() => null));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-layers-"));
  workspace = new Workspace({ watch: false });
  await workspace.scaffold(root);
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("three layers, not five", () => {
  test("the bundle root holds exactly the three layers, plus the orientation files", async () => {
    const entries = (await readdir(root)).sort();

    // The directories at the root are the layers and nothing else — that is
    // the invariant. The three loose files beside them are deliberately not
    // layers: they are not the material the layers stage.
    expect(entries.filter((e) => !e.endsWith(".md"))).toEqual([".rag", "raw", "wiki"]);
    expect(entries.filter((e) => e.endsWith(".md")).sort()).toEqual([
      "MAP.md",
      "Task.md",
      "human.md",
    ]);
  });

  test("AGENTS.md, skills/ and loops/ live inside wiki/", async () => {
    expect(await exists(join(root, "wiki", "AGENTS.md"))).toBe(true);
    expect(await exists(join(root, "wiki", "skills"))).toBe(true);
    expect(await exists(join(root, "wiki", "loops"))).toBe(true);

    // And not at the root, where they used to be.
    expect(await exists(join(root, "AGENTS.md"))).toBe(false);
    expect(await exists(join(root, "skills"))).toBe(false);
  });

  test("MAP, human and Task sit outside the layers, not inside wiki/", async () => {
    // They describe where things live, who the user is, and what is in flight.
    // None is knowledge, so none belongs to a layer that stages knowledge.
    for (const name of ["MAP.md", "human.md", "Task.md"]) {
      expect(await exists(join(root, name))).toBe(true);
      expect(await exists(join(root, "wiki", name))).toBe(false);
    }
  });

  test("everything under wiki/ reports the wiki layer", () => {
    const paths = workspace.requireBundle().paths;

    expect(paths.layerOf("wiki/index.md")).toBe("wiki");
    expect(paths.layerOf("wiki/AGENTS.md")).toBe("wiki");
    expect(paths.layerOf("wiki/skills/okf-ingest/SKILL.md")).toBe("wiki");
    expect(paths.layerOf("wiki/loops/weekly-lint.md")).toBe("wiki");
    expect(paths.layerOf("raw/note.md")).toBe("raw");
    expect(paths.layerOf(".rag/fts.sqlite")).toBe("rag");
  });

  test("skills, loops and the contract are not indexed as knowledge", async () => {
    // A procedure or a work log turning up in search would corrupt every result.
    const ids = workspace.requireBundle().allConcepts().map((c) => c.id);

    expect(ids.some((id) => id.includes("skills/"))).toBe(false);
    expect(ids.some((id) => id.includes("loops/"))).toBe(false);
    expect(ids.some((id) => id.toLowerCase().includes("agents"))).toBe(false);
  });

  test("the contract is not conformance-checked as a concept", () => {
    // It is prose for agents; demanding OKF frontmatter of it would be wrong.
    const issues = workspace.conformanceIssues().map((i) => i.path);
    expect(issues).toEqual([]);
  });

  test("agents can still read the contract from its new home", async () => {
    const result = await callTool(workspace, "read_agents_md", {});
    expect(result.content[0]?.text).toContain("レイヤー");
  });
});

describe("migrating a bundle written with the old layout", () => {
  async function oldLayout(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "okf-old-"));
    await mkdir(join(dir, "wiki"), { recursive: true });
    await mkdir(join(dir, "raw"), { recursive: true });
    await mkdir(join(dir, "skills", "my-skill"), { recursive: true });
    await mkdir(join(dir, "loops"), { recursive: true });

    await writeFile(join(dir, "AGENTS.md"), "# 旧レイアウトの規約\n", "utf8");
    await writeFile(
      join(dir, "skills", "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: 移行テスト用\n---\n\n# 手順\n",
      "utf8"
    );
    await writeFile(join(dir, "loops", "my-loop.md"), "---\nloop: my-loop\ngoal: 移行\n---\n", "utf8");
    await writeFile(join(dir, "wiki", "note.md"), "---\ntype: Concept\n---\n\n# ノート\n", "utf8");
    return dir;
  }

  test("lifts MAP, human and Task out of wiki/ on open, content intact", async () => {
    // These briefly lived inside wiki/. A migration that dropped Task.md would
    // destroy a real task list, so the content is checked, not just the path.
    const dir = await mkdtemp(join(tmpdir(), "okf-orient-"));
    await mkdir(join(dir, "wiki"), { recursive: true });
    await mkdir(join(dir, "raw"), { recursive: true });

    const tasks = "# タスク\n\n## 進行中\n\n- [ ] T-0007 移行しても消えないこと\n";
    await writeFile(join(dir, "wiki", "MAP.md"), "# MAP\n\n<!-- okf:user-rules -->\n自作の規則\n", "utf8");
    await writeFile(join(dir, "wiki", "human.md"), "# 利用者\n\n- 呼び方: テスト\n", "utf8");
    await writeFile(join(dir, "wiki", "Task.md"), tasks, "utf8");

    const other = new Workspace({ watch: false });
    await other.open(dir);

    for (const name of ["MAP.md", "human.md", "Task.md"]) {
      expect(await exists(join(dir, name))).toBe(true);
      expect(await exists(join(dir, "wiki", name))).toBe(false);
    }

    expect(await readFile(join(dir, "Task.md"), "utf8")).toContain("T-0007 移行しても消えないこと");
    expect(await readFile(join(dir, "human.md"), "utf8")).toContain("呼び方: テスト");
    // MAP is regenerated on read, but the user's own half must survive that.
    expect(await other.readMap()).toContain("自作の規則");

    await other.close();
    await removeTempDir(dir);
  });

  test("moves the three into wiki/ on open", async () => {
    const dir = await oldLayout();
    const other = new Workspace({ watch: false });
    await other.open(dir);

    expect(await exists(join(dir, "wiki", "AGENTS.md"))).toBe(true);
    expect(await exists(join(dir, "wiki", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(await exists(join(dir, "wiki", "loops", "my-loop.md"))).toBe(true);

    expect(await exists(join(dir, "AGENTS.md"))).toBe(false);
    expect(await exists(join(dir, "skills"))).toBe(false);
    expect(await exists(join(dir, "loops"))).toBe(false);

    // The content survived, not just the paths.
    expect(await readFile(join(dir, "wiki", "AGENTS.md"), "utf8")).toContain("旧レイアウト");
    expect((await other.requireSkills().summaries()).map((s) => s.name)).toContain("my-skill");

    await other.close();
    await removeTempDir(dir);
  });

  test("is idempotent", async () => {
    const dir = await oldLayout();

    const first = new Workspace({ watch: false });
    await first.open(dir);
    await first.close();

    // A second open must not move anything, nor fail.
    const second = new Workspace({ watch: false });
    await second.open(dir);
    expect(second.requireBundle().migration.moved).toEqual([]);
    expect(await exists(join(dir, "wiki", "skills", "my-skill", "SKILL.md"))).toBe(true);

    await second.close();
    await removeTempDir(dir);
  });

  test("never overwrites a file that already exists at the destination", async () => {
    const dir = await oldLayout();
    // The user already made a skill under the corrected layout.
    await mkdir(join(dir, "wiki", "skills", "my-skill"), { recursive: true });
    await writeFile(join(dir, "wiki", "skills", "my-skill", "SKILL.md"), "新しいほう\n", "utf8");

    const paths = new BundlePaths(dir, "wiki");
    const result = await migrateLayout(paths);

    // The newer file wins and the older one is reported, not silently dropped.
    expect(await readFile(join(dir, "wiki", "skills", "my-skill", "SKILL.md"), "utf8")).toContain(
      "新しいほう"
    );
    expect(result.skipped.join()).toContain("my-skill");
    expect(await exists(join(dir, "skills", "my-skill", "SKILL.md"))).toBe(true);

    await removeTempDir(dir);
  });

  test("a folder opened directly as the wiki layer is left alone", async () => {
    // No wiki/ subdirectory means the roots coincide; moving would be a no-op
    // at best and a rename onto itself at worst.
    const dir = await mkdtemp(join(tmpdir(), "okf-flat-"));
    await mkdir(join(dir, "skills"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "# flat\n", "utf8");

    const result = await migrateLayout(new BundlePaths(dir, ""));

    expect(result.moved).toEqual([]);
    expect(await exists(join(dir, "AGENTS.md"))).toBe(true);

    await removeTempDir(dir);
  });
});

describe("moving between layers", () => {
  beforeEach(async () => {
    await mkdir(join(root, "raw"), { recursive: true });
    await writeFile(join(root, "raw", "source.md"), "# 生データ\n\n議事録の本文。\n", "utf8");
  });

  test("a human can promote from raw/ into wiki/", async () => {
    const result = await workspace.promote("raw/source.md", "wiki/summary.md");

    expect(result.promoted).toBe("wiki/summary.md");
    expect(await readFile(join(root, "wiki", "summary.md"), "utf8")).toContain("議事録の本文");
  });

  test("promotion keeps the original by default", async () => {
    // raw/ is the record of what was actually received. A wiki page whose
    // source has been moved away cannot be checked against it.
    await workspace.promote("raw/source.md", "wiki/summary.md");

    expect(await exists(join(root, "raw", "source.md"))).toBe(true);
  });

  test("keepSource: false performs a true move", async () => {
    const result = await workspace.promote("raw/source.md", "wiki/summary.md", {
      keepSource: false,
    });

    expect(result.kept).toBe(false);
    expect(await exists(join(root, "raw", "source.md"))).toBe(false);
    expect(await exists(join(root, "wiki", "summary.md"))).toBe(true);
  });

  test("promotion never overwrites an existing page", async () => {
    await workspace.writeFile("wiki/summary.md", "---\ntype: Concept\n---\n\n# 先客\n", {
      actor: "test",
    });

    const result = await workspace.promote("raw/source.md", "wiki/summary.md");

    expect(result.promoted).not.toBe("wiki/summary.md");
    expect(await readFile(join(root, "wiki", "summary.md"), "utf8")).toContain("先客");
  });

  test("an agent cannot move a file out of raw/", async () => {
    const result = await callTool(workspace, "move_file", {
      from: "raw/source.md",
      to: "wiki/stolen.md",
      actor: "process:test",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("人間の操作");
    expect(await exists(join(root, "raw", "source.md"))).toBe(true);
    expect(await exists(join(root, "wiki", "stolen.md"))).toBe(false);
  });

  test("an agent can move files within the wiki layer", async () => {
    await workspace.writeFile("wiki/a.md", "---\ntype: Concept\n---\n\n# A\n", { actor: "test" });

    const result = await callTool(workspace, "move_file", {
      from: "wiki/a.md",
      to: "wiki/topics/a.md",
      actor: "process:test",
    });

    expect(result.isError).toBeFalsy();
    expect(await exists(join(root, "wiki", "topics", "a.md"))).toBe(true);
  });

  test("a human may put things into raw/", async () => {
    // raw/ is the human's inbox: originals arrive by hand, or through an
    // import the user triggered.
    await workspace.writeFile("raw/notes.md", "# 手で置いた原本\n", { actor: "human:local" });

    expect(await readFile(join(root, "raw", "notes.md"), "utf8")).toContain("手で置いた");
  });

  test("a human may move a file into raw/", async () => {
    await workspace.writeFile("wiki/a.md", "---\ntype: Concept\n---\n\n# A\n", { actor: "test" });
    await workspace.move("wiki/a.md", "raw/a.md", "human:local", "human");

    expect(await exists(join(root, "raw", "a.md"))).toBe(true);
  });

  test("an agent may not write into raw/", async () => {
    // raw/ records what was actually received; material an agent produced was
    // not received from anywhere.
    const result = await callTool(workspace, "write_file", {
      path: "raw/fabricated.md",
      content: "# エージェントが作った原本\n",
      actor: "process:test",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("人間");
    expect(await exists(join(root, "raw", "fabricated.md"))).toBe(false);
  });

  test("an agent may not move a file into raw/", async () => {
    await workspace.writeFile("wiki/a.md", "---\ntype: Concept\n---\n\n# A\n", { actor: "test" });

    const result = await callTool(workspace, "move_file", {
      from: "wiki/a.md",
      to: "raw/a.md",
      actor: "process:test",
    });

    expect(result.isError).toBe(true);
    expect(await exists(join(root, "raw", "a.md"))).toBe(false);
  });

  test("both sides may work in .rag/", async () => {
    // The derived layer is operable from either direction: it is rebuildable,
    // so nothing there is precious.
    await workspace.writeFile(".rag/human-note.md", "human\n", { actor: "human:local" });
    expect(await exists(join(root, ".rag", "human-note.md"))).toBe(true);

    const result = await callTool(workspace, "write_file", {
      path: ".rag/agent-note.md",
      content: "agent",
      actor: "process:test",
    });
    expect(result.isError).toBeFalsy();
    expect(await exists(join(root, ".rag", "agent-note.md"))).toBe(true);
  });

  test("an import from Notion or Drive still lands in raw/", async () => {
    // The user triggers these from the connections panel, so they are a human
    // action even though an MCP client fetched the bytes.
    const { path } = await workspace
      .requireBundle()
      .importToRaw("raw/notion/2026-08-03-page.md", "# Notion から\n", {
        actor: "human:local",
      });

    expect(path).toStartWith("raw/");
    expect(await readFile(join(root, path), "utf8")).toContain("Notion から");
  });

  test("promotion is recorded in log.md", async () => {
    await workspace.promote("raw/source.md", "wiki/summary.md");

    const log = await readFile(join(root, "wiki", "log.md"), "utf8");
    expect(log).toContain("wiki/summary.md");
    expect(log).toContain("raw/source.md");
  });

  test("a promoted page is searchable immediately", async () => {
    await workspace.promote("raw/source.md", "wiki/summary.md");

    // The index must reflect the new page without a manual rebuild.
    expect(workspace.search("議事録").length).toBeGreaterThan(0);
  });
});
