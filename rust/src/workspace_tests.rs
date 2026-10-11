//! Workspace behaviour over real temporary bundles, ported from
//! `workspace.test.ts`, `fileops.test.ts`, `layers.test.ts`, `para.test.ts`,
//! `daily.test.ts`, `skillspace.test.ts`, `loops.test.ts`, `audit.test.ts`,
//! `context-pack.test.ts` and `reserved-files.test.ts`.
//!
//! The MCP-surface halves of those files live in `mcp/tools_tests.rs`.

use super::*;
use crate::okf::bundle::{ImportOptions, PromoteOptions, WriteOptions};
use crate::okf::loops::{DefineOptions, StartOptions};
use crate::okf::migrate::migrate_layout;
use crate::okf::paths::{Actor, BundlePaths};
use crate::rag::context_pack::{format_context_pack, TIER_DEFAULTS_SUPERVISOR, TIER_DEFAULTS_WORKER};
use crate::shared::okf::daily::{daily_id, DAILY_TASK_HEADING};
use crate::shared::okf::loop_::{DETAILED_RUNS, SUMMARY_RUNS};
use crate::shared::okf::para::PARA_ORDER;
use crate::shared::types::{Layer, NodeType};
use chrono::TimeZone;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

// ---- helpers ---------------------------------------------------------------------

fn bundle_dir(prefix: &str) -> (TempDir, String) {
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

fn concept(ty: &str, body: &str) -> String {
    format!("---\ntype: {ty}\n---\n\n{body}")
}

fn note(root: &str, rel: &str, body: &str) {
    seed(root, &[(&format!("wiki/{rel}"), &format!("---\ntype: Concept\n---\n\n{body}\n"))]);
}

fn offline() -> Workspace {
    Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() })
}

fn open_at(root: &str) -> Workspace {
    let mut ws = offline();
    ws.open(root).unwrap();
    ws
}

fn read(root: &str, rel: &str) -> String {
    fs::read_to_string(Path::new(root).join(rel)).unwrap()
}

fn exists(root: &str, rel: &str) -> bool {
    Path::new(root).join(rel).exists()
}

fn as_actor(actor: &str) -> WriteOptions {
    WriteOptions { actor: Some(actor.into()), ..Default::default() }
}

fn by_agent() -> WriteOptions {
    WriteOptions { by: Some(Actor::Agent), ..Default::default() }
}

fn message<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e.to_string(),
    }
}

fn ids(hits: &[crate::shared::types::SearchHit]) -> Vec<&str> {
    hits.iter().map(|h| h.id.as_str()).collect()
}

fn search(ws: &Workspace, query: &str) -> Vec<crate::shared::types::SearchHit> {
    ws.search(query, &SearchOptions::default()).unwrap()
}

// ---- workspace.test.ts -----------------------------------------------------------

#[test]
fn creates_the_reserved_files_on_open() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("wiki/a.md", &concept("Concept", ""))]);
    let ws = open_at(&root);
    let info = ws.info().unwrap();
    assert!(info.has_index);
    assert!(info.has_log);
}

#[test]
fn writes_a_concept_indexes_it_and_logs_it() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("wiki/a.md", &concept("Concept", "alpha"))]);
    let mut ws = open_at(&root);

    ws.write_file("wiki/b.md", &concept("Concept", "bravo unique-token"), &as_actor("process:test"))
        .unwrap();

    assert_eq!(ids(&search(&ws, "unique-token")), vec!["b"]);
    let log = read(&root, "wiki/log.md");
    assert!(log.contains("process:test"));
    assert!(log.contains("wiki/b.md"));
}

#[test]
fn reports_okf_warnings_instead_of_refusing_the_write() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("wiki/a.md", &concept("Concept", ""))]);
    let mut ws = open_at(&root);

    let result = ws.write_file("wiki/bad.md", "# no frontmatter\n", &WriteOptions::default()).unwrap();
    assert!(result.ok);
    assert_eq!(result.warnings[0], messages::MISSING_FRONTMATTER);
}

#[test]
fn raw_is_the_humans_inbox_closed_to_agents() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("wiki/a.md", &concept("Concept", "")), ("raw/keep.md", "original")]);
    let mut ws = open_at(&root);

    // A person may put originals in; an agent may not.
    ws.write_file("raw/new.md", "dropped in", &as_actor("human:local")).unwrap();
    assert_eq!(read(&root, "raw/new.md"), "dropped in");

    let err = message(ws.write_file("raw/keep.md", "overwritten", &by_agent()));
    assert!(err.contains("人間"), "{err}");
    assert_eq!(read(&root, "raw/keep.md"), "original");

    // The derived layer is open to both: it is rebuildable.
    ws.write_file(".rag/scratch.md", "x", &by_agent()).unwrap();
}

#[test]
fn refuses_to_escape_the_bundle() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("wiki/a.md", &concept("Concept", ""))]);
    let mut ws = open_at(&root);
    assert!(message(ws.write_file("../escaped.md", "x", &WriteOptions::default())).contains("バンドルの外"));
    assert!(message(ws.read_file("../../etc/passwd")).contains("バンドルの外"));
}

#[test]
fn read_returns_parsed_frontmatter_and_backlinks() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(
        &root,
        &[
            ("wiki/a.md", &concept("Playbook", "see [[b]]")),
            ("wiki/b.md", &concept("Concept", "target")),
        ],
    );
    let mut ws = open_at(&root);

    let result = ws.read_file("wiki/b.md").unwrap();
    assert_eq!(result.concept.unwrap().frontmatter.r#type, "Concept");
    assert_eq!(result.backlinks, vec!["a"]);
}

#[test]
fn rebuild_index_lists_every_concept() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(
        &root,
        &[
            ("wiki/a.md", "---\ntype: Concept\ntitle: Alpha\ndescription: first | piped\n---\n"),
            ("wiki/topics/b.md", &concept("Note", "")),
        ],
    );
    let mut ws = open_at(&root);

    assert_eq!(ws.rebuild_index().unwrap(), 2);

    let index = read(&root, "wiki/index.md");
    // OKF section 8: sectioned bullet entries, bundle-absolute links, and the
    // one permitted frontmatter key on a root index.
    assert!(index.contains("okf_version: 0.2"));
    assert!(index.contains("## Concepts"));
    assert!(index.contains("* [Alpha](/a.md) - first | piped"));
    assert!(index.contains("## topics"));
    assert!(index.contains("](/topics/b.md)"));
    assert!(!index.contains("|----"));
}

#[test]
fn rebuild_rag_drops_rows_for_deleted_concepts() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(
        &root,
        &[("wiki/a.md", &concept("Concept", "findme")), ("wiki/b.md", &concept("Concept", ""))],
    );
    let mut ws = open_at(&root);
    assert_eq!(search(&ws, "findme").len(), 1);

    fs::remove_file(Path::new(&root).join("wiki/a.md")).unwrap();
    assert_eq!(ws.rebuild_rag().unwrap(), 1);
    assert_eq!(search(&ws, "findme").len(), 0);
}

#[test]
fn search_survives_punctuation_that_is_fts5_syntax() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("wiki/a.md", &concept("Concept", "hello world"))]);
    let ws = open_at(&root);
    for query in ["\"", "a OR", "NEAR(", "-x", "*", "a:b"] {
        assert!(ws.search(query, &SearchOptions::default()).is_ok(), "{query}");
    }
}

#[test]
fn open_is_idempotent_and_does_not_leak_the_previous_index() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("wiki/a.md", &concept("Concept", "alpha"))]);
    let mut ws = open_at(&root);
    ws.open(&root).unwrap();
    assert_eq!(search(&ws, "alpha").len(), 1);
}

#[test]
fn nothing_works_without_a_bundle() {
    let ws = offline();
    assert!(!ws.is_open());
    assert!(ws.info().is_none());
    assert_eq!(message(ws.search("x", &SearchOptions::default())), messages::NO_BUNDLE_OPEN);
    assert_eq!(message(ws.list_concepts()), messages::NO_BUNDLE_OPEN);
}

#[test]
fn closing_forgets_the_bundle() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("wiki/a.md", &concept("Concept", "alpha"))]);
    let mut ws = open_at(&root);
    ws.close();
    assert!(!ws.is_open());
    assert_eq!(message(ws.tags()), messages::NO_BUNDLE_OPEN);
}

#[test]
fn scaffold_creates_the_three_layer_layout() {
    let (_d, root) = bundle_dir("okf-ws-");
    let result = offline().scaffold(&root).unwrap();
    // The contract lives inside the wiki layer, not beside it.
    for expected in ["wiki/AGENTS.md", "wiki/index.md", "wiki/log.md"] {
        assert!(result.created.iter().any(|c| c == expected), "{expected}");
    }
    let info = open_at(&root).info().unwrap();
    assert_eq!(info.wiki_dir, "wiki");
    assert!(info.has_agents_md);
    assert!(info.has_raw);
}

#[test]
fn scaffold_never_overwrites_existing_content() {
    let (_d, root) = bundle_dir("okf-ws-");
    seed(&root, &[("AGENTS.md", "MY RULES")]);
    let result = offline().scaffold(&root).unwrap();
    assert!(!result.created.iter().any(|c| c == "AGENTS.md"));
    assert_eq!(read(&root, "AGENTS.md"), "MY RULES");
}

#[test]
fn scaffold_produces_a_conformant_hello_concept() {
    let (_d, root) = bundle_dir("okf-ws-");
    offline().scaffold(&root).unwrap();
    assert_eq!(open_at(&root).conformance_issues().unwrap(), vec![]);
}

// ---- fileops.test.ts -------------------------------------------------------------

fn fileops_bundle() -> (TempDir, String) {
    let (d, root) = bundle_dir("okf-fileops-");
    fs::create_dir_all(Path::new(&root).join("wiki")).unwrap();
    fs::create_dir_all(Path::new(&root).join("raw")).unwrap();
    (d, root)
}

#[test]
fn rename_updates_inbound_wikilinks() {
    let (_d, root) = fileops_bundle();
    note(&root, "target.md", "I am the target.");
    note(&root, "source.md", "See [[target]] for details.");
    let mut ws = open_at(&root);

    let result = ws.move_file("wiki/target.md", "wiki/renamed.md", "human:local", Actor::Human).unwrap();

    assert_eq!(result.link_count, 1);
    assert_eq!(result.updated, vec!["wiki/source.md"]);
    assert!(read(&root, "wiki/source.md").contains("[[renamed|target]]"));
}

#[test]
fn rename_updates_inbound_relative_markdown_links() {
    let (_d, root) = fileops_bundle();
    note(&root, "target.md", "I am the target.");
    note(&root, "deep/source.md", "See [T](../target.md).");
    let mut ws = open_at(&root);

    ws.move_file("wiki/target.md", "wiki/renamed.md", "human:local", Actor::Human).unwrap();
    assert!(read(&root, "wiki/deep/source.md").contains("(../renamed.md)"));
}

#[test]
fn moving_into_a_subdirectory_rebases_the_documents_own_links() {
    let (_d, root) = fileops_bundle();
    note(&root, "a.md", "See [B](./b.md).");
    note(&root, "b.md", "I am B.");
    let mut ws = open_at(&root);

    ws.move_file("wiki/a.md", "wiki/deep/a.md", "human:local", Actor::Human).unwrap();

    // `a` moved down a level, so its link to `b` must climb back up.
    assert!(read(&root, "wiki/deep/a.md").contains("(../b.md)"));
}

#[test]
fn links_inside_code_blocks_are_left_alone() {
    let (_d, root) = fileops_bundle();
    note(&root, "target.md", "target");
    note(&root, "source.md", "```\n[[target]]\n```\n\nreal [[target]]");
    let mut ws = open_at(&root);

    ws.move_file("wiki/target.md", "wiki/renamed.md", "human:local", Actor::Human).unwrap();

    let source = read(&root, "wiki/source.md");
    assert!(source.contains("```\n[[target]]\n```"));
    assert!(source.contains("[[renamed|target]]"));
}

#[test]
fn the_index_follows_the_move() {
    let (_d, root) = fileops_bundle();
    note(&root, "target.md", "unique-token-here");
    let mut ws = open_at(&root);
    ws.move_file("wiki/target.md", "wiki/renamed.md", "human:local", Actor::Human).unwrap();

    assert_eq!(ids(&search(&ws, "unique-token-here")), vec!["renamed"]);
}

#[test]
fn backlinks_are_rebuilt_around_the_new_id() {
    let (_d, root) = fileops_bundle();
    note(&root, "target.md", "target");
    note(&root, "source.md", "[[target]]");
    let mut ws = open_at(&root);

    ws.move_file("wiki/target.md", "wiki/renamed.md", "human:local", Actor::Human).unwrap();

    let bundle = ws.require_bundle().unwrap();
    assert_eq!(bundle.backlinks_of("renamed"), vec!["source"]);
    assert!(bundle.backlinks_of("target").is_empty());
}

#[test]
fn the_move_is_recorded_in_log_md() {
    let (_d, root) = fileops_bundle();
    note(&root, "target.md", "t");
    let mut ws = open_at(&root);
    ws.move_file("wiki/target.md", "wiki/renamed.md", "process:test", Actor::Human).unwrap();

    let log = read(&root, "wiki/log.md");
    // OKF section 9: date-grouped prose entries with a conventional leading word.
    assert!(log.lines().any(|l| l.len() == 13 && l.starts_with("## ")));
    assert!(log.contains("**Move**"));
    assert!(log.contains("process:test"));
}

#[test]
fn move_refuses_to_overwrite_an_existing_file() {
    let (_d, root) = fileops_bundle();
    note(&root, "a.md", "a");
    note(&root, "b.md", "b");
    let mut ws = open_at(&root);

    let err = message(ws.move_file("wiki/a.md", "wiki/b.md", "human:local", Actor::Human));
    assert!(err.contains("既に存在します"), "{err}");
    assert!(read(&root, "wiki/b.md").contains('b'));
}

#[test]
fn move_refuses_an_agent_moving_a_file_into_raw() {
    let (_d, root) = fileops_bundle();
    note(&root, "a.md", "a");
    let mut ws = open_at(&root);
    // A person may file something back into their own inbox; an agent may not.
    let err = message(ws.move_file("wiki/a.md", "raw/a.md", "process:test", Actor::Agent));
    assert!(err.contains("人間"), "{err}");
}

#[test]
fn move_refuses_to_leave_the_bundle_and_reports_a_missing_source() {
    let (_d, root) = fileops_bundle();
    note(&root, "a.md", "a");
    let mut ws = open_at(&root);
    assert!(message(ws.move_file("wiki/a.md", "../escaped.md", "human:local", Actor::Human)).contains("バンドルの外"));
    assert!(message(ws.move_file("wiki/nope.md", "wiki/x.md", "human:local", Actor::Human)).contains("見つかりません"));
}

#[test]
fn delete_removes_the_file_and_reindexes() {
    let (_d, root) = fileops_bundle();
    note(&root, "doomed.md", "unique-doomed-token");
    let mut ws = open_at(&root);

    let result = ws.delete("wiki/doomed.md", "human:local", Actor::Human).unwrap();

    assert_eq!(result.deleted, "wiki/doomed.md");
    assert_eq!(search(&ws, "unique-doomed-token").len(), 0);
    assert!(ws.require_bundle().unwrap().get_concept("doomed").is_none());
}

#[test]
fn delete_reports_which_concepts_are_left_with_broken_links() {
    let (_d, root) = fileops_bundle();
    note(&root, "doomed.md", "doomed");
    note(&root, "source.md", "[[doomed]]");
    let mut ws = open_at(&root);

    let result = ws.delete("wiki/doomed.md", "human:local", Actor::Human).unwrap();
    // Rewriting them would destroy the record that something used to be there.
    assert_eq!(result.broken_links_from, vec!["source"]);
    assert!(read(&root, "wiki/source.md").contains("[[doomed]]"));
}

#[test]
fn delete_refuses_reserved_files() {
    let (_d, root) = fileops_bundle();
    note(&root, "a.md", "a");
    let mut ws = open_at(&root);
    for reserved in ["wiki/index.md", "wiki/log.md"] {
        assert!(message(ws.delete(reserved, "human:local", Actor::Human)).contains("予約ファイル"));
    }
}

#[test]
fn delete_refuses_the_immutable_layer() {
    let (_d, root) = fileops_bundle();
    seed(&root, &[("raw/source.txt", "original")]);
    note(&root, "a.md", "a");
    let mut ws = open_at(&root);

    let err = message(ws.delete("raw/source.txt", "process:test", Actor::Agent));
    assert!(err.contains("人間"), "{err}");
    assert_eq!(read(&root, "raw/source.txt"), "original");
}

#[test]
fn creates_a_directory_and_refuses_one_in_raw_for_an_agent() {
    let (_d, root) = fileops_bundle();
    note(&root, "a.md", "a");
    let ws = open_at(&root);
    ws.create_directory("wiki/topics", Actor::Human).unwrap();

    let nodes = ws.list_dir("wiki", false).unwrap();
    assert!(nodes.iter().any(|n| n.name == "topics" && n.r#type == NodeType::Dir));

    assert!(message(ws.create_directory("raw/nope", Actor::Agent)).contains("人間"));
}

#[test]
fn unresolved_links_are_reported_and_resolved_ones_are_not() {
    let (_d, root) = fileops_bundle();
    note(&root, "a.md", "See [[nowhere]] and [[also-missing]].");
    let ws = open_at(&root);

    let gaps = ws.unresolved_links().unwrap();
    let mut targets: Vec<&str> = gaps.iter().map(|g| g.target.as_str()).collect();
    targets.sort();
    assert_eq!(targets, vec!["also-missing", "nowhere"]);
    assert!(gaps.iter().all(|g| g.from == "a"));

    let (_d2, root2) = fileops_bundle();
    note(&root2, "a.md", "See [[b]].");
    note(&root2, "b.md", "b");
    assert!(open_at(&root2).unresolved_links().unwrap().is_empty());
}

#[test]
fn lists_ids_titles_and_types_for_the_quick_switcher() {
    let (_d, root) = fileops_bundle();
    seed(&root, &[("wiki/titled.md", "---\ntype: Playbook\ntitle: My Title\n---\n\nbody\n")]);
    note(&root, "untitled.md", "body");
    let ws = open_at(&root);

    let json = serde_json::to_value(ws.list_concepts().unwrap()).unwrap();
    assert_eq!(
        json,
        serde_json::json!([
            { "id": "titled", "path": "wiki/titled.md", "title": "My Title", "type": "Playbook" },
            { "id": "untitled", "path": "wiki/untitled.md", "title": "untitled", "type": "Concept" },
        ])
    );
}

// ---- layers.test.ts --------------------------------------------------------------

fn scaffolded() -> (TempDir, String, Workspace) {
    let (d, root) = bundle_dir("okf-layers-");
    let mut ws = offline();
    ws.scaffold(&root).unwrap();
    ws.open(&root).unwrap();
    (d, root, ws)
}

#[test]
fn the_bundle_root_holds_exactly_the_three_layers_plus_the_orientation_files() {
    let (_d, root, _ws) = scaffolded();
    let mut entries: Vec<String> = fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();

    let mut dirs: Vec<&String> = entries.iter().filter(|e| !e.ends_with(".md")).collect();
    dirs.sort();
    assert_eq!(dirs, vec![".rag", "raw", "wiki"]);
    let mut files: Vec<&String> = entries.iter().filter(|e| e.ends_with(".md")).collect();
    files.sort();
    assert_eq!(files, vec!["MAP.md", "SYSTEMMAP.md", "Task.md", "human.md"]);
}

#[test]
fn agents_md_skills_and_loops_live_inside_wiki() {
    let (_d, root, _ws) = scaffolded();
    for inside in ["wiki/AGENTS.md", "wiki/skills", "wiki/loops"] {
        assert!(exists(&root, inside), "{inside}");
    }
    assert!(!exists(&root, "AGENTS.md"));
    assert!(!exists(&root, "skills"));
}

#[test]
fn map_human_and_task_sit_outside_the_layers() {
    let (_d, root, _ws) = scaffolded();
    for name in ["MAP.md", "human.md", "Task.md"] {
        assert!(exists(&root, name), "{name}");
        assert!(!exists(&root, &format!("wiki/{name}")), "{name}");
    }
}

#[test]
fn everything_under_wiki_reports_the_wiki_layer() {
    let (_d, _root, ws) = scaffolded();
    let paths = &ws.require_bundle().unwrap().paths;
    for wiki in [
        "wiki/index.md",
        "wiki/AGENTS.md",
        "wiki/skills/okf-ingest/SKILL.md",
        "wiki/loops/weekly-lint.md",
    ] {
        assert_eq!(paths.layer_of(wiki), Some(Layer::Wiki), "{wiki}");
    }
    assert_eq!(paths.layer_of("raw/note.md"), Some(Layer::Raw));
    assert_eq!(paths.layer_of(".rag/fts.sqlite"), Some(Layer::Rag));
}

#[test]
fn skills_loops_and_the_contract_are_not_indexed_as_knowledge() {
    let (_d, _root, ws) = scaffolded();
    let bundle = ws.require_bundle().unwrap();
    let ids: Vec<&str> = bundle.all_concepts().iter().map(|c| c.id.as_str()).collect();
    assert!(!ids.iter().any(|id| id.contains("skills/")));
    assert!(!ids.iter().any(|id| id.contains("loops/")));
    assert!(!ids.iter().any(|id| id.to_lowercase().contains("agents")));
    // And the contract is prose for agents, so it is not conformance-checked.
    assert_eq!(ws.conformance_issues().unwrap(), vec![]);
}

fn old_layout() -> (TempDir, String) {
    let (d, dir) = bundle_dir("okf-old-");
    seed(
        &dir,
        &[
            ("AGENTS.md", "# 旧レイアウトの規約\n"),
            (
                "skills/my-skill/SKILL.md",
                "---\nname: my-skill\ndescription: 移行テスト用\n---\n\n# 手順\n",
            ),
            ("loops/my-loop.md", "---\nloop: my-loop\ngoal: 移行\n---\n"),
            ("wiki/note.md", "---\ntype: Concept\n---\n\n# ノート\n"),
        ],
    );
    fs::create_dir_all(Path::new(&dir).join("raw")).unwrap();
    (d, dir)
}

#[test]
fn lifts_map_human_and_task_out_of_wiki_on_open_content_intact() {
    let (_d, dir) = bundle_dir("okf-orient-");
    let tasks = "# タスク\n\n## 進行中\n\n- [ ] T-0007 移行しても消えないこと\n";
    seed(
        &dir,
        &[
            ("wiki/MAP.md", "# MAP\n\n<!-- okf:user-rules -->\n自作の規則\n"),
            ("wiki/human.md", "# 利用者\n\n- 呼び方: テスト\n"),
            ("wiki/Task.md", tasks),
        ],
    );
    fs::create_dir_all(Path::new(&dir).join("raw")).unwrap();

    let ws = open_at(&dir);
    for name in ["MAP.md", "human.md", "Task.md"] {
        assert!(exists(&dir, name), "{name}");
        assert!(!exists(&dir, &format!("wiki/{name}")), "{name}");
    }
    assert!(read(&dir, "Task.md").contains("T-0007 移行しても消えないこと"));
    assert!(read(&dir, "human.md").contains("呼び方: テスト"));
    // MAP is regenerated on read, but the user's own half must survive that.
    assert!(ws.read_map().unwrap().contains("自作の規則"));
}

#[test]
fn moves_the_three_into_wiki_on_open() {
    let (_d, dir) = old_layout();
    let mut ws = open_at(&dir);

    assert!(exists(&dir, "wiki/AGENTS.md"));
    assert!(exists(&dir, "wiki/skills/my-skill/SKILL.md"));
    assert!(exists(&dir, "wiki/loops/my-loop.md"));
    assert!(!exists(&dir, "AGENTS.md"));
    assert!(!exists(&dir, "skills"));
    assert!(!exists(&dir, "loops"));

    assert!(read(&dir, "wiki/AGENTS.md").contains("旧レイアウト"));
    let names: Vec<String> =
        ws.require_skills_mut().unwrap().summaries().into_iter().map(|s| s.name).collect();
    assert!(names.contains(&"my-skill".to_string()));
}

#[test]
fn migration_is_idempotent() {
    let (_d, dir) = old_layout();
    let mut first = open_at(&dir);
    first.close();

    let second = open_at(&dir);
    assert!(second.require_bundle().unwrap().migration.moved.is_empty());
    assert!(exists(&dir, "wiki/skills/my-skill/SKILL.md"));
}

#[test]
fn migration_never_overwrites_a_file_at_the_destination() {
    let (_d, dir) = old_layout();
    seed(&dir, &[("wiki/skills/my-skill/SKILL.md", "新しいほう\n")]);

    let result = migrate_layout(&BundlePaths::new(&dir, "wiki")).unwrap();

    // The newer file wins and the older one is reported, not silently dropped.
    assert!(read(&dir, "wiki/skills/my-skill/SKILL.md").contains("新しいほう"));
    assert!(result.skipped.join(",").contains("my-skill"));
    assert!(exists(&dir, "skills/my-skill/SKILL.md"));
}

#[test]
fn a_folder_opened_directly_as_the_wiki_layer_is_left_alone() {
    let (_d, dir) = bundle_dir("okf-flat-");
    seed(&dir, &[("skills/.keep", ""), ("AGENTS.md", "# flat\n")]);

    let result = migrate_layout(&BundlePaths::new(&dir, "")).unwrap();

    assert!(result.moved.is_empty());
    assert!(exists(&dir, "AGENTS.md"));
}

fn with_raw_source() -> (TempDir, String, Workspace) {
    let (d, root, ws) = scaffolded();
    seed(&root, &[("raw/source.md", "# 生データ\n\n議事録の本文。\n")]);
    (d, root, ws)
}

#[test]
fn a_human_can_promote_from_raw_and_the_original_is_kept() {
    let (_d, root, mut ws) = with_raw_source();
    let result = ws.promote("raw/source.md", "wiki/summary.md", &PromoteOptions::default()).unwrap();

    assert_eq!(result.promoted, "wiki/summary.md");
    assert!(read(&root, "wiki/summary.md").contains("議事録の本文"));
    // raw/ is the record of what was actually received.
    assert!(exists(&root, "raw/source.md"));
}

#[test]
fn keep_source_false_performs_a_true_move() {
    let (_d, root, mut ws) = with_raw_source();
    let result = ws
        .promote(
            "raw/source.md",
            "wiki/summary.md",
            &PromoteOptions { keep_source: Some(false), ..Default::default() },
        )
        .unwrap();

    assert!(!result.kept);
    assert!(!exists(&root, "raw/source.md"));
    assert!(exists(&root, "wiki/summary.md"));
}

#[test]
fn promotion_never_overwrites_an_existing_page() {
    let (_d, root, mut ws) = with_raw_source();
    ws.write_file("wiki/summary.md", "---\ntype: Concept\n---\n\n# 先客\n", &as_actor("test")).unwrap();

    let result = ws.promote("raw/source.md", "wiki/summary.md", &PromoteOptions::default()).unwrap();

    assert_ne!(result.promoted, "wiki/summary.md");
    assert!(read(&root, "wiki/summary.md").contains("先客"));
}

#[test]
fn a_human_may_put_things_into_raw_and_move_a_file_there() {
    let (_d, root, mut ws) = with_raw_source();
    ws.write_file("raw/notes.md", "# 手で置いた原本\n", &as_actor("human:local")).unwrap();
    assert!(read(&root, "raw/notes.md").contains("手で置いた"));

    ws.write_file("wiki/a.md", "---\ntype: Concept\n---\n\n# A\n", &as_actor("test")).unwrap();
    ws.move_file("wiki/a.md", "raw/a.md", "human:local", Actor::Human).unwrap();
    assert!(exists(&root, "raw/a.md"));
}

#[test]
fn both_sides_may_work_in_the_derived_layer() {
    let (_d, root, mut ws) = with_raw_source();
    ws.write_file(".rag/human-note.md", "human\n", &as_actor("human:local")).unwrap();
    assert!(exists(&root, ".rag/human-note.md"));
    ws.write_file(".rag/agent-note.md", "agent", &by_agent()).unwrap();
    assert!(exists(&root, ".rag/agent-note.md"));
}

#[test]
fn an_import_from_notion_or_drive_still_lands_in_raw() {
    let (_d, root, ws) = with_raw_source();
    let result = ws
        .require_bundle()
        .unwrap()
        .import_to_raw(
            "raw/notion/2026-08-03-page.md",
            "# Notion から\n",
            &ImportOptions { actor: Some("human:local".into()), note: None },
        )
        .unwrap();

    assert!(result.path.starts_with("raw/"));
    assert!(read(&root, &result.path).contains("Notion から"));
}

#[test]
fn promotion_is_logged_and_the_page_is_searchable_immediately() {
    let (_d, root, mut ws) = with_raw_source();
    ws.promote("raw/source.md", "wiki/summary.md", &PromoteOptions::default()).unwrap();

    let log = read(&root, "wiki/log.md");
    assert!(log.contains("wiki/summary.md"));
    assert!(log.contains("raw/source.md"));
    // The index reflects the new page without a manual rebuild.
    assert!(!search(&ws, "議事録").is_empty());
}

#[test]
fn promotion_refuses_a_source_outside_raw_with_the_real_reason() {
    let (_d, _root, mut ws) = with_raw_source();
    ws.write_file("wiki/one.md", "---\ntype: Note\n---\n\nA\n", &as_actor("t")).unwrap();
    let err = message(ws.promote("wiki/one.md", "wiki/copy.md", &PromoteOptions::default()));
    assert!(err.contains("raw/ の中のファイル"), "{err}");
}

#[test]
fn skills_are_writable_and_subsystem_paths_are_flagged() {
    let (_d, _root, ws) = scaffolded();
    let paths = &ws.require_bundle().unwrap().paths;
    assert!(paths.assert_writable("skills/x/SKILL.md", Actor::Human).is_ok());
    assert!(paths.assert_writable("wiki/loops/x.md", Actor::Agent).is_ok());
    assert!(paths.is_subsystem_path("wiki/skills/okf-ingest/SKILL.md"));
    assert!(paths.is_subsystem_path("wiki/loops/weekly-lint.md"));
    assert!(!paths.is_subsystem_path("wiki/index.md"));
}

// ---- para.test.ts ----------------------------------------------------------------

fn para_note(root: &str, rel: &str, title: &str, body: &str) {
    seed(
        root,
        &[(
            &format!("wiki/{rel}"),
            &format!("---\ntype: Concept\ntitle: {title}\n---\n\n# {title}\n\n{body}\n"),
        )],
    );
}

fn para_bundle() -> (TempDir, String) {
    let (d, root) = bundle_dir("okf-para-");
    offline().scaffold(&root).unwrap();
    (d, root)
}

#[test]
fn scaffold_creates_the_four_numbered_para_folders() {
    let (_d, root) = para_bundle();
    for class in PARA_ORDER {
        assert!(exists(&root, &format!("wiki/{}", class.dir())));
    }
}

#[test]
fn an_active_project_outranks_the_same_content_in_the_archive() {
    let (_d, root) = para_bundle();
    // The same sentence in four places: only PARA can separate them.
    let text = "レイヤー分離の設計判断について。";
    para_note(&root, "1-projects/active.md", "進行中", text);
    para_note(&root, "2-areas/interest.md", "関心", text);
    para_note(&root, "3-resources/reference.md", "参照", text);
    para_note(&root, "4-archive/stale.md", "旧", text);
    let ws = open_at(&root);

    let hits = search(&ws, "レイヤー分離");
    assert!(hits[0].id.contains("1-projects"));
    assert!(hits[hits.len() - 1].id.contains("4-archive"));
    let classes: Vec<&str> = hits.iter().map(|h| h.para.as_str()).collect();
    assert_eq!(classes, vec!["project", "area", "resource", "archive"]);

    // Ranking it down is not the same as hiding it.
    assert!(search(&ws, "旧").iter().any(|h| h.id.contains("4-archive")));
}

fn refile_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = para_bundle();
    para_note(&root, "1-projects/q3.md", "Q3", "本文");
    para_note(&root, "3-resources/ref.md", "参照", "[[1-projects/q3]] を見る");
    let ws = open_at(&root);
    (d, root, ws)
}

#[test]
fn archiving_moves_the_file_and_rewrites_inbound_links() {
    let (_d, root, mut ws) = refile_bundle();
    let result = ws.set_para("wiki/1-projects/q3.md", ParaClass::Archive, Actor::Human, None).unwrap();

    assert!(result.moved);
    assert!(exists(&root, "wiki/4-archive/q3.md"));
    assert!(!exists(&root, "wiki/1-projects/q3.md"));

    // Archiving must not break the graph.
    let reference = read(&root, "wiki/3-resources/ref.md");
    assert!(reference.contains("4-archive/q3"));
    assert!(!reference.contains("[[1-projects/q3]]"));
}

#[test]
fn refiling_to_the_class_it_already_has_is_a_no_op() {
    let (_d, root, mut ws) = refile_bundle();
    let result = ws.set_para("wiki/1-projects/q3.md", ParaClass::Project, Actor::Human, None).unwrap();
    assert!(!result.moved);
    assert!(exists(&root, "wiki/1-projects/q3.md"));
}

#[test]
fn an_unfiled_note_gains_a_prefix_rather_than_being_flattened() {
    let (_d, root, mut ws) = refile_bundle();
    para_note(&root, "topics/deep/loose.md", "散在", "本文");
    ws.reload_bundle().unwrap();

    ws.set_para("wiki/topics/deep/loose.md", ParaClass::Area, Actor::Human, None).unwrap();

    assert!(exists(&root, "wiki/2-areas/topics/deep/loose.md"));
}

#[test]
fn an_agent_refile_is_tagged_with_a_process_actor() {
    let (_d, root, mut ws) = refile_bundle();
    ws.set_para("wiki/1-projects/q3.md", ParaClass::Archive, Actor::Agent, None).unwrap();
    assert!(read(&root, "wiki/log.md").contains("process:mcp"));
}

#[test]
fn skills_are_grouped_by_category_folder() {
    let (_d, _root) = para_bundle();
    let mut ws = open_at(&_root);
    let skills = ws.require_skills_mut().unwrap();
    let summaries = skills.summaries();
    let category = |name: &str| summaries.iter().find(|s| s.name == name).map(|s| s.category.clone());

    assert_eq!(category("okf-ingest").as_deref(), Some("ingest"));
    assert_eq!(category("wiki-answer").as_deref(), Some("query"));
    assert_eq!(category("wiki-lint").as_deref(), Some("quality"));
    assert_eq!(skills.categories(), vec!["ingest", "quality", "query"]);

    // Addressed by name alone, whatever the category.
    let opened = skills.open("okf-ingest").unwrap();
    assert_eq!(opened.document.name, "okf-ingest");
    assert_eq!(opened.document.category, "ingest");
}

#[test]
fn an_uncategorised_skill_still_works() {
    let (_d, root) = para_bundle();
    seed(
        &root,
        &[(
            "wiki/skills/loose-skill/SKILL.md",
            "---\nname: loose-skill\ndescription: カテゴリなしの手順\n---\n\n# 手順\n",
        )],
    );
    let mut ws = open_at(&root);
    let summaries = ws.require_skills_mut().unwrap().summaries();
    assert_eq!(summaries.iter().find(|s| s.name == "loose-skill").unwrap().category, "");
}

#[test]
fn an_archived_skill_is_never_suggested_but_can_still_be_opened() {
    let (_d, root) = para_bundle();
    seed(
        &root,
        &[(
            "wiki/skills/ingest/old-way/SKILL.md",
            "---\nname: old-way\ndescription: 議事録を取り込む古いやり方。\nwhen: [取り込み, 議事録]\npara: archive\n---\n\n# 旧手順",
        )],
    );
    let mut ws = open_at(&root);
    let skills = ws.require_skills_mut().unwrap();

    let found = skills.find("議事録を取り込みたい", None);
    assert!(!found.ranked.iter().any(|r| r.name == "old-way"));
    // Archiving is a decision to stop using it, not to delete it.
    assert_eq!(skills.open("old-way").unwrap().document.para, ParaClass::Archive);
}

// ---- daily.test.ts ---------------------------------------------------------------

#[test]
fn opening_today_creates_it_once_then_reuses_it() {
    let (_d, _root, mut ws) = scaffolded();
    let (path, created) = ws.open_daily(None).unwrap();
    assert!(created);
    let (second_path, second_created) = ws.open_daily(None).unwrap();
    assert!(!second_created);
    assert_eq!(second_path, path);
}

#[test]
fn a_daily_note_is_a_conformant_concept_so_it_is_searchable() {
    let (_d, _root, mut ws) = scaffolded();
    let (path, _) = ws.open_daily(None).unwrap();
    assert!(!ws.conformance_issues().unwrap().iter().any(|i| i.path == path));
}

#[test]
fn task_lines_move_into_task_md_and_are_not_moved_twice() {
    let (_d, root, mut ws) = scaffolded();
    let (path, _) = ws.open_daily(None).unwrap();
    let original = ws.read_file(&path).unwrap().content;

    ws.write_file(
        &path,
        &original.replacen("- [ ] ", "- [ ] 議事録を取り込む\n- [ ] 図を描き直す", 1),
        &WriteOptions {
            actor: Some("human:local".into()),
            action: Some("update".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let created = ws.collect_daily_tasks(None).unwrap();
    let titles: Vec<&str> = created.iter().map(|t| t.title.as_str()).collect();
    assert_eq!(titles, vec!["議事録を取り込む", "図を描き直す"]);

    // Each carries where it came from, so the task is traceable to the day.
    assert!(created[0].note.as_deref().unwrap().contains(&daily_id(&Local::now())));

    // The note now shows them ticked with their ids.
    assert!(read(&root, &path).contains(&format!("→ {}", created[0].id)));

    // Running again adds nothing: this is called on every daily-note read.
    assert!(ws.collect_daily_tasks(None).unwrap().is_empty());
    assert_eq!(ws.list_tasks(None).unwrap().len(), 2);
}

#[test]
fn a_note_with_nothing_pending_is_left_untouched() {
    let (_d, root, mut ws) = scaffolded();
    let (path, _) = ws.open_daily(None).unwrap();
    let before = read(&root, &path);

    assert!(ws.collect_daily_tasks(None).unwrap().is_empty());
    assert_eq!(read(&root, &path), before);
}

#[test]
fn collecting_from_a_day_with_no_note_is_not_an_error() {
    let (_d, _root, mut ws) = scaffolded();
    let long_ago = Local.with_ymd_and_hms(2020, 1, 1, 0, 0, 0).unwrap();
    assert!(ws.collect_daily_tasks(Some(long_ago)).unwrap().is_empty());
}

#[test]
fn a_batch_allocates_distinct_ids_in_one_write() {
    let (_d, _root, mut ws) = scaffolded();
    let created = ws
        .add_tasks(&[
            TaskInput { title: "一つ目".into(), ..Default::default() },
            TaskInput { title: "二つ目".into(), ..Default::default() },
            TaskInput { title: "三つ目".into(), ..Default::default() },
        ])
        .unwrap();

    let distinct: std::collections::HashSet<&str> = created.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(distinct.len(), 3);
    let titles: Vec<String> = ws.list_tasks(None).unwrap().into_iter().map(|t| t.title).collect();
    assert_eq!(titles, vec!["三つ目", "二つ目", "一つ目"]);
}

#[test]
fn collecting_many_lines_gives_each_its_own_id() {
    let (_d, root, mut ws) = scaffolded();
    let (path, _) = ws.open_daily(None).unwrap();
    let text = read(&root, &path);
    ws.write_file(
        &path,
        &text.replacen(
            DAILY_TASK_HEADING,
            &format!("{DAILY_TASK_HEADING}\n\n- [ ] 一\n- [ ] 二\n- [ ] 三\n- [ ] 四"),
            1,
        ),
        &WriteOptions::default(),
    )
    .unwrap();

    let created = ws.collect_daily_tasks(None).unwrap();
    assert_eq!(created.len(), 4);
    let distinct: std::collections::HashSet<&str> = created.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(distinct.len(), 4);

    let after = read(&root, &path);
    for task in &created {
        assert!(after.contains(&format!("→ {}", task.id)));
    }
}

#[test]
fn completing_and_reopening_a_task_keeps_the_all_time_count_honest() {
    let (_d, root, mut ws) = scaffolded();
    let task = ws.add_task(TaskInput { title: "やる".into(), ..Default::default() }).unwrap();

    let done = ws
        .update_task(&task.id, &TaskChanges { status: Some(TaskStatus::Done), ..Default::default() })
        .unwrap()
        .unwrap();
    assert_eq!(done.status, TaskStatus::Done);
    assert!(done.done.is_some());
    assert!(ws.list_tasks(None).unwrap().is_empty());
    assert_eq!(ws.list_tasks(Some(TaskStatus::Done)).unwrap().len(), 1);
    assert_eq!(ws.require_bundle().unwrap().read_task_file().done_ever, 1);

    let reopened = ws
        .update_task(&task.id, &TaskChanges { status: Some(TaskStatus::Todo), ..Default::default() })
        .unwrap()
        .unwrap();
    assert!(reopened.done.is_none());
    assert_eq!(ws.require_bundle().unwrap().read_task_file().done_ever, 0);
    assert!(read(&root, "Task.md").contains(&task.id));

    assert!(ws.update_task("T-9999", &TaskChanges::default()).unwrap().is_none());
}

// ---- skillspace.test.ts ----------------------------------------------------------

fn skill(root: &str, name: &str, frontmatter: &str, body: &str) {
    seed(
        root,
        &[(&format!("wiki/skills/{name}/SKILL.md"), &format!("---\n{frontmatter}\n---\n\n{body}"))],
    );
}

fn skill_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = bundle_dir("okf-skill-");
    fs::create_dir_all(Path::new(&root).join("wiki")).unwrap();
    skill(
        &root,
        "okf-ingest",
        "name: okf-ingest\ndescription: raw/ の資料を wiki/ に取り込んで整理する手順。議事録やエクスポートを扱うとき。\nwhen: [取り込み, ingest, 議事録, エクスポート]\ntags: [ingest, workflow]",
        "# 取り込み手順\n\n1. read_agents_md を呼ぶ\n2. search で重複を確認する",
    );
    skill(
        &root,
        "japanese-search",
        "name: japanese-search\ndescription: 日本語で検索がヒットしないときの調べ方と直し方。\nwhen: [検索, search, ヒットしない, バイグラム]\ntags: [search]",
        "# 日本語検索\n\nCJK はバイグラムで索引している。",
    );
    // A supporting file, to prove it is listed but not loaded.
    seed(&root, &[("wiki/skills/okf-ingest/reference.md", "# 詳細な参照\n\nここに長い手順が入る。")]);
    let ws = open_at(&root);
    (d, root, ws)
}

#[test]
fn lists_skills_with_their_cost_and_never_their_bodies() {
    let (_d, _root, mut ws) = skill_bundle();
    let summaries = ws.require_skills_mut().unwrap().summaries();

    let names: Vec<&str> = summaries.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["japanese-search", "okf-ingest"]);
    assert!(summaries[1].body_tokens > 0);
    let json = serde_json::to_string(&summaries).unwrap();
    // The economic contract: a summary carries no procedure text.
    assert!(!json.contains("read_agents_md"));
    assert!(!json.contains("詳細な参照"));
    assert_eq!(summaries[1].resources, vec!["reference.md"]);
}

#[test]
fn a_skill_with_no_description_is_not_listed() {
    let (_d, root, mut ws) = skill_bundle();
    skill(&root, "no-description", "name: no-description", "body");
    ws.require_skills_mut().unwrap().invalidate();

    let names: Vec<String> =
        ws.require_skills_mut().unwrap().summaries().into_iter().map(|s| s.name).collect();
    assert!(!names.contains(&"no-description".to_string()));
}

#[test]
fn an_empty_skill_space_is_not_an_error() {
    let (_d, root) = bundle_dir("okf-skill-empty-");
    fs::create_dir_all(Path::new(&root).join("wiki")).unwrap();
    let mut ws = open_at(&root);
    assert!(ws.require_skills_mut().unwrap().summaries().is_empty());
}

#[test]
fn selection_finds_the_right_skill_and_returns_nothing_rather_than_a_bad_guess() {
    let (_d, _root, mut ws) = skill_bundle();
    let skills = ws.require_skills_mut().unwrap();

    let ingest = skills.find("Notion のエクスポートを取り込みたい", None);
    assert_eq!(ingest.ranked[0].name, "okf-ingest");
    assert!(ingest.top_tokens > 0);

    assert_eq!(skills.find("日本語で検索してもヒットしない", None).ranked[0].name, "japanese-search");
    assert!(skills.find("今日の天気", None).ranked.is_empty());
}

#[test]
fn loading_returns_the_body_resources_and_named_resource_only_on_request() {
    let (_d, _root, mut ws) = skill_bundle();
    let skills = ws.require_skills_mut().unwrap();

    let opened = skills.open("okf-ingest").unwrap();
    assert!(opened.document.body.contains("read_agents_md"));
    assert_eq!(opened.resources, vec!["reference.md"]);

    assert!(skills.read_resource("okf-ingest", "reference.md").unwrap().content.contains("詳細な参照"));
    assert!(message(skills.open("nope")).contains("nope"));
}

#[test]
fn a_resource_path_cannot_escape_the_skill_folder() {
    let (_d, _root, mut ws) = skill_bundle();
    let skills = ws.require_skills_mut().unwrap();
    for attack in ["../japanese-search/SKILL.md", "../../wiki/index.md", "..\\..\\AGENTS.md"] {
        let err = message(skills.read_resource("okf-ingest", attack));
        assert!(err.contains("okf-ingest"), "{attack}: {err}");
    }
    assert!(skills.open("../wiki").is_err());
}

// ---- loops.test.ts ---------------------------------------------------------------

fn loop_files(root: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(Path::new(root).join("wiki/loops"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".md") && n != "README.md")
        .collect();
    names.sort();
    names
}

fn define(ws: &Workspace, goal: &str, name: Option<&str>) {
    ws.require_loops()
        .unwrap()
        .define(&DefineOptions {
            goal: goal.into(),
            name: name.map(str::to_string),
            ..Default::default()
        })
        .unwrap();
}

fn start(ws: &mut Workspace, name: &str) -> crate::okf::loops::LoopStartResult {
    ws.loop_start(&StartOptions { name: name.into(), ..Default::default() }).unwrap()
}

fn end(ws: &mut Workspace, outcome: Option<&str>) {
    ws.loop_end(&EndOptions { outcome: outcome.map(str::to_string), ..Default::default() }).unwrap();
}

#[test]
fn defining_a_loop_creates_exactly_one_file() {
    let (_d, root, ws) = scaffolded();
    // The scaffold ships starter designs, so count the change.
    let before = loop_files(&root).len();
    define(&ws, "Brand new loop", None);

    let after = loop_files(&root);
    assert_eq!(after.len(), before + 1);
    assert!(after.contains(&"brand-new-loop.md".to_string()));
}

#[test]
fn running_the_same_design_many_times_does_not_create_more_files() {
    let (_d, root, mut ws) = scaffolded();
    define(&ws, "Weekly lint", Some("weekly-lint"));
    for n in 0..5 {
        start(&mut ws, "weekly-lint");
        end(&mut ws, Some(&format!("run {n}")));
    }
    // Five runs, one file.
    assert_eq!(loop_files(&root).iter().filter(|n| *n == "weekly-lint.md").count(), 1);
    assert_eq!(ws.require_loops().unwrap().read("weekly-lint").unwrap().runs, 5);
}

#[test]
fn different_designs_never_share_a_file_and_redefining_keeps_history() {
    let (_d, root, mut ws) = scaffolded();
    define(&ws, "Ingest notes", Some("ingest-notes"));
    define(&ws, "Weekly lint", Some("weekly-lint"));
    let files = loop_files(&root);
    assert!(files.contains(&"ingest-notes.md".to_string()));
    assert!(files.contains(&"weekly-lint.md".to_string()));
    assert_eq!(ws.require_loops().unwrap().read("ingest-notes").unwrap().goal, "Ingest notes");

    start(&mut ws, "weekly-lint");
    end(&mut ws, Some("一回目"));
    ws.require_loops()
        .unwrap()
        .define(&DefineOptions {
            goal: "Weekly lint (改訂)".into(),
            name: Some("weekly-lint".into()),
            checks: Some(vec!["新しい条件".into()]),
            ..Default::default()
        })
        .unwrap();

    let design = ws.require_loops().unwrap().read("weekly-lint").unwrap();
    assert_eq!(design.goal, "Weekly lint (改訂)");
    assert_eq!(design.checks, vec!["新しい条件"]);
    // Editing the plan must not rewrite the past.
    assert_eq!(design.runs, 1);
    assert_eq!(design.history[0].outcome.as_deref(), Some("一回目"));
}

#[test]
fn a_loop_name_cannot_escape_the_loops_directory() {
    let (_d, _root, ws) = scaffolded();
    for bad in ["../wiki/index", "a/b", "..\\escape"] {
        let err = message(ws.require_loops().unwrap().read(bad));
        assert!(err.contains("ループ名"), "{bad}: {err}");
    }
}

#[test]
fn a_second_run_is_refused_while_one_is_in_progress() {
    let (_d, _root, mut ws) = scaffolded();
    define(&ws, "Ingest notes", Some("ingest-notes"));
    define(&ws, "Weekly lint", Some("weekly-lint"));
    start(&mut ws, "ingest-notes");

    let err = message(ws.loop_start(&StartOptions { name: "weekly-lint".into(), ..Default::default() }));
    assert!(err.contains("実行中"), "{err}");
}

#[test]
fn closing_frees_the_slot_and_ending_with_nothing_running_is_refused() {
    let (_d, _root, mut ws) = scaffolded();
    assert!(message(ws.loop_end(&EndOptions::default())).contains("実行中のループがありません"));

    define(&ws, "Weekly lint", Some("weekly-lint"));
    start(&mut ws, "weekly-lint");
    end(&mut ws, None);
    assert_eq!(start(&mut ws, "weekly-lint").run_number, 2);
}

#[test]
fn an_in_progress_run_is_recovered_after_a_restart() {
    let (_d, root, mut ws) = scaffolded();
    define(&ws, "Weekly lint", Some("weekly-lint"));
    start(&mut ws, "weekly-lint");
    ws.close();

    let reopened = open_at(&root);
    assert_eq!(reopened.require_loops().unwrap().running_loop(), Some("weekly-lint"));
}

#[test]
fn history_beyond_the_cap_is_dropped_but_the_count_survives() {
    let (_d, root, mut ws) = scaffolded();
    define(&ws, "Weekly lint", Some("weekly-lint"));
    let total = SUMMARY_RUNS + 5;
    for n in 0..total {
        start(&mut ws, "weekly-lint");
        end(&mut ws, Some(&format!("run {n}")));
    }

    let design = ws.require_loops().unwrap().read("weekly-lint").unwrap();
    assert_eq!(design.runs as usize, total);
    // The file must stay readable no matter how long the loop has been in use.
    assert!(design.history.len() <= SUMMARY_RUNS);
    assert!(read(&root, "wiki/loops/weekly-lint.md").contains("回の実行は記録から省略"));
}

#[test]
fn only_the_most_recent_runs_keep_their_journal() {
    let (_d, root, mut ws) = scaffolded();
    define(&ws, "Weekly lint", Some("weekly-lint"));
    for n in 0..DETAILED_RUNS + 3 {
        start(&mut ws, "weekly-lint");
        ws.loop_note("note", &format!("詳細 {n}")).unwrap();
        end(&mut ws, Some(&format!("run {n}")));
    }

    let raw = read(&root, "wiki/loops/weekly-lint.md");
    assert!(raw.contains(&format!("詳細 {}", DETAILED_RUNS + 2)));
    // The oldest run's journal is gone; its one-line summary is not.
    assert!(!raw.contains("詳細 0"));
    assert!(raw.contains("run 0"));
}

#[test]
fn a_summarised_run_does_not_decay_on_later_rewrites() {
    let (_d, root, mut ws) = scaffolded();
    define(&ws, "Weekly lint", Some("weekly-lint"));
    for n in 0..DETAILED_RUNS + 6 {
        start(&mut ws, "weekly-lint");
        end(&mut ws, Some(&format!("run {n}")));
    }

    let raw = read(&root, "wiki/loops/weekly-lint.md");
    // Every summarised run finished, so none of them may read as unfinished.
    assert!(!raw.contains("未完了"));
    assert!(raw.contains("run 0"));

    let design = ws.require_loops().unwrap().read("weekly-lint").unwrap();
    let oldest = design.history.last().unwrap();
    assert_eq!(oldest.status, crate::shared::okf::loop_::RunStatus::Done);
    assert_eq!(oldest.summary.as_ref().unwrap().non_conformant, "±0");
}

#[test]
fn a_file_with_a_long_history_stays_a_reasonable_size() {
    let (_d, root, mut ws) = scaffolded();
    define(&ws, "Weekly lint", Some("weekly-lint"));
    for n in 0..SUMMARY_RUNS + 10 {
        start(&mut ws, "weekly-lint");
        ws.loop_note("write", "wiki/some/long/path/to/a/note.md").unwrap();
        end(&mut ws, Some(&format!("run {n}")));
    }
    assert!(read(&root, "wiki/loops/weekly-lint.md").len() < 8000);
}

#[test]
fn writes_moves_and_deletes_are_journalled_automatically() {
    let (_d, _root, mut ws) = scaffolded();
    ws.write_file("wiki/old.md", "---\ntype: Concept\n---\n\n# Old\n", &as_actor("t")).unwrap();
    define(&ws, "Tidy up", Some("tidy-up"));
    start(&mut ws, "tidy-up");

    ws.write_file("wiki/a.md", "---\ntype: Concept\n---\n\n# A\n", &as_actor("test")).unwrap();
    ws.move_file("wiki/old.md", "wiki/renamed.md", "human:local", Actor::Human).unwrap();
    ws.delete("wiki/renamed.md", "human:local", Actor::Human).unwrap();

    let journal = ws.require_loops().unwrap().read("tidy-up").unwrap().history[0].journal.clone();
    let actions: Vec<&str> = journal.iter().map(|e| e.action.as_str()).collect();
    assert_eq!(actions, vec!["write", "move", "delete"]);
    assert_eq!(journal[0].detail, "wiki/a.md");
    // Recursion here would grow the file without bound.
    assert!(!journal.iter().any(|e| e.detail.starts_with("loops/")));
}

#[test]
fn journal_entries_reach_disk_as_work_happens_and_land_in_the_running_design_only() {
    let (_d, root, mut ws) = scaffolded();
    define(&ws, "One", Some("one"));
    define(&ws, "Two", Some("two"));
    start(&mut ws, "one");
    ws.loop_note("note", "途中経過").unwrap();

    // An abandoned run must still leave a usable trace.
    assert!(read(&root, "wiki/loops/one.md").contains("途中経過"));
    end(&mut ws, None);
    assert!(!read(&root, "wiki/loops/two.md").contains("途中経過"));
}

#[test]
fn loops_are_not_indexed_as_concepts() {
    let (_d, _root, ws) = scaffolded();
    define(&ws, "検索に出てはいけない目的", Some("hidden"));
    // A loop is process, not knowledge; mixing them corrupts every search.
    assert!(search(&ws, "検索に出てはいけない目的").is_empty());
}

// ---- audit.test.ts ---------------------------------------------------------------

fn audit_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = bundle_dir("okf-audit-");
    fs::create_dir_all(Path::new(&root).join("wiki")).unwrap();
    let mut ws = open_at(&root);
    let agent = |actor: &str| WriteOptions {
        by: Some(Actor::Agent),
        actor: Some(actor.into()),
        ..Default::default()
    };
    ws.write_file("wiki/one.md", "---\ntype: Note\n---\n\nA\n", &agent("process:local-qwen")).unwrap();
    ws.write_file("wiki/two.md", "---\ntype: Note\n---\n\nB\n", &agent("process:local-qwen")).unwrap();
    ws.write_file("wiki/three.md", "---\ntype: Note\n---\n\nC\n", &as_actor("human:local")).unwrap();
    (d, root, ws)
}

#[test]
fn groups_changes_by_actor_busiest_first() {
    let (_d, _root, ws) = audit_bundle();
    let audit = ws.audit_changes(None, None).unwrap();
    assert_eq!(audit.total, 3);
    assert_eq!(audit.actors[0].actor, "process:local-qwen");
    assert_eq!(audit.actors[0].count, 2);
    assert!(audit.actors.iter().any(|a| a.actor == "human:local"));
}

#[test]
fn filters_by_actor_substring_and_by_date() {
    let (_d, _root, ws) = audit_bundle();
    let agents = ws.audit_changes(None, Some("process:")).unwrap();
    assert_eq!(agents.total, 2);
    assert_eq!(agents.actors.len(), 1);

    // Local tomorrow, because log headings are local days.
    let tomorrow = iso_date_of(&(Local::now() + chrono::Duration::days(1)));
    assert_eq!(ws.audit_changes(Some(&tomorrow), None).unwrap().total, 0);
}

#[test]
fn a_layer_root_cannot_be_deleted_even_with_other_casing() {
    let (_d, _root, mut ws) = audit_bundle();
    for root in ["wiki", "", "raw", ".rag"] {
        let err = message(ws.delete(root, "human:local", Actor::Human));
        assert!(err.contains("層のルート"), "{root:?}: {err}");
    }
    // On Windows and macOS `WIKI` and `wiki` are one directory.
    if cfg!(any(windows, target_os = "macos")) {
        for path in ["WIKI", "Wiki", "./WIKI"] {
            let err = message(ws.delete(path, "human:local", Actor::Human));
            assert!(err.contains("層のルート"), "{path}: {err}");
        }
    }
    assert_eq!(ws.require_bundle().unwrap().all_concepts().len(), 3);
}

// ---- context-pack.test.ts --------------------------------------------------------

fn pack_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = bundle_dir("okf-pack-");
    seed(
        &root,
        &[
            (
                "wiki/search-design.md",
                "---\ntype: Concept\ntitle: 検索設計\ndescription: 日本語検索をバイグラムで実現する設計\ntags: [search]\n---\n\n# 検索設計\n\n## バイグラム索引\n\n日本語検索はバイグラム索引で実現する。unicode61 では分かち書きできない。\n\n## BM25 ランキング\n\n検索結果は BM25 でランキングし、タイトルに重みを付ける。",
            ),
            (
                "wiki/ingest.md",
                "---\ntype: Playbook\ntitle: 取り込み手順\n---\n\n# 取り込み手順\n\nraw/ の資料を検索できる形で wiki/ に取り込む。",
            ),
            (
                "wiki/skills/japanese-search/SKILL.md",
                "---\nname: japanese-search\ndescription: 日本語検索がヒットしないときの調べ方。\nwhen: [検索, search, バイグラム]\n---\n\n# 手順",
            ),
        ],
    );
    let ws = open_at(&root);
    (d, root, ws)
}

fn pack(ws: &mut Workspace, task: &str, tier: Option<ContextTier>, budget: Option<i64>) -> ContextPack {
    ws.context_pack(task, &RetrieveOptions { budget_chars: budget, ..Default::default() }, tier).unwrap()
}

#[test]
fn a_pack_groups_passages_by_file_and_carries_the_description() {
    let (_d, _root, mut ws) = pack_bundle();
    let pack = pack(&mut ws, "日本語検索のバイグラム索引はどうなっている", None, None);

    let file = pack.files.iter().find(|f| f.id == "search-design").unwrap();
    assert_eq!(file.description.as_deref(), Some("日本語検索をバイグラムで実現する設計"));
    assert!(!file.passages.is_empty());
    assert!(file.passages.iter().all(|p| p.id == "search-design"));
}

#[test]
fn tiers_size_the_budget() {
    let (_d, _root, mut ws) = pack_bundle();
    let worker = pack(&mut ws, "検索 バイグラム", Some(ContextTier::Worker), None);
    let supervisor = pack(&mut ws, "検索 バイグラム", Some(ContextTier::Supervisor), None);
    let untiered = pack(&mut ws, "検索 バイグラム", None, None);

    assert_eq!(worker.budget_chars, TIER_DEFAULTS_WORKER.budget_chars);
    assert_eq!(supervisor.budget_chars, TIER_DEFAULTS_SUPERVISOR.budget_chars);
    assert_eq!(untiered.budget_chars, DEFAULT_BUDGET_CHARS);
    assert!(worker.budget_chars < supervisor.budget_chars);
    assert_eq!(worker.tier, Some(ContextTier::Worker));
}

#[test]
fn an_explicit_budget_overrides_the_tier_default() {
    let (_d, _root, mut ws) = pack_bundle();
    let pack = pack(&mut ws, "検索 バイグラム", Some(ContextTier::Supervisor), Some(100));
    assert_eq!(pack.budget_chars, 100);
    assert!(pack.used_chars <= 100);
}

#[test]
fn matching_skills_ride_along_and_an_uncovered_task_returns_an_empty_pack() {
    let (_d, _root, mut ws) = pack_bundle();
    let with_skill = pack(&mut ws, "日本語の検索がヒットしない", None, None);
    assert!(with_skill.skills.iter().any(|s| s.name == "japanese-search"));

    assert!(pack(&mut ws, "量子コンピュータの誤り訂正", None, None).files.is_empty());
}

#[test]
fn a_rendered_pack_names_paths_anchors_and_skills() {
    let (_d, _root, mut ws) = pack_bundle();
    let rendered = format_context_pack(&pack(&mut ws, "日本語検索のバイグラム索引", None, None));
    assert!(rendered.contains("wiki/search-design.md"));
    assert!(rendered.contains("anchor: `"));
    assert!(rendered.contains("japanese-search"));
}

// ---- reserved-files.test.ts ------------------------------------------------------

#[test]
fn a_healthy_folder_opens_with_no_warnings_and_gets_both_reserved_files() {
    let (_d, root) = bundle_dir("okf-reserved-");
    let info = offline().open(&root).unwrap();
    assert!(info.warnings.is_empty());
    assert!(info.has_index);
    assert!(info.has_log);
}

/// Leave `name` as a directory entry that exists but leads nowhere (a
/// directory junction whose target is then removed).
#[cfg(windows)]
fn dangling_link(root: &str, name: &str) -> bool {
    let target = Path::new(root).join("target-to-remove");
    fs::create_dir_all(&target).unwrap();
    let made = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(Path::new(root).join(name))
        .arg(&target)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    fs::remove_dir_all(&target).unwrap();
    made
}

#[cfg(windows)]
fn unlink_junctions(root: &str) {
    for name in ["index.md", "log.md"] {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "rmdir"])
            .arg(Path::new(root).join(name))
            .output();
    }
}

#[cfg(windows)]
#[test]
fn a_reserved_file_that_cannot_be_written_does_not_stop_the_open() {
    let (_d, root) = bundle_dir("okf-reserved-");
    if !dangling_link(&root, "index.md") {
        return; // no junction support here
    }
    seed(&root, &[("note.md", &concept("Concept", "# note\n"))]);

    let mut ws = offline();
    let info = ws.open(&root).unwrap();
    // The actual notes are what the user came for, and they are all here.
    assert_eq!(info.concept_count, 1);
    assert_eq!(info.warnings.len(), 1);
    assert!(info.warnings[0].contains("index.md"));
    // The path is stated once, by us, not repeated out of the raw errno text.
    assert!(!info.warnings[0].contains("open '"));
    assert!(!info.has_index);
    assert!(ws.read_file("note.md").unwrap().content.contains("# note"));

    ws.close();
    unlink_junctions(&root);
}

// ---- the watcher -----------------------------------------------------------------


/// Apply watcher events until `done` holds, or fail after a few seconds.
fn settle(ws: &mut Workspace, done: impl Fn(&Workspace) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        ws.poll_watcher();
        if done(ws) {
            return;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    panic!("the watcher never produced the expected state");
}

#[test]
fn an_external_edit_is_picked_up_indexed_and_reported() {
    let (_d, root) = bundle_dir("okf-watch-");
    seed(&root, &[("wiki/a.md", &concept("Concept", "alpha"))]);

    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
    let sink = seen.clone();
    let mut ws = Workspace::new(WorkspaceOptions {
        watch: Some(true),
        on_external_change: Some(Box::new(move |paths, _| sink.borrow_mut().extend_from_slice(paths))),
        ..Default::default()
    });
    ws.open(&root).unwrap();

    seed(&root, &[("wiki/external.md", &concept("Concept", "zebrafish swims"))]);
    settle(&mut ws, |ws| !ws.search("zebrafish", &SearchOptions::default()).unwrap().is_empty());
    assert!(seen.borrow().iter().any(|p| p == "wiki/external.md"));

    fs::remove_file(Path::new(&root).join("wiki/external.md")).unwrap();
    settle(&mut ws, |ws| ws.search("zebrafish", &SearchOptions::default()).unwrap().is_empty());
    assert!(ws.require_bundle().unwrap().get_concept("external").is_none());
}

#[test]
fn the_apps_own_writes_are_not_reported_as_external_changes() {
    let (_d, root) = bundle_dir("okf-watch-");
    seed(&root, &[("wiki/a.md", &concept("Concept", "alpha"))]);

    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
    let sink = seen.clone();
    let mut ws = Workspace::new(WorkspaceOptions {
        watch: Some(true),
        on_external_change: Some(Box::new(move |paths, _| sink.borrow_mut().extend_from_slice(paths))),
        ..Default::default()
    });
    ws.open(&root).unwrap();

    ws.write_file("wiki/mine.md", &concept("Concept", "mine"), &as_actor("process:test")).unwrap();
    ws.add_task(TaskInput { title: "t".into(), ..Default::default() }).unwrap();
    let until = Instant::now() + Duration::from_millis(900);
    while Instant::now() < until {
        ws.poll_watcher();
        std::thread::sleep(Duration::from_millis(30));
    }
    // Windows also reports the parent directory as modified; that is not an
    // edit to any of the files the app wrote.
    let files: Vec<String> =
        seen.borrow().iter().filter(|p| p.contains('.')).cloned().collect();
    assert!(files.is_empty(), "{files:?}");
}
