//! Lifecycle tags, context range, activity summaries and know-how over real
//! temporary bundles, ported from `lifecycle.test.ts`, `context-range.test.ts`,
//! `activity.test.ts` and `knowhow.test.ts`.
//!
//! The MCP-surface halves live in `mcp/tools_features_tests.rs`.

use super::*;
use crate::okf::bundle::WriteOptions;
use crate::okf::scaffold::scaffold_bundle;
use crate::rag::context_pack::format_context_pack;
use crate::shared::okf::lifecycle::PRODUCT_WEIGHT;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

// ---- helpers ---------------------------------------------------------------------

fn scaffolded(prefix: &str) -> (TempDir, String) {
    let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    scaffold_bundle(&root).unwrap();
    (dir, root)
}

fn note(root: &str, rel: &str, frontmatter: &str, body: &str) {
    let abs = Path::new(root).join("wiki").join(rel);
    fs::create_dir_all(abs.parent().unwrap()).unwrap();
    fs::write(abs, format!("---\n{frontmatter}\n---\n\n{body}")).unwrap();
}

fn open_at(root: &str) -> Workspace {
    let mut ws = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    ws.open(root).unwrap();
    ws
}

fn with(filters: SearchFilters) -> SearchOptions {
    SearchOptions { filters, ..Default::default() }
}

fn dead_ok() -> SearchFilters {
    SearchFilters { include_dead: Some(true), ..Default::default() }
}

fn ids(hits: &[SearchHit]) -> Vec<String> {
    hits.iter().map(|h| h.id.clone()).collect()
}

fn passage_ids(result: &RetrievalResult) -> Vec<String> {
    let mut ids: Vec<String> = result.passages.iter().map(|p| p.id.clone()).collect();
    ids.sort();
    ids.dedup();
    ids
}

fn message<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(e) => e.to_string(),
    }
}

fn pack_of(ws: &mut Workspace, task: &str, options: &RetrieveOptions) -> ContextPack {
    ws.context_pack(task, options, None).unwrap()
}

const PRODUCT: LifecycleChoice = LifecycleChoice::Set(Lifecycle::Product);
const DEAD: LifecycleChoice = LifecycleChoice::Set(Lifecycle::Dead);

// ---- lifecycle ---------------------------------------------------------------------

fn lifecycle_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = scaffolded("okf-life-");
    note(&root, "live.md", "type: Concept\ntitle: Live\ntags: [kappa]", "# Live\n\nthe quokka habitat survey notes");
    note(&root, "retired.md", "type: Concept\ntitle: Retired\ntags: [kappa, DEAD]", "# Retired\n\nthe quokka habitat survey notes");
    note(&root, "plain.md", "type: Concept\ntitle: Plain", "# Plain\n\nwombat burrow depth");
    // Lower-case spellings were someone's own tags before lifecycle existed.
    note(&root, "legacy.md", "type: Concept\ntitle: Legacy\ntags: [dead, product]", "# Legacy\n\nthe numbat termite census");
    note(&root, "shipped.md", "type: Concept\ntitle: Shipped\ntags: [Product]", "# Shipped\n\nwombat burrow depth");
    let ws = open_at(&root);
    (d, root, ws)
}

#[test]
fn dead_is_left_out_of_search_retrieve_and_context_pack() {
    let (_d, _root, mut ws) = lifecycle_bundle();
    assert_eq!(ids(&ws.search("quokka", &SearchOptions::default()).unwrap()), vec!["live"]);
    let retrieved = ws.retrieve("quokka habitat survey", &RetrieveOptions::default()).unwrap();
    assert_eq!(passage_ids(&retrieved), vec!["live"]);
    let pack = pack_of(&mut ws, "quokka habitat survey", &RetrieveOptions::default());
    assert_eq!(pack.files.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["live"]);
}

#[test]
fn include_dead_brings_it_back_and_the_dead_tag_finds_the_retired_files() {
    let (_d, _root, ws) = lifecycle_bundle();
    let mut both = ids(&ws.search("quokka", &with(dead_ok())).unwrap());
    both.sort();
    assert_eq!(both, vec!["live", "retired"]);

    let only_dead = SearchFilters { tags: Some(vec!["DEAD".into()]), ..Default::default() };
    assert!(ws.search("quokka", &with(only_dead.clone())).unwrap().is_empty());
    let found = SearchFilters { include_dead: Some(true), ..only_dead };
    assert_eq!(ids(&ws.search("quokka", &with(found)).unwrap()), vec!["retired"]);

    let retrieved = ws
        .retrieve("quokka habitat survey", &RetrieveOptions { filters: dead_ok(), ..Default::default() })
        .unwrap();
    assert_eq!(passage_ids(&retrieved), vec!["live", "retired"]);
}

#[test]
fn list_concepts_still_lists_dead_with_its_lifecycle() {
    let (_d, _root, ws) = lifecycle_bundle();
    let listed = ws.list_concepts().unwrap();
    let of = |id: &str| listed.iter().find(|c| c.id == id).unwrap().lifecycle;
    assert_eq!(of("retired"), Some("dead"));
    assert_eq!(of("shipped"), Some("product"));
    assert_eq!(of("plain"), None);
    // An unmarked entry serialises exactly as it always did.
    let json = serde_json::to_value(listed.iter().find(|c| c.id == "plain").unwrap()).unwrap();
    assert!(json.get("lifecycle").is_none());
}

#[test]
fn product_multiplies_the_score_by_its_weight_and_wins_a_tie() {
    let (_d, _root, ws) = lifecycle_bundle();
    let hits = ws.search("wombat burrow depth", &SearchOptions::default()).unwrap();
    assert_eq!(ids(&hits), vec!["shipped", "plain"]);
    assert!((hits[0].score / hits[1].score - PRODUCT_WEIGHT).abs() < 1e-10);
}

#[test]
fn set_lifecycle_goes_through_the_write_path_and_reindexes() {
    let (_d, root, mut ws) = lifecycle_bundle();
    let result = ws.set_lifecycle("wiki/plain.md", PRODUCT, "process:tester").unwrap();
    assert_eq!(
        result,
        SetLifecycleResult { path: "wiki/plain.md".into(), lifecycle: PRODUCT, changed: true }
    );
    let text = fs::read_to_string(Path::new(&root).join("wiki/plain.md")).unwrap();
    assert!(text.contains("Product"), "{text}");
    assert!(text.contains("# Plain"));

    let audit = ws.audit_changes(None, Some("process:tester")).unwrap();
    assert_eq!(audit.total, 1);
    assert_eq!(audit.actors[0].entries[0].path, "wiki/plain.md");
    let tagged = SearchFilters { tags: Some(vec!["Product".into()]), ..Default::default() };
    let mut found = ids(&ws.search("wombat", &with(tagged)).unwrap());
    found.sort();
    assert_eq!(found, vec!["plain", "shipped"]);
}

#[test]
fn dead_replaces_product_and_none_clears_both() {
    let (_d, _root, mut ws) = lifecycle_bundle();
    ws.set_lifecycle("wiki/shipped.md", DEAD, "process:mcp").unwrap();
    let tags = ws.read_file("wiki/shipped.md").unwrap().concept.unwrap().frontmatter.tags;
    assert_eq!(tags, Some(vec!["DEAD".to_string()]));
    assert_eq!(ids(&ws.search("wombat", &SearchOptions::default()).unwrap()), vec!["plain"]);

    ws.set_lifecycle("wiki/shipped.md", LifecycleChoice::None, "process:mcp").unwrap();
    let concept = ws.read_file("wiki/shipped.md").unwrap().concept.unwrap();
    assert_eq!(concept.frontmatter.tags, None);
    assert!(ids(&ws.search("wombat", &SearchOptions::default()).unwrap()).contains(&"shipped".to_string()));
}

#[test]
fn an_unchanged_lifecycle_writes_nothing() {
    let (_d, _root, mut ws) = lifecycle_bundle();
    let before = ws.audit_changes(None, None).unwrap().total;
    let result = ws.set_lifecycle("wiki/retired.md", DEAD, "process:mcp").unwrap();
    assert!(!result.changed);
    assert_eq!(ws.audit_changes(None, None).unwrap().total, before);
}

#[test]
fn set_lifecycle_refuses_what_it_cannot_tag() {
    let (_d, root, mut ws) = lifecycle_bundle();
    assert!(ws.set_lifecycle("wiki/missing.md", DEAD, "a").is_err());
    assert!(ws.set_lifecycle("raw/README.md", DEAD, "a").is_err());

    note(&root, "odd.md", "type: Concept\ntags: just-a-string", "x");
    fs::write(Path::new(&root).join("wiki/nofm.md"), "no frontmatter").unwrap();
    fs::write(Path::new(&root).join("wiki/bad.md"), "---\ntype: [unclosed\n---\nx").unwrap();
    ws.reload_bundle().unwrap();
    assert!(message(ws.set_lifecycle("wiki/odd.md", DEAD, "a")).contains("not a list"));
    assert!(message(ws.set_lifecycle("wiki/nofm.md", DEAD, "a")).contains("readable YAML frontmatter"));
    assert!(message(ws.set_lifecycle("wiki/bad.md", DEAD, "a")).contains("readable YAML frontmatter"));
}

#[test]
fn editing_tags_keeps_the_other_keys_as_written_and_in_order() {
    let (_d, root, mut ws) = lifecycle_bundle();
    note(&root, "keys.md", "type: Concept\ntags:\ncustom: {a: 1}\ntitle: Keys\nlast: z", "x");
    ws.reload_bundle().unwrap();
    ws.set_lifecycle("wiki/keys.md", PRODUCT, "a").unwrap();
    ws.set_lifecycle("wiki/keys.md", LifecycleChoice::None, "a").unwrap();
    let text = fs::read_to_string(Path::new(&root).join("wiki/keys.md")).unwrap();
    assert!(text.starts_with("---\ntype: Concept\ncustom: {a: 1}\ntitle: Keys\nlast: z\n---"), "{text}");
}

// ---- context range -----------------------------------------------------------------

const TOPIC: &str = "marmoset canopy telemetry";

fn range_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = scaffolded("okf-range-");
    for (rel, label) in [
        ("1-projects/p.md", "project"),
        ("2-areas/a.md", "area"),
        ("3-resources/r.md", "resource"),
        ("loose.md", "unfiled"),
        ("4-archive/z.md", "archive"),
    ] {
        note(&root, rel, &format!("type: Concept\ntitle: {label}"), &format!("# {label}\n\n{TOPIC} for the {label}"));
    }
    note(
        &root,
        "head.md",
        "type: Concept\ntitle: Head\ndescription: the entry point",
        "# Head\n\nzebu pasture rotation plan. See [[mid]] and [[retired-link]] and [[4-archive/old-link]].",
    );
    note(
        &root,
        "mid.md",
        "type: Concept\ntitle: Mid\ndescription: the middle step",
        "# Mid\n\nSecret body text that must never be copied. Next is [[tail]] and back to [[head]].",
    );
    note(&root, "tail.md", "type: Concept\ntitle: Tail\ndescription: the far end", "# Tail\n\nthe end");
    note(&root, "retired-link.md", "type: Concept\ntitle: Retired link\ntags: [DEAD]\ndescription: gone", "# R\n\nx");
    note(&root, "4-archive/old-link.md", "type: Concept\ntitle: Old link\ndescription: shelved", "# O\n\nx");
    let ws = open_at(&root);
    (d, root, ws)
}

fn depth(para_depth: i64) -> RetrieveOptions {
    RetrieveOptions {
        filters: SearchFilters { para_depth: Some(para_depth), ..Default::default() },
        ..Default::default()
    }
}

fn linking(link_depth: i64) -> RetrieveOptions {
    RetrieveOptions { link_depth: Some(link_depth), ..Default::default() }
}

#[test]
fn para_depth_defaults_to_everything_and_narrows_by_priority() {
    let (_d, _root, ws) = range_bundle();
    let all = ws.retrieve(TOPIC, &RetrieveOptions::default()).unwrap();
    assert_eq!(passage_ids(&all), vec!["1-projects/p", "2-areas/a", "3-resources/r", "4-archive/z", "loose"]);
    let at = |d| passage_ids(&ws.retrieve(TOPIC, &depth(d)).unwrap());
    assert_eq!(at(1), vec!["1-projects/p"]);
    assert_eq!(at(2), vec!["1-projects/p", "2-areas/a"]);
    assert_eq!(at(3), vec!["1-projects/p", "2-areas/a", "3-resources/r", "loose"]);
    assert_eq!(at(4).len(), 5);
}

#[test]
fn para_depth_applies_to_the_context_pack() {
    let (_d, _root, mut ws) = range_bundle();
    let pack = pack_of(&mut ws, TOPIC, &depth(2));
    let mut files: Vec<&str> = pack.files.iter().map(|f| f.id.as_str()).collect();
    files.sort();
    assert_eq!(files, vec!["1-projects/p", "2-areas/a"]);
}

#[test]
fn link_depth_zero_changes_nothing() {
    let (_d, _root, mut ws) = range_bundle();
    let pack = pack_of(&mut ws, "zebu pasture rotation plan", &RetrieveOptions::default());
    assert!(pack.linked.is_empty());
    assert!(!format_context_pack(&pack).contains("Linked"));
    assert!(ws.retrieve("zebu pasture rotation plan", &linking(0)).unwrap().linked.is_none());
}

#[test]
fn link_depth_one_adds_descriptions_not_bodies() {
    let (_d, _root, mut ws) = range_bundle();
    let pack = pack_of(&mut ws, "zebu pasture rotation plan", &linking(1));
    assert_eq!(pack.files.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["head"]);
    // The DEAD neighbour is hidden; the archived one is within the default depth.
    let linked: Vec<(&str, u32)> = pack.linked.iter().map(|l| (l.id.as_str(), l.hops)).collect();
    assert_eq!(linked, vec![("mid", 1), ("4-archive/old-link", 1)]);
    assert_eq!(
        pack.linked[0],
        LinkedFile {
            path: "wiki/mid.md".into(),
            id: "mid".into(),
            title: "Mid".into(),
            r#type: "Concept".into(),
            description: Some("the middle step".into()),
            hops: 1,
            from: "wiki/head.md".into(),
        }
    );
    let text = format_context_pack(&pack);
    assert!(text.contains("## Linked files"));
    assert!(text.contains("the middle step"));
    assert!(!text.contains("Secret body text"));
}

#[test]
fn link_depth_two_follows_another_hop_and_never_revisits() {
    let (_d, _root, mut ws) = range_bundle();
    let pack = pack_of(&mut ws, "zebu pasture rotation plan", &linking(2));
    let linked: Vec<(&str, u32)> = pack.linked.iter().map(|l| (l.id.as_str(), l.hops)).collect();
    assert_eq!(linked, vec![("mid", 1), ("4-archive/old-link", 1), ("tail", 2)]);
}

#[test]
fn links_are_resolved_against_the_pages_that_exist_now() {
    let (_d, _root, mut ws) = range_bundle();
    let agent = WriteOptions { by: Some(Actor::Agent), ..Default::default() };
    // The link is written while its target does not exist, and the target
    // comes later: the page keeps the unresolved link it was parsed with.
    ws.write_file(
        "wiki/early.md",
        "---\ntype: Concept\ntitle: Early\n---\n\nokapi glade inventory. See [[late]].",
        &agent,
    )
    .unwrap();
    ws.write_file(
        "wiki/late.md",
        "---\ntype: Concept\ntitle: Late\ndescription: made later\n---\n\nx",
        &agent,
    )
    .unwrap();
    let pack = pack_of(&mut ws, "okapi glade inventory", &linking(1));
    assert_eq!(pack.linked.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), vec!["late"]);
}

#[test]
fn link_depth_honours_para_depth_and_include_dead() {
    let (_d, _root, mut ws) = range_bundle();
    let shallow = RetrieveOptions {
        link_depth: Some(1),
        filters: SearchFilters { para_depth: Some(3), ..Default::default() },
        ..Default::default()
    };
    let pack = pack_of(&mut ws, "zebu pasture rotation plan", &shallow);
    assert_eq!(pack.linked.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), vec!["mid"]);

    let with_dead = RetrieveOptions { link_depth: Some(1), filters: dead_ok(), ..Default::default() };
    let pack = pack_of(&mut ws, "zebu pasture rotation plan", &with_dead);
    assert_eq!(
        pack.linked.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
        vec!["mid", "retired-link", "4-archive/old-link"]
    );
}

#[test]
fn link_depth_stays_inside_the_budget_and_says_so() {
    let (_d, _root, mut ws) = range_bundle();
    let full = pack_of(&mut ws, "zebu pasture rotation plan", &linking(2));
    let linked_cost: u64 = full
        .linked
        .iter()
        .map(|l| (l.title.chars().count() + l.description.as_deref().map_or(0, |d| d.chars().count())) as u64)
        .sum();
    let passages = full.used_chars - linked_cost;

    let tight = pack_of(
        &mut ws,
        "zebu pasture rotation plan",
        &RetrieveOptions { link_depth: Some(2), budget_chars: Some(passages as i64 + 20), ..Default::default() },
    );
    assert!(tight.used_chars <= passages + 20);
    assert!(tight.linked.len() < full.linked.len());
    assert!(tight.truncated);
}

#[test]
fn retrieve_gets_the_same_linked_group() {
    let (_d, _root, ws) = range_bundle();
    let result = ws.retrieve("zebu pasture rotation plan", &linking(1)).unwrap();
    let linked = result.linked.unwrap();
    assert_eq!(linked.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), vec!["mid", "4-archive/old-link"]);
}

// ---- activity ----------------------------------------------------------------------

const LOG: &str = "# Log\n\n## 2026-09-03\n\n* **Update**: `wiki/b.md` by process:codex. second pass\n* **Creation**: `wiki/c.md` by process:claude-code.\n\n## 2026-09-02\n\n* **Update**: `wiki/a.md` by process:claude-code. fixed typo\n* **Move**: `wiki/x.md → wiki/y.md` by human:local.\n\n## 2026-09-01\n\n* **Creation**: `wiki/a.md` by process:claude-code.\n";

fn activity_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = scaffolded("okf-activity-");
    fs::write(Path::new(&root).join("wiki/log.md"), LOG).unwrap();
    let ws = open_at(&root);
    (d, root, ws)
}

fn rows(actor: Option<&str>, since: Option<&str>, until: Option<&str>) -> ActivityFilter {
    ActivityFilter {
        since: since.map(String::from),
        until: until.map(String::from),
        actor: actor.map(String::from),
    }
}

#[test]
fn summarizing_reads_the_log_without_writing() {
    let (_d, _root, mut ws) = activity_bundle();
    let result = ws.summarize_activity(&rows(None, None, None), None, false).unwrap();
    assert_eq!(result.total, 5);
    assert!(result.markdown.starts_with("# Activity 2026-09-01 → 2026-09-03\n\n"));
    assert_eq!(result.saved, None);
    assert_eq!(ws.audit_changes(None, None).unwrap().total, 5);
}

#[test]
fn save_writes_an_activity_summary_concept_through_the_write_path() {
    let (_d, _root, mut ws) = activity_bundle();
    let result = ws
        .summarize_activity(&rows(Some("process:claude-code"), Some("2026-09-02"), None), None, true)
        .unwrap();
    let saved = result.saved.unwrap();
    assert_eq!(saved, "wiki/activity/2026-09-02_2026-09-03_process-claude-code-041f4214.md");

    let concept = ws.read_file(&saved).unwrap().concept.unwrap();
    assert_eq!(concept.frontmatter.r#type, "ActivitySummary");
    // The filter picks the rows; it does not say who ran the tool.
    assert_eq!(concept.frontmatter.generated.unwrap().by, "process:okf");
    assert!(concept.body.contains("* 2026-09-02 · Update · `wiki/a.md` — fixed typo"));
    assert!(concept.body.contains("Actor filter: process:claude-code"));

    let audit = ws.audit_changes(None, Some("process:okf")).unwrap();
    assert!(audit.actors[0].entries.iter().any(|e| e.path == saved));
    let found = ws
        .search("fixed typo", &with(SearchFilters { r#type: Some("ActivitySummary".into()), ..Default::default() }))
        .unwrap();
    assert_eq!(ids(&found), vec!["activity/2026-09-02_2026-09-03_process-claude-code-041f4214"]);
}

#[test]
fn a_save_is_credited_to_whoever_ran_it_in_the_file_and_the_log() {
    let (_d, _root, mut ws) = activity_bundle();
    let saved = ws
        .summarize_activity(&rows(Some("claude"), None, None), Some("process:tester"), true)
        .unwrap()
        .saved
        .unwrap();
    let concept = ws.read_file(&saved).unwrap().concept.unwrap();
    assert_eq!(concept.frontmatter.generated.unwrap().by, "process:tester");
    let audit = ws.audit_changes(None, Some("process:tester")).unwrap();
    assert!(audit.actors[0].entries.iter().any(|e| e.path == saved));
}

#[test]
fn an_unattributed_save_is_credited_to_okf_and_saving_twice_updates_in_place() {
    let (_d, root, mut ws) = activity_bundle();
    let first = ws.summarize_activity(&rows(None, None, None), None, true).unwrap().saved.unwrap();
    assert_eq!(first, "wiki/activity/2026-09-01_2026-09-03.md");
    assert!(fs::read_to_string(Path::new(&root).join(&first)).unwrap().contains("by: process:okf"));

    // The first save added log rows dated today, so pin the range.
    let second = ws.summarize_activity(&rows(None, None, Some("2026-09-03")), None, true).unwrap();
    assert_eq!(second.saved.as_deref(), Some(first.as_str()));
}

#[test]
fn nothing_matched_means_nothing_is_saved() {
    let (_d, root, mut ws) = activity_bundle();
    let result = ws.summarize_activity(&rows(None, Some("2030-01-01"), None), None, true).unwrap();
    assert_eq!(result.total, 0);
    assert_eq!(result.saved, None);
    assert!(!Path::new(&root).join("wiki/activity").read_dir().unwrap().any(|e| {
        e.unwrap().file_name().to_string_lossy() != "index.md"
    }));
}

// ---- know-how ----------------------------------------------------------------------

fn knowhow_bundle() -> (TempDir, String, Workspace) {
    let (d, root) = scaffolded("okf-knowhow-");
    let ws = open_at(&root);
    (d, root, ws)
}

fn add(ws: &mut Workspace, title: &str, body: &str, actor: &str) -> String {
    ws.knowhow_add(title, body, &[], actor).unwrap()
}

#[test]
fn a_new_bundle_has_both_folders_with_an_index_each() {
    let (_d, root, _ws) = knowhow_bundle();
    assert_eq!(fs::read_to_string(Path::new(&root).join("wiki/knowhow/index.md")).unwrap(), "# Know-how\n");
    assert_eq!(fs::read_to_string(Path::new(&root).join("wiki/activity/index.md")).unwrap(), "# Activity\n");
}

#[test]
fn an_older_bundle_gets_them_on_the_first_write() {
    let (_d, root, mut ws) = knowhow_bundle();
    fs::remove_dir_all(Path::new(&root).join("wiki/knowhow")).unwrap();
    add(&mut ws, "First", "Lesson one.", "process:tester");
    assert_eq!(fs::read_to_string(Path::new(&root).join("wiki/knowhow/index.md")).unwrap(), "# Know-how\n");
}

#[test]
fn knowhow_add_stores_who_recorded_it() {
    let (_d, _root, mut ws) = knowhow_bundle();
    let path = ws
        .knowhow_add(
            "Use forward slashes",
            "Windows accepts / in every API we call.\n\nBackslashes break the glob.",
            &["windows".to_string(), "paths".to_string()],
            "process:claude-code",
        )
        .unwrap();
    assert_eq!(path, "wiki/knowhow/use-forward-slashes.md");

    let concept = ws.read_file(&path).unwrap().concept.unwrap();
    let fm = &concept.frontmatter;
    assert_eq!(fm.r#type, "Knowhow");
    assert_eq!(fm.title.as_deref(), Some("Use forward slashes"));
    assert_eq!(fm.extra.get("by").and_then(Value::as_str), Some("process:claude-code"));
    assert_eq!(fm.tags, Some(vec!["windows".to_string(), "paths".to_string()]));
    assert_eq!(fm.description.as_deref(), Some("Windows accepts / in every API we call."));
    assert_eq!(fm.generated.as_ref().unwrap().by, "process:claude-code");
    assert!(concept.body.contains("Backslashes break the glob."));
    let audit = ws.audit_changes(None, Some("process:claude-code")).unwrap();
    assert_eq!(audit.actors[0].entries[0].kind, "Creation");
}

#[test]
fn a_repeated_title_gets_a_numbered_file() {
    let (_d, root, mut ws) = knowhow_bundle();
    let paths = [
        add(&mut ws, "Same", "one", "process:a"),
        add(&mut ws, "Same", "two", "process:b"),
        add(&mut ws, "Same", "three", "process:c"),
    ];
    assert_eq!(paths, ["wiki/knowhow/same.md", "wiki/knowhow/same-2.md", "wiki/knowhow/same-3.md"]);
    assert!(fs::read_to_string(Path::new(&root).join(&paths[0])).unwrap().contains("one"));
}

fn lessons() -> (TempDir, String, Workspace) {
    let (d, root, mut ws) = knowhow_bundle();
    ws.knowhow_add(
        "Quote Windows paths",
        "Quote any path with spaces before passing it to a shell command.",
        &["windows".to_string(), "shell".to_string()],
        "process:claude-code",
    )
    .unwrap();
    ws.knowhow_add(
        "Retry flaky downloads",
        "The release server drops connections; retry with backoff.",
        &["network".to_string()],
        "process:codex",
    )
    .unwrap();
    (d, root, ws)
}

#[test]
fn knowhow_find_returns_names_scores_and_who_never_bodies() {
    let (_d, _root, ws) = lessons();
    let found = ws.knowhow_find("quote windows path spaces shell", 3, false, &SearchFilters::default()).unwrap();
    assert_eq!(found.ranked.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["Quote Windows paths"]);
    let top = &found.ranked[0];
    assert_eq!(top.by, "process:claude-code");
    assert_eq!(top.path, "wiki/knowhow/quote-windows-paths.md");
    assert!(top.score > 0.0);
    assert!(!serde_json::to_string(&found).unwrap().contains("backoff"));
    let keys: Vec<String> =
        serde_json::to_value(top).unwrap().as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["title", "path", "description", "by", "score", "matched"]);
}

#[test]
fn dead_lessons_are_not_offered_unless_asked_for() {
    let (_d, _root, mut ws) = lessons();
    ws.set_lifecycle("wiki/knowhow/retry-flaky-downloads.md", DEAD, "a").unwrap();
    assert!(ws.knowhow_find("retry downloads backoff", 3, false, &SearchFilters::default()).unwrap().ranked.is_empty());
    assert_eq!(ws.knowhow_find("retry downloads backoff", 3, true, &SearchFilters::default()).unwrap().ranked.len(), 1);
}

#[test]
fn the_context_pack_carries_the_best_matches_in_their_own_group() {
    let (_d, _root, mut ws) = lessons();
    let task = "windows path spaces shell command";
    let pack = pack_of(&mut ws, task, &RetrieveOptions::default());
    assert_eq!(pack.knowhow.iter().map(|k| k.title.as_str()).collect::<Vec<_>>(), vec!["Quote Windows paths"]);
    assert_eq!(pack.knowhow[0].by, "process:claude-code");
    let text = format_context_pack(&pack);
    assert!(text.contains("## Relevant know-how"));
    assert!(text.contains("wiki/knowhow/quote-windows-paths.md"));

    // Know-how counts as a resource, so a depth that stops short of it drops it.
    assert!(pack_of(&mut ws, task, &depth(2)).knowhow.is_empty());
    assert_eq!(pack_of(&mut ws, task, &depth(3)).knowhow.len(), 1);
}

#[test]
fn at_most_three_are_offered() {
    let (_d, _root, mut ws) = knowhow_bundle();
    for n in 1..=4 {
        add(&mut ws, &format!("Marmot burrow lesson {n}"), "marmot burrow lesson", "process:tester");
    }
    assert_eq!(pack_of(&mut ws, "marmot burrow lesson", &RetrieveOptions::default()).knowhow.len(), 3);
}

#[test]
fn the_limit_is_clamped_to_one_through_twenty() {
    let (_d, _root, ws) = lessons();
    assert_eq!(ws.knowhow_find("quote windows path spaces shell retry downloads backoff", 0, false, &SearchFilters::default()).unwrap().ranked.len(), 1);
    assert_eq!(ws.knowhow_find("quote windows path spaces shell retry downloads backoff", -5, false, &SearchFilters::default()).unwrap().ranked.len(), 1);
    assert_eq!(ws.knowhow_find("quote windows path spaces shell retry downloads backoff", 99, false, &SearchFilters::default()).unwrap().ranked.len(), 2);
}

// ---- stage 1 review fixes --------------------------------------------------------------

#[test]
fn a_bundles_own_lowercase_product_and_dead_tags_change_nothing() {
    let (_d, _root, mut ws) = lifecycle_bundle();
    assert_eq!(ids(&ws.search("numbat", &SearchOptions::default()).unwrap()), vec!["legacy"]);
    let retrieved = ws.retrieve("numbat termite census", &RetrieveOptions::default()).unwrap();
    assert_eq!(passage_ids(&retrieved), vec!["legacy"]);
    let pack = pack_of(&mut ws, "numbat termite census", &RetrieveOptions::default());
    assert_eq!(pack.files.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["legacy"]);
    let listed = ws.list_concepts().unwrap();
    assert_eq!(listed.iter().find(|c| c.id == "legacy").unwrap().lifecycle, None);
    // No Product nudge either: the score is the plain one.
    let plain = ws.search("numbat", &SearchOptions::default()).unwrap()[0].score;
    let with_dead = ws.search("numbat", &with(dead_ok())).unwrap()[0].score;
    assert_eq!(plain, with_dead);
}

/// Write `raw` as a concept, apply a lifecycle, and return the file as it is on disk.
fn applied(root: &str, ws: &mut Workspace, raw: &str, to: LifecycleChoice) -> String {
    fs::write(Path::new(root).join("wiki/raw.md"), raw).unwrap();
    ws.reload_bundle().unwrap();
    ws.set_lifecycle("wiki/raw.md", to, "process:tester").unwrap();
    fs::read_to_string(Path::new(root).join("wiki/raw.md")).unwrap()
}

#[test]
fn set_lifecycle_flow_tags_keep_comments_quoting_and_other_values_byte_for_byte() {
    let (_d, root, mut ws) = lifecycle_bundle();
    let head = "# keep me\ntype: Concept\ntitle: \"Quoted: title\"   # trailing\nversion: 1.10\nowner: 'o''brien'\n";
    let tail = "weird:   spaced\nnested:\n  a: 1\n  b: [x,   y]\n";
    let raw = format!("---\n{head}tags: [kappa, \"b c\", 'it''s']  # why\n{tail}---\n\nbody\n");
    let want = format!("---\n{head}tags: [kappa, \"b c\", 'it''s', Product]  # why\n{tail}---\n\nbody\n");
    assert_eq!(applied(&root, &mut ws, &raw, PRODUCT), want);
}

#[test]
fn set_lifecycle_block_tags_keep_their_style_indent_and_comments() {
    let (_d, root, mut ws) = lifecycle_bundle();
    let raw = "---\ntype: Concept\ntags:\n  - kappa\n  # between\n  - DEAD\n  - \"b c\"\nversion: 1.10\n---\nbody\n";
    let want = "---\ntype: Concept\ntags:\n  - kappa\n  # between\n  - \"b c\"\n  - Product\nversion: 1.10\n---\nbody\n";
    assert_eq!(applied(&root, &mut ws, raw, PRODUCT), want);
}

#[test]
fn set_lifecycle_keeps_an_item_that_is_already_written_even_quoted() {
    let (_d, root, mut ws) = lifecycle_bundle();
    let raw = "---\ntype: Concept\ntags: [a, \"DEAD\", b]\nversion: 1.10\n---\nbody\n";
    assert_eq!(applied(&root, &mut ws, raw, DEAD), raw);
    assert_eq!(
        applied(&root, &mut ws, raw, PRODUCT),
        "---\ntype: Concept\ntags: [a, b, Product]\nversion: 1.10\n---\nbody\n"
    );
}

#[test]
fn set_lifecycle_handles_absent_empty_and_null_tags() {
    let (_d, root, mut ws) = lifecycle_bundle();
    assert_eq!(
        applied(&root, &mut ws, "---\ntype: Concept\nversion: 1.10\n---\nbody\n", DEAD),
        "---\ntype: Concept\nversion: 1.10\ntags: [DEAD]\n---\nbody\n"
    );
    assert_eq!(
        applied(&root, &mut ws, "---\ntype: Concept\ntags: []\nx: 1\n---\nbody\n", DEAD),
        "---\ntype: Concept\ntags: [DEAD]\nx: 1\n---\nbody\n"
    );
    assert_eq!(
        applied(&root, &mut ws, "---\ntype: Concept\ntags:   # none yet\nx: 1\n---\nbody\n", PRODUCT),
        "---\ntype: Concept\ntags: [Product] # none yet\nx: 1\n---\nbody\n"
    );
}

#[test]
fn set_lifecycle_none_removes_an_emptied_entry_and_nothing_else() {
    let (_d, root, mut ws) = lifecycle_bundle();
    let none = LifecycleChoice::None;
    assert_eq!(
        applied(&root, &mut ws, "---\n# c\ntype: Concept\ntags: [DEAD] # x\nversion: 1.10\n---\nbody\n", none),
        "---\n# c\ntype: Concept\nversion: 1.10\n---\nbody\n"
    );
    assert_eq!(
        applied(&root, &mut ws, "---\ntype: Concept\ntags:\n  - Product\nversion: 1.10\n---\nbody\n", none),
        "---\ntype: Concept\nversion: 1.10\n---\nbody\n"
    );
    assert_eq!(
        applied(&root, &mut ws, "---\ntype: Concept\nversion: 1.10\ntags: [DEAD]\n---\nbody\n", none),
        "---\ntype: Concept\nversion: 1.10\n---\nbody\n"
    );
}

#[test]
fn set_lifecycle_keeps_crlf_files_crlf() {
    let (_d, root, mut ws) = lifecycle_bundle();
    assert_eq!(
        applied(&root, &mut ws, "---\r\ntype: Concept\r\nversion: 1.10\r\ntags:\r\n  - a\r\n---\r\nbody\r\n", DEAD),
        "---\r\ntype: Concept\r\nversion: 1.10\r\ntags:\r\n  - a\r\n  - DEAD\r\n---\r\nbody\r\n"
    );
    assert_eq!(
        applied(&root, &mut ws, "---\r\ntype: Concept\r\n---\r\nbody\r\n", DEAD),
        "---\r\ntype: Concept\r\ntags: [DEAD]\r\n---\r\nbody\r\n"
    );
}

#[test]
fn set_lifecycle_leaves_lowercase_product_and_dead_as_the_authors_own_tags() {
    let (_d, root, mut ws) = lifecycle_bundle();
    assert_eq!(
        applied(&root, &mut ws, "---\ntype: Concept\ntags: [dead, product]\n---\nbody\n", DEAD),
        "---\ntype: Concept\ntags: [dead, product, DEAD]\n---\nbody\n"
    );
    assert_eq!(
        applied(&root, &mut ws, "---\ntype: Concept\ntags: [dead, Product]\n---\nbody\n", LifecycleChoice::None),
        "---\ntype: Concept\ntags: [dead]\n---\nbody\n"
    );
}

#[test]
fn set_lifecycle_refuses_a_form_it_cannot_edit_safely_and_leaves_the_file() {
    let (_d, root, mut ws) = lifecycle_bundle();
    let raw = "---\ntype: Concept\ntags: &shared [a, b]\n---\nbody\n";
    fs::write(Path::new(&root).join("wiki/raw.md"), raw).unwrap();
    ws.reload_bundle().unwrap();
    assert!(message(ws.set_lifecycle("wiki/raw.md", DEAD, "a")).contains("cannot be edited safely"));
    assert_eq!(fs::read_to_string(Path::new(&root).join("wiki/raw.md")).unwrap(), raw);
}

#[test]
fn the_saved_summary_records_the_actor_filter_in_its_body() {
    let (_d, _root, mut ws) = activity_bundle();
    let saved = ws
        .summarize_activity(&rows(Some("claude"), None, None), Some("process:tester"), true)
        .unwrap()
        .saved
        .unwrap();
    assert!(ws.read_file(&saved).unwrap().concept.unwrap().body.contains("Actor filter: claude"));
}

#[test]
fn knowhow_titles_that_collide_with_reserved_names_get_a_normal_indexed_file() {
    let (_d, _root, mut ws) = knowhow_bundle();
    let a = add(&mut ws, "Index", "never edit the index by hand", "process:t");
    let b = add(&mut ws, "NUL", "device names break file creation", "process:t");
    assert_eq!([a.as_str(), b.as_str()], ["wiki/knowhow/index-note.md", "wiki/knowhow/nul-note.md"]);

    assert!(ws.list_concepts().unwrap().iter().any(|c| c.id == "knowhow/index-note"));
    let hits = ws
        .search(
            "never edit the index",
            &with(SearchFilters { r#type: Some("Knowhow".into()), ..Default::default() }),
        )
        .unwrap();
    assert_eq!(ids(&hits), vec!["knowhow/index-note"]);
    let found = ws.knowhow_find("device names file creation", 3, false, &SearchFilters::default()).unwrap();
    assert_eq!(found.ranked.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), vec!["wiki/knowhow/nul-note.md"]);
    assert_eq!(add(&mut ws, "index", "second", "process:t"), "wiki/knowhow/index-note-2.md");
}

#[test]
fn a_free_path_check_that_fails_for_any_reason_but_not_found_is_an_error() {
    let (_d, _root, ws) = knowhow_bundle();
    let bundle = ws.require_bundle().unwrap();
    assert!(!bundle.exists("wiki/knowhow/nothing-here.md").unwrap());
    assert!(bundle.exists("wiki/knowhow/index.md").unwrap());
    assert!(bundle.exists("wiki/knowhow/bad\0name.md").is_err());
}

const PACK_TASK: &str = "windows path spaces shell command";

fn pack_titles(ws: &mut Workspace, filters: SearchFilters) -> Vec<String> {
    let options = RetrieveOptions { filters, ..Default::default() };
    pack_of(ws, PACK_TASK, &options).knowhow.into_iter().map(|k| k.title).collect()
}

#[test]
fn the_pack_knowhow_follows_path_prefix_tags_and_type() {
    let (_d, _root, mut ws) = lessons();
    let f = SearchFilters::default;
    assert_eq!(pack_titles(&mut ws, f()), vec!["Quote Windows paths"]);
    let prefix = |p: &str| SearchFilters { path_prefix: Some(p.into()), ..f() };
    let tags = |t: &[&str]| SearchFilters { tags: Some(t.iter().map(|s| s.to_string()).collect()), ..f() };
    let kind = |t: &str| SearchFilters { r#type: Some(t.into()), ..f() };
    assert_eq!(pack_titles(&mut ws, prefix("wiki/knowhow")), vec!["Quote Windows paths"]);
    assert!(pack_titles(&mut ws, prefix("wiki/projects")).is_empty());
    assert_eq!(pack_titles(&mut ws, tags(&["windows"])), vec!["Quote Windows paths"]);
    assert!(pack_titles(&mut ws, tags(&["network"])).is_empty());
    assert!(pack_titles(&mut ws, tags(&["windows", "network"])).is_empty());
    assert_eq!(pack_titles(&mut ws, kind("Knowhow")), vec!["Quote Windows paths"]);
    assert!(pack_titles(&mut ws, kind("Concept")).is_empty());
}

#[test]
fn the_pack_knowhow_is_paid_for_from_the_same_budget_as_the_passages() {
    let (_d, _root, mut ws) = lessons();
    let roomy = RetrieveOptions { budget_chars: Some(20000), ..Default::default() };
    let pack = pack_of(&mut ws, PACK_TASK, &roomy);
    let entry = &pack.knowhow[0];
    let cost = (entry.title.chars().count() + entry.description.chars().count()) as u64;
    let passages = ws
        .retrieve(PACK_TASK, &RetrieveOptions { budget_chars: Some(20000), limit: Some(8), ..Default::default() })
        .unwrap();
    assert_eq!(pack.used_chars, passages.used_chars + cost);

    // Room for the passages but not the lesson on top of them.
    let tight = RetrieveOptions { budget_chars: Some((passages.used_chars + cost) as i64 - 1), ..Default::default() };
    let pack = pack_of(&mut ws, PACK_TASK, &tight);
    assert!(pack.knowhow.is_empty());
    assert!(pack.truncated);
    assert!(pack.used_chars as i64 <= pack.budget_chars);
}

#[test]
fn link_depth_honours_type_tags_and_path_prefix_like_the_passages_do() {
    let (_d, root, mut ws) = range_bundle();
    note(
        &root,
        "pool/lead.md",
        "type: Concept\ntitle: Lead\ntags: [x]",
        "# Lead\n\nquail roost census. See [[pool/same]], [[pool/other-type]], [[pool/other-tag]] and [[elsewhere/far]].",
    );
    note(&root, "pool/same.md", "type: Concept\ntitle: Same\ntags: [x]\ndescription: kept", "# S\n\nx");
    note(&root, "pool/other-type.md", "type: Reference\ntitle: Other type\ntags: [x]\ndescription: wrong type", "# T\n\nx");
    note(&root, "pool/other-tag.md", "type: Concept\ntitle: Other tag\ndescription: no tag", "# G\n\nx");
    note(&root, "elsewhere/far.md", "type: Concept\ntitle: Far\ntags: [x]\ndescription: wrong folder", "# F\n\nx");
    ws.reload_bundle().unwrap();

    let mut linked = |filters: SearchFilters| -> Vec<String> {
        let options = RetrieveOptions { link_depth: Some(1), filters, ..Default::default() };
        let mut out: Vec<String> =
            pack_of(&mut ws, "quail roost census", &options).linked.into_iter().map(|l| l.id).collect();
        out.sort();
        out
    };
    let f = SearchFilters::default;
    assert_eq!(linked(f()), vec!["elsewhere/far", "pool/other-tag", "pool/other-type", "pool/same"]);
    assert_eq!(
        linked(SearchFilters { r#type: Some("Concept".into()), ..f() }),
        vec!["elsewhere/far", "pool/other-tag", "pool/same"]
    );
    assert_eq!(
        linked(SearchFilters { tags: Some(vec!["x".into()]), ..f() }),
        vec!["elsewhere/far", "pool/other-type", "pool/same"]
    );
    assert_eq!(
        linked(SearchFilters { path_prefix: Some("wiki/pool".into()), ..f() }),
        vec!["pool/other-tag", "pool/other-type", "pool/same"]
    );
    assert_eq!(
        linked(SearchFilters {
            r#type: Some("Concept".into()),
            tags: Some(vec!["x".into()]),
            path_prefix: Some("wiki/pool".into()),
            ..f()
        }),
        vec!["pool/same"]
    );
}

#[test]
fn string_tags_still_count_when_the_list_also_holds_other_values() {
    let (_d, root, mut ws) = lifecycle_bundle();
    note(&root, "mixed.md", "type: Concept\ntitle: Mixed\ntags: [1, {k: v}, kappa, DEAD]", "# Mixed\n\nthe ocelot canopy census");
    ws.reload_bundle().unwrap();
    // The list is not all strings, but its DEAD tag still retires the note.
    assert!(ws.search("ocelot", &SearchOptions::default()).unwrap().is_empty());
    let tagged = SearchFilters { tags: Some(vec!["kappa".into()]), include_dead: Some(true), ..Default::default() };
    assert_eq!(ids(&ws.search("ocelot", &with(tagged)).unwrap()), vec!["mixed"]);
    let listed = ws.list_concepts().unwrap();
    assert_eq!(listed.iter().find(|c| c.id == "mixed").unwrap().lifecycle, Some("dead"));
}
