/**
 * Cross-agent know-how: short lessons recorded by one agent for the next.
 *
 * The claims under test: a lesson carries who recorded it, it is findable
 * cheaply (names, descriptions, scores - never bodies), the context pack
 * volunteers the best three, and retired lessons (DEAD) stop being offered.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { deriveDescription, knowhowSlug } from "../src/shared/okf/knowhow";
import { Workspace } from "../src/bun/workspace";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { callTool, TOOLS } from "../src/bun/mcp/tools";
import { formatContextPack } from "../src/bun/rag/context-pack";
import { removeTempDir } from "./helpers";

describe("know-how naming", () => {
  test("slugs keep letters of any script and fall back to the folder name", () => {
    expect(knowhowSlug("Windows: path  separators!")).toBe("windows-path-separators");
    expect(knowhowSlug("日本語のパス問題")).toBe("日本語のパス問題");
    expect(knowhowSlug("!!!")).toBe("knowhow");
    expect(Array.from(knowhowSlug("a".repeat(100)))).toHaveLength(60);
  });

  test("the description is the first meaningful line, trimmed", () => {
    expect(deriveDescription("\n\n## Heading\n- use   forward slashes\nmore")).toBe("Heading");
    expect(deriveDescription("  > quoted   lesson here  ")).toBe("quoted lesson here");
    expect(deriveDescription("***\n")).toBe("");
    const long = deriveDescription("x".repeat(200));
    expect(Array.from(long)).toHaveLength(141);
    expect(long.endsWith("…")).toBe(true);
  });
});

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-knowhow-test-"));
  await scaffoldBundle(root);
  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("scaffold", () => {
  test("a new bundle has knowhow/ and activity/ with an index.md each", async () => {
    for (const [dir, title] of [
      ["knowhow", "Know-how"],
      ["activity", "Activity"],
    ] as const) {
      const index = await readFile(join(root, "wiki", dir, "index.md"), "utf8");
      expect(index).toBe(`# ${title}\n`);
    }
  });

  test("an existing bundle gets them on the first write", async () => {
    await rm(join(root, "wiki", "knowhow"), { recursive: true });
    await workspace.knowhowAdd({ title: "First", body: "Lesson one.", actor: "process:tester" });
    expect(await readFile(join(root, "wiki", "knowhow", "index.md"), "utf8")).toBe("# Know-how\n");
  });
});

describe("knowhow_add", () => {
  test("stores a Knowhow concept with who recorded it", async () => {
    const { path } = await workspace.knowhowAdd({
      title: "Use forward slashes",
      body: "Windows accepts / in every API we call.\n\nBackslashes break the glob.",
      tags: ["windows", "paths"],
      actor: "process:claude-code",
    });
    expect(path).toBe("wiki/knowhow/use-forward-slashes.md");

    const concept = (await workspace.readFile(path)).concept!;
    expect(concept.frontmatter.type).toBe("Knowhow");
    expect(concept.frontmatter.title).toBe("Use forward slashes");
    expect(concept.frontmatter.by).toBe("process:claude-code");
    expect(concept.frontmatter.tags).toEqual(["windows", "paths"]);
    expect(concept.frontmatter.description).toBe("Windows accepts / in every API we call.");
    expect(concept.frontmatter.generated?.by).toBe("process:claude-code");
    expect(concept.body).toContain("Backslashes break the glob.");

    const audit = await workspace.auditChanges({ actor: "process:claude-code" });
    expect(audit.actors[0]!.entries[0]!.kind).toBe("Creation");
  });

  test("a repeated title gets a numbered file instead of overwriting", async () => {
    const a = await workspace.knowhowAdd({ title: "Same", body: "one", actor: "process:a" });
    const b = await workspace.knowhowAdd({ title: "Same", body: "two", actor: "process:b" });
    const c = await workspace.knowhowAdd({ title: "Same", body: "three", actor: "process:c" });
    expect([a.path, b.path, c.path]).toEqual([
      "wiki/knowhow/same.md",
      "wiki/knowhow/same-2.md",
      "wiki/knowhow/same-3.md",
    ]);
    expect(await readFile(join(root, a.path), "utf8")).toContain("one");
  });
});

describe("knowhow_find", () => {
  beforeEach(async () => {
    await workspace.knowhowAdd({
      title: "Quote Windows paths",
      body: "Quote any path with spaces before passing it to a shell command.",
      tags: ["windows", "shell"],
      actor: "process:claude-code",
    });
    await workspace.knowhowAdd({
      title: "Retry flaky downloads",
      body: "The release server drops connections; retry with backoff.",
      tags: ["network"],
      actor: "process:codex",
    });
  });

  test("ranks like skill_find: names, descriptions, scores and who, never bodies", () => {
    const found = workspace.knowhowFind("quote windows path spaces shell", 3);
    expect(found.ranked.map((r) => r.title)).toEqual(["Quote Windows paths"]);
    const top = found.ranked[0]!;
    expect(Object.keys(top)).toEqual(["title", "path", "description", "by", "score", "matched"]);
    expect(top.by).toBe("process:claude-code");
    expect(top.path).toBe("wiki/knowhow/quote-windows-paths.md");
    expect(top.score).toBeGreaterThan(0);
    expect(found.confidence).toBeDefined();
    expect(JSON.stringify(found)).not.toContain("backoff");
  });

  test("DEAD lessons are not offered unless asked for", async () => {
    await workspace.setLifecycle("wiki/knowhow/retry-flaky-downloads.md", "dead");
    expect(workspace.knowhowFind("retry downloads backoff").ranked).toEqual([]);
    expect(workspace.knowhowFind("retry downloads backoff", 3, true).ranked).toHaveLength(1);
  });

  test("the context pack carries the best matches in their own group", async () => {
    const pack = await workspace.contextPack("windows path spaces shell command");
    expect(pack.knowhow.map((k) => k.title)).toEqual(["Quote Windows paths"]);
    expect(pack.knowhow[0]!.by).toBe("process:claude-code");

    const text = formatContextPack(pack);
    expect(text).toContain("## Relevant know-how");
    expect(text).toContain("wiki/knowhow/quote-windows-paths.md");

    const empty = await workspace.contextPack("windows path spaces shell command", { paraDepth: 2 });
    expect(empty.knowhow).toEqual([]);
  });

  test("at most three are offered", async () => {
    for (let n = 1; n <= 4; n++) {
      await workspace.knowhowAdd({
        title: `Marmot burrow lesson ${n}`,
        body: "marmot burrow lesson",
        actor: "process:tester",
      });
    }
    expect((await workspace.contextPack("marmot burrow lesson")).knowhow).toHaveLength(3);
  });
});

describe("know-how tools", () => {
  test("schemas", () => {
    const add = TOOLS.find((t) => t.name === "knowhow_add")!;
    expect(add.inputSchema.required).toEqual(["title", "body", "actor"]);
    expect(Object.keys(add.inputSchema.properties)).toEqual(["title", "body", "tags", "actor"]);
    const find = TOOLS.find((t) => t.name === "knowhow_find")!;
    expect(find.inputSchema.required).toEqual(["task"]);
    expect(Object.keys(find.inputSchema.properties)).toEqual(["task", "limit"]);
  });

  test("knowhow_add reports each missing piece", async () => {
    const run = (args: Record<string, unknown>) => callTool(workspace, "knowhow_add", args);
    expect((await run({})).content[0]!.text).toBe("'title' is required");
    expect((await run({ title: "t" })).content[0]!.text).toBe("'body' is required");
    const noActor = await run({ title: "t", body: "b" });
    expect(noActor.isError).toBe(true);
    expect(noActor.content[0]!.text).toContain("'actor' is required");

    const ok = await run({ title: "A lesson", body: "details", actor: "process:tester", tags: ["x", 1] });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).toBe("Recorded know-how wiki/knowhow/a-lesson.md");
  });

  test("knowhow_find answers plainly when nothing matches", async () => {
    expect((await callTool(workspace, "knowhow_find", {})).isError).toBe(true);
    const none = await callTool(workspace, "knowhow_find", { task: "nothing like this" });
    expect(none.isError).toBeUndefined();
    expect(none.content[0]!.text).toContain("No know-how matched");

    await callTool(workspace, "knowhow_add", { title: "Pitfall", body: "sqlite wal files", actor: "process:t" });
    const hit = await callTool(workspace, "knowhow_find", { task: "sqlite wal", limit: 99 });
    expect(JSON.parse(hit.content[0]!.text).ranked[0].title).toBe("Pitfall");
  });

  test("know-how is ordinary knowledge too: search finds it", async () => {
    await callTool(workspace, "knowhow_add", { title: "Pitfall", body: "sqlite wal files", actor: "process:t" });
    const hits = workspace.search("sqlite wal", { type: "Knowhow" });
    expect(hits.map((h) => h.id)).toEqual(["knowhow/pitfall"]);
  });
});

describe("know-how names that would not be plain concepts", () => {
  test("reserved basenames and Windows device names get a -note suffix", () => {
    // index/log are OKF-reserved, agents is the contract, map/human/task are workspace files.
    for (const title of ["index", "Index", "log", "agents", "map", "human", "task", "CON", "prn", "Aux", "nul", "COM1", "lpt9"]) {
      expect(knowhowSlug(title)).toBe(`${title.toLowerCase()}-note`);
    }
    for (const title of ["tasks", "console", "com10", "index of things", "logbook"]) {
      expect(knowhowSlug(title)).not.toEndWith("-note");
    }
  });

  test("a lesson titled like a reserved file is still a normal, indexed concept", async () => {
    const a = await workspace.knowhowAdd({ title: "Index", body: "never edit the index by hand", actor: "process:t" });
    const b = await workspace.knowhowAdd({ title: "NUL", body: "device names break file creation", actor: "process:t" });
    expect([a.path, b.path]).toEqual(["wiki/knowhow/index-note.md", "wiki/knowhow/nul-note.md"]);

    expect(workspace.listConcepts().map((c) => c.id)).toContain("knowhow/index-note");
    expect(workspace.search("never edit the index", { type: "Knowhow" }).map((h) => h.id)).toEqual(["knowhow/index-note"]);
    expect(workspace.knowhowFind("device names file creation").ranked.map((r) => r.path)).toEqual([
      "wiki/knowhow/nul-note.md",
    ]);
    const again = await workspace.knowhowAdd({ title: "index", body: "second", actor: "process:t" });
    expect(again.path).toBe("wiki/knowhow/index-note-2.md");
  });

  test("a free-path check that fails for any reason but not-found refuses", async () => {
    const bundle = workspace.requireBundle();
    expect(await bundle.exists("wiki/knowhow/nothing-here.md")).toBe(false);
    expect(await bundle.exists("wiki/knowhow/index.md")).toBe(true);
    await expect(bundle.exists("wiki/knowhow/bad\0name.md")).rejects.toThrow();
  });
});

describe("know-how in the context pack", () => {
  const TASK = "windows path spaces shell command";
  beforeEach(async () => {
    await workspace.knowhowAdd({
      title: "Quote Windows paths",
      body: "Quote any path with spaces before passing it to a shell command.",
      tags: ["windows", "shell"],
      actor: "process:claude-code",
    });
    await workspace.knowhowAdd({
      title: "Retry flaky downloads",
      body: "The release server drops connections; retry with backoff.",
      tags: ["network"],
      actor: "process:codex",
    });
  });

  const titles = async (options: Record<string, unknown>) =>
    (await workspace.contextPack(TASK, options)).knowhow.map((k) => k.title);

  test("follows the caller's path_prefix, tags and type", async () => {
    expect(await titles({})).toEqual(["Quote Windows paths"]);
    expect(await titles({ pathPrefix: "wiki/knowhow" })).toEqual(["Quote Windows paths"]);
    expect(await titles({ pathPrefix: "wiki/projects" })).toEqual([]);
    expect(await titles({ tags: ["windows"] })).toEqual(["Quote Windows paths"]);
    expect(await titles({ tags: ["network"] })).toEqual([]);
    expect(await titles({ tags: ["windows", "network"] })).toEqual([]);
    expect(await titles({ type: "Knowhow" })).toEqual(["Quote Windows paths"]);
    expect(await titles({ type: "Concept" })).toEqual([]);
  });

  test("is paid for from the same budget as the passages", async () => {
    const roomy = await workspace.contextPack(TASK, { budgetChars: 20000 });
    const entry = roomy.knowhow[0]!;
    const cost = entry.title.length + entry.description.length;
    const passages = workspace.retrieve(TASK, { budgetChars: 20000, limit: 8 });
    expect(roomy.usedChars).toBe(passages.usedChars + cost);

    // Room for the passages but not the lesson on top of them.
    const tight = await workspace.contextPack(TASK, { budgetChars: passages.usedChars + cost - 1 });
    expect(tight.knowhow).toEqual([]);
    expect(tight.truncated).toBe(true);
    expect(tight.usedChars).toBeLessThanOrEqual(tight.budgetChars);
  });
});
