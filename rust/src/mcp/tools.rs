//! MCP tool surface (`src/bun/mcp/tools.ts`).
//!
//! Every tool goes through [`Workspace`], so an agent write is subject to the
//! same layer rules, logging and indexing as a keystroke in the editor.
//!
//! Tool arguments are untyped JSON and the TS coerces them with JS rules
//! (`String(x)`, truthiness, `typeof x === "number"`); the helpers below
//! reproduce those so odd inputs get the same answer from both servers.

use crate::okf::bundle::{DanglingRelation, WriteOptions};
use crate::okf::error::Result;
use crate::okf::loops::{DefineOptions, EndOptions, StartOptions, SuggestedSkill};
use crate::okf::parser::{skeleton_concept, ConceptSkeletonOptions};
use crate::okf::paths::Actor;
use crate::rag::context_pack::{format_context_pack, ContextTier};
use crate::rag::fts::SearchOptions;
use crate::rag::retrieve::{format_retrieval, RetrieveOptions};
use crate::shared::js_compat::{ends_with_ascii_ci, js_trim, locale_compare};
use crate::shared::messages;
use crate::shared::okf::activity::ActivityFilter;
use crate::shared::okf::base::is_base_path;
use crate::shared::okf::canvas::is_canvas_path;
use crate::shared::okf::canvas::MAX_CANVAS_EDGES;
use crate::shared::okf::canvas_graph::MAX_GRAPH_NODES;
use crate::shared::okf::concept::is_concept_path;
use crate::shared::okf::frontmatter::split_frontmatter;
use crate::shared::okf::lifecycle::parse_lifecycle;
use crate::shared::okf::loop_::RunStatus;
use crate::shared::okf::para::{para_of, parse_para_class, ParaClass, PARA_ORDER};
use crate::shared::okf::workspace_files::{Task, TaskStatus};
use crate::shared::types::SearchFilters;
use crate::workspace::{CanvasFromLinks, TaskChanges, TaskInput, Workspace};
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

pub type Args = Map<String, Value>;

/// `{ content: [{ type: "text", text }], isError? }`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

impl ToolResult {
    pub fn to_value(&self) -> Value {
        let mut result = Map::new();
        result.insert("content".into(), json!([{ "type": "text", "text": self.text }]));
        if self.is_error {
            result.insert("isError".into(), Value::Bool(true));
        }
        Value::Object(result)
    }
}

fn text(body: impl Into<String>) -> ToolResult {
    ToolResult { text: body.into(), is_error: false }
}

fn fail(body: impl Into<String>) -> ToolResult {
    ToolResult { text: body.into(), is_error: true }
}

/// `JSON.stringify(value, null, 2)`
fn json_text<T: Serialize>(value: &T) -> ToolResult {
    text(serde_json::to_string_pretty(value).expect("tool results are serialisable"))
}

/// The tool definitions, exactly as `tools/list` returns them.
///
/// Generated from the TS `TOOLS` array (key order included) so the two
/// servers cannot drift; descriptions are long prose that agents read, and a
/// retyped copy would be one stray character away from a different prompt.
pub static TOOLS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    match serde_json::from_str::<Value>(include_str!("tools.json")) {
        Ok(Value::Array(tools)) => tools,
        _ => unreachable!("tools.json is a JSON array"),
    }
});

/// The relations a move could not follow, for the end of its answer.
fn dangling_note(dangling: &[DanglingRelation]) -> String {
    if dangling.is_empty() {
        return String::new();
    }
    let list: Vec<String> = dangling.iter().map(|d| format!("{} ({}: {})", d.path, d.kind, d.target)).collect();
    format!(" — these relations now dangle and need a manual edit: {}", list.join("; "))
}

// ---- JS-flavoured argument access ---------------------------------------------

/// `typeof args[key] === "string" ? value : ""`
fn str_arg(args: &Args, key: &str) -> String {
    match args.get(key) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn str_array(args: &Args, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// JS `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            // `String(1.0)` is "1", and serde would print "1.0".
            Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i128),
            _ => n.to_string(),
        },
        Value::Array(items) => items
            .iter()
            .map(|v| if v.is_null() { String::new() } else { js_string(v) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS truthiness.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `args[key] === undefined ? undefined : String(args[key])`
fn opt_string(args: &Args, key: &str) -> Option<String> {
    args.get(key).map(js_string)
}

/// `String(args[key] ?? "")`
fn string_or_empty(args: &Args, key: &str) -> String {
    match args.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    }
}

/// `typeof args[key] === "number" ? args[key] : undefined`
fn number_arg(args: &Args, key: &str) -> Option<i64> {
    match args.get(key) {
        Some(Value::Number(n)) => Some(n.as_f64().unwrap_or(0.0) as i64),
        _ => None,
    }
}

fn filters_from(args: &Args) -> SearchFilters {
    let mut filters = SearchFilters::default();
    let ty = str_arg(args, "type");
    if !ty.is_empty() {
        filters.r#type = Some(ty);
    }
    let tags = str_array(args, "tags");
    if !tags.is_empty() {
        filters.tags = Some(tags);
    }
    let prefix = str_arg(args, "path_prefix");
    if !prefix.is_empty() {
        filters.path_prefix = Some(prefix);
    }
    if args.get("include_dead") == Some(&Value::Bool(true)) {
        filters.include_dead = Some(true);
    }
    filters
}

/// `para_depth` and `link_depth`, validated, or the message to fail with.
///
/// Rejected rather than clamped: a depth is a scope the caller chose on
/// purpose, and silently reading a different scope than the one asked for
/// would return an answer to another question.
fn range_from(args: &Args) -> std::result::Result<(Option<i64>, Option<i64>), ToolResult> {
    let check = |key: &str, min: i64, max: i64| -> std::result::Result<Option<i64>, ToolResult> {
        let value = match args.get(key) {
            None | Some(Value::Null) => return Ok(None),
            Some(value) => value,
        };
        let whole = match value {
            Value::Number(n) => n.as_f64().filter(|f| f.fract() == 0.0 && *f >= min as f64 && *f <= max as f64),
            _ => None,
        };
        match whole {
            Some(f) => Ok(Some(f as i64)),
            None => Err(fail(format!(
                "{key} must be an integer from {min} to {max}: {}",
                js_string(value)
            ))),
        }
    };
    Ok((check("para_depth", 1, 4)?, check("link_depth", 0, 2)?))
}

/// `depth` (0-3) and `para_depth` (1-4) for `canvas_from_links`, validated, or
/// the message to fail with. Rejected rather than clamped, like `range_from`.
fn canvas_range_from(args: &Args) -> std::result::Result<(Option<i64>, Option<i64>), ToolResult> {
    let check = |key: &str, min: i64, max: i64| -> std::result::Result<Option<i64>, ToolResult> {
        let value = match args.get(key) {
            None | Some(Value::Null) => return Ok(None),
            Some(value) => value,
        };
        let whole = match value {
            Value::Number(n) => n.as_f64().filter(|f| f.fract() == 0.0 && *f >= min as f64 && *f <= max as f64),
            _ => None,
        };
        match whole {
            Some(f) => Ok(Some(f as i64)),
            None => Err(fail(format!(
                "{key} must be an integer from {min} to {max}: {}",
                js_string(value)
            ))),
        }
    };
    Ok((check("depth", 0, 3)?, check("para_depth", 1, 4)?))
}

enum DateArg {
    /// Not given: use today.
    Today,
    On(DateTime<Local>),
    /// Supplied but not a date. Treating it as today would write into the
    /// wrong day's note.
    Invalid,
}

static ISO_DATE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap());

fn is_iso_date(value: &str) -> bool {
    ISO_DATE_RE.is_match(js_trim(value))
}

/// An optional ISO date argument, as a local-midnight date: a daily note is
/// named for a local day, and a UTC parse lands on the previous day west of
/// Greenwich.
fn parse_date(value: &str) -> DateArg {
    let value = js_trim(value);
    if value.is_empty() {
        return DateArg::Today;
    }
    if !is_iso_date(value) {
        return DateArg::Invalid;
    }
    let part = |range: std::ops::Range<usize>| value[range].parse::<u32>().unwrap_or(0);
    let (y, m, d) = (part(0..4), part(5..7), part(8..10));
    // `new Date(y, ...)` maps years 0-99 to 1900-1999, which the TS then
    // rejects when it compares the components back; so does this.
    if y < 100 {
        return DateArg::Invalid;
    }
    // Overflow (2026-02-30) is rejected rather than normalised into March.
    let Some(date) = NaiveDate::from_ymd_opt(y as i32, m, d) else {
        return DateArg::Invalid;
    };
    let midnight = date.and_hms_opt(0, 0, 0).expect("midnight exists");
    match Local.from_local_datetime(&midnight).earliest() {
        Some(local) if local.year() == y as i32 => DateArg::On(local),
        _ => DateArg::Invalid,
    }
}

fn parse_status(value: &str) -> Option<TaskStatus> {
    match value {
        "doing" => Some(TaskStatus::Doing),
        "todo" => Some(TaskStatus::Todo),
        "done" => Some(TaskStatus::Done),
        _ => None,
    }
}

const TASK_STATUS_NAMES: &str = "doing, todo, done";

fn task_status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Doing => "進行中",
        TaskStatus::Todo => "未着手",
        TaskStatus::Done => "完了",
    }
}

/// One task on one line, which is all a caller needs to pick or refer to it.
fn describe_task(task: &Task) -> String {
    let mut parts = vec![format!("{} [{}] {}", task.id, task_status_label(task.status), task.title)];
    if let Some(para) = task.para {
        parts.push(para.as_str().to_string());
    }
    if let Some(due) = task.due.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("期限 {due}"));
    }
    if let Some(done) = task.done.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("完了 {done}"));
    }
    if let Some(note) = task.note.as_deref().filter(|s| !s.is_empty()) {
        parts.push(note.to_string());
    }
    parts.join(" · ")
}

static GENERATED_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^generated[ \t]*:").unwrap());

/// Whether a concept document records who generated it.
///
/// Cheap on purpose: a top-level `generated:` key in the frontmatter is taken
/// at its word. The point is a nudge on every agent write, not a validation.
fn lacks_provenance(content: &str) -> bool {
    match split_frontmatter(content).yaml {
        None => true,
        Some(yaml) => !GENERATED_RE.is_match(&yaml),
    }
}

fn optional_para(args: &Args) -> std::result::Result<Option<ParaClass>, ToolResult> {
    match args.get("para") {
        None => Ok(None),
        Some(v) => match parse_para_class(&js_string(v)) {
            Some(para) => Ok(Some(para)),
            None => Err(fail(format!("unknown PARA class: {}", js_string(v)))),
        },
    }
}

/// `status` for add_task/update_task: `None` when absent or empty, an error
/// result when it is not one of the three.
fn optional_status(args: &Args) -> std::result::Result<Option<TaskStatus>, ToolResult> {
    match opt_string(args, "status").filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => parse_status(&s)
            .map(Some)
            .ok_or_else(|| fail(format!("status must be one of: {TASK_STATUS_NAMES}"))),
    }
}

macro_rules! try_result {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(result) => return Ok(result),
        }
    };
}

/// Run one tool. Errors never escape: they become `isError` results, which is
/// what the TS `callTool` does with every exception.
pub fn call_tool(workspace: &mut Workspace, name: &str, args: &Args) -> ToolResult {
    match dispatch(workspace, name, args) {
        Ok(result) => result,
        Err(error) => fail(error.to_string()),
    }
}

fn dispatch(ws: &mut Workspace, name: &str, args: &Args) -> Result<ToolResult> {
    match name {
        "read_map" => Ok(text(ws.read_map()?)),

        "read_human" => Ok(text(ws.ensure_human()?)),

        "write_human" => {
            let content = string_or_empty(args, "content");
            if js_trim(&content).is_empty() {
                return Ok(fail("content is empty"));
            }
            ws.write_human(&content)?;
            Ok(text("human.md を更新しました。"))
        }

        "list_tasks" => {
            let requested = opt_string(args, "status").filter(|s| !s.is_empty());
            let status = match &requested {
                None => None,
                Some(s) => match parse_status(s) {
                    Some(status) => Some(status),
                    None => return Ok(fail(format!("status must be one of: {TASK_STATUS_NAMES}"))),
                },
            };

            let tasks = ws.list_tasks(status)?;
            if tasks.is_empty() {
                return Ok(text(match &requested {
                    Some(r) => format!("{r} のタスクはありません。"),
                    None => "未完了のタスクはありません。".to_string(),
                }));
            }
            Ok(text(tasks.iter().map(describe_task).collect::<Vec<_>>().join("\n")))
        }

        "daily_note" => {
            let date = match parse_date(&str_arg(args, "date")) {
                DateArg::Invalid => {
                    let shown = args.get("date").map(js_string).unwrap_or_else(|| "undefined".into());
                    return Ok(fail(format!("date must be an ISO date: {shown}")));
                }
                DateArg::Today => None,
                DateArg::On(d) => Some(d),
            };

            let (path, created) = ws.open_daily(date)?;
            let file = ws.read_file(&path)?;
            let body = if file.binary == Some(true) { "" } else { file.content.as_str() };
            Ok(text(format!("{path}{}\n\n{body}", if created { "（新規作成）" } else { "" })))
        }

        "collect_daily_tasks" => {
            let date = match parse_date(&str_arg(args, "date")) {
                DateArg::Invalid => {
                    let shown = args.get("date").map(js_string).unwrap_or_else(|| "undefined".into());
                    return Ok(fail(format!("date must be an ISO date: {shown}")));
                }
                DateArg::Today => None,
                DateArg::On(d) => Some(d),
            };

            let created = ws.collect_daily_tasks(date)?;
            if created.is_empty() {
                return Ok(text("取り込むタスクはありません（未チェックの項目なし）。"));
            }
            Ok(text(format!(
                "{} 件を Task.md に取り込みました:\n{}",
                created.len(),
                created.iter().map(describe_task).collect::<Vec<_>>().join("\n")
            )))
        }

        "add_task" => {
            let title = js_trim(&string_or_empty(args, "title")).to_string();
            if title.is_empty() {
                return Ok(fail("title is required"));
            }
            let status = try_result!(optional_status(args));
            let para = try_result!(optional_para(args));

            let task = ws.add_task(TaskInput {
                title,
                status,
                para,
                due: args.get("due").filter(|v| truthy(v)).map(js_string),
                note: args.get("note").filter(|v| truthy(v)).map(js_string),
            })?;
            Ok(text(format!("追加しました: {}", describe_task(&task))))
        }

        "update_task" => {
            let id = js_trim(&string_or_empty(args, "id")).to_string();
            if id.is_empty() {
                return Ok(fail("id is required"));
            }
            let status = try_result!(optional_status(args));
            let para = try_result!(optional_para(args));

            let task = ws.update_task(
                &id,
                &TaskChanges {
                    status,
                    title: opt_string(args, "title"),
                    para,
                    due: opt_string(args, "due"),
                    note: opt_string(args, "note"),
                },
            )?;
            match task {
                None => Ok(fail(format!("no such task: {id}"))),
                Some(task) => Ok(text(format!("更新しました: {}", describe_task(&task)))),
            }
        }

        "read_agents_md" => match ws.read_agents_md()? {
            Some(content) => Ok(text(content)),
            None => Ok(text(
                "AGENTS.md is missing at the bundle root.\n\n\
                 This bundle has no agent contract. Follow the OKF v0.2 defaults: every concept \
                 document needs YAML frontmatter with a non-empty 'type'; index.md and log.md are \
                 reserved and carry no frontmatter; raw/ is immutable; .rag/ is derived.",
            )),
        },

        "open_bundle" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            Ok(json_text(&ws.open(&path)?))
        }

        "bundle_info" => match ws.info() {
            Some(info) => Ok(json_text(&info)),
            None => Ok(fail("No bundle is open. Call open_bundle first.")),
        },

        "list_files" => {
            let recursive = args.get("recursive").is_some_and(truthy);
            Ok(json_text(&ws.list_dir(&str_arg(args, "path"), recursive)?))
        }

        "retrieve" => {
            let query = str_arg(args, "query");
            if query.is_empty() {
                return Ok(fail("'query' is required"));
            }
            let (para_depth, link_depth) = try_result!(range_from(args));
            let mut filters = filters_from(args);
            filters.para_depth = para_depth;
            let result = ws.retrieve(
                &query,
                &RetrieveOptions {
                    filters,
                    limit: number_arg(args, "limit"),
                    budget_chars: number_arg(args, "budget_chars"),
                    expand_neighbours: args.get("expand_neighbours") == Some(&Value::Bool(true)),
                    min_content_matches: None,
                    link_depth,
                },
            )?;
            Ok(text(format_retrieval(&result)))
        }

        "context_pack" => {
            let task = str_arg(args, "task");
            if js_trim(&task).is_empty() {
                return Ok(fail("'task' is required"));
            }
            let tier_arg = str_arg(args, "tier");
            let tier = if tier_arg.is_empty() {
                None
            } else {
                match ContextTier::parse(&tier_arg) {
                    Some(t) => Some(t),
                    None => return Ok(fail(format!("tier must be 'worker' or 'supervisor': {tier_arg}"))),
                }
            };

            let (para_depth, link_depth) = try_result!(range_from(args));
            let mut filters = filters_from(args);
            filters.para_depth = para_depth;

            let pack = ws.context_pack(
                &task,
                &RetrieveOptions {
                    filters,
                    limit: number_arg(args, "limit"),
                    budget_chars: number_arg(args, "budget_chars"),
                    link_depth,
                    ..Default::default()
                },
                tier,
            )?;
            Ok(text(format_context_pack(&pack)))
        }

        "search" => {
            let query = str_arg(args, "query");
            if query.is_empty() {
                return Ok(fail("'query' is required"));
            }
            let hits = ws.search(
                &query,
                &SearchOptions {
                    filters: filters_from(args),
                    limit: Some(number_arg(args, "limit").unwrap_or(20)),
                    ..Default::default()
                },
            )?;
            if hits.is_empty() {
                return Ok(text(format!("No matches for: {query}")));
            }
            let rows: Vec<Value> = hits
                .iter()
                .map(|hit| {
                    let mut row = Map::new();
                    row.insert("id".into(), hit.id.clone().into());
                    row.insert("path".into(), hit.path.clone().into());
                    row.insert("title".into(), hit.title.clone().into());
                    row.insert("type".into(), hit.r#type.clone().into());
                    // `|| undefined`: an empty trail is dropped from the JSON.
                    let section = hit.heading_path.join(" › ");
                    if !section.is_empty() {
                        row.insert("section".into(), section.into());
                    }
                    row.insert("snippet".into(), hit.snippet.clone().into());
                    Value::Object(row)
                })
                .collect();
            Ok(json_text(&rows))
        }

        "list_concepts" => Ok(json_text(&ws.list_concepts()?)),

        "list_tags" => Ok(json_text(&json!({ "tags": ws.tags()?, "types": ws.types()? }))),

        "unresolved_links" => {
            let gaps = ws.unresolved_links()?;
            Ok(if gaps.is_empty() { text("No unresolved links.") } else { json_text(&gaps) })
        }

        "move_file" => {
            // Agents may reorganise curated material but cannot promote out of
            // raw/; `assert_movable` enforces that from the actor tag.
            let from = str_arg(args, "from");
            let to = str_arg(args, "to");
            if from.is_empty() || to.is_empty() {
                return Ok(fail("'from' and 'to' are required"));
            }
            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            let result = ws.move_file(&from, &to, actor.as_deref().unwrap_or("process:mcp"), Actor::Agent)?;
            let note = if result.link_count > 0 {
                format!(" — updated {} link(s) in {} file(s)", result.link_count, result.updated.len())
            } else {
                String::new()
            };
            Ok(text(format!("Moved {from} → {}{note}{}", result.moved, dangling_note(&result.dangling_relations))))
        }

        "delete_file" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            let result = ws.delete(&path, actor.as_deref().unwrap_or("process:mcp"), Actor::Agent)?;
            if result.broken_links_from.is_empty() {
                return Ok(text(format!("Deleted {}", result.deleted)));
            }
            Ok(text(format!(
                "Deleted {}. These concepts now have broken links: {}",
                result.deleted,
                result.broken_links_from.join(", ")
            )))
        }

        "create_directory" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            ws.create_directory(&path, Actor::Agent)?;
            Ok(text(format!("Created directory {path}")))
        }

        "read_file" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            let result = ws.read_file(&path)?;
            let Some(concept) = result.concept else {
                return Ok(text(result.content));
            };
            Ok(json_text(&json!({
                "path": path,
                "id": concept.id,
                "frontmatter": concept.frontmatter,
                "links": concept.links,
                "backlinks": result.backlinks,
                "body": concept.body,
            })))
        }

        "write_file" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            let content = str_arg(args, "content");
            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            let result = ws.write_file(
                &path,
                &content,
                &WriteOptions {
                    by: Some(Actor::Agent),
                    actor: Some(actor.unwrap_or_else(|| "process:mcp".into())),
                    note: Some(str_arg(args, "note")),
                    ..Default::default()
                },
            )?;

            // Conformance was checked as part of the write; provenance is
            // checked here because it is a rule for agents, not for the file
            // format: a human editing in the UI is not held to it. skills/ and
            // loops/ hold procedures and journals, not knowledge claims, so
            // they are exempt.
            let mut warnings = result.warnings;
            if is_concept_path(&path)
                && !ws.require_bundle()?.paths.is_subsystem_path(&path)
                && lacks_provenance(&content)
            {
                warnings.push(messages::MISSING_PROVENANCE.to_string());
            }

            if !warnings.is_empty() {
                return Ok(text(format!("Wrote {path}\nOKF warnings: {}", warnings.join("; "))));
            }
            Ok(text(format!("Wrote {path}")))
        }

        "create_concept" => {
            let path = str_arg(args, "path");
            let ty = str_arg(args, "type");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            if ty.is_empty() {
                return Ok(fail("'type' is required and must be non-empty (OKF v0.2)"));
            }
            if !ends_with_ascii_ci(&path, ".md") {
                return Ok(fail("'path' must end in .md"));
            }

            let actor = Some(str_arg(args, "actor"))
                .filter(|a| !a.is_empty())
                .unwrap_or_else(|| "process:mcp".into());
            let content = skeleton_concept(&ConceptSkeletonOptions {
                r#type: ty,
                title: Some(str_arg(args, "title")),
                description: Some(str_arg(args, "description")),
                tags: str_array(args, "tags"),
                body: Some(str_arg(args, "body")),
                generated_by: Some(actor.clone()),
                extra: Vec::new(),
                now: None,
            });
            ws.write_file(
                &path,
                &content,
                &WriteOptions {
                    by: Some(Actor::Agent),
                    actor: Some(actor),
                    action: Some("create".into()),
                    ..Default::default()
                },
            )?;
            Ok(text(format!("Created {path}")))
        }

        "backlinks" => {
            let id = str_arg(args, "id");
            if id.is_empty() {
                return Ok(fail("'id' is required"));
            }
            Ok(json_text(&ws.require_bundle()?.backlinks_of(&id)))
        }

        "check_conformance" => {
            let issues = ws.conformance_issues()?;
            Ok(if issues.is_empty() {
                text("All documents conform to OKF v0.2.")
            } else {
                json_text(&issues)
            })
        }

        "audit_changes" => {
            let since = str_arg(args, "since");
            if !since.is_empty() && !is_iso_date(&since) {
                return Ok(fail(format!("since must be an ISO date: {since}")));
            }
            let actor = str_arg(args, "actor");

            let since = (!since.is_empty()).then(|| js_trim(&since).to_string());
            let result = ws.audit_changes(since.as_deref(), Some(actor.as_str()))?;
            if result.total == 0 {
                return Ok(text(messages::AUDIT_NO_CHANGES));
            }
            Ok(json_text(&result))
        }

        "summarize_activity" => {
            let since = str_arg(args, "since");
            if !since.is_empty() && !is_iso_date(&since) {
                return Ok(fail(format!("since must be an ISO date: {since}")));
            }
            let until = str_arg(args, "until");
            if !until.is_empty() && !is_iso_date(&until) {
                return Ok(fail(format!("until must be an ISO date: {until}")));
            }
            if !since.is_empty() && !until.is_empty() && js_trim(&until) < js_trim(&since) {
                return Ok(fail(format!(
                    "until must not be before since: {} < {}",
                    js_trim(&until),
                    js_trim(&since)
                )));
            }

            let actor = str_arg(args, "actor");
            let by = js_trim(&str_arg(args, "by")).to_string();
            let result = ws.summarize_activity(
                &ActivityFilter {
                    since: (!since.is_empty()).then(|| js_trim(&since).to_string()),
                    until: (!until.is_empty()).then(|| js_trim(&until).to_string()),
                    actor: (!actor.is_empty()).then_some(actor),
                },
                (!by.is_empty()).then_some(by.as_str()),
                args.get("save") == Some(&Value::Bool(true)),
            )?;
            if result.total == 0 {
                return Ok(text("No log entries matched the given range or actor."));
            }
            if let Some(saved) = result.saved {
                return Ok(text(format!("Saved {saved} ({} row(s))", result.total)));
            }
            Ok(text(result.markdown))
        }

        "rebuild_index" => {
            let rows = ws.rebuild_index()?;
            Ok(text(format!("index.md rebuilt with {rows} concepts")))
        }

        "rebuild_rag" => {
            let indexed = ws.rebuild_rag()?;
            Ok(text(format!("Indexed {indexed} concepts")))
        }

        "skill_find" => {
            let task = str_arg(args, "task");
            if js_trim(&task).is_empty() {
                return Ok(fail("task is required"));
            }
            let limit = number_arg(args, "limit").map(|n| n.max(0) as usize).unwrap_or(3);
            let result = ws.require_skills_mut()?.find(&task, Some(limit));

            if result.ranked.is_empty() {
                // Say so plainly rather than returning an empty list: an agent
                // given nothing tends to retry, and a retry costs more than an
                // explanation.
                return Ok(text(messages::skill_none_matched(&task)));
            }
            Ok(json_text(&result))
        }

        "skill_list" => {
            let summaries = ws.require_skills_mut()?.summaries();
            if summaries.is_empty() {
                return Ok(text(messages::SKILL_SPACE_EMPTY));
            }
            Ok(json_text(&summaries))
        }

        "skill_open" => {
            let name = str_arg(args, "name");
            if name.is_empty() {
                return Ok(fail("name is required"));
            }
            let skill = ws.require_skills_mut()?.open(&name)?;
            let doc = &skill.document;
            let resources = if skill.resources.is_empty() {
                String::new()
            } else {
                format!("\nSupporting files (read with skill_read): {}", skill.resources.join(", "))
            };
            let warnings = if doc.warnings.is_empty() {
                String::new()
            } else {
                format!("\n⚠ {}", doc.warnings.join(" / "))
            };
            let header = [
                format!("# skill: {}", doc.name),
                String::new(),
                doc.description.clone(),
                resources,
                warnings,
                String::new(),
                "---".to_string(),
                String::new(),
            ]
            .join("\n");
            Ok(text(format!("{header}{}", doc.body)))
        }

        "skill_read" => {
            let name = str_arg(args, "name");
            let path = str_arg(args, "path");
            if name.is_empty() || path.is_empty() {
                return Ok(fail("name and path are required"));
            }
            let resource = ws.require_skills()?.read_resource(&name, &path)?;
            Ok(text(resource.content))
        }

        "set_para" => {
            let path = str_arg(args, "path");
            let para = str_arg(args, "para");
            let target = parse_para_class(&para);
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            let Some(target) = target else {
                return Ok(fail(messages::para_unknown_class(&para)));
            };

            let result = ws.set_para(&path, target, Actor::Agent, None)?;
            Ok(text(if result.moved {
                messages::para_moved(&result.from, &result.to, target.label())
                    + &dangling_note(&result.dangling_relations)
            } else {
                messages::para_already(&path, target.label())
            }))
        }

        "set_lifecycle" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            let raw = str_arg(args, "lifecycle");
            let Some(lifecycle) = parse_lifecycle(&raw) else {
                let shown = if raw.is_empty() { String::new() } else { format!(": {raw}") };
                return Ok(fail(format!("lifecycle must be product | dead | none{shown}")));
            };

            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            let result = ws.set_lifecycle(&path, lifecycle, actor.as_deref().unwrap_or("process:mcp"))?;
            Ok(text(if result.changed {
                format!("Set lifecycle of {path} to {}.", lifecycle.as_str())
            } else {
                format!("{path} already has lifecycle {}; nothing changed.", lifecycle.as_str())
            }))
        }

        "base_list" => Ok(json_text(&ws.base_list()?)),

        "base_query" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            if !is_base_path(&path) {
                return Ok(fail("'path' must end in .base"));
            }
            let limit = match args.get("limit") {
                None => None,
                Some(Value::Number(n)) => match n.as_f64().filter(|f| f.fract() == 0.0 && *f >= 1.0) {
                    Some(f) => Some(f as usize),
                    None => return Ok(fail("limit must be a positive integer")),
                },
                Some(_) => return Ok(fail("limit must be a positive integer")),
            };
            let view = Some(str_arg(args, "view")).filter(|v| !v.is_empty());
            let (result, markdown) = ws.base_query(&path, view.as_deref(), limit)?;
            let mut out = Map::new();
            out.insert("path".into(), Value::String(path));
            out.extend(result.to_map());
            out.insert("markdown".into(), Value::String(markdown));
            Ok(json_text(&Value::Object(out)))
        }

        "base_write" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            let Some(Value::String(content)) = args.get("content") else {
                return Ok(fail("'content' is required"));
            };
            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            let warnings =
                ws.base_write(&path, content, Actor::Agent, Some(actor.as_deref().unwrap_or("process:mcp")))?;
            Ok(text(if warnings.is_empty() {
                format!("Wrote {path}")
            } else {
                format!("Wrote {path}\nWarnings: {}", warnings.join("; "))
            }))
        }

        "knowhow_find" => {
            let task = str_arg(args, "task");
            if js_trim(&task).is_empty() {
                return Ok(fail("task is required"));
            }

            let result = ws.knowhow_find(&task, number_arg(args, "limit").unwrap_or(3), false, &SearchFilters::default())?;
            if result.ranked.is_empty() {
                return Ok(text(format!(
                    "No know-how matched: {task}\nNothing recorded applies yet - when you finish, record what you learned with knowhow_add."
                )));
            }
            Ok(json_text(&result))
        }

        "knowhow_add" => {
            let title = js_trim(&str_arg(args, "title")).to_string();
            if title.is_empty() {
                return Ok(fail("'title' is required"));
            }
            let body = str_arg(args, "body");
            if js_trim(&body).is_empty() {
                return Ok(fail("'body' is required"));
            }
            let actor = js_trim(&str_arg(args, "actor")).to_string();
            if actor.is_empty() {
                return Ok(fail(
                    "'actor' is required: say which agent is recording this, e.g. process:claude-code",
                ));
            }

            let path = ws.knowhow_add(&title, &body, &str_array(args, "tags"), &actor)?;
            Ok(text(format!("Recorded know-how {path}")))
        }

        "list_para" => {
            let para = str_arg(args, "para");
            let only = if para.is_empty() { None } else { parse_para_class(&para) };
            if !para.is_empty() && only.is_none() {
                return Ok(fail(messages::para_unknown_class(&para)));
            }

            struct Row {
                id: String,
                title: String,
                r#type: String,
            }
            let mut grouped: Vec<(ParaClass, Vec<Row>)> = Vec::new();
            for cls in PARA_ORDER {
                if only.is_some_and(|o| o != cls) {
                    continue;
                }
                grouped.push((cls, Vec::new()));
            }

            for concept in ws.require_bundle()?.all_concepts() {
                let cls = para_of(&concept.id);
                if only.is_some_and(|o| o != cls) {
                    continue;
                }
                if let Some((_, list)) = grouped.iter_mut().find(|(c, _)| *c == cls) {
                    list.push(Row {
                        id: concept.id.clone(),
                        title: concept.frontmatter.title.clone().unwrap_or_else(|| concept.id.clone()),
                        r#type: concept.frontmatter.r#type.clone(),
                    });
                }
            }

            let mut groups = Map::new();
            for (cls, mut list) in grouped {
                list.sort_by(|a, b| locale_compare(&a.id, &b.id));
                let rows: Vec<Value> = list
                    .into_iter()
                    .map(|r| json!({ "id": r.id, "title": r.title, "type": r.r#type }))
                    .collect();
                groups.insert(cls.as_str().to_string(), Value::Array(rows));
            }
            let order: Vec<&str> = PARA_ORDER.iter().map(|c| c.as_str()).collect();
            Ok(json_text(&json!({ "order": order, "groups": groups })))
        }

        "canvas_list" => Ok(json_text(&ws.canvas_list()?)),

        "canvas_read" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            if !is_canvas_path(&path) {
                return Ok(fail("'path' must end in .canvas"));
            }
            Ok(json_text(&ws.canvas_read(&path)?))
        }

        "canvas_write" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            let Some(Value::String(content)) = args.get("content") else {
                return Ok(fail("'content' is required"));
            };
            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            ws.canvas_write(&path, content, Actor::Agent, Some(actor.as_deref().unwrap_or("process:mcp")))?;
            Ok(text(format!("Wrote {path}")))
        }

        "canvas_from_links" => {
            let path = str_arg(args, "path");
            if path.is_empty() {
                return Ok(fail("'path' is required"));
            }
            if !is_canvas_path(&path) {
                return Ok(fail("'path' must end in .canvas"));
            }
            let root = str_arg(args, "root");
            let query = str_arg(args, "query");
            if js_trim(&root).is_empty() && js_trim(&query).is_empty() {
                return Ok(fail("'root' or 'query' is required"));
            }
            let (depth, para_depth) = try_result!(canvas_range_from(args));
            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            let result = ws.canvas_from_links(&CanvasFromLinks {
                root: (!js_trim(&root).is_empty()).then_some(root),
                query: (!js_trim(&query).is_empty()).then_some(query),
                depth,
                include_dead: args.get("include_dead") == Some(&Value::Bool(true)),
                para_depth,
                group_by_para: args.get("group_by_para") == Some(&Value::Bool(true)),
                overwrite: args.get("overwrite") == Some(&Value::Bool(true)),
                path,
                by: Actor::Agent,
                actor: Some(actor.unwrap_or_else(|| "process:mcp".to_string())),
            })?;
            let noun = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
            let truncated = if result.truncated {
                format!(" Left some concepts or edges out (limits: {MAX_GRAPH_NODES} concepts, {MAX_CANVAS_EDGES} edges); use a smaller depth or para_depth.")
            } else {
                String::new()
            };
            Ok(text(format!(
                "Wrote {}: {}, {}.{truncated}\n\n{}",
                result.path,
                noun(result.concepts, "concept"),
                noun(result.edges, "edge"),
                result.outline
            )))
        }

        "graph_schema" => {
            // Undeclared types and kinds are advice about the schema, so they live here
            // and check_conformance keeps its original shape.
            let warnings = ws.schema_warnings()?;
            let mut schema = ws.graph_schema()?;
            if !warnings.is_empty() {
                let rows: Vec<Value> = warnings
                    .into_iter()
                    .map(|(path, warnings)| json!({ "path": path, "warnings": warnings }))
                    .collect();
                if let Some(map) = schema.as_object_mut() {
                    map.insert("warnings".into(), Value::Array(rows));
                }
            }
            Ok(json_text(&schema))
        }

        "system_map" => {
            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            Ok(text(ws.system_map(
                args.get("refresh") == Some(&Value::Bool(true)),
                Some(actor.as_deref().unwrap_or("process:mcp")),
                TOOLS.len(),
            )?))
        }

        "loop_define" => {
            let loops = ws.require_loops()?;
            let name = Some(str_arg(args, "name")).filter(|s| !s.is_empty());
            let skill = Some(str_arg(args, "skill")).filter(|s| !s.is_empty());
            let checks = Some(str_array(args, "checks")).filter(|c| !c.is_empty());
            let design = loops.define(&DefineOptions {
                goal: str_arg(args, "goal"),
                name,
                skill,
                checks,
                now: None,
            })?;

            let mut out = Map::new();
            out.insert("name".into(), design.name.clone().into());
            out.insert("path".into(), loops.rel_path_of(&design.name).into());
            out.insert("goal".into(), design.goal.clone().into());
            if let Some(skill) = &design.skill {
                out.insert("skill".into(), skill.clone().into());
            }
            out.insert("checks".into(), json!(design.checks));
            out.insert("runs".into(), design.runs.into());
            Ok(json_text(&out))
        }

        "loop_start" => {
            let loops = ws.require_loops()?;
            let goal = str_arg(args, "goal");
            let mut name = str_arg(args, "name");

            // Define on the spot when the design is new: an agent should not
            // have to make two calls to start work it has already described.
            if name.is_empty() && goal.is_empty() {
                return Ok(fail(messages::LOOP_NEEDS_GOAL));
            }
            if name.is_empty() || !loops.exists(&name).unwrap_or(false) {
                if goal.is_empty() {
                    return Ok(fail(messages::loop_unknown(&name)));
                }
                let design = loops.define(&DefineOptions {
                    goal: goal.clone(),
                    name: Some(name.clone()).filter(|n| !n.is_empty()),
                    ..Default::default()
                })?;
                name = design.name;
            }

            let design = ws.require_loops()?.read(&name)?;
            // Only look for a skill when the design does not already name one.
            let suggested: Option<Vec<SuggestedSkill>> = if design.skill.as_deref().is_some_and(|s| !s.is_empty()) {
                None
            } else {
                let found = ws.require_skills_mut()?.find(&design.goal, Some(3));
                Some(
                    found
                        .ranked
                        .iter()
                        .map(|r| SuggestedSkill {
                            name: r.name.clone(),
                            description: r.description.clone(),
                            score: r.score,
                        })
                        .collect(),
                )
            };

            let actor = Some(str_arg(args, "actor")).filter(|a| !a.is_empty());
            let result = ws.loop_start(&StartOptions {
                name,
                actor,
                suggested: suggested.unwrap_or_default(),
                now: None,
            })?;

            let skill = result
                .skill
                .clone()
                .or_else(|| result.suggested.first().map(|s| s.name.clone()))
                .filter(|s| !s.is_empty());
            let next = match skill {
                Some(skill) => format!("skill_open(\"{skill}\") で手順を読んでから作業してください"),
                None => "合うスキルはありません。作業後は必ず loop_end を呼んでください".to_string(),
            };
            let Value::Object(mut out) = serde_json::to_value(&result).expect("serialisable") else {
                unreachable!("LoopStartResult serialises to an object")
            };
            out.insert("next".into(), next.into());
            Ok(json_text(&out))
        }

        "loop_note" => {
            let detail = str_arg(args, "detail");
            if detail.is_empty() {
                return Ok(fail("detail is required"));
            }
            if ws.require_loops()?.running_loop().is_none() {
                return Ok(fail(messages::LOOP_NONE_RUNNING));
            }
            let action = Some(str_arg(args, "action")).filter(|a| !a.is_empty());
            ws.loop_note(action.as_deref().unwrap_or("note"), &detail)?;
            Ok(text("記録しました"))
        }

        "loop_end" => {
            let status = str_arg(args, "status");
            let outcome = Some(str_arg(args, "outcome")).filter(|o| !o.is_empty());
            let result = ws.loop_end(&EndOptions {
                outcome,
                status: (status == "abandoned").then_some(RunStatus::Abandoned),
                now: None,
            })?;

            let mut lines = vec![
                format!("loop {} 第 {} 回を閉じました ({})", result.name, result.run_number, result.path),
                String::new(),
            ];
            lines.extend(result.diff.iter().cloned());
            if !result.checks.is_empty() {
                lines.push(String::new());
                lines.push("完了条件（確認してください）:".to_string());
                lines.extend(result.checks.iter().map(|c| format!("- {c}")));
            }
            lines.push(if result.regressed {
                format!("\n⚠ {}", messages::LOOP_REGRESSED)
            } else {
                String::new()
            });
            let body = lines.join("\n");

            // Surfaced as an error so a regression cannot be skimmed past.
            Ok(if result.regressed { fail(body) } else { text(body) })
        }

        "loop_list" => {
            let loops = ws.require_loops()?;
            let mut designs: Vec<Value> = Vec::new();
            for name in loops.list() {
                let Ok(design) = loops.read(&name) else { continue };
                let mut row = Map::new();
                row.insert("name".into(), design.name.clone().into());
                row.insert("goal".into(), design.goal.clone().into());
                if let Some(skill) = &design.skill {
                    row.insert("skill".into(), skill.clone().into());
                }
                row.insert("runs".into(), design.runs.into());
                if let Some(last) = design.history.first() {
                    let mut last_run = Map::new();
                    last_run.insert("started".into(), last.started.clone().into());
                    last_run.insert("status".into(), serde_json::to_value(last.status).expect("serialisable"));
                    if let Some(outcome) = last.outcome.as_deref().filter(|o| !o.is_empty()) {
                        last_run.insert("outcome".into(), outcome.into());
                    }
                    row.insert("lastRun".into(), Value::Object(last_run));
                }
                designs.push(Value::Object(row));
            }

            let running = loops.running_loop();
            let hint = match running {
                Some(r) => format!("ループ {r} が実行中です。終えたら loop_end を呼んでください"),
                None => "作業前に loop_start を呼んでください（無ければ goal を渡せばその場で作られます）".to_string(),
            };
            Ok(json_text(&json!({ "running": running, "loops": designs, "hint": hint })))
        }

        "loop_read" => {
            let name = str_arg(args, "name");
            if name.is_empty() {
                return Ok(fail("name is required"));
            }
            Ok(json_text(&ws.require_loops()?.read(&name)?))
        }

        _ => Ok(fail(format!("Unknown tool: {name}"))),
    }
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "tools_features_tests.rs"]
mod features_tests;

#[cfg(test)]
#[path = "tools_bases_tests.rs"]
mod bases_tests;

#[cfg(test)]
#[path = "tools_canvas_tests.rs"]
mod canvas_tests;
