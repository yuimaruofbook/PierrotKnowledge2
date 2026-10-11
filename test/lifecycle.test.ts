/**
 * Lifecycle tags (Product / DEAD): the pure rules, the write path, and what
 * they do to search, retrieval and context packs.
 *
 * The claims under test: DEAD is a filter and not a deletion (the file, its
 * links and a way to find it all survive), the two tags can never coexist
 * after a write, and Product only ever nudges a ranking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  LIFECYCLE_TAGS,
  PRODUCT_WEIGHT,
  lifecycleOf,
  lifecycleWeight,
  parseLifecycle,
  withLifecycle,
} from "../src/shared/okf/lifecycle";
import { PARA_WEIGHTS } from "../src/shared/okf/para";
import { Workspace } from "../src/bun/workspace";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { callTool, TOOLS } from "../src/bun/mcp/tools";
import { removeTempDir } from "./helpers";

describe("lifecycle rules", () => {
  test("only the exact tags count, and DEAD beats Product", () => {
    expect(lifecycleOf(["x", "Product"])).toBe("product");
    expect(lifecycleOf(["DEAD"])).toBe("dead");
    expect(lifecycleOf(["Product", "DEAD"])).toBe("dead");
    expect(lifecycleOf(["other", 5, null])).toBe("none");
    expect(lifecycleOf(undefined)).toBe("none");
    // A bundle may already use these spellings for something else.
    expect(lifecycleOf(["product", "Dead", "PRODUCT", "dead"])).toBe("none");
    expect(lifecycleWeight(["product"])).toBe(1);
  });

  test("setting one removes the other and writes the canonical spelling", () => {
    expect(withLifecycle(["a", "DEAD", "b"], "product")).toEqual(["a", "b", "Product"]);
    expect(withLifecycle(["a", "Product", "b"], "product")).toEqual(["a", "Product", "b"]);
    expect(withLifecycle(["Product", "DEAD", "x"], "dead")).toEqual(["DEAD", "x"]);
    expect(withLifecycle(["DEAD", "Product", "DEAD"], "none")).toEqual([]);
    expect(withLifecycle(["a", 7], "dead")).toEqual(["a", 7, "DEAD"]);
    // Only the canonical spelling is removed; the author's own tags stay.
    expect(withLifecycle(["dead", "product", "DEAD"], "product")).toEqual(["dead", "product", "Product"]);
    expect(withLifecycle(["dead"], "none")).toEqual(["dead"]);
  });

  test("Product is a nudge smaller than one PARA step", () => {
    expect(lifecycleWeight(["Product"])).toBe(PRODUCT_WEIGHT);
    expect(lifecycleWeight(["x"])).toBe(1);
    expect(PRODUCT_WEIGHT).toBeGreaterThan(1);
    expect(PRODUCT_WEIGHT).toBeLessThan(PARA_WEIGHTS.area / PARA_WEIGHTS.resource);
    expect(LIFECYCLE_TAGS).toEqual({ product: "Product", dead: "DEAD" });
  });

  test("parseLifecycle is tolerant and rejects the rest", () => {
    expect(parseLifecycle(" Product ")).toBe("product");
    expect(parseLifecycle("DEAD")).toBe("dead");
    expect(parseLifecycle("none")).toBe("none");
    expect(parseLifecycle("alive")).toBeNull();
  });
});

let root: string;
let workspace: Workspace;

async function note(rel: string, frontmatter: string, body: string): Promise<void> {
  const abs = join(root, "wiki", rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, `---\n${frontmatter}\n---\n\n${body}`, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-life-test-"));
  await scaffoldBundle(root);
  await note("live.md", "type: Concept\ntitle: Live\ntags: [kappa]", "# Live\n\nthe quokka habitat survey notes");
  await note(
    "retired.md",
    "type: Concept\ntitle: Retired\ntags: [kappa, DEAD]",
    "# Retired\n\nthe quokka habitat survey notes"
  );
  await note("plain.md", "type: Concept\ntitle: Plain", "# Plain\n\nwombat burrow depth");
  // Lower-case spellings were someone's own tags before lifecycle existed.
  await note(
    "legacy.md",
    "type: Concept\ntitle: Legacy\ntags: [dead, product]",
    "# Legacy\n\nthe numbat termite census"
  );
  await note("shipped.md", "type: Concept\ntitle: Shipped\ntags: [Product]", "# Shipped\n\nwombat burrow depth");
  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

describe("DEAD is excluded by default", () => {
  test("search, retrieve and context_pack leave it out", async () => {
    expect(workspace.search("quokka").map((h) => h.id)).toEqual(["live"]);
    expect(workspace.retrieve("quokka habitat survey").passages.map((p) => p.id)).toEqual(["live"]);
    const pack = await workspace.contextPack("quokka habitat survey");
    expect(pack.files.map((f) => f.id)).toEqual(["live"]);
  });

  test("include_dead brings it back, and the DEAD tag finds exactly the retired files", async () => {
    expect(
      workspace
        .search("quokka", { includeDead: true })
        .map((h) => h.id)
        .sort()
    ).toEqual(["live", "retired"]);
    expect(workspace.search("quokka", { tags: ["DEAD"] })).toEqual([]);
    expect(workspace.search("quokka", { tags: ["DEAD"], includeDead: true }).map((h) => h.id)).toEqual([
      "retired",
    ]);
    expect(
      workspace
        .retrieve("quokka habitat survey", { includeDead: true })
        .passages.map((p) => p.id)
        .sort()
    ).toEqual(["live", "retired"]);
  });

  test("a bundle's own lower-case product / dead tags change nothing", async () => {
    expect(workspace.search("numbat").map((h) => h.id)).toEqual(["legacy"]);
    expect(workspace.retrieve("numbat termite census").passages.map((p) => p.id)).toEqual(["legacy"]);
    expect((await workspace.contextPack("numbat termite census")).files.map((f) => f.id)).toEqual(["legacy"]);
    expect(workspace.listConcepts().find((c) => c.id === "legacy")).not.toHaveProperty("lifecycle");
    // No Product nudge either: the score is the plain one.
    expect(workspace.search("numbat")[0]!.score).toBe(
      workspace.search("numbat", { includeDead: true })[0]!.score
    );
  });

  test("the UI search finds DEAD notes so a person can revive them", async () => {
    // The UI request handler passes includeDead; agents keep the default.
    const { createRequestHandlers } = await import("../src/bun/rpc");
    const handlers = createRequestHandlers(workspace, {} as never, {} as never);
    const hits = await handlers.search({ query: "quokka", limit: 20 });
    expect(hits.map((h) => h.id).sort()).toEqual(["live", "retired"]);
  });

  test("list_concepts still lists it, with its lifecycle", () => {
    const listed = workspace.listConcepts();
    expect(listed.find((c) => c.id === "retired")?.lifecycle).toBe("dead");
    expect(listed.find((c) => c.id === "shipped")?.lifecycle).toBe("product");
    expect(listed.find((c) => c.id === "plain")).not.toHaveProperty("lifecycle");
  });
});

describe("Product ranking", () => {
  test("multiplies the score by the Product weight and wins a tie", () => {
    const hits = workspace.search("wombat burrow depth");
    expect(hits.map((h) => h.id)).toEqual(["shipped", "plain"]);
    expect(hits[0]!.score / hits[1]!.score).toBeCloseTo(PRODUCT_WEIGHT, 10);
  });
});

describe("set_lifecycle", () => {
  test("adds the canonical tag through the write path: log row, reindex", async () => {
    const result = await workspace.setLifecycle("wiki/plain.md", "product", "process:tester");
    expect(result).toEqual({ path: "wiki/plain.md", lifecycle: "product", changed: true });

    const text = await readFile(join(root, "wiki", "plain.md"), "utf8");
    expect(text).toContain("Product");
    expect(text).toContain("# Plain");

    const audit = await workspace.auditChanges({ actor: "process:tester" });
    expect(audit.total).toBe(1);
    expect(audit.actors[0]!.entries[0]!.path).toBe("wiki/plain.md");
    expect(
      workspace
        .search("wombat", { tags: ["Product"] })
        .map((h) => h.id)
        .sort()
    ).toEqual(["plain", "shipped"]);
  });

  test("DEAD replaces Product, and none clears both", async () => {
    await workspace.setLifecycle("wiki/shipped.md", "dead");
    const tags = (await workspace.readFile("wiki/shipped.md")).concept!.frontmatter.tags;
    expect(tags).toEqual(["DEAD"]);
    expect(workspace.search("wombat").map((h) => h.id)).toEqual(["plain"]);

    await workspace.setLifecycle("wiki/shipped.md", "none");
    const concept = (await workspace.readFile("wiki/shipped.md")).concept!;
    expect(concept.frontmatter.tags).toBeUndefined();
    expect(workspace.search("wombat").map((h) => h.id)).toContain("shipped");
  });

  test("an unchanged lifecycle writes nothing", async () => {
    const before = (await workspace.auditChanges()).total;
    const result = await workspace.setLifecycle("wiki/retired.md", "dead");
    expect(result.changed).toBe(false);
    expect((await workspace.auditChanges()).total).toBe(before);
  });

  test("refuses what it cannot tag", async () => {
    await expect(workspace.setLifecycle("wiki/missing.md", "dead")).rejects.toThrow();
    await expect(workspace.setLifecycle("raw/README.md", "dead")).rejects.toThrow();
    await note("odd.md", "type: Concept\ntags: just-a-string", "x");
    await workspace.reloadBundle();
    await expect(workspace.setLifecycle("wiki/odd.md", "dead")).rejects.toThrow(/not a list/);
  });
});

describe("set_lifecycle edits only the tags entry", () => {
  /** Write `raw` as a concept, apply a lifecycle, and return the file as it is on disk. */
  async function applied(raw: string, to: "product" | "dead" | "none"): Promise<string> {
    await writeFile(join(root, "wiki", "raw.md"), raw, "utf8");
    await workspace.reloadBundle();
    await workspace.setLifecycle("wiki/raw.md", to, "process:tester");
    return readFile(join(root, "wiki", "raw.md"), "utf8");
  }

  test("flow tags: comments, quoting, key order and other values survive byte for byte", async () => {
    const head = "# keep me\ntype: Concept\ntitle: \"Quoted: title\"   # trailing\nversion: 1.10\nowner: 'o''brien'\n";
    const tail = "weird:   spaced\nnested:\n  a: 1\n  b: [x,   y]\n";
    const out = await applied(`---\n${head}tags: [kappa, "b c", 'it''s']  # why\n${tail}---\n\nbody\n`, "product");
    expect(out).toBe(`---\n${head}tags: [kappa, "b c", 'it''s', Product]  # why\n${tail}---\n\nbody\n`);
  });

  test("block tags keep their style, indent and comments", async () => {
    const raw = "---\ntype: Concept\ntags:\n  - kappa\n  # between\n  - DEAD\n  - \"b c\"\nversion: 1.10\n---\nbody\n";
    expect(await applied(raw, "product")).toBe(
      "---\ntype: Concept\ntags:\n  - kappa\n  # between\n  - \"b c\"\n  - Product\nversion: 1.10\n---\nbody\n"
    );
  });

  test("an item already written (even quoted) is kept as written", async () => {
    const raw = "---\ntype: Concept\ntags: [a, \"DEAD\", b]\nversion: 1.10\n---\nbody\n";
    expect(await applied(raw, "dead")).toBe(raw);
    expect(await applied(raw, "product")).toBe("---\ntype: Concept\ntags: [a, b, Product]\nversion: 1.10\n---\nbody\n");
  });

  test("absent, empty and null tags", async () => {
    expect(await applied("---\ntype: Concept\nversion: 1.10\n---\nbody\n", "dead")).toBe(
      "---\ntype: Concept\nversion: 1.10\ntags: [DEAD]\n---\nbody\n"
    );
    expect(await applied("---\ntype: Concept\ntags: []\nx: 1\n---\nbody\n", "dead")).toBe(
      "---\ntype: Concept\ntags: [DEAD]\nx: 1\n---\nbody\n"
    );
    expect(await applied("---\ntype: Concept\ntags:   # none yet\nx: 1\n---\nbody\n", "product")).toBe(
      "---\ntype: Concept\ntags: [Product] # none yet\nx: 1\n---\nbody\n"
    );
  });

  test("none removes an emptied entry and nothing else", async () => {
    expect(await applied("---\n# c\ntype: Concept\ntags: [DEAD] # x\nversion: 1.10\n---\nbody\n", "none")).toBe(
      "---\n# c\ntype: Concept\nversion: 1.10\n---\nbody\n"
    );
    expect(await applied("---\ntype: Concept\ntags:\n  - Product\nversion: 1.10\n---\nbody\n", "none")).toBe(
      "---\ntype: Concept\nversion: 1.10\n---\nbody\n"
    );
    expect(await applied("---\ntype: Concept\nversion: 1.10\ntags: [DEAD]\n---\nbody\n", "none")).toBe(
      "---\ntype: Concept\nversion: 1.10\n---\nbody\n"
    );
  });

  test("CRLF files stay CRLF", async () => {
    const out = await applied("---\r\ntype: Concept\r\nversion: 1.10\r\ntags:\r\n  - a\r\n---\r\nbody\r\n", "dead");
    expect(out).toBe("---\r\ntype: Concept\r\nversion: 1.10\r\ntags:\r\n  - a\r\n  - DEAD\r\n---\r\nbody\r\n");
    const absent = await applied("---\r\ntype: Concept\r\n---\r\nbody\r\n", "dead");
    expect(absent).toBe("---\r\ntype: Concept\r\ntags: [DEAD]\r\n---\r\nbody\r\n");
  });

  test("lower-case product / dead are the author's own tags and stay", async () => {
    expect(await applied("---\ntype: Concept\ntags: [dead, product]\n---\nbody\n", "dead")).toBe(
      "---\ntype: Concept\ntags: [dead, product, DEAD]\n---\nbody\n"
    );
    expect(await applied("---\ntype: Concept\ntags: [dead, Product]\n---\nbody\n", "none")).toBe(
      "---\ntype: Concept\ntags: [dead]\n---\nbody\n"
    );
  });

  test("a form it cannot edit safely is refused and the file is untouched", async () => {
    const raw = "---\ntype: Concept\ntags: &shared [a, b]\n---\nbody\n";
    await writeFile(join(root, "wiki", "raw.md"), raw, "utf8");
    await workspace.reloadBundle();
    await expect(workspace.setLifecycle("wiki/raw.md", "dead")).rejects.toThrow(/cannot be edited safely/);
    expect(await readFile(join(root, "wiki", "raw.md"), "utf8")).toBe(raw);
  });
});

describe("lifecycle tools", () => {
  test("set_lifecycle is listed with its schema", () => {
    const tool = TOOLS.find((t) => t.name === "set_lifecycle")!;
    expect(tool.inputSchema.required).toEqual(["path", "lifecycle"]);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["path", "lifecycle", "actor"]);
  });

  test("set_lifecycle validates its arguments and reports the outcome", async () => {
    expect((await callTool(workspace, "set_lifecycle", {})).isError).toBe(true);
    const badValue = await callTool(workspace, "set_lifecycle", { path: "wiki/plain.md", lifecycle: "alive" });
    expect(badValue.isError).toBe(true);
    expect(badValue.content[0]!.text).toContain("product | dead | none");

    const ok = await callTool(workspace, "set_lifecycle", {
      path: "wiki/plain.md",
      lifecycle: "DEAD",
      actor: "process:tester",
    });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).toContain("wiki/plain.md");

    const again = await callTool(workspace, "set_lifecycle", { path: "wiki/plain.md", lifecycle: "dead" });
    expect(again.content[0]!.text).toContain("nothing changed");
  });

  test("search, retrieve and context_pack take include_dead", async () => {
    const hidden = await callTool(workspace, "search", { query: "quokka" });
    expect(hidden.content[0]!.text).not.toContain("retired");
    const shown = await callTool(workspace, "search", { query: "quokka", tags: ["DEAD"], include_dead: true });
    expect(shown.content[0]!.text).toContain("retired");
    const packed = await callTool(workspace, "context_pack", {
      task: "quokka habitat survey",
      include_dead: true,
    });
    expect(packed.content[0]!.text).toContain("wiki/retired.md");
    const retrieved = await callTool(workspace, "retrieve", { query: "quokka habitat survey" });
    expect(retrieved.content[0]!.text).not.toContain("wiki/retired.md");
  });
});
