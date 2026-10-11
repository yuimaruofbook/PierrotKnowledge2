/**
 * The Rust headless server answers exactly as the TypeScript one does.
 *
 * Agents only ever see the MCP surface, so that is what is compared: the same
 * script of calls goes to both servers over stdio, each against its own copy
 * of the same bundle, and every response must match once the parts that differ
 * by nature — the temp folder's path, clocks — are masked.
 *
 * Skipped when the Rust binary has not been built (`cargo build --release
 * --manifest-path rust/Cargo.toml`), or point `OKF_RUST_MCP` at one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { activityRelPath } from "../src/shared/okf";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { removeTempDir } from "./helpers";

const RUST_BINARY =
  process.env.OKF_RUST_MCP ??
  resolve("rust", "target", "release", process.platform === "win32" ? "okf-mcp.exe" : "okf-mcp");
const TS_SERVER = resolve("src", "bun", "mcp", "standalone.ts");

/** The calls both servers receive, in order. Writes come before the reads that would see them. */
const SCRIPT: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["bundle_info", {}],
  ["read_map", {}],
  ["read_agents_md", {}],
  ["read_human", {}],
  ["list_files", {}],
  ["list_files", { path: "wiki", recursive: true }],
  ["list_concepts", {}],
  ["list_tags", {}],
  ["search", { query: "知識" }],
  ["search", { query: "alpha", limit: 3 }],
  ["retrieve", { query: "日本語の検索" }],
  ["context_pack", { task: "Alpha について調べる" }],
  ["read_file", { path: "wiki/alpha.md" }],
  ["read_file", { path: "wiki/missing.md" }],
  ["backlinks", { id: "alpha" }],
  ["unresolved_links", {}],
  ["check_conformance", {}],
  ["create_concept", {
    path: "wiki/beta.md",
    type: "Concept",
    title: "Beta",
    description: "二つ目の概念",
    tags: ["parity", "テスト"],
    body: "[[alpha]] を参照する。",
    actor: "process:parity",
  }],
  ["write_file", { path: "wiki/gamma.md", content: "---\ntype: Entity\ntitle: Gamma\n---\n\n# Gamma\n\n[[beta]] と [[nowhere]]\n" }],
  ["write_file", { path: "raw/forbidden.md", content: "x" }],
  ["backlinks", { id: "beta" }],
  ["unresolved_links", {}],
  ["set_para", { path: "wiki/beta.md", para: "project" }],
  ["list_para", {}],
  ["list_para", { para: "project" }],
  ["move_file", { from: "wiki/gamma.md", to: "wiki/topic/gamma.md", actor: "process:parity" }],
  ["create_directory", { path: "wiki/empty" }],
  ["delete_file", { path: "wiki/topic/gamma.md", actor: "process:parity" }],
  ["add_task", { title: "パリティを確かめる", status: "doing", para: "project", due: "2026-12-31", note: "一行" }],
  ["add_task", { title: "second" }],
  ["update_task", { id: "T-0001", status: "done" }],
  ["update_task", { id: "T-9999", status: "done" }],
  ["list_tasks", {}],
  ["daily_note", { date: "2026-08-04" }],
  ["collect_daily_tasks", { date: "2026-08-04" }],
  ["skill_list", {}],
  ["skill_find", { task: "週次の点検をしたい" }],
  ["skill_open", { name: "nope" }],
  ["loop_list", {}],
  ["loop_define", { goal: "Keep the wiki tidy every week", name: "tidy" }],
  ["loop_start", { name: "tidy", actor: "process:parity" }],
  ["loop_note", { detail: "looked at alpha" }],
  ["loop_end", { outcome: "done for now" }],
  ["loop_read", { name: "tidy" }],
  ["audit_changes", {}],
  ["rebuild_index", {}],
  ["rebuild_rag", {}],
  ["search", { query: "Beta", tags: ["parity"] }],
  ["no_such_tool", {}],
];

/**
 * Error paths, argument coercion and every tool's less-travelled branches.
 * Runs after SCRIPT against the state it left. `<BUNDLE>` stands for each
 * server's own bundle path.
 */
const SCRIPT_MORE: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["write_human", { content: "" }],
  ["write_human", { content: "   " }],
  ["write_human", { content: "# 私\n\n短く話す。\n" }],
  ["read_human", {}],
  ["list_tasks", { status: "bogus" }],
  ["list_tasks", { status: "done" }],
  ["list_tasks", { status: "doing" }],
  ["list_tasks", { status: null }],
  ["add_task", { title: "" }],
  ["add_task", { title: "x", status: "weird" }],
  ["add_task", { title: "x", para: "nope" }],
  ["add_task", { title: "  padded  ", due: "2026-09-01", note: 5 }],
  ["update_task", {}],
  ["update_task", { id: "T-0002", title: "renamed", para: "area", note: "n", due: "2026-10-01", status: "doing" }],
  ["update_task", { id: "T-0001", status: "todo" }],
  ["update_task", { id: "T-0002", para: "zzz" }],
  ["update_task", { id: "T-0002", status: "bad" }],
  ["list_tasks", {}],
  ["list_tasks", { status: "done" }],
  ["daily_note", {}],
  ["daily_note", { date: "2026-02-30" }],
  ["daily_note", { date: "yesterday" }],
  ["daily_note", { date: "0026-01-01" }],
  ["collect_daily_tasks", { date: "bad" }],
  ["collect_daily_tasks", { date: "2031-01-01" }],
  ["write_file", { path: "wiki/daily/2026-09-09.md", content: "---\ntype: Daily\ntitle: d\n---\n\n## タスク\n\n- [ ] one\n  - [ ] nested\n- [x] finished\n- [ ]\n- [ ] two\n\n## 他\n\n- [ ] not a task\n" }],
  ["collect_daily_tasks", { date: "2026-09-09" }],
  ["collect_daily_tasks", { date: "2026-09-09" }],
  ["read_file", { path: "wiki/daily/2026-09-09.md" }],
  ["list_tasks", {}],
  ["retrieve", {}],
  ["retrieve", { query: "alpha", limit: 2, budget_chars: 200, expand_neighbours: true, type: "Concept", tags: ["parity"], path_prefix: "wiki/" }],
  ["retrieve", { query: "zzzzqqq" }],
  ["context_pack", {}],
  ["context_pack", { task: "x", tier: "bogus" }],
  ["context_pack", { task: "Alpha を調べる", tier: "worker" }],
  ["context_pack", { task: "Alpha を調べる", tier: "supervisor", budget_chars: 500, limit: 2 }],
  ["context_pack", { task: "zzzzqqq" }],
  ["search", {}],
  ["search", { query: "zzzzqqq" }],
  ["search", { query: "alpha", type: "Concept", path_prefix: "wiki/", limit: 1 }],
  ["list_files", { path: "../" }],
  ["list_files", { path: "nope" }],
  ["list_files", { recursive: true }],
  ["list_files", { path: "wiki", recursive: "yes" }],
  ["read_file", {}],
  ["read_file", { path: "wiki/log.md" }],
  ["read_file", { path: "wiki/index.md" }],
  ["read_file", { path: "../outside.md" }],
  ["write_file", {}],
  ["write_file", { path: "wiki/delta.md", content: "no frontmatter" }],
  ["write_file", { path: "wiki/eps.md", content: "---\ntype: Concept\ngenerated:\n  by: h\n---\n\nbody" }],
  ["write_file", { path: "wiki/n.md", content: "---\ntype: Concept\n---\nx", note: "hello", actor: "process:x" }],
  ["write_file", { path: "wiki/skills/zz/SKILL.md", content: "---\nname: zz\ndescription: zz skill\n---\nbody" }],
  ["write_file", { path: "wiki/index.md", content: "# not allowed?" }],
  ["list_concepts", {}],
  ["check_conformance", {}],
  ["create_concept", {}],
  ["create_concept", { path: "a.md" }],
  ["create_concept", { path: "x.txt", type: "Concept" }],
  ["create_concept", { path: "wiki/1-projects/proj.md", type: "Project" }],
  ["list_concepts", {}],
  ["check_conformance", {}],
  ["backlinks", {}],
  ["backlinks", { id: "nope" }],
  ["move_file", {}],
  ["move_file", { from: "raw/x.md", to: "wiki/x.md" }],
  ["move_file", { from: "wiki/nope.md", to: "wiki/b.md" }],
  ["move_file", { from: "wiki/alpha.md", to: "wiki/2-areas/alpha.md" }],
  ["move_file", { from: "wiki/n.md", to: "wiki/n.md" }],
  ["delete_file", {}],
  ["delete_file", { path: "wiki/index.md" }],
  ["delete_file", { path: "wiki/nope.md" }],
  ["delete_file", { path: "wiki/2-areas/alpha.md" }],
  ["create_directory", {}],
  ["create_directory", { path: "raw/x" }],
  ["set_para", {}],
  ["set_para", { path: "wiki/beta.md", para: "bogus" }],
  ["set_para", { path: "wiki/beta.md", para: "archive" }],
  ["set_para", { path: "wiki/missing.md", para: "area" }],
  ["list_para", { para: "bogus" }],
  ["list_para", {}],
  ["audit_changes", { since: "bad" }],
  ["audit_changes", { since: "2020-01-01", actor: "process:" }],
  ["audit_changes", { actor: "nobody" }],
  ["skill_find", {}],
  ["skill_find", { task: "ingest notes into the wiki", limit: 1 }],
  ["skill_find", { task: "zzzz" }],
  ["skill_list", {}],
  ["skill_open", {}],
  ["skill_open", { name: "okf-ingest" }],
  ["skill_read", { name: "okf-ingest", path: "reference.md" }],
  ["skill_read", { name: "okf-ingest", path: "../../AGENTS.md" }],
  ["skill_read", { name: "okf-ingest", path: "nope.md" }],
  ["skill_read", {}],
  ["list_concepts", {}],
  ["check_conformance", {}],
  ["loop_note", { detail: "nothing running" }],
  ["loop_end", {}],
  ["loop_start", {}],
  ["loop_start", { name: "ghost" }],
  ["loop_define", { goal: "Ingest new meeting notes into the wiki" }],
  ["list_concepts", {}],
  ["check_conformance", {}],
  ["loop_start", { goal: "Ingest new meeting notes into the wiki" }],
  ["loop_start", { name: "tidy" }],
  ["write_file", { path: "wiki/journaled.md", content: "---\ntype: Concept\n---\nj" }],
  ["move_file", { from: "wiki/journaled.md", to: "wiki/journaled2.md" }],
  ["delete_file", { path: "wiki/journaled2.md" }],
  ["loop_note", {}],
  ["loop_note", { detail: "d", action: "decide" }],
  ["loop_define", { goal: "x", name: "Bad Name" }],
  ["loop_define", {}],
  ["loop_define", { goal: "Check things", name: "checker", skill: "wiki-lint", checks: ["one", "two", 3] }],
  ["write_file", { path: "wiki/broken.md", content: "no frontmatter at all" }],
  ["loop_end", { outcome: "regressed on purpose" }],
  ["loop_list", {}],
  ["loop_read", { name: "ingest-new-meeting-notes-into-the-wiki" }],
  ["loop_read", {}],
  ["loop_read", { name: "nope" }],
  ["loop_start", { name: "checker", actor: "process:parity" }],
  ["loop_end", { status: "abandoned" }],
  ["loop_read", { name: "checker" }],
  ["rebuild_index", {}],
  ["read_file", { path: "wiki/index.md" }],
  ["open_bundle", {}],
  ["open_bundle", { path: "<BUNDLE>" }],
  ["bundle_info", {}],
  ["list_concepts", {}],
  ["open_bundle", { path: "<BUNDLE>/nope" }],
  ["bundle_info", {}],
  ["read_map", {}],
  ["search", { query: "alpha" }],
  ["loop_list", {}],
  ["skill_list", {}],
  ["list_tasks", {}],
  ["context_pack", { task: "x" }],
];

/** The local calendar day, as log.md files today's rows under it. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const note = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n\n${body}\n`;

/**
 * Lifecycle tags, context range, activity summaries and know-how: every new
 * tool and parameter, with the error paths. Builds its own fixtures so it does
 * not depend on what the scripts above left behind. The summaries cite today's
 * log rows, so their paths carry today's date.
 */
function newFeatureScript(): ReadonlyArray<readonly [string, Record<string, unknown>]> {
  const day = today();
  const TOPIC = "tapir canopy telemetry";
  const KIWI = "kiwi orchard survey notes";
  const KNOW = "quote windows path spaces shell";
  const out: Array<readonly [string, Record<string, unknown>]> = [];
  const add = (name: string, args: Record<string, unknown> = {}) => void out.push([name, args]);
  // SCRIPT_MORE ends on a failed open_bundle, which leaves nothing open: without
  // this every call below would answer "no bundle open" on both sides and agree
  // for the wrong reason.
  add("open_bundle", { path: "<BUNDLE>" });

  // -- lifecycle fixtures: a live note, a retired one, a Product twin of a plain one
  add("write_file", { path: "wiki/lc/live.md", content: note("type: Concept\ntitle: Live Kiwi\ntags: [kiwi]", `# Live Kiwi\n\n${KIWI}`) });
  add("write_file", { path: "wiki/lc/old.md", content: note("type: Concept\ntitle: Old Kiwi\ntags: [kiwi, dead]", `# Old Kiwi\n\n${KIWI}`) });
  add("write_file", { path: "wiki/lc/plain.md", content: note("type: Concept\ntitle: Plain Fig\nstatus: draft", "# Plain Fig\n\nfig orchard depth notes") });
  add("write_file", { path: "wiki/lc/shipped.md", content: note("type: Concept\ntitle: Shipped Fig\nstatus: draft\ntags: [product]", "# Shipped Fig\n\nfig orchard depth notes") });
  add("write_file", { path: "wiki/lc/both.md", content: note("type: Concept\ntitle: Both\ntags: [Product, DEAD, other]", "# Both\n\nfig orchard depth notes") });
  add("search", { query: "fig orchard depth" });
  add("search", { query: "fig orchard depth", include_dead: true });
  add("retrieve", { query: "fig orchard depth notes" });
  add("context_pack", { task: "fig orchard depth notes" });
  add("search", { query: "kiwi" });
  add("search", { query: "kiwi", include_dead: true });
  add("search", { query: "kiwi", include_dead: false });
  add("search", { query: "kiwi", include_dead: "yes" });
  add("search", { query: "kiwi", tags: ["DEAD"] });
  add("search", { query: "kiwi", tags: ["DEAD"], include_dead: true });
  add("search", { query: "kiwi", tags: ["dead"], include_dead: true });
  add("retrieve", { query: KIWI });
  add("retrieve", { query: KIWI, include_dead: true });
  add("context_pack", { task: KIWI });
  add("context_pack", { task: KIWI, include_dead: true, tier: "worker" });
  add("list_concepts");

  // -- set_lifecycle: errors first, then every transition
  add("set_lifecycle");
  add("set_lifecycle", { path: "wiki/lc/plain.md" });
  add("set_lifecycle", { path: "wiki/lc/plain.md", lifecycle: "alive" });
  add("set_lifecycle", { path: "wiki/lc/plain.md", lifecycle: 5 });
  add("set_lifecycle", { lifecycle: "dead" });
  add("set_lifecycle", { path: "wiki/lc/missing.md", lifecycle: "dead" });
  add("set_lifecycle", { path: "raw/README.md", lifecycle: "dead" });
  add("set_lifecycle", { path: "wiki/index.md", lifecycle: "dead" });
  add("set_lifecycle", { path: "wiki/log.md", lifecycle: "dead" });
  add("set_lifecycle", { path: "../x.md", lifecycle: "dead" });
  add("write_file", { path: "wiki/lc/nofm.md", content: "no frontmatter" });
  add("set_lifecycle", { path: "wiki/lc/nofm.md", lifecycle: "dead" });
  add("write_file", { path: "wiki/lc/strtags.md", content: note("type: Concept\ntags: just-a-string", "x") });
  add("set_lifecycle", { path: "wiki/lc/strtags.md", lifecycle: "dead" });
  add("write_file", { path: "wiki/lc/badyaml.md", content: "---\ntype: [unclosed\n---\nx" });
  add("set_lifecycle", { path: "wiki/lc/badyaml.md", lifecycle: "dead" });
  add("write_file", { path: "wiki/lc/nulltags.md", content: note("type: Concept\ntags:\ntitle: Null Tags\ncustom: {a: 1}", "x") });
  add("set_lifecycle", { path: "wiki/lc/nulltags.md", lifecycle: "product" });
  add("read_file", { path: "wiki/lc/nulltags.md" });
  add("set_lifecycle", { path: "wiki/lc/nulltags.md", lifecycle: "none" });
  add("read_file", { path: "wiki/lc/nulltags.md" });
  add("set_lifecycle", { path: "wiki/lc/plain.md", lifecycle: " Product ", actor: "process:parity" });
  add("read_file", { path: "wiki/lc/plain.md" });
  add("set_lifecycle", { path: "wiki/lc/plain.md", lifecycle: "product" });
  add("set_lifecycle", { path: "wiki/lc/plain.md", lifecycle: "DEAD" });
  add("read_file", { path: "wiki/lc/plain.md" });
  add("set_lifecycle", { path: "wiki/lc/both.md", lifecycle: "product" });
  add("read_file", { path: "wiki/lc/both.md" });
  add("set_lifecycle", { path: "wiki/lc/old.md", lifecycle: "dead" });
  add("set_lifecycle", { path: "wiki/lc/old.md", lifecycle: "none" });
  add("read_file", { path: "wiki/lc/old.md" });
  add("set_lifecycle", { path: "wiki/lc/old.md", lifecycle: "dead" });
  add("search", { query: "fig orchard depth" });
  add("search", { query: "kiwi" });
  add("list_concepts");
  add("audit_changes", { actor: "process:parity" });

  // -- set_lifecycle edits only the tags entry: comments, quoting, styles, CRLF
  const raw = (name: string, content: string) => add("write_file", { path: `wiki/lc/${name}.md`, content });
  const lifecycleOn = (name: string, ...choices: string[]) => {
    for (const lifecycle of choices) {
      add("set_lifecycle", { path: `wiki/lc/${name}.md`, lifecycle, actor: "process:parity" });
      add("read_file", { path: `wiki/lc/${name}.md` });
    }
  };
  raw("flow", "---\n# keep me\ntype: Concept\ntitle: \"Quoted: title\"   # trailing\nversion: 1.10\nowner: 'o''brien'\ntags: [kiwi, \"b c\", 'it''s', DEAD]  # why\nweird:   spaced\nnested:\n  a: 1\n  b: [x,   y]\n---\n\nbody kiwi flow\n");
  lifecycleOn("flow", "product", "dead", "none");
  raw("flowml", "---\ntype: Concept\ntags: [a,\n  \"b, c\",\n  DEAD]\nversion: 1.10\n---\nbody\n");
  lifecycleOn("flowml", "product", "none");
  raw("flowcomment", "---\ntype: Concept\ntags: [a,\n  # inner comment\n  b]\n---\nbody\n");
  lifecycleOn("flowcomment", "dead");
  raw("block", "---\ntype: Concept\ntags:\n  - kiwi\n  # between\n  - DEAD\n  - \"b c\"\nversion: 1.10\n---\nbody\n");
  lifecycleOn("block", "product", "dead", "none");
  raw("blockflush", "---\ntype: Concept\ntags:\n- a\n- Product\nx: 1\n---\nbody\n");
  lifecycleOn("blockflush", "dead", "none");
  raw("quoted", "---\ntype: Concept\ntags: [a, \"DEAD\", b]\nversion: 1.10\n---\nbody\n");
  lifecycleOn("quoted", "dead", "product", "none");
  raw("absent", "---\ntype: Concept\nversion: 1.10\ntitle: 'Absent: one'\n---\nbody\n");
  lifecycleOn("absent", "dead", "none");
  raw("empty", "---\ntype: Concept\ntags: []\nx: 1\n---\nbody\n");
  lifecycleOn("empty", "product", "none");
  raw("nullc", "---\ntype: Concept\ntags:   # none yet\nx: 1\n---\nbody\n");
  lifecycleOn("nullc", "product");
  raw("tilde", "---\ntype: Concept\ntags: ~\nx: 1\n---\nbody\n");
  lifecycleOn("tilde", "dead");
  raw("crlf", "---\r\ntype: Concept\r\nversion: 1.10\r\ntags:\r\n  - a\r\n---\r\nbody\r\n");
  lifecycleOn("crlf", "dead", "none");
  raw("crlfabsent", "---\r\ntype: Concept\r\n---\r\nbody\r\n");
  lifecycleOn("crlfabsent", "dead");
  raw("lower", "---\ntype: Concept\ntags: [dead, product, Dead]\n---\nbody\n");
  lifecycleOn("lower", "dead", "product", "none");
  raw("alias", "---\ntype: Concept\ntags: &shared [a, b]\n---\nbody\n");
  lifecycleOn("alias", "dead");
  raw("eof", "---\ntype: Concept\ntags: [DEAD]\n---\nbody\n");
  lifecycleOn("eof", "none", "product");
  raw("onlyfm", "---\ntags: [a]\n---");
  lifecycleOn("onlyfm", "dead");
  raw("bom", "﻿---\ntype: Concept\ntags: [a]\n---\nbody\n");
  lifecycleOn("bom", "dead");
  raw("mixed", "---\ntype: Concept\ntags: [1, true, null, [x, y], {k: v}, \"日本語\", DEAD]\nx: 1\n---\nbody\n");
  lifecycleOn("mixed", "product", "none");
  raw("quotedkey", "---\ntype: Concept\n\"tags\": [a]\nx: 1\n---\nbody\n");
  lifecycleOn("quotedkey", "dead");
  raw("spaces", "---\ntype: Concept\ntags   :    [ a ,b,   c ]   \nx: 1\n---\nbody\n");
  lifecycleOn("spaces", "dead", "none");
  raw("trailingblank", "---\ntype: Concept\ntags:\n  - a\n\nx: 1\n---\nbody\n");
  lifecycleOn("trailingblank", "product");
  raw("apostrophe", "---\ntype: Concept\ntags: [don't, it's, \"q,\"]\n---\nbody\n");
  lifecycleOn("apostrophe", "dead");
  raw("deepblock", "---\ntype: Concept\ntags:\n    - a\n    - b: c\n      d: e\n    - DEAD\nx: 1\n---\nbody\n");
  lifecycleOn("deepblock", "product");
  raw("tagsonly", "---\ntags: [DEAD]\ntype: Concept\n---\nbody\n");
  lifecycleOn("tagsonly", "none");
  raw("duptags", "---\ntype: Concept\ntags: [a]\ntags: [b]\n---\nbody\n");
  lifecycleOn("duptags", "dead");
  add("search", { query: "kiwi", tags: ["Product"] });
  add("list_concepts");

  // -- para_depth / link_depth fixtures
  for (const [rel, label] of [["1-projects/p", "project"], ["2-areas/a", "area"], ["3-resources/r", "resource"], ["loose", "unfiled"], ["4-archive/z", "archive"]] as const) {
    add("write_file", { path: `wiki/${rel}.md`, content: note(`type: Concept\ntitle: ${label}`, `# ${label}\n\n${TOPIC} for the ${label}`) });
  }
  add("write_file", { path: "wiki/head.md", content: note("type: Concept\ntitle: Head\ndescription: the entry point", "# Head\n\nzebu pasture rotation plan. See [[mid]] and [[retired-link]] and [[4-archive/old-link]] and [here](loose.md).") });
  add("write_file", { path: "wiki/mid.md", content: note("type: Concept\ntitle: Mid\ndescription: the middle step", "# Mid\n\nSecret body text that must never be copied. Next is [[tail]] and back to [[head]].") });
  add("write_file", { path: "wiki/tail.md", content: note("type: Concept\ntitle: Tail\ndescription: the far end", "# Tail\n\nthe end") });
  add("write_file", { path: "wiki/retired-link.md", content: note("type: Concept\ntitle: Retired link\ntags: [DEAD]\ndescription: gone", "# R\n\nx") });
  add("write_file", { path: "wiki/4-archive/old-link.md", content: note("type: Concept\ntitle: Old link\ndescription: shelved", "# O\n\nx") });
  for (const depth of [1, 2, 3, 4]) {
    add("retrieve", { query: TOPIC, para_depth: depth });
    add("context_pack", { task: TOPIC, para_depth: depth });
  }
  add("retrieve", { query: TOPIC, para_depth: null });
  add("retrieve", { query: TOPIC, para_depth: 2.0 });
  add("retrieve", { query: TOPIC, para_depth: 2, type: "Concept", path_prefix: "wiki/", limit: 2 });
  for (const bad of [0, 5, 1.5, -1, "2", true, [], {}, [1]]) {
    add("retrieve", { query: TOPIC, para_depth: bad });
    add("context_pack", { task: TOPIC, para_depth: bad });
  }
  const HEAD = "zebu pasture rotation plan";
  add("retrieve", { query: HEAD });
  for (const depth of [0, 1, 2]) {
    add("retrieve", { query: HEAD, link_depth: depth });
    add("context_pack", { task: HEAD, link_depth: depth });
  }
  add("retrieve", { query: HEAD, link_depth: 2, include_dead: true });
  add("context_pack", { task: HEAD, link_depth: 2, include_dead: true, tier: "supervisor" });
  add("retrieve", { query: HEAD, link_depth: 2, para_depth: 3 });
  add("context_pack", { task: HEAD, link_depth: 1, para_depth: 1 });
  add("retrieve", { query: HEAD, link_depth: 1, expand_neighbours: true });
  add("retrieve", { query: "zzzzqqq", link_depth: 2 });
  add("context_pack", { task: "zzzzqqq", link_depth: 2 });
  for (const budget of [60, 100, 120, 135, 150, 170, 200, 260, 500]) {
    add("retrieve", { query: HEAD, link_depth: 2, budget_chars: budget });
    add("context_pack", { task: HEAD, link_depth: 2, budget_chars: budget });
  }
  for (const bad of [-1, 3, 0.5, "1", false, [], {}]) {
    add("retrieve", { query: HEAD, link_depth: bad });
    add("context_pack", { task: HEAD, link_depth: bad });
  }
  add("retrieve", { query: HEAD, para_depth: 9, link_depth: 9 });

  // -- know-how
  add("knowhow_add");
  add("knowhow_add", { title: "  " });
  add("knowhow_add", { title: "t" });
  add("knowhow_add", { title: "t", body: "  " });
  add("knowhow_add", { title: "t", body: "b" });
  add("knowhow_add", { title: "t", body: "b", actor: "  " });
  add("knowhow_add", { title: "Quote Windows paths", body: "Quote any path with spaces before passing it to a shell command.\nSecond line.", tags: ["windows", "shell", 3], actor: "process:claude-code" });
  add("knowhow_add", { title: "Quote Windows paths", body: "dup of the first", actor: "process:codex" });
  add("knowhow_add", { title: "Quote Windows paths", body: "third one", actor: "process:codex" });
  add("knowhow_add", { title: "日本語の罠", body: "## 見出し\n- パスの区切りに注意する", actor: "process:codex", tags: ["日本語"] });
  add("knowhow_add", { title: "!!!", body: "x", actor: "process:a" });
  add("knowhow_add", { title: "Retry flaky downloads", body: "The release server drops connections; retry with backoff.", tags: "network", actor: "process:codex" });
  add("knowhow_add", { title: "Long", body: `${"x".repeat(200)}\nmore`, actor: "process:codex" });
  add("read_file", { path: "wiki/knowhow/quote-windows-paths.md" });
  add("read_file", { path: "wiki/knowhow/quote-windows-paths-2.md" });
  add("read_file", { path: "wiki/knowhow/日本語の罠.md" });
  add("read_file", { path: "wiki/knowhow/knowhow.md" });
  add("read_file", { path: "wiki/knowhow/long.md" });
  add("knowhow_find");
  add("knowhow_find", { task: "  " });
  add("knowhow_find", { task: KNOW });
  add("knowhow_find", { task: KNOW, limit: 1 });
  for (const limit of [0, -3, "2", 99, 1.7, null]) add("knowhow_find", { task: KNOW, limit });
  add("knowhow_find", { task: "日本語 パス" });
  add("knowhow_find", { task: "retry downloads backoff" });
  add("knowhow_find", { task: "zzzzqqq" });
  add("set_lifecycle", { path: "wiki/knowhow/retry-flaky-downloads.md", lifecycle: "dead" });
  add("knowhow_find", { task: "retry downloads backoff" });
  add("context_pack", { task: "retry downloads backoff" });
  add("context_pack", { task: "retry downloads backoff", include_dead: true });
  add("context_pack", { task: `${KNOW} command` });
  add("context_pack", { task: `${KNOW} command`, tier: "worker", para_depth: 2 });
  add("context_pack", { task: `${KNOW} command`, para_depth: 3 });
  add("search", { query: "windows path", type: "Knowhow" });
  add("list_files", { path: "wiki/knowhow" });
  add("list_concepts");

  // -- know-how titles that collide with reserved or device names
  for (const title of ["Index", "log", "AGENTS", "map", "Human", "task", "tasks", "CON", "prn", "Aux", "nul", "COM1", "lpt9", "com10", "console"]) {
    add("knowhow_add", { title, body: `lesson about ${title} files`, actor: "process:parity" });
  }
  add("knowhow_add", { title: "index", body: "second lesson about index files", actor: "process:parity" });
  add("read_file", { path: "wiki/knowhow/index-note.md" });
  add("read_file", { path: "wiki/knowhow/nul-note.md" });
  add("knowhow_find", { task: "lesson about index files" });
  add("search", { query: "lesson about index files", type: "Knowhow" });
  add("list_files", { path: "wiki/knowhow" });
  add("rebuild_index");
  add("read_file", { path: "wiki/knowhow/index.md" });

  // -- the pack's know-how follows the caller's filters and pays from the budget
  const PACK = `${KNOW} command`;
  add("context_pack", { task: PACK, path_prefix: "wiki/knowhow" });
  add("context_pack", { task: PACK, path_prefix: "wiki/nowhere" });
  add("context_pack", { task: PACK, path_prefix: "WIKI/KNOW" });
  add("context_pack", { task: PACK, tags: ["windows"] });
  add("context_pack", { task: PACK, tags: ["Windows", "shell"] });
  add("context_pack", { task: PACK, tags: ["network"] });
  add("context_pack", { task: PACK, type: "Knowhow" });
  add("context_pack", { task: PACK, type: "Concept" });
  add("context_pack", { task: PACK, type: "Knowhow", tags: ["windows"], path_prefix: "wiki/knowhow", link_depth: 1 });
  for (const budget of [1, 20, 60, 120, 200, 300, 450, 700, 1500, 6000]) {
    add("context_pack", { task: PACK, budget_chars: budget });
    add("context_pack", { task: PACK, budget_chars: budget, link_depth: 1 });
  }
  add("context_pack", { task: PACK, tier: "worker" });
  add("context_pack", { task: PACK, tier: "supervisor", budget_chars: 50 });

  // -- link_depth honours type, tags and path_prefix like the passages do
  add("write_file", { path: "wiki/pool/lead.md", content: note("type: Concept\ntitle: Lead\ntags: [x]", "# Lead\n\nquail roost census. See [[pool/same]], [[pool/other-type]], [[pool/other-tag]] and [[elsewhere/far]].") });
  add("write_file", { path: "wiki/pool/same.md", content: note("type: Concept\ntitle: Same\ntags: [x]\ndescription: kept", "# S\n\nx") });
  add("write_file", { path: "wiki/pool/other-type.md", content: note("type: Reference\ntitle: Other type\ntags: [x]\ndescription: wrong type", "# T\n\nx") });
  add("write_file", { path: "wiki/pool/other-tag.md", content: note("type: Concept\ntitle: Other tag\ndescription: no tag", "# G\n\nx") });
  add("write_file", { path: "wiki/elsewhere/far.md", content: note("type: Concept\ntitle: Far\ntags: [X]\ndescription: wrong folder", "# F\n\nx") });
  const QUAIL = "quail roost census";
  for (const filters of [{}, { type: "Concept" }, { tags: ["x"] }, { tags: ["X"] }, { path_prefix: "wiki/pool" }, { path_prefix: "WIKI/POOL/" }, { type: "Concept", tags: ["x"], path_prefix: "wiki/pool" }, { type: "Reference" }]) {
    add("context_pack", { task: QUAIL, link_depth: 1, ...filters });
    add("retrieve", { query: QUAIL, link_depth: 2, ...filters });
  }

  // -- summarize_activity
  add("summarize_activity");
  add("summarize_activity", { since: day });
  add("summarize_activity", { since: "2020-01-01", until: "2999-12-31" });
  add("summarize_activity", { since: " 2020-01-01 " });
  add("summarize_activity", { since: "bad" });
  add("summarize_activity", { until: "2026-9-1" });
  add("summarize_activity", { since: "2026-09-03", until: "2026-09-01" });
  add("summarize_activity", { since: 5 });
  add("summarize_activity", { actor: "process:parity" });
  add("summarize_activity", { actor: "process:codex" });
  add("summarize_activity", { actor: "nobody" });
  add("summarize_activity", { since: "2999-01-01" });
  add("summarize_activity", { until: "2000-01-01" });
  add("summarize_activity", { save: "true" });
  add("summarize_activity", { save: false, actor: "process:codex" });
  add("summarize_activity", { save: true, actor: "nobody" });
  add("summarize_activity", { save: true, since: "2999-01-01" });
  add("summarize_activity", { save: true, actor: "process:codex", since: day, until: day });
  add("read_file", { path: `wiki/${activityRelPath(day, day, "process:codex")}` });
  add("summarize_activity", { save: true, actor: "process:codex", since: day, until: day });
  add("summarize_activity", { save: true, since: "2020-01-01", until: "2999-12-31" });
  add("read_file", { path: "wiki/activity/2020-01-01_2999-12-31.md" });
  add("summarize_activity", { save: true, actor: "::" });
  // The save is credited to whoever ran it; the filter only picks rows, and
  // filters that squeeze to the same ASCII name get different files.
  add("create_concept", { path: "wiki/act/tanaka.md", type: "Concept", title: "Tanaka", body: "x", actor: "田中" });
  add("create_concept", { path: "wiki/act/suzuki.md", type: "Concept", title: "Suzuki", body: "x", actor: "鈴木" });
  add("create_concept", { path: "wiki/act/colon.md", type: "Concept", title: "Colon", body: "x", actor: "process-codex" });
  add("summarize_activity", { actor: "田中" });
  add("summarize_activity", { save: true, actor: "田中", by: "process:parity", since: day, until: day });
  add("summarize_activity", { save: true, actor: "鈴木", since: day, until: day });
  add("summarize_activity", { save: true, actor: "process-codex", by: " process:other ", since: day, until: day });
  add("summarize_activity", { save: true, actor: "process:codex", by: "  ", since: day, until: day });
  add("summarize_activity", { save: true, actor: "process:codex", by: 5, since: day, until: day });
  for (const actor of ["田中", "鈴木", "process-codex", "process:codex"]) {
    add("read_file", { path: `wiki/${activityRelPath(day, day, actor)}` });
  }
  add("list_files", { path: "wiki/activity" });
  add("audit_changes", { actor: "process:parity" });
  add("audit_changes", { actor: "process:other" });
  add("search", { query: "summary", type: "ActivitySummary" });
  add("list_files", { path: "wiki/activity" });
  add("audit_changes", { actor: "process:okf" });
  add("summarize_activity", { actor: "process:okf" });
  add("check_conformance");
  add("rebuild_rag");
  add("list_concepts");
  return out;
}

/**
 * Bases: every filter, formula, summary, view option and error path, over a
 * fixture of concepts with numbers, floats, dates, lists, links, Japanese
 * text and every PARA class. Builds its own fixtures. Nothing here prints a
 * clock-dependent value (no `now()` in a cell, no mtime in a cell), so both
 * servers must agree byte for byte.
 */
function basesScript(): ReadonlyArray<readonly [string, Record<string, unknown>]> {
  const out: Array<readonly [string, Record<string, unknown>]> = [];
  const add = (name: string, args: Record<string, unknown> = {}) => void out.push([name, args]);
  // The scripts above end on a failed open_bundle, which leaves nothing open.
  add("open_bundle", { path: "<BUNDLE>" });
  const concept = (rel: string, frontmatter: string, body = "x") =>
    add("write_file", { path: `wiki/bs/${rel}.md`, content: note(`type: Concept\n${frontmatter}`, body) });
  const base = (name: string, content: string) =>
    add("base_write", { path: `wiki/bs/${name}.base`, content, actor: "process:parity" });
  const query = (name: string, extra: Record<string, unknown> = {}) =>
    add("base_query", { path: `wiki/bs/${name}.base`, ...extra });

  concept("a", "title: Apple\nprice: 1.5\nqty: 4\ntags: [Product, fruit]\nstatus: open\ndue: 2026-03-01\nowner: 田中", "see [[b]] and [[c]]");
  concept("b", "title: Banana\nprice: 0.25\nqty: 12\ntags: [fruit/yellow]\nstatus: done\ndue: 2026-01-20 10:30\nowner: 鈴木", "back to [[a]]");
  concept("c", "title: Cherry\nprice: 12\nqty: 0\ntags: [DEAD, fruit]\nstatus: open\nowner: 田中\ndone: true");
  concept("d", "title: Date palm\nprice: 7.125\ntags: fruit, tree\nstatus: ''\ndone: false\nmeta: {k: v, n: 2}");
  concept("e", "title: Elder\nqty: 3\ntags: [Product]\nlist: [3, 1, 2, [4, 5]]\nname with space: ok");
  add("write_file", { path: "wiki/1-projects/p1.md", content: note("type: Project\ntitle: Proj One\ntags: [Product]\nprice: 100", "x") });
  add("write_file", { path: "wiki/2-areas/a1.md", content: note("type: Area\ntitle: Area One\nprice: 50", "x") });
  add("write_file", { path: "wiki/4-archive/z1.md", content: note("type: Concept\ntitle: Zed\ntags: [DEAD]\nprice: 5", "x") });
  add("write_file", { path: "wiki/bs/nofm.md", content: "no frontmatter at all" });

  // -- the scaffolded example, and a listing
  add("base_list");
  add("base_query", { path: "wiki/bases/products-and-dead.base" });
  add("base_query", { path: "wiki/bases/products-and-dead.base", view: "Products" });
  add("base_query", { path: "wiki/bases/products-and-dead.base", view: "Products", limit: 1 });
  add("read_file", { path: "wiki/bases/index.md" });
  add("list_files", { path: "wiki/bases" });
  add("check_conformance");
  add("list_concepts");
  add("search", { query: "views" });

  // -- the Obsidian docs example, written as Obsidian saves it
  base(
    "obsidian",
    `filters:
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
  ppu: "(price / qty).toFixed(2)"
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
      property: note.qty
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
      - note.qty
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
      formula.formatted_price: customAverage
  - type: list
    name: "Other layout"
    unknownKey: [1, 2]
unknownTopLevel: kept
`
  );
  query("obsidian");
  query("obsidian", { view: "My table" });
  query("obsidian", { view: "Other layout" });
  query("obsidian", { view: "nope" });
  add("base_list");
  add("read_file", { path: "wiki/bs/obsidian.base" });

  // -- filters
  const filtered = (name: string, filters: string, order = "[file.basename]") =>
    base(name, `views:\n  - type: table\n    name: V\n    order: ${order}\n    sort: [{property: file.path}]\n    filters: ${filters}\n`);
  const filters: Array<[string, string]> = [
    ["f-tag", `'file.hasTag("fruit")'`],
    ["f-tag-nested", `'file.hasTag("fruit/yellow")'`],
    ["f-tag-parent", `'file.hasTag("fruit")'`],
    ["f-tags-many", `'file.hasTag("tree", "Product")'`],
    ["f-tag-case", `'file.hasTag("PRODUCT")'`],
    ["f-folder", `'file.inFolder("wiki/bs")'`],
    ["f-folder-wiki", `'file.inFolder("1-projects")'`],
    ["f-folder-root", `'file.inFolder("/")'`],
    ["f-folder-near", `'file.inFolder("wiki/b")'`],
    ["f-name", `'file.name == "a.md"'`],
    ["f-basename", `'file.basename.startsWith("b")'`],
    ["f-path", `'file.path.contains("1-projects")'`],
    ["f-ext", `'file.ext == "md"'`],
    ["f-para", `'file.para == "archive"'`],
    ["f-mtime", `'file.mtime > date("2000-01-01")'`],
    ["f-mtime-year", `'file.mtime.year >= 2026'`],
    ["f-link", `'file.hasLink("b")'`],
    ["f-link-path", `'file.hasLink("bs/b")'`],
    ["f-link-bracket", `'file.hasLink("[[a]]")'`],
    ["f-hasprop", `'file.hasProperty("qty")'`],
    ["f-links", `'file.links.length > 1'`],
    ["f-cmp", `'price >= 1.5 && price < 12'`],
    ["f-eq-num", `'qty == 0'`],
    ["f-neq", `'status != "open"'`],
    ["f-bool", `'done'`],
    ["f-not-bool", `'!done'`],
    ["f-or-str", `'status == "done" || owner == "田中"'`],
    ["f-isempty", `'status.isEmpty()'`],
    ["f-isempty-missing", `'qty.isEmpty()'`],
    ["f-list-contains", `'file.tags.contains("fruit")'`],
    ["f-list-any", `'file.tags.containsAny("tree", "zzz")'`],
    ["f-list-all", `'file.tags.containsAll("fruit", "Product")'`],
    ["f-obj", `'meta.k == "v"'`],
    ["f-obj-keys", `'meta.keys().length == 2'`],
    ["f-index", `'list[0] == 3'`],
    ["f-flat", `'list.flat().length == 5'`],
    ["f-space-prop", `'note["name with space"] == "ok"'`],
    ["f-date-cmp", `'due > date("2026-02-01")'`],
    ["f-date-cmp-str", `'due < "2026-02-01"'`],
    ["f-date-eq", `'date(due) == date("2026-03-01")'`],
    ["f-dur", `'(date(due) + "1d") > date("2026-03-01")'`],
    ["f-today", `'today() > date("2000-01-01")'`],
    ["f-if", `'if(qty > 3, true, false)'`],
    ["f-title", `'title.lower().contains("an")'`],
    ["f-replace", `'title.replace("a", "o") == "Apple"'`],
    ["f-number", `'number("12") == qty'`],
    ["f-type", `'price.isType("number")'`],
    ["f-lit-list", `'[1, 2, 3].contains(qty)'`],
    ["f-lit-true", `'true'`],
    ["f-lit-false", `'false'`],
  ];
  for (const [name, expr] of filters) {
    filtered(name, expr);
    query(name);
  }
  for (const [name, spec] of [
    ["f-bad-syntax", `'price >'`],
    ["f-bad-fn", `'nosuch(1)'`],
    ["f-bad-method", `'price.nosuch()'`],
    ["f-bad-char", `'price = 1'`],
    ["f-bad-str", `'"open'`],
    ["f-bad-obj", `{xor: []}`],
    ["f-bad-multi", `{and: [], or: []}`],
    ["f-bad-list", `{and: 5}`],
    ["f-bad-num", `5`],
    ["f-bad-deep", `'${"(".repeat(70)}1${")".repeat(70)}'`],
  ] as const) {
    add("base_write", { path: `wiki/bs/${name}.base`, content: `filters: ${spec}\n` });
  }
  for (const [name, spec] of [
    ["f-warn-file", `'file.size > 1'`],
    ["f-warn-unknown", `'file.zzz'`],
    ["f-warn-fn", `'random() > 0.5'`],
    ["f-warn-this", `'this.file.name == "x"'`],
    ["f-warn-method", `'title.relative()'`],
  ] as const) {
    add("base_write", { path: `wiki/bs/${name}.base`, content: `filters: ${spec}\n` });
    query(name);
  }

  base(
    "f-nested",
    `filters:
  and:
    - or:
        - file.hasTag("Product")
        - status == "done"
    - not:
        - qty == 3
views: [{type: table, name: V, order: [file.basename], sort: [{property: file.path}]}]
`
  );
  query("f-nested");

  // -- formulas, in cells
  const formulas: Array<[string, string]> = [
    ["double", "price * 2"],
    ["sum", "price + qty"],
    ["div", "price / qty"],
    ["div0", "qty / 0"],
    ["mod", "qty % 5"],
    ["neg", "-qty"],
    ["str", 'title + " (" + qty + ")"'],
    ["fixed", "price.toFixed(2)"],
    ["fixed0", "price.toFixed(0)"],
    ["round", "price.round()"],
    ["round2", "price.round(1)"],
    ["ceil", "price.ceil()"],
    ["floor", "price.floor()"],
    ["abs", "(0 - price).abs()"],
    ["min", "min(price, qty, 3)"],
    ["max", "max(price, qty)"],
    ["upper", 'title.lower().title()'],
    ["slice", "title.slice(1, 3)"],
    ["slicenegative", "title.slice(-3)"],
    ["split", 'title.split("a").join("-")'],
    ["reverse", "title.reverse()"],
    ["repeat", 'owner.repeat(2)'],
    ["len", "title.length"],
    ["trim", '("  " + title + "  ").trim()'],
    ["starts", 'title.startsWith("A")'],
    ["ends", 'title.endsWith("a")'],
    ["ifelse", 'if(price > 5, "dear", "cheap")'],
    ["ifnull", 'if(qty, "yes")'],
    ["nested", 'if(price > 5, if(price > 10, "huge", "big"), "small")'],
    ["datey", "date(due).year"],
    ["datem", "date(due).month"],
    ["dated", "date(due).day"],
    ["dateh", "date(due).hour"],
    ["datefmt", 'date(due).format("YYYY/MM/DD HH:mm:ss")'],
    ["datefmt2", 'date(due).format("dddd, MMMM D, YYYY [at] h:mm A")'],
    ["dateplus", 'date(due) + "1M"'],
    ["dateplus2", '(date(due) + "2 weeks").format("YYYY-MM-DD")'],
    ["dateminus", 'date(due) - "1y"'],
    ["datediff", 'date("2026-03-01") - date("2026-02-01")'],
    ["datetime", "date(due).time()"],
    ["datedate", "date(due).date()"],
    ["durmul", '(duration("1d") * 3) == duration("72h")'],
    ["nowtype", "now().isType(\"date\")"],
    ["linkv", 'link("a", "Alpha")'],
    ["linkv2", "link(file.path)"],
    ["aslink", "file.asLink()"],
    ["tags", "file.tags"],
    ["tagsjoin", 'file.tags.join(" / ")'],
    ["tagsort", "file.tags.sort()"],
    ["props", "file.properties"],
    ["propkeys", "file.properties.keys().length"],
    ["links", "file.links"],
    ["listsum", "list.flat().sum()"],
    ["listmean", "list.flat().mean()"],
    ["listmax", "list.flat().max()"],
    ["listmedian", "list.flat().median()"],
    ["listmap", "list.flat().map(value * 10)"],
    ["listidx", "list.flat().map(index)"],
    ["listfilter", "list.flat().filter(value > 2)"],
    ["listreduce", "list.flat().reduce(acc + value, 100)"],
    ["listslice", "list.flat().slice(1, 3)"],
    ["listuniq", "[1, 1, 2, 2].unique()"],
    ["listrev", "list.flat().reverse()"],
    ["objv", "meta"],
    ["objvals", "meta.values()"],
    ["istr", 'owner.isTruthy()'],
    ["tostr", "price.toString() + qty.toString()"],
    ["escape", 'escapeHTML("<a href=\\"x\\">&</a>")'],
    ["bad", "title - 1"],
    ["badfn", "price.title()"],
    ["badidx", "price[0]"],
    ["literal", "1 + 1 == 2"],
    ["unicode", "owner + owner.length"],
    ["bigfloat", "0.1 + 0.2"],
    ["neg0", "0 * -1"],
    ["para", "file.para + file.folder"],
  ];
  const fnames = formulas.map(([n]) => n);
  const chunk = 8;
  for (let i = 0; i < formulas.length; i += chunk) {
    const slice = formulas.slice(i, i + chunk);
    const yaml = slice.map(([n, e]) => `  ${n}: ${JSON.stringify(e)}`).join("\n");
    const cols = slice.map(([n]) => `formula.${n}`).join(", ");
    base(`fx-${i / chunk}`, `formulas:\n${yaml}\nviews:\n  - type: table\n    name: V\n    order: [file.basename, ${cols}]\n    sort: [{property: file.path}]\n    filters: 'file.inFolder("wiki/bs")'\n`);
    query(`fx-${i / chunk}`);
  }
  void fnames;

  // -- sorting, grouping, limits
  base(
    "sort",
    `views:
  - type: table
    name: By price desc
    order: [file.basename, price, status, owner]
    sort:
      - property: price
        direction: DESC
  - type: table
    name: By status then owner
    order: [file.basename, status, owner]
    sort:
      - property: status
      - property: owner
        direction: desc
  - type: table
    name: By title
    order: [title]
    sort: [{property: title, direction: ASC}]
  - type: table
    name: By date
    order: [file.basename, due]
    sort: [{property: due}]
  - type: table
    name: By bool
    order: [file.basename, done]
    sort: [{property: done, direction: DESC}]
  - type: table
    name: By tags
    order: [file.basename, tags]
    sort: [{property: tags}]
  - type: table
    name: Limited
    order: [file.basename]
    limit: 2
  - type: table
    name: Japanese
    order: [owner, title]
    sort: [{property: owner}, {property: title}]
`
  );
  for (const view of ["By price desc", "By status then owner", "By title", "By date", "By bool", "By tags", "Limited", "Japanese"]) query("sort", { view });
  query("sort", { view: "Limited", limit: 1 });
  query("sort", { view: "Limited", limit: 50 });
  query("sort", { limit: 3 });
  for (const limit of [0, -1, 1.5, "3", null, true]) query("sort", { limit });

  base(
    "groups",
    `formulas:
  PARA: 'if(file.para == "project", "1 Projects", if(file.para == "area", "2 Areas", if(file.para == "resource", "3 Resources", "4 Archive")))'
  band: 'if(price >= 10, "high", if(price >= 1, "mid", "low"))'
views:
  - type: table
    name: By PARA
    groupBy: {property: formula.PARA}
    order: [title, price]
    summaries: {title: Count, price: Sum}
  - type: cards
    name: By band desc
    groupBy: {property: formula.band, direction: DESC}
    order: [title, price, qty]
    summaries: {price: Average, qty: Max}
    sort: [{property: price, direction: DESC}]
  - type: table
    name: By owner
    groupBy: {property: owner}
    order: [title, qty]
    summaries: {qty: Sum}
  - type: table
    name: By status limited
    groupBy: {property: status}
    order: [title]
    limit: 3
  - type: table
    name: By tags list
    groupBy: {property: tags}
    order: [title]
`
  );
  for (const view of ["By PARA", "By band desc", "By owner", "By status limited"]) query("groups", { view });
  query("groups", { view: "By tags list" });
  query("groups", { view: "By PARA", limit: 2 });

  // -- summaries
  const sums = ["Count", "Average", "Min", "Max", "Sum", "Range", "Median", "Stddev", "Earliest", "Latest", "Checked", "Unchecked", "Empty", "Filled", "Unique"];
  for (const column of ["price", "qty", "due", "done", "status", "tags", "title", "meta", "formula.dbl", "file.mtime", "file.tags"]) {
    const rows = sums.map((s) => `${s}`);
    base(
      `sum-${column.replace(/\W/g, "_")}`,
      `formulas:\n  dbl: price * 2\nviews:\n${rows
        .map((s) => `  - type: table\n    name: ${s}\n    order: [${column}]\n    filters: 'file.inFolder("wiki/bs")'\n    summaries: {${column}: ${s}}\n`)
        .join("")}`
    );
    if (column === "file.mtime") continue; // a clock value; checked via filters instead
    for (const s of sums) query(`sum-${column.replace(/\W/g, "_")}`, { view: s });
  }
  base(
    "sum-custom",
    `summaries:
  total: 'values.sum()'
  doubled: 'values.sum() * 2'
  firstfilled: 'values.filter(value).length'
  bad: 'values.nosuch()'
  badtype: 'values.join(",") - 1'
  top: 'values.max()'
  half: 'values.mean().round(3)'
  count: 'values.length'
views:
  - type: table
    name: V
    order: [price, qty, title]
    filters: 'file.inFolder("wiki/bs")'
    summaries: {price: total, qty: doubled, title: firstfilled}
  - type: table
    name: W
    order: [price, qty]
    summaries: {price: top, qty: half}
  - type: table
    name: X
    order: [price]
    summaries: {price: count}
  - type: table
    name: Y
    order: [price]
    filters: 'price > 99999'
    summaries: {price: total}
`
  );
  for (const view of ["V", "W", "X", "Y"]) query("sum-custom", { view });
  base("sum-custom-bad", `summaries:\n  bad: 'values.nosuch()'\nviews: [{type: table, name: V, order: [price], summaries: {price: bad}}]\n`);
  base("sum-badtype", `summaries:\n  badtype: 'values.join(",") - 1'\nviews: [{type: table, name: V, order: [price], filters: 'price', summaries: {price: badtype}}]\n`);
  query("sum-badtype");

  // -- columns, display names and unsupported things at run time
  base(
    "columns",
    `properties:
  title:
    displayName: "Name | with pipe"
  note.price:
    displayName: Price
  formula.f:
    displayName: Fff
  file.name:
    displayName: ""
formulas:
  f: 'title + "\\n" + owner'
views:
  - type: table
    name: V
    order: [file.name, title, note.price, formula.f, file.size, file.ctime, file.zzz, formula.nope, tags, meta, "name with space"]
    filters: 'file.inFolder("wiki/bs") && !title.isEmpty()'
    sort: [{property: file.path}]
  - type: cards
    name: Cards
    order: []
`
  );
  query("columns");
  query("columns", { view: "Cards" });
  base("empty", "");
  query("empty");
  base("only-comment", "# nothing here\n");
  query("only-comment");
  base("views-empty", "views: []\n");
  query("views-empty");
  base("noname", "views:\n  - type: table\n  - type: cards\n    name: ''\n");
  query("noname");
  query("noname", { view: "View 2" });
  add("base_list");

  // -- write validation: structure
  for (const [name, content] of [
    ["w-scalar", "just text"],
    ["w-list", "- a\n- b"],
    ["w-yaml", "a: [1\n"],
    ["w-yaml-dup", "a: 1\na: 2\n"],
    ["w-yaml-multi", "a: 1\n---\nb: 2\n"],
    ["w-filters", "filters: 5"],
    ["w-formulas", "formulas: [a]"],
    ["w-formula-val", "formulas: {a: 5}"],
    ["w-formula-cycle", "formulas: {a: 'formula.b', b: 'formula.a', c: '1', d: 'formula.d'}"],
    ["w-formula-undef", "formulas: {a: 'formula.zzz'}"],
    ["w-props", "properties: [a]"],
    ["w-sums", "summaries: [a]"],
    ["w-sums-val", "summaries: {a: 5}"],
    ["w-views", "views: {a: 1}"],
    ["w-view-item", "views: [1]"],
    ["w-view-type", "views: [{name: x}]"],
    ["w-view-name", "views: [{type: table, name: 5}]"],
    ["w-view-limit", "views: [{type: table, limit: 0}]"],
    ["w-view-limit2", "views: [{type: table, limit: 2.5}]"],
    ["w-view-limit3", "views: [{type: table, limit: '2'}]"],
    ["w-view-order", "views: [{type: table, order: x}]"],
    ["w-view-order2", "views: [{type: table, order: [1]}]"],
    ["w-view-sort", "views: [{type: table, sort: x}]"],
    ["w-view-sort2", "views: [{type: table, sort: [x]}]"],
    ["w-view-sort3", "views: [{type: table, sort: [{property: a, direction: UP}]}]"],
    ["w-view-group", "views: [{type: table, groupBy: a}]"],
    ["w-view-group2", "views: [{type: table, groupBy: {property: a, direction: 1}}]"],
    ["w-view-sums", "views: [{type: table, summaries: a}]"],
    ["w-view-sums2", "views: [{type: table, summaries: {a: Nope, b: 5, c: Sum}}]"],
    ["w-view-warn", "views: [{type: table, order: [file.size, file.zzz, formula.q], sort: [{property: file.ctime}], groupBy: {property: formula.q}, summaries: {formula.q: Sum}}]"],
    ["w-unsupported", "views: [{type: map, name: M, order: 5, filters: 7}, {type: kanban}]"],
    ["w-many", "filters: 5\nformulas: [a]\nviews: 3\nproperties: 1"],
    ["w-ok", "# comment\nviews: [{type: table, name: V}]\nextra: {anything: [1, 2]}\n"],
    ["w-ok-cards", "views:\n  - type: cards\n    name: Gallery\n    image: note.cover\n    cardSize: 200\n"],
    ["w-null-parts", "filters:\nformulas:\nproperties:\nsummaries:\nviews:\n"],
  ] as const) {
    add("base_write", { path: `wiki/bs/${name}.base`, content });
  }
  query("w-ok");
  query("w-ok-cards");
  query("w-unsupported", {});
  query("w-unsupported", { view: "M" });
  query("w-unsupported", { view: "View 2" });
  add("read_file", { path: "wiki/bs/w-ok.base" });
  add("base_list");

  // -- tool argument and path errors
  add("base_write");
  add("base_write", { path: "wiki/bs/x.base" });
  add("base_write", { path: "wiki/bs/x.base", content: 5 });
  add("base_write", { path: "wiki/bs/x.base", content: null });
  add("base_write", { content: "views: []" });
  add("base_write", { path: "wiki/bs/x.md", content: "views: []" });
  add("base_write", { path: "wiki/bs/x.BASE", content: "views: []" });
  add("base_write", { path: "raw/x.base", content: "views: []" });
  add("base_write", { path: "../x.base", content: "views: []" });
  add("base_write", { path: "x.base", content: "views: []" });
  add("base_write", { path: "wiki/bs/y.base", content: "views: []", actor: "  " });
  add("base_write", { path: "wiki/bs/y.base", content: "views: []", actor: 5 });
  add("base_query");
  add("base_query", { path: "" });
  add("base_query", { path: 5 });
  add("base_query", { path: "wiki/bs/missing.base" });
  add("base_query", { path: "wiki/bs/a.md" });
  add("base_query", { path: "../x.base" });
  add("base_query", { path: "raw/README.base" });
  add("base_query", { path: "wiki/bs/y.base", view: "" });
  add("base_query", { path: "wiki/bs/y.base", view: 5 });
  add("base_query", { path: "wiki/bs/x.BASE" });
  add("base_query", { path: "wiki/bs/w-yaml.base" });
  add("base_query", { path: "wiki/bs/w-filters.base" });
  add("base_list", { ignored: true });

  // -- limits: hostile input answers with errors and warnings, the same in both servers
  const chainOf = (op: string) => Array(50_000).fill("1").join(` ${op} `);
  for (const op of ["+", "&&", "=="]) base(`lim-chain-${op.length}${op.charCodeAt(0)}`, `filters: '${chainOf(op)}'\n`);
  base("lim-chain-member", `filters: 'a${".b".repeat(50_000)}'\n`);
  base("lim-chain-call", `filters: '"x"${".trim()".repeat(50_000)}'\n`);
  base("lim-chain-index", `filters: 'a${"[0]".repeat(50_000)}'\n`);
  base("lim-chain-unary", `filters: '${"-".repeat(50_000)}1'\n`);
  base("lim-nodes", `filters: '[${Array(20_000).fill("1").join(",")}]'\n`);
  base("lim-ok-long", `filters: '${Array(100).fill("1").join(" + ")}'\n`);
  query("lim-ok-long");
  const formulaChain = (n: number) =>
    Array.from({ length: n }, (_, i) => `  f${i}: '${i === n - 1 ? "1" : `formula.f${i + 1} + 1`}'`).join("\n");
  base("lim-formula-long", `formulas:\n${formulaChain(40)}\n`);
  base("lim-formula-limit", `formulas:\n${formulaChain(32)}\nviews: [{type: table, name: V, order: [formula.f0], filters: 'file.basename == "a"'}]\n`);
  query("lim-formula-limit");
  base("lim-ring", `formulas:\n${Array.from({ length: 200 }, (_, i) => `  r${i}: 'formula.r${(i + 1) % 200}'`).join("\n")}\n`);
  const h = `"x".repeat(100).split("")`;
  base(
    "lim-eval",
    `formulas:
  boom: '"x".repeat(10000).repeat(10000)'
  dbl: '[${Array(20).fill("1").join(",")}].reduce(acc + acc, "ab")'
  nest: '${h}.map(${h}.map(${h}.map(${h}.map(value)))).length'
  big: '"x".repeat(100).split("").map(value.repeat(10000))'
  ok: '"ab".repeat(3)'
views:
  - type: table
    name: V
    order: [file.basename, formula.boom, formula.dbl, formula.nest, formula.big, formula.ok]
    filters: 'file.inFolder("wiki/bs")'
    sort: [{property: file.path}]
  - type: table
    name: F
    order: [file.basename]
    filters: '"x".repeat(10000).repeat(10000).isEmpty()'
`
  );
  query("lim-eval");
  query("lim-eval", { view: "F" });
  const hn = `"x".repeat(800).split("")`;
  base(
    "lim-budget",
    `formulas:
  slow: '${hn}.map(${hn}.map(index)).length'
views:
  - type: table
    name: V
    order: [file.basename, formula.slow]
    filters: 'file.inFolder("wiki/bs")'
    sort: [{property: file.path}]
`
  );
  query("lim-budget");

  // -- NaN: after every number, before empty values, one group
  const nanBase = `formulas:
  v: 'if(file.basename == "b" || file.basename == "e", 0 / 0, price)'
  l: '[3, 0 / 0, 1, 0 / 0, 2].sort().join(",")'
views:
  - type: table
    name: Sorted
    order: [file.basename, formula.v, formula.l]
    filters: 'file.inFolder("wiki/bs")'
    sort: [{property: formula.v}]
  - type: table
    name: Desc
    order: [file.basename, formula.v]
    filters: 'file.inFolder("wiki/bs")'
    sort: [{property: formula.v, direction: DESC}]
  - type: table
    name: Grouped
    order: [file.basename, formula.v]
    filters: 'file.inFolder("wiki/bs")'
    groupBy: {property: formula.v}
`;
  base("lim-nan", nanBase);
  for (const view of ["Sorted", "Desc", "Grouped"]) query("lim-nan", { view });

  // -- summaries and group counts cover every match; rows are capped
  base(
    "lim-groups",
    `views:
  - type: table
    name: G
    order: [file.basename, price]
    filters: 'file.inFolder("wiki/bs")'
    groupBy: {property: status}
    sort: [{property: file.path}]
    summaries: {price: Sum, file.basename: Count}
  - type: table
    name: Flat
    order: [file.basename, price]
    filters: 'file.inFolder("wiki/bs")'
    sort: [{property: file.path}]
    summaries: {price: Sum, file.basename: Count}
`
  );
  for (const limit of [1, 2, 3, 100]) query("lim-groups", { view: "G", limit });
  for (const limit of [1, 3]) query("lim-groups", { view: "Flat", limit });

  // -- durations: only documented units; milliseconds are not one
  base(
    "lim-dur",
    `formulas:
  min: '(date("2026-01-31 00:00") + "30m").format("HH:mm")'
  month: '(date("2026-01-31") + "1M").format("YYYY-MM-DD")'
  words: '(date("2026-01-01 00:00") + "90 minutes").format("HH:mm")'
  plural: '(date("2026-01-31") + "2 Months").format("YYYY-MM-DD")'
  combo: '(date("2026-01-01 00:00") + "1h 30m").format("HH:mm")'
  ms: '(date("2026-01-01") + "5ms").format("HH:mm")'
  dms: 'duration("5ms")'
  dMS: 'duration("5MS")'
  dsec: 'duration("5sec")'
  dnone: 'duration("5")'
  far: 'date("2026-01-01") + duration("999999999999999999y")'
  huge: '(duration("1${"0".repeat(400)}d") + date("2026-01-01")).format("MMMM")'
views:
  - type: table
    name: V
    order: [formula.min, formula.month, formula.words, formula.plural, formula.combo, formula.ms, formula.dms, formula.dMS, formula.dsec, formula.dnone, formula.far, formula.huge]
    filters: 'file.basename == "a"'
`
  );
  query("lim-dur");

  // -- base_write stays inside the wiki layer and out of hidden folders
  for (const path of [
    "wiki/.hidden/x.base",
    "wiki/bs/.x.base",
    "wiki/bs/.okf/x.base",
    "wiki/bs/./.okf/x.base",
    "wiki/bs/sub/../../.git/x.base",
    "wiki/bs/../../x.base",
    "wiki/../.okf/x.base",
    ".okf/x.base",
    ".rag/x.base",
  ]) {
    add("base_write", { path, content: "views: []\n" });
  }
  add("base_write", { path: "wiki/bs/sub/../ok-normalised.base", content: "views: []\n" });
  add("base_list");

  // -- a base is a file like any other: it can be moved, deleted, read; and an outside edit is seen
  add("move_file", { from: "wiki/bs/y.base", to: "wiki/bs/sub/y2.base" });
  add("base_list");
  add("delete_file", { path: "wiki/bs/sub/y2.base" });
  add("write_file", { path: "wiki/bs/raw-write.base", content: "filters: 'a ='\nviews: [{type: table, name: V}]\n" });
  add("base_list");
  add("base_query", { path: "wiki/bs/raw-write.base" });
  add("check_conformance");
  add("rebuild_rag");
  add("search", { query: "filters" });
  add("audit_changes", { actor: "process:parity" });

  // -- the concepts the bases ran over were not changed by running them
  add("list_concepts");
  add("check_conformance");
  return out;
}

/** Replace `<BUNDLE>` in string arguments with this server's bundle path. */
function withBundle<T>(value: T, bundle: string): T {
  return JSON.parse(JSON.stringify(value).split("<BUNDLE>").join(JSON.stringify(bundle).slice(1, -1)));
}

async function makeBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "okf-parity-"));
  await scaffoldBundle(root);
  await writeFile(
    join(root, "wiki", "alpha.md"),
    "---\ntype: Concept\ntitle: Alpha\ndescription: 最初の概念\ntags: [parity]\n---\n\n# Alpha\n\n日本語の検索ができる知識。\n\n## 詳細\n\nalpha の詳しい説明。\n",
    "utf8"
  );
  return root;
}

/** One server over stdio, answering requests in order. */
class StdioClient {
  private buffer = "";
  private waiting: Array<(line: string) => void> = [];
  private lines: string[] = [];
  private nextId = 1;

  constructor(private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const waiter = this.waiting.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    }
  }

  private next(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolveLine) => this.waiting.push(resolveLine));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await this.proc.stdin.flush();
    return JSON.parse(await this.next());
  }

  /** Send a line as is and read one response. */
  async raw(line: string): Promise<unknown> {
    this.proc.stdin.write(`${line}\n`);
    await this.proc.stdin.flush();
    return JSON.parse(await this.next());
  }

  /** Send a line that must not be answered. */
  notifyRaw(line: string): void {
    this.proc.stdin.write(`${line}\n`);
  }

  notify(method: string): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async close(): Promise<void> {
    await this.proc.stdin.end();
    this.proc.kill();
    await this.proc.exited;
  }
}

function spawnServer(command: string[], bundle: string): StdioClient {
  return new StdioClient(
    Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OKF_BUNDLE: bundle },
    })
  );
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Mask what differs between two honest runs: where the bundle is, and when. */
function normalize(value: unknown, bundle: string): string {
  const forward = bundle.replace(/\\/g, "/");
  const escapedBack = JSON.stringify(bundle).slice(1, -1);
  return JSON.stringify(value, null, 2)
    .split(escapedBack).join("<BUNDLE>")
    .split(forward).join("<BUNDLE>")
    .replace(/okf-parity-[A-Za-z0-9]+/g, "<TMP>")
    .replace(/(\\"at\\": \\")\d{2}:\d{2}:\d{2}/g, "$1<CLOCK>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TIME>")
    // A base shows file.mtime as `YYYY-MM-DD HH:mm:ss.SSS`; no fixture date has milliseconds.
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/g, "<TIME>")
    // The ".SSS" is dropped when the millisecond happens to be 0, and the two
    // servers write their fixtures at different milliseconds. A file.mtime is
    // always "now", so a seconds-resolution stamp on today's date is masked too.
    .replace(new RegExp(`(?:${todayUtc()}|${today()}) \\d{2}:\\d{2}:\\d{2}`, "g"), "<TIME>")
    .replace(/("\w*(?:mtime|Mtime|At|Ms|ms|elapsed|duration)\w*":\s*)\d+(\.\d+)?/g, "$1<N>")
    .replace(/(\\"\w*(?:mtime|Mtime|At|Ms|ms|elapsed|duration)\w*\\":\s*)\d+(\.\d+)?/g, "$1<N>");
}

const ready = existsSync(RUST_BINARY);
if (!ready) console.log(`  (Rust MCP binary not built at ${RUST_BINARY} — parity test skipped)`);

describe.skipIf(!ready)("Rust headless server parity", () => {
  let tsBundle: string;
  let rustBundle: string;
  let ts: StdioClient;
  let rust: StdioClient;

  beforeAll(async () => {
    tsBundle = await makeBundle();
    rustBundle = await makeBundle();
    ts = spawnServer([process.execPath, "run", TS_SERVER], tsBundle);
    rust = spawnServer([RUST_BINARY], rustBundle);
    const init = {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "parity", version: "0" },
    };
    await ts.request("initialize", init);
    await rust.request("initialize", init);
    ts.notify("notifications/initialized");
    rust.notify("notifications/initialized");
  });

  afterAll(async () => {
    await ts?.close();
    await rust?.close();
    await removeTempDir(tsBundle);
    await removeTempDir(rustBundle);
  });

  test("initialize negotiates the same protocol for every version a client may ask", async () => {
    for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "1999-01-01"]) {
      const params = { protocolVersion, capabilities: {}, clientInfo: { name: "p", version: "0" } };
      expect(normalize(await rust.request("initialize", params), rustBundle)).toBe(
        normalize(await ts.request("initialize", params), tsBundle)
      );
    }
  });

  test("tools/list is identical", async () => {
    expect(normalize(await rust.request("tools/list", {}), rustBundle)).toBe(
      normalize(await ts.request("tools/list", {}), tsBundle)
    );
  });

  test("unknown methods fail the same way", async () => {
    expect(normalize(await rust.request("nope/nope", {}), rustBundle)).toBe(
      normalize(await ts.request("nope/nope", {}), tsBundle)
    );
  });

  test("every scripted tool call answers identically", async () => {
    let calls = 0;
    // A segment whose calls mostly answer "no bundle open" proves nothing: both
    // sides agree for the wrong reason. SCRIPT_MORE ends on a deliberate failed
    // open_bundle followed by a few calls that must see that state; no other
    // segment may answer it at all.
    const segments: Array<[string, ReadonlyArray<readonly [string, Record<string, unknown>]>, number]> = [
      ["SCRIPT", SCRIPT, 0],
      ["SCRIPT_MORE", SCRIPT_MORE, 8],
      ["newFeatureScript", newFeatureScript(), 0],
      ["basesScript", basesScript(), 0],
    ];
    const noBundle = new Map<string, number>();
    for (const [segment, script] of segments) {
      for (const [name, args] of script) {
        const expected = normalize(
          await ts.request("tools/call", { name, arguments: withBundle(args, tsBundle) }),
          tsBundle
        );
        const actual = normalize(
          await rust.request("tools/call", { name, arguments: withBundle(args, rustBundle) }),
          rustBundle
        );
        expect(`${name} ${JSON.stringify(args)}\n${actual}`).toBe(
          `${name} ${JSON.stringify(args)}\n${expected}`
        );
        calls += 1;
        if (/バンドルが開かれていません|No bundle is open/.test(expected)) {
          noBundle.set(segment, (noBundle.get(segment) ?? 0) + 1);
        }
        // The TS watcher indexes a loop file as a concept whenever it happens to
        // see one change (its refresh forgets that loops/ is not knowledge), and
        // whether it does depends on the platform's rename events. The Rust
        // server leaves loops/ out, as the layer contract says. Wait out the
        // debounce, then reload both from disk so that quirk cannot decide what
        // the next call sees.
        if (/^loop_(define|start|note|end)$/.test(name)) {
          await Bun.sleep(400);
          await ts.request("tools/call", { name: "rebuild_rag", arguments: {} });
          await rust.request("tools/call", { name: "rebuild_rag", arguments: {} });
        }
      }
    }
    for (const [segment, , allowed] of segments) {
      expect({ segment, noBundle: noBundle.get(segment) ?? 0 }).toEqual({
        segment,
        noBundle: Math.min(noBundle.get(segment) ?? 0, allowed),
      });
    }
    expect(calls).toBeGreaterThan(800);
  }, 300_000);

  test("a bundle made before knowhow/ and activity/ existed gets them on the first write", async () => {
    // Fresh bundles with the folders removed *before* the servers open them:
    // taking a folder away under a running watcher races with its handles on
    // Windows, which is a property of the test, not of the write under test.
    const fresh = [await makeBundle(), await makeBundle()] as const;
    try {
      for (const bundle of fresh) {
        for (const dir of ["knowhow", "activity"]) await rm(join(bundle, "wiki", dir), { recursive: true });
      }
      await ts.request("tools/call", { name: "open_bundle", arguments: { path: fresh[0] } });
      await rust.request("tools/call", { name: "open_bundle", arguments: { path: fresh[1] } });

      const calls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["knowhow_add", { title: "First lesson", body: "after the folders were removed", actor: "process:parity" }],
        ["list_files", { path: "wiki/knowhow", recursive: true }],
        ["read_file", { path: "wiki/knowhow/index.md" }],
        ["summarize_activity", { save: true, actor: "process:parity" }],
        ["list_files", { path: "wiki/activity", recursive: true }],
        ["read_file", { path: "wiki/activity/index.md" }],
        ["check_conformance", {}],
      ];
      for (const [name, args] of calls) {
        const expected = normalize(await ts.request("tools/call", { name, arguments: args }), fresh[0]);
        const actual = normalize(await rust.request("tools/call", { name, arguments: args }), fresh[1]);
        expect(`${name}\n${actual}`).toBe(`${name}\n${expected}`);
      }
      for (const bundle of fresh) {
        expect(await readFile(join(bundle, "wiki", "knowhow", "index.md"), "utf8")).toBe("# Know-how\n");
        expect(await readFile(join(bundle, "wiki", "activity", "index.md"), "utf8")).toBe("# Activity\n");
      }
    } finally {
      await ts.request("tools/call", { name: "open_bundle", arguments: { path: tsBundle } });
      await rust.request("tools/call", { name: "open_bundle", arguments: { path: rustBundle } });
      for (const bundle of fresh) await removeTempDir(bundle);
    }
  }, 30_000);

  test("malformed and unusual JSON-RPC messages are handled the same", async () => {
    const lines = [
      "not json",
      '{"jsonrpc":"2.0","id":7}',
      '{"jsonrpc":"2.0","id":8,"method":42}',
      '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{}}',
      '{"jsonrpc":"2.0","id":"str-id","method":"ping"}',
      '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"read_map","arguments":[1]}}',
      '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"read_map","arguments":null}}',
      '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":5}}',
      '{"jsonrpc":"2.0","id":13,"method":"initialize"}',
      '{"jsonrpc":"2.0","id":14,"method":"initialize","params":{"protocolVersion":7}}',
      '{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}',
      '{"jsonrpc":"2.0","id":1.5,"method":"ping"}',
      '{"jsonrpc":"2.0","id":0,"method":"ping"}',
      '  {"jsonrpc":"2.0","id":15,"method":"tools/list"}  ',
    ];
    for (const line of lines) {
      expect(normalize(await rust.raw(line), rustBundle)).toBe(normalize(await ts.raw(line), tsBundle));
    }

    // These draw no response at all; the ping that follows proves nothing extra was written.
    for (const silent of [
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":null,"method":"ping"}',
      '{"jsonrpc":"2.0","id":null}',
      "[1,2]",
      "42",
      "",
      '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"bundle_info"}}',
    ]) {
      rust.notifyRaw(silent);
      ts.notifyRaw(silent);
      const ping = '{"jsonrpc":"2.0","id":"after","method":"ping"}';
      expect(normalize(await rust.raw(ping), rustBundle)).toBe(normalize(await ts.raw(ping), tsBundle));
    }
  });

  test("edits made outside the server are picked up by the watcher", async () => {
    await ts.request("tools/call", { name: "open_bundle", arguments: { path: tsBundle } });
    await rust.request("tools/call", { name: "open_bundle", arguments: { path: rustBundle } });
    const seen = async (query: string) => [
      normalize(await ts.request("tools/call", { name: "search", arguments: { query } }), tsBundle),
      normalize(await rust.request("tools/call", { name: "search", arguments: { query } }), rustBundle),
    ];
    const externalNote = (word: string) =>
      `---\ntype: Concept\ntitle: External\n---\n\n# External\n\n${word} swims here.\n`;

    for (const bundle of [tsBundle, rustBundle]) {
      await writeFile(join(bundle, "wiki", "external.md"), externalNote("zebrafish"), "utf8");
    }
    await Bun.sleep(900);
    const [tsFound, rustFound] = await seen("zebrafish");
    expect(tsFound).toContain("external");
    expect(rustFound).toBe(tsFound);

    for (const bundle of [tsBundle, rustBundle]) {
      await writeFile(join(bundle, "wiki", "external.md"), externalNote("narwhal"), "utf8");
    }
    await Bun.sleep(900);
    const [tsOld, rustOld] = await seen("zebrafish");
    expect(rustOld).toBe(tsOld);
    const [tsNarwhal, rustNarwhal] = await seen("narwhal");
    expect(tsNarwhal).toContain("external");
    expect(rustNarwhal).toBe(tsNarwhal);

    for (const bundle of [tsBundle, rustBundle]) await rm(join(bundle, "wiki", "external.md"));
    await Bun.sleep(900);
    const [tsGone, rustGone] = await seen("narwhal");
    expect(tsGone).toContain("No matches");
    expect(rustGone).toBe(tsGone);
  }, 30_000);
});
