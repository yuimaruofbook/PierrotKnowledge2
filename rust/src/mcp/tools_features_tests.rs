//! The MCP surface of the lifecycle, context-range, activity and know-how
//! features, ported from the tool halves of `lifecycle.test.ts`,
//! `context-range.test.ts`, `activity.test.ts` and `knowhow.test.ts`.

use super::*;
use crate::okf::scaffold::scaffold_bundle;
use crate::workspace::WorkspaceOptions;
use serde_json::json;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn bundle() -> (TempDir, String, Workspace) {
    let dir = tempfile::Builder::new().prefix("okf-tools-features-").tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    scaffold_bundle(&root).unwrap();
    let mut ws = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    ws.open(&root).unwrap();
    (dir, root, ws)
}

fn note(ws: &mut Workspace, rel: &str, frontmatter: &str, body: &str) {
    let content = format!("---\n{frontmatter}\n---\n\n{body}");
    call_tool(
        ws,
        "write_file",
        json!({ "path": format!("wiki/{rel}"), "content": content }).as_object().unwrap(),
    );
}

fn call(ws: &mut Workspace, name: &str, args: Value) -> ToolResult {
    call_tool(ws, name, args.as_object().expect("arguments are an object"))
}

fn schema_keys(name: &str) -> Vec<String> {
    let tool = TOOLS.iter().find(|t| t["name"] == name).unwrap();
    tool["inputSchema"]["properties"].as_object().unwrap().keys().cloned().collect()
}

#[test]
fn the_new_tools_are_listed_with_their_schemas() {
    assert_eq!(TOOLS.len(), 54);
    let required = |name: &str| TOOLS.iter().find(|t| t["name"] == name).unwrap()["inputSchema"]["required"].clone();
    assert_eq!(required("set_lifecycle"), json!(["path", "lifecycle"]));
    assert_eq!(schema_keys("set_lifecycle"), ["path", "lifecycle", "actor"]);
    assert_eq!(required("summarize_activity"), Value::Null);
    assert_eq!(schema_keys("summarize_activity"), ["since", "until", "actor", "by", "save"]);
    assert_eq!(required("knowhow_add"), json!(["title", "body", "actor"]));
    assert_eq!(schema_keys("knowhow_add"), ["title", "body", "tags", "actor"]);
    assert_eq!(required("knowhow_find"), json!(["task"]));
    assert_eq!(schema_keys("knowhow_find"), ["task", "limit"]);
    for name in ["retrieve", "context_pack"] {
        let keys = schema_keys(name);
        for key in ["para_depth", "link_depth", "include_dead"] {
            assert!(keys.contains(&key.to_string()), "{name} lacks {key}");
        }
    }
    assert!(schema_keys("search").contains(&"include_dead".to_string()));
}

#[test]
fn set_lifecycle_validates_its_arguments_and_reports_the_outcome() {
    let (_d, _root, mut ws) = bundle();
    note(&mut ws, "plain.md", "type: Concept\ntitle: Plain", "# Plain\n\nwombat");

    assert!(call(&mut ws, "set_lifecycle", json!({})).is_error);
    let bad = call(&mut ws, "set_lifecycle", json!({ "path": "wiki/plain.md", "lifecycle": "alive" }));
    assert!(bad.is_error);
    assert_eq!(bad.text, "lifecycle must be product | dead | none: alive");
    assert_eq!(
        call(&mut ws, "set_lifecycle", json!({ "path": "wiki/plain.md" })).text,
        "lifecycle must be product | dead | none"
    );

    let ok = call(
        &mut ws,
        "set_lifecycle",
        json!({ "path": "wiki/plain.md", "lifecycle": "DEAD", "actor": "process:tester" }),
    );
    assert!(!ok.is_error);
    assert_eq!(ok.text, "Set lifecycle of wiki/plain.md to dead.");
    let again = call(&mut ws, "set_lifecycle", json!({ "path": "wiki/plain.md", "lifecycle": "dead" }));
    assert_eq!(again.text, "wiki/plain.md already has lifecycle dead; nothing changed.");
}

#[test]
fn include_dead_reaches_search_retrieve_and_context_pack() {
    let (_d, _root, mut ws) = bundle();
    note(&mut ws, "live.md", "type: Concept\ntitle: Live", "# Live\n\nthe quokka habitat survey notes");
    note(&mut ws, "retired.md", "type: Concept\ntitle: Retired\ntags: [DEAD]", "# Retired\n\nthe quokka habitat survey notes");

    assert!(!call(&mut ws, "search", json!({ "query": "quokka" })).text.contains("retired"));
    let shown = call(&mut ws, "search", json!({ "query": "quokka", "tags": ["DEAD"], "include_dead": true }));
    assert!(shown.text.contains("retired"));
    let packed = call(&mut ws, "context_pack", json!({ "task": "quokka habitat survey", "include_dead": true }));
    assert!(packed.text.contains("wiki/retired.md"));
    let retrieved = call(&mut ws, "retrieve", json!({ "query": "quokka habitat survey" }));
    assert!(!retrieved.text.contains("wiki/retired.md"));
    // Only a literal true counts.
    let loose = call(&mut ws, "search", json!({ "query": "quokka", "include_dead": "yes" }));
    assert!(!loose.text.contains("retired"));
}

#[test]
fn depths_are_rejected_when_out_of_range_not_clamped() {
    let (_d, _root, mut ws) = bundle();
    for bad in [json!(0), json!(5), json!(1.5), json!("2"), json!(true)] {
        let r = call(&mut ws, "retrieve", json!({ "query": "x", "para_depth": bad }));
        assert!(r.is_error);
        assert!(r.text.starts_with("para_depth must be an integer from 1 to 4: "), "{}", r.text);
    }
    for bad in [json!(-1), json!(3), json!(0.5), json!([1])] {
        let r = call(&mut ws, "context_pack", json!({ "task": "x", "link_depth": bad }));
        assert!(r.is_error);
        assert!(r.text.starts_with("link_depth must be an integer from 0 to 2: "), "{}", r.text);
    }
    assert_eq!(
        call(&mut ws, "retrieve", json!({ "query": "x", "para_depth": "2" })).text,
        "para_depth must be an integer from 1 to 4: 2"
    );
    // null means not given, and a whole float is an integer.
    assert!(!call(&mut ws, "retrieve", json!({ "query": "x", "para_depth": null })).is_error);
    assert!(!call(&mut ws, "retrieve", json!({ "query": "x", "para_depth": 2.0 })).is_error);
}

#[test]
fn valid_depths_reach_the_pack_and_retrieval() {
    let (_d, _root, mut ws) = bundle();
    note(&mut ws, "1-projects/p.md", "type: Concept\ntitle: P", "# P\n\nmarmoset canopy telemetry for the project");
    note(&mut ws, "2-areas/a.md", "type: Concept\ntitle: A", "# A\n\nmarmoset canopy telemetry for the area");
    let narrow = call(&mut ws, "context_pack", json!({ "task": "marmoset canopy telemetry", "para_depth": 1 }));
    assert!(narrow.text.contains("wiki/1-projects/p.md"));
    assert!(!narrow.text.contains("wiki/2-areas/a.md"));

    note(&mut ws, "head.md", "type: Concept\ntitle: Head", "# Head\n\nzebu pasture rotation plan. See [[mid]].");
    note(&mut ws, "mid.md", "type: Concept\ntitle: Mid\ndescription: the middle step", "# Mid\n\nbody");
    let linked = call(&mut ws, "retrieve", json!({ "query": "zebu pasture rotation plan", "link_depth": 1 }));
    assert!(linked.text.contains("Linked files"), "{}", linked.text);
    assert!(linked.text.contains("wiki/mid.md"));
}

#[test]
fn summarize_activity_rejects_bad_dates_and_inverted_ranges() {
    let (_d, _root, mut ws) = bundle();
    assert_eq!(
        call(&mut ws, "summarize_activity", json!({ "since": "last week" })).text,
        "since must be an ISO date: last week"
    );
    assert_eq!(
        call(&mut ws, "summarize_activity", json!({ "until": "2026-9-1" })).text,
        "until must be an ISO date: 2026-9-1"
    );
    let inverted = call(&mut ws, "summarize_activity", json!({ "since": "2026-09-03", "until": "2026-09-01" }));
    assert!(inverted.is_error);
    assert!(inverted.text.contains("until must not be before since"));
}

#[test]
fn summarize_activity_returns_the_page_or_the_saved_path() {
    let (_d, root, mut ws) = bundle();
    fs::write(
        Path::new(&root).join("wiki/log.md"),
        "# Log\n\n## 2026-09-03\n\n* **Update**: `wiki/b.md` by process:codex. second pass\n\n## 2026-09-02\n\n* **Update**: `wiki/a.md` by process:claude-code.\n",
    )
    .unwrap();
    ws.reload_bundle().unwrap();

    let page = call(&mut ws, "summarize_activity", json!({ "actor": "codex" }));
    assert!(page.text.contains("* 2026-09-03 · Update · `wiki/b.md` — second pass"));
    assert!(!page.text.contains("wiki/a.md"));

    let none = call(&mut ws, "summarize_activity", json!({ "since": "2030-01-01" }));
    assert!(!none.is_error);
    assert_eq!(none.text, "No log entries matched the given range or actor.");

    let saved = call(&mut ws, "summarize_activity", json!({ "save": true, "actor": "process:codex" }));
    assert_eq!(saved.text, "Saved wiki/activity/2026-09-03_2026-09-03_process-codex-f256b097.md (1 row(s))");
    // A non-boolean save is not a save.
    let not_saved = call(&mut ws, "summarize_activity", json!({ "save": "true" }));
    assert!(not_saved.text.starts_with("# Activity"));
}

#[test]
fn knowhow_add_reports_each_missing_piece() {
    let (_d, _root, mut ws) = bundle();
    assert_eq!(call(&mut ws, "knowhow_add", json!({})).text, "'title' is required");
    assert_eq!(call(&mut ws, "knowhow_add", json!({ "title": "t" })).text, "'body' is required");
    let no_actor = call(&mut ws, "knowhow_add", json!({ "title": "t", "body": "b" }));
    assert!(no_actor.is_error);
    assert!(no_actor.text.starts_with("'actor' is required"));

    let ok = call(
        &mut ws,
        "knowhow_add",
        json!({ "title": "A lesson", "body": "details", "actor": "process:tester", "tags": ["x", 1] }),
    );
    assert!(!ok.is_error);
    assert_eq!(ok.text, "Recorded know-how wiki/knowhow/a-lesson.md");
}

#[test]
fn knowhow_find_answers_plainly_when_nothing_matches() {
    let (_d, _root, mut ws) = bundle();
    assert!(call(&mut ws, "knowhow_find", json!({})).is_error);
    let none = call(&mut ws, "knowhow_find", json!({ "task": "nothing like this" }));
    assert!(!none.is_error);
    assert!(none.text.contains("No know-how matched"));

    call(&mut ws, "knowhow_add", json!({ "title": "Pitfall", "body": "sqlite wal files", "actor": "process:t" }));
    let hit = call(&mut ws, "knowhow_find", json!({ "task": "sqlite wal", "limit": 99 }));
    let parsed: Value = serde_json::from_str(&hit.text).unwrap();
    assert_eq!(parsed["ranked"][0]["title"], "Pitfall");
    assert_eq!(parsed["ranked"][0]["by"], "process:t");
}
