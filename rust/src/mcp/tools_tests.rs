//! MCP protocol and tool tests, ported from `mcp.test.ts` and the MCP-surface
//! halves of `layers`, `para`, `skillspace`, `loops`, `audit` and
//! `context-pack`. The Workspace halves live in `workspace_tests.rs`.

use super::super::stdio::{
    handle_message, negotiate_protocol, run_stdio_server, SUPPORTED_PROTOCOL_VERSIONS,
};
use super::*;
use crate::okf::bundle::WriteOptions;
use crate::workspace::WorkspaceOptions;
use serde_json::json;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use tempfile::TempDir;

// ---- helpers ---------------------------------------------------------------------

fn root_of(prefix: &str) -> (TempDir, String) {
    let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    (dir, root)
}

fn seed(root: &str, files: &[(&str, &str)]) {
    for (rel, content) in files {
        let abs = Path::new(root).join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(abs, content).unwrap();
    }
}

fn offline() -> Workspace {
    Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() })
}

fn call(ws: &mut Workspace, name: &str, args: Value) -> ToolResult {
    call_tool(ws, name, args.as_object().expect("arguments are an object"))
}

fn json_of(result: &ToolResult) -> Value {
    serde_json::from_str(&result.text).unwrap_or_else(|e| panic!("{e}: {}", result.text))
}

fn exists(root: &str, rel: &str) -> bool {
    Path::new(root).join(rel).exists()
}

fn as_actor(actor: &str) -> WriteOptions {
    WriteOptions { actor: Some(actor.into()), ..Default::default() }
}

/// The mcp.test.ts fixture: a root-level AGENTS.md and one searchable note.
fn mcp_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = root_of("okf-mcp-");
    seed(
        &root,
        &[
            ("AGENTS.md", "# Agent contract\nRead me first.\n"),
            ("wiki/alpha.md", "---\ntype: Concept\ntitle: Alpha\n---\n\nsearchable-token here\n"),
        ],
    );
    let mut ws = offline();
    ws.open(&root).unwrap();
    (d, root, ws)
}

fn scaffolded() -> (TempDir, String, Workspace) {
    let (d, root) = root_of("okf-tools-");
    let mut ws = offline();
    ws.scaffold(&root).unwrap();
    ws.open(&root).unwrap();
    (d, root, ws)
}

// ---- JSON-RPC envelope -----------------------------------------------------------

#[test]
fn initialize_advertises_tools_and_echoes_a_supported_protocol() {
    let (_d, _root, mut ws) = mcp_bundle();
    let response = handle_message(
        &mut ws,
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
    )
    .unwrap();

    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["id"], 1);
    assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(response["result"]["capabilities"], json!({ "tools": { "listChanged": false } }));
    assert_eq!(response["result"]["serverInfo"]["name"], "okf-wiki");
    assert!(response["result"]["instructions"].as_str().unwrap().starts_with("Call read_map first."));
}

#[test]
fn negotiation_falls_back_to_our_newest_version() {
    assert_eq!(negotiate_protocol(Some(&json!("1999-01-01"))), SUPPORTED_PROTOCOL_VERSIONS[0]);
    assert_eq!(negotiate_protocol(None), SUPPORTED_PROTOCOL_VERSIONS[0]);
    assert_eq!(negotiate_protocol(Some(&json!(7))), SUPPORTED_PROTOCOL_VERSIONS[0]);
    assert_eq!(negotiate_protocol(Some(&json!("2024-11-05"))), "2024-11-05");
}

#[test]
fn notifications_are_never_answered() {
    let (_d, _root, mut ws) = mcp_bundle();
    assert!(handle_message(&mut ws, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
    assert!(handle_message(&mut ws, &json!({ "jsonrpc": "2.0", "method": "ping" })).is_none());
    assert!(handle_message(&mut ws, &json!({ "jsonrpc": "2.0", "id": null, "method": "ping" })).is_none());
    // Not an object at all: there is no id to answer.
    assert!(handle_message(&mut ws, &json!([1, 2])).is_none());
    assert!(handle_message(&mut ws, &json!(42)).is_none());
}

#[test]
fn ping_with_an_id_is_answered_and_a_missing_method_is_invalid() {
    let (_d, _root, mut ws) = mcp_bundle();
    let pong = handle_message(&mut ws, &json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" })).unwrap();
    assert_eq!(pong, json!({ "jsonrpc": "2.0", "id": 7, "result": {} }));

    let invalid = handle_message(&mut ws, &json!({ "jsonrpc": "2.0", "id": 8 })).unwrap();
    assert_eq!(invalid["error"], json!({ "code": -32600, "message": "Missing 'method'" }));
}

#[test]
fn an_unknown_method_is_a_json_rpc_error_not_a_crash() {
    let (_d, _root, mut ws) = mcp_bundle();
    let response = handle_message(&mut ws, &json!({ "jsonrpc": "2.0", "id": 2, "method": "nope" })).unwrap();
    assert_eq!(response["id"], 2);
    assert_eq!(response["error"], json!({ "code": -32601, "message": "Unknown method: nope" }));
}

#[test]
fn tools_call_without_a_name_is_invalid() {
    let (_d, _root, mut ws) = mcp_bundle();
    let response = handle_message(
        &mut ws,
        &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {} }),
    )
    .unwrap();
    assert_eq!(response["error"], json!({ "code": -32600, "message": "Missing tool name" }));
}

#[test]
fn tools_list_returns_schemas_for_every_tool() {
    let (_d, _root, mut ws) = mcp_bundle();
    let response =
        handle_message(&mut ws, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })).unwrap();
    let tools = response["result"]["tools"].as_array().unwrap();

    assert_eq!(tools.len(), 54);
    assert_eq!(tools.len(), TOOLS.len());
    for tool in tools {
        let name = tool["name"].as_str().unwrap();
        assert!(name.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{name}");
        assert_eq!(tool["inputSchema"]["type"], "object");
        // name, title, description, inputSchema: the order the TS source writes them in.
        let keys: Vec<&str> = tool.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["name", "title", "description", "inputSchema"], "{name}");
    }
}

#[test]
fn every_tool_in_the_definitions_is_dispatched() {
    let (_d, _root, mut ws) = mcp_bundle();
    for tool in TOOLS.iter() {
        let name = tool["name"].as_str().unwrap();
        let result = call(&mut ws, name, json!({}));
        assert!(!result.text.starts_with("Unknown tool"), "{name} has no handler");
    }
}

// ---- stdio framing ---------------------------------------------------------------

fn serve(ws: &mut Workspace, input: Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    run_stdio_server(ws, Cursor::new(input), |line| lines.push(line.to_string()), &AtomicBool::new(false));
    lines
}

#[test]
fn emits_one_json_object_per_line_and_no_headers() {
    let (_d, _root, mut ws) = mcp_bundle();
    let requests = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    ];
    let payload: String = requests.iter().map(|r| format!("{r}\n")).collect();

    let lines = serve(&mut ws, payload.into_bytes());

    assert_eq!(lines.len(), 2); // the notification is not answered
    for line in &lines {
        assert!(line.ends_with('\n'));
        assert!(!line.contains("Content-Length"));
        assert!(serde_json::from_str::<Value>(line).is_ok());
        assert!(!line.trim_end().contains('\n'));
    }
}

#[test]
fn a_malformed_line_yields_a_parse_error_and_the_stream_continues() {
    let (_d, _root, mut ws) = mcp_bundle();
    let input = format!("not json\n{}\n", json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" }));
    let lines = serve(&mut ws, input.into_bytes());

    let first: Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(first["error"]["code"], -32700);
    assert_eq!(first["id"], Value::Null);
    let second: Value = serde_json::from_str(&lines[1]).unwrap();
    assert_eq!(second["id"], 9);
}

#[test]
fn blank_lines_are_skipped_and_an_unterminated_tail_is_dropped() {
    let (_d, _root, mut ws) = mcp_bundle();
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    let input = format!("\n   \n{ping}\n{ping}");
    assert_eq!(serve(&mut ws, input.into_bytes()).len(), 1);
}

#[test]
fn a_message_split_across_reads_is_reassembled() {
    struct Chunked(Vec<Vec<u8>>);
    impl std::io::Read for Chunked {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.is_empty() {
                return Ok(0);
            }
            let chunk = self.0.remove(0);
            buf[..chunk.len()].copy_from_slice(&chunk);
            // Give the loop time to see the first half alone.
            std::thread::sleep(std::time::Duration::from_millis(60));
            Ok(chunk.len())
        }
    }

    let (_d, _root, mut ws) = mcp_bundle();
    // Split inside a multi-byte character: a real client's writes do not align
    // to message boundaries, and a naive reader corrupts the split one.
    let full = format!("{}\n", json!({ "jsonrpc": "2.0", "id": 5, "method": "ping", "params": { "x": "日本語" } }));
    let bytes = full.into_bytes();
    let cut = bytes.iter().position(|b| *b >= 0x80).unwrap() + 1;
    let mut lines = Vec::new();
    run_stdio_server(
        &mut ws,
        Chunked(vec![bytes[..cut].to_vec(), bytes[cut..].to_vec()]),
        |line| lines.push(line.to_string()),
        &AtomicBool::new(false),
    );
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("\"id\":5"));
}

// ---- tools -----------------------------------------------------------------------

#[test]
fn read_agents_md_returns_the_contract() {
    let (_d, _root, mut ws) = mcp_bundle();
    assert!(call(&mut ws, "read_agents_md", json!({})).text.contains("Read me first"));
}

#[test]
fn read_agents_md_explains_the_defaults_when_the_file_is_missing() {
    let (_d, root, mut ws) = mcp_bundle();
    let _ = fs::remove_file(Path::new(&root).join("wiki/AGENTS.md"));
    let _ = fs::remove_file(Path::new(&root).join("AGENTS.md"));
    let result = call(&mut ws, "read_agents_md", json!({}));
    assert!(!result.is_error);
    assert!(result.text.contains("OKF v0.2 defaults"));
}

#[test]
fn search_finds_a_concept_and_reports_no_matches_as_text() {
    let (_d, _root, mut ws) = mcp_bundle();
    assert!(call(&mut ws, "search", json!({ "query": "searchable-token" })).text.contains("alpha"));

    let none = call(&mut ws, "search", json!({ "query": "zzzznotpresent" }));
    assert!(!none.is_error);
    assert!(none.text.contains("No matches"));
}

#[test]
fn create_concept_produces_a_conformant_file() {
    let (_d, _root, mut ws) = mcp_bundle();
    let result = call(
        &mut ws,
        "create_concept",
        json!({ "path": "wiki/new-page.md", "type": "Playbook", "title": "New Page", "actor": "process:test" }),
    );
    assert!(!result.is_error, "{}", result.text);

    let read = ws.read_file("wiki/new-page.md").unwrap();
    let frontmatter = read.concept.unwrap().frontmatter;
    assert_eq!(frontmatter.r#type, "Playbook");
    assert_eq!(frontmatter.generated.unwrap().by, "process:test");
    assert!(ws.conformance_issues().unwrap().is_empty());
}

#[test]
fn create_concept_validates_its_arguments() {
    let (_d, _root, mut ws) = mcp_bundle();
    let empty_type = call(&mut ws, "create_concept", json!({ "path": "wiki/x.md", "type": "" }));
    assert!(empty_type.is_error);
    assert_eq!(empty_type.text, "'type' is required and must be non-empty (OKF v0.2)");
    assert_eq!(call(&mut ws, "create_concept", json!({ "type": "Concept" })).text, "'path' is required");
    assert_eq!(
        call(&mut ws, "create_concept", json!({ "path": "x.txt", "type": "Concept" })).text,
        "'path' must end in .md"
    );
}

#[test]
fn write_file_into_raw_is_refused_with_an_explanation() {
    // raw/ is the human's inbox. An agent writing there would be inventing a
    // source, so the refusal says whose job it is rather than just "denied".
    let (_d, _root, mut ws) = mcp_bundle();
    let result = call(&mut ws, "write_file", json!({ "path": "raw/thing.md", "content": "x" }));
    assert!(result.is_error);
    assert!(result.text.contains("人間"));
}

#[test]
fn write_file_cannot_escape_the_bundle_and_surfaces_conformance_warnings() {
    let (_d, _root, mut ws) = mcp_bundle();
    let escape = call(&mut ws, "write_file", json!({ "path": "../../escaped.md", "content": "x" }));
    assert!(escape.is_error);
    assert!(escape.text.contains("バンドルの外"));

    let loose = call(&mut ws, "write_file", json!({ "path": "wiki/loose.md", "content": "# no frontmatter" }));
    assert!(loose.text.contains("OKF warnings"));
}

#[test]
fn check_conformance_reports_offenders() {
    let (_d, _root, mut ws) = mcp_bundle();
    ws.write_file("wiki/loose.md", "# no frontmatter", &WriteOptions::default()).unwrap();
    assert!(call(&mut ws, "check_conformance", json!({})).text.contains("wiki/loose.md"));
}

#[test]
fn an_unknown_tool_is_an_error_result_not_a_panic() {
    let (_d, _root, mut ws) = mcp_bundle();
    let result = call(&mut ws, "does_not_exist", json!({}));
    assert!(result.is_error);
    assert_eq!(result.text, "Unknown tool: does_not_exist");
}

#[test]
fn tools_operate_without_a_bundle_instead_of_crashing() {
    let mut empty = offline();
    let result = call(&mut empty, "search", json!({ "query": "x" }));
    assert!(result.is_error);
    assert!(result.text.contains(messages::NO_BUNDLE_OPEN));
    assert_eq!(
        call(&mut empty, "bundle_info", json!({})).text,
        "No bundle is open. Call open_bundle first."
    );
}

#[test]
fn tool_results_serialise_like_the_ts() {
    let ok = text("hi").to_value();
    assert_eq!(serde_json::to_string(&ok).unwrap(), r#"{"content":[{"type":"text","text":"hi"}]}"#);
    let bad = fail("no").to_value();
    assert_eq!(
        serde_json::to_string(&bad).unwrap(),
        r#"{"content":[{"type":"text","text":"no"}],"isError":true}"#
    );
}

#[test]
fn arguments_are_coerced_the_way_js_would() {
    assert_eq!(js_string(&json!(1.0)), "1");
    assert_eq!(js_string(&json!(2.5)), "2.5");
    assert_eq!(js_string(&json!(null)), "null");
    assert_eq!(js_string(&json!(true)), "true");
    assert_eq!(js_string(&json!([1, null, "a"])), "1,,a");
    assert_eq!(js_string(&json!({})), "[object Object]");
    assert!(!truthy(&json!("")));
    assert!(!truthy(&json!(0)));
    assert!(truthy(&json!([])));
    assert!(truthy(&json!("0")));
}

#[test]
fn dates_must_be_real_calendar_days() {
    assert!(matches!(parse_date(""), DateArg::Today));
    assert!(matches!(parse_date(" 2026-08-04 "), DateArg::On(_)));
    for bad in ["2026-02-30", "2026-13-01", "yesterday", "26-01-01", "0026-01-01", "2026-8-4"] {
        assert!(matches!(parse_date(bad), DateArg::Invalid), "{bad}");
    }
}

// ---- layers.test.ts (MCP) --------------------------------------------------------

#[test]
fn agents_can_still_read_the_contract_from_its_new_home() {
    let (_d, _root, mut ws) = scaffolded();
    assert!(call(&mut ws, "read_agents_md", json!({})).text.contains("レイヤー"));
}

fn scaffolded_with_raw() -> (TempDir, String, Workspace) {
    let (d, root, ws) = scaffolded();
    seed(&root, &[("raw/source.md", "# 生データ\n\n議事録の本文。\n")]);
    (d, root, ws)
}

#[test]
fn an_agent_cannot_move_a_file_out_of_raw() {
    let (_d, root, mut ws) = scaffolded_with_raw();
    let result = call(
        &mut ws,
        "move_file",
        json!({ "from": "raw/source.md", "to": "wiki/stolen.md", "actor": "process:test" }),
    );
    assert!(result.is_error);
    assert!(result.text.contains("人間の操作"));
    assert!(exists(&root, "raw/source.md"));
    assert!(!exists(&root, "wiki/stolen.md"));
}

#[test]
fn an_agent_can_move_files_within_the_wiki_layer_but_not_into_raw() {
    let (_d, root, mut ws) = scaffolded_with_raw();
    ws.write_file("wiki/a.md", "---\ntype: Concept\n---\n\n# A\n", &as_actor("test")).unwrap();

    let into_raw = call(&mut ws, "move_file", json!({ "from": "wiki/a.md", "to": "raw/a.md", "actor": "process:test" }));
    assert!(into_raw.is_error);
    assert!(!exists(&root, "raw/a.md"));

    let within = call(
        &mut ws,
        "move_file",
        json!({ "from": "wiki/a.md", "to": "wiki/topics/a.md", "actor": "process:test" }),
    );
    assert!(!within.is_error, "{}", within.text);
    assert!(exists(&root, "wiki/topics/a.md"));
    assert_eq!(within.text, "Moved wiki/a.md → wiki/topics/a.md");
}

#[test]
fn an_agent_may_not_write_into_raw_but_may_into_rag() {
    let (_d, root, mut ws) = scaffolded_with_raw();
    let fabricated = call(
        &mut ws,
        "write_file",
        json!({ "path": "raw/fabricated.md", "content": "# エージェントが作った原本\n", "actor": "process:test" }),
    );
    assert!(fabricated.is_error);
    assert!(fabricated.text.contains("人間"));
    assert!(!exists(&root, "raw/fabricated.md"));

    let derived = call(
        &mut ws,
        "write_file",
        json!({ "path": ".rag/agent-note.md", "content": "agent", "actor": "process:test" }),
    );
    assert!(!derived.is_error);
    assert!(exists(&root, ".rag/agent-note.md"));
}

// ---- para.test.ts (MCP) ----------------------------------------------------------

fn para_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = root_of("okf-para-");
    let mut ws = offline();
    ws.scaffold(&root).unwrap();
    seed(
        &root,
        &[
            ("wiki/1-projects/q3.md", "---\ntype: Concept\ntitle: Q3\n---\n\n# Q3\n\n本文\n"),
            ("wiki/3-resources/ref.md", "---\ntype: Concept\ntitle: 参照\n---\n\n# 参照\n\n本文\n"),
        ],
    );
    ws.open(&root).unwrap();
    (d, root, ws)
}

#[test]
fn set_para_refiles_and_reports_where_it_went() {
    let (_d, root, mut ws) = para_bundle();
    let result = call(&mut ws, "set_para", json!({ "path": "wiki/1-projects/q3.md", "para": "archive" }));
    assert!(!result.is_error, "{}", result.text);
    assert!(result.text.contains("4-archive"));
    assert!(exists(&root, "wiki/4-archive/q3.md"));
}

#[test]
fn set_para_accepts_the_folder_name_and_refuses_unknown_classes() {
    let (_d, _root, mut ws) = para_bundle();
    assert!(!call(&mut ws, "set_para", json!({ "path": "wiki/1-projects/q3.md", "para": "4-archive" })).is_error);

    let unknown = call(&mut ws, "set_para", json!({ "path": "wiki/3-resources/ref.md", "para": "someday" }));
    assert!(unknown.is_error);
    assert!(unknown.text.contains("project"));
}

#[test]
fn list_para_groups_in_priority_order_and_can_be_narrowed() {
    let (_d, _root, mut ws) = para_bundle();
    let payload = json_of(&call(&mut ws, "list_para", json!({})));
    assert_eq!(payload["order"], json!(["project", "area", "resource", "archive"]));
    let ids = |class: &str| -> Vec<String> {
        payload["groups"][class]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert!(ids("project").contains(&"1-projects/q3".to_string()));
    assert!(ids("resource").contains(&"3-resources/ref".to_string()));

    let narrowed = json_of(&call(&mut ws, "list_para", json!({ "para": "project" })));
    let keys: Vec<&str> = narrowed["groups"].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["project"]);
}

// ---- skillspace.test.ts (MCP) ----------------------------------------------------

fn skill_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = root_of("okf-skill-");
    seed(
        &root,
        &[
            (
                "wiki/skills/okf-ingest/SKILL.md",
                "---\nname: okf-ingest\ndescription: raw/ の資料を wiki/ に取り込んで整理する手順。議事録やエクスポートを扱うとき。\nwhen: [取り込み, ingest, 議事録, エクスポート]\ntags: [ingest, workflow]\n---\n\n# 取り込み手順\n\n1. read_agents_md を呼ぶ\n2. search で重複を確認する",
            ),
            ("wiki/skills/okf-ingest/reference.md", "# 詳細な参照\n\nここに長い手順が入る。"),
            (
                "wiki/skills/japanese-search/SKILL.md",
                "---\nname: japanese-search\ndescription: 日本語で検索がヒットしないときの調べ方と直し方。\nwhen: [検索, search, ヒットしない, バイグラム]\ntags: [search]\n---\n\n# 日本語検索\n\nCJK はバイグラムで索引している。",
            ),
        ],
    );
    let mut ws = offline();
    ws.open(&root).unwrap();
    (d, root, ws)
}

#[test]
fn skill_find_returns_candidates_and_confidence_but_no_bodies() {
    let (_d, _root, mut ws) = skill_bundle();
    let result = call(&mut ws, "skill_find", json!({ "task": "議事録を取り込む" }));
    let payload = json_of(&result);
    assert_eq!(payload["ranked"][0]["name"], "okf-ingest");
    assert!(payload["confidence"].is_string());
    assert!(!result.text.contains("read_agents_md"));

    let nothing = call(&mut ws, "skill_find", json!({ "task": "今日の天気" }));
    assert!(!nothing.is_error);
    assert!(nothing.text.contains("skill_list"));

    assert!(call(&mut ws, "skill_find", json!({})).is_error);
}

#[test]
fn the_skill_tiers_stay_separate() {
    let (_d, _root, mut ws) = skill_bundle();
    let list = call(&mut ws, "skill_list", json!({}));
    assert!(list.text.contains("okf-ingest"));
    assert!(!list.text.contains("read_agents_md"));

    let open = call(&mut ws, "skill_open", json!({ "name": "okf-ingest" }));
    assert!(open.text.contains("read_agents_md"));
    // It must also tell the agent what else it could read, without reading it.
    assert!(open.text.contains("reference.md"));
    assert!(!open.text.contains("詳細な参照"));
    assert!(open.text.starts_with("# skill: okf-ingest\n\n"));

    assert!(call(&mut ws, "skill_read", json!({ "name": "okf-ingest", "path": "reference.md" })).text.contains("詳細な参照"));
    assert!(call(&mut ws, "skill_read", json!({ "name": "okf-ingest", "path": "../../AGENTS.md" })).is_error);
}

// ---- loops.test.ts (MCP) ---------------------------------------------------------

fn loop_files(root: &str) -> Vec<String> {
    fs::read_dir(Path::new(root).join("wiki/loops"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn start_reports_state_skill_and_checks_in_one_call() {
    let (_d, _root, mut ws) = scaffolded();
    call(
        &mut ws,
        "loop_define",
        json!({ "goal": "議事録を wiki に取り込む", "name": "ingest-notes", "skill": "okf-ingest", "checks": ["未解決リンクを確認した"] }),
    );
    let payload = json_of(&call(&mut ws, "loop_start", json!({ "name": "ingest-notes" })));

    assert_eq!(payload["before"]["nonConformant"], 0);
    assert_eq!(payload["skill"], "okf-ingest");
    assert_eq!(payload["checks"], json!(["未解決リンクを確認した"]));
    assert!(payload["next"].as_str().unwrap().contains("skill_open"));
    assert_eq!(payload["runNumber"], 1);
}

#[test]
fn start_suggests_a_skill_when_the_design_names_none() {
    let (_d, _root, mut ws) = scaffolded();
    let payload = json_of(&call(&mut ws, "loop_start", json!({ "goal": "議事録を取り込みたい" })));
    assert_eq!(payload["suggested"][0]["name"], "okf-ingest");
}

#[test]
fn start_defines_the_design_on_the_spot_and_reports_the_previous_run() {
    let (_d, root, mut ws) = scaffolded();
    let first = json_of(&call(&mut ws, "loop_start", json!({ "goal": "Weekly lint", "name": "weekly-lint" })));
    assert_eq!(first["name"], "weekly-lint");
    assert!(loop_files(&root).contains(&"weekly-lint.md".to_string()));

    call(&mut ws, "loop_end", json!({ "outcome": "前回の結果" }));
    let second = json_of(&call(&mut ws, "loop_start", json!({ "name": "weekly-lint" })));
    assert_eq!(second["lastRun"]["outcome"], "前回の結果");
    assert_eq!(second["runNumber"], 2);
}

#[test]
fn end_reports_the_difference_and_the_checks() {
    let (_d, _root, mut ws) = scaffolded();
    call(
        &mut ws,
        "loop_define",
        json!({ "goal": "ページを作る", "name": "make-pages", "checks": ["index.md を再構築した"] }),
    );
    call(&mut ws, "loop_start", json!({ "name": "make-pages" }));
    ws.write_file("wiki/new-note.md", "---\ntype: Concept\n---\n\n# 新規\n", &as_actor("test")).unwrap();

    let result = call(&mut ws, "loop_end", json!({ "outcome": "1 ページ作成" }));
    assert!(!result.is_error, "{}", result.text);
    assert!(result.text.contains("(+1)"));
    assert!(result.text.contains("index.md を再構築した"));
    assert!(result.text.ends_with('\n'), "a closing run ends with the empty regression slot");
}

#[test]
fn a_rise_in_non_conformance_is_reported_as_an_error() {
    let (_d, _root, mut ws) = scaffolded();
    call(&mut ws, "loop_start", json!({ "goal": "壊す", "name": "break-it" }));
    // No frontmatter: an OKF section 11 violation.
    ws.write_file("wiki/broken.md", "# frontmatter がない\n", &as_actor("test")).unwrap();

    let result = call(&mut ws, "loop_end", json!({}));
    assert!(result.is_error);
    assert!(result.text.contains("非準拠"));
}

#[test]
fn notes_are_refused_when_nothing_is_running() {
    let (_d, _root, mut ws) = scaffolded();
    let result = call(&mut ws, "loop_note", json!({ "detail": "x" }));
    assert!(result.is_error);
    assert_eq!(result.text, messages::LOOP_NONE_RUNNING);
}

#[test]
fn loop_list_guides_an_agent_that_is_resuming() {
    let (_d, _root, mut ws) = scaffolded();
    call(&mut ws, "loop_define", json!({ "goal": "Weekly lint", "name": "weekly-lint" }));

    let idle = json_of(&call(&mut ws, "loop_list", json!({})));
    assert_eq!(idle["running"], Value::Null);
    let names: Vec<&str> = idle["loops"].as_array().unwrap().iter().map(|l| l["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"weekly-lint"));
    assert!(idle["hint"].as_str().unwrap().contains("loop_start"));

    call(&mut ws, "loop_start", json!({ "name": "weekly-lint" }));
    let busy = json_of(&call(&mut ws, "loop_list", json!({})));
    assert_eq!(busy["running"], "weekly-lint");
    assert!(busy["hint"].as_str().unwrap().contains("loop_end"));
}

#[test]
fn loop_read_returns_the_design_and_history_and_unknown_loops_fail_clearly() {
    let (_d, _root, mut ws) = scaffolded();
    call(&mut ws, "loop_start", json!({ "goal": "Weekly lint", "name": "weekly-lint" }));
    call(&mut ws, "loop_end", json!({ "outcome": "終わった" }));

    let design = json_of(&call(&mut ws, "loop_read", json!({ "name": "weekly-lint" })));
    assert_eq!(design["runs"], 1);
    assert_eq!(design["history"][0]["outcome"], "終わった");

    assert!(call(&mut ws, "loop_start", json!({})).is_error);
    let unknown = call(&mut ws, "loop_read", json!({ "name": "no-such-loop" }));
    assert!(unknown.is_error);
    assert!(unknown.text.contains("no-such-loop"));
}

#[test]
fn abandoning_is_recorded_as_such() {
    let (_d, _root, mut ws) = scaffolded();
    call(&mut ws, "loop_start", json!({ "goal": "やめる", "name": "give-up" }));
    call(&mut ws, "loop_end", json!({ "status": "abandoned", "outcome": "中断" }));

    let design = ws.require_loops().unwrap().read("give-up").unwrap();
    assert_eq!(design.history[0].status, crate::shared::okf::loop_::RunStatus::Abandoned);
}

// ---- audit.test.ts (MCP) ---------------------------------------------------------

fn audit_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = root_of("okf-audit-");
    fs::create_dir_all(Path::new(&root).join("wiki")).unwrap();
    let mut ws = offline();
    ws.open(&root).unwrap();
    let agent = |actor: &str| WriteOptions {
        by: Some(crate::okf::paths::Actor::Agent),
        actor: Some(actor.into()),
        ..Default::default()
    };
    ws.write_file("wiki/one.md", "---\ntype: Note\n---\n\nA\n", &agent("process:local-qwen")).unwrap();
    ws.write_file("wiki/two.md", "---\ntype: Note\n---\n\nB\n", &agent("process:local-qwen")).unwrap();
    ws.write_file("wiki/three.md", "---\ntype: Note\n---\n\nC\n", &as_actor("human:local")).unwrap();
    (d, root, ws)
}

#[test]
fn audit_changes_tool_reports_and_validates() {
    let (_d, _root, mut ws) = audit_bundle();
    let ok = call(&mut ws, "audit_changes", json!({ "actor": "process:" }));
    assert!(!ok.is_error);
    assert!(ok.text.contains("process:local-qwen"));
    let payload = json_of(&ok);
    assert_eq!(payload["total"], 2);
    assert!(payload.get("since").is_none());

    assert!(call(&mut ws, "audit_changes", json!({ "since": "yesterday" })).is_error);

    let none = call(&mut ws, "audit_changes", json!({ "actor": "process:nonexistent" }));
    assert_eq!(none.text, messages::AUDIT_NO_CHANGES);
}

#[test]
fn an_agent_write_without_generated_frontmatter_is_warned_about() {
    let (_d, _root, mut ws) = audit_bundle();
    let result = call(
        &mut ws,
        "write_file",
        json!({ "path": "wiki/no-provenance.md", "content": "---\ntype: Note\n---\n\nbody\n", "actor": "process:test" }),
    );
    assert!(!result.is_error);
    assert!(result.text.contains(messages::MISSING_PROVENANCE));
}

#[test]
fn a_write_carrying_generated_passes_clean() {
    let (_d, _root, mut ws) = audit_bundle();
    let result = call(
        &mut ws,
        "write_file",
        json!({
            "path": "wiki/with-provenance.md",
            "content": "---\ntype: Note\ngenerated:\n  by: process:test\n  at: 2026-09-10T00:00:00Z\n---\n\nbody\n",
            "actor": "process:test",
        }),
    );
    assert_eq!(result.text, "Wrote wiki/with-provenance.md");
}

#[test]
fn a_non_concept_write_is_not_held_to_concept_provenance() {
    let (_d, _root, mut ws) = audit_bundle();
    let result = call(
        &mut ws,
        "write_file",
        json!({ "path": "wiki/loops/README.md", "content": "# Loops\n", "actor": "process:test" }),
    );
    assert!(!result.text.contains(messages::MISSING_PROVENANCE));
}

#[test]
fn daily_note_rejects_a_rolled_over_calendar_date() {
    let (_d, _root, mut ws) = audit_bundle();
    let result = call(&mut ws, "daily_note", json!({ "date": "2026-02-30" }));
    assert!(result.is_error);
    assert_eq!(result.text, "date must be an ISO date: 2026-02-30");
}

// ---- context-pack.test.ts (MCP) --------------------------------------------------

fn pack_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = root_of("okf-pack-");
    seed(
        &root,
        &[(
            "wiki/search-design.md",
            "---\ntype: Concept\ntitle: 検索設計\ndescription: 日本語検索をバイグラムで実現する設計\n---\n\n# 検索設計\n\n## バイグラム索引\n\n日本語検索はバイグラム索引で実現する。unicode61 では分かち書きできない。",
        )],
    );
    let mut ws = offline();
    ws.open(&root).unwrap();
    (d, root, ws)
}

#[test]
fn context_pack_returns_a_formatted_pack() {
    let (_d, _root, mut ws) = pack_bundle();
    let result = call(&mut ws, "context_pack", json!({ "task": "日本語検索のバイグラム索引", "tier": "worker" }));
    assert!(!result.is_error);
    assert!(result.text.contains("tier: worker"));
    assert!(result.text.contains("wiki/search-design.md"));
}

#[test]
fn context_pack_rejects_an_unknown_tier_and_requires_a_task() {
    let (_d, _root, mut ws) = pack_bundle();
    let bad_tier = call(&mut ws, "context_pack", json!({ "task": "検索", "tier": "manager" }));
    assert!(bad_tier.is_error);
    assert_eq!(bad_tier.text, "tier must be 'worker' or 'supervisor': manager");
    assert!(call(&mut ws, "context_pack", json!({ "task": "  " })).is_error);
}

// ---- tasks and orientation files -------------------------------------------------

#[test]
fn tasks_round_trip_through_the_tools() {
    let (_d, _root, mut ws) = scaffolded();
    let added = call(&mut ws, "add_task", json!({ "title": " やる ", "para": "project", "due": "2026-12-31", "note": "一行" }));
    assert_eq!(added.text, "追加しました: T-0001 [未着手] やる · project · 期限 2026-12-31 · 一行");

    assert!(call(&mut ws, "add_task", json!({ "title": "" })).is_error);
    assert_eq!(
        call(&mut ws, "add_task", json!({ "title": "x", "status": "weird" })).text,
        "status must be one of: doing, todo, done"
    );
    assert_eq!(call(&mut ws, "add_task", json!({ "title": "x", "para": "nope" })).text, "unknown PARA class: nope");

    let done = call(&mut ws, "update_task", json!({ "id": "T-0001", "status": "done" }));
    assert!(done.text.starts_with("更新しました: T-0001 [完了] やる"));
    assert!(done.text.contains("完了 "));
    assert_eq!(call(&mut ws, "update_task", json!({ "id": "T-9999" })).text, "no such task: T-9999");
    assert_eq!(call(&mut ws, "list_tasks", json!({})).text, "未完了のタスクはありません。");
    assert_eq!(call(&mut ws, "list_tasks", json!({ "status": "doing" })).text, "doing のタスクはありません。");
    assert_eq!(call(&mut ws, "list_tasks", json!({ "status": "bogus" })).text, "status must be one of: doing, todo, done");
}

#[test]
fn read_human_creates_the_file_and_write_human_replaces_it() {
    let (_d, root, mut ws) = scaffolded();
    let _ = fs::remove_file(Path::new(&root).join("human.md"));
    let created = call(&mut ws, "read_human", json!({}));
    assert!(exists(&root, "human.md"));
    assert!(!created.text.is_empty());

    assert_eq!(call(&mut ws, "write_human", json!({ "content": "  " })).text, "content is empty");
    assert_eq!(call(&mut ws, "write_human", json!({ "content": "# 私\n" })).text, "human.md を更新しました。");
    assert_eq!(call(&mut ws, "read_human", json!({})).text, "# 私\n");
}

#[test]
fn open_bundle_switches_bundles_and_reports_failures() {
    let (_d, _root, mut ws) = mcp_bundle();
    let (_d2, other) = root_of("okf-other-");
    seed(&other, &[("wiki/b.md", "---\ntype: Concept\n---\n\nb\n")]);

    let info = json_of(&call(&mut ws, "open_bundle", json!({ "path": other })));
    assert_eq!(info["conceptCount"], 1);
    assert_eq!(info["wikiDir"], "wiki");

    assert_eq!(call(&mut ws, "open_bundle", json!({})).text, "'path' is required");
    let missing = call(&mut ws, "open_bundle", json!({ "path": format!("{other}/nope") }));
    assert!(missing.is_error);
    assert!(missing.text.starts_with("フォルダではありません"));
}
