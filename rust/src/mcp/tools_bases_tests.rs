//! The MCP surface of bases, ported from the tool halves of `bases.test.ts`.

use super::*;
use crate::okf::scaffold::scaffold_bundle;
use crate::workspace::WorkspaceOptions;
use serde_json::json;
use tempfile::TempDir;

fn bundle() -> (TempDir, String, Workspace) {
    let dir = tempfile::Builder::new().prefix("okf-bases-").tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    scaffold_bundle(&root).unwrap();
    let mut ws = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    ws.open(&root).unwrap();
    (dir, root, ws)
}

fn call(ws: &mut Workspace, name: &str, args: Value) -> ToolResult {
    call_tool(ws, name, args.as_object().expect("arguments are an object"))
}

fn write(ws: &mut Workspace, path: &str, content: &str) {
    let r = call(ws, "write_file", json!({ "path": path, "content": content }));
    assert!(!r.is_error, "{}", r.text);
}

const BASE: &str =
    "filters: file.hasTag(\"Product\")\nviews:\n  - type: table\n    name: Products\n    order: [file.basename, title]\n";

fn seed(ws: &mut Workspace) {
    write(ws, "wiki/1-projects/shipped.md", "---\ntype: Project\ntitle: Shipped\ntags: [Product]\n---\n\nBody.\n");
    write(ws, "wiki/4-archive/old.md", "---\ntype: Concept\ntitle: Old\ntags: [DEAD]\n---\n\nBody.\n");
}

#[test]
fn the_tools_are_listed_with_their_schemas() {
    let keys = |name: &str| -> Vec<String> {
        let tool = TOOLS.iter().find(|t| t["name"] == name).unwrap();
        tool["inputSchema"]["properties"].as_object().unwrap().keys().cloned().collect()
    };
    let required = |name: &str| TOOLS.iter().find(|t| t["name"] == name).unwrap()["inputSchema"]["required"].clone();
    assert_eq!(keys("base_list"), Vec::<String>::new());
    assert_eq!(keys("base_query"), ["path", "view", "limit"]);
    assert_eq!(required("base_query"), json!(["path"]));
    assert_eq!(keys("base_write"), ["path", "content", "actor"]);
    assert_eq!(required("base_write"), json!(["path", "content"]));
}

#[test]
fn a_new_bundle_has_an_example_base_that_runs() {
    let (_d, _root, mut ws) = bundle();
    seed(&mut ws);
    let out = call(&mut ws, "base_query", json!({ "path": "wiki/bases/products-and-dead.base" }));
    assert!(!out.is_error, "{}", out.text);
    let data: Value = serde_json::from_str(&out.text).unwrap();
    assert_eq!(data["view"], "Products and DEAD by PARA");
    let keys: Vec<&Value> = data["groups"].as_array().unwrap().iter().map(|g| &g["key"]).collect();
    assert_eq!(keys, [&json!("1 Projects"), &json!("4 Archive")]);
}

#[test]
fn base_files_are_not_concepts_and_raise_no_conformance_warning() {
    let (_d, _root, mut ws) = bundle();
    write(&mut ws, "wiki/bases/x.base", "views: []\n");
    assert!(ws.list_concepts().unwrap().iter().all(|c| !c.path.ends_with(".base")));
    assert!(ws.conformance_issues().unwrap().is_empty());
}

#[test]
fn base_write_validates_writes_verbatim_and_keeps_unknown_keys() {
    let (_d, root, mut ws) = bundle();
    let content = "# edited in Obsidian\nfilters: file.hasTag(\"Product\")\nviews:\n  - type: table\n    name: P\n    columnSize: {file.name: 120}\nmyPlugin: {a: 1}\n";
    let out = call(
        &mut ws,
        "base_write",
        json!({ "path": "wiki/bases/p.base", "content": content, "actor": "process:test" }),
    );
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(out.text, "Wrote wiki/bases/p.base");
    assert_eq!(std::fs::read_to_string(format!("{root}/wiki/bases/p.base")).unwrap(), content);

    let warn = call(
        &mut ws,
        "base_write",
        json!({ "path": "wiki/bases/w.base", "content": "views: [{type: list, name: L}]\n" }),
    );
    assert_eq!(
        warn.text,
        "Wrote wiki/bases/w.base\nWarnings: views[0]: type 'list' is not supported (table and cards only)"
    );
}

#[test]
fn base_write_refuses_what_would_not_work_and_writes_nothing() {
    let (_d, root, mut ws) = bundle();
    let bad = call(&mut ws, "base_write", json!({ "path": "wiki/bases/b.base", "content": "filters: 'a ='\n" }));
    assert!(bad.is_error);
    assert_eq!(bad.text, "Invalid base, nothing written: filters: unexpected character '='");
    assert!(!std::path::Path::new(&format!("{root}/wiki/bases/b.base")).exists());

    let yaml = call(&mut ws, "base_write", json!({ "path": "wiki/bases/b.base", "content": "a: [1\n" }));
    assert_eq!(yaml.text, "Invalid base, nothing written: the content is not valid YAML");
    assert_eq!(
        call(&mut ws, "base_write", json!({ "path": "wiki/bases/b.md", "content": "views: []" })).text,
        "'path' must end in .base"
    );
    assert_eq!(
        call(&mut ws, "base_write", json!({ "path": "raw/b.base", "content": "views: []" })).text,
        "A .base file must live under wiki/: raw/b.base"
    );
    assert_eq!(call(&mut ws, "base_write", json!({ "path": "wiki/bases/b.base" })).text, "'content' is required");
}

#[test]
fn base_list_lists_every_base_with_its_views_and_errors() {
    let (_d, _root, mut ws) = bundle();
    write(&mut ws, "wiki/bases/p.base", BASE);
    write(&mut ws, "wiki/deep/er/q.base", "views: [{type: cards, name: Q}]\n");
    write(&mut ws, "wiki/bases/broken.base", "a: [1\n");
    let data: Value = serde_json::from_str(&call(&mut ws, "base_list", json!({})).text).unwrap();
    assert_eq!(
        data,
        json!([
            { "path": "wiki/bases/broken.base", "views": [], "error": "the content is not valid YAML" },
            { "path": "wiki/bases/p.base", "views": [{ "name": "Products", "type": "table" }] },
            { "path": "wiki/bases/products-and-dead.base", "views": [
                { "name": "Products and DEAD by PARA", "type": "table" },
                { "name": "Products", "type": "cards" }
            ] },
            { "path": "wiki/deep/er/q.base", "views": [{ "name": "Q", "type": "cards" }] },
        ])
    );
}

#[test]
fn base_query_returns_rows_columns_and_a_markdown_table() {
    let (_d, _root, mut ws) = bundle();
    seed(&mut ws);
    write(&mut ws, "wiki/bases/p.base", BASE);
    let data: Value =
        serde_json::from_str(&call(&mut ws, "base_query", json!({ "path": "wiki/bases/p.base" })).text).unwrap();
    assert_eq!(
        data,
        json!({
            "path": "wiki/bases/p.base",
            "view": "Products",
            "type": "table",
            "columns": [{ "id": "file.basename", "name": "file.basename" }, { "id": "title", "name": "title" }],
            "total": 1,
            "shown": 1,
            "rows": [{ "path": "wiki/1-projects/shipped.md", "cells": ["shipped", "Shipped"] }],
            "summaries": [],
            "markdown": "**Products** (table) - 1 of 1 rows\n\n| file.basename | title |\n| --- | --- |\n| shipped | Shipped |"
        })
    );
}

#[test]
fn base_query_errors_are_plain_sentences() {
    let (_d, _root, mut ws) = bundle();
    write(&mut ws, "wiki/bases/p.base", BASE);
    assert_eq!(call(&mut ws, "base_query", json!({})).text, "'path' is required");
    assert!(call(&mut ws, "base_query", json!({ "path": "wiki/bases/none.base" })).is_error);
    assert_eq!(call(&mut ws, "base_query", json!({ "path": "wiki/hello.md" })).text, "'path' must end in .base");
    assert_eq!(
        call(&mut ws, "base_query", json!({ "path": "wiki/bases/p.base", "view": "Z" })).text,
        "view 'Z' not found; available: Products"
    );
    for bad in [json!(0), json!(1.5), json!("2"), Value::Null] {
        assert_eq!(
            call(&mut ws, "base_query", json!({ "path": "wiki/bases/p.base", "limit": bad })).text,
            "limit must be a positive integer"
        );
    }
}

#[test]
fn base_write_is_confined_to_the_wiki_layer() {
    // A flat bundle: the wiki layer is the whole folder, so hidden folders need their own check.
    let dir = tempfile::Builder::new().prefix("okf-bases-flat-").tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    std::fs::write(dir.path().join("note.md"), "---\ntype: Concept\n---\n\nx\n").unwrap();
    let mut ws = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    ws.open(&root).unwrap();
    let mut attempt = |path: &str| {
        call(&mut ws, "base_write", json!({ "path": path, "content": "views: []\n", "actor": "process:test" }))
    };
    assert!(!attempt("bases/x.base").is_error);
    assert!(!attempt("top.base").is_error);
    for path in [".okf/x.base", ".git/x.base", "a/.hidden/x.base", ".x.base", "a/./.okf/x.base"] {
        let out = attempt(path);
        assert!(out.is_error, "{path}");
        assert_eq!(out.text, format!("A .base file cannot live in a hidden folder: {path}"));
    }
    assert_eq!(attempt("raw/x.base").text, "A .base file must live under wiki/: raw/x.base");
    assert!(attempt("../x.base").is_error);
    assert!(attempt("a/../../x.base").is_error);
    assert!(!dir.path().join(".okf").join("x.base").exists());

    let (_d, _root, mut normal) = bundle();
    let out = call(
        &mut normal,
        "base_write",
        json!({ "path": "wiki/.hidden/x.base", "content": "views: []\n", "actor": "process:test" }),
    );
    assert!(out.is_error);
    assert_eq!(out.text, "A .base file cannot live in a hidden folder: wiki/.hidden/x.base");
}
