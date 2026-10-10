//! Parser tests. Expected strings were produced by npm `yaml` 2.9 in Bun.

use super::parser::*;
use serde_json::{json, Map, Value};

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn emits_the_shapes_the_app_writes() {
    let fm = obj(json!({
        "type": "Note", "title": "A: b", "tags": ["x", "true", "日本"],
        "generated": {"by": "agent", "at": "2026-01-01T00:00:00.000Z"}, "status": "draft",
        "empty": [], "none": null, "n": 3, "f": 1.5, "t": true,
    }));
    assert_eq!(
        stringify_yaml(&fm),
        "type: Note\ntitle: \"A: b\"\ntags:\n  - x\n  - \"true\"\n  - 日本\ngenerated:\n  by: agent\n  at: 2026-01-01T00:00:00.000Z\nstatus: draft\nempty: []\nnone: null\nn: 3\nf: 1.5\nt: true\n"
    );
}

#[test]
fn quoting_and_block_scalars() {
    let fm = obj(json!({
        "a": "", "b": "123", "c": "null", "d": "it's", "e": "say \"hi\"", "f": "- x", "g": "line1\nline2",
        "h": "trail\n", "i": "a\u{1}b", "j": " lead", "k": "x #y", "l": "a:b",
    }));
    assert_eq!(
        stringify_yaml(&fm),
        "a: \"\"\nb: \"123\"\nc: \"null\"\nd: it's\ne: say \"hi\"\nf: \"- x\"\ng: |-\n  line1\n  line2\nh: |\n  trail\ni: \"a\\x01b\"\nj: \" lead\"\nk: \"x #y\"\nl: a:b\n"
    );
}

#[test]
fn nested_sequences_of_maps_indent_like_yaml() {
    let fm = obj(json!({"sources": [{"id": "a", "resource": "r", "tags": ["p"]}, "s"], "m": {"k": {"z": 1}}}));
    assert_eq!(
        stringify_yaml(&fm),
        "sources:\n  - id: a\n    resource: r\n    tags:\n      - p\n  - s\nm:\n  k:\n    z: 1\n"
    );
}

#[test]
fn serialize_concept_orders_keys_and_joins_the_body() {
    let fm = obj(json!({"custom": 1, "status": "draft", "title": "T", "type": "N"}));
    assert_eq!(
        serialize_concept(&fm, "\n\nbody\n"),
        "---\ntype: N\ntitle: T\nstatus: draft\ncustom: 1\n---\n\nbody\n"
    );
}

#[test]
fn integer_like_keys_come_first_as_in_a_js_object() {
    let fm = obj(json!({"b": 1, "10": 2, "2": 3, "type": "N"}));
    assert_eq!(serialize_concept(&fm, ""), "---\n\"2\": 3\n\"10\": 2\ntype: N\nb: 1\n---\n\n");
}

#[test]
fn parse_applies_defaults_and_core_schema() {
    let p = |s: &str| serde_json::to_string(&parse_frontmatter(Some(s))).unwrap();
    assert_eq!(parse_frontmatter(None).r#type, "Concept");
    assert_eq!(p("- a\n- b"), r#"{"type":"Concept"}"#);
    assert_eq!(p("a: [unclosed"), r#"{"type":"Concept"}"#);
    assert_eq!(p("a: 1\na: 2"), r#"{"type":"Concept"}"#);
    assert_eq!(p("type: '  Spaced  '"), r#"{"type":"Spaced"}"#);
    assert_eq!(p("type: 5\nx: yes\ny: 0x1f\nz: 1e3\nd: 2026-04-01"), r#"{"type":"Concept","x":"yes","y":31,"z":1000,"d":"2026-04-01"}"#);
    assert_eq!(p("title: x"), r#"{"title":"x","type":"Concept"}"#);
    assert_eq!(p("title: 5\ntags: [1, a]"), r#"{"title":5,"tags":[1,"a"],"type":"Concept"}"#);
}

#[test]
fn parse_concept_trims_leading_newlines_and_resolves_links() {
    let doc = parse_concept(ParseConceptOptions {
        id: String::new(),
        rel_path: "wiki/a.md".into(),
        abs_path: "/x/wiki/a.md".into(),
        raw: "---\ntype: Note\n---\n\n\nsee [[b]]\n".into(),
        mtime_ms: None,
        known_ids: None,
    });
    assert_eq!(doc.id, "wiki/a");
    assert_eq!(doc.body, "see [[b]]\n");
    assert_eq!(doc.links.len(), 1);
    assert_eq!(doc.mtime_ms, 0.0);
}

#[test]
fn skeleton_has_a_stable_layout() {
    let text = skeleton_concept(&ConceptSkeletonOptions {
        r#type: " Topic ".into(),
        title: Some("T".into()),
        description: Some("d".into()),
        tags: vec!["a".into()],
        body: Some("hello\n\n".into()),
        generated_by: Some("agent".into()),
        now: Some(chrono::DateTime::from_timestamp(0, 0).unwrap()),
    });
    assert_eq!(
        text,
        "---\ntype: Topic\ntitle: T\ndescription: d\ntags:\n  - a\nstatus: draft\ngenerated:\n  by: agent\n  at: 1970-01-01T00:00:00.000Z\n---\n\n# T\n\nhello\n"
    );
}
