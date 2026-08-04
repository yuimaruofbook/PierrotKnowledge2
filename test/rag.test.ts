/**
 * Retrieval over a real bundle, with Japanese content.
 *
 * Japanese is the case that a stock FTS5 setup silently gets wrong, so it is
 * tested as a first-class requirement rather than an edge case.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Workspace } from "../src/bun/workspace";
import { formatRetrieval, passageLocation } from "../src/bun/rag/retrieve";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

async function note(rel: string, frontmatter: string, body: string): Promise<void> {
  const abs = join(root, "wiki", rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, `---\n${frontmatter}\n---\n\n${body}`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-rag-test-"));
  await mkdir(join(root, "wiki"), { recursive: true });

  await note(
    "design.md",
    "type: Concept\ntitle: 設計原則\ntags: [design, okf]",
    [
      "# 設計原則",
      "",
      "## File over App",
      "",
      "ノートの正本は常にローカルの Markdown ファイル。アプリはビューアに過ぎない。",
      "",
      "## 最高軽量",
      "",
      "システム WebView を使い、不要な機能を削る。メモリとバイナリサイズを最優先する。",
    ].join("\n")
  );

  await note(
    "rag.md",
    "type: Playbook\ntitle: RAG構成\ntags: [rag, search]",
    [
      "# RAG構成",
      "",
      "## インデックス",
      "",
      "SQLite FTS5 で BM25 検索を行う。埋め込みは使わない。",
      "",
      "## チャンク分割",
      "",
      "見出し単位で分割し、見出しパスを添えて返す。",
    ].join("\n")
  );

  await note("english.md", "type: Note\ntitle: Lightweight notes\ntags: [design]", [
    "# Lightweight",
    "",
    "The application stays small by avoiding a bundled browser engine.",
  ].join("\n"));

  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("Japanese search", () => {
  test("finds a mid-sentence two-character word", () => {
    // The exact case a stock unicode61 index misses entirely.
    const hits = workspace.search("軽量");
    expect(hits.map((h) => h.id)).toContain("design");
  });

  test("finds a katakana word", () => {
    expect(workspace.search("ノート").map((h) => h.id)).toContain("design");
  });

  test("finds a longer phrase", () => {
    expect(workspace.search("見出しパス").map((h) => h.id)).toContain("rag");
  });

  test("a single character still matches, by prefix", () => {
    expect(workspace.search("軽").length).toBeGreaterThan(0);
  });

  test("does not match an unrelated word that shares a character", () => {
    // 「軽」 appears in the corpus but 「軽率」 does not.
    expect(workspace.search("軽率").map((h) => h.id)).not.toContain("design");
  });

  test("matches a title written only in Japanese", () => {
    expect(workspace.search("設計原則").map((h) => h.id)).toContain("design");
  });

  test("English still works alongside", () => {
    expect(workspace.search("lightweight").map((h) => h.id)).toContain("english");
  });

  test("search is case-insensitive", () => {
    expect(workspace.search("LIGHTWEIGHT").map((h) => h.id)).toContain("english");
  });
});

describe("chunk-level results", () => {
  test("a hit reports which section matched", () => {
    const [hit] = workspace.search("最高軽量");
    expect(hit?.id).toBe("design");
    expect(hit?.headingPath).toContain("最高軽量");
  });

  test("different queries hit different sections of one document", () => {
    const a = workspace.searchChunks("ローカル", { limit: 5 })[0];
    const b = workspace.searchChunks("バイナリサイズ", { limit: 5 })[0];
    // The document H1 stays in the trail: it is real structure, and it is what
    // makes a section citable as "設計原則 › 最高軽量".
    expect(a?.headingPath).toEqual(["設計原則", "File over App"]);
    expect(b?.headingPath).toEqual(["設計原則", "最高軽量"]);
  });

  test("snippets are readable prose, not bigrams", () => {
    const [hit] = workspace.search("軽量");
    expect(hit?.snippet).toContain("軽量");
    // A bigram-expanded snippet would be full of single-space-separated pairs.
    expect(hit?.snippet).not.toMatch(/(\S\S )(\S\S )(\S\S )/);
  });
});

describe("filters", () => {
  test("by type", () => {
    const hits = workspace.search("分割", { type: "Playbook" });
    expect(hits.every((h) => h.type === "Playbook")).toBe(true);
  });

  test("by tag", () => {
    const ids = workspace.search("軽量", { tags: ["design"] }).map((h) => h.id);
    expect(ids).toContain("design");
    expect(workspace.search("インデックス", { tags: ["design"] })).toHaveLength(0);
  });

  test("a tag filter does not match a prefix of another tag", () => {
    // "desi" must not match the tag "design".
    expect(workspace.search("軽量", { tags: ["desi"] })).toHaveLength(0);
  });

  test("by path prefix", () => {
    expect(workspace.search("軽量", { pathPrefix: "wiki/" }).length).toBeGreaterThan(0);
    expect(workspace.search("軽量", { pathPrefix: "nowhere/" })).toHaveLength(0);
  });
});

describe("tags and types", () => {
  test("counts tags across the bundle", () => {
    const tags = Object.fromEntries(workspace.tags().map((t) => [t.tag, t.count]));
    expect(tags.design).toBe(2);
    expect(tags.rag).toBe(1);
  });

  test("counts types", () => {
    const types = workspace.types().map((t) => t.tag);
    expect(types).toEqual(expect.arrayContaining(["Concept", "Playbook", "Note"]));
  });
});

describe("retrieve", () => {
  test("returns whole sections with citation anchors", () => {
    const result = workspace.retrieve("チャンク分割の方法");
    expect(result.passages.length).toBeGreaterThan(0);

    const passage = result.passages[0]!;
    expect(passage.anchor).toMatch(/\.md#/);
    expect(passage.path).toBe("wiki/rag.md");
    expect(passage.text).toContain("見出し");
  });

  test("respects the character budget and says when it truncated", () => {
    // Self-calibrating: measure what the query returns unconstrained, then
    // demand that half of that is actually enforced.
    const generous = workspace.retrieve("設計");
    expect(generous.usedChars).toBeGreaterThan(0);
    expect(generous.truncated).toBe(false);

    const cap = Math.floor(generous.usedChars / 2);
    const capped = workspace.retrieve("設計", { budgetChars: cap });
    expect(capped.usedChars).toBeLessThanOrEqual(cap);
    expect(capped.truncated).toBe(true);
  });

  test("caps how much any single document contributes", () => {
    const result = workspace.retrieve("設計", { limit: 10 });
    const perDoc = new Map<string, number>();
    for (const passage of result.passages) {
      perDoc.set(passage.id, (perDoc.get(passage.id) ?? 0) + 1);
    }
    expect(Math.max(...perDoc.values())).toBeLessThanOrEqual(3);
  });

  test("honours filters", () => {
    const result = workspace.retrieve("分割", { type: "Playbook" });
    expect(result.passages.every((p) => p.type === "Playbook")).toBe(true);
  });

  test("empty result is reported, not thrown", () => {
    const result = workspace.retrieve("まったく存在しない語句xyzzy");
    expect(result.passages).toHaveLength(0);
    expect(formatRetrieval(result)).toContain("No passages found");
  });

  test("formats passages with a source path an agent can cite", () => {
    const text = formatRetrieval(workspace.retrieve("BM25"));
    expect(text).toContain("wiki/rag.md");
    expect(text).toContain("anchor:");
  });

  test("answers a natural-language Japanese question", () => {
    // A question is a paraphrase, not a term: the words 検索 and 実装 do not
    // appear in the target chunk, so strict phrase matching finds nothing.
    const result = workspace.retrieve("チャンクはどう分割している？");
    expect(result.passages.map((p) => p.id)).toContain("rag");
  });

  test("answers a natural-language English question", () => {
    const result = workspace.retrieve("how does the app stay small?");
    expect(result.passages.map((p) => p.id)).toContain("english");
  });

  test("a nonsense question returns nothing rather than plausible noise", () => {
    // Loose OR matching would otherwise qualify a passage on one stray bigram.
    expect(workspace.retrieve("まったく存在しない語句xyzzy").passages).toHaveLength(0);
  });

  test("the location does not repeat a title that matches the H1", () => {
    const [passage] = workspace.retrieve("チャンク分割").passages;
    expect(passage).toBeDefined();
    const location = passageLocation(passage!);
    expect(location).toBe("RAG構成 › チャンク分割");
  });

  test("neighbour expansion adds adjacent sections", () => {
    const plain = workspace.retrieve("チャンク分割", { limit: 1 });
    const expanded = workspace.retrieve("チャンク分割", { limit: 1, expandNeighbours: true });
    expect(expanded.passages.length).toBeGreaterThan(plain.passages.length);
  });
});

describe("index maintenance", () => {
  test("a new note is searchable immediately after writing", async () => {
    await workspace.writeFile(
      "wiki/新規.md",
      "---\ntype: Note\ntitle: 新規ノート\n---\n\n特殊な用語ホゲフガ。\n"
    );
    expect(workspace.search("ホゲフガ").map((h) => h.id)).toContain("新規");
  });

  test("editing a note updates its chunks", async () => {
    await workspace.writeFile(
      "wiki/design.md",
      "---\ntype: Concept\ntitle: 設計原則\n---\n\n## 新章\n\n差し替えた内容。\n"
    );
    expect(workspace.search("差し替え").map((h) => h.id)).toContain("design");
    // The old content must be gone, not merely outranked.
    expect(workspace.search("バイナリサイズ").map((h) => h.id)).not.toContain("design");
  });

  test("a stub with a title but no body is still findable", async () => {
    await workspace.writeFile("wiki/stub.md", "---\ntype: Note\ntitle: スタブ頁\n---\n");
    expect(workspace.search("スタブ").map((h) => h.id)).toContain("stub");
  });

  test("index stats reflect chunking", () => {
    const stats = workspace.indexStats();
    expect(stats.documents).toBe(3);
    // design and rag each have several sections.
    expect(stats.chunks).toBeGreaterThan(stats.documents);
  });
});
