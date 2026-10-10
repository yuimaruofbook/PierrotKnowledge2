//! Bundle behaviour tests, ported from `paths.test.ts`, `fileops.test.ts`,
//! `layers.test.ts`, `reserved-files.test.ts`, `binary.test.ts` and the
//! Bundle-only parts of `capture.test.ts` / `para.test.ts`.

use super::bundle::*;
use super::paths::Actor;
use super::scaffold::scaffold_bundle;
use crate::shared::types::{Layer, NodeType};
use std::fs;

fn note(title: &str, body: &str) -> String {
    format!("---\ntype: Note\ntitle: {title}\n---\n\n{body}\n")
}

fn open_scaffolded() -> (tempfile::TempDir, Bundle) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("bundle");
    scaffold_bundle(root.to_str().unwrap()).unwrap();
    let mut b = Bundle::open(root.to_str().unwrap()).unwrap();
    b.ensure_reserved_files();
    (dir, b)
}

fn put(b: &mut Bundle, path: &str, content: &str) -> WriteOutcome {
    b.write_file(path, content, &WriteOptions::default()).unwrap()
}

#[test]
fn open_requires_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.txt");
    fs::write(&file, "x").unwrap();
    let err = Bundle::open(file.to_str().unwrap()).err().unwrap();
    assert!(err.to_string().starts_with("フォルダではありません: "));
}

#[test]
fn a_plain_folder_is_its_own_wiki_layer() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("n.md"), note("N", "x")).unwrap();
    let b = Bundle::open(dir.path().to_str().unwrap()).unwrap();
    assert_eq!(b.paths.wiki_dir, "");
    assert_eq!(b.info().concept_count, 1);
    assert!(b.get_concept("n").is_some());
}

#[test]
fn paths_refuse_escapes_and_agents_stay_out_of_raw() {
    let (_d, b) = open_scaffolded();
    for bad in ["../x.md", "wiki/../../x.md", "a\0b", "C:foo", "D:\\x"] {
        let err = b.paths.resolve(bad).unwrap_err();
        assert_eq!(err.name(), "PathEscapeError", "{bad}");
    }
    assert!(b.paths.resolve("wiki/a.md").is_ok());
    for raw in ["raw/x.md", "RAW/x.md", "Raw/sub/x.md"] {
        let r = b.paths.assert_writable(raw, Actor::Agent);
        if cfg!(any(windows, target_os = "macos")) || raw == "raw/x.md" {
            assert_eq!(r.unwrap_err().name(), "LayerViolationError", "{raw}");
        }
        assert!(b.paths.assert_writable(raw, Actor::Human).is_ok());
    }
    assert!(b.paths.assert_writable("wiki/x.md", Actor::Agent).is_ok());
    assert!(b.paths.assert_movable("wiki/a.md", "raw/a.md", Actor::Agent).is_err());
    assert!(b.paths.assert_movable("raw/a.md", "wiki/a.md", Actor::Agent).is_err());
    assert!(b.paths.assert_movable("raw/a.md", "wiki/a.md", Actor::Human).is_ok());
}

#[test]
fn layers_are_classified() {
    let (_d, b) = open_scaffolded();
    assert_eq!(b.paths.layer_of("raw/a.md"), Some(Layer::Raw));
    assert_eq!(b.paths.layer_of(".rag/fts.sqlite"), Some(Layer::Rag));
    assert_eq!(b.paths.layer_of("wiki/skills/x"), Some(Layer::Wiki));
    assert_eq!(b.paths.layer_of("MAP.md"), None);
    assert!(b.paths.is_subsystem_path("wiki/skills/a/SKILL.md"));
    assert!(b.paths.is_subsystem_path("wiki/loops/x.md"));
    assert!(!b.paths.is_subsystem_path("wiki/daily/x.md"));
}

#[test]
fn write_read_round_trip_with_links_and_log() {
    let (_d, mut b) = open_scaffolded();
    let out = put(&mut b, "wiki/a.md", &note("A", "see [[b]]"));
    assert!(out.result.warnings.is_empty());
    put(&mut b, "wiki/b.md", &note("B", "back [[a]]"));

    let read = b.read_file("wiki/a.md").unwrap();
    assert_eq!(read.backlinks, vec!["b"]);
    assert_eq!(read.concept.unwrap().links[0].resolved.as_deref(), Some("b"));
    assert!(b.read_log().contains("wiki/a.md"));
    assert_eq!(b.unresolved_links().len(), 0);
}

#[test]
fn write_without_log_and_with_custom_action() {
    let (_d, mut b) = open_scaffolded();
    b.write_file("wiki/q.md", &note("Q", ""), &WriteOptions { log: Some(false), ..Default::default() })
        .unwrap();
    assert!(!b.read_log().contains("wiki/q.md"));
    b.write_file(
        "wiki/r.md",
        &note("R", ""),
        &WriteOptions {
            actor: Some("agent:x".into()),
            action: Some("create".into()),
            note: Some("hello".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let log = b.read_log();
    assert!(log.contains("agent:x") && log.contains("hello"));
}

#[test]
fn nonconformant_files_are_reported_and_cleared() {
    let (_d, mut b) = open_scaffolded();
    let out = put(&mut b, "wiki/bad.md", "---\ntitle: no type\n---\nbody\n");
    assert!(!out.result.warnings.is_empty());
    assert_eq!(b.conformance_issues()[0].path, "wiki/bad.md");
    put(&mut b, "wiki/bad.md", &note("fixed", ""));
    assert!(b.conformance_issues().is_empty());
}

#[test]
fn agents_cannot_write_raw_but_humans_can() {
    let (_d, mut b) = open_scaffolded();
    let err = b
        .write_file("raw/x.md", "x", &WriteOptions { by: Some(Actor::Agent), ..Default::default() })
        .unwrap_err();
    assert_eq!(err.name(), "LayerViolationError");
    b.write_file("raw/x.md", "x", &WriteOptions::default()).unwrap();
}

#[test]
fn binary_files_are_reported_not_decoded() {
    let (_d, mut b) = open_scaffolded();
    let path = format!("{}/raw/blob.sqlite", b.root());
    fs::write(path, b"SQLite format 3\0rest").unwrap();
    let r = b.read_file("raw/blob.sqlite").unwrap();
    assert_eq!(r.binary, Some(true));
    assert_eq!(r.content, "");
    assert_eq!(r.byte_length, Some(20));
    assert!(r.file_type.is_some());
}

#[test]
fn a_bom_is_dropped_on_read_and_frontmatter_still_parses() {
    let (_d, mut b) = open_scaffolded();
    fs::write(format!("{}/wiki/bom.md", b.root()), "\u{feff}---\ntype: Note\n---\nhi\n").unwrap();
    let r = b.read_file("wiki/bom.md").unwrap();
    assert!(r.content.starts_with("---"));
    assert_eq!(r.concept.unwrap().frontmatter.r#type, "Note");
}

#[test]
fn frontmatter_json_keeps_file_key_order() {
    let (_d, mut b) = open_scaffolded();
    put(
        &mut b,
        "wiki/o.md",
        "---\nstatus: draft\ntitle: t\ntype: T\ncustom: 1\ntags: [a]\n---\nb\n",
    );
    let doc = b.read_file("wiki/o.md").unwrap().concept.unwrap();
    assert_eq!(
        serde_json::to_string(&doc.frontmatter).unwrap(),
        r#"{"status":"draft","title":"t","type":"T","custom":1,"tags":["a"]}"#
    );
}

#[test]
fn move_rewrites_inbound_links_and_rebases_its_own() {
    let (_d, mut b) = open_scaffolded();
    put(&mut b, "wiki/a.md", &note("A", "[[b]] [x](topics/c.md)"));
    put(&mut b, "wiki/b.md", &note("B", "[[a]]"));
    put(&mut b, "wiki/topics/c.md", &note("C", "[up](../a.md)"));
    b.reload();

    let r = b
        .move_path("wiki/topics/c.md", "wiki/c2.md", &MoveOptions { actor: Some("human:t".into()), by: None })
        .unwrap();
    assert_eq!(r.moved, "wiki/c2.md");
    assert_eq!(r.updated, vec!["wiki/a.md"]);
    assert_eq!(r.link_count, 2);
    assert!(b.read_file("wiki/a.md").unwrap().content.contains("(./c2.md)"));
    assert!(!b.read_file("wiki/c2.md").unwrap().content.contains("../a.md"));
    assert!(b.read_log().contains("2 link(s) updated"));
}

#[test]
fn move_refuses_missing_sources_and_existing_targets() {
    let (_d, mut b) = open_scaffolded();
    put(&mut b, "wiki/a.md", &note("A", ""));
    put(&mut b, "wiki/b.md", &note("B", ""));
    let o = MoveOptions::default();
    assert_eq!(
        b.move_path("wiki/zz.md", "wiki/y.md", &o).unwrap_err().to_string(),
        "見つかりません: wiki/zz.md"
    );
    assert_eq!(
        b.move_path("wiki/a.md", "wiki/b.md", &o).unwrap_err().to_string(),
        "既に存在します: wiki/b.md"
    );
    let agent = MoveOptions { by: Some(Actor::Agent), actor: None };
    assert!(b.move_path("wiki/a.md", "raw/a.md", &agent).is_err());
}

#[test]
fn delete_protects_reserved_files_and_layer_roots() {
    let (_d, mut b) = open_scaffolded();
    let d = DeleteOptions::default();
    assert!(b.delete_path("wiki/index.md", &d).unwrap_err().to_string().contains("予約ファイル"));
    for root in ["wiki", "raw", ".rag", "", ".", "WIKI"] {
        let msg = b.delete_path(root, &d).unwrap_err().to_string();
        assert!(msg.contains("層のルート") || msg.contains("見つかりません"), "{root}: {msg}");
    }
    assert!(b.delete_path("wiki/missing.md", &d).is_err());
    let agent = DeleteOptions { by: Some(Actor::Agent), ..Default::default() };
    assert!(b.delete_path("raw/README.md", &agent).is_err());
}

#[test]
fn delete_reports_broken_inbound_links() {
    let (_d, mut b) = open_scaffolded();
    put(&mut b, "wiki/a.md", &note("A", "[[b]]"));
    put(&mut b, "wiki/b.md", &note("B", ""));
    b.reload();
    let r = b
        .delete_path("wiki/b.md", &DeleteOptions { actor: Some("agent:x".into()), ..Default::default() })
        .unwrap();
    assert_eq!(r, DeleteResult { deleted: "wiki/b.md".into(), broken_links_from: vec!["a".into()] });
    assert!(b.read_log().contains("1 inbound link(s) now broken"));
    assert_eq!(b.unresolved_links().len(), 1);
}

#[test]
fn import_never_overwrites_and_stays_in_raw() {
    let (_d, b) = open_scaffolded();
    let o = ImportOptions::default();
    assert_eq!(b.import_to_raw("raw/in.md", "1", &o).unwrap().path, "raw/in.md");
    assert_eq!(b.import_to_raw("raw/in.md", "2", &o).unwrap().path, "raw/in-2.md");
    assert_eq!(b.import_to_raw("raw/in.md", "3", &o).unwrap().path, "raw/in-3.md");
    assert_eq!(b.import_to_raw("raw/noext", "a", &o).unwrap().path, "raw/noext");
    assert_eq!(b.import_to_raw("raw/noext", "b", &o).unwrap().path, "raw/noext-2");
    assert_eq!(b.import_to_raw("raw/d.x/f", "b", &o).unwrap().path, "raw/d.x/f");
    assert_eq!(b.import_to_raw("raw/d.x/f", "b", &o).unwrap().path, "raw/d.x/f-2");
    assert!(b.import_to_raw("wiki/in.md", "x", &o).is_err());
    assert_eq!(fs::read_to_string(format!("{}/raw/in.md", b.root())).unwrap(), "1");
}

#[test]
fn promote_copies_by_default_and_moves_on_request() {
    let (_d, mut b) = open_scaffolded();
    b.import_to_raw("raw/s.md", "src", &ImportOptions::default()).unwrap();
    let kept = b.promote_from_raw("raw/s.md", "wiki/p.md", &PromoteOptions::default()).unwrap();
    assert_eq!(
        kept,
        PromoteResult { promoted: "wiki/p.md".into(), source: "raw/s.md".into(), kept: true }
    );
    assert!(fs::metadata(format!("{}/raw/s.md", b.root())).is_ok());
    let moved = b
        .promote_from_raw("raw/s.md", "wiki/p.md", &PromoteOptions { keep_source: Some(false), actor: None })
        .unwrap();
    assert_eq!(moved.promoted, "wiki/p-2.md");
    assert!(fs::metadata(format!("{}/raw/s.md", b.root())).is_err());
    assert!(b.promote_from_raw("wiki/p.md", "wiki/q.md", &PromoteOptions::default()).is_err());
    assert!(b.get_concept("p").is_some());
}

#[test]
fn index_is_grouped_and_rebuilt_from_concepts() {
    let (_d, mut b) = open_scaffolded();
    put(&mut b, "wiki/top.md", "---\ntype: N\ndescription: d\n---\n");
    put(&mut b, "wiki/zeta/z.md", &note("Z", ""));
    put(&mut b, "wiki/alpha/a.md", &note("A", ""));
    assert!(b.rebuild_index_md().unwrap() >= 3);
    let index = b.read_file("wiki/index.md").unwrap().content;
    let concepts = index.find("Concepts").unwrap();
    let alpha = index.find("alpha").unwrap();
    let zeta = index.find("zeta").unwrap();
    assert!(concepts < alpha && alpha < zeta);
    assert!(index.contains("(/top.md)"));
    assert_eq!(b.read_okf_version().as_deref(), Some("0.2"));
}

#[test]
fn reserved_files_that_cannot_be_created_do_not_stop_the_open() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("wiki/index.md")).unwrap();
    let mut b = Bundle::open(dir.path().to_str().unwrap()).unwrap();
    b.ensure_reserved_files();
    // index.md exists (as a directory), so only log.md is written.
    assert!(b.info().warnings.is_empty());
    assert!(b.info().has_log);
}

#[test]
fn layout_migration_runs_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("wiki")).unwrap();
    fs::create_dir_all(root.join("skills/s")).unwrap();
    fs::write(root.join("skills/s/SKILL.md"), "x").unwrap();
    fs::write(root.join("AGENTS.md"), "legacy").unwrap();
    let b = Bundle::open(root.to_str().unwrap()).unwrap();
    assert_eq!(b.migration.moved, vec!["AGENTS.md", "skills/"]);
    assert_eq!(b.read_agents_md().as_deref(), Some("legacy"));
}

#[test]
fn orientation_files_round_trip() {
    let (_d, b) = open_scaffolded();
    assert!(b.read_map().unwrap().contains("MAP"));
    b.write_human("me\n").unwrap();
    assert_eq!(b.read_human().as_deref(), Some("me\n"));
    let mut tasks = b.read_task_file();
    assert!(tasks.tasks.is_empty());
    tasks.done_ever = 3;
    b.write_task_file(&tasks).unwrap();
    assert_eq!(b.read_task_file().done_ever, 3);
}

#[test]
fn tag_counts_and_dir_listing() {
    let (_d, mut b) = open_scaffolded();
    put(&mut b, "wiki/a.md", "---\ntype: N\ntags: [x, y]\n---\n");
    put(&mut b, "wiki/b.md", "---\ntype: N\ntags: [x, 1, \"\"]\n---\n");
    let counts = b.tag_counts();
    assert_eq!(counts.get("x"), Some(&2));
    assert_eq!(counts.get("y"), Some(&1));
    assert_eq!(counts.get(""), None);

    let nodes = b.list_dir("", false).unwrap();
    let names: Vec<_> = nodes.iter().map(|n| n.name.as_str()).collect();
    assert!(!names.contains(&".rag"));
    assert_eq!(nodes[0].r#type, NodeType::Dir);
    assert!(b.list_dir("nope", false).unwrap().is_empty());
    assert!(b.list_dir("../x", false).is_err());
}

#[test]
fn fs_errors_read_like_nodes() {
    let (_d, mut b) = open_scaffolded();
    let msg = b.read_file("wiki/nope.md").unwrap_err().to_string();
    assert!(msg.starts_with("ENOENT: no such file or directory, open '"), "{msg}");
    assert_eq!(
        b.read_file("wiki").unwrap_err().to_string(),
        "EISDIR: illegal operation on a directory, read"
    );
}
