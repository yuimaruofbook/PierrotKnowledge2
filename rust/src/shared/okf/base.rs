//! Bases: `.base` files as list and aggregate views over the concepts
//! (`src/shared/okf/base.ts`).
//!
//! A `.base` file is YAML in the format Obsidian Bases reads. This module
//! checks a parsed document and runs one view of it over a set of concepts
//! into rows, groups and summaries. The TS file documents the supported
//! subset; both must give the same rows, the same JSON and the same messages.

use super::base_expr::{
    aggregate, check_expr, compare_values, display, formula_refs, num_str, parse_date, parse_expr,
    to_json, truthy, values_equal, BaseRow, EvalEnv, EvalError, Evaluator, Expr, Findings, Value,
    EVAL_STEP_BUDGET, FILE_PROPS, MAX_FORMULA_DEPTH, UNSUPPORTED_FILE_PROPS,
};
use crate::shared::js_compat::locale_compare;
use indexmap::IndexMap;
use serde_json::{Map, Value as Json};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

/// The file name a base must have.
pub const BASE_EXT: &str = ".base";

/// Where the example base for new bundles lives.
pub const BASES_DIR: &str = "bases";
pub const BASES_TITLE: &str = "Bases";

/// Rows an answer never exceeds, whatever the view or the caller asks for.
pub const MAX_ROWS: usize = 500;

pub fn is_base_path(path: &str) -> bool {
    path.to_lowercase().ends_with(BASE_EXT)
}

// ---- compiled form -------------------------------------------------------------

enum FilterNode {
    Expr(Expr),
    And(Vec<FilterNode>),
    Or(Vec<FilterNode>),
    Not(Vec<FilterNode>),
}

struct SortKey {
    property: String,
    desc: bool,
}

struct CompiledView {
    name: String,
    kind: String,
    supported: bool,
    filter: Option<FilterNode>,
    order: Vec<String>,
    sort: Vec<SortKey>,
    limit: Option<f64>,
    group_by: Option<SortKey>,
    summaries: IndexMap<String, String>,
}

struct Compiled {
    filter: Option<FilterNode>,
    formulas: IndexMap<String, Expr>,
    display_names: HashMap<String, String>,
    summaries: IndexMap<String, Expr>,
    views: Vec<CompiledView>,
}

const DEFAULT_SUMMARIES: [&str; 15] = [
    "Count",
    "Average",
    "Min",
    "Max",
    "Sum",
    "Range",
    "Median",
    "Stddev",
    "Earliest",
    "Latest",
    "Checked",
    "Unchecked",
    "Empty",
    "Filled",
    "Unique",
];

type Dict = Map<String, Json>;

/// `undefined` and `null` both mean "not written".
fn present(v: Option<&Json>) -> Option<&Json> {
    v.filter(|x| !x.is_null())
}

fn implicit_view() -> CompiledView {
    CompiledView {
        name: "Table".into(),
        kind: "table".into(),
        supported: true,
        filter: None,
        order: Vec::new(),
        sort: Vec::new(),
        limit: None,
        group_by: None,
        summaries: IndexMap::new(),
    }
}

/// One expression: parsed, and its static findings recorded under `where_`.
fn compile_expr(
    src: &str,
    where_: &str,
    formulas: &HashSet<String>,
    out: &mut Findings,
) -> Option<Expr> {
    let expr = match parse_expr(src) {
        Ok(e) => e,
        Err(e) => {
            out.errors.push(format!("{where_}: {}", e.0));
            return None;
        }
    };
    let mut found = Findings::default();
    check_expr(&expr, formulas, &mut found);
    out.errors
        .extend(found.errors.iter().map(|m| format!("{where_}: {m}")));
    out.warnings
        .extend(found.warnings.iter().map(|m| format!("{where_}: {m}")));
    Some(expr)
}

fn compile_filter(
    node: &Json,
    where_: &str,
    formulas: &HashSet<String>,
    out: &mut Findings,
) -> Option<FilterNode> {
    match node {
        Json::String(src) => compile_expr(src, where_, formulas, out).map(FilterNode::Expr),
        Json::Object(map) => {
            let unknown: Vec<&String> = map
                .keys()
                .filter(|k| !matches!(k.as_str(), "and" | "or" | "not"))
                .collect();
            for k in &unknown {
                out.errors
                    .push(format!("{where_}: unknown key '{k}' (use and, or, not)"));
            }
            if !unknown.is_empty() {
                return None;
            }
            if map.len() != 1 {
                out.errors.push(format!(
                    "{where_}: must have exactly one key (and, or, not)"
                ));
                return None;
            }
            let (key, list) = map.iter().next()?;
            let Json::Array(list) = list else {
                out.errors.push(format!("{where_}.{key}: must be a list"));
                return None;
            };
            let mut items = Vec::new();
            for (i, item) in list.iter().enumerate() {
                if let Some(child) =
                    compile_filter(item, &format!("{where_}.{key}[{i}]"), formulas, out)
                {
                    items.push(child);
                }
            }
            Some(match key.as_str() {
                "and" => FilterNode::And(items),
                "or" => FilterNode::Or(items),
                _ => FilterNode::Not(items),
            })
        }
        _ => {
            out.errors.push(format!(
                "{where_}: must be an expression or an and / or / not mapping"
            ));
            None
        }
    }
}

/// A property id in `order`, `sort`, `groupBy` or `summaries`, checked statically.
fn check_property(id: &str, where_: &str, formulas: &HashSet<String>, out: &mut Findings) {
    if let Some(name) = id.strip_prefix("file.") {
        if UNSUPPORTED_FILE_PROPS.contains(&name) {
            out.warnings
                .push(format!("{where_}: file.{name} is not supported"));
        } else if !FILE_PROPS.contains(&name) {
            out.warnings.push(format!(
                "{where_}: file.{name} is not a known file property"
            ));
        }
    } else if let Some(name) = id.strip_prefix("formula.") {
        if !formulas.contains(name) {
            out.warnings
                .push(format!("{where_}: formula.{name} is not defined"));
        }
    }
}

fn compile_sort(
    raw: &Json,
    where_: &str,
    formulas: &HashSet<String>,
    out: &mut Findings,
) -> Option<SortKey> {
    let property = raw
        .as_object()
        .and_then(|m| m.get("property"))
        .and_then(Json::as_str);
    let Some(property) = property else {
        out.errors.push(format!("{where_}: property is required"));
        return None;
    };
    let dir = raw.as_object().and_then(|m| m.get("direction"));
    let is_dir = |s: &str| s.eq_ignore_ascii_case("asc") || s.eq_ignore_ascii_case("desc");
    if let Some(d) = dir {
        if !matches!(d, Json::String(s) if is_dir(s)) {
            out.errors
                .push(format!("{where_}: direction must be ASC or DESC"));
            return None;
        }
    }
    check_property(property, where_, formulas, out);
    let desc = matches!(dir, Some(Json::String(s)) if s.eq_ignore_ascii_case("desc"));
    Some(SortKey {
        property: property.to_string(),
        desc,
    })
}

fn is_positive_integer(v: &Json) -> Option<f64> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && n >= 1.0).then_some(n)
}

/// The formulas that can reach themselves (Tarjan's strongly connected components,
/// iterative so a long chain cannot overflow the stack). `refs[i]` are the formulas `i` refers to.
fn formulas_in_cycles(refs: &[Vec<usize>]) -> Vec<bool> {
    let n = refs.len();
    let mut index = vec![usize::MAX; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut cyclic = vec![false; n];
    let mut counter = 0usize;
    for root in 0..n {
        if index[root] != usize::MAX {
            continue;
        }
        let mut work: Vec<(usize, usize)> = Vec::new();
        index[root] = counter;
        low[root] = counter;
        counter += 1;
        stack.push(root);
        on_stack[root] = true;
        work.push((root, 0));
        while let Some(&(node, i)) = work.last() {
            if i < refs[node].len() {
                if let Some(top) = work.last_mut() {
                    top.1 += 1;
                }
                let next = refs[node][i];
                if index[next] == usize::MAX {
                    index[next] = counter;
                    low[next] = counter;
                    counter += 1;
                    stack.push(next);
                    on_stack[next] = true;
                    work.push((next, 0));
                } else if on_stack[next] {
                    low[node] = low[node].min(index[next]);
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                low[parent] = low[parent].min(low[node]);
            }
            if low[node] == index[node] {
                let mut members = Vec::new();
                while let Some(top) = stack.pop() {
                    on_stack[top] = false;
                    members.push(top);
                    if top == node {
                        break;
                    }
                }
                if members.len() > 1 || refs[node].contains(&node) {
                    for m in members {
                        cyclic[m] = true;
                    }
                }
            }
        }
    }
    cyclic
}

/// How many formulas deep each one goes (itself included); the graph must have no cycle.
fn formula_depths(refs: &[Vec<usize>]) -> Vec<usize> {
    let n = refs.len();
    let mut depth = vec![0usize; n];
    for root in 0..n {
        if depth[root] != 0 {
            continue;
        }
        let mut work: Vec<(usize, usize)> = vec![(root, 0)];
        while let Some(&(node, i)) = work.last() {
            if i < refs[node].len() {
                if let Some(top) = work.last_mut() {
                    top.1 += 1;
                }
                let next = refs[node][i];
                if depth[next] == 0 {
                    work.push((next, 0));
                }
                continue;
            }
            depth[node] = 1 + refs[node].iter().map(|&m| depth[m]).max().unwrap_or(0);
            work.pop();
        }
    }
    depth
}

/// Check a parsed `.base` document and, when it is usable, compile it.
fn compile(value: &Json) -> (Findings, Option<Compiled>) {
    let mut found = Findings::default();
    let empty = Dict::new();
    let root: &Dict = match value {
        Json::Null => &empty,
        Json::Object(m) => m,
        _ => {
            found.errors.push("a base must be a YAML mapping".into());
            return (found, None);
        }
    };

    // Formula names first: every expression is checked against them.
    let formula_src = present(root.get("formulas"));
    let mut formulas: IndexMap<String, Expr> = IndexMap::new();
    let mut formula_names: HashSet<String> = HashSet::new();
    if let Some(src) = formula_src {
        match src {
            Json::Object(m) => formula_names.extend(m.keys().cloned()),
            _ => found
                .errors
                .push("formulas: must be a mapping of name to expression".into()),
        }
    }

    let filter = match present(root.get("filters")) {
        None => None,
        Some(node) => compile_filter(node, "filters", &formula_names, &mut found),
    };

    if let Some(Json::Object(src)) = formula_src {
        for (name, expr_src) in src {
            let Json::String(text) = expr_src else {
                found
                    .errors
                    .push(format!("formulas.{name}: must be an expression string"));
                continue;
            };
            if let Some(expr) = compile_expr(
                text,
                &format!("formulas.{name}"),
                &formula_names,
                &mut found,
            ) {
                formulas.insert(name.clone(), expr);
            }
        }
        let refs: Vec<Vec<usize>> = formulas
            .values()
            .map(|expr| {
                let mut names = Vec::new();
                formula_refs(expr, &mut names);
                names
                    .iter()
                    .filter_map(|n| formulas.get_index_of(n))
                    .collect()
            })
            .collect();
        let cyclic = formulas_in_cycles(&refs);
        for (i, name) in formulas.keys().enumerate() {
            if cyclic[i] {
                found
                    .errors
                    .push(format!("formulas.{name}: circular reference"));
            }
        }
        // Chains that are too long would recurse too deeply when evaluated.
        if !cyclic.iter().any(|&c| c) {
            let depth = formula_depths(&refs);
            if let Some(i) = depth.iter().position(|&d| d > MAX_FORMULA_DEPTH) {
                if let Some(name) = formulas.get_index(i).map(|(k, _)| k) {
                    found.errors.push(format!(
                        "formulas.{name}: references are nested more than {MAX_FORMULA_DEPTH} deep"
                    ));
                }
            }
        }
    }

    let mut display_names = HashMap::new();
    if let Some(props) = present(root.get("properties")) {
        match props {
            Json::Object(m) => {
                for (id, conf) in m {
                    if let Some(name) = conf
                        .as_object()
                        .and_then(|c| c.get("displayName"))
                        .and_then(Json::as_str)
                    {
                        display_names.insert(id.clone(), name.to_string());
                    }
                }
            }
            _ => found.errors.push("properties: must be a mapping".into()),
        }
    }

    let mut custom: IndexMap<String, Expr> = IndexMap::new();
    if let Some(sums) = present(root.get("summaries")) {
        match sums {
            Json::Object(m) => {
                for (name, src) in m {
                    let Json::String(text) = src else {
                        found
                            .errors
                            .push(format!("summaries.{name}: must be an expression string"));
                        continue;
                    };
                    if let Some(expr) = compile_expr(
                        text,
                        &format!("summaries.{name}"),
                        &formula_names,
                        &mut found,
                    ) {
                        custom.insert(name.clone(), expr);
                    }
                }
            }
            _ => found
                .errors
                .push("summaries: must be a mapping of name to expression".into()),
        }
    }

    let mut views: Vec<CompiledView> = Vec::new();
    let raw_views = present(root.get("views"));
    match raw_views {
        None => {}
        Some(Json::Array(list)) => {
            for (i, raw) in list.iter().enumerate() {
                let at = format!("views[{i}]");
                let Json::Object(map) = raw else {
                    found.errors.push(format!("{at}: must be a mapping"));
                    continue;
                };
                let kind = match map.get("type") {
                    Some(Json::String(t)) if !t.is_empty() => t.clone(),
                    _ => {
                        found.errors.push(format!("{at}: type is required"));
                        continue;
                    }
                };
                let mut view = implicit_view();
                view.kind = kind.clone();
                view.name = match map.get("name") {
                    Some(Json::String(n)) if !n.is_empty() => n.clone(),
                    _ => format!("View {}", i + 1),
                };
                if let Some(n) = present(map.get("name")) {
                    if !n.is_string() {
                        found.errors.push(format!("{at}.name: must be text"));
                    }
                }
                view.supported = kind == "table" || kind == "cards";
                if !view.supported {
                    found.warnings.push(format!(
                        "{at}: type '{kind}' is not supported (table and cards only)"
                    ));
                    views.push(view);
                    continue;
                }

                if let Some(f) = present(map.get("filters")) {
                    view.filter =
                        compile_filter(f, &format!("{at}.filters"), &formula_names, &mut found);
                }
                if let Some(order) = present(map.get("order")) {
                    match order {
                        Json::Array(ids) if ids.iter().all(Json::is_string) => {
                            view.order = ids
                                .iter()
                                .filter_map(|x| x.as_str().map(str::to_string))
                                .collect();
                            for (j, id) in view.order.iter().enumerate() {
                                check_property(
                                    id,
                                    &format!("{at}.order[{j}]"),
                                    &formula_names,
                                    &mut found,
                                );
                            }
                        }
                        _ => found
                            .errors
                            .push(format!("{at}.order: must be a list of property names")),
                    }
                }
                if let Some(sort) = present(map.get("sort")) {
                    match sort {
                        Json::Array(list) => {
                            for (j, s) in list.iter().enumerate() {
                                if let Some(key) = compile_sort(
                                    s,
                                    &format!("{at}.sort[{j}]"),
                                    &formula_names,
                                    &mut found,
                                ) {
                                    view.sort.push(key);
                                }
                            }
                        }
                        _ => found.errors.push(format!("{at}.sort: must be a list")),
                    }
                }
                if let Some(limit) = present(map.get("limit")) {
                    match is_positive_integer(limit) {
                        Some(n) => view.limit = Some(n),
                        None => found
                            .errors
                            .push(format!("{at}.limit: must be a positive integer")),
                    }
                }
                if let Some(group) = present(map.get("groupBy")) {
                    let has_property = group
                        .as_object()
                        .is_some_and(|g| g.get("property").is_some_and(Json::is_string));
                    if !has_property {
                        found
                            .errors
                            .push(format!("{at}.groupBy: must be a mapping with a property"));
                    } else {
                        view.group_by = compile_sort(
                            group,
                            &format!("{at}.groupBy"),
                            &formula_names,
                            &mut found,
                        );
                    }
                }
                if let Some(sums) = present(map.get("summaries")) {
                    match sums {
                        Json::Object(m) => {
                            for (id, name) in m {
                                let known = name.as_str().filter(|n| {
                                    DEFAULT_SUMMARIES.contains(n) || custom.contains_key(*n)
                                });
                                match known {
                                    Some(n) => {
                                        view.summaries.insert(id.clone(), n.to_string());
                                        check_property(
                                            id,
                                            &format!("{at}.summaries.{id}"),
                                            &formula_names,
                                            &mut found,
                                        );
                                    }
                                    None => found.errors.push(format!(
                                        "{at}.summaries.{id}: unknown summary '{}'",
                                        js_string(name)
                                    )),
                                }
                            }
                        }
                        _ => found.errors.push(format!(
                            "{at}.summaries: must be a mapping of property to summary name"
                        )),
                    }
                }
                views.push(view);
            }
        }
        Some(_) => found.errors.push("views: must be a list".into()),
    }
    let no_views = match raw_views {
        None => true,
        Some(Json::Array(list)) => list.is_empty(),
        _ => false,
    };
    if views.is_empty() && no_views {
        views.push(implicit_view());
    }

    if !found.errors.is_empty() {
        return (found, None);
    }
    (
        found,
        Some(Compiled {
            filter,
            formulas,
            display_names,
            summaries: custom,
            views,
        }),
    )
}

/// JS `String(value)` for the one place a summary name of any type is quoted.
fn js_string(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Null => "null".into(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => num_str(n.as_f64().unwrap_or(f64::NAN)),
        Json::Array(items) => items
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Json::Object(_) => "[object Object]".into(),
    }
}

/// Errors stop a write; warnings are for the author to read.
pub fn validate_base(value: &Json) -> Findings {
    compile(value).0
}

/// The views a parsed base offers, read leniently (for listings).
pub fn list_views(value: &Json) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(Json::Array(views)) = value.as_object().and_then(|m| m.get("views")) {
        for (i, raw) in views.iter().enumerate() {
            let Json::Object(map) = raw else { continue };
            let name = match map.get("name") {
                Some(Json::String(n)) if !n.is_empty() => n.clone(),
                _ => format!("View {}", i + 1),
            };
            let kind = match map.get("type") {
                Some(Json::String(t)) if !t.is_empty() => t.clone(),
                _ => "unknown".to_string(),
            };
            out.push((name, kind));
        }
    }
    if out.is_empty() {
        out.push(("Table".into(), "table".into()));
    }
    out
}

// ---- running a view ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct BaseColumn {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BaseResultRow {
    pub path: String,
    pub cells: Vec<Json>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BaseSummary {
    pub column: String,
    pub summary: String,
    pub value: Json,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BaseGroup {
    pub key: Json,
    pub label: String,
    /// Every row of the group, whether or not the row cap let them all be listed.
    pub count: usize,
    /// Set when the row cap cut this group's `rows` short of `count`.
    pub truncated: bool,
    pub rows: Vec<BaseResultRow>,
    pub summaries: Vec<BaseSummary>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BaseResult {
    pub view: String,
    pub kind: String,
    pub columns: Vec<BaseColumn>,
    /// Rows that matched the filters, before any limit.
    pub total: usize,
    pub shown: usize,
    pub rows: Option<Vec<BaseResultRow>>,
    pub groups: Option<Vec<BaseGroup>>,
    pub summaries: Vec<BaseSummary>,
    pub warnings: Vec<String>,
}

fn row_json(r: &BaseResultRow) -> Json {
    let mut m = Map::new();
    m.insert("path".into(), Json::String(r.path.clone()));
    m.insert("cells".into(), Json::Array(r.cells.clone()));
    Json::Object(m)
}

fn summary_json(s: &BaseSummary) -> Json {
    let mut m = Map::new();
    m.insert("column".into(), Json::String(s.column.clone()));
    m.insert("summary".into(), Json::String(s.summary.clone()));
    m.insert("value".into(), s.value.clone());
    Json::Object(m)
}

impl BaseResult {
    /// The JSON the tool returns, keys in the order the TS builds them.
    pub fn to_map(&self) -> Map<String, Json> {
        let mut m = Map::new();
        m.insert("view".into(), Json::String(self.view.clone()));
        m.insert("type".into(), Json::String(self.kind.clone()));
        m.insert(
            "columns".into(),
            Json::Array(
                self.columns
                    .iter()
                    .map(|c| {
                        let mut x = Map::new();
                        x.insert("id".into(), Json::String(c.id.clone()));
                        x.insert("name".into(), Json::String(c.name.clone()));
                        Json::Object(x)
                    })
                    .collect(),
            ),
        );
        m.insert("total".into(), Json::from(self.total as u64));
        m.insert("shown".into(), Json::from(self.shown as u64));
        if let Some(groups) = &self.groups {
            m.insert(
                "groups".into(),
                Json::Array(
                    groups
                        .iter()
                        .map(|g| {
                            let mut x = Map::new();
                            x.insert("key".into(), g.key.clone());
                            x.insert("label".into(), Json::String(g.label.clone()));
                            x.insert("count".into(), Json::from(g.count as u64));
                            if g.truncated {
                                x.insert("truncated".into(), Json::Bool(true));
                            }
                            x.insert(
                                "rows".into(),
                                Json::Array(g.rows.iter().map(row_json).collect()),
                            );
                            x.insert(
                                "summaries".into(),
                                Json::Array(g.summaries.iter().map(summary_json).collect()),
                            );
                            Json::Object(x)
                        })
                        .collect(),
                ),
            );
        }
        if let Some(rows) = &self.rows {
            m.insert(
                "rows".into(),
                Json::Array(rows.iter().map(row_json).collect()),
            );
        }
        m.insert(
            "summaries".into(),
            Json::Array(self.summaries.iter().map(summary_json).collect()),
        );
        if !self.warnings.is_empty() {
            m.insert(
                "warnings".into(),
                Json::Array(self.warnings.iter().cloned().map(Json::String).collect()),
            );
        }
        m
    }
}

pub struct RunOptions<'a> {
    pub view: Option<&'a str>,
    pub limit: Option<usize>,
    /// The clock, in epoch milliseconds; injected so tests are exact.
    pub now: f64,
}

fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Str(s) => s.is_empty(),
        Value::List(l) => l.is_empty(),
        Value::Obj(o) => o.is_empty(),
        _ => false,
    }
}

fn date_of(v: &Value) -> Option<f64> {
    match v {
        Value::Date(ms) => Some(*ms),
        Value::Str(s) => parse_date(s),
        _ => None,
    }
}

fn run_summary(
    name: &str,
    values: &[Value],
    custom: Option<&Expr>,
    ev: Option<&mut Evaluator>,
) -> Result<Value, EvalError> {
    if let Some(expr) = custom {
        return match ev {
            Some(ev) => ev.eval(
                expr,
                &mut vec![vec![("values".to_string(), Value::List(values.to_vec()))]],
            ),
            None => Ok(Value::Null),
        };
    }
    let nums: Vec<f64> = values
        .iter()
        .filter_map(|v| match v {
            Value::Num(n) if n.is_finite() => Some(*n),
            _ => None,
        })
        .collect();
    let num = |x: Option<f64>| x.map_or(Value::Null, Value::Num);
    Ok(match name {
        "Count" => Value::Num(values.len() as f64),
        "Average" => num(aggregate("mean", &nums)),
        "Min" => num(aggregate("min", &nums)),
        "Max" => num(aggregate("max", &nums)),
        "Sum" => num(aggregate("sum", &nums)),
        "Median" => num(aggregate("median", &nums)),
        "Stddev" => num(aggregate("stddev", &nums)),
        "Range" => match (aggregate("min", &nums), aggregate("max", &nums)) {
            (Some(lo), Some(hi)) => Value::Num(hi - lo),
            _ => Value::Null,
        },
        "Earliest" | "Latest" => {
            let dates: Vec<f64> = values.iter().filter_map(date_of).collect();
            let mut it = dates.into_iter();
            match it.next() {
                None => Value::Null,
                Some(first) => Value::Date(it.fold(first, |a, b| {
                    if name == "Earliest" {
                        if b < a {
                            b
                        } else {
                            a
                        }
                    } else if b > a {
                        b
                    } else {
                        a
                    }
                })),
            }
        }
        "Checked" => Value::Num(
            values
                .iter()
                .filter(|v| matches!(v, Value::Bool(true)))
                .count() as f64,
        ),
        "Unchecked" => Value::Num(
            values
                .iter()
                .filter(|v| matches!(v, Value::Bool(false)))
                .count() as f64,
        ),
        "Empty" => Value::Num(values.iter().filter(|v| is_empty_value(v)).count() as f64),
        "Filled" => Value::Num(values.iter().filter(|v| !is_empty_value(v)).count() as f64),
        _ => {
            // Unique: distinct non-empty values.
            let mut seen: Vec<&Value> = Vec::new();
            for v in values {
                if !is_empty_value(v) && !seen.iter().any(|s| values_equal(s, v)) {
                    seen.push(v);
                }
            }
            Value::Num(seen.len() as f64)
        }
    })
}

fn pick_view<'a>(c: &'a Compiled, wanted: Option<&str>) -> Result<&'a CompiledView, String> {
    let Some(wanted) = wanted else {
        return Ok(&c.views[0]);
    };
    c.views.iter().find(|v| v.name == wanted).ok_or_else(|| {
        format!(
            "view '{wanted}' not found; available: {}",
            c.views
                .iter()
                .map(|v| v.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

fn guard<T>(
    warnings: &RefCell<Vec<String>>,
    where_: &str,
    fallback: T,
    result: Result<T, EvalError>,
) -> T {
    match result {
        Ok(v) => v,
        Err(EvalError(message)) => {
            let line = format!("{where_}: {message}");
            let mut list = warnings.borrow_mut();
            if !list.contains(&line) {
                list.push(line);
            }
            fallback
        }
    }
}

fn passes(
    node: &Option<FilterNode>,
    idx: usize,
    evs: &mut [Evaluator],
    warnings: &RefCell<Vec<String>>,
) -> bool {
    match node {
        None => true,
        Some(n) => passes_node(n, idx, evs, warnings),
    }
}

fn passes_node(
    node: &FilterNode,
    idx: usize,
    evs: &mut [Evaluator],
    warnings: &RefCell<Vec<String>>,
) -> bool {
    match node {
        FilterNode::Expr(expr) => {
            let result = evs[idx].eval(expr, &mut Vec::new()).map(|v| truthy(&v));
            guard(warnings, "filter", false, result)
        }
        FilterNode::And(items) => items.iter().all(|n| passes_node(n, idx, evs, warnings)),
        FilterNode::Or(items) => items.iter().any(|n| passes_node(n, idx, evs, warnings)),
        FilterNode::Not(items) => !items.iter().any(|n| passes_node(n, idx, evs, warnings)),
    }
}

/// Run one view of a parsed base over concepts. `Err` is the `BaseError` message.
pub fn run_base(
    value: &Json,
    concepts: &[BaseRow],
    options: &RunOptions,
) -> Result<BaseResult, String> {
    let (found, compiled) = compile(value);
    let Some(compiled) = compiled else {
        return Err(format!("invalid base: {}", found.errors.join("; ")));
    };
    let view = pick_view(&compiled, options.view)?;
    if !view.supported {
        return Err(format!(
            "view '{}' has type '{}', which is not supported (table and cards only)",
            view.name, view.kind
        ));
    }

    let warnings: RefCell<Vec<String>> = RefCell::new(Vec::new());
    // One budget for the whole query, so a hostile base ends in warnings, not a hang.
    let env = EvalEnv {
        now: options.now,
        formulas: Some(&compiled.formulas),
        warnings: Some(&warnings),
        budget: Cell::new(EVAL_STEP_BUDGET),
    };

    let mut rows: Vec<&BaseRow> = concepts.iter().collect();
    rows.sort_by(|a, b| locale_compare(&a.path, &b.path));
    let mut evs: Vec<Evaluator> = rows.iter().map(|r| Evaluator::new(r, &env)).collect();

    // 1. filters: global, then the view's own.
    let mut kept: Vec<usize> = Vec::new();
    for i in 0..rows.len() {
        if passes(&compiled.filter, i, &mut evs, &warnings)
            && passes(&view.filter, i, &mut evs, &warnings)
        {
            kept.push(i);
        }
    }
    let total = kept.len();

    // 2. sort (grouping is the outermost key).
    let keys: Vec<&SortKey> = view.group_by.iter().chain(view.sort.iter()).collect();
    let mut key_values: Vec<Vec<Value>> = vec![Vec::new(); rows.len()];
    for &i in &kept {
        key_values[i] = keys
            .iter()
            .map(|k| {
                let result = evs[i].property(&k.property);
                guard(
                    &warnings,
                    &format!("sort {}", k.property),
                    Value::Null,
                    result,
                )
            })
            .collect();
    }
    kept.sort_by(|&a, &b| {
        for (n, key) in keys.iter().enumerate() {
            let (x, y) = (&key_values[a][n], &key_values[b][n]);
            // An empty value goes last whichever way the key runs: a gap is not the biggest or smallest.
            let c = match (x, y) {
                (Value::Null, Value::Null) => 0,
                (Value::Null, _) => 1,
                (_, Value::Null) => -1,
                _ if key.desc => -compare_values(x, y),
                _ => compare_values(x, y),
            };
            if c != 0 {
                return c.cmp(&0);
            }
        }
        locale_compare(&rows[a].path, &rows[b].path)
    });

    // 3. limit: the view's, the caller's and the hard cap, whichever is smallest.
    // It caps the rows listed; counts and summaries still cover every match.
    let cap = MAX_ROWS
        .min(view.limit.map_or(MAX_ROWS, |l| l as usize))
        .min(options.limit.unwrap_or(MAX_ROWS));
    let shown: Vec<usize> = kept.iter().copied().take(cap).collect();
    let mut is_shown = vec![false; rows.len()];
    for &i in &shown {
        is_shown[i] = true;
    }

    // 4. cells.
    let order: Vec<String> = if view.order.is_empty() {
        vec!["file.name".to_string()]
    } else {
        view.order.clone()
    };
    let columns: Vec<BaseColumn> = order
        .iter()
        .map(|id| BaseColumn {
            id: id.clone(),
            name: compiled.display_names.get(id).cloned().unwrap_or_else(|| {
                if let Some(rest) = id.strip_prefix("note.") {
                    rest.to_string()
                } else if let Some(rest) = id.strip_prefix("formula.") {
                    rest.to_string()
                } else {
                    id.clone()
                }
            }),
        })
        .collect();
    // A row that is not listed only needs the columns that have a summary.
    let mut cells: Vec<Vec<Value>> = vec![Vec::new(); rows.len()];
    for &i in &kept {
        cells[i] = order
            .iter()
            .map(|id| {
                if is_shown[i] || view.summaries.contains_key(id) {
                    let result = evs[i].property(id);
                    guard(&warnings, &format!("column {id}"), Value::Null, result)
                } else {
                    Value::Null
                }
            })
            .collect();
    }
    let result_row = |i: usize| BaseResultRow {
        path: rows[i].path.clone(),
        cells: cells[i].iter().map(to_json).collect(),
    };

    // 5. summaries, over the rows given (every match, not just the listed ones).
    let summarize = |subset: &[usize], evs: &mut Vec<Evaluator>| -> Vec<BaseSummary> {
        let mut out = Vec::new();
        for (col, id) in order.iter().enumerate() {
            let Some(name) = view.summaries.get(id) else {
                continue;
            };
            let values: Vec<Value> = subset.iter().map(|&i| cells[i][col].clone()).collect();
            let custom = compiled.summaries.get(name);
            let probe = subset
                .first()
                .copied()
                .or(if rows.is_empty() { None } else { Some(0) });
            let result = run_summary(name, &values, custom, probe.map(|p| &mut evs[p]));
            let v = guard(&warnings, &format!("summary {name}"), Value::Null, result);
            out.push(BaseSummary {
                column: id.clone(),
                summary: name.clone(),
                value: to_json(&v),
            });
        }
        out
    };

    let (mut out_rows, mut out_groups) = (None, None);
    if view.group_by.is_some() {
        let mut buckets: Vec<(Value, Vec<usize>)> = Vec::new();
        for &i in &kept {
            let key = key_values[i][0].clone();
            match buckets.last_mut() {
                Some((current, members)) if compare_values(current, &key) == 0 => members.push(i),
                _ => buckets.push((key, vec![i])),
            }
        }
        let mut groups = Vec::new();
        for (key, members) in &buckets {
            // The listed rows are a prefix of the sorted matches, so each group lists its first members.
            let listed: Vec<usize> = members.iter().copied().filter(|&i| is_shown[i]).collect();
            groups.push(BaseGroup {
                key: to_json(key),
                label: if matches!(key, Value::Null) {
                    "(empty)".to_string()
                } else {
                    display(key)
                },
                count: members.len(),
                truncated: listed.len() < members.len(),
                rows: listed.iter().map(|&i| result_row(i)).collect(),
                summaries: summarize(members, &mut evs),
            });
        }
        out_groups = Some(groups);
    } else {
        out_rows = Some(shown.iter().map(|&i| result_row(i)).collect());
    }
    let summaries = summarize(&kept, &mut evs);

    let warnings = warnings.borrow().clone();
    Ok(BaseResult {
        view: view.name.clone(),
        kind: view.kind.clone(),
        columns,
        total,
        shown: shown.len(),
        rows: out_rows,
        groups: out_groups,
        summaries,
        warnings,
    })
}

// ---- markdown ---------------------------------------------------------------------

fn cell_text(v: &Json) -> String {
    let s = match v {
        Json::Null => String::new(),
        Json::Number(n) => num_str(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => s.clone(),
        Json::Bool(b) => b.to_string(),
        Json::Array(items) => items.iter().map(cell_text).collect::<Vec<_>>().join(", "),
        Json::Object(_) => serde_json::to_string(v).unwrap_or_default(),
    };
    // `|` would split a cell; a line break would end the row.
    s.replace('|', "\\|")
        .replace("\r\n", " ")
        .replace(['\r', '\n'], " ")
}

/// A compact rendering for agents: one table per group, summaries beneath.
pub fn render_base_markdown(result: &BaseResult) -> String {
    let names: HashMap<&str, &str> = result
        .columns
        .iter()
        .map(|c| (c.id.as_str(), c.name.as_str()))
        .collect();
    let table = |rows: &[BaseResultRow]| -> Vec<String> {
        let mut lines = vec![
            format!(
                "| {} |",
                result
                    .columns
                    .iter()
                    .map(|c| cell_text(&Json::String(c.name.clone())))
                    .collect::<Vec<_>>()
                    .join(" | ")
            ),
            format!(
                "| {} |",
                result
                    .columns
                    .iter()
                    .map(|_| "---")
                    .collect::<Vec<_>>()
                    .join(" | ")
            ),
        ];
        for r in rows {
            lines.push(format!(
                "| {} |",
                r.cells
                    .iter()
                    .map(cell_text)
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));
        }
        lines
    };
    let summary_line = |list: &[BaseSummary]| -> Vec<String> {
        if list.is_empty() {
            return Vec::new();
        }
        let parts: Vec<String> = list
            .iter()
            .map(|s| {
                format!(
                    "{} {} = {}",
                    names
                        .get(s.column.as_str())
                        .copied()
                        .unwrap_or(s.column.as_str()),
                    s.summary,
                    cell_text(&s.value)
                )
            })
            .collect();
        vec![String::new(), format!("Summary: {}", parts.join("; "))]
    };

    let mut out: Vec<String> = vec![
        format!(
            "**{}** ({}) - {} of {} rows",
            result.view, result.kind, result.shown, result.total
        ),
        String::new(),
    ];
    if result.shown == 0 {
        out.push("(no rows)".into());
    } else if let Some(groups) = &result.groups {
        for (i, g) in groups.iter().enumerate() {
            if i > 0 {
                out.push(String::new());
            }
            let size = if g.truncated {
                format!("{} of {} rows shown", g.rows.len(), g.count)
            } else {
                g.count.to_string()
            };
            out.push(format!("### {} ({})", g.label, size));
            out.push(String::new());
            if g.rows.is_empty() {
                out.push("(no rows shown)".into());
            } else {
                out.extend(table(&g.rows));
            }
            out.extend(summary_line(&g.summaries));
        }
        out.extend(summary_line(&result.summaries));
    } else {
        out.extend(table(result.rows.as_deref().unwrap_or(&[])));
        out.extend(summary_line(&result.summaries));
    }
    if !result.warnings.is_empty() {
        out.push(String::new());
        out.push("Warnings:".into());
        out.extend(result.warnings.iter().map(|w| format!("- {w}")));
    }
    out.join("\n")
}

#[cfg(test)]
#[path = "base_tests.rs"]
mod tests;
