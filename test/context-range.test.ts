/**
 * Context range: how far down the PARA priority order, and how many links
 * away from the retrieved files, a pack or a retrieval may reach.
 *
 * `para_depth` narrows what is read; `link_depth` widens it by pointers only
 * (one-line descriptions, never bodies) and stays inside the same budget, so
 * neither can make an answer larger than the caller asked for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Workspace } from "../src/bun/workspace";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { callTool, TOOLS } from "../src/bun/mcp/tools";
import { formatContextPack } from "../src/bun/rag/context-pack";
import { removeTempDir } from "./helpers";

let root: string;
let workspace: Workspace;

async function note(rel: string, frontmatter: string, body: string): Promise<void> {
  const abs = join(root, "wiki", rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, `---\n${frontmatter}\n---\n\n${body}`, "utf8");
}

const TOPIC = "marmoset canopy telemetry";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-range-test-"));
  await scaffoldBundle(root);
  await note("1-projects/p.md", "type: Concept\ntitle: P", `# P\n\n${TOPIC} for the project`);
  await note("2-areas/a.md", "type: Concept\ntitle: A", `# A\n\n${TOPIC} for the area`);
  await note("3-resources/r.md", "type: Concept\ntitle: R", `# R\n\n${TOPIC} for the resource`);
  await note("loose.md", "type: Concept\ntitle: Loose", `# Loose\n\n${TOPIC} filed nowhere`);
  await note("4-archive/z.md", "type: Concept\ntitle: Z", `# Z\n\n${TOPIC} for the archive`);

  // A chain: head -> mid -> tail, plus a dead and an archived neighbour.
  await note(
    "head.md",
    "type: Concept\ntitle: Head\ndescription: the entry point",
    "# Head\n\nzebu pasture rotation plan. See [[mid]] and [[retired-link]] and [[4-archive/old-link]]."
  );
  await note(
    "mid.md",
    "type: Concept\ntitle: Mid\ndescription: the middle step",
    "# Mid\n\nSecret body text that must never be copied. Next is [[tail]] and back to [[head]]."
  );
  await note("tail.md", "type: Concept\ntitle: Tail\ndescription: the far end", "# Tail\n\nthe end");
  await note("retired-link.md", "type: Concept\ntitle: Retired link\ntags: [DEAD]\ndescription: gone", "# R\n\nx");
  await note("4-archive/old-link.md", "type: Concept\ntitle: Old link\ndescription: shelved", "# O\n\nx");

  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

const ids = (r: { passages: Array<{ id: string }> }) => [...new Set(r.passages.map((p) => p.id))].sort();

describe("para_depth", () => {
  test("defaults to everything, as before", () => {
    expect(ids(workspace.retrieve(TOPIC))).toEqual(["1-projects/p", "2-areas/a", "3-resources/r", "4-archive/z", "loose"]);
  });

  test("1 reads projects only, 2 adds areas, 3 adds resources and unfiled, 4 adds the archive", () => {
    expect(ids(workspace.retrieve(TOPIC, { paraDepth: 1 }))).toEqual(["1-projects/p"]);
    expect(ids(workspace.retrieve(TOPIC, { paraDepth: 2 }))).toEqual(["1-projects/p", "2-areas/a"]);
    expect(ids(workspace.retrieve(TOPIC, { paraDepth: 3 }))).toEqual([
      "1-projects/p",
      "2-areas/a",
      "3-resources/r",
      "loose",
    ]);
    expect(ids(workspace.retrieve(TOPIC, { paraDepth: 4 }))).toHaveLength(5);
  });

  test("applies to the context pack", async () => {
    const pack = await workspace.contextPack(TOPIC, { paraDepth: 2 });
    expect(pack.files.map((f) => f.id).sort()).toEqual(["1-projects/p", "2-areas/a"]);
  });
});

describe("link_depth", () => {
  test("0 changes nothing", async () => {
    const pack = await workspace.contextPack("zebu pasture rotation plan");
    expect(pack.linked).toEqual([]);
    expect(formatContextPack(pack)).not.toContain("Linked");
    expect(workspace.retrieve("zebu pasture rotation plan").linked).toBeUndefined();
  });

  test("1 adds the neighbours' one-line descriptions, not their bodies", async () => {
    const pack = await workspace.contextPack("zebu pasture rotation plan", { linkDepth: 1 });
    expect(pack.files.map((f) => f.id)).toEqual(["head"]);
    // The DEAD neighbour is hidden; the archived one is within the default depth.
    expect(pack.linked.map((l) => [l.id, l.hops])).toEqual([
      ["mid", 1],
      ["4-archive/old-link", 1],
    ]);
    expect(pack.linked[0]).toEqual({
      path: "wiki/mid.md",
      id: "mid",
      title: "Mid",
      type: "Concept",
      description: "the middle step",
      hops: 1,
      from: "wiki/head.md",
    });

    const text = formatContextPack(pack);
    expect(text).toContain("## Linked files");
    expect(text).toContain("the middle step");
    expect(text).not.toContain("Secret body text");
  });

  test("2 follows another hop and never revisits a file", async () => {
    const pack = await workspace.contextPack("zebu pasture rotation plan", { linkDepth: 2 });
    expect(pack.linked.map((l) => [l.id, l.hops])).toEqual([
      ["mid", 1],
      ["4-archive/old-link", 1],
      ["tail", 2],
    ]);
  });

  test("links are resolved against the pages that exist now", async () => {
    // The link is written while its target does not exist, and the target
    // comes later: the page keeps the unresolved link it was parsed with.
    await workspace.writeFile(
      "wiki/early.md",
      "---\ntype: Concept\ntitle: Early\n---\n\nokapi glade inventory. See [[late]].",
      { by: "agent" }
    );
    await workspace.writeFile(
      "wiki/late.md",
      "---\ntype: Concept\ntitle: Late\ndescription: made later\n---\n\nx",
      { by: "agent" }
    );
    const pack = await workspace.contextPack("okapi glade inventory", { linkDepth: 1 });
    expect(pack.linked.map((l) => l.id)).toEqual(["late"]);
  });

  test("honours para_depth and include_dead", async () => {
    const shallow = await workspace.contextPack("zebu pasture rotation plan", { linkDepth: 1, paraDepth: 3 });
    expect(shallow.linked.map((l) => l.id)).toEqual(["mid"]);

    const withDead = await workspace.contextPack("zebu pasture rotation plan", { linkDepth: 1, includeDead: true });
    expect(withDead.linked.map((l) => l.id)).toEqual(["mid", "retired-link", "4-archive/old-link"]);
  });

  test("honours type, tags and path_prefix like the passages do", async () => {
    await note(
      "pool/lead.md",
      "type: Concept\ntitle: Lead\ntags: [x]",
      "# Lead\n\nquail roost census. See [[pool/same]], [[pool/other-type]], [[pool/other-tag]] and [[elsewhere/far]]."
    );
    await note("pool/same.md", "type: Concept\ntitle: Same\ntags: [x]\ndescription: kept", "# S\n\nx");
    await note("pool/other-type.md", "type: Reference\ntitle: Other type\ntags: [x]\ndescription: wrong type", "# T\n\nx");
    await note("pool/other-tag.md", "type: Concept\ntitle: Other tag\ndescription: no tag", "# G\n\nx");
    await note("elsewhere/far.md", "type: Concept\ntitle: Far\ntags: [x]\ndescription: wrong folder", "# F\n\nx");
    await workspace.reloadBundle();

    const linked = async (filters: Record<string, unknown>) =>
      (await workspace.contextPack("quail roost census", { linkDepth: 1, ...filters })).linked.map((l) => l.id).sort();

    expect(await linked({})).toEqual(["elsewhere/far", "pool/other-tag", "pool/other-type", "pool/same"]);
    expect(await linked({ type: "Concept" })).toEqual(["elsewhere/far", "pool/other-tag", "pool/same"]);
    expect(await linked({ tags: ["x"] })).toEqual(["elsewhere/far", "pool/other-type", "pool/same"]);
    expect(await linked({ pathPrefix: "wiki/pool" })).toEqual(["pool/other-tag", "pool/other-type", "pool/same"]);
    expect(await linked({ type: "Concept", tags: ["x"], pathPrefix: "wiki/pool" })).toEqual(["pool/same"]);
    // retrieve takes the same rule.
    const direct = workspace.retrieve("quail roost census", { linkDepth: 1, type: "Concept", tags: ["x"], pathPrefix: "wiki/pool" });
    expect(direct.linked!.map((l) => l.id)).toEqual(["pool/same"]);
  });

  test("stays inside the character budget and says so when it cuts", async () => {
    const full = await workspace.contextPack("zebu pasture rotation plan", { linkDepth: 2 });
    const passages = full.usedChars - full.linked.reduce((n, l) => n + l.title.length + (l.description?.length ?? 0), 0);

    const tight = await workspace.contextPack("zebu pasture rotation plan", {
      linkDepth: 2,
      budgetChars: passages + 20,
    });
    expect(tight.usedChars).toBeLessThanOrEqual(passages + 20);
    expect(tight.linked.length).toBeLessThan(full.linked.length);
    expect(tight.truncated).toBe(true);
  });

  test("retrieve gets the same group", () => {
    const result = workspace.retrieve("zebu pasture rotation plan", { linkDepth: 1 });
    expect(result.linked!.map((l) => l.id)).toEqual(["mid", "4-archive/old-link"]);
  });
});

describe("tool arguments", () => {
  test("schemas name the new parameters", () => {
    for (const name of ["retrieve", "context_pack"]) {
      const props = TOOLS.find((t) => t.name === name)!.inputSchema.properties;
      expect(Object.keys(props)).toContain("para_depth");
      expect(Object.keys(props)).toContain("link_depth");
      expect(Object.keys(props)).toContain("include_dead");
    }
    expect(Object.keys(TOOLS.find((t) => t.name === "search")!.inputSchema.properties)).toContain("include_dead");
  });

  test("out-of-range values are rejected, not clamped", async () => {
    for (const args of [{ para_depth: 0 }, { para_depth: 5 }, { para_depth: 1.5 }, { para_depth: "2" }]) {
      const r = await callTool(workspace, "retrieve", { query: TOPIC, ...args });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("para_depth must be an integer from 1 to 4");
    }
    for (const args of [{ link_depth: -1 }, { link_depth: 3 }, { link_depth: 0.5 }]) {
      const r = await callTool(workspace, "context_pack", { task: TOPIC, ...args });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("link_depth must be an integer from 0 to 2");
    }
  });

  test("valid values reach the pack", async () => {
    const narrow = await callTool(workspace, "context_pack", { task: TOPIC, para_depth: 1 });
    expect(narrow.content[0]!.text).toContain("wiki/1-projects/p.md");
    expect(narrow.content[0]!.text).not.toContain("wiki/2-areas/a.md");

    const linked = await callTool(workspace, "retrieve", { query: "zebu pasture rotation plan", link_depth: 1 });
    expect(linked.content[0]!.text).toContain("Linked files");
    expect(linked.content[0]!.text).toContain("wiki/mid.md");
  });
});
