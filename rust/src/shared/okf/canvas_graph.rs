//! A canvas drawn from the link graph (`src/shared/okf/canvas-graph.ts`): the
//! neighbourhood of some concepts, laid out in layers.
//!
//! Plain integer arithmetic, so the same graph gives the same coordinates in
//! the Bun and the Rust build, and the same file every time. The TS file
//! documents the algorithm; this is the same one, step for step.

use crate::shared::okf::canvas::MAX_CANVAS_EDGES;
use crate::shared::okf::para::{para_of, within_para_depth, PARA_ORDER};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Concepts drawn at most; the walk stops adding nodes past this.
pub const MAX_GRAPH_NODES: usize = 150;

pub const NODE_WIDTH: i64 = 280;
pub const NODE_HEIGHT: i64 = 96;
const COLUMN_GAP: i64 = 160;
const ROW_GAP: i64 = 40;
/// Extra space between PARA clusters in a column, so their group frames do not touch.
const CLUSTER_GAP: i64 = 96;
const GROUP_PAD: i64 = 24;
const COLUMN_PITCH: i64 = NODE_WIDTH + COLUMN_GAP;
const ROW_PITCH: i64 = NODE_HEIGHT + ROW_GAP;

/// Preset colours: a root is green, a retired (DEAD) concept red.
const COLOR_ROOT: &str = "4";
const COLOR_DEAD: &str = "1";

#[derive(Debug, Clone)]
pub struct GraphLink {
    pub resolved: Option<String>,
    pub relation: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GraphConcept {
    pub id: String,
    /// Bundle-relative path: what a file node holds, and what ordering uses.
    pub path: String,
    pub dead: bool,
    pub links: Vec<GraphLink>,
}

#[derive(Debug, Clone)]
pub struct GraphOptions {
    pub roots: Vec<String>,
    pub depth: i64,
    pub include_dead: bool,
    pub para_depth: Option<i64>,
    pub group_by_para: bool,
}

#[derive(Debug, Clone)]
pub struct GraphResult {
    /// `{ "nodes": [...], "edges": [...] }`
    pub canvas: Value,
    /// Concepts drawn (not counting group frames).
    pub concepts: usize,
    pub edges: usize,
    /// The walk reached `MAX_GRAPH_NODES` and left concepts out.
    pub truncated: bool,
}

/// FNV-1a over the UTF-8 bytes, as 16 hex digits: a stable id that needs no counter.
pub fn stable_id(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn unique_id(used: &mut HashSet<String>, seed: &str) -> String {
    let mut id = stable_id(seed);
    let mut n = 2;
    while used.contains(&id) {
        id = format!("{}-{n}", stable_id(seed));
        n += 1;
    }
    used.insert(id.clone());
    id
}

struct Edge {
    from: String,
    to: String,
    label: Option<String>,
}

pub fn build_graph_canvas(concepts: &[GraphConcept], options: &GraphOptions) -> GraphResult {
    let by_id: HashMap<&str, &GraphConcept> = concepts.iter().map(|c| (c.id.as_str(), c)).collect();
    let path_of = |id: &str| by_id[id].path.as_str();
    let by_path = |a: &String, b: &String| path_of(a).cmp(path_of(b));

    // Links in both directions: what points at a concept is as much its
    // neighbourhood as what it points at.
    let mut adjacent: HashMap<&str, HashSet<&str>> = HashMap::new();
    for c in concepts {
        for link in &c.links {
            let Some(to) = link.resolved.as_deref() else { continue };
            if to == c.id || !by_id.contains_key(to) {
                continue;
            }
            adjacent.entry(c.id.as_str()).or_default().insert(to);
            adjacent.entry(to).or_default().insert(c.id.as_str());
        }
    }

    let mut roots: Vec<String> = Vec::new();
    for id in &options.roots {
        if by_id.contains_key(id.as_str()) && !roots.contains(id) {
            roots.push(id.clone());
        }
    }
    roots.sort_by(by_path);

    let mut distance: HashMap<String, i64> = HashMap::new();
    let mut included: Vec<String> = Vec::new();
    for id in &roots {
        distance.insert(id.clone(), 0);
        included.push(id.clone());
    }

    let mut truncated = false;
    let mut frontier = roots.clone();
    let mut hop = 1;
    while hop <= options.depth && !frontier.is_empty() {
        let mut next: Vec<String> = Vec::new();
        for id in &frontier {
            let mut neighbours: Vec<String> =
                adjacent.get(id.as_str()).map(|s| s.iter().map(|n| (*n).to_string()).collect()).unwrap_or_default();
            neighbours.sort_by(by_path);
            for neighbour in neighbours {
                if distance.contains_key(&neighbour) {
                    continue;
                }
                let concept = by_id[neighbour.as_str()];
                if concept.dead && !options.include_dead {
                    continue;
                }
                if let Some(depth) = options.para_depth {
                    if !within_para_depth(&neighbour, depth) {
                        continue;
                    }
                }
                if included.len() >= MAX_GRAPH_NODES {
                    truncated = true;
                    continue;
                }
                distance.insert(neighbour.clone(), hop);
                included.push(neighbour.clone());
                next.push(neighbour);
            }
        }
        next.sort_by(by_path);
        frontier = next;
        hop += 1;
    }

    // ---- edges: every link between drawn concepts, once, in a fixed order
    let mut edge_keys: HashSet<String> = HashSet::new();
    let mut edges: Vec<Edge> = Vec::new();
    for id in &included {
        for link in &by_id[id.as_str()].links {
            let Some(to) = link.resolved.as_deref() else { continue };
            if to == id || !distance.contains_key(to) {
                continue;
            }
            let relation = link.relation.as_deref().unwrap_or("");
            let key = format!("{id}\n{to}\n{relation}\n{}", if link.relation.is_none() { "p" } else { "r" });
            if !edge_keys.insert(key) {
                continue;
            }
            edges.push(Edge { from: id.clone(), to: to.to_string(), label: link.relation.clone() });
        }
    }
    edges.sort_by(|a, b| {
        path_of(&a.from)
            .cmp(path_of(&b.from))
            .then_with(|| path_of(&a.to).cmp(path_of(&b.to)))
            .then_with(|| a.label.as_deref().unwrap_or("").cmp(b.label.as_deref().unwrap_or("")))
    });

    // A dense neighbourhood (many typed relations) can carry more edges than a canvas
    // may hold; keep the first ones in the fixed order and say so, rather than let
    // canvas_write refuse the whole drawing.
    if edges.len() > MAX_CANVAS_EDGES {
        edges.truncate(MAX_CANVAS_EDGES);
        truncated = true;
    }

    // ---- columns
    let para_index = |id: &str| PARA_ORDER.iter().position(|c| *c == para_of(id)).unwrap_or(0) as i64;
    let mut columns: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for id in &included {
        columns.entry(distance[id]).or_default().push(id.clone());
    }
    for list in columns.values_mut() {
        list.sort_by(|a, b| {
            let by_class = if options.group_by_para { para_index(a) - para_index(b) } else { 0 };
            by_class.cmp(&0).then_with(|| by_path(a, b))
        });
    }

    // y within each column, before centring
    let mut ys: HashMap<String, i64> = HashMap::new();
    let mut heights: HashMap<i64, i64> = HashMap::new();
    for (col, list) in &columns {
        let mut y = 0;
        for (i, id) in list.iter().enumerate() {
            if i > 0 {
                y += if options.group_by_para && para_index(id) != para_index(&list[i - 1]) {
                    ROW_PITCH + CLUSTER_GAP
                } else {
                    ROW_PITCH
                };
            }
            ys.insert(id.clone(), y);
        }
        heights.insert(*col, y + NODE_HEIGHT);
    }
    let tallest = heights.values().copied().max().unwrap_or(0).max(0);

    // ---- nodes
    let mut used: HashSet<String> = HashSet::new();
    let mut node_ids: HashMap<String, String> = HashMap::new();
    let mut position: HashMap<String, (i64, i64)> = HashMap::new();
    let mut file_nodes: Vec<Value> = Vec::new();
    let mut group_nodes: Vec<Value> = Vec::new();

    for (col, list) in &columns {
        let offset = (tallest - heights[col]) / 2;
        let mut cluster_start = 0;
        for (i, id) in list.iter().enumerate() {
            let x = col * COLUMN_PITCH;
            let y = ys[id] + offset;
            position.insert(id.clone(), (x, y));
            let concept = by_id[id.as_str()];
            let node_id = unique_id(&mut used, &concept.path);
            node_ids.insert(id.clone(), node_id.clone());
            let color = if distance[id] == 0 {
                Some(COLOR_ROOT)
            } else if concept.dead {
                Some(COLOR_DEAD)
            } else {
                None
            };
            let mut node = Map::new();
            node.insert("id".into(), json!(node_id));
            node.insert("type".into(), json!("file"));
            node.insert("file".into(), json!(concept.path));
            node.insert("x".into(), json!(x));
            node.insert("y".into(), json!(y));
            node.insert("width".into(), json!(NODE_WIDTH));
            node.insert("height".into(), json!(NODE_HEIGHT));
            if let Some(color) = color {
                node.insert("color".into(), json!(color));
            }
            file_nodes.push(Value::Object(node));

            let last = i == list.len() - 1;
            if options.group_by_para && (last || para_index(&list[i + 1]) != para_index(id)) {
                let top = position[&list[cluster_start]].1;
                let para = PARA_ORDER[para_index(id) as usize];
                let mut group = Map::new();
                group.insert("id".into(), json!(unique_id(&mut used, &format!("group:{col}:{}", para.as_str()))));
                group.insert("type".into(), json!("group"));
                group.insert("x".into(), json!(x - GROUP_PAD));
                group.insert("y".into(), json!(top - GROUP_PAD));
                group.insert("width".into(), json!(NODE_WIDTH + 2 * GROUP_PAD));
                group.insert("height".into(), json!(y - top + NODE_HEIGHT + 2 * GROUP_PAD));
                group.insert("label".into(), json!(para.label()));
                group_nodes.push(Value::Object(group));
                cluster_start = i + 1;
            }
        }
    }

    let mut canvas_edges: Vec<Value> = Vec::new();
    for edge in &edges {
        let a = position[&edge.from];
        let b = position[&edge.to];
        let (from_side, to_side) = if a.0 != b.0 {
            if a.0 < b.0 {
                ("right", "left")
            } else {
                ("left", "right")
            }
        } else if a.1 <= b.1 {
            ("bottom", "top")
        } else {
            ("top", "bottom")
        };
        let label = edge.label.clone().unwrap_or_default();
        let mut e = Map::new();
        e.insert(
            "id".into(),
            json!(unique_id(&mut used, &format!("edge:{}>{}>{label}", edge.from, edge.to))),
        );
        e.insert("fromNode".into(), json!(node_ids[&edge.from]));
        e.insert("fromSide".into(), json!(from_side));
        e.insert("toNode".into(), json!(node_ids[&edge.to]));
        e.insert("toSide".into(), json!(to_side));
        if let Some(label) = &edge.label {
            e.insert("label".into(), json!(label));
        }
        canvas_edges.push(Value::Object(e));
    }

    let concepts_drawn = file_nodes.len();
    let edge_count = canvas_edges.len();
    // Frames first: they are drawn first, so they sit under the concepts.
    let mut nodes = group_nodes;
    nodes.extend(file_nodes);
    GraphResult {
        canvas: json!({ "nodes": nodes, "edges": canvas_edges }),
        concepts: concepts_drawn,
        edges: edge_count,
        truncated,
    }
}

/// A canvas as text, the way Obsidian writes one: tab-indented, one node or
/// edge per line. Key order is the order the objects were built in.
pub fn serialize_canvas(canvas: &Value) -> String {
    let block = |key: &str| -> String {
        let list: &[Value] = canvas.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice);
        if list.is_empty() {
            format!("\t\"{key}\":[]")
        } else {
            let items: Vec<String> = list
                .iter()
                .map(|item| format!("\t\t{}", serde_json::to_string(item).expect("canvas items serialise")))
                .collect();
            format!("\t\"{key}\":[\n{}\n\t]", items.join(",\n"))
        }
    };
    format!("{{\n{},\n{}\n}}", block("nodes"), block("edges"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn concept(id: &str, links: &[(&str, Option<&str>)], dead: bool) -> GraphConcept {
        GraphConcept {
            id: id.into(),
            path: format!("wiki/{id}.md"),
            dead,
            links: links
                .iter()
                .map(|(t, r)| GraphLink {
                    resolved: (!t.is_empty()).then(|| (*t).to_string()),
                    relation: r.map(str::to_string),
                })
                .collect(),
        }
    }

    fn opts(roots: &[&str], depth: i64) -> GraphOptions {
        GraphOptions {
            roots: roots.iter().map(|r| (*r).to_string()).collect(),
            depth,
            include_dead: false,
            para_depth: None,
            group_by_para: false,
        }
    }

    fn at(result: &GraphResult, id: &str) -> (i64, i64) {
        let file = format!("wiki/{id}.md");
        let node = result.canvas["nodes"].as_array().unwrap().iter().find(|n| n["file"] == file.as_str()).unwrap();
        (node["x"].as_i64().unwrap(), node["y"].as_i64().unwrap())
    }

    #[test]
    fn columns_are_distances_and_rows_are_ordered_and_centred() {
        let concepts = vec![
            concept("r", &[("x", None), ("y", None)], false),
            concept("x", &[("z", None)], false),
            concept("y", &[], false),
            concept("z", &[], false),
            concept("far", &[("z", None)], false),
        ];
        let result = build_graph_canvas(&concepts, &opts(&["r"], 2));
        assert_eq!(at(&result, "r"), (0, 68));
        assert_eq!(at(&result, "x"), (440, 0));
        assert_eq!(at(&result, "y"), (440, 136));
        assert_eq!(at(&result, "z"), (880, 68));
        assert_eq!((result.concepts, result.edges, result.truncated), (4, 3, false));
    }

    #[test]
    fn the_same_graph_gives_the_same_file_in_any_input_order() {
        let concepts = vec![
            concept("アルファ", &[("ベータ", None), ("ガンマ", Some("depends_on"))], false),
            concept("ベータ", &[("アルファ", None), ("ベータ", None), ("", None)], false),
            concept("ガンマ", &[("デルタ", None)], false),
            concept("デルタ", &[], true),
            concept("e", &[("ガンマ", Some("part_of")), ("ガンマ", None)], false),
        ];
        let mut o = opts(&["アルファ"], 3);
        o.include_dead = true;
        let base = serialize_canvas(&build_graph_canvas(&concepts, &o).canvas);
        let mut reversed = concepts.clone();
        reversed.reverse();
        assert_eq!(serialize_canvas(&build_graph_canvas(&reversed, &o).canvas), base);
        assert!(base.starts_with("{\n\t\"nodes\":[\n\t\t{\"id\":\""));
    }

    #[test]
    fn cycles_self_links_and_unresolved_links_are_handled() {
        let concepts = vec![
            concept("a", &[("b", None), ("a", None), ("", None)], false),
            concept("b", &[("a", None), ("c", None)], false),
            concept("c", &[("b", None)], false),
        ];
        let result = build_graph_canvas(&concepts, &opts(&["a"], 3));
        assert_eq!((result.concepts, result.edges), (3, 4));
    }

    #[test]
    fn group_frames_hold_their_nodes_and_come_first() {
        let concepts = vec![
            concept("1-projects/p", &[("3-resources/r", None), ("4-archive/old", None), ("1-projects/q", None)], false),
            concept("1-projects/q", &[], false),
            concept("3-resources/r", &[], false),
            concept("4-archive/old", &[], false),
        ];
        let mut o = opts(&["1-projects/p"], 1);
        o.group_by_para = true;
        let result = build_graph_canvas(&concepts, &o);
        let nodes = result.canvas["nodes"].as_array().unwrap();
        let labels: Vec<&str> =
            nodes.iter().filter(|n| n["type"] == "group").map(|n| n["label"].as_str().unwrap()).collect();
        assert_eq!(labels, vec!["プロジェクト", "プロジェクト", "リソース", "アーカイブ"]);
        assert_eq!(nodes[0]["type"], "group");
    }

    #[test]
    fn a_big_neighbourhood_stops_at_the_cap() {
        let leaves: Vec<GraphConcept> = (0..200).map(|i| concept(&format!("leaf{i:03}"), &[], false)).collect();
        let hub_links: Vec<(&str, Option<&str>)> = Vec::new();
        let mut all = vec![concept("hub", &hub_links, false)];
        all[0].links = leaves.iter().map(|l| GraphLink { resolved: Some(l.id.clone()), relation: None }).collect();
        all.extend(leaves);
        let result = build_graph_canvas(&all, &opts(&["hub"], 1));
        assert_eq!(result.concepts, MAX_GRAPH_NODES);
        assert!(result.truncated);
    }

    #[test]
    fn more_typed_edges_than_a_canvas_may_hold_are_cut_at_the_limit() {
        let ids: Vec<String> = (0..80).map(|i| format!("n{i:02}")).collect();
        let concepts: Vec<GraphConcept> = ids
            .iter()
            .map(|id| {
                let mut c = concept(id, &[], false);
                for other in ids.iter().filter(|o| *o != id) {
                    for kind in ["a", "b", "c"] {
                        c.links.push(GraphLink { resolved: Some(other.clone()), relation: Some(kind.into()) });
                    }
                }
                c
            })
            .collect();
        let result = build_graph_canvas(&concepts, &opts(&["n00"], 1));
        assert!(result.truncated);
        assert_eq!(result.edges, MAX_CANVAS_EDGES);
    }

    #[test]
    fn ids_are_stable_hashes() {
        assert_eq!(stable_id(""), "cbf29ce484222325");
        assert_eq!(stable_id("a"), "af63dc4c8601ec8c");
    }
}
