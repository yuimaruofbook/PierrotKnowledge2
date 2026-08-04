/**
 * PARA: Projects, Areas, Resources, Archive.
 *
 * The class is the folder, and the four are an explicit priority order — so
 * what is tested is that the order actually *does* something: that an active
 * project outranks a shelved note, and that archiving is a real move rather
 * than a label.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Workspace } from "../src/bun/workspace";
import { callTool } from "../src/bun/mcp/tools";
import {
  DEFAULT_PARA,
  PARA_DIRS,
  PARA_ORDER,
  PARA_WEIGHTS,
  isArchived,
  paraOf,
  parseParaClass,
  reclassify,
} from "../src/shared/okf/para";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

const exists = async (p: string) => !!(await stat(p).catch(() => null));

async function note(wikiRel: string, title: string, body: string): Promise<void> {
  const abs = join(root, "wiki", wikiRel);
  await (await import("fs/promises")).mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, `---\ntype: Concept\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-para-"));
  workspace = new Workspace({ watch: false });
  await workspace.scaffold(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("classification", () => {
  test("the four classes are in priority order", () => {
    expect(PARA_ORDER).toEqual(["project", "area", "resource", "archive"]);
  });

  test("the folder decides the class", () => {
    expect(paraOf("1-projects/q3.md")).toBe("project");
    expect(paraOf("2-areas/health.md")).toBe("area");
    expect(paraOf("3-resources/okf.md")).toBe("resource");
    expect(paraOf("4-archive/old.md")).toBe("archive");
  });

  test("only the first segment counts", () => {
    // A folder called 1-projects nested deeper is just a folder.
    expect(paraOf("3-resources/1-projects/note.md")).toBe("resource");
  });

  test("anything unfiled is a Resource", () => {
    expect(paraOf("loose-note.md")).toBe(DEFAULT_PARA);
    expect(paraOf("topics/deep/note.md")).toBe("resource");
  });

  test("class names are parsed tolerantly", () => {
    // An agent that read the tree saw `4-archive`, not `archive`.
    expect(parseParaClass("archive")).toBe("archive");
    expect(parseParaClass("4-archive")).toBe("archive");
    expect(parseParaClass("4")).toBe("archive");
    expect(parseParaClass("Project")).toBe("project");
    expect(parseParaClass("nonsense")).toBeNull();
  });

  test("reclassifying keeps the sub-path", () => {
    expect(reclassify("1-projects/q3/notes.md", "archive")).toBe("4-archive/q3/notes.md");
    // Filing something for the first time must not flatten existing structure.
    expect(reclassify("topics/deep/note.md", "project")).toBe("1-projects/topics/deep/note.md");
  });

  test("archive ranks far below everything else", () => {
    expect(PARA_WEIGHTS.project).toBeGreaterThan(PARA_WEIGHTS.area);
    expect(PARA_WEIGHTS.area).toBeGreaterThan(PARA_WEIGHTS.resource);
    expect(PARA_WEIGHTS.resource).toBeGreaterThan(PARA_WEIGHTS.archive);
  });
});

describe("the scaffolded layout", () => {
  test("creates the four folders, numbered so the tree sorts by priority", async () => {
    for (const cls of PARA_ORDER) {
      expect(await exists(join(root, "wiki", PARA_DIRS[cls]))).toBe(true);
    }
    expect(PARA_DIRS.project).toStartWith("1-");
    expect(PARA_DIRS.archive).toStartWith("4-");
  });
});

describe("ranking", () => {
  beforeEach(async () => {
    // The same sentence in four places: only PARA can separate them.
    const text = "レイヤー分離の設計判断について。";
    await note("1-projects/active.md", "進行中", text);
    await note("2-areas/interest.md", "関心", text);
    await note("3-resources/reference.md", "参照", text);
    await note("4-archive/stale.md", "旧", text);
    await workspace.open(root);
  });

  test("an active project outranks the same content in the archive", () => {
    const hits = workspace.search("レイヤー分離");
    const paths = hits.map((h) => h.id);

    expect(paths[0]).toContain("1-projects");
    expect(paths[paths.length - 1]).toContain("4-archive");
  });

  test("the order is project, area, resource, archive", () => {
    const classes = workspace.search("レイヤー分離").map((h) => h.para);
    expect(classes).toEqual(["project", "area", "resource", "archive"]);
  });

  test("archived material is still findable, just never preferred", () => {
    // Ranking it down is not the same as hiding it: something that is the only
    // answer must still come back.
    const hits = workspace.search("旧");
    expect(hits.some((h) => h.id.includes("4-archive"))).toBe(true);
  });

  test("hits carry their class, so the UI can badge them", () => {
    expect(workspace.search("レイヤー分離")[0]?.para).toBe("project");
  });
});

describe("refiling", () => {
  beforeEach(async () => {
    await note("1-projects/q3.md", "Q3", "本文");
    await note("3-resources/ref.md", "参照", "[[1-projects/q3]] を見る");
    await workspace.open(root);
  });

  test("archiving moves the file", async () => {
    const result = await workspace.setPara("wiki/1-projects/q3.md", "archive");

    expect(result.moved).toBe(true);
    expect(await exists(join(root, "wiki", "4-archive", "q3.md"))).toBe(true);
    expect(await exists(join(root, "wiki", "1-projects", "q3.md"))).toBe(false);
  });

  test("refiling rewrites inbound links", async () => {
    await workspace.setPara("wiki/1-projects/q3.md", "archive");

    // Archiving must not break the graph.
    const ref = await readFile(join(root, "wiki", "3-resources", "ref.md"), "utf8");
    expect(ref).toContain("4-archive/q3");
    expect(ref).not.toContain("[[1-projects/q3]]");
  });

  test("refiling to the class it already has is a no-op", async () => {
    const result = await workspace.setPara("wiki/1-projects/q3.md", "project");

    expect(result.moved).toBe(false);
    expect(await exists(join(root, "wiki", "1-projects", "q3.md"))).toBe(true);
  });

  test("an unfiled note gains a prefix rather than being flattened", async () => {
    await note("topics/deep/loose.md", "散在", "本文");
    await workspace.reloadBundle();

    await workspace.setPara("wiki/topics/deep/loose.md", "area");

    expect(await exists(join(root, "wiki", "2-areas", "topics", "deep", "loose.md"))).toBe(true);
  });
});

describe("the MCP surface", () => {
  beforeEach(async () => {
    await note("1-projects/q3.md", "Q3", "本文");
    await note("3-resources/ref.md", "参照", "本文");
    await workspace.open(root);
  });

  test("set_para refiles and reports where it went", async () => {
    const result = await callTool(workspace, "set_para", {
      path: "wiki/1-projects/q3.md",
      para: "archive",
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("4-archive");
    expect(await exists(join(root, "wiki", "4-archive", "q3.md"))).toBe(true);
  });

  test("set_para accepts the folder name an agent saw in the tree", async () => {
    const result = await callTool(workspace, "set_para", {
      path: "wiki/1-projects/q3.md",
      para: "4-archive",
    });

    expect(result.isError).toBeFalsy();
  });

  test("an unknown class is refused with the valid ones named", async () => {
    const result = await callTool(workspace, "set_para", {
      path: "wiki/1-projects/q3.md",
      para: "someday",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("project");
  });

  test("list_para groups in priority order", async () => {
    const payload = JSON.parse(
      (await callTool(workspace, "list_para", {})).content[0]?.text ?? "{}"
    );

    expect(payload.order).toEqual(["project", "area", "resource", "archive"]);
    expect(payload.groups.project.map((c: { id: string }) => c.id)).toContain("1-projects/q3");
    expect(payload.groups.resource.map((c: { id: string }) => c.id)).toContain("3-resources/ref");
  });

  test("list_para can be narrowed to one class", async () => {
    const payload = JSON.parse(
      (await callTool(workspace, "list_para", { para: "project" })).content[0]?.text ?? "{}"
    );

    expect(Object.keys(payload.groups)).toEqual(["project"]);
  });
});

describe("skills", () => {
  test("are grouped by category folder", async () => {
    await workspace.open(root);
    const summaries = await workspace.requireSkills().summaries();

    expect(summaries.find((s) => s.name === "okf-ingest")?.category).toBe("ingest");
    expect(summaries.find((s) => s.name === "wiki-answer")?.category).toBe("query");
    expect(summaries.find((s) => s.name === "wiki-lint")?.category).toBe("quality");
    expect(await workspace.requireSkills().categories()).toEqual(["ingest", "quality", "query"]);
  });

  test("a skill is still addressed by name alone, whatever its category", async () => {
    await workspace.open(root);
    const skill = await workspace.requireSkills().open("okf-ingest");

    expect(skill.name).toBe("okf-ingest");
    expect(skill.category).toBe("ingest");
  });

  test("an uncategorised skill still works", async () => {
    // The flat layout has to keep working: people had skills before categories.
    const dir = join(root, "wiki", "skills", "loose-skill");
    await (await import("fs/promises")).mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: loose-skill\ndescription: カテゴリなしの手順\n---\n\n# 手順\n",
      "utf8"
    );
    await workspace.open(root);

    const summary = (await workspace.requireSkills().summaries()).find(
      (s) => s.name === "loose-skill"
    );
    expect(summary?.category).toBe("");
  });

  test("an archived skill is never suggested but can still be opened", async () => {
    const dir = join(root, "wiki", "skills", "ingest", "old-way");
    await (await import("fs/promises")).mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      [
        "---",
        "name: old-way",
        "description: 議事録を取り込む古いやり方。",
        "when: [取り込み, 議事録]",
        "para: archive",
        "---",
        "",
        "# 旧手順",
      ].join("\n"),
      "utf8"
    );
    await workspace.open(root);

    const found = await workspace.requireSkills().find("議事録を取り込みたい");
    expect(found.ranked.map((r) => r.name)).not.toContain("old-way");

    // Archiving is a decision to stop using it, not to delete it.
    expect((await workspace.requireSkills().open("old-way")).para).toBe("archive");
  });

  test("isArchived reads straight off the path", () => {
    expect(isArchived("4-archive/x.md")).toBe(true);
    expect(isArchived("1-projects/x.md")).toBe(false);
  });
});
