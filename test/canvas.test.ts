/**
 * Canvases, typed relations, the graph schema and SYSTEMMAP.md.
 *
 * The claims under test: a canvas is checked against JSON Canvas 1.0 within
 * fixed bounds and saved exactly as given; the layout of a link graph is
 * deterministic whatever order the concepts arrive in; a typed relation counts
 * as a link everywhere a body link does; a schema produces warnings (never
 * errors) and only when it exists; SYSTEMMAP.md refreshes its marked section
 * and nothing else; and hostile input answers with errors, quickly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_CANVAS_BYTES,
  MAX_CANVAS_EDGES,
  MAX_CANVAS_NODES,
  buildGraphCanvas,
  canvasOutline,
  compareCodePoints,
  describeCanvasErrors,
  groupParents,
  parseCanvas,
  parseGraphSchema,
  readRelations,
  renderSystemMap,
  schemaWarnings,
  serializeCanvas,
  validateCanvas,
  SYSTEMMAP_END,
  SYSTEMMAP_START,
  type Canvas,
  type GraphConcept,
} from "../src/shared/okf";
import { Workspace } from "../src/bun/workspace";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { callTool, TOOLS } from "../src/bun/mcp/tools";
import { removeTempDir } from "./helpers";

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...extra,
});

// ---- the spec ------------------------------------------------------------------------

describe("JSON Canvas validation", () => {
  test("an empty canvas and a full one are valid; unknown keys are fine", () => {
    expect(validateCanvas({})).toEqual([]);
    expect(validateCanvas({ nodes: [], edges: [], metadata: { a: 1 } })).toEqual([]);
    const full = {
      nodes: [
        node("a", { color: "3", extra: [1, 2] }),
        { id: "f", type: "file", file: "wiki/x.md", subpath: "#H", x: -5, y: 5, width: 10, height: 10, color: "#FF00aa" },
        { id: "l", type: "link", url: "https://example.com", x: 0, y: 0, width: 10, height: 10 },
        { id: "g", type: "group", label: "G", background: "bg.png", backgroundStyle: "ratio", x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [
        { id: "e", fromNode: "a", toNode: "f", fromSide: "right", toSide: "left", fromEnd: "none", toEnd: "arrow", color: "1", label: "x" },
      ],
    };
    expect(validateCanvas(full)).toEqual([]);
  });

  test("every field is checked, and the message says where", () => {
    expect(validateCanvas([])).toEqual(["the canvas must be a JSON object"]);
    expect(validateCanvas({ nodes: {} })).toEqual(["nodes must be an array"]);
    expect(validateCanvas({ nodes: [5] })).toEqual(["nodes[0] must be an object"]);
    expect(validateCanvas({ nodes: [node("a", { type: "image" })] })).toEqual([
      "nodes[0].type must be text, file, link or group",
    ]);
    expect(validateCanvas({ nodes: [node("a", { x: 1.5 })] })[0]).toBe("nodes[0].x must be an integer from -10000000 to 10000000");
    expect(validateCanvas({ nodes: [node("a", { width: 0 })] })[0]).toBe("nodes[0].width must be an integer from 1 to 10000000");
    expect(validateCanvas({ nodes: [node("a", { color: "7" })] })[0]).toBe('nodes[0].color must be "1" to "6" or a #hex colour');
    expect(validateCanvas({ nodes: [node("a", { color: "#12" })] })).toHaveLength(1);
    expect(validateCanvas({ nodes: [node("a", { text: 5 })] })).toEqual(["nodes[0].text must be a string"]);
    expect(validateCanvas({ nodes: [{ ...node("a"), type: "file", text: undefined }] })).toEqual([
      "nodes[0].file must be a non-empty path",
    ]);
    expect(validateCanvas({ nodes: [{ ...node("a"), type: "file", file: "x.md", subpath: "H" }] })).toEqual([
      "nodes[0].subpath must be a string starting with #",
    ]);
    expect(validateCanvas({ nodes: [{ ...node("a"), type: "link" }] })).toEqual(["nodes[0].url must be a non-empty string"]);
    expect(validateCanvas({ nodes: [{ ...node("a"), type: "group", backgroundStyle: "tile" }] })).toEqual([
      "nodes[0].backgroundStyle must be cover, ratio or repeat",
    ]);
    expect(validateCanvas({ nodes: [node("a"), node("a")] })).toEqual(["nodes[1].id 'a' is used twice"]);
    expect(validateCanvas({ nodes: [node("")] })[0]).toContain("nodes[0].id must be a non-empty string");
  });

  test("edges must join existing nodes and use the spec's sides and ends", () => {
    const nodes = [node("a"), node("b")];
    const edge = (extra: Record<string, unknown>) => ({ edges: [{ id: "e", fromNode: "a", toNode: "b", ...extra }], nodes });
    expect(validateCanvas(edge({}))).toEqual([]);
    expect(validateCanvas(edge({ toNode: "zz" }))).toEqual(["edges[0].toNode 'zz' is not a node"]);
    expect(validateCanvas(edge({ fromNode: 3 }))).toEqual(["edges[0].fromNode must be a node id"]);
    expect(validateCanvas(edge({ fromSide: "middle" }))).toEqual(["edges[0].fromSide must be top, right, bottom or left"]);
    expect(validateCanvas(edge({ toEnd: "dot" }))).toEqual(["edges[0].toEnd must be none or arrow"]);
    expect(validateCanvas(edge({ label: 4 }))).toEqual(["edges[0].label must be a string"]);
    expect(validateCanvas({ nodes, edges: [{ id: "e", fromNode: "a", toNode: "b" }, { id: "e", fromNode: "a", toNode: "b" }] })).toEqual([
      "edges[1].id 'e' is used twice",
    ]);
  });

  test("errors are capped in the message and counted", () => {
    const errors = Array.from({ length: 14 }, (_, i) => `e${i}`);
    expect(describeCanvasErrors(errors)).toBe(`${errors.slice(0, 10).join("; ")}; and 4 more`);
    expect(describeCanvasErrors(["only"])).toBe("only");
  });

  test("parseCanvas separates not-JSON from not-a-canvas", () => {
    expect(parseCanvas("")).toEqual({ ok: false, errors: ["the content is not valid JSON"] });
    expect(parseCanvas("{")).toEqual({ ok: false, errors: ["the content is not valid JSON"] });
    expect(parseCanvas("[]")).toEqual({ ok: false, errors: ["the canvas must be a JSON object"] });
    const ok = parseCanvas('{"nodes":[],"edges":[]}');
    expect(ok.ok).toBe(true);
  });
});

describe("hostile canvases answer with errors, quickly", () => {
  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const start = performance.now();
    const value = fn();
    return { value, ms: performance.now() - start };
  };

  test("too many nodes or edges", () => {
    const nodes = Array.from({ length: MAX_CANVAS_NODES + 1 }, (_, i) => node(`n${i}`));
    const { value, ms } = timed(() => parseCanvas(JSON.stringify({ nodes })));
    expect(value).toEqual({ ok: false, errors: [`too many nodes: the limit is ${MAX_CANVAS_NODES}`] });
    expect(ms).toBeLessThan(1000);
    const edges = Array.from({ length: 5001 }, (_, i) => ({ id: `e${i}`, fromNode: "a", toNode: "a" }));
    expect(parseCanvas(JSON.stringify({ nodes: [node("a")], edges }))).toEqual({
      ok: false,
      errors: ["too many edges: the limit is 5000"],
    });
  });

  test("a bracket bomb never reaches the parser", () => {
    const { value, ms } = timed(() => parseCanvas("[".repeat(200_000)));
    expect(value).toEqual({ ok: false, errors: ["the canvas is nested deeper than 32 levels"] });
    expect(ms).toBeLessThan(1000);
    const deepKey = `{"nodes":[],"x":${"[".repeat(40)}${"]".repeat(40)}}`;
    expect(parseCanvas(deepKey).ok).toBe(false);
    // Brackets inside strings do not count.
    expect(parseCanvas(`{"nodes":[${JSON.stringify(node("a", { text: "[".repeat(100) }))}]}`).ok).toBe(true);
  });

  test("an oversized file is refused by size first", () => {
    const { value } = timed(() => parseCanvas(`{"x":"${"a".repeat(MAX_CANVAS_BYTES)}"}`));
    expect(value).toEqual({ ok: false, errors: [`the canvas is larger than ${MAX_CANVAS_BYTES} bytes`] });
  });

  test("groups that contain each other cannot loop", () => {
    const same = (id: string) => ({ id, type: "group", label: id, x: 0, y: 0, width: 500, height: 500 });
    const nodes = [same("g1"), same("g2"), same("g3"), node("t", { x: 10, y: 10 })] as never;
    const parents = groupParents(nodes);
    // Earlier-drawn groups hold later ones; nothing is its own ancestor.
    expect(parents).toEqual([-1, 0, 1, 2]);

    const many = [
      ...Array.from({ length: 1000 }, (_, i) => ({ id: `g${i}`, type: "group", x: 0, y: 0, width: 900, height: 900 })),
      ...Array.from({ length: 1000 }, (_, i) => node(`n${i}`, { x: 1, y: 1 })),
    ] as never;
    const { value, ms } = timed(() => canvasOutline({ nodes: many }, () => null));
    expect(value).toContain("## Group [g999]");
    expect(ms).toBeLessThan(5000);
  });
});

describe("outline", () => {
  const canvas: Canvas = {
    nodes: [
      { id: "g", type: "group", label: "Core", x: 0, y: 0, width: 600, height: 400 },
      { id: "a", type: "file", file: "wiki/3-resources/a.md", x: 10, y: 10, width: 100, height: 50 },
      { id: "b", type: "text", text: "\n\nIdea one\nsecond line", x: 200, y: 10, width: 100, height: 50 },
      { id: "c", type: "link", url: "https://example.com", x: 900, y: 0, width: 100, height: 50 },
      { id: "d", type: "file", file: "wiki/missing.md", subpath: "#H", x: 900, y: 100, width: 100, height: 50 },
    ],
    edges: [
      { id: "e1", fromNode: "a", toNode: "b" },
      { id: "e2", fromNode: "b", toNode: "c", label: "depends_on", toEnd: "none" },
      { id: "e3", fromNode: "c", toNode: "a", fromEnd: "arrow" },
      { id: "e4", fromNode: "c", toNode: "d", fromEnd: "arrow", toEnd: "none", label: "" },
    ],
  };
  const resolve = (file: string) =>
    file === "wiki/3-resources/a.md" ? { title: "Alpha", description: "The first" } : null;

  test("groups, resolved file nodes and labelled edges", () => {
    expect(canvasOutline(canvas, resolve, "wiki/c.canvas")).toBe(
      [
        "Canvas wiki/c.canvas: 5 nodes, 4 edges",
        "",
        "## Group [g] Core (2 nodes)",
        "- [a] file wiki/3-resources/a.md — Alpha: The first",
        '- [b] text "Idea one"',
        "",
        "## Ungrouped (2)",
        "- [c] link https://example.com",
        "- [d] file wiki/missing.md#H (not found)",
        "",
        "## Edges (4)",
        '- Alpha -> "Idea one"',
        '- "Idea one" -- https://example.com [depends_on]',
        "- https://example.com <-> Alpha",
        "- https://example.com <- wiki/missing.md",
      ].join("\n")
    );
  });
});

// ---- typed relations -----------------------------------------------------------------

describe("relations", () => {
  test("entries may be paths, wiki links or lists, and keep their order", () => {
    const read = readRelations(
      {
        relations: {
          depends_on: ["topics/a", "[[b|Bee]]", "wiki/3-resources/c.md#sec", "  ", "topics/a"],
          part_of: "[[p]]",
          " ": ["x"],
        },
      },
      "wiki"
    );
    expect(read.refs).toEqual([
      { kind: "depends_on", target: "topics/a" },
      { kind: "depends_on", target: "b" },
      { kind: "depends_on", target: "3-resources/c.md" },
      { kind: "part_of", target: "p" },
    ]);
    expect(read.problems).toEqual(["a relation kind is empty"]);
  });

  test("a bad shape is a problem, not a crash", () => {
    expect(readRelations({ relations: "x" }, "wiki")).toEqual({
      refs: [],
      problems: ["relations must be a mapping of kind to a list of paths"],
    });
    expect(readRelations({ relations: { k: 5, j: [1, "a"] } }, "wiki")).toEqual({
      refs: [{ kind: "j", target: "a" }],
      problems: [
        "relation 'k' must be a path, a wiki link or a list of them",
        "relation 'j' has an entry that is not a path",
      ],
    });
    expect(readRelations({}, "wiki")).toEqual({ refs: [], problems: [] });
  });
});

// ---- the schema ----------------------------------------------------------------------

describe("graph schema parsing and warnings", () => {
  const schema = parseGraphSchema({
    types: [{ name: "A", description: "a" }, "B", { description: "no name" }],
    kinds: [{ name: "uses", from: "A", to: ["A", "B"] }, "plain"],
  });

  test("types and kinds are read, bad entries are problems", () => {
    expect(schema.types).toEqual([{ name: "A", description: "a" }, { name: "B" }]);
    expect(schema.kinds).toEqual([{ name: "uses", from: ["A"], to: ["A", "B"] }, { name: "plain" }]);
    expect(schema.problems).toEqual(["types[2] needs a name"]);
    expect(parseGraphSchema({})).toEqual({ types: null, kinds: null, problems: [] });
  });

  test("warnings name what is not declared, ordered by path", () => {
    const link = (relation: string, resolved: string | null) => ({ target: "t", kind: "relation" as const, relation, resolved });
    const subjects = [
      { id: "z", relPath: "wiki/z.md", frontmatter: { type: "A", relations: { uses: ["a"] } }, links: [link("uses", "a")] },
      { id: "a", relPath: "wiki/a.md", frontmatter: { type: "C", relations: { uses: ["z"], flies: ["z"] } }, links: [link("uses", "z"), link("flies", "z")] },
      { id: "b", relPath: "wiki/b.md", frontmatter: { type: "B" }, links: [] },
    ];
    expect(schemaWarnings(schema, subjects, "wiki")).toEqual([
      {
        path: "wiki/a.md",
        warnings: [
          "type 'C' is not declared in the graph schema",
          "relation 'uses': source type 'C' is not one of [A]",
          "relation kind 'flies' is not declared in the graph schema",
        ],
      },
      // z -> a: `uses` only points at A or B, and a is a C.
      { path: "wiki/z.md", warnings: ["relation 'uses' -> a: target type 'C' is not one of [A, B]"] },
    ]);
  });

  test("a target type outside `to` is a warning", () => {
    const only = parseGraphSchema({ types: ["A", "B"], kinds: [{ name: "uses", to: ["B"] }] });
    const subjects = [
      { id: "x", relPath: "wiki/x.md", frontmatter: { type: "A", relations: { uses: ["y"] } }, links: [{ target: "y", kind: "relation" as const, relation: "uses", resolved: "y" }] },
      { id: "y", relPath: "wiki/y.md", frontmatter: { type: "A" }, links: [] },
    ];
    expect(schemaWarnings(only, subjects, "wiki")).toEqual([
      { path: "wiki/x.md", warnings: ["relation 'uses' -> y: target type 'A' is not one of [B]"] },
    ]);
  });
});

// ---- layout --------------------------------------------------------------------------

/** A link is a target id, `null` (unresolved) or `[target, relation]`. */
function concept(id: string, links: Array<string | null | [string, string]> = [], extra: Partial<GraphConcept> = {}): GraphConcept {
  return {
    id,
    path: `wiki/${id}.md`,
    dead: false,
    links: links.map((l) => (l === null || typeof l === "string" ? { resolved: l } : { resolved: l[0], relation: l[1] })),
    ...extra,
  };
}

const opts = (roots: string[], depth = 1, extra: Record<string, unknown> = {}) => ({
  roots,
  depth,
  includeDead: false,
  groupByPara: false,
  ...extra,
});

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("graph layout", () => {
  test("columns are distances from the root, rows are ordered by path and centred", () => {
    const concepts = [
      concept("r", ["x", "y"]),
      concept("x", ["z"]),
      concept("y"),
      concept("z"),
      concept("far", ["z"]),
    ];
    const result = buildGraphCanvas(concepts, opts(["r"], 2));
    const at = (id: string) => {
      const n = result.canvas.nodes!.find((m) => m.file === `wiki/${id}.md`)!;
      return [n.x, n.y];
    };
    expect(at("r")).toEqual([0, 68]);
    expect(at("x")).toEqual([440, 0]);
    expect(at("y")).toEqual([440, 136]);
    expect(at("z")).toEqual([880, 68]);
    expect(result.canvas.nodes!.some((n) => n.file === "wiki/far.md")).toBe(false);
    expect(result).toMatchObject({ concepts: 4, edges: 3, truncated: false });
    const r = result.canvas.nodes!.find((n) => n.file === "wiki/r.md")!;
    expect(r).toMatchObject({ type: "file", width: 280, height: 96, color: "4" });
  });

  test("depth 0 is the root alone; depth reaches incoming links too", () => {
    const concepts = [concept("a", ["b"]), concept("b"), concept("c", ["a"])];
    expect(buildGraphCanvas(concepts, opts(["a"], 0)).concepts).toBe(1);
    const one = buildGraphCanvas(concepts, opts(["a"], 1));
    expect(one.concepts).toBe(3);
    expect(one.edges).toBe(2);
  });

  test("the same graph gives the same file whatever order it arrives in", () => {
    const concepts = [
      concept("アルファ", ["ベータ", ["ガンマ", "depends_on"]]),
      concept("ベータ", ["アルファ", "ベータ", "nowhere"]),
      concept("ガンマ", ["デルタ"]),
      concept("デルタ", [], { dead: true }),
      concept("e", [["ガンマ", "part_of"], "ガンマ"]),
    ];
    const base = serializeCanvas(buildGraphCanvas(concepts, opts(["アルファ"], 3, { includeDead: true })).canvas);
    for (let seed = 1; seed <= 6; seed++) {
      expect(serializeCanvas(buildGraphCanvas(shuffled(concepts, seed), opts(["アルファ"], 3, { includeDead: true })).canvas)).toBe(base);
    }
    expect(parseCanvas(base).ok).toBe(true);
  });

  test("cycles, self-links and unresolved links are handled", () => {
    const concepts = [concept("a", ["b", "a", null]), concept("b", ["a", "c"]), concept("c", ["b"])];
    const result = buildGraphCanvas(concepts, opts(["a"], 3));
    expect(result.concepts).toBe(3);
    // a<->b, b<->c: no self-link, no edge for the null.
    expect(result.edges).toBe(4);
    expect(validateCanvas(result.canvas)).toEqual([]);
  });

  test("DEAD concepts are left out unless asked for, and drawn red", () => {
    const concepts = [concept("a", ["d"]), concept("d", [], { dead: true })];
    expect(buildGraphCanvas(concepts, opts(["a"])).concepts).toBe(1);
    const shown = buildGraphCanvas(concepts, opts(["a"], 1, { includeDead: true }));
    expect(shown.canvas.nodes!.find((n) => n.file === "wiki/d.md")!.color).toBe("1");
  });

  test("plain links are unlabeled, relations carry their kind, both can join the same pair", () => {
    const concepts = [concept("a", ["b", ["b", "depends_on"]]), concept("b")];
    const edges = buildGraphCanvas(concepts, opts(["a"])).canvas.edges!;
    expect(edges.map((e) => e.label)).toEqual([undefined, "depends_on"]);
    expect(edges[0]).toMatchObject({ fromSide: "right", toSide: "left" });
  });

  test("para_depth keeps the walk inside the classes asked for", () => {
    const concepts = [
      concept("1-projects/p", ["3-resources/r", "4-archive/old"]),
      concept("3-resources/r"),
      concept("4-archive/old"),
    ];
    expect(buildGraphCanvas(concepts, opts(["1-projects/p"], 1, { paraDepth: 3 })).concepts).toBe(2);
    expect(buildGraphCanvas(concepts, opts(["1-projects/p"], 1)).concepts).toBe(3);
  });

  test("group_by_para frames each class cluster, and the frame holds its nodes", () => {
    const concepts = [
      concept("1-projects/p", ["3-resources/r", "4-archive/old", "1-projects/q"]),
      concept("1-projects/q"),
      concept("3-resources/r"),
      concept("4-archive/old"),
    ];
    const { canvas } = buildGraphCanvas(concepts, opts(["1-projects/p"], 1, { groupByPara: true }));
    const nodes = canvas.nodes!;
    expect(nodes.filter((n) => n.type === "group").map((n) => n.label)).toEqual(["プロジェクト", "プロジェクト", "リソース", "アーカイブ"]);
    const parents = groupParents(nodes as never);
    for (const [i, n] of nodes.entries()) {
      if (n.type === "file") expect(nodes[parents[i]!]?.type).toBe("group");
    }
    // Frames are listed first, so they are drawn under the concepts.
    expect(nodes[0]!.type).toBe("group");
    expect(validateCanvas(canvas)).toEqual([]);
  });

  test("a big neighbourhood stops at the cap and says so", () => {
    const leaves = Array.from({ length: 200 }, (_, i) => concept(`leaf${String(i).padStart(3, "0")}`));
    const hub = concept("hub", leaves.map((l) => l.id));
    const result = buildGraphCanvas([hub, ...leaves], opts(["hub"]));
    expect(result.concepts).toBe(150);
    expect(result.truncated).toBe(true);
  });

  test("ordering is by code point, as the Rust build's is", () => {
    expect(compareCodePoints("a", "b")).toBe(-1);
    expect(compareCodePoints("\u{1F600}", "￿")).toBe(1); // UTF-16 order says the opposite
    expect(compareCodePoints("ab", "a")).toBe(1);
    expect(compareCodePoints("a", "a")).toBe(0);
  });
});

// ---- the workspace and the tools -----------------------------------------------------

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-canvas-test-"));
  await scaffoldBundle(root);
  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

const call = (name: string, args: Record<string, unknown> = {}) => callTool(workspace, name, args);
const note = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n\n${body}\n`;

async function seedGraph(): Promise<void> {
  await workspace.writeFile("wiki/1-projects/アルファ.md", note("type: Project\ntitle: アルファ\ndescription: 始まり\nrelations:\n  depends_on: [3-resources/gamma]", "[[ベータ]] へ"));
  await workspace.writeFile("wiki/3-resources/ベータ.md", note("type: Concept\ntitle: ベータ", "[[アルファ]] [[ベータ]] [[missing-page]]"));
  await workspace.writeFile("wiki/3-resources/gamma.md", note("type: Concept\ntitle: Gamma\ndescription: g", "[[delta]]"));
  await workspace.writeFile("wiki/3-resources/delta.md", note("type: Concept\ntags: [DEAD]", "d"));
  await workspace.writeFile("wiki/4-archive/eps.md", note('type: Concept\nrelations:\n  part_of: "[[gamma]]"', "e"));
  // Links to files written later stay unresolved until the next reload.
  await workspace.reloadBundle();
}

describe("scaffold", () => {
  test("a new bundle has wiki/graph/ and SYSTEMMAP.md, and raises no warning", async () => {
    const graph = await workspace.listDir("wiki/graph", true);
    expect(graph.map((n) => n.name)).toEqual(["canvases", "index.md", "schema.md"]);
    const schema = await readFile(join(root, "wiki", "graph", "schema.md"), "utf8");
    expect(schema).toContain("type: GraphSchema");
    expect(workspace.conformanceIssues()).toEqual([]);
    expect(workspace.schemaWarnings()).toEqual([]);

    const map = await readFile(join(root, "SYSTEMMAP.md"), "utf8");
    expect(map).toContain(SYSTEMMAP_START);
    expect(map).toContain(SYSTEMMAP_END);
    expect(workspace.listConcepts().some((c) => c.path.endsWith("SYSTEMMAP.md"))).toBe(false);
    expect(await workspace.readMap()).toContain("SYSTEMMAP.md");
  });

  test("the agent contract tells agents about canvases, relations and SYSTEMMAP", async () => {
    const agents = (await call("read_agents_md")).content[0]!.text;
    for (const word of ["canvas_from_links", "graph_schema", "relations", "SYSTEMMAP.md", "system_map"]) {
      expect(agents).toContain(word);
    }
  });
});

describe("typed relations in the graph", () => {
  test("a relation is a link: backlinks, unresolved links and the concept's links", async () => {
    await seedGraph();
    const bundle = workspace.requireBundle();
    expect(bundle.backlinksOf("3-resources/gamma")).toEqual(["1-projects/アルファ", "4-archive/eps"]);
    const links = bundle.getConcept("1-projects/アルファ")!.links;
    expect(links.map((l) => [l.kind, l.relation ?? null, l.resolved])).toEqual([
      ["wikilink", null, "3-resources/ベータ"],
      ["relation", "depends_on", "3-resources/gamma"],
    ]);

    await workspace.writeFile("wiki/3-resources/lost.md", note("type: Concept\nrelations:\n  see_also: [nowhere/at-all]", "x"));
    expect(workspace.unresolvedLinks()).toContainEqual({ from: "3-resources/lost", target: "nowhere/at-all", relation: "see_also" });
    // Plain unresolved wikilinks keep their old shape.
    expect(workspace.unresolvedLinks()).toContainEqual({ from: "3-resources/ベータ", target: "missing-page" });
  });
});

describe("check_conformance and graph_schema", () => {
  test("warnings appear only with a schema, never as errors", async () => {
    await workspace.writeFile("wiki/3-resources/odd.md", note("type: Gizmo\nrelations:\n  teleports: [3-resources/odd]", "x"));
    const out = await call("check_conformance");
    expect(out.isError).toBeUndefined();
    // check_conformance keeps its original shape; the warnings are graph_schema's.
    expect(out.content[0]!.text).toBe("All documents conform to OKF v0.2.");
    expect(JSON.parse((await call("graph_schema")).content[0]!.text).warnings).toEqual([
      {
        path: "wiki/3-resources/odd.md",
        warnings: [
          "type 'Gizmo' is not declared in the graph schema",
          "relation kind 'teleports' is not declared in the graph schema",
        ],
      },
    ]);
    expect(workspace.conformanceIssues()).toEqual([]);
    expect((await workspace.requireBundle().info()).nonConformantCount).toBe(0);

    await call("delete_file", { path: "wiki/graph/schema.md" });
    const none = await call("check_conformance");
    expect(none.content[0]!.text).toBe("All documents conform to OKF v0.2.");
  });

  test("graph_schema returns the declared types and kinds", async () => {
    const data = JSON.parse((await call("graph_schema")).content[0]!.text);
    expect(data.exists).toBe(true);
    expect(data.path).toBe("wiki/graph/schema.md");
    expect(data.types.map((t: { name: string }) => t.name)).toContain("GraphSchema");
    expect(data.kinds.map((k: { name: string }) => k.name)).toEqual(["related_to", "depends_on", "part_of", "derived_from", "supersedes"]);

    await call("delete_file", { path: "wiki/graph/schema.md" });
    expect(JSON.parse((await call("graph_schema")).content[0]!.text)).toEqual({
      path: "wiki/graph/schema.md",
      exists: false,
      types: [],
      kinds: [],
    });
  });
});

describe("canvas tools", () => {
  const CANVAS = '{\n\t"nodes":[\n\t\t{"id":"b","type":"text","text":"Hi","x":0,"y":0,"width":200,"height":60,"zz":{"keep":1}},\n\t\t{"id":"a","type":"file","file":"wiki/hello.md","x":300,"y":0,"width":200,"height":60}\n\t],\n\t"edges":[\n\t\t{"id":"e","fromNode":"b","toNode":"a","label":"see"}\n\t],\n\t"custom":true\n}';

  test("they are registered", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining(["canvas_list", "canvas_read", "canvas_write", "canvas_from_links", "graph_schema", "system_map"])
    );
  });

  test("canvas_write validates, writes verbatim and keeps unknown keys and order", async () => {
    const out = await call("canvas_write", { path: "wiki/graph/canvases/c.canvas", content: CANVAS, actor: "process:test" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toBe("Wrote wiki/graph/canvases/c.canvas");
    expect(await readFile(join(root, "wiki", "graph", "canvases", "c.canvas"), "utf8")).toBe(CANVAS);
    expect(workspace.listConcepts().some((c) => c.path.endsWith(".canvas"))).toBe(false);
    expect(workspace.conformanceIssues()).toEqual([]);
  });

  test("canvas_write refuses what is invalid or misplaced, and writes nothing", async () => {
    const bad = await call("canvas_write", { path: "wiki/c.canvas", content: '{"nodes":[{"id":"a"}]}' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toStartWith("Invalid canvas, nothing written: nodes[0].type must be");
    await expect(readFile(join(root, "wiki", "c.canvas"), "utf8")).rejects.toThrow();

    expect((await call("canvas_write", { path: "wiki/c.canvas", content: "{" })).content[0]!.text).toBe(
      "Invalid canvas, nothing written: the content is not valid JSON"
    );
    expect((await call("canvas_write", { path: "wiki/c.json", content: "{}" })).content[0]!.text).toBe("'path' must end in .canvas");
    expect((await call("canvas_write", { path: "raw/c.canvas", content: "{}" })).content[0]!.text).toBe(
      "A .canvas file must live under wiki/: raw/c.canvas"
    );
    expect((await call("canvas_write", { path: "wiki/.hidden/c.canvas", content: "{}" })).content[0]!.text).toBe(
      "A .canvas file cannot live in a hidden folder: wiki/.hidden/c.canvas"
    );
    expect((await call("canvas_write", { path: "wiki/sub/../../x.canvas", content: "{}" })).isError).toBe(true);
    expect((await call("canvas_write", { path: "wiki/c.canvas" })).content[0]!.text).toBe("'content' is required");
    expect((await call("canvas_write", { content: "{}" })).content[0]!.text).toBe("'path' is required");
  });

  test("canvas_read returns the structure and an outline that resolves file nodes", async () => {
    await call("canvas_write", { path: "wiki/graph/canvases/c.canvas", content: CANVAS });
    const out = await call("canvas_read", { path: "wiki/graph/canvases/c.canvas" });
    const data = JSON.parse(out.content[0]!.text);
    expect(data.nodeCount).toBe(2);
    expect(data.edgeCount).toBe(1);
    expect(data.canvas.custom).toBe(true);
    expect(data.canvas.nodes[0].zz).toEqual({ keep: 1 });
    expect(data.outline).toContain("- [a] file wiki/hello.md — ようこそ: このバンドルの最初の概念ページ");
    expect(data.outline).toContain('- "Hi" -> ようこそ [see]');

    expect((await call("canvas_read", { path: "wiki/nope.canvas" })).content[0]!.text).toBe("wiki/nope.canvas not found");
    expect((await call("canvas_read", { path: "wiki/hello.md" })).content[0]!.text).toBe("'path' must end in .canvas");
    await writeFile(join(root, "wiki", "broken.canvas"), '{"nodes":5}');
    expect((await call("canvas_read", { path: "wiki/broken.canvas" })).content[0]!.text).toBe(
      "Invalid canvas wiki/broken.canvas: nodes must be an array"
    );
  });

  test("canvas_list lists canvases with counts and errors", async () => {
    await call("canvas_write", { path: "wiki/graph/canvases/c.canvas", content: CANVAS });
    await writeFile(join(root, "wiki", "broken.canvas"), "nope");
    expect(JSON.parse((await call("canvas_list")).content[0]!.text)).toEqual([
      { path: "wiki/broken.canvas", error: "the content is not valid JSON" },
      { path: "wiki/graph/canvases/c.canvas", nodes: 2, edges: 1 },
    ]);
  });

  test("canvas_from_links draws the neighbourhood, saves it and returns the outline", async () => {
    await seedGraph();
    const out = await call("canvas_from_links", { root: "1-projects/アルファ", depth: 2, path: "alpha.canvas", actor: "process:test" });
    expect(out.isError).toBeUndefined();
    const text = out.content[0]!.text;
    expect(text).toStartWith("Wrote wiki/graph/canvases/alpha.canvas: 4 concepts, 4 edges.");
    expect(text).toContain("wiki/3-resources/gamma.md — Gamma: g");
    expect(text).toContain("アルファ -> Gamma [depends_on]");
    expect(text).not.toContain("delta"); // DEAD, and not asked for

    const saved = await readFile(join(root, "wiki", "graph", "canvases", "alpha.canvas"), "utf8");
    expect(parseCanvas(saved).ok).toBe(true);
    expect(saved.startsWith('{\n\t"nodes":[\n\t\t{"id":"')).toBe(true);

    // The same call again gives the same bytes.
    await call("canvas_from_links", { root: "wiki/1-projects/アルファ.md", depth: 2, path: "wiki/graph/canvases/again.canvas" });
    expect(await readFile(join(root, "wiki", "graph", "canvases", "again.canvas"), "utf8")).toBe(saved);

    const dead = await call("canvas_from_links", { root: "gamma", depth: 1, include_dead: true, path: "g.canvas" });
    expect(dead.content[0]!.text).toContain("delta");
    expect(dead.content[0]!.text).toContain("Wrote wiki/graph/canvases/g.canvas: 4 concepts");
  });

  test("canvas_from_links can start from a query, and refuses bad input", async () => {
    await seedGraph();
    const viaQuery = await call("canvas_from_links", { query: "gamma", depth: 0, path: "q.canvas" });
    expect(viaQuery.isError).toBeUndefined();
    expect(viaQuery.content[0]!.text).toContain("Gamma");

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ path: "x.canvas" }, "'root' or 'query' is required"],
      [{ root: "gamma" }, "'path' is required"],
      [{ root: "gamma", path: "x.json" }, "'path' must end in .canvas"],
      [{ root: "gamma", path: "x.canvas", depth: 4 }, "depth must be an integer from 0 to 3: 4"],
      [{ root: "gamma", path: "x.canvas", depth: 1.5 }, "depth must be an integer from 0 to 3: 1.5"],
      [{ root: "gamma", path: "x.canvas", para_depth: 0 }, "para_depth must be an integer from 1 to 4: 0"],
      [{ root: "no-such", path: "x.canvas" }, "No concept matches root: no-such"],
      [{ query: "zzzzqqqq", path: "x.canvas" }, "No concept matches the query: zzzzqqqq"],
      [{ root: "gamma", path: "raw/x.canvas" }, "A .canvas file must live under wiki/: raw/x.canvas"],
    ];
    for (const [args, message] of cases) {
      const out = await call("canvas_from_links", args);
      expect({ args, text: out.content[0]!.text, isError: out.isError }).toEqual({ args, text: message, isError: true });
    }
  });
});

describe("SYSTEMMAP.md", () => {
  const section = (text: string) => text.slice(text.indexOf(SYSTEMMAP_START), text.indexOf(SYSTEMMAP_END) + SYSTEMMAP_END.length);

  test("refresh rewrites only the marked section; human text survives byte for byte", async () => {
    const path = join(root, "SYSTEMMAP.md");
    const original = await readFile(path, "utf8");
    const before = original.slice(0, original.indexOf(SYSTEMMAP_START));
    const after = original.slice(original.indexOf(SYSTEMMAP_END) + SYSTEMMAP_END.length);
    const edited = `MY NOTE — 日本語 ${"\r\n"}${before}${section(original)}${after}\n\ttrailing  spaces  \n`;
    await writeFile(path, edited, "utf8");

    await seedGraph();
    const out = await call("system_map", { refresh: true, actor: "process:test" });
    expect(out.isError).toBeUndefined();
    const now = await readFile(path, "utf8");
    expect(now).toBe(out.content[0]!.text);
    expect(now.startsWith(`MY NOTE — 日本語 \r\n${before}`)).toBe(true);
    expect(now.endsWith(`${after}\n\ttrailing  spaces  \n`)).toBe(true);
    expect(now).toContain("| 概念 | 7（DEAD 1 件を含む） |");
    expect(now).toContain("| MCP ツール | " + TOOLS.length + " |");
    expect(now).toContain("| 1-projects（プロジェクト） | 1 |");
    expect(now).toContain("| Concept | 4 |");
    expect(now).toContain("- 関係: `depends_on`");
    expect(now).toContain("`okf-ingest`");

    // Refreshing again changes nothing.
    expect((await call("system_map", { refresh: true })).content[0]!.text).toBe(now);
  });

  test("without refresh it only reads; a bundle without the file gets it on refresh", async () => {
    await rm(join(root, "SYSTEMMAP.md"));
    const read = await call("system_map");
    expect(read.content[0]!.text).toContain(SYSTEMMAP_START);
    await expect(readFile(join(root, "SYSTEMMAP.md"), "utf8")).rejects.toThrow();

    await call("system_map", { refresh: true });
    expect(await readFile(join(root, "SYSTEMMAP.md"), "utf8")).toContain("## 拡張のしかた");
  });

  test("a file without markers keeps its text and gains the section at the end", () => {
    const next = renderSystemMap("# mine\nno markers", null);
    expect(next.startsWith("# mine\nno markers\n\n")).toBe(true);
    expect(next.endsWith(`${SYSTEMMAP_END}\n`)).toBe(true);
    // Markers out of order are refused (see "markers and read errors" below).
  });

  test("it lists canvases, bases and skills, and the layer files are not concepts", async () => {
    await call("canvas_write", { path: "wiki/graph/canvases/c.canvas", content: '{"nodes":[],"edges":[]}' });
    const text = (await call("system_map", { refresh: true })).content[0]!.text;
    expect(text).toContain("- `wiki/graph/canvases/c.canvas` — 0 ノード / 0 エッジ");
    expect(text).toContain("- `wiki/bases/products-and-dead.base`");
    expect(workspace.requireBundle().getConcept("SYSTEMMAP")).toBeUndefined();
  });
});

// ---- the geometry the view draws with --------------------------------------------------

import {
  anchorPoint,
  arrowHead,
  boundsOf,
  edgeGeometry,
  fitView,
  freshId,
  heldBy,
  heldByAny,
  sideFacing,
  stringifyCanvas,
  zoomAt,
} from "../src/shared/okf/canvas-geometry";

describe("canvas geometry", () => {
  const a = { x: 0, y: 0, width: 100, height: 50 };
  const b = { x: 300, y: 0, width: 100, height: 50 };

  test("anchors are the middle of a side, and a missing side faces the other node", () => {
    expect(anchorPoint(a, "right")).toEqual([100, 25]);
    expect(anchorPoint(a, "bottom")).toEqual([50, 50]);
    expect(sideFacing(a, [500, 25])).toBe("right");
    expect(sideFacing(a, [50, -500])).toBe("top");
    const geo = edgeGeometry({}, a, b);
    expect([geo.fromSide, geo.toSide]).toEqual(["right", "left"]);
    expect(geo.mid).toEqual([200, 25]);
    expect(geo.d.startsWith("M 100 25 C ")).toBe(true);
    expect(edgeGeometry({ fromSide: "bottom", toSide: "top" }, a, b).fromSide).toBe("bottom");
  });

  test("an arrowhead's tip is the point it is given", () => {
    expect(arrowHead([100, 25], "left").startsWith("100,25 ")).toBe(true);
  });

  test("fit centres the content and never magnifies; zoom keeps the point under the cursor", () => {
    expect(boundsOf([])).toBeNull();
    const bounds = boundsOf([a, b])!;
    expect(bounds).toEqual({ x: 0, y: 0, width: 400, height: 50 });
    const view = fitView(bounds, 1000, 600);
    expect(view.k).toBe(1);
    expect(view.x + 200 * view.k).toBe(500);
    expect(fitView(bounds, 200, 600).k).toBeLessThan(1);
    const zoomed = zoomAt({ x: 10, y: 20, k: 1 }, 2, 110, 120);
    // The canvas point (100, 100) was at screen (110, 120) and still is.
    expect([zoomed.x + 100 * zoomed.k, zoomed.y + 100 * zoomed.k]).toEqual([110, 120]);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 1000, 0, 0).k).toBe(4);
  });

  test("a canvas is saved the way Obsidian lays it out, and every other key survives", () => {
    const text = '{\n\t"nodes":[\n\t\t{"id":"a","type":"text","text":"t","x":0,"y":0,"width":1,"height":1}\n\t],\n\t"edges":[],\n\t"extra":{"k":[1,2]}\n}';
    const parsed = parseCanvas(text);
    expect(parsed.ok && stringifyCanvas(parsed.value)).toBe(text);
    expect(stringifyCanvas({})).toBe("{}");
  });

  test("ids are fresh, and a group holds what lies inside it however deep", () => {
    const seen = new Set(["0000000000000000"]);
    // The first draw lands on a taken id, so a second one is made.
    let calls = 0;
    expect(freshId(seen, () => (calls++ < 16 ? 0 : 0.5))).toBe("8888888888888888");
    expect(freshId(new Set(), () => 0.5)).toBe("8888888888888888");
    const nodes = [
      { id: "outer", type: "group", x: 0, y: 0, width: 500, height: 500 },
      { id: "inner", type: "group", x: 10, y: 10, width: 300, height: 300 },
      node("t", { x: 20, y: 20 }),
      node("far", { x: 900, y: 900 }),
    ] as never;
    expect(heldBy(nodes, groupParents(nodes), 0)).toEqual([1, 2]);
    expect(heldBy(nodes, groupParents(nodes), 1)).toEqual([2]);
  });
});

// ---- review fixes ---------------------------------------------------------------------

describe("SYSTEMMAP.md markers and read errors", () => {
  const path = () => join(root, "SYSTEMMAP.md");

  test("anything but one start followed by one end is refused and leaves the file alone", async () => {
    const cases: Array<[string, string]> = [
      [`mine\n${SYSTEMMAP_START}\nhalf\n`, "1 start and 0 end markers"],
      [`mine\n${SYSTEMMAP_END}\nhalf\n`, "0 start and 1 end markers"],
      [`${SYSTEMMAP_END}\nx\n${SYSTEMMAP_START}\n`, "1 start and 1 end markers"],
      [`${SYSTEMMAP_START}\n${SYSTEMMAP_START}\n${SYSTEMMAP_END}\n`, "2 start and 1 end markers"],
      [`${SYSTEMMAP_START}\n${SYSTEMMAP_END}\n${SYSTEMMAP_END}\n`, "1 start and 2 end markers"],
    ];
    for (const [text, counts] of cases) {
      await writeFile(path(), text, "utf8");
      const out = await call("system_map", { refresh: true });
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toContain(counts);
      expect(out.content[0]!.text).toEndWith("Nothing was written.");
      expect(await readFile(path(), "utf8")).toBe(text);
    }
    expect(() => renderSystemMap(`${SYSTEMMAP_START}\n`, null)).toThrow(SYSTEMMAP_END);
    expect(() => renderSystemMap(`${SYSTEMMAP_END}\n`, null)).toThrow(SYSTEMMAP_START);
    // Neither marker is still fine: the section is appended.
    expect(renderSystemMap("# mine", null).startsWith("# mine\n\n")).toBe(true);
  });

  test("a file that cannot be read is not mistaken for a missing one", async () => {
    await rm(path());
    await mkdir(path()); // a directory at the path: reading it fails with EISDIR, not ENOENT
    const out = await call("system_map", { refresh: true });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("EISDIR");
    expect((await stat(path())).isDirectory()).toBe(true);
  });

  test("generated text cannot spell a marker, so refreshes do not grow the file", async () => {
    await workspace.writeFile(
      "wiki/3-resources/evil.md",
      note(`type: "Evil ${SYSTEMMAP_END} ${SYSTEMMAP_START}"\ntitle: evil`, "x")
    );
    await call("loop_define", { goal: `goal ${SYSTEMMAP_END} more`, name: "evil-loop" });
    const first = (await call("system_map", { refresh: true })).content[0]!.text;
    expect(first.split(SYSTEMMAP_START)).toHaveLength(2);
    expect(first.split(SYSTEMMAP_END)).toHaveLength(2);
    expect(first).toContain("&lt;!-- okf:systemmap:end -->");
    const second = (await call("system_map", { refresh: true })).content[0]!.text;
    expect(second).toBe(first);
    expect(await readFile(path(), "utf8")).toBe(first);
  });
});

describe("canvas_from_links overwrite and dense graphs", () => {
  test("it refuses to replace an existing canvas unless overwrite is true", async () => {
    await seedGraph();
    const args = { root: "gamma", depth: 1, path: "o.canvas" };
    expect((await call("canvas_from_links", args)).isError).toBeUndefined();
    const file = join(root, "wiki", "graph", "canvases", "o.canvas");
    const before = await readFile(file, "utf8");
    await writeFile(file, '{"nodes":[],"edges":[]}', "utf8");
    const again = await call("canvas_from_links", args);
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toBe("wiki/graph/canvases/o.canvas already exists; pass overwrite: true to replace it");
    expect(await readFile(file, "utf8")).toBe('{"nodes":[],"edges":[]}');
    expect((await call("canvas_from_links", { ...args, overwrite: true })).isError).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(before);
  });

  test("more typed edges than a canvas may hold are cut at the limit and flagged", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `n${String(i).padStart(2, "0")}`);
    const kinds = ["a", "b", "c"];
    const concepts = ids.map((id) =>
      concept(id, ids.filter((o) => o !== id).flatMap((o) => kinds.map((k) => [o, k] as [string, string])))
    );
    const result = buildGraphCanvas(concepts, opts(["n00"], 1));
    expect(result.truncated).toBe(true);
    expect(result.edges).toBe(MAX_CANVAS_EDGES);
    expect(validateCanvas(result.canvas)).toEqual([]);
  });
});

describe("moving a concept keeps typed relations pointing at it", () => {
  const fm = (relations: string, extra = "") => `---\ntype: Concept\n# keep this comment\n${extra}relations:\n${relations}\n---\n\nbody\n`;
  const read = (rel: string) => readFile(join(root, ...rel.split("/")), "utf8");

  test("path and [[link]] forms, list and single forms, are edited in place and nothing else changes", async () => {
    await workspace.writeFile("wiki/3-resources/gamma.md", note("type: Concept", "target"));
    const files: Record<string, string> = {
      "wiki/3-resources/a.md": fm('  depends_on: [3-resources/gamma, "[[gamma]]", other/x]   # tail comment\n  tags_like: 5', "title:   spaced   title\n"),
      "wiki/3-resources/b.md": fm("  part_of:\n    - wiki/3-resources/gamma.md#sec\n    # between\n    - 'unrelated/y'"),
      "wiki/3-resources/c.md": fm("  see_also: 3-resources/gamma # note"),
      "wiki/3-resources/d.md": fm("  see_also: '[[gamma|G]]'"),
      "wiki/3-resources/e.md": fm("  see_also: ./gamma.md"),
    };
    for (const [path, text] of Object.entries(files)) await workspace.writeFile(path, text);
    await workspace.reloadBundle();

    const out = await call("move_file", { from: "wiki/3-resources/gamma.md", to: "wiki/4-archive/gamma.md" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toBe("Moved wiki/3-resources/gamma.md → wiki/4-archive/gamma.md — updated 6 link(s) in 5 file(s)");

    expect(await read("wiki/3-resources/a.md")).toBe(
      files["wiki/3-resources/a.md"]!.replace("[3-resources/gamma, \"[[gamma]]\"", '[4-archive/gamma, "[[4-archive/gamma]]"')
    );
    expect(await read("wiki/3-resources/b.md")).toBe(files["wiki/3-resources/b.md"]!.replace("3-resources/gamma.md#sec", "4-archive/gamma.md#sec"));
    expect(await read("wiki/3-resources/c.md")).toBe(files["wiki/3-resources/c.md"]!.replace("3-resources/gamma", "4-archive/gamma"));
    expect(await read("wiki/3-resources/d.md")).toBe(files["wiki/3-resources/d.md"]!.replace("[[gamma|G]]", "[[4-archive/gamma|G]]"));
    expect(await read("wiki/3-resources/e.md")).toBe(files["wiki/3-resources/e.md"]!.replace("./gamma.md", "../4-archive/gamma.md"));

    // The graph still sees every relation.
    const back = workspace.requireBundle().backlinksOf("4-archive/gamma");
    expect(back).toEqual(["3-resources/a", "3-resources/b", "3-resources/c", "3-resources/d", "3-resources/e"]);
    expect(workspace.unresolvedLinks().filter((g) => g.target.includes("gamma"))).toEqual([]);
  });

  test("an entry it cannot edit safely is left alone and reported as dangling", async () => {
    await workspace.writeFile("wiki/3-resources/gamma.md", note("type: Concept", "target"));
    const multi = fm("  depends_on: [\n    3-resources/gamma,\n    other/x\n  ]");
    const anchor = fm("  depends_on: &d [3-resources/gamma]");
    await workspace.writeFile("wiki/3-resources/m.md", multi);
    await workspace.writeFile("wiki/3-resources/n.md", anchor);
    await workspace.reloadBundle();

    const out = await call("move_file", { from: "wiki/3-resources/gamma.md", to: "wiki/3-resources/delta.md" });
    expect(out.content[0]!.text).toBe(
      "Moved wiki/3-resources/gamma.md → wiki/3-resources/delta.md — these relations now dangle and need a manual edit: wiki/3-resources/m.md (depends_on: 3-resources/gamma); wiki/3-resources/n.md (depends_on: 3-resources/gamma)"
    );
    expect(await read("wiki/3-resources/m.md")).toBe(multi);
    expect(await read("wiki/3-resources/n.md")).toBe(anchor);
  });

  test("the moved file's own relative relations are rebased, and set_para follows relations too", async () => {
    await workspace.writeFile("wiki/3-resources/sibling.md", note("type: Concept", "s"));
    const own = fm('  related_to: [./sibling.md, "[[sibling]]", 3-resources/sibling]');
    await workspace.writeFile("wiki/3-resources/mover.md", own);
    await workspace.writeFile("wiki/3-resources/ref.md", fm("  part_of: 3-resources/mover"));
    await workspace.reloadBundle();

    const out = await call("set_para", { path: "wiki/3-resources/mover.md", para: "project" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).not.toContain("dangle");
    expect(await read("wiki/1-projects/mover.md")).toBe(own.replace("./sibling.md", "../3-resources/sibling.md"));
    expect(await read("wiki/3-resources/ref.md")).toBe(fm("  part_of: 1-projects/mover"));
  });
});

describe("group descendants in one pass", () => {
  test("heldByAny agrees with heldBy for every set of groups", () => {
    const nodes = [
      { id: "outer", type: "group", x: 0, y: 0, width: 500, height: 500 },
      { id: "inner", type: "group", x: 10, y: 10, width: 300, height: 300 },
      { id: "t", type: "text", text: "t", x: 20, y: 20, width: 10, height: 10 },
      { id: "u", type: "text", text: "u", x: 400, y: 400, width: 10, height: 10 },
      { id: "far", type: "text", text: "f", x: 900, y: 900, width: 10, height: 10 },
      { id: "solo", type: "group", x: 800, y: 800, width: 300, height: 300 },
    ] as never as Parameters<typeof groupParents>[0];
    const parents = groupParents(nodes);
    for (const groups of [[0], [1], [5], [0, 1], [1, 5], [0, 1, 5], []]) {
      const expected = [...new Set(groups.flatMap((g) => heldBy(nodes, parents, g)))].sort((a, b) => a - b);
      expect(heldByAny(parents, new Set(groups))).toEqual(expected);
    }
  });
});
