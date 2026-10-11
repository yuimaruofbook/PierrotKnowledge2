/**
 * Bases: `.base` files as list and aggregate views over the concepts.
 *
 * The claims under test: the expression subset evaluates deterministically and
 * never runs code, filters / formulas / sort / group / summaries behave as the
 * Obsidian docs describe, a file written by Obsidian is read (and unknown keys
 * survive a write byte for byte), and the three MCP tools answer and refuse
 * the way an agent can rely on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import {
  BaseError,
  listViews,
  type RunOptions,
  renderBaseMarkdown,
  runBase,
  validateBase,
  type BaseRow,
} from "../src/shared/okf/base";
import { EvalError, evalExpression, evalFailure } from "../src/shared/okf/base-expr";
import { Workspace } from "../src/bun/workspace";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { callTool, TOOLS } from "../src/bun/mcp/tools";
import { removeTempDir } from "./helpers";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function row(path: string, frontmatter: Record<string, unknown>, extra: Partial<BaseRow> = {}): BaseRow {
  return {
    path,
    wikiPath: path.replace(/^wiki\//, ""),
    id: path.replace(/^wiki\//, "").replace(/\.md$/, ""),
    mtimeMs: Date.UTC(2026, 0, 10),
    frontmatter,
    links: [],
    ...extra,
  };
}

const ROWS: BaseRow[] = [
  row("wiki/1-projects/alpha.md", { type: "Project", title: "Alpha", tags: ["Product", "web"], price: 10, due: "2026-02-01" }),
  row("wiki/1-projects/beta.md", { type: "Project", title: "Beta", tags: ["DEAD"], price: 30 }),
  row("wiki/2-areas/gamma.md", { type: "Concept", title: "Gamma", tags: ["Product"], price: 20, status: "done" }),
  row("wiki/notes/delta.md", { type: "Concept", title: "Delta", tags: "web, misc", status: "open" }, {
    links: [{ target: "alpha", resolved: "1-projects/alpha" }],
  }),
];

const run = (yaml: string, options: Partial<RunOptions> = {}) =>
  runBase(parseYaml(yaml), ROWS, { now: NOW, ...options });

describe("expressions", () => {
  const ev = (src: string, fm: Record<string, unknown> = {}) =>
    evalExpression(src, row("wiki/x/note.md", fm), { now: NOW });

  test("arithmetic, strings and comparison", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3 % 4")).toBe(1);
    expect(ev('"a" + "b"')).toBe("ab");
    expect(ev('"n=" + 5')).toBe("n=5");
    expect(ev("price > 5 && price < 20", { price: 10 })).toBe(true);
    expect(ev("!missing")).toBe(true);
    expect(ev("-price", { price: 4 })).toBe(-4);
    expect(ev('status == "done" || 0')).toBe(0);
    expect(ev("null == null")).toBe(true);
  });

  test("a missing property is null and propagates through arithmetic", () => {
    expect(ev("price")).toBeNull();
    expect(ev("price + 1")).toBeNull();
    expect(ev("price.toFixed(2)")).toBeNull();
    expect(ev("price > 1")).toBe(false);
  });

  test("note., file. and formula-free property access", () => {
    expect(ev("note.price + price", { price: 2 })).toBe(4);
    expect(ev("file.name")).toBe("note.md");
    expect(ev("file.basename")).toBe("note");
    expect(ev("file.folder")).toBe("wiki/x");
    expect(ev("file.ext")).toBe("md");
    expect(ev("file.para")).toBe("resource");
    expect(ev("generated.by", { generated: { by: "me" } })).toBe("me");
  });

  test("file.hasTag matches nested tags and ignores case", () => {
    const fm = { tags: ["Project/Alpha", "#plain"] };
    expect(ev('file.hasTag("project")', fm)).toBe(true);
    expect(ev('file.hasTag("plain", "zzz")', fm)).toBe(true);
    expect(ev('file.hasTag("proj")', fm)).toBe(false);
    expect(ev("file.tags.length", fm)).toBe(2);
  });

  test("file.inFolder works with bundle-relative and wiki-relative paths", () => {
    expect(ev('file.inFolder("wiki/x")')).toBe(true);
    expect(ev('file.inFolder("x")')).toBe(true);
    expect(ev('file.inFolder("wiki")')).toBe(true);
    expect(ev('file.inFolder("xy")')).toBe(false);
  });

  test("string, number and list methods", () => {
    expect(ev('"Hello World".lower().contains("world")')).toBe(true);
    expect(ev('"a,b,c".split(",").join("-")')).toBe("a-b-c");
    expect(ev('"hello world".title()')).toBe("Hello World");
    expect(ev('"abcdef".slice(1, -1)')).toBe("bcde");
    expect(ev('"abc".replace("b", "X")')).toBe("aXc");
    expect(ev('"  x ".trim().length')).toBe(1);
    expect(ev("(1.005).toFixed(2)")).toBe("1.00");
    expect(ev("(2.5).toFixed(0)")).toBe("3");
    expect(ev("(3.14159).round(2)")).toBe(3.14);
    expect(ev("(-1.5).abs().ceil()")).toBe(2);
    expect(ev("[3, 1, 2].sort().reverse().join(\",\")")).toBe("3,2,1");
    expect(ev("[1, 2, 3].map(value * 2).filter(value > 2).join(\",\")")).toBe("4,6");
    expect(ev("[1, 2, 3].reduce(acc + value, 0)")).toBe(6);
    expect(ev("[1, [2, [3]]].flat().length")).toBe(3);
    expect(ev("[1, 1, 2].unique().length")).toBe(2);
    expect(ev('list("a").length')).toBe(1);
    expect(ev("max(1, 5, 3) - min(4, 2)")).toBe(3);
    expect(ev('if(price, "has", "none")', { price: 1 })).toBe("has");
    expect(ev('if(price, "has")')).toBeNull();
    expect(ev("number(true) + 1")).toBe(2);
  });

  test("dates: parsing, fields, arithmetic and comparison (UTC)", () => {
    expect(ev('date("2026-03-04 05:06:07").year')).toBe(2026);
    expect(ev('date("2026-03-04").month')).toBe(3);
    expect(ev('date("2026-03-04 05:06:07").format("YYYY/MM/DD HH:mm")')).toBe("2026/03/04 05:06");
    expect(ev('(date("2026-01-31") + "1M").format("YYYY-MM-DD")')).toBe("2026-02-28");
    expect(ev('(date("2026-01-01") + duration("2 weeks")).day')).toBe(15);
    expect(ev('date("2026-01-02") - date("2026-01-01")')).toBe(86400000);
    expect(ev("today().hour")).toBe(0);
    expect(ev('now() > date("2026-01-01")')).toBe(true);
    expect(ev('due > date("2026-01-31")', { due: "2026-02-01" })).toBe(true);
    expect(ev('(duration("1d") * 2) == duration("48h")')).toBe(true);
    expect(ev("file.mtime.year")).toBe(2026);
  });

  test("links and any-type helpers", () => {
    expect(ev('link("Foo", "bar").toString()')).toBe("bar");
    expect(ev('"x".isType("string")')).toBe(true);
    expect(ev("price.isEmpty()")).toBe(true);
    expect(ev("[].isEmpty()")).toBe(true);
    expect(ev('"".isEmpty()')).toBe(true);
    expect(ev("(1).isTruthy()")).toBe(true);
  });

  test("code cannot be smuggled in: unknown names and syntax are refused", () => {
    expect(() => ev("process.exit(1)")).toThrow();
    expect(() => ev("constructor.constructor('x')()")).toThrow();
    expect(() => ev("a = 1")).toThrow();
    expect(() => ev("1 +")).toThrow();
    expect(() => ev('"open')).toThrow();
    expect(() => ev("x.__proto__")).not.toThrow();
    expect(ev("x.__proto__")).toBeNull();
    expect(ev("toString")).toBeNull();
  });
});

describe("running a base", () => {
  test("no views: an implicit table of file names, ordered by path", () => {
    const result = run("");
    expect(result.type).toBe("table");
    expect(result.view).toBe("Table");
    expect(result.columns).toEqual([{ id: "file.name", name: "file.name" }]);
    expect(result.rows?.map((r) => r.path)).toEqual([
      "wiki/1-projects/alpha.md",
      "wiki/1-projects/beta.md",
      "wiki/2-areas/gamma.md",
      "wiki/notes/delta.md",
    ]);
    expect(result.total).toBe(4);
  });

  test("global filters combine with view filters; and / or / not", () => {
    const result = run(`
filters:
  or:
    - file.hasTag("Product")
    - file.hasTag("web")
views:
  - type: table
    name: T
    filters:
      and:
        - 'price != 30'
        - not:
            - 'status == "open"'
    order: [file.basename]
`);
    expect(result.rows?.map((r) => r.cells[0])).toEqual(["alpha", "gamma"]);
  });

  test("not with several entries means none of them", () => {
    const result = run(`
filters:
  not:
    - file.hasTag("Product")
    - file.hasTag("DEAD")
views: [{type: table, name: T, order: [file.basename]}]
`);
    expect(result.rows?.map((r) => r.cells[0])).toEqual(["delta"]);
  });

  test("formulas, display names, sort and limit", () => {
    const result = run(`
formulas:
  double: price * 2
  label: 'title + " (" + formula.double + ")"'
properties:
  formula.label:
    displayName: Label
views:
  - type: table
    name: T
    filters: price
    order: [formula.label, price]
    sort:
      - property: price
        direction: DESC
    limit: 2
`);
    expect(result.columns).toEqual([
      { id: "formula.label", name: "Label" },
      { id: "price", name: "price" },
    ]);
    expect(result.rows?.map((r) => r.cells)).toEqual([
      ["Beta (60)", 30],
      ["Gamma (40)", 20],
    ]);
    expect(result.total).toBe(3);
    expect(result.shown).toBe(2);
  });

  test("a limit argument can only narrow the view's own limit", () => {
    const yaml = "views: [{type: table, name: T, limit: 3}]";
    expect(run(yaml, { limit: 2 }).shown).toBe(2);
    expect(run(yaml, { limit: 10 }).shown).toBe(3);
  });

  test("empty values sort last in both directions; ties fall back to the path", () => {
    const desc = run(`
views:
  - type: table
    name: T
    order: [file.basename]
    sort: [{property: price, direction: DESC}]
`);
    expect(desc.rows?.map((r) => r.cells[0])).toEqual(["beta", "gamma", "alpha", "delta"]);
    const result = run(`
views:
  - type: table
    name: T
    order: [file.basename]
    sort: [{property: price}]
`);
    expect(result.rows?.map((r) => r.cells[0])).toEqual(["alpha", "gamma", "beta", "delta"]);
  });

  test("groupBy yields ordered groups with counts and per-group summaries", () => {
    const result = run(`
formulas:
  bucket: 'if(file.hasTag("Product"), "Product", "Other")'
views:
  - type: cards
    name: C
    groupBy:
      property: formula.bucket
      direction: DESC
    order: [file.basename, price]
    summaries:
      price: Sum
      file.basename: Count
`);
    expect(result.type).toBe("cards");
    expect(result.rows).toBeUndefined();
    expect(result.groups?.map((g) => [g.key, g.count])).toEqual([
      ["Product", 2],
      ["Other", 2],
    ]);
    expect(result.groups?.[0]?.summaries).toEqual([
      { column: "file.basename", summary: "Count", value: 2 },
      { column: "price", summary: "Sum", value: 30 },
    ]);
    expect(result.summaries).toEqual([
      { column: "file.basename", summary: "Count", value: 4 },
      { column: "price", summary: "Sum", value: 60 },
    ]);
  });

  test("default and custom summaries", () => {
    const result = run(`
summaries:
  doubled: 'values.sum() * 2'
views:
  - type: table
    name: T
    order: [price, status, due, tags]
    summaries:
      price: Average
      status: Filled
      due: Latest
      tags: Unique
`);
    const byColumn = Object.fromEntries((result.summaries ?? []).map((s) => [s.column, s.value]));
    expect(byColumn.price).toBe(20);
    expect(byColumn.status).toBe(2);
    expect(byColumn.due).toBe("2026-02-01");
    expect(byColumn.tags).toBe(4);

    const custom = run(`
summaries:
  doubled: 'values.sum() * 2'
views: [{type: table, name: T, order: [price], summaries: {price: doubled}}]
`);
    expect(custom.summaries).toEqual([{ column: "price", summary: "doubled", value: 120 }]);

    const stats = run(`
views: [{type: table, name: T, order: [price], summaries: {price: Median}}]
`);
    expect(stats.summaries?.[0]?.value).toBe(20);
    for (const [name, want] of [["Min", 10], ["Max", 30], ["Range", 20], ["Stddev", Math.sqrt(200 / 3)]] as const) {
      const r = run(`views: [{type: table, name: T, order: [price], summaries: {price: ${name}}}]`);
      expect(r.summaries?.[0]?.value).toBe(want);
    }
  });

  test("a view is picked by name; unknown names and unsupported types are errors", () => {
    const yaml = `
views:
  - {type: table, name: One, order: [file.basename]}
  - {type: cards, name: Two}
  - {type: list, name: Three}
`;
    expect(run(yaml).view).toBe("One");
    expect(run(yaml, { view: "Two" }).type).toBe("cards");
    expect(() => run(yaml, { view: "Nope" })).toThrow("view 'Nope' not found; available: One, Two, Three");
    expect(() => run(yaml, { view: "Three" })).toThrow("not supported");
    expect(listViews(parseYaml(yaml))).toEqual([
      { name: "One", type: "table" },
      { name: "Two", type: "cards" },
      { name: "Three", type: "list" },
    ]);
  });

  test("runtime errors become empty values plus a warning, never a crash", () => {
    const result = run(`
formulas:
  bad: 'title - 1'
views:
  - {type: table, name: T, order: [formula.bad, file.size]}
`);
    expect(result.rows?.[0]?.cells).toEqual([null, null]);
    expect(result.warnings).toEqual([
      "formula.bad: cannot apply '-' to string and number",
      "column file.size: file.size is not supported",
    ]);
  });

  test("an Obsidian-authored example from the docs reads, with unsupported parts reported", () => {
    const docExample = `
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.50"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
      formula.formatted_price: customAverage
  - type: list
    name: "Other layout"
    unknownKey: [1, 2]
unknownTopLevel: kept
`;
    const parsed = parseYaml(docExample);
    expect(validateBase(parsed)).toEqual({
      errors: [],
      warnings: ["views[1]: type 'list' is not supported (table and cards only)"],
    });
    const result = runBase(parsed, ROWS, { now: NOW });
    expect(result.view).toBe("My table");
    expect(result.columns.map((c) => c.name)).toEqual(["file.name", "Extension", "age", "ppu", "Price"]);
    // `status != "done"` drops gamma; ppu is empty without an age, so only price > 2.50 keeps alpha and beta.
    expect(result.total).toBe(2);
  });
});

describe("validation", () => {
  const check = (yaml: string) => validateBase(parseYaml(yaml));

  test("accepts empty and minimal documents", () => {
    expect(check("")).toEqual({ errors: [], warnings: [] });
    expect(check("views: []")).toEqual({ errors: [], warnings: [] });
  });

  test("structure errors are specific", () => {
    expect(validateBase("text").errors).toEqual(["a base must be a YAML mapping"]);
    expect(check("filters: 5").errors).toEqual(["filters: must be an expression or an and / or / not mapping"]);
    expect(check("filters: {xor: []}").errors).toEqual(["filters: unknown key 'xor' (use and, or, not)"]);
    expect(check("formulas: [a]").errors).toEqual(["formulas: must be a mapping of name to expression"]);
    expect(check("views: {a: 1}").errors).toEqual(["views: must be a list"]);
    expect(check("views: [{name: x}]").errors).toEqual(["views[0]: type is required"]);
    expect(check("views: [{type: table, limit: 0}]").errors).toEqual(["views[0].limit: must be a positive integer"]);
    expect(check("views: [{type: table, order: x}]").errors).toEqual(["views[0].order: must be a list of property names"]);
    expect(check("views: [{type: table, sort: [{property: a, direction: UP}]}]").errors).toEqual([
      "views[0].sort[0]: direction must be ASC or DESC",
    ]);
    expect(check("views: [{type: table, groupBy: a}]").errors).toEqual(["views[0].groupBy: must be a mapping with a property"]);
    expect(check("views: [{type: table, summaries: {a: Nope}}]").errors).toEqual(["views[0].summaries.a: unknown summary 'Nope'"]);
  });

  test("expression errors name where they are", () => {
    expect(check("formulas: {a: '1 +'}").errors).toEqual(["formulas.a: unexpected end of expression"]);
    expect(check("filters: 'a ='").errors).toEqual(["filters: unexpected character '='"]);
    expect(check("filters: 'nosuch(1)'").errors).toEqual(["filters: unknown function 'nosuch'"]);
    expect(check("views: [{type: table, filters: 'x.foo()'}]").errors).toEqual([
      "views[0].filters: unknown function 'foo'",
    ]);
  });

  test("formula cycles are errors; unsupported features are warnings", () => {
    expect(check("formulas: {a: 'formula.b', b: 'formula.a', c: '1'}").errors).toEqual([
      "formulas.a: circular reference",
      "formulas.b: circular reference",
    ]);
    expect(check("formulas: {a: 'formula.zzz'}").warnings).toEqual(["formulas.a: formula.zzz is not defined"]);
    expect(check("filters: 'file.size > 1'").warnings).toEqual(["filters: file.size is not supported"]);
    expect(check("filters: 'file.nosuch'").warnings).toEqual(["filters: file.nosuch is not a known file property"]);
    expect(check("filters: 'random() > 1'").warnings).toEqual(["filters: random() is not supported"]);
  });

  test("running an invalid base reports every error at once", () => {
    expect(() => runBase(parseYaml("filters: 5\nviews: 3"), ROWS, { now: NOW })).toThrow(BaseError);
    expect(() => runBase(parseYaml("filters: 5\nviews: 3"), ROWS, { now: NOW })).toThrow(
      "invalid base: filters: must be an expression or an and / or / not mapping; views: must be a list"
    );
  });
});

describe("markdown rendering", () => {
  test("a grouped table with summaries and escaped cells", () => {
    const result = run(`
views:
  - type: table
    name: By status
    order: [file.basename, tags]
    groupBy: {property: status}
    summaries: {file.basename: Count}
`);
    const md = renderBaseMarkdown(result);
    expect(md).toBe(
      [
        "**By status** (table) - 4 of 4 rows",
        "",
        "### done (1)",
        "",
        "| file.basename | tags |",
        "| --- | --- |",
        "| gamma | Product |",
        "",
        "Summary: file.basename Count = 1",
        "",
        "### open (1)",
        "",
        "| file.basename | tags |",
        "| --- | --- |",
        "| delta | web, misc |",
        "",
        "Summary: file.basename Count = 1",
        "",
        "### (empty) (2)",
        "",
        "| file.basename | tags |",
        "| --- | --- |",
        "| alpha | Product, web |",
        "| beta | DEAD |",
        "",
        "Summary: file.basename Count = 2",
        "",
        "Summary: file.basename Count = 4",
      ].join("\n")
    );
  });

  test("no rows", () => {
    const md = renderBaseMarkdown(run("filters: 'price > 999'"));
    expect(md).toBe("**Table** (table) - 0 of 0 rows\n\n(no rows)");
  });
});

// ---- the workspace and the MCP tools -------------------------------------------

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-bases-test-"));
  await scaffoldBundle(root);
  workspace = new Workspace({ watch: false });
  await workspace.open(root);
});

afterEach(async () => {
  await workspace.close();
  await removeTempDir(root);
});

const call = (name: string, args: Record<string, unknown>) => callTool(workspace, name, args);

const BASE = `filters: file.hasTag("Product")
views:
  - type: table
    name: Products
    order: [file.basename, title]
`;

async function seedConcepts(): Promise<void> {
  await workspace.writeFile(
    "wiki/1-projects/shipped.md",
    "---\ntype: Project\ntitle: Shipped\ntags: [Product]\n---\n\nBody.\n"
  );
  await workspace.writeFile(
    "wiki/4-archive/old.md",
    "---\ntype: Concept\ntitle: Old\ntags: [DEAD]\n---\n\nBody.\n"
  );
}

describe("scaffold and index", () => {
  test("a new bundle has wiki/bases/ with an example that runs against it", async () => {
    const files = await workspace.listDir("wiki/bases");
    expect(files.map((f) => f.name)).toEqual(["index.md", "products-and-dead.base"]);
    await seedConcepts();
    const out = await call("base_query", { path: "wiki/bases/products-and-dead.base" });
    expect(out.isError).toBeUndefined();
    const data = JSON.parse(out.content[0]!.text);
    expect(data.view).toBe("Products and DEAD by PARA");
    expect(data.groups.map((g: { key: string }) => g.key)).toEqual(["1 Projects", "4 Archive"]);
  });

  test(".base files are not concepts and raise no conformance warning", async () => {
    await workspace.writeFile("wiki/bases/x.base", "views: []\n");
    expect(workspace.listConcepts().some((c) => c.path.endsWith(".base"))).toBe(false);
    expect(workspace.conformanceIssues()).toEqual([]);
    expect(workspace.search("views").length).toBe(0);
  });
});

describe("base tools", () => {
  test("they are registered", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["base_list", "base_query", "base_write"]));
  });

  test("base_write validates, writes verbatim and keeps unknown keys", async () => {
    const content = `# edited in Obsidian\nfilters: file.hasTag("Product")\nviews:\n  - type: table\n    name: P\n    columnSize: {file.name: 120}\nmyPlugin: {a: 1}\n`;
    const out = await call("base_write", { path: "wiki/bases/p.base", content, actor: "process:test" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toBe("Wrote wiki/bases/p.base");
    expect(await readFile(join(root, "wiki", "bases", "p.base"), "utf8")).toBe(content);
  });

  test("base_write reports warnings but still writes", async () => {
    const out = await call("base_write", {
      path: "wiki/bases/w.base",
      content: "views: [{type: list, name: L}]\n",
      actor: "process:test",
    });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toBe(
      "Wrote wiki/bases/w.base\nWarnings: views[0]: type 'list' is not supported (table and cards only)"
    );
  });

  test("base_write refuses what would not work, and writes nothing", async () => {
    const bad = await call("base_write", { path: "wiki/bases/b.base", content: "filters: 'a ='\n", actor: "process:test" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toBe("Invalid base, nothing written: filters: unexpected character '='");
    await expect(readFile(join(root, "wiki", "bases", "b.base"), "utf8")).rejects.toThrow();

    const yaml = await call("base_write", { path: "wiki/bases/b.base", content: "a: [1\n", actor: "process:test" });
    expect(yaml.content[0]!.text).toBe("Invalid base, nothing written: the content is not valid YAML");

    const ext = await call("base_write", { path: "wiki/bases/b.md", content: "views: []", actor: "process:test" });
    expect(ext.content[0]!.text).toBe("'path' must end in .base");

    const place = await call("base_write", { path: "raw/b.base", content: "views: []", actor: "process:test" });
    expect(place.content[0]!.text).toBe("A .base file must live under wiki/: raw/b.base");

    const missing = await call("base_write", { path: "wiki/bases/b.base" });
    expect(missing.content[0]!.text).toBe("'content' is required");
  });

  test("base_list lists every .base file with its views, and its errors", async () => {
    await workspace.writeFile("wiki/bases/p.base", BASE);
    await workspace.writeFile("wiki/deep/er/q.base", "views: [{type: cards, name: Q}]\n");
    await workspace.writeFile("wiki/bases/broken.base", "a: [1\n");
    const out = await call("base_list", {});
    const data = JSON.parse(out.content[0]!.text);
    expect(data).toEqual([
      { path: "wiki/bases/broken.base", views: [], error: "the content is not valid YAML" },
      { path: "wiki/bases/p.base", views: [{ name: "Products", type: "table" }] },
      {
        path: "wiki/bases/products-and-dead.base",
        views: [
          { name: "Products and DEAD by PARA", type: "table" },
          { name: "Products", type: "cards" },
        ],
      },
      { path: "wiki/deep/er/q.base", views: [{ name: "Q", type: "cards" }] },
    ]);
  });

  test("base_query returns rows, columns and a markdown table", async () => {
    await seedConcepts();
    await workspace.writeFile("wiki/bases/p.base", BASE);
    const out = await call("base_query", { path: "wiki/bases/p.base" });
    const data = JSON.parse(out.content[0]!.text);
    expect(data).toEqual({
      path: "wiki/bases/p.base",
      view: "Products",
      type: "table",
      columns: [
        { id: "file.basename", name: "file.basename" },
        { id: "title", name: "title" },
      ],
      total: 1,
      shown: 1,
      rows: [{ path: "wiki/1-projects/shipped.md", cells: ["shipped", "Shipped"] }],
      summaries: [],
      markdown:
        "**Products** (table) - 1 of 1 rows\n\n| file.basename | title |\n| --- | --- |\n| shipped | Shipped |",
    });
  });

  test("base_query errors are plain sentences", async () => {
    await workspace.writeFile("wiki/bases/p.base", BASE);
    expect((await call("base_query", {})).content[0]!.text).toBe("'path' is required");
    expect((await call("base_query", { path: "wiki/bases/none.base" })).isError).toBe(true);
    expect((await call("base_query", { path: "wiki/hello.md" })).content[0]!.text).toBe("'path' must end in .base");
    expect((await call("base_query", { path: "wiki/bases/p.base", view: "Z" })).content[0]!.text).toBe(
      "view 'Z' not found; available: Products"
    );
    expect((await call("base_query", { path: "wiki/bases/p.base", limit: 0 })).content[0]!.text).toBe(
      "limit must be a positive integer"
    );
  });

  test("an edit made outside the app is picked up on the next query", async () => {
    await seedConcepts();
    await workspace.writeFile("wiki/bases/p.base", BASE);
    await writeFile(join(root, "wiki", "bases", "p.base"), BASE.replace("Product", "DEAD"));
    const data = JSON.parse((await call("base_query", { path: "wiki/bases/p.base" })).content[0]!.text);
    expect(data.rows.map((r: { path: string }) => r.path)).toEqual(["wiki/4-archive/old.md"]);
  });
});

describe("the interface's view of a base", () => {
  test("baseView returns the views and one run, and failures as a message", async () => {
    await seedConcepts();
    await workspace.writeFile("wiki/bases/p.base", BASE + "  - type: cards\n    name: Gallery\n");
    const ok = await workspace.baseView("wiki/bases/p.base");
    expect(ok.error).toBeUndefined();
    expect(ok.views).toEqual([
      { name: "Products", type: "table" },
      { name: "Gallery", type: "cards" },
    ]);
    expect(ok.result?.view).toBe("Products");
    expect((await workspace.baseView("wiki/bases/p.base", "Gallery")).result?.type).toBe("cards");

    expect(await workspace.baseView("wiki/bases/p.base", "Nope")).toEqual({
      views: ok.views,
      error: "view 'Nope' not found; available: Products, Gallery",
    });
    await workspace.writeFile("wiki/bases/bad.base", "filters: 'a ='\n");
    expect((await workspace.baseView("wiki/bases/bad.base")).error).toBe(
      "invalid base: filters: unexpected character '='"
    );
    expect(await workspace.baseView("wiki/bases/missing.base")).toEqual({
      views: [],
      error: "wiki/bases/missing.base not found",
    });
  });
});

// ---- limits: hostile input must come back as errors and warnings, quickly ---------------

describe("hostile expressions", () => {
  const ev = (src: string, fm: Record<string, unknown> = {}) =>
    evalExpression(src, row("wiki/x/note.md", fm), { now: NOW });
  const within = <T>(fn: () => T, ms = 2000): T => {
    const start = performance.now();
    try {
      return fn();
    } finally {
      expect(performance.now() - start).toBeLessThan(ms);
    }
  };

  test("a long chain of operators is a parse error, not a stack overflow", () => {
    for (const op of ["+", "&&", "-", "*", "=="]) {
      const src = Array(50_000).fill("1").join(` ${op} `);
      expect(() => within(() => ev(src))).toThrow("expression is nested too deeply");
    }
  });

  test("a long chain of member access or method calls is a parse error", () => {
    expect(() => within(() => ev(`a${".b".repeat(50_000)}`))).toThrow("expression is nested too deeply");
    expect(() => within(() => ev(`"x"${".trim()".repeat(50_000)}`))).toThrow("expression is nested too deeply");
    expect(() => within(() => ev(`a${"[0]".repeat(50_000)}`))).toThrow("expression is nested too deeply");
    expect(() => within(() => ev("-".repeat(50_000) + "1"))).toThrow("expression is nested too deeply");
  });

  test("an expression with too many nodes is refused", () => {
    expect(() => within(() => ev(`[${Array(20_000).fill("1").join(",")}]`))).toThrow("expression is too large");
  });

  test("the limits leave ordinary long expressions alone", () => {
    expect(ev(Array(100).fill("1").join(" + "))).toBe(100);
    expect(ev(`"x"${".trim()".repeat(100)}`)).toBe("x");
  });

  test("validation reports a deep expression instead of throwing", () => {
    const src = Array(50_000).fill("1").join(" + ");
    const found = within(() => validateBase({ filters: src }));
    expect(found.errors).toEqual(["filters: expression is nested too deeply"]);
  });

  test("repeat, doubling and nested maps end in an evaluation error", () => {
    expect(() => within(() => ev(`"x".repeat(10000).repeat(10000)`))).toThrow("value is too large");
    const twenty = Array(20).fill("1").join(",");
    expect(() => within(() => ev(`[${twenty}].reduce(acc + acc, "ab")`))).toThrow("value is too large");
    const hundred = `"x".repeat(100).split("")`;
    const nested = `${hundred}.map(${hundred}.map(${hundred}.map(${hundred}.map(value))))`;
    expect(() => within(() => ev(nested))).toThrow(EvalError);
    expect(() => within(() => ev(`"x".repeat(100).split("").map(value.repeat(10000))`))).toThrow(EvalError);
  });

  test("a hostile cell becomes an empty value and a warning; the query still answers", () => {
    const filtered = within(() =>
      run(`
views:
  - type: table
    name: T
    filters: '"x".repeat(10000).repeat(10000).isEmpty()'
`)
    );
    expect(filtered.total).toBe(0);
    expect(filtered.warnings).toContain("filter: value is too large");

    const cells = within(() =>
      run(`
formulas:
  boom: '"x".repeat(10000).repeat(10000)'
views:
  - type: table
    name: T
    order: [file.basename, formula.boom]
`)
    );
    expect(cells.rows?.map((r) => r.cells[1])).toEqual([null, null, null, null]);
    expect(cells.warnings).toContain("formula.boom: value is too large");
  });

  test("the step budget is shared by the whole query", () => {
    const hundred = `"x".repeat(100).split("")`;
    const result = within(() =>
      run(`
formulas:
  slow: '${hundred}.map(${hundred}.map(${hundred}.map(value))).length'
views:
  - type: table
    name: T
    order: [file.basename, formula.slow]
`)
    );
    expect(result.warnings?.some((w) => w.endsWith("evaluation budget exceeded"))).toBe(true);
  });

  test("anything that is not an EvalError becomes one", () => {
    expect(evalFailure(new RangeError("Maximum call stack size exceeded"))).toBeInstanceOf(EvalError);
    expect(evalFailure(new RangeError("x")).message).toBe("evaluation failed");
    const e = new EvalError("kept");
    expect(evalFailure(e)).toBe(e);
  });

  test("dates beyond the representable range are an error", () => {
    expect(() => ev(`date("2026-01-01") + duration("999999999999999999y")`)).toThrow("date is out of range");
    expect(() => ev(`date("2026-01-01") + duration("1${"0".repeat(400)}y")`)).toThrow("date is out of range");
    expect(() => ev(`(duration("1${"0".repeat(400)}d") + date("2026-01-01")).format("MMMM")`)).toThrow(
      "date is out of range"
    );
  });

  test("formula chains: a long chain is an error, a long ring is reported quickly", () => {
    const chain = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, i === n - 1 ? "1" : `formula.f${i + 1} + 1`]));
    const ok = within(() => validateBase({ formulas: chain(32) }));
    expect(ok.errors).toEqual([]);
    const tooLong = within(() => validateBase({ formulas: chain(10_000) }));
    expect(tooLong.errors).toEqual(["formulas.f0: references are nested more than 32 deep"]);

    const ring = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`r${i}`, `formula.r${(i + 1) % 5000}`]));
    const cyc = within(() => validateBase({ formulas: ring }));
    expect(cyc.errors.length).toBe(5000);
    expect(cyc.errors[0]).toBe("formulas.r0: circular reference");

    const lines = Object.entries(chain(32)).map(([k, v]) => `  ${k}: '${v}'`);
    const result = run(
      `formulas:\n${lines.join("\n")}\nviews:\n  - type: table\n    name: T\n    order: [formula.f0]\n    limit: 1\n`
    );
    expect(result.rows?.[0]?.cells[0]).toBe(32);
  });
});

describe("ordering with NaN", () => {
  test("list sort puts NaN after every number", () => {
    const ev = (src: string) => evalExpression(src, row("wiki/x/note.md", {}), { now: NOW });
    expect(ev(`[2, 0 / 0, 1, 0 / 0, 3].sort().join(",")`)).toBe("1,2,3,NaN,NaN");
  });

  test("view sort and groupBy: NaN after the numbers, before empty values, one group", () => {
    const rows: BaseRow[] = [
      row("wiki/n/a.md", { v: 2 }),
      row("wiki/n/b.md", { v: Number.NaN }),
      row("wiki/n/c.md", {}),
      row("wiki/n/d.md", { v: 1 }),
      row("wiki/n/e.md", { v: Number.NaN }),
    ];
    const out = runBase(
      parseYaml("views: [{type: table, name: T, order: [file.basename], sort: [{property: v}]}]"),
      rows,
      { now: NOW }
    );
    expect(out.rows?.map((r) => r.cells[0])).toEqual(["d", "a", "b", "e", "c"]);
    const grouped = runBase(
      parseYaml("views: [{type: table, name: T, order: [file.basename], groupBy: {property: v}}]"),
      rows,
      { now: NOW }
    );
    expect(grouped.groups?.map((g) => g.count)).toEqual([1, 1, 2, 1]);
  });
});

describe("summaries and groups cover every match", () => {
  test("a limit caps the listed rows, not the summaries or the total", () => {
    const result = run(
      `views:\n  - type: table\n    name: T\n    filters: price\n    order: [file.basename, price]\n    summaries: {price: Sum, file.basename: Count}\n`,
      { limit: 2 }
    );
    expect(result.total).toBe(3);
    expect(result.shown).toBe(2);
    expect(result.summaries).toEqual([
      { column: "file.basename", summary: "Count", value: 3 },
      { column: "price", summary: "Sum", value: 60 },
    ]);
  });

  test("groups keep their full counts and say when rows were cut", () => {
    const result = run(
      `views:\n  - type: table\n    name: T\n    order: [file.basename, price]\n    groupBy: {property: type}\n    summaries: {price: Sum}\n`,
      { limit: 3 }
    );
    expect(result.shown).toBe(3);
    expect(result.groups?.map((g) => [g.key, g.count, g.rows.length, g.truncated])).toEqual([
      ["Concept", 2, 2, undefined],
      ["Project", 2, 1, true],
    ]);
    expect(result.groups?.[1]?.summaries).toEqual([{ column: "price", summary: "Sum", value: 40 }]);
    expect(renderBaseMarkdown(result)).toContain("### Project (1 of 2 rows shown)");

    const none = run(
      `views:\n  - type: table\n    name: T\n    order: [file.basename]\n    groupBy: {property: type}\n`,
      { limit: 2 }
    );
    expect(none.groups?.[1]).toMatchObject({ key: "Project", count: 2, truncated: true, rows: [] });
    expect(renderBaseMarkdown(none)).toContain("(no rows shown)");
  });

  test("columns that are not summarised are not evaluated for rows that are not listed", () => {
    const result = run(
      `formulas:\n  bad: 'price.toFixed()'\nviews:\n  - type: table\n    name: T\n    filters: price\n    order: [file.basename, formula.bad]\n    summaries: {file.basename: Count}\n`,
      { limit: 1 }
    );
    expect(result.warnings).toEqual(["formula.bad: toFixed() needs a number"]);
    expect(result.summaries[0]?.value).toBe(3);
  });
});

describe("durations", () => {
  const ev = (src: string) => evalExpression(src, row("wiki/x/note.md", {}), { now: NOW });
  test("M is months and m is minutes; words and plurals work", () => {
    expect(ev(`(date("2026-01-31 00:00") + "30m").format("HH:mm")`)).toBe("00:30");
    expect(ev(`(date("2026-01-31") + "1M").format("YYYY-MM-DD")`)).toBe("2026-02-28");
    expect(ev(`(date("2026-01-31") + "2 Months").format("YYYY-MM-DD")`)).toBe("2026-03-31");
    expect(ev(`(date("2026-01-01 00:00") + "90 minutes").format("HH:mm")`)).toBe("01:30");
    expect(ev(`(date("2026-01-01 00:00") + "1h 30m").format("HH:mm")`)).toBe("01:30");
    expect(ev(`(date("2026-01-01") + "1y").format("YYYY")`)).toBe("2027");
  });

  test("milliseconds and other undocumented units are rejected, never turned into minutes", () => {
    for (const unit of ["ms", "MS", "Ms", "msec", "mins", "sec", "hrs", "Y", "H", "D"]) {
      expect(() => ev(`duration("5${unit}")`)).toThrow("duration() cannot read that value");
      expect(() => ev(`date("2026-01-01") + "5${unit}"`)).toThrow("cannot apply '+' to date and string");
    }
    expect(() => ev(`duration("5")`)).toThrow("duration() cannot read that value");
  });
});

describe("base_write is confined to the wiki layer", () => {
  let flat: string;
  let flatWs: Workspace;
  beforeEach(async () => {
    flat = await mkdtemp(join(tmpdir(), "okf-bases-flat-"));
    await writeFile(join(flat, "note.md"), "---\ntype: Concept\n---\n\nx\n");
    flatWs = new Workspace({ watch: false });
    await flatWs.open(flat);
  });
  afterEach(async () => {
    await flatWs.close();
    await removeTempDir(flat);
  });

  test("in a flat bundle, hidden folders are refused; ordinary folders are fine", async () => {
    const attempt = (path: string) =>
      callTool(flatWs, "base_write", { path, content: "views: []\n", actor: "process:test" });
    const ok = await attempt("bases/x.base");
    expect(ok.isError).toBeUndefined();
    expect((await attempt("top.base")).isError).toBeUndefined();
    for (const path of [".okf/x.base", ".git/x.base", "a/.hidden/x.base", ".x.base", "a/./.okf/x.base"]) {
      const out = await attempt(path);
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toBe(`A .base file cannot live in a hidden folder: ${path}`);
    }
    // raw/ stays refused by the layer rule; an escape is refused by the path check.
    expect((await attempt("raw/x.base")).content[0]!.text).toBe("A .base file must live under wiki/: raw/x.base");
    expect((await attempt("../x.base")).isError).toBe(true);
    expect((await attempt("a/../../x.base")).isError).toBe(true);
    await expect(readFile(join(flat, ".okf", "x.base"), "utf8")).rejects.toThrow();
  });

  test("in a normal bundle, a hidden folder under wiki/ is refused too", async () => {
    const out = await callTool(workspace, "base_write", {
      path: "wiki/.hidden/x.base",
      content: "views: []\n",
      actor: "process:test",
    });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toBe("A .base file cannot live in a hidden folder: wiki/.hidden/x.base");
  });
});
