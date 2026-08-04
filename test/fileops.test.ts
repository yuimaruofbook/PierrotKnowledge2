/**
 * Move, rename and delete against a real bundle.
 *
 * The contract under test is that reorganising notes never silently breaks the
 * link graph — the failure that makes people stop reorganising at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Workspace } from "../src/bun/workspace";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

async function note(rel: string, body: string, type = "Concept"): Promise<void> {
  const abs = join(root, "wiki", rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, `---\ntype: ${type}\n---\n\n${body}\n`, "utf8");
}

const read = (rel: string) => readFile(join(root, rel), "utf8");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-fileops-test-"));
  await mkdir(join(root, "wiki"), { recursive: true });
  await mkdir(join(root, "raw"), { recursive: true });
  workspace = new Workspace({ watch: false });
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("rename", () => {
  test("updates inbound wikilinks", async () => {
    await note("target.md", "I am the target.");
    await note("source.md", "See [[target]] for details.");
    await workspace.open(root);

    const result = await workspace.move("wiki/target.md", "wiki/renamed.md");

    expect(result.linkCount).toBe(1);
    expect(result.updated).toEqual(["wiki/source.md"]);
    expect(await read("wiki/source.md")).toContain("[[renamed|target]]");
  });

  test("updates inbound relative Markdown links", async () => {
    await note("target.md", "I am the target.");
    await note("deep/source.md", "See [T](../target.md).");
    await workspace.open(root);

    await workspace.move("wiki/target.md", "wiki/renamed.md");
    expect(await read("wiki/deep/source.md")).toContain("(../renamed.md)");
  });

  test("moving into a subdirectory rebases the document's own links", async () => {
    await note("a.md", "See [B](./b.md).");
    await note("b.md", "I am B.");
    await workspace.open(root);

    await workspace.move("wiki/a.md", "wiki/deep/a.md");

    // `a` moved down a level, so its link to `b` must climb back up.
    expect(await read("wiki/deep/a.md")).toContain("(../b.md)");
  });

  test("links inside code blocks are left alone", async () => {
    await note("target.md", "target");
    await note("source.md", "```\n[[target]]\n```\n\nreal [[target]]");
    await workspace.open(root);

    await workspace.move("wiki/target.md", "wiki/renamed.md");

    const source = await read("wiki/source.md");
    expect(source).toContain("```\n[[target]]\n```");
    expect(source).toContain("[[renamed|target]]");
  });

  test("the index follows the move", async () => {
    await note("target.md", "unique-token-here");
    await workspace.open(root);
    await workspace.move("wiki/target.md", "wiki/renamed.md");

    const hits = workspace.search("unique-token-here");
    expect(hits.map((h) => h.id)).toEqual(["renamed"]);
  });

  test("backlinks are rebuilt around the new id", async () => {
    await note("target.md", "target");
    await note("source.md", "[[target]]");
    await workspace.open(root);

    await workspace.move("wiki/target.md", "wiki/renamed.md");

    expect(workspace.requireBundle().backlinksOf("renamed")).toEqual(["source"]);
    expect(workspace.requireBundle().backlinksOf("target")).toEqual([]);
  });

  test("the move is recorded in log.md", async () => {
    await note("target.md", "t");
    await workspace.open(root);
    await workspace.move("wiki/target.md", "wiki/renamed.md", "process:test");

    const log = await read("wiki/log.md");
    // OKF §9: date-grouped prose entries with a conventional leading word.
    expect(log).toMatch(/^## \d{4}-\d{2}-\d{2}$/m);
    expect(log).toContain("**Move**");
    expect(log).toContain("process:test");
  });

  test("refuses to overwrite an existing file", async () => {
    await note("a.md", "a");
    await note("b.md", "b");
    await workspace.open(root);

    await expect(workspace.move("wiki/a.md", "wiki/b.md")).rejects.toThrow(/既に存在します/);
    expect(await read("wiki/b.md")).toContain("b");
  });

  test("refuses an agent moving a file into raw/", async () => {
    await note("a.md", "a");
    await workspace.open(root);
    // A person may file something back into their own inbox; an agent may not
    // put its own output there and call it a source.
    await expect(
      workspace.move("wiki/a.md", "raw/a.md", "process:test", "agent")
    ).rejects.toThrow(/人間/);
  });

  test("refuses to move out of the bundle", async () => {
    await note("a.md", "a");
    await workspace.open(root);
    await expect(workspace.move("wiki/a.md", "../escaped.md")).rejects.toThrow(/バンドルの外/);
  });

  test("a missing source is reported", async () => {
    await note("a.md", "a");
    await workspace.open(root);
    await expect(workspace.move("wiki/nope.md", "wiki/x.md")).rejects.toThrow(/見つかりません/);
  });
});

describe("delete", () => {
  test("removes the file and reindexes", async () => {
    await note("doomed.md", "unique-doomed-token");
    await workspace.open(root);

    const result = await workspace.delete("wiki/doomed.md");

    expect(result.deleted).toBe("wiki/doomed.md");
    expect(workspace.search("unique-doomed-token")).toHaveLength(0);
    expect(workspace.requireBundle().getConcept("doomed")).toBeUndefined();
  });

  test("reports which concepts are left with broken links", async () => {
    await note("doomed.md", "doomed");
    await note("source.md", "[[doomed]]");
    await workspace.open(root);

    const result = await workspace.delete("wiki/doomed.md");
    // Rewriting them would destroy the record that something used to be there.
    expect(result.brokenLinksFrom).toEqual(["source"]);
    expect(await read("wiki/source.md")).toContain("[[doomed]]");
  });

  test("refuses to delete reserved files", async () => {
    await note("a.md", "a");
    await workspace.open(root);
    await expect(workspace.delete("wiki/index.md")).rejects.toThrow(/予約ファイル/);
    await expect(workspace.delete("wiki/log.md")).rejects.toThrow(/予約ファイル/);
  });

  test("refuses to delete from the immutable layer", async () => {
    await writeFile(join(root, "raw", "source.txt"), "original", "utf8");
    await note("a.md", "a");
    await workspace.open(root);

    await expect(workspace.delete("raw/source.txt", "process:test", "agent")).rejects.toThrow(
      /人間/
    );
    expect(await read("raw/source.txt")).toBe("original");
  });
});

describe("directories", () => {
  test("creates a directory", async () => {
    await note("a.md", "a");
    await workspace.open(root);
    await workspace.createDirectory("wiki/topics");

    const nodes = await workspace.listDir("wiki");
    expect(nodes.some((n) => n.name === "topics" && n.type === "dir")).toBe(true);
  });

  test("refuses to create one inside the immutable layer", async () => {
    await note("a.md", "a");
    await workspace.open(root);
    await expect(workspace.createDirectory("raw/nope", "agent")).rejects.toThrow(/人間/);
  });
});

describe("unresolved links", () => {
  test("reports wikilinks with no target", async () => {
    await note("a.md", "See [[nowhere]] and [[also-missing]].");
    await workspace.open(root);

    const gaps = workspace.unresolvedLinks();
    expect(gaps.map((g) => g.target).sort()).toEqual(["also-missing", "nowhere"]);
    expect(gaps.every((g) => g.from === "a")).toBe(true);
  });

  test("a resolved link is not reported", async () => {
    await note("a.md", "See [[b]].");
    await note("b.md", "b");
    await workspace.open(root);
    expect(workspace.unresolvedLinks()).toEqual([]);
  });
});

describe("concept listing", () => {
  test("lists ids, titles and types for the quick switcher", async () => {
    await writeFile(
      join(root, "wiki", "titled.md"),
      "---\ntype: Playbook\ntitle: My Title\n---\n\nbody\n",
      "utf8"
    );
    await note("untitled.md", "body");
    await workspace.open(root);

    const list = workspace.listConcepts();
    expect(list).toEqual([
      { id: "titled", path: "wiki/titled.md", title: "My Title", type: "Playbook" },
      { id: "untitled", path: "wiki/untitled.md", title: "untitled", type: "Concept" },
    ]);
  });
});
