//! The knowledge-graph design layer: typed relations and the graph schema
//! (`src/shared/okf/graph-schema.ts`).
//!
//! A concept may declare typed relations in its frontmatter
//! (`relations: { depends_on: [topics/a, "[[b]]"] }`); each entry is a link that
//! carries its kind. `wiki/graph/schema.md` (a `GraphSchema` concept) declares
//! the concept types and relation kinds the bundle intends to use, and a bundle
//! with a schema gets warnings, never errors, for anything outside it. Both
//! builds must give the same links, schema JSON and warning text.

use crate::shared::js_compat::js_trim;
use crate::shared::okf::links::resolve_link_target;
use crate::shared::types::{ConceptDocument, ConceptLink, LinkKind};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

pub const GRAPH_DIR: &str = "graph";
pub const GRAPH_TITLE: &str = "Graph";
pub const CANVASES_DIR: &str = "graph/canvases";
pub const CANVASES_TITLE: &str = "Canvases";
/// Concept id (wiki-relative, no extension) of the schema.
pub const GRAPH_SCHEMA_ID: &str = "graph/schema";
pub const GRAPH_SCHEMA_TYPE: &str = "GraphSchema";

/// Relations read from one concept, and schema entries kept: bounds on hostile frontmatter.
pub const MAX_RELATION_ENTRIES: usize = 500;
pub const MAX_SCHEMA_ENTRIES: usize = 200;
pub const MAX_SCHEMA_ENDPOINTS: usize = 50;

// ---- relations -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationRef {
    pub kind: String,
    /// Link target in the form `resolve_link_target` takes: no brackets, no wiki-dir prefix.
    pub target: String,
}

/// One relation entry as a link target: `[[x|label]]` and `x#heading` lose
/// their decoration, a bundle-relative `wiki/…` path loses its layer prefix.
/// `None` for an entry with nothing in it.
pub fn normalize_relation_target(raw: &str, wiki_dir: &str) -> Option<String> {
    let mut target = js_trim(raw);
    if target.len() >= 4 && target.starts_with("[[") && target.ends_with("]]") {
        target = &target[2..target.len() - 2];
    }
    let target = target.split('|').next().unwrap_or("");
    let target = target.split('#').next().unwrap_or("");
    let mut target = js_trim(target).replace('\\', "/");
    if !wiki_dir.is_empty() {
        let prefix = format!("{wiki_dir}/");
        if target.starts_with(&prefix) {
            target = target[prefix.len()..].to_string();
        }
    }
    (!target.is_empty()).then_some(target)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RelationRead {
    pub refs: Vec<RelationRef>,
    /// Things in the `relations` value that are not a kind with paths.
    pub problems: Vec<String>,
}

/// What a concept's `relations` frontmatter says, in the order it says it.
pub fn read_relations(frontmatter: &Map<String, Value>, wiki_dir: &str) -> RelationRead {
    let mut read = RelationRead::default();
    let value = match frontmatter.get("relations") {
        None | Some(Value::Null) => return read,
        Some(value) => value,
    };
    let Value::Object(map) = value else {
        read.problems.push("relations must be a mapping of kind to a list of paths".into());
        return read;
    };

    let mut seen: HashSet<(String, String)> = HashSet::new();
    for (raw_kind, entries) in map {
        let kind = js_trim(raw_kind);
        if kind.is_empty() {
            read.problems.push("a relation kind is empty".into());
            continue;
        }
        let single;
        let list: &[Value] = match entries {
            Value::String(_) => {
                single = [entries.clone()];
                &single
            }
            Value::Array(items) => items,
            _ => {
                read.problems
                    .push(format!("relation '{kind}' must be a path, a wiki link or a list of them"));
                continue;
            }
        };
        for entry in list {
            let Value::String(entry) = entry else {
                read.problems.push(format!("relation '{kind}' has an entry that is not a path"));
                continue;
            };
            let Some(target) = normalize_relation_target(entry, wiki_dir) else {
                continue;
            };
            let key = (kind.to_string(), target.clone());
            if seen.contains(&key) {
                continue;
            }
            if read.refs.len() >= MAX_RELATION_ENTRIES {
                read.problems
                    .push(format!("more than {MAX_RELATION_ENTRIES} relations; the rest are ignored"));
                return read;
            }
            seen.insert(key);
            read.refs.push(RelationRef { kind: kind.to_string(), target });
        }
    }
    read
}

/// The relations as links, resolved against the concept ids like any other link.
pub fn relation_links(
    frontmatter: &Map<String, Value>,
    from_id: &str,
    known_ids: Option<&HashSet<String>>,
    wiki_dir: &str,
) -> Vec<ConceptLink> {
    read_relations(frontmatter, wiki_dir)
        .refs
        .into_iter()
        .map(|r| ConceptLink {
            resolved: resolve_link_target(&r.target, from_id, known_ids),
            target: r.target,
            label: None,
            kind: LinkKind::Relation,
            relation: Some(r.kind),
        })
        .collect()
}

// ---- the schema ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaType {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaKind {
    pub name: String,
    pub description: Option<String>,
    pub from: Option<Vec<String>>,
    pub to: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GraphSchema {
    /// `None` when the schema does not list types at all: then none is checked.
    pub types: Option<Vec<SchemaType>>,
    pub kinds: Option<Vec<SchemaKind>>,
    pub problems: Vec<String>,
}

fn endpoints(value: Option<&Value>, place: &str, problems: &mut Vec<String>) -> Option<Vec<String>> {
    let value = match value {
        None | Some(Value::Null) => return None,
        Some(value) => value,
    };
    let single;
    let list: &[Value] = match value {
        Value::String(_) => {
            single = [value.clone()];
            &single
        }
        Value::Array(items) => items,
        _ => {
            problems.push(format!("{place} must be a type name or a list of them"));
            return None;
        }
    };
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let name = match item {
            Value::String(s) if !js_trim(s).is_empty() => js_trim(s).to_string(),
            _ => {
                problems.push(format!("{place} has an entry that is not a type name"));
                continue;
            }
        };
        if out.len() >= MAX_SCHEMA_ENDPOINTS {
            problems.push(format!("{place} lists more than {MAX_SCHEMA_ENDPOINTS} types; the rest are ignored"));
            break;
        }
        if !out.contains(&name) {
            out.push(name);
        }
    }
    Some(out)
}

fn description_of(item: &Map<String, Value>) -> Option<String> {
    match item.get("description") {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(js_trim(s).to_string()),
        _ => None,
    }
}

/// Read the `types` and `kinds` a `GraphSchema` concept declares.
pub fn parse_graph_schema(frontmatter: &Map<String, Value>) -> GraphSchema {
    let mut problems: Vec<String> = Vec::new();

    let entries = |key: &str, problems: &mut Vec<String>| -> Option<Vec<(String, Map<String, Value>)>> {
        let items = match frontmatter.get(key) {
            None | Some(Value::Null) => return None,
            Some(Value::Array(items)) => items,
            Some(_) => {
                problems.push(format!("{key} must be a list"));
                return None;
            }
        };
        let mut out: Vec<(String, Map<String, Value>)> = Vec::new();
        let mut overflow = false;
        for (i, item) in items.iter().enumerate() {
            let dict: Option<Map<String, Value>> = match item {
                Value::String(s) => {
                    let mut m = Map::new();
                    m.insert("name".into(), Value::String(s.clone()));
                    Some(m)
                }
                Value::Object(m) => Some(m.clone()),
                _ => None,
            };
            let name = match &dict {
                Some(d) => match d.get("name") {
                    Some(Value::String(n)) => js_trim(n).to_string(),
                    _ => String::new(),
                },
                None => String::new(),
            };
            let Some(dict) = dict.filter(|_| !name.is_empty()) else {
                problems.push(format!("{key}[{i}] needs a name"));
                continue;
            };
            if out.iter().any(|(n, _)| *n == name) {
                continue;
            }
            if out.len() >= MAX_SCHEMA_ENTRIES {
                if !overflow {
                    problems.push(format!("{key} lists more than {MAX_SCHEMA_ENTRIES} entries; the rest are ignored"));
                }
                overflow = true;
                continue;
            }
            out.push((name, dict));
        }
        Some(out)
    };

    let types = entries("types", &mut problems).map(|list| {
        list.into_iter()
            .map(|(name, item)| SchemaType { name, description: description_of(&item) })
            .collect::<Vec<_>>()
    });
    let kinds = entries("kinds", &mut problems).map(|list| {
        list.into_iter()
            .map(|(name, item)| {
                let from = endpoints(item.get("from"), &format!("kinds '{name}' from"), &mut problems);
                let to = endpoints(item.get("to"), &format!("kinds '{name}' to"), &mut problems);
                SchemaKind { description: description_of(&item), name, from, to }
            })
            .collect::<Vec<_>>()
    });
    GraphSchema { types, kinds, problems }
}

fn list(names: &[String]) -> String {
    format!("[{}]", names.join(", "))
}

/// Concept types and relation kinds the schema does not cover, per concept.
///
/// Warnings, not errors: a schema describes intent, and a bundle that has
/// outgrown it should be told, not broken. Concepts come back ordered by path.
pub fn schema_warnings(
    schema: &GraphSchema,
    subjects: &[&ConceptDocument],
    wiki_dir: &str,
) -> Vec<(String, Vec<String>)> {
    let type_of: HashMap<&str, &str> =
        subjects.iter().map(|s| (s.id.as_str(), s.frontmatter.r#type.as_str())).collect();
    let declared_types: Option<HashSet<&str>> =
        schema.types.as_ref().map(|types| types.iter().map(|t| t.name.as_str()).collect());
    let kind_by_name: HashMap<&str, &SchemaKind> = schema
        .kinds
        .iter()
        .flatten()
        .map(|k| (k.name.as_str(), k))
        .collect();

    let mut ordered: Vec<&&ConceptDocument> = subjects.iter().collect();
    ordered.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let mut out = Vec::new();
    for s in ordered {
        let mut warnings: Vec<String> = Vec::new();
        let ty = s.frontmatter.r#type.as_str();
        if let Some(declared) = &declared_types {
            if !declared.contains(ty) {
                warnings.push(format!("type '{ty}' is not declared in the graph schema"));
            }
        }

        let read = read_relations(&s.frontmatter.extra, wiki_dir);
        if schema.kinds.is_some() {
            warnings.extend(read.problems.iter().cloned());
            let mut kinds: Vec<&str> = Vec::new();
            for r in &read.refs {
                if !kinds.contains(&r.kind.as_str()) {
                    kinds.push(&r.kind);
                }
            }
            for kind in kinds {
                let Some(declared) = kind_by_name.get(kind) else {
                    warnings.push(format!("relation kind '{kind}' is not declared in the graph schema"));
                    continue;
                };
                if let Some(from) = &declared.from {
                    if !from.is_empty() && !from.iter().any(|f| f == ty) {
                        warnings.push(format!("relation '{kind}': source type '{ty}' is not one of {}", list(from)));
                    }
                }
                if let Some(to) = &declared.to {
                    if !to.is_empty() {
                        for link in &s.links {
                            if link.kind != LinkKind::Relation || link.relation.as_deref() != Some(kind) {
                                continue;
                            }
                            let Some(resolved) = &link.resolved else { continue };
                            let target_type = type_of.get(resolved.as_str()).copied().unwrap_or("");
                            if !to.iter().any(|t| t == target_type) {
                                warnings.push(format!(
                                    "relation '{kind}' -> {resolved}: target type '{target_type}' is not one of {}",
                                    list(to)
                                ));
                            }
                        }
                    }
                }
            }
        }
        if !warnings.is_empty() {
            out.push((s.rel_path.clone(), warnings));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn entries_may_be_paths_wiki_links_or_lists() {
        let read = read_relations(
            &map(json!({"relations": {
                "depends_on": ["topics/a", "[[b|Bee]]", "wiki/3-resources/c.md#sec", "  ", "topics/a"],
                "part_of": "[[p]]",
                " ": ["x"]
            }})),
            "wiki",
        );
        let got: Vec<(String, String)> = read.refs.iter().map(|r| (r.kind.clone(), r.target.clone())).collect();
        assert_eq!(
            got,
            vec![
                ("depends_on".to_string(), "topics/a".to_string()),
                ("depends_on".to_string(), "b".to_string()),
                ("depends_on".to_string(), "3-resources/c.md".to_string()),
                ("part_of".to_string(), "p".to_string()),
            ]
        );
        assert_eq!(read.problems, vec!["a relation kind is empty".to_string()]);
    }

    #[test]
    fn a_bad_shape_is_a_problem_not_a_crash() {
        let read = read_relations(&map(json!({"relations": "x"})), "wiki");
        assert_eq!(read.problems, vec!["relations must be a mapping of kind to a list of paths".to_string()]);
        let read = read_relations(&map(json!({"relations": {"k": 5, "j": [1, "a"]}})), "wiki");
        assert_eq!(read.refs.len(), 1);
        assert_eq!(
            read.problems,
            vec![
                "relation 'k' must be a path, a wiki link or a list of them".to_string(),
                "relation 'j' has an entry that is not a path".to_string(),
            ]
        );
        assert_eq!(read_relations(&Map::new(), "wiki"), RelationRead::default());
    }

    #[test]
    fn schema_types_and_kinds_are_read_and_bad_entries_reported() {
        let schema = parse_graph_schema(&map(json!({
            "types": [{"name": "A", "description": "a"}, "B", {"description": "no name"}],
            "kinds": [{"name": "uses", "from": "A", "to": ["A", "B"]}, "plain"]
        })));
        let types = schema.types.unwrap();
        assert_eq!(types[0], SchemaType { name: "A".into(), description: Some("a".into()) });
        assert_eq!(types[1], SchemaType { name: "B".into(), description: None });
        let kinds = schema.kinds.unwrap();
        assert_eq!(kinds[0].from, Some(vec!["A".to_string()]));
        assert_eq!(kinds[0].to, Some(vec!["A".to_string(), "B".to_string()]));
        assert_eq!(kinds[1].from, None);
        assert_eq!(schema.problems, vec!["types[2] needs a name".to_string()]);
        let empty = parse_graph_schema(&Map::new());
        assert!(empty.types.is_none() && empty.kinds.is_none() && empty.problems.is_empty());
    }
}
