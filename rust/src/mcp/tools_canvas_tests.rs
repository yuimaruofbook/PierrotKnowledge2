//! The MCP surface of canvases, typed relations, the graph schema and
//! SYSTEMMAP.md, ported from `test/canvas.test.ts`.

use super::*;
use crate::okf::scaffold::scaffold_bundle;
use crate::shared::okf::systemmap::{SYSTEMMAP_END, SYSTEMMAP_START};
use crate::workspace::WorkspaceOptions;
use serde_json::json;
use std::fs;
use tempfile::TempDir;

fn bundle() -> (TempDir, String, Workspace) {
    let dir = tempfile::Builder::new().prefix("okf-canvas-").tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    scaffold_bundle(&root).unwrap();
    let mut ws = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    ws.open(&root).unwrap();
    (dir, root, ws)
}

fn call(ws: &mut Workspace, name: &str, args: Value) -> ToolResult {
    call_tool(ws, name, args.as_object().expect("arguments are an object"))
}

fn note(frontmatter: &str, body: &str) -> String {
    format!("---\n{frontmatter}\n---\n\n{body}\n")
}

fn write(ws: &mut Workspace, path: &str, content: &str) {
    let r = call(ws, "write_file", json!({ "path": path, "content": content }));
    assert!(!r.is_error, "{}", r.text);
}

fn seed_graph(ws: &mut Workspace) {
    write(
        ws,
        "wiki/1-projects/アルファ.md",
        &note("type: Project\ntitle: アルファ\ndescription: 始まり\nrelations:\n  depends_on: [3-resources/gamma]", "[[ベータ]] へ"),
    );
    write(ws, "wiki/3-resources/ベータ.md", &note("type: Concept\ntitle: ベータ", "[[アルファ]] [[ベータ]] [[missing-page]]"));
    write(ws, "wiki/3-resources/gamma.md", &note("type: Concept\ntitle: Gamma\ndescription: g", "[[delta]]"));
    write(ws, "wiki/3-resources/delta.md", &note("type: Concept\ntags: [DEAD]", "d"));
    write(ws, "wiki/4-archive/eps.md", &note("type: Concept\nrelations:\n  part_of: \"[[gamma]]\"", "e"));
    // Links to files written later stay unresolved until the next reload.
    ws.reload_bundle().unwrap();
}

const CANVAS: &str = "{\n\t\"nodes\":[\n\t\t{\"id\":\"b\",\"type\":\"text\",\"text\":\"Hi\",\"x\":0,\"y\":0,\"width\":200,\"height\":60,\"zz\":{\"keep\":1}},\n\t\t{\"id\":\"a\",\"type\":\"file\",\"file\":\"wiki/hello.md\",\"x\":300,\"y\":0,\"width\":200,\"height\":60}\n\t],\n\t\"edges\":[\n\t\t{\"id\":\"e\",\"fromNode\":\"b\",\"toNode\":\"a\",\"label\":\"see\"}\n\t],\n\t\"custom\":true\n}";

#[test]
fn the_tools_are_listed_with_their_schemas() {
    let names: Vec<&str> = TOOLS.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for name in ["canvas_list", "canvas_read", "canvas_write", "canvas_from_links", "graph_schema", "system_map"] {
        assert!(names.contains(&name), "{name}");
    }
}

#[test]
fn a_new_bundle_has_the_graph_folder_and_systemmap_and_raises_no_warning() {
    let (_d, root, mut ws) = bundle();
    let schema = fs::read_to_string(format!("{root}/wiki/graph/schema.md")).unwrap();
    assert!(schema.contains("type: GraphSchema"));
    assert!(fs::metadata(format!("{root}/wiki/graph/canvases/index.md")).is_ok());
    assert!(ws.conformance_issues().unwrap().is_empty());
    assert!(ws.schema_warnings().unwrap().is_empty());
    let map = fs::read_to_string(format!("{root}/SYSTEMMAP.md")).unwrap();
    assert!(map.contains(SYSTEMMAP_START) && map.contains(SYSTEMMAP_END));
    assert!(call(&mut ws, "read_map", json!({})).text.contains("SYSTEMMAP.md"));
    assert_eq!(call(&mut ws, "check_conformance", json!({})).text, "All documents conform to OKF v0.2.");
}

#[test]
fn canvas_write_validates_writes_verbatim_and_keeps_unknown_keys() {
    let (_d, root, mut ws) = bundle();
    let out = call(&mut ws, "canvas_write", json!({"path": "wiki/graph/canvases/c.canvas", "content": CANVAS, "actor": "process:test"}));
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(out.text, "Wrote wiki/graph/canvases/c.canvas");
    assert_eq!(fs::read_to_string(format!("{root}/wiki/graph/canvases/c.canvas")).unwrap(), CANVAS);
    assert!(ws.conformance_issues().unwrap().is_empty());
    assert!(!ws.list_concepts().unwrap().iter().any(|c| c.path.ends_with(".canvas")));

    let bad = call(&mut ws, "canvas_write", json!({"path": "wiki/c.canvas", "content": "{\"nodes\":[{\"id\":\"a\"}]}"}));
    assert!(bad.is_error);
    assert!(bad.text.starts_with("Invalid canvas, nothing written: nodes[0].type must be"));
    assert!(fs::metadata(format!("{root}/wiki/c.canvas")).is_err());

    let cases = [
        (json!({"path": "wiki/c.canvas", "content": "{"}), "Invalid canvas, nothing written: the content is not valid JSON"),
        (json!({"path": "wiki/c.json", "content": "{}"}), "'path' must end in .canvas"),
        (json!({"path": "raw/c.canvas", "content": "{}"}), "A .canvas file must live under wiki/: raw/c.canvas"),
        (json!({"path": "wiki/.hidden/c.canvas", "content": "{}"}), "A .canvas file cannot live in a hidden folder: wiki/.hidden/c.canvas"),
        (json!({"path": "wiki/c.canvas"}), "'content' is required"),
        (json!({"content": "{}"}), "'path' is required"),
    ];
    for (args, expected) in cases {
        let out = call(&mut ws, "canvas_write", args);
        assert!(out.is_error);
        assert_eq!(out.text, expected);
    }
}

#[test]
fn canvas_read_and_list() {
    let (_d, root, mut ws) = bundle();
    call(&mut ws, "canvas_write", json!({"path": "wiki/graph/canvases/c.canvas", "content": CANVAS}));
    let data: Value = serde_json::from_str(&call(&mut ws, "canvas_read", json!({"path": "wiki/graph/canvases/c.canvas"})).text).unwrap();
    assert_eq!(data["nodeCount"], 2);
    assert_eq!(data["canvas"]["custom"], true);
    assert_eq!(data["canvas"]["nodes"][0]["zz"], json!({"keep": 1}));
    let outline = data["outline"].as_str().unwrap();
    assert!(outline.contains("- [a] file wiki/hello.md — ようこそ: このバンドルの最初の概念ページ"));
    assert!(outline.contains("\"Hi\" -> ようこそ [see]"));

    assert_eq!(call(&mut ws, "canvas_read", json!({"path": "wiki/nope.canvas"})).text, "wiki/nope.canvas not found");
    fs::write(format!("{root}/wiki/broken.canvas"), "nope").unwrap();
    let list: Value = serde_json::from_str(&call(&mut ws, "canvas_list", json!({})).text).unwrap();
    assert_eq!(
        list,
        json!([
            {"path": "wiki/broken.canvas", "error": "the content is not valid JSON"},
            {"path": "wiki/graph/canvases/c.canvas", "nodes": 2, "edges": 1}
        ])
    );
}

#[test]
fn canvas_from_links_draws_saves_and_repeats_byte_for_byte() {
    let (_d, root, mut ws) = bundle();
    seed_graph(&mut ws);
    let out = call(&mut ws, "canvas_from_links", json!({"root": "1-projects/アルファ", "depth": 2, "path": "alpha.canvas"}));
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.starts_with("Wrote wiki/graph/canvases/alpha.canvas: 4 concepts, 4 edges."));
    assert!(out.text.contains("アルファ -> Gamma [depends_on]"));
    assert!(!out.text.contains("delta"));
    let saved = fs::read_to_string(format!("{root}/wiki/graph/canvases/alpha.canvas")).unwrap();
    assert!(saved.starts_with("{\n\t\"nodes\":[\n\t\t{\"id\":\""));

    call(&mut ws, "canvas_from_links", json!({"root": "wiki/1-projects/アルファ.md", "depth": 2, "path": "wiki/graph/canvases/again.canvas"}));
    assert_eq!(fs::read_to_string(format!("{root}/wiki/graph/canvases/again.canvas")).unwrap(), saved);

    let dead = call(&mut ws, "canvas_from_links", json!({"root": "gamma", "depth": 1, "include_dead": true, "path": "g.canvas"}));
    assert!(dead.text.contains("Wrote wiki/graph/canvases/g.canvas: 4 concepts"));

    let via_query = call(&mut ws, "canvas_from_links", json!({"query": "gamma", "depth": 0, "path": "q.canvas"}));
    assert!(!via_query.is_error, "{}", via_query.text);
}

#[test]
fn canvas_from_links_refuses_bad_input() {
    let (_d, _root, mut ws) = bundle();
    seed_graph(&mut ws);
    let cases = [
        (json!({"path": "x.canvas"}), "'root' or 'query' is required"),
        (json!({"root": "gamma"}), "'path' is required"),
        (json!({"root": "gamma", "path": "x.json"}), "'path' must end in .canvas"),
        (json!({"root": "gamma", "path": "x.canvas", "depth": 4}), "depth must be an integer from 0 to 3: 4"),
        (json!({"root": "gamma", "path": "x.canvas", "depth": 1.5}), "depth must be an integer from 0 to 3: 1.5"),
        (json!({"root": "gamma", "path": "x.canvas", "para_depth": 0}), "para_depth must be an integer from 1 to 4: 0"),
        (json!({"root": "no-such", "path": "x.canvas"}), "No concept matches root: no-such"),
        (json!({"query": "zzzzqqqq", "path": "x.canvas"}), "No concept matches the query: zzzzqqqq"),
        (json!({"root": "gamma", "path": "raw/x.canvas"}), "A .canvas file must live under wiki/: raw/x.canvas"),
    ];
    for (args, expected) in cases {
        let out = call(&mut ws, "canvas_from_links", args.clone());
        assert!(out.is_error, "{args}");
        assert_eq!(out.text, expected, "{args}");
    }
}

#[test]
fn relations_are_links_and_unresolved_relations_say_their_kind() {
    let (_d, _root, mut ws) = bundle();
    seed_graph(&mut ws);
    let bundle = ws.require_bundle().unwrap();
    assert_eq!(bundle.backlinks_of("3-resources/gamma"), vec!["1-projects/アルファ", "4-archive/eps"]);
    write(&mut ws, "wiki/3-resources/lost.md", &note("type: Concept\nrelations:\n  see_also: [nowhere/at-all]", "x"));
    let gaps = ws.unresolved_links().unwrap();
    assert!(gaps.iter().any(|g| g.from == "3-resources/lost"
        && g.target == "nowhere/at-all"
        && g.relation.as_deref() == Some("see_also")));
    assert!(gaps.iter().any(|g| g.target == "missing-page" && g.relation.is_none()));
}

#[test]
fn schema_warnings_appear_only_with_a_schema_and_never_as_errors() {
    let (_d, _root, mut ws) = bundle();
    write(&mut ws, "wiki/3-resources/odd.md", &note("type: Gizmo\nrelations:\n  teleports: [3-resources/odd]", "x"));
    // check_conformance keeps its original shape; the warnings are graph_schema's.
    let out = call(&mut ws, "check_conformance", json!({}));
    assert!(!out.is_error);
    assert_eq!(out.text, "All documents conform to OKF v0.2.");
    assert!(ws.conformance_issues().unwrap().is_empty());

    let schema: Value = serde_json::from_str(&call(&mut ws, "graph_schema", json!({})).text).unwrap();
    assert_eq!(schema["exists"], true);
    assert_eq!(schema["kinds"].as_array().unwrap().len(), 5);
    assert_eq!(
        schema["warnings"],
        json!([{
            "path": "wiki/3-resources/odd.md",
            "warnings": [
                "type 'Gizmo' is not declared in the graph schema",
                "relation kind 'teleports' is not declared in the graph schema"
            ]
        }])
    );

    call(&mut ws, "delete_file", json!({"path": "wiki/graph/schema.md"}));
    assert_eq!(call(&mut ws, "check_conformance", json!({})).text, "All documents conform to OKF v0.2.");
    let gone: Value = serde_json::from_str(&call(&mut ws, "graph_schema", json!({})).text).unwrap();
    assert_eq!(gone, json!({"path": "wiki/graph/schema.md", "exists": false, "types": [], "kinds": []}));
}

#[test]
fn system_map_refresh_rewrites_only_the_marked_section() {
    let (_d, root, mut ws) = bundle();
    let path = format!("{root}/SYSTEMMAP.md");
    let original = fs::read_to_string(&path).unwrap();
    let edited = format!("MY NOTE — 日本語 \r\n{original}\n\ttrailing  spaces  \n");
    fs::write(&path, &edited).unwrap();

    seed_graph(&mut ws);
    let out = call(&mut ws, "system_map", json!({"refresh": true, "actor": "process:test"}));
    assert!(!out.is_error, "{}", out.text);
    let now = fs::read_to_string(&path).unwrap();
    assert_eq!(now, out.text);
    assert!(now.starts_with("MY NOTE — 日本語 \r\n"));
    assert!(now.ends_with("\n\ttrailing  spaces  \n"));
    assert!(now.contains("| 概念 | 7（DEAD 1 件を含む） |"));
    assert!(now.contains(&format!("| MCP ツール | {} |", TOOLS.len())));
    assert!(now.contains("- 関係: `depends_on`"));
    assert_eq!(call(&mut ws, "system_map", json!({"refresh": true})).text, now);

    fs::remove_file(&path).unwrap();
    assert!(call(&mut ws, "system_map", json!({})).text.contains(SYSTEMMAP_START));
    assert!(fs::metadata(&path).is_err());
    call(&mut ws, "system_map", json!({"refresh": true}));
    assert!(fs::read_to_string(&path).unwrap().contains("## 拡張のしかた"));
}

#[test]
fn a_marker_mix_other_than_one_pair_is_refused_and_the_file_left_alone() {
    let (_d, root, mut ws) = bundle();
    let path = format!("{root}/SYSTEMMAP.md");
    let (s, e) = (SYSTEMMAP_START, SYSTEMMAP_END);
    let cases = [
        (format!("mine\n{s}\nhalf\n"), "1 start and 0 end markers"),
        (format!("mine\n{e}\nhalf\n"), "0 start and 1 end markers"),
        (format!("{e}\nx\n{s}\n"), "1 start and 1 end markers"),
        (format!("{s}\n{s}\n{e}\n"), "2 start and 1 end markers"),
        (format!("{s}\n{e}\n{e}\n"), "1 start and 2 end markers"),
    ];
    for (text, counts) in cases {
        fs::write(&path, &text).unwrap();
        let out = call(&mut ws, "system_map", json!({"refresh": true}));
        assert!(out.is_error, "{text}");
        assert!(out.text.contains(counts) && out.text.ends_with("Nothing was written."), "{}", out.text);
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }
}

#[test]
fn an_unreadable_systemmap_is_not_taken_for_a_missing_one() {
    let (_d, root, mut ws) = bundle();
    let path = format!("{root}/SYSTEMMAP.md");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let out = call(&mut ws, "system_map", json!({"refresh": true}));
    assert!(out.is_error);
    assert!(out.text.contains("EISDIR"), "{}", out.text);
    assert!(fs::metadata(&path).unwrap().is_dir());
}

#[test]
fn generated_text_cannot_spell_a_marker() {
    let (_d, root, mut ws) = bundle();
    write(
        &mut ws,
        "wiki/3-resources/evil.md",
        &note(&format!("type: \"Evil {SYSTEMMAP_END} {SYSTEMMAP_START}\"\ntitle: evil"), "x"),
    );
    call(&mut ws, "loop_define", json!({"goal": format!("goal {SYSTEMMAP_END} more"), "name": "evil-loop"}));
    let first = call(&mut ws, "system_map", json!({"refresh": true})).text;
    assert_eq!(first.matches(SYSTEMMAP_START).count(), 1);
    assert_eq!(first.matches(SYSTEMMAP_END).count(), 1);
    assert!(first.contains("&lt;!-- okf:systemmap:end -->"));
    assert_eq!(call(&mut ws, "system_map", json!({"refresh": true})).text, first);
    assert_eq!(fs::read_to_string(format!("{root}/SYSTEMMAP.md")).unwrap(), first);
}

#[test]
fn canvas_from_links_will_not_replace_a_canvas_unless_told_to() {
    let (_d, root, mut ws) = bundle();
    seed_graph(&mut ws);
    let args = json!({"root": "gamma", "depth": 1, "path": "o.canvas"});
    assert!(!call(&mut ws, "canvas_from_links", args.clone()).is_error);
    let file = format!("{root}/wiki/graph/canvases/o.canvas");
    let before = fs::read_to_string(&file).unwrap();
    fs::write(&file, "{\"nodes\":[],\"edges\":[]}").unwrap();
    let again = call(&mut ws, "canvas_from_links", args);
    assert!(again.is_error);
    assert_eq!(again.text, "wiki/graph/canvases/o.canvas already exists; pass overwrite: true to replace it");
    assert_eq!(fs::read_to_string(&file).unwrap(), "{\"nodes\":[],\"edges\":[]}");
    let forced = call(&mut ws, "canvas_from_links", json!({"root": "gamma", "depth": 1, "path": "o.canvas", "overwrite": true}));
    assert!(!forced.is_error, "{}", forced.text);
    assert_eq!(fs::read_to_string(&file).unwrap(), before);
}

#[test]
fn a_move_keeps_typed_relations_pointing_at_the_file() {
    let (_d, root, mut ws) = bundle();
    let fm = |relations: &str| format!("---\ntype: Concept\n# keep this comment\nrelations:\n{relations}\n---\n\nbody\n");
    let read = |rel: &str| fs::read_to_string(format!("{root}/{rel}")).unwrap();
    write(&mut ws, "wiki/3-resources/gamma.md", &note("type: Concept", "target"));
    let a = fm("  depends_on: [3-resources/gamma, \"[[gamma]]\", other/x]   # tail comment");
    let b = fm("  part_of:\n    - wiki/3-resources/gamma.md#sec\n    # between\n    - 'unrelated/y'");
    let c = fm("  see_also: 3-resources/gamma # note");
    let d = fm("  see_also: '[[gamma|G]]'");
    let e = fm("  see_also: ./gamma.md");
    for (name, text) in [("a", &a), ("b", &b), ("c", &c), ("d", &d), ("e", &e)] {
        write(&mut ws, &format!("wiki/3-resources/{name}.md"), text);
    }
    ws.reload_bundle().unwrap();

    let out = call(&mut ws, "move_file", json!({"from": "wiki/3-resources/gamma.md", "to": "wiki/4-archive/gamma.md"}));
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(out.text, "Moved wiki/3-resources/gamma.md → wiki/4-archive/gamma.md — updated 6 link(s) in 5 file(s)");
    assert_eq!(read("wiki/3-resources/a.md"), a.replace("[3-resources/gamma, \"[[gamma]]\"", "[4-archive/gamma, \"[[4-archive/gamma]]\""));
    assert_eq!(read("wiki/3-resources/b.md"), b.replace("3-resources/gamma.md#sec", "4-archive/gamma.md#sec"));
    assert_eq!(read("wiki/3-resources/c.md"), c.replace("3-resources/gamma", "4-archive/gamma"));
    assert_eq!(read("wiki/3-resources/d.md"), d.replace("[[gamma|G]]", "[[4-archive/gamma|G]]"));
    assert_eq!(read("wiki/3-resources/e.md"), e.replace("./gamma.md", "../4-archive/gamma.md"));
}

#[test]
fn a_relation_it_cannot_edit_safely_is_reported_as_dangling() {
    let (_d, root, mut ws) = bundle();
    let fm = |relations: &str| format!("---\ntype: Concept\nrelations:\n{relations}\n---\n\nbody\n");
    write(&mut ws, "wiki/3-resources/gamma.md", &note("type: Concept", "target"));
    let multi = fm("  depends_on: [\n    3-resources/gamma,\n    other/x\n  ]");
    let anchor = fm("  depends_on: &d [3-resources/gamma]");
    write(&mut ws, "wiki/3-resources/m.md", &multi);
    write(&mut ws, "wiki/3-resources/n.md", &anchor);
    ws.reload_bundle().unwrap();

    let out = call(&mut ws, "move_file", json!({"from": "wiki/3-resources/gamma.md", "to": "wiki/3-resources/delta.md"}));
    assert_eq!(
        out.text,
        "Moved wiki/3-resources/gamma.md → wiki/3-resources/delta.md — these relations now dangle and need a manual edit: wiki/3-resources/m.md (depends_on: 3-resources/gamma); wiki/3-resources/n.md (depends_on: 3-resources/gamma)"
    );
    assert_eq!(fs::read_to_string(format!("{root}/wiki/3-resources/m.md")).unwrap(), multi);
    assert_eq!(fs::read_to_string(format!("{root}/wiki/3-resources/n.md")).unwrap(), anchor);
}

#[test]
fn the_moved_files_own_relative_relations_are_rebased_by_set_para() {
    let (_d, root, mut ws) = bundle();
    let fm = |relations: &str| format!("---\ntype: Concept\n# keep this comment\nrelations:\n{relations}\n---\n\nbody\n");
    write(&mut ws, "wiki/3-resources/sibling.md", &note("type: Concept", "s"));
    let own = fm("  related_to: [./sibling.md, \"[[sibling]]\", 3-resources/sibling]");
    write(&mut ws, "wiki/3-resources/mover.md", &own);
    write(&mut ws, "wiki/3-resources/ref.md", &fm("  part_of: 3-resources/mover"));
    ws.reload_bundle().unwrap();

    let out = call(&mut ws, "set_para", json!({"path": "wiki/3-resources/mover.md", "para": "project"}));
    assert!(!out.is_error && !out.text.contains("dangle"), "{}", out.text);
    assert_eq!(
        fs::read_to_string(format!("{root}/wiki/1-projects/mover.md")).unwrap(),
        own.replace("./sibling.md", "../3-resources/sibling.md")
    );
    assert_eq!(fs::read_to_string(format!("{root}/wiki/3-resources/ref.md")).unwrap(), fm("  part_of: 1-projects/mover"));
}
