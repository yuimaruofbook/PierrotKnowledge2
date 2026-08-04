/**
 * Integration tests over a real temporary bundle on disk.
 *
 * The point of these is the write path: the UI and the MCP server share it, so
 * a regression here breaks both at once.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { messages } from "../src/shared/messages";
import { removeTempDir } from "./helpers";
import { tmpdir } from "os";
import { join } from "path";
import { Bundle } from "../src/bun/okf/bundle";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { Workspace } from "../src/bun/workspace";

let root: string;

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

const concept = (type: string, body = "") => `---\ntype: ${type}\n---\n\n${body}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-wiki-test-"));
});

afterEach(async () => {
  await removeTempDir(root);
});

describe("Bundle.open", () => {
  test("detects the wiki layer when wiki/ exists", async () => {
    await seed({ "wiki/a.md": concept("Concept") });
    const bundle = await Bundle.open(root);
    expect(bundle.paths.wikiDir).toBe("wiki");
    expect(bundle.getConcept("a")).toBeDefined();
  });

  test("treats a plain Markdown folder as the wiki layer", async () => {
    await seed({ "notes/a.md": concept("Note") });
    const bundle = await Bundle.open(root);
    expect(bundle.paths.wikiDir).toBe("");
    expect(bundle.getConcept("notes/a")).toBeDefined();
  });

  test("excludes raw/ from the concept map", async () => {
    await seed({ "wiki/a.md": concept("Concept"), "raw/source.md": concept("Raw") });
    const bundle = await Bundle.open(root);
    expect(bundle.allConcepts().map((c) => c.id)).toEqual(["a"]);
  });

  test("excludes reserved files from the concept map", async () => {
    await seed({ "wiki/index.md": "# Index\n", "wiki/log.md": "# Log\n" });
    const bundle = await Bundle.open(root);
    expect(bundle.allConcepts()).toHaveLength(0);
  });

  test("reports non-conformant documents without failing the open", async () => {
    await seed({ "wiki/good.md": concept("Concept"), "wiki/bad.md": "# no frontmatter\n" });
    const bundle = await Bundle.open(root);
    const issues = bundle.conformanceIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("wiki/bad.md");
  });

  test("rejects a path that is not a directory", async () => {
    await seed({ "file.md": concept("Concept") });
    await expect(Bundle.open(join(root, "file.md"))).rejects.toThrow();
  });
});

describe("link graph", () => {
  test("resolves wikilinks across directories and records backlinks", async () => {
    await seed({
      "wiki/a.md": concept("Concept", "links to [[topics/b]]"),
      "wiki/topics/b.md": concept("Concept", "back to [A](../a.md)"),
    });
    const bundle = await Bundle.open(root);

    expect(bundle.getConcept("a")?.links[0]?.resolved).toBe("topics/b");
    expect(bundle.backlinksOf("topics/b")).toEqual(["a"]);
    expect(bundle.backlinksOf("a")).toEqual(["topics/b"]);
  });

  test("resolveLink honours the linking document's directory", async () => {
    await seed({
      "wiki/a.md": concept("Concept"),
      "wiki/topics/b.md": concept("Concept"),
    });
    const bundle = await Bundle.open(root);
    expect(bundle.resolveLink("topics/b", "../a.md")).toBe("a");
    expect(bundle.resolveLink("a", "nope")).toBeNull();
  });
});

describe("Workspace writes", () => {
  const open = async () => {
    const workspace = new Workspace({ watch: false });
    await workspace.open(root);
    return workspace;
  };

  test("creates the reserved files on open", async () => {
    await seed({ "wiki/a.md": concept("Concept") });
    const workspace = await open();
    const info = await workspace.info();
    expect(info?.hasIndex).toBe(true);
    expect(info?.hasLog).toBe(true);
    await workspace.close();
  });

  test("writes a concept, indexes it and logs it", async () => {
    await seed({ "wiki/a.md": concept("Concept", "alpha") });
    const workspace = await open();

    await workspace.writeFile("wiki/b.md", concept("Concept", "bravo unique-token"), {
      actor: "process:test",
    });

    expect(workspace.search("unique-token").map((h) => h.id)).toEqual(["b"]);

    const log = await readFile(join(root, "wiki", "log.md"), "utf8");
    expect(log).toContain("process:test");
    expect(log).toContain("wiki/b.md");
    await workspace.close();
  });

  test("reports OKF warnings instead of refusing the write", async () => {
    await seed({ "wiki/a.md": concept("Concept") });
    const workspace = await open();

    const result = await workspace.writeFile("wiki/bad.md", "# no frontmatter\n");
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toBe(messages.missingFrontmatter);
    await workspace.close();
  });

  test("raw/ is the human's inbox, closed to agents", async () => {
    await seed({ "wiki/a.md": concept("Concept"), "raw/keep.md": "original" });
    const workspace = await open();

    // A person may put originals in — by hand, or via an import they triggered.
    await workspace.writeFile("raw/new.md", "dropped in", { actor: "human:local" });
    expect(await readFile(join(root, "raw", "new.md"), "utf8")).toBe("dropped in");

    // An agent may not: raw/ records what was received, and material an agent
    // produced was not received from anywhere.
    await expect(
      workspace.writeFile("raw/keep.md", "overwritten", { by: "agent" })
    ).rejects.toThrow(/人間/);
    expect(await readFile(join(root, "raw", "keep.md"), "utf8")).toBe("original");

    // The derived layer is open to both — it is rebuildable.
    await workspace.writeFile(".rag/scratch.md", "x", { by: "agent" });
    await workspace.close();
  });

  test("refuses to escape the bundle", async () => {
    await seed({ "wiki/a.md": concept("Concept") });
    const workspace = await open();
    await expect(workspace.writeFile("../escaped.md", "x")).rejects.toThrow(/バンドルの外/);
    await expect(workspace.readFile("../../etc/passwd")).rejects.toThrow(/バンドルの外/);
    await workspace.close();
  });

  test("read returns parsed frontmatter and backlinks", async () => {
    await seed({
      "wiki/a.md": concept("Playbook", "see [[b]]"),
      "wiki/b.md": concept("Concept", "target"),
    });
    const workspace = await open();

    const result = await workspace.readFile("wiki/b.md");
    expect(result.concept?.frontmatter.type).toBe("Concept");
    expect(result.backlinks).toEqual(["a"]);
    await workspace.close();
  });

  test("rebuildIndex lists every concept", async () => {
    await seed({
      "wiki/a.md": `---\ntype: Concept\ntitle: Alpha\ndescription: first | piped\n---\n`,
      "wiki/topics/b.md": concept("Note"),
    });
    const workspace = await open();

    const { rows } = await workspace.rebuildIndex();
    expect(rows).toBe(2);

    const index = await readFile(join(root, "wiki", "index.md"), "utf8");
    // OKF §8: sectioned bullet entries, bundle-absolute links, and the one
    // permitted frontmatter key on a root index.
    expect(index).toContain("okf_version: 0.2");
    expect(index).toContain("## Concepts");
    expect(index).toContain("* [Alpha](/a.md) - first | piped");
    expect(index).toContain("## topics");
    expect(index).toContain("](/topics/b.md)");
    expect(index).not.toContain("|----");
    await workspace.close();
  });

  test("rebuildRag drops rows for deleted concepts", async () => {
    await seed({ "wiki/a.md": concept("Concept", "findme"), "wiki/b.md": concept("Concept") });
    const workspace = await open();
    expect(workspace.search("findme")).toHaveLength(1);

    await rm(join(root, "wiki", "a.md"));
    const { indexed } = await workspace.rebuildRag();

    expect(indexed).toBe(1);
    expect(workspace.search("findme")).toHaveLength(0);
    await workspace.close();
  });

  test("search survives punctuation that is FTS5 syntax", async () => {
    await seed({ "wiki/a.md": concept("Concept", "hello world") });
    const workspace = await open();
    for (const query of ['"', "a OR", "NEAR(", "-x", "*", "a:b"]) {
      expect(() => workspace.search(query)).not.toThrow();
    }
    await workspace.close();
  });

  test("open is idempotent and does not leak the previous index", async () => {
    await seed({ "wiki/a.md": concept("Concept", "alpha") });
    const workspace = await open();
    await workspace.open(root);
    expect(workspace.search("alpha")).toHaveLength(1);
    await workspace.close();
  });
});

describe("scaffoldBundle", () => {
  test("creates the three-layer layout", async () => {
    const result = await scaffoldBundle(root);
    // The contract lives inside the wiki layer, not beside it.
    expect(result.created).toContain("wiki/AGENTS.md");
    expect(result.created).toContain("wiki/index.md");
    expect(result.created).toContain("wiki/log.md");

    const bundle = await Bundle.open(root);
    expect(bundle.paths.wikiDir).toBe("wiki");
    const info = await bundle.info();
    expect(info.hasAgentsMd).toBe(true);
    expect(info.hasRaw).toBe(true);
  });

  test("never overwrites existing content", async () => {
    await seed({ "AGENTS.md": "MY RULES" });
    const result = await scaffoldBundle(root);
    expect(result.created).not.toContain("AGENTS.md");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("MY RULES");
  });

  test("produces a conformant hello concept", async () => {
    await scaffoldBundle(root);
    const bundle = await Bundle.open(root);
    expect(bundle.conformanceIssues()).toEqual([]);
  });
});
