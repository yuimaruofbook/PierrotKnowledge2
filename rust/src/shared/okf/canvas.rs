//! Canvases: `.canvas` files in the JSON Canvas 1.0 format
//! (`src/shared/okf/canvas.ts`).
//!
//! Checking a canvas against the spec within fixed bounds, and describing one as
//! a compact text outline. A canvas is saved exactly as given, so unknown keys
//! and the order of nodes and edges survive a round trip with Obsidian. Group
//! membership is geometric and resolved with a total order, so groups that
//! overlap or contain each other cannot form a cycle. Both builds must give the
//! same errors and the same outline.

use crate::shared::js_compat::js_trim;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub const CANVAS_EXT: &str = ".canvas";

/// Largest canvas file read or written.
pub const MAX_CANVAS_BYTES: usize = 1_048_576;
pub const MAX_CANVAS_NODES: usize = 2_000;
pub const MAX_CANVAS_EDGES: usize = 5_000;
/// JSON nesting, checked before parsing so a bracket bomb never reaches the parser.
pub const MAX_CANVAS_DEPTH: usize = 32;
/// Coordinates and sizes stay well inside the range where integers are exact.
pub const MAX_COORD: i64 = 10_000_000;
pub const MAX_ID_CHARS: usize = 128;
/// How many errors a message spells out; the rest are counted.
pub const MAX_ERRORS_SHOWN: usize = 10;

pub fn is_canvas_path(path: &str) -> bool {
    path.to_lowercase().ends_with(CANVAS_EXT)
}

/// First `max` code points of `text`, with an ellipsis when it was cut.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}…")
}

static PRESET_COLOR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[1-6]$").unwrap());
static HEX_COLOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$").unwrap());

const NODE_TYPES: [&str; 4] = ["text", "file", "link", "group"];
const SIDES: [&str; 4] = ["top", "right", "bottom", "left"];
const ENDS: [&str; 2] = ["none", "arrow"];
const BG_STYLES: [&str; 3] = ["cover", "ratio", "repeat"];

fn is_int(v: Option<&Value>, min: i64, max: i64) -> bool {
    match v {
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) => f.is_finite() && f.fract() == 0.0 && f >= min as f64 && f <= max as f64,
            None => false,
        },
        _ => false,
    }
}

fn valid_id(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= MAX_ID_CHARS => Some(s),
        _ => None,
    }
}

fn str_in(v: Option<&Value>, set: &[&str]) -> bool {
    matches!(v, Some(Value::String(s)) if set.contains(&s.as_str()))
}

/// The spec's problems with a parsed canvas, in the order found. Empty when it is valid.
pub fn validate_canvas(value: &Value) -> Vec<String> {
    let Value::Object(root) = value else {
        return vec!["the canvas must be a JSON object".into()];
    };
    let mut errors: Vec<String> = Vec::new();

    let nodes = root.get("nodes");
    let edges = root.get("edges");
    if matches!(nodes, Some(v) if !v.is_array()) {
        errors.push("nodes must be an array".into());
    }
    if matches!(edges, Some(v) if !v.is_array()) {
        errors.push("edges must be an array".into());
    }
    let empty: Vec<Value> = Vec::new();
    let node_list = nodes.and_then(Value::as_array).unwrap_or(&empty);
    let edge_list = edges.and_then(Value::as_array).unwrap_or(&empty);
    if node_list.len() > MAX_CANVAS_NODES {
        errors.push(format!("too many nodes: the limit is {MAX_CANVAS_NODES}"));
    }
    if edge_list.len() > MAX_CANVAS_EDGES {
        errors.push(format!("too many edges: the limit is {MAX_CANVAS_EDGES}"));
    }
    if !errors.is_empty() {
        return errors;
    }

    let mut ids: HashSet<&str> = HashSet::new();
    let color = |item: &Map<String, Value>, place: &str, errors: &mut Vec<String>| match item.get("color") {
        None => {}
        Some(Value::String(c)) if PRESET_COLOR_RE.is_match(c) || HEX_COLOR_RE.is_match(c) => {}
        Some(_) => errors.push(format!("{place}.color must be \"1\" to \"6\" or a #hex colour")),
    };
    let opt_string = |item: &Map<String, Value>, key: &str, place: &str, errors: &mut Vec<String>| {
        if matches!(item.get(key), Some(v) if !v.is_string()) {
            errors.push(format!("{place}.{key} must be a string"));
        }
    };

    for (i, node) in node_list.iter().enumerate() {
        let place = format!("nodes[{i}]");
        let Value::Object(node) = node else {
            errors.push(format!("{place} must be an object"));
            continue;
        };
        match valid_id(node.get("id")) {
            None => errors.push(format!("{place}.id must be a non-empty string of at most {MAX_ID_CHARS} characters")),
            Some(id) => {
                if !ids.insert(id) {
                    errors.push(format!("{place}.id '{}' is used twice", clip(id, 40)));
                }
            }
        }

        if !str_in(node.get("type"), &NODE_TYPES) {
            errors.push(format!("{place}.type must be text, file, link or group"));
        }
        for key in ["x", "y"] {
            if !is_int(node.get(key), -MAX_COORD, MAX_COORD) {
                errors.push(format!("{place}.{key} must be an integer from -{MAX_COORD} to {MAX_COORD}"));
            }
        }
        for key in ["width", "height"] {
            if !is_int(node.get(key), 1, MAX_COORD) {
                errors.push(format!("{place}.{key} must be an integer from 1 to {MAX_COORD}"));
            }
        }
        color(node, &place, &mut errors);

        match node.get("type").and_then(Value::as_str) {
            Some("text") => {
                if !matches!(node.get("text"), Some(Value::String(_))) {
                    errors.push(format!("{place}.text must be a string"));
                }
            }
            Some("file") => {
                match node.get("file") {
                    Some(Value::String(f)) if !f.is_empty() && !f.contains('\0') => {}
                    _ => errors.push(format!("{place}.file must be a non-empty path")),
                }
                if let Some(sub) = node.get("subpath") {
                    if !matches!(sub, Value::String(s) if s.starts_with('#')) {
                        errors.push(format!("{place}.subpath must be a string starting with #"));
                    }
                }
            }
            Some("link") => {
                if !matches!(node.get("url"), Some(Value::String(u)) if !u.is_empty()) {
                    errors.push(format!("{place}.url must be a non-empty string"));
                }
            }
            Some("group") => {
                opt_string(node, "label", &place, &mut errors);
                opt_string(node, "background", &place, &mut errors);
                if let Some(style) = node.get("backgroundStyle") {
                    if !str_in(Some(style), &BG_STYLES) {
                        errors.push(format!("{place}.backgroundStyle must be cover, ratio or repeat"));
                    }
                }
            }
            _ => {}
        }
    }

    let mut edge_ids: HashSet<&str> = HashSet::new();
    for (i, edge) in edge_list.iter().enumerate() {
        let place = format!("edges[{i}]");
        let Value::Object(edge) = edge else {
            errors.push(format!("{place} must be an object"));
            continue;
        };
        match valid_id(edge.get("id")) {
            None => errors.push(format!("{place}.id must be a non-empty string of at most {MAX_ID_CHARS} characters")),
            Some(id) => {
                if !edge_ids.insert(id) {
                    errors.push(format!("{place}.id '{}' is used twice", clip(id, 40)));
                }
            }
        }

        for key in ["fromNode", "toNode"] {
            match edge.get(key) {
                Some(Value::String(target)) => {
                    if !ids.contains(target.as_str()) {
                        errors.push(format!("{place}.{key} '{}' is not a node", clip(target, 40)));
                    }
                }
                _ => errors.push(format!("{place}.{key} must be a node id")),
            }
        }
        for key in ["fromSide", "toSide"] {
            if edge.contains_key(key) && !str_in(edge.get(key), &SIDES) {
                errors.push(format!("{place}.{key} must be top, right, bottom or left"));
            }
        }
        for key in ["fromEnd", "toEnd"] {
            if edge.contains_key(key) && !str_in(edge.get(key), &ENDS) {
                errors.push(format!("{place}.{key} must be none or arrow"));
            }
        }
        color(edge, &place, &mut errors);
        opt_string(edge, "label", &place, &mut errors);
    }

    errors
}

/// At most `MAX_ERRORS_SHOWN` errors, then how many were left out.
pub fn describe_canvas_errors(errors: &[String]) -> String {
    let shown = errors.iter().take(MAX_ERRORS_SHOWN).cloned().collect::<Vec<_>>().join("; ");
    if errors.len() > MAX_ERRORS_SHOWN {
        format!("{shown}; and {} more", errors.len() - MAX_ERRORS_SHOWN)
    } else {
        shown
    }
}

/// Whether JSON text nests deeper than `limit` brackets, outside strings.
fn json_depth_exceeds(text: &str, limit: usize) -> bool {
    let mut depth: i64 = 0;
    let mut in_string = false;
    let mut skip = false;
    for &b in text.as_bytes() {
        if skip {
            skip = false;
            continue;
        }
        if in_string {
            if b == b'\\' {
                skip = true;
            } else if b == b'"' {
                in_string = false;
            }
        } else if b == b'"' {
            in_string = true;
        } else if b == b'{' || b == b'[' {
            depth += 1;
            if depth > limit as i64 {
                return true;
            }
        } else if b == b'}' || b == b']' {
            depth -= 1;
        }
    }
    false
}

/// Size, nesting, JSON and the spec, in that order: the cheap refusals come first.
pub fn parse_canvas(text: &str) -> Result<Value, Vec<String>> {
    if text.len() > MAX_CANVAS_BYTES {
        return Err(vec![format!("the canvas is larger than {MAX_CANVAS_BYTES} bytes")]);
    }
    if json_depth_exceeds(text, MAX_CANVAS_DEPTH) {
        return Err(vec![format!("the canvas is nested deeper than {MAX_CANVAS_DEPTH} levels")]);
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Err(vec!["the content is not valid JSON".into()]);
    };
    let errors = validate_canvas(&value);
    if errors.is_empty() {
        Ok(value)
    } else {
        Err(errors)
    }
}

/// A parsed number as JS prints it: a whole value has no `.0`.
pub fn js_numbers(value: &Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 => Value::Number((f as i64).into()),
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(js_numbers).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), js_numbers(v))).collect()),
        other => other.clone(),
    }
}

// ---- groups -------------------------------------------------------------------------

/// A node's rectangle, and whether it is a group.
#[derive(Debug, Clone, Copy)]
pub struct Geo {
    pub group: bool,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

fn int(node: &Map<String, Value>, key: &str) -> i64 {
    node.get(key).and_then(Value::as_f64).unwrap_or(0.0) as i64
}

pub fn geo_of(node: &Map<String, Value>) -> Geo {
    Geo {
        group: node.get("type").and_then(Value::as_str) == Some("group"),
        x: int(node, "x"),
        y: int(node, "y"),
        w: int(node, "width"),
        h: int(node, "height"),
    }
}

/// The group each node sits in: the smallest group whose rectangle holds it.
///
/// A group holds a node when it is strictly larger, or the same size and drawn
/// earlier. That makes "holds" an order, so a chain of parents always ends: two
/// identical groups do not contain each other, and nothing contains itself.
/// Returns, per node index, the parent group's index or -1.
pub fn group_parents(nodes: &[Geo]) -> Vec<i64> {
    let area = |n: &Geo| n.w * n.h;
    let groups: Vec<usize> = nodes.iter().enumerate().filter(|(_, n)| n.group).map(|(i, _)| i).collect();

    nodes
        .iter()
        .enumerate()
        .map(|(i, node)| {
            let mut best: Option<usize> = None;
            for &g in &groups {
                if g == i {
                    continue;
                }
                let group = &nodes[g];
                let inside = group.x <= node.x
                    && group.y <= node.y
                    && group.x + group.w >= node.x + node.w
                    && group.y + group.h >= node.y + node.h;
                if !inside {
                    continue;
                }
                if !(area(group) > area(node) || (area(group) == area(node) && g < i)) {
                    continue;
                }
                // The nearest group is the smallest; among equals, the one drawn last.
                let better = match best {
                    None => true,
                    Some(b) => area(group) < area(&nodes[b]) || (area(group) == area(&nodes[b]) && g > b),
                };
                if better {
                    best = Some(g);
                }
            }
            best.map_or(-1, |b| b as i64)
        })
        .collect()
}

// ---- outline ------------------------------------------------------------------------

/// What a file node points at, if it is a concept.
#[derive(Debug, Clone)]
pub struct ResolvedFile {
    pub title: String,
    pub description: Option<String>,
}

const LABEL_CHARS: usize = 80;

fn first_line(text: &str) -> String {
    let line = text.split('\n').find(|l| !js_trim(l).is_empty()).unwrap_or("");
    clip(js_trim(line), LABEL_CHARS)
}

fn string_of<'a>(node: &'a Map<String, Value>, key: &str) -> &'a str {
    node.get(key).and_then(Value::as_str).unwrap_or("")
}

fn node_type(node: &Map<String, Value>) -> &str {
    string_of(node, "type")
}

/// How a node is named in the outline and in edges.
fn node_name(node: &Map<String, Value>, resolve: &dyn Fn(&str) -> Option<ResolvedFile>) -> String {
    match node_type(node) {
        "file" => match resolve(string_of(node, "file")) {
            Some(found) => found.title,
            None => string_of(node, "file").to_string(),
        },
        "text" => format!("\"{}\"", first_line(string_of(node, "text"))),
        "link" => string_of(node, "url").to_string(),
        _ => match node.get("label") {
            Some(Value::String(label)) if !label.is_empty() => clip(label, LABEL_CHARS),
            _ => format!("(group {})", string_of(node, "id")),
        },
    }
}

fn node_line(node: &Map<String, Value>, resolve: &dyn Fn(&str) -> Option<ResolvedFile>) -> String {
    let head = format!("- [{}] {}", string_of(node, "id"), node_type(node));
    match node_type(node) {
        "file" => {
            let file = format!("{}{}", string_of(node, "file"), string_of(node, "subpath"));
            match resolve(string_of(node, "file")) {
                Some(found) => {
                    let description = found.description.map(|d| format!(": {d}")).unwrap_or_default();
                    format!("{head} {file} — {}{description}", found.title)
                }
                None if string_of(node, "file").to_lowercase().ends_with(".md") => format!("{head} {file} (not found)"),
                None => format!("{head} {file}"),
            }
        }
        "link" => format!("{head} {}", string_of(node, "url")),
        _ => format!("{head} {}", node_name(node, resolve)),
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// A canvas as text: nodes by group (file nodes resolved to their concept's
/// title and description), then the edges with their labels. Sections are left
/// out when empty. Groups are listed in file order, each with the nodes it holds
/// directly; a nested group appears as a member of its parent and again as a
/// section of its own.
pub fn canvas_outline(
    canvas: &Value,
    resolve: &dyn Fn(&str) -> Option<ResolvedFile>,
    path: Option<&str>,
) -> String {
    let empty: Vec<Value> = Vec::new();
    let nodes: Vec<&Map<String, Value>> =
        canvas.get("nodes").and_then(Value::as_array).unwrap_or(&empty).iter().filter_map(Value::as_object).collect();
    let edges: Vec<&Map<String, Value>> =
        canvas.get("edges").and_then(Value::as_array).unwrap_or(&empty).iter().filter_map(Value::as_object).collect();

    let mut lines: Vec<String> = vec![format!(
        "Canvas{}: {} node{}, {} edge{}",
        path.map(|p| format!(" {p}")).unwrap_or_default(),
        nodes.len(),
        plural(nodes.len()),
        edges.len(),
        plural(edges.len())
    )];

    let geos: Vec<Geo> = nodes.iter().map(|n| geo_of(n)).collect();
    let parents = group_parents(&geos);
    let members = |parent: i64| -> Vec<usize> {
        parents.iter().enumerate().filter(|(_, p)| **p == parent).map(|(i, _)| i).collect()
    };

    for (g, group) in nodes.iter().enumerate() {
        if node_type(group) != "group" {
            continue;
        }
        let held = members(g as i64);
        lines.push(String::new());
        lines.push(format!(
            "## Group [{}] {} ({} node{})",
            string_of(group, "id"),
            node_name(group, resolve),
            held.len(),
            plural(held.len())
        ));
        for i in held {
            lines.push(node_line(nodes[i], resolve));
        }
    }

    let loose: Vec<usize> = members(-1).into_iter().filter(|&i| node_type(nodes[i]) != "group").collect();
    if !loose.is_empty() {
        let any_group = nodes.iter().any(|n| node_type(n) == "group");
        lines.push(String::new());
        lines.push(format!("## {} ({})", if any_group { "Ungrouped" } else { "Nodes" }, loose.len()));
        for i in loose {
            lines.push(node_line(nodes[i], resolve));
        }
    }

    if !edges.is_empty() {
        let by_id: HashMap<&str, &Map<String, Value>> = {
            let mut m = HashMap::new();
            for n in &nodes {
                // `new Map(...)` keeps the last of a repeated id.
                m.insert(string_of(n, "id"), *n);
            }
            m
        };
        lines.push(String::new());
        lines.push(format!("## Edges ({})", edges.len()));
        for edge in &edges {
            let from = by_id.get(string_of(edge, "fromNode"));
            let to = by_id.get(string_of(edge, "toNode"));
            let from_arrow = edge.get("fromEnd").and_then(Value::as_str) == Some("arrow");
            let to_arrow = match edge.get("toEnd") {
                None => true,
                Some(v) => v.as_str() == Some("arrow"),
            };
            let arrow = match (from_arrow, to_arrow) {
                (true, true) => "<->",
                (false, true) => "->",
                (true, false) => "<-",
                (false, false) => "--",
            };
            let label = match edge.get("label") {
                Some(Value::String(l)) if !l.is_empty() => format!(" [{}]", clip(l, LABEL_CHARS)),
                _ => String::new(),
            };
            let name = |n: Option<&&Map<String, Value>>, fallback: &str| match n {
                Some(node) => node_name(node, resolve),
                None => fallback.to_string(),
            };
            lines.push(format!(
                "- {} {arrow} {}{label}",
                name(from, string_of(edge, "fromNode")),
                name(to, string_of(edge, "toNode"))
            ));
        }
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, extra: Value) -> Value {
        let mut base = json!({"id": id, "type": "text", "text": id, "x": 0, "y": 0, "width": 100, "height": 50});
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn valid_canvases_pass_and_unknown_keys_are_fine() {
        assert!(validate_canvas(&json!({})).is_empty());
        assert!(validate_canvas(&json!({"nodes": [], "edges": [], "metadata": {"a": 1}})).is_empty());
        let full = json!({
            "nodes": [
                node("a", json!({"color": "3", "extra": [1, 2]})),
                {"id": "f", "type": "file", "file": "wiki/x.md", "subpath": "#H", "x": -5, "y": 5, "width": 10, "height": 10, "color": "#FF00aa"},
                {"id": "l", "type": "link", "url": "https://example.com", "x": 0, "y": 0, "width": 10, "height": 10},
                {"id": "g", "type": "group", "label": "G", "backgroundStyle": "ratio", "x": 0, "y": 0, "width": 10, "height": 10}
            ],
            "edges": [{"id": "e", "fromNode": "a", "toNode": "f", "fromSide": "right", "toEnd": "arrow", "label": "x"}]
        });
        assert!(validate_canvas(&full).is_empty());
    }

    #[test]
    fn errors_say_where() {
        assert_eq!(validate_canvas(&json!([])), vec!["the canvas must be a JSON object"]);
        assert_eq!(validate_canvas(&json!({"nodes": {}})), vec!["nodes must be an array"]);
        assert_eq!(validate_canvas(&json!({"nodes": [5]})), vec!["nodes[0] must be an object"]);
        assert_eq!(
            validate_canvas(&json!({"nodes": [node("a", json!({"type": "image"}))]})),
            vec!["nodes[0].type must be text, file, link or group"]
        );
        assert_eq!(
            validate_canvas(&json!({"nodes": [node("a", json!({"x": 1.5}))]}))[0],
            "nodes[0].x must be an integer from -10000000 to 10000000"
        );
        assert_eq!(
            validate_canvas(&json!({"nodes": [node("a", json!({"width": 0}))]}))[0],
            "nodes[0].width must be an integer from 1 to 10000000"
        );
        assert_eq!(
            validate_canvas(&json!({"nodes": [node("a", json!({"color": "7"}))]}))[0],
            "nodes[0].color must be \"1\" to \"6\" or a #hex colour"
        );
        assert_eq!(validate_canvas(&json!({"nodes": [node("a", json!({})), node("a", json!({}))]})), vec!["nodes[1].id 'a' is used twice"]);
        let nodes = json!([node("a", json!({})), node("b", json!({}))]);
        assert_eq!(
            validate_canvas(&json!({"nodes": nodes, "edges": [{"id": "e", "fromNode": "a", "toNode": "zz"}]})),
            vec!["edges[0].toNode 'zz' is not a node"]
        );
    }

    #[test]
    fn errors_are_capped_in_the_message() {
        let errors: Vec<String> = (0..14).map(|i| format!("e{i}")).collect();
        assert_eq!(describe_canvas_errors(&errors), "e0; e1; e2; e3; e4; e5; e6; e7; e8; e9; and 4 more");
        assert_eq!(describe_canvas_errors(&["only".to_string()]), "only");
    }

    #[test]
    fn hostile_input_is_refused_by_size_then_depth_then_syntax() {
        assert_eq!(parse_canvas(""), Err(vec!["the content is not valid JSON".to_string()]));
        assert_eq!(
            parse_canvas(&"[".repeat(200_000)),
            Err(vec!["the canvas is nested deeper than 32 levels".to_string()])
        );
        assert_eq!(
            parse_canvas(&format!("{{\"x\":\"{}\"}}", "a".repeat(MAX_CANVAS_BYTES))),
            Err(vec![format!("the canvas is larger than {MAX_CANVAS_BYTES} bytes")])
        );
        let nodes: Vec<Value> = (0..=MAX_CANVAS_NODES).map(|i| node(&format!("n{i}"), json!({}))).collect();
        assert_eq!(
            parse_canvas(&json!({"nodes": nodes}).to_string()),
            Err(vec![format!("too many nodes: the limit is {MAX_CANVAS_NODES}")])
        );
        // Brackets inside strings do not count.
        assert!(parse_canvas(&json!({"nodes": [node("a", json!({"text": "[".repeat(100)}))]}).to_string()).is_ok());
    }

    #[test]
    fn groups_that_contain_each_other_cannot_loop() {
        let same = |g: bool| Geo { group: g, x: 0, y: 0, w: 500, h: 500 };
        let inner = Geo { group: false, x: 10, y: 10, w: 100, h: 50 };
        assert_eq!(group_parents(&[same(true), same(true), same(true), inner]), vec![-1, 0, 1, 2]);
    }

    #[test]
    fn outline_lists_groups_resolved_files_and_labelled_edges() {
        let canvas = json!({
            "nodes": [
                {"id": "g", "type": "group", "label": "Core", "x": 0, "y": 0, "width": 600, "height": 400},
                {"id": "a", "type": "file", "file": "wiki/3-resources/a.md", "x": 10, "y": 10, "width": 100, "height": 50},
                {"id": "b", "type": "text", "text": "\n\nIdea one\nsecond line", "x": 200, "y": 10, "width": 100, "height": 50},
                {"id": "c", "type": "link", "url": "https://example.com", "x": 900, "y": 0, "width": 100, "height": 50},
                {"id": "d", "type": "file", "file": "wiki/missing.md", "subpath": "#H", "x": 900, "y": 100, "width": 100, "height": 50}
            ],
            "edges": [
                {"id": "e1", "fromNode": "a", "toNode": "b"},
                {"id": "e2", "fromNode": "b", "toNode": "c", "label": "depends_on", "toEnd": "none"},
                {"id": "e3", "fromNode": "c", "toNode": "a", "fromEnd": "arrow"},
                {"id": "e4", "fromNode": "c", "toNode": "d", "fromEnd": "arrow", "toEnd": "none", "label": ""}
            ]
        });
        let resolve = |file: &str| {
            (file == "wiki/3-resources/a.md")
                .then(|| ResolvedFile { title: "Alpha".into(), description: Some("The first".into()) })
        };
        assert_eq!(
            canvas_outline(&canvas, &resolve, Some("wiki/c.canvas")),
            [
                "Canvas wiki/c.canvas: 5 nodes, 4 edges",
                "",
                "## Group [g] Core (2 nodes)",
                "- [a] file wiki/3-resources/a.md — Alpha: The first",
                "- [b] text \"Idea one\"",
                "",
                "## Ungrouped (2)",
                "- [c] link https://example.com",
                "- [d] file wiki/missing.md#H (not found)",
                "",
                "## Edges (4)",
                "- Alpha -> \"Idea one\"",
                "- \"Idea one\" -- https://example.com [depends_on]",
                "- https://example.com <-> Alpha",
                "- https://example.com <- wiki/missing.md",
            ]
            .join("\n")
        );
    }

    #[test]
    fn whole_floats_print_like_js_integers() {
        let v: Value = serde_json::from_str(r#"{"a": 5.0, "b": [1.5, 2.0]}"#).unwrap();
        assert_eq!(js_numbers(&v).to_string(), r#"{"a":5,"b":[1.5,2]}"#);
    }
}
