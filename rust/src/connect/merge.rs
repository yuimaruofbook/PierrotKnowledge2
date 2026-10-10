//! Merging our server entry into somebody else's config file
//! (`src/bun/connect/merge.ts`).
//!
//! These files belong to other tools and usually contain settings the user
//! spent time on. So every function here is a *merge*, never a rewrite: it adds
//! or replaces one entry and leaves every other byte alone wherever the format
//! allows it. TOML is therefore edited as text rather than parsed and
//! re-emitted; JSON and YAML are re-emitted exactly as the TypeScript does
//! (`JSON.stringify(_, null, 2)` and `yaml.stringify`), which is what the
//! differential harness compares byte for byte.

use super::jsjson::{self, json_string, stringify_pretty};
use super::yaml_emit;
use crate::okf::parser::parse_yaml;
use crate::shared::js_compat::{is_js_space, js_trim};
use crate::shared::messages;
use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::fmt;

/// The command an agent host should spawn.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StdioServer {
    pub command: String,
    pub args: Vec<String>,
    /// Insertion-ordered, like a JS object.
    pub env: IndexMap<String, String>,
}

impl StdioServer {
    pub fn new(command: impl Into<String>, args: &[&str], env: &[(&str, &str)]) -> Self {
        Self {
            command: command.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }
}

/// A merge refused because the existing file could not be read safely. The
/// message is the user-facing text from `shared::messages`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeError(pub String);

impl fmt::Display for MergeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MergeError {}

type MergeResult = Result<String, MergeError>;

/// The `yaml` lexer ignores one byte-order mark at the start of a line while
/// nothing but blank lines and comments precede it (Notepad writes one at the
/// start of a file); later ones stay part of the key. yaml-rust2 would keep
/// them all.
fn strip_boms(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prelude = true;
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let line = if prelude { line.strip_prefix('\u{feff}').unwrap_or(line) } else { line };
        if prelude {
            let t = js_trim(line);
            prelude = t.is_empty() || t.starts_with('#');
        }
        out.push_str(line);
    }
    out
}

fn str_array(items: &[String]) -> Value {
    Value::Array(items.iter().map(|s| Value::String(s.clone())).collect())
}

fn env_object(server: &StdioServer) -> Option<Value> {
    if server.env.is_empty() {
        return None;
    }
    Some(Value::Object(
        server
            .env
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect(),
    ))
}

fn pretty_with_newline(value: Value) -> String {
    format!("{}\n", stringify_pretty(&value))
}

/// Parse a config we are about to rewrite, refusing rather than discarding it.
///
/// Absent or empty is `{}`; present but unparseable is an error, because the
/// alternative is writing back a file containing only our entry and silently
/// deleting every other MCP server the user had registered.
fn parse_for_merge(text: Option<&str>, shape: &str) -> Result<Map<String, Value>, MergeError> {
    let Some(text) = text else { return Ok(Map::new()) };
    if js_trim(text).is_empty() {
        return Ok(Map::new());
    }
    match jsjson::parse(text) {
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err(MergeError(messages::config_not_an_object(shape))),
        None => Err(MergeError(messages::config_unparseable(shape))),
    }
}

/// Parse for removal: anything unreadable counts as having nothing of ours.
fn safe_json(text: Option<&str>) -> Map<String, Value> {
    let Some(text) = text else { return Map::new() };
    if js_trim(text).is_empty() {
        return Map::new();
    }
    match jsjson::parse(text) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Merge into a `mcpServers`-style JSON config (Claude Code and others).
pub fn merge_mcp_json(existing: Option<&str>, name: &str, server: &StdioServer) -> MergeResult {
    let mut root = parse_for_merge(existing, "mcpServers")?;
    let mut servers = record(root.get("mcpServers")).cloned().unwrap_or_default();

    let mut entry = Map::new();
    entry.insert("command".into(), Value::String(server.command.clone()));
    entry.insert("args".into(), str_array(&server.args));
    if let Some(env) = env_object(server) {
        entry.insert("env".into(), env);
    }
    servers.insert(name.to_string(), Value::Object(entry));

    root.insert("mcpServers".into(), Value::Object(servers));
    Ok(pretty_with_newline(Value::Object(root)))
}

/// Merge into an opencode config: key `mcp`, `"type": "local"`, one command
/// array, `environment` instead of `env`.
pub fn merge_opencode_json(existing: Option<&str>, name: &str, server: &StdioServer) -> MergeResult {
    let root = parse_for_merge(existing, "opencode")?;
    let mut mcp = record(root.get("mcp")).cloned().unwrap_or_default();

    let mut command = vec![Value::String(server.command.clone())];
    command.extend(server.args.iter().map(|a| Value::String(a.clone())));
    let mut entry = Map::new();
    entry.insert("type".into(), Value::String("local".into()));
    entry.insert("command".into(), Value::Array(command));
    entry.insert("enabled".into(), Value::Bool(true));
    if let Some(env) = env_object(server) {
        entry.insert("environment".into(), env);
    }
    mcp.insert(name.to_string(), Value::Object(entry));

    // `{ $schema, ...root, mcp }`: a key already present keeps its position.
    let mut out = Map::new();
    out.insert(
        "$schema".into(),
        Value::String("https://opencode.ai/config.json".into()),
    );
    for (k, v) in root {
        out.insert(k, v);
    }
    out.insert("mcp".into(), Value::Object(mcp));
    Ok(pretty_with_newline(Value::Object(out)))
}

// ---- TOML (text surgery) -------------------------------------------------------

/// Horizontal whitespace: JS `[^\S\r\n]`.
fn is_hspace(c: char) -> bool {
    is_js_space(c) && c != '\r' && c != '\n'
}

/// A JS `m`-flag line boundary.
fn is_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn at_line_end(text: &str, pos: usize) -> bool {
    text[pos..].chars().next().is_none_or(is_terminator)
}

fn skip_hspace(text: &str, mut pos: usize) -> usize {
    while let Some(c) = text[pos..].chars().next() {
        if !is_hspace(c) {
            break;
        }
        pos += c.len_utf8();
    }
    pos
}

/// The end of `HSPACE$` starting at `pos`, as the backtracking regex finds it.
fn hspace_then_line_end(text: &str, pos: usize) -> Option<usize> {
    let run_end = skip_hspace(text, pos);
    // Greedy first, then back off one character at a time.
    let mut candidates: Vec<usize> = text[pos..run_end]
        .char_indices()
        .map(|(i, _)| pos + i)
        .collect();
    candidates.push(run_end);
    candidates.into_iter().rev().find(|&e| at_line_end(text, e))
}

/// Positions where `^` matches at or after `from`.
fn line_starts(text: &str, from: usize) -> Vec<usize> {
    let mut starts = vec![from];
    for (i, c) in text[from..].char_indices() {
        if is_terminator(c) {
            starts.push(from + i + c.len_utf8());
        }
    }
    starts
}

/// `^HSPACE\[mcp_servers\.(?:"name"|name)\]HSPACE$` anchored at `start`.
fn match_header(text: &str, start: usize, name: &str) -> Option<usize> {
    let mut p = skip_hspace(text, start);
    let prefix = "[mcp_servers.";
    if !text[p..].starts_with(prefix) {
        return None;
    }
    p += prefix.len();
    for alt in [format!("\"{name}\""), name.to_string()] {
        if text[p..].starts_with(&alt) {
            let q = p + alt.len();
            if text[q..].starts_with(']') {
                if let Some(end) = hspace_then_line_end(text, q + 1) {
                    return Some(end);
                }
            }
        }
    }
    None
}

/// `^HSPACE\[[^\]]+\]HSPACE$` anchored at `start`. The bracket body may span lines.
fn match_any_table(text: &str, start: usize) -> bool {
    let p = skip_hspace(text, start);
    if !text[p..].starts_with('[') {
        return false;
    }
    let body = p + 1;
    if text[body..].starts_with(']') {
        return false;
    }
    let Some(rel) = text[body..].find(']') else { return false };
    hspace_then_line_end(text, body + rel + 1).is_some()
}

/// The `[mcp_servers.<name>]` table and everything up to the next table.
///
/// Horizontal whitespace only around the headers, deliberately: a pattern
/// that could match a newline there would start the match at the previous
/// blank line, so replacing the table swallowed the blank lines around it.
fn toml_table_range(source: &str, name: &str) -> Option<(usize, usize)> {
    let (start, after) = line_starts(source, 0)
        .into_iter()
        .find_map(|s| match_header(source, s, name).map(|e| (s, e)))?;
    // The search for the next header starts on the sliced text, whose first
    // position counts as a line start.
    let end = line_starts(source, after)
        .into_iter()
        .find(|&s| match_any_table(source, s))
        .unwrap_or(source.len());
    Some((start, end))
}

/// JS `/^[A-Za-z0-9_-]+$/.test(name)`.
fn is_bare_key(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// TOML basic strings: the escapes a Windows path actually needs.
fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The trailing run of `(?:HSPACE\r?\n)*` that `/(?:[^\S\r\n]*\r?\n)*$/` finds first.
fn trailing_blank_lines(original: &str) -> &str {
    for (i, _) in original.char_indices().chain(std::iter::once((original.len(), ' '))) {
        let mut j = i;
        loop {
            let k = skip_hspace(original, j);
            let rest = &original[k..];
            if rest.starts_with("\r\n") {
                j = k + 2;
            } else if rest.starts_with('\n') {
                j = k + 1;
            } else {
                break;
            }
        }
        if j == original.len() {
            return &original[i..];
        }
    }
    ""
}

/// Merge into Codex's `config.toml`.
///
/// Text surgery rather than a parse: replace our own table if it is already
/// there, otherwise append. Everything else in the file is untouched.
pub fn merge_codex_toml(existing: Option<&str>, name: &str, server: &StdioServer) -> MergeResult {
    let source = existing.unwrap_or("");
    let quoted = if is_bare_key(name) {
        name.to_string()
    } else {
        json_string(name)
    };

    let mut lines = vec![
        format!("[mcp_servers.{quoted}]"),
        format!("command = {}", toml_string(&server.command)),
        format!(
            "args = [{}]",
            server.args.iter().map(|a| toml_string(a)).collect::<Vec<_>>().join(", ")
        ),
    ];
    if !server.env.is_empty() {
        let env: Map<String, Value> = server
            .env
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        let pairs: Vec<String> = super::jsjson::js_ordered(&env)
            .into_iter()
            .map(|(k, v)| format!("{k} = {}", toml_string(v.as_str().unwrap_or(""))))
            .collect();
        lines.push(format!("env = {{ {} }}", pairs.join(", ")));
    }
    let table = format!("{}\n", lines.join("\n"));

    if let Some((start, end)) = toml_table_range(source, name) {
        // Carry over the separator that was there: the range runs to the next
        // header, so it includes the blank line between the two, and a
        // replacement ending in a single "\n" would quietly close the gap.
        let original = &source[start..end];
        let separator = match trailing_blank_lines(original) {
            "" => "\n",
            sep => sep,
        };
        let table = table.strip_suffix('\n').unwrap_or(&table);
        return Ok(format!("{}{table}{separator}{}", &source[..start], &source[end..]));
    }

    if js_trim(source).is_empty() {
        return Ok(table);
    }
    Ok(format!("{}\n\n{table}", source.trim_end_matches('\n')))
}

// ---- Hermes (YAML) -------------------------------------------------------------

/// Merge into Hermes Agent's `config.yaml`.
///
/// YAML is significant-whitespace, so text surgery is not safe the way it is
/// for TOML; a parse and re-emit is the correct trade even though it
/// reformats (comments are lost, as in the TS). The backup makes that fine.
pub fn merge_hermes_yaml(existing: Option<&str>, name: &str, server: &StdioServer) -> MergeResult {
    let mut root = Map::new();
    if let Some(text) = existing {
        if !js_trim(text).is_empty() {
            let parsed = parse_yaml(&strip_boms(text))
                .ok_or_else(|| MergeError(messages::config_unparseable("Hermes")))?;
            match parsed {
                Value::Object(map) => root = map,
                _ => return Err(MergeError(messages::config_not_an_object("Hermes"))),
            }
        }
    }

    let mut servers = record(root.get("mcp_servers")).cloned().unwrap_or_default();
    let mut entry = Map::new();
    entry.insert("command".into(), Value::String(server.command.clone()));
    entry.insert("args".into(), str_array(&server.args));
    if let Some(env) = env_object(server) {
        entry.insert("env".into(), env);
    }
    entry.insert("enabled".into(), Value::Bool(true));
    servers.insert(name.to_string(), Value::Object(entry));

    root.insert("mcp_servers".into(), Value::Object(servers));
    Ok(yaml_emit::stringify(&root))
}

// ---- Removal -------------------------------------------------------------------
//
// The inverse of each merge: an agent host left pointing at a binary that no
// longer exists reports a failed MCP server on every launch. Each returns
// `None` when there was nothing of ours to remove, so a caller can leave the
// file alone rather than rewrite it for no reason.

pub fn remove_from_mcp_json(existing: Option<&str>, name: &str) -> Option<String> {
    let text = existing.filter(|t| !js_trim(t).is_empty())?;
    let mut root = safe_json(Some(text));
    let mut servers = record(root.get("mcpServers"))?.clone();
    servers.get(name)?;
    servers.shift_remove(name);

    // Drop the key entirely when it was only ever holding ours, so an
    // untouched config comes back looking untouched.
    if servers.is_empty() {
        root.shift_remove("mcpServers");
    } else {
        root.insert("mcpServers".into(), Value::Object(servers));
    }
    Some(pretty_with_newline(Value::Object(root)))
}

pub fn remove_from_opencode_json(existing: Option<&str>, name: &str) -> Option<String> {
    let text = existing.filter(|t| !js_trim(t).is_empty())?;
    let mut root = safe_json(Some(text));
    let mut mcp = record(root.get("mcp"))?.clone();
    mcp.get(name)?;
    mcp.shift_remove(name);

    if mcp.is_empty() {
        root.shift_remove("mcp");
    } else {
        root.insert("mcp".into(), Value::Object(mcp));
    }
    Some(pretty_with_newline(Value::Object(root)))
}

pub fn remove_from_codex_toml(existing: Option<&str>, name: &str) -> Option<String> {
    let text = existing.filter(|t| !js_trim(t).is_empty())?;
    let (start, end) = toml_table_range(text, name)?;

    // Text surgery again: a parse and re-emit would lose the comments and key
    // order in a file the user maintains by hand.
    let next = format!("{}{}", &text[..start], &text[end..]);
    Some(collapse_blank_runs(&next).trim_start_matches('\n').to_string())
}

/// `.replace(/\n{3,}/g, "\n\n")`.
fn collapse_blank_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0usize;
    let flush = |out: &mut String, run: usize| {
        let kept = if run >= 3 { 2 } else { run };
        out.push_str(&"\n".repeat(kept));
    };
    for c in text.chars() {
        if c == '\n' {
            run += 1;
            continue;
        }
        flush(&mut out, run);
        run = 0;
        out.push(c);
    }
    flush(&mut out, run);
    out
}

pub fn remove_from_hermes_yaml(existing: Option<&str>, name: &str) -> Option<String> {
    let text = existing.filter(|t| !js_trim(t).is_empty())?;
    let mut root = match parse_yaml(&strip_boms(text))? {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let mut servers = record(root.get("mcp_servers"))?.clone();
    servers.get(name)?;
    servers.shift_remove(name);

    if servers.is_empty() {
        root.shift_remove("mcp_servers");
    } else {
        root.insert("mcp_servers".into(), Value::Object(servers));
    }
    Some(yaml_emit::stringify(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> StdioServer {
        StdioServer::new(
            "bun",
            &["run", "C:/proj/src/bun/mcp/standalone.ts"],
            &[("OKF_BUNDLE", "C:/notes")],
        )
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    // ---- Claude Code (.mcp.json)

    #[test]
    fn mcp_json_creates_the_file_when_absent() {
        let out = merge_mcp_json(None, "okf-wiki", &server()).unwrap();
        let v = json(&out);
        assert_eq!(v["mcpServers"]["okf-wiki"]["command"], "bun");
        assert_eq!(v["mcpServers"]["okf-wiki"]["env"]["OKF_BUNDLE"], "C:/notes");
        assert!(out.ends_with("}\n"));
    }

    #[test]
    fn mcp_json_keeps_other_servers_and_other_top_level_keys() {
        let existing = r#"{"mcpServers":{"notion":{"command":"npx","args":["-y","notion"]}},"somethingElse":{"keep":true}}"#;
        let v = json(&merge_mcp_json(Some(existing), "okf-wiki", &server()).unwrap());
        assert_eq!(v["mcpServers"]["notion"]["command"], "npx");
        assert_eq!(v["somethingElse"]["keep"], true);
        assert!(v["mcpServers"]["okf-wiki"].is_object());
    }

    #[test]
    fn mcp_json_replaces_our_own_entry_rather_than_duplicating_it() {
        let once = merge_mcp_json(None, "okf-wiki", &server()).unwrap();
        let twice = merge_mcp_json(Some(&once), "okf-wiki", &server()).unwrap();
        assert_eq!(twice, once);
        let keys: Vec<_> = json(&twice)["mcpServers"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["okf-wiki"]);
    }

    #[test]
    fn mcp_json_a_file_we_cannot_read_stops_the_connection() {
        let err = merge_mcp_json(Some("{not json"), "okf-wiki", &server()).unwrap_err();
        assert!(err.0.contains("失われる"), "{err}");
    }

    #[test]
    fn mcp_json_a_non_object_root_is_named_as_such() {
        let err = merge_mcp_json(Some("[1,2]"), "okf-wiki", &server()).unwrap_err();
        assert_eq!(err.0, messages::config_not_an_object("mcpServers"));
        let err = merge_opencode_json(Some("3"), "okf-wiki", &server()).unwrap_err();
        assert_eq!(err.0, messages::config_not_an_object("opencode"));
    }

    #[test]
    fn mcp_json_key_order_and_numbers_survive_like_js() {
        // Integer-like keys move to the front and 1.0 prints as 1, exactly as
        // JSON.parse + JSON.stringify do.
        let existing = r#"{"z":1.0,"7":true,"a":{"x":2.50}}"#;
        let out = merge_mcp_json(Some(existing), "okf-wiki", &StdioServer::new("c", &[], &[])).unwrap();
        assert!(out.starts_with("{\n  \"7\": true,\n  \"z\": 1,\n  \"a\": {\n    \"x\": 2.5\n  },\n  \"mcpServers\""), "{out}");
        assert!(out.contains("\"args\": []"));
        assert!(!out.contains("\"env\""));
    }

    // ---- opencode

    #[test]
    fn opencode_uses_the_mcp_key_a_type_and_a_single_command_array() {
        let v = json(&merge_opencode_json(None, "okf-wiki", &server()).unwrap());
        let entry = &v["mcp"]["okf-wiki"];
        assert_eq!(entry["type"], "local");
        assert_eq!(entry["command"], json(r#"["bun","run","C:/proj/src/bun/mcp/standalone.ts"]"#));
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["environment"]["OKF_BUNDLE"], "C:/notes");
        assert!(entry.get("env").is_none());
        assert_eq!(v["$schema"], "https://opencode.ai/config.json");
    }

    #[test]
    fn opencode_keeps_existing_servers_settings_and_schema_position() {
        let existing = r#"{"model":"anthropic/claude-sonnet-5","$schema":"custom","mcp":{"other":{"type":"local","command":["x"]}}}"#;
        let out = merge_opencode_json(Some(existing), "okf-wiki", &server()).unwrap();
        let v = json(&out);
        assert_eq!(v["model"], "anthropic/claude-sonnet-5");
        assert_eq!(v["mcp"]["other"]["command"], json(r#"["x"]"#));
        assert_eq!(v["$schema"], "custom");
        // `$schema` was first in the defaults object, so it stays first.
        assert!(out.starts_with("{\n  \"$schema\": \"custom\",\n  \"model\""), "{out}");
    }

    // ---- Codex (TOML)

    fn codex_existing() -> String {
        [
            "personality = \"pragmatic\"",
            "model = \"gpt-5.6-terra\"",
            "",
            "[mcp_servers.pencil]",
            "command = \"c:\\\\tools\\\\pencil.exe\"",
            "args = [ \"--app\", \"antigravity\" ]",
            "",
            "[windows]",
            "sandbox = \"elevated\"",
            "",
            "[projects.'C:\\Users\\me']",
            "trust_level = \"trusted\"",
            "",
        ]
        .join("\n")
    }

    #[test]
    fn codex_appends_our_table_without_disturbing_anything_else() {
        let merged = merge_codex_toml(Some(&codex_existing()), "okf-wiki", &server()).unwrap();
        for needle in [
            "personality = \"pragmatic\"",
            "[mcp_servers.pencil]",
            "[windows]",
            "[projects.'C:\\Users\\me']",
            "[mcp_servers.okf-wiki]",
            "command = \"bun\"",
            "env = { OKF_BUNDLE = \"C:/notes\" }",
        ] {
            assert!(merged.contains(needle), "{needle}\n{merged}");
        }
        assert!(merged.starts_with(&codex_existing().trim_end_matches('\n').to_string()));
    }

    #[test]
    fn codex_second_run_changes_nothing_at_all() {
        let once = merge_codex_toml(Some(&codex_existing()), "okf-wiki", &server()).unwrap();
        let twice = merge_codex_toml(Some(&once), "okf-wiki", &server()).unwrap();
        let thrice = merge_codex_toml(Some(&twice), "okf-wiki", &server()).unwrap();
        assert_eq!(twice.matches("[mcp_servers.okf-wiki]").count(), 1);
        assert!(twice.contains("[windows]"));
        assert_eq!(twice, once);
        assert_eq!(thrice, once);
    }

    #[test]
    fn codex_blank_lines_around_our_table_are_left_alone() {
        let with_ours = [
            "[general]",
            "model = \"x\"",
            "",
            "[mcp_servers.okf-wiki]",
            "command = \"old\"",
            "args = []",
            "",
            "[windows]",
            "shell = true",
            "",
        ]
        .join("\n");
        let merged = merge_codex_toml(Some(&with_ours), "okf-wiki", &server()).unwrap();
        assert!(merged.contains("model = \"x\"\n\n[mcp_servers.okf-wiki]"));
        assert!(merged.contains("\n\n[windows]"));
        assert!(!merged.contains("command = \"old\""));
    }

    #[test]
    fn codex_replacing_our_table_does_not_swallow_the_next_one() {
        let with_ours = [
            "[mcp_servers.okf-wiki]",
            "command = \"old\"",
            "args = []",
            "",
            "[mcp_servers.keep-me]",
            "command = \"npx\"",
            "",
        ]
        .join("\n");
        let merged = merge_codex_toml(Some(&with_ours), "okf-wiki", &server()).unwrap();
        assert!(merged.contains("[mcp_servers.keep-me]"));
        assert!(!merged.contains("command = \"old\""));
    }

    #[test]
    fn codex_escapes_windows_paths() {
        let merged = merge_codex_toml(
            None,
            "okf-wiki",
            &StdioServer::new("C:\\Program Files\\bun\\bun.exe", &[], &[]),
        )
        .unwrap();
        assert!(merged.contains("command = \"C:\\\\Program Files\\\\bun\\\\bun.exe\""));
        assert!(merged.starts_with("[mcp_servers.okf-wiki]"));
    }

    #[test]
    fn codex_crlf_files_keep_their_line_endings() {
        let existing = "model = \"x\"\r\n\r\n[mcp_servers.okf-wiki]\r\ncommand = \"old\"\r\n\r\n[windows]\r\nshell = true\r\n";
        let merged = merge_codex_toml(Some(existing), "okf-wiki", &server()).unwrap();
        assert!(merged.starts_with("model = \"x\"\r\n\r\n[mcp_servers.okf-wiki]\ncommand = \"bun\""), "{merged:?}");
        assert!(merged.ends_with("\r\n\r\n[windows]\r\nshell = true\r\n"), "{merged:?}");
    }

    #[test]
    fn codex_a_name_that_needs_quoting_is_json_quoted() {
        let merged = merge_codex_toml(None, "my server", &StdioServer::new("c", &[], &[])).unwrap();
        assert!(merged.starts_with("[mcp_servers.\"my server\"]\n"));
    }

    // ---- Hermes (YAML)

    #[test]
    fn hermes_adds_under_mcp_servers_and_keeps_the_rest() {
        let existing = "model: hermes-4\nmcp_servers:\n  fs:\n    command: npx\n";
        let out = merge_hermes_yaml(Some(existing), "okf-wiki", &server()).unwrap();
        assert_eq!(
            out,
            "model: hermes-4\nmcp_servers:\n  fs:\n    command: npx\n  okf-wiki:\n    command: bun\n    args:\n      - run\n      - C:/proj/src/bun/mcp/standalone.ts\n    env:\n      OKF_BUNDLE: C:/notes\n    enabled: true\n"
        );
    }

    #[test]
    fn hermes_is_idempotent() {
        let once = merge_hermes_yaml(None, "okf-wiki", &server()).unwrap();
        let twice = merge_hermes_yaml(Some(&once), "okf-wiki", &server()).unwrap();
        assert_eq!(twice, once);
        assert_eq!(twice.matches("okf-wiki:").count(), 1);
    }

    #[test]
    fn hermes_unreadable_yaml_is_refused() {
        let broken = "mcp_servers:\n  notion:\n    command: npx\n   bad: indent\n";
        let err = merge_hermes_yaml(Some(broken), "okf-wiki", &server()).unwrap_err();
        assert!(err.0.contains("失われる"), "{err}");
        let err = merge_hermes_yaml(Some("- a\n- b\n"), "okf-wiki", &server()).unwrap_err();
        assert_eq!(err.0, messages::config_not_an_object("Hermes"));
    }

    // ---- Removal

    #[test]
    fn mcp_json_removal_keeps_everything_else() {
        let existing = r#"{"mcpServers":{"notion":{"command":"npx","args":["-y","notion"]},"okf-wiki":{"command":"old"}},"otherSetting":{"keep":true}}"#;
        let v = json(&remove_from_mcp_json(Some(existing), "okf-wiki").unwrap());
        assert!(v["mcpServers"].get("okf-wiki").is_none());
        assert_eq!(v["mcpServers"]["notion"]["command"], "npx");
        assert_eq!(v["otherSetting"]["keep"], true);
    }

    #[test]
    fn mcp_json_removal_drops_the_key_when_it_only_held_ours() {
        let once = merge_mcp_json(None, "okf-wiki", &server()).unwrap();
        let v = json(&remove_from_mcp_json(Some(&once), "okf-wiki").unwrap());
        assert!(v.get("mcpServers").is_none());
    }

    #[test]
    fn round_trip_leaves_the_users_settings_as_they_were() {
        type Merge = fn(Option<&str>, &str, &StdioServer) -> MergeResult;
        type Remove = fn(Option<&str>, &str) -> Option<String>;
        let pairs: [(Merge, Remove); 2] = [
            (merge_mcp_json, remove_from_mcp_json),
            (merge_opencode_json, remove_from_opencode_json),
        ];
        for (merge, remove) in pairs {
            let before = "{\n  \"keep\": 1,\n  \"other\": {\n    \"a\": 2\n  }\n}\n";
            let merged = merge(Some(before), "okf-wiki", &server()).unwrap();
            let after = json(&remove(Some(&merged), "okf-wiki").unwrap());
            assert_eq!(after["keep"], 1);
            assert_eq!(after["other"], json(r#"{"a":2}"#));
            assert!(!after.to_string().contains("okf-wiki"));
        }
    }

    #[test]
    fn opencode_schema_hint_is_left_behind_deliberately() {
        let merged = merge_opencode_json(Some(r#"{"keep":1}"#), "okf-wiki", &server()).unwrap();
        let after = json(&remove_from_opencode_json(Some(&merged), "okf-wiki").unwrap());
        assert!(after.get("$schema").is_some());
        assert!(after.get("mcp").is_none());
    }

    #[test]
    fn codex_removal_takes_our_table_and_nothing_else() {
        let existing = [
            "model = \"gpt-5.6-terra\"",
            "",
            "[mcp_servers.okf-wiki]",
            "command = \"bun\"",
            "",
            "[mcp_servers.keep-me]",
            "command = \"npx\"",
            "",
            "[windows]",
            "sandbox = \"elevated\"",
            "",
        ]
        .join("\n");
        let next = remove_from_codex_toml(Some(&existing), "okf-wiki").unwrap();
        assert!(!next.contains("[mcp_servers.okf-wiki]"));
        assert!(next.contains("[mcp_servers.keep-me]"));
        assert!(next.contains("[windows]"));
        assert!(next.contains("model = \"gpt-5.6-terra\""));
    }

    #[test]
    fn codex_removal_keeps_comments_because_it_is_text_surgery() {
        let existing = ["# my notes", "model = \"x\"", "", "[mcp_servers.okf-wiki]", "command = \"bun\"", ""].join("\n");
        let next = remove_from_codex_toml(Some(&existing), "okf-wiki").unwrap();
        assert!(next.contains("# my notes"));
    }

    #[test]
    fn hermes_removal_keeps_the_other_server() {
        let existing = merge_hermes_yaml(
            Some("model: hermes-4\nmcp_servers:\n  fs:\n    command: npx\n"),
            "okf-wiki",
            &server(),
        )
        .unwrap();
        let next = remove_from_hermes_yaml(Some(&existing), "okf-wiki").unwrap();
        assert!(next.contains("fs:"));
        assert!(!next.contains("okf-wiki"));
        assert!(next.contains("hermes-4"));
    }

    #[test]
    fn removal_from_a_file_without_our_entry_is_none() {
        assert_eq!(remove_from_mcp_json(Some(r#"{"mcpServers":{"notion":{}}}"#), "okf-wiki"), None);
        assert_eq!(remove_from_codex_toml(Some("model = \"x\""), "okf-wiki"), None);
        assert_eq!(remove_from_hermes_yaml(Some("model: hermes-4"), "okf-wiki"), None);
        assert_eq!(remove_from_opencode_json(Some(r#"{"mcp":{"other":{}}}"#), "okf-wiki"), None);
    }

    #[test]
    fn removal_from_nothing_is_none() {
        assert_eq!(remove_from_mcp_json(None, "okf-wiki"), None);
        assert_eq!(remove_from_codex_toml(Some(""), "okf-wiki"), None);
    }

    // ---- Refusing to rewrite a config we could not read

    const JSONC: &str = "{\n  // the notion server\n  \"mcpServers\": {\n    \"notion\": { \"command\": \"npx\", \"args\": [\"-y\", \"notion\"] }\n  },\n}";

    #[test]
    fn jsonc_is_refused_not_silently_replaced() {
        assert!(merge_mcp_json(Some(JSONC), "okf-wiki", &server()).unwrap_err().0.contains("失われる"));
        assert!(merge_opencode_json(Some(JSONC), "okf-wiki", &server()).unwrap_err().0.contains("失われる"));
    }

    #[test]
    fn absent_or_empty_is_a_fresh_config() {
        for empty in [None, Some(""), Some("   "), Some("\u{3000}\n")] {
            let v = json(&merge_mcp_json(empty, "okf-wiki", &server()).unwrap());
            assert!(v["mcpServers"]["okf-wiki"].is_object());
        }
    }

    #[test]
    fn removal_never_rewrites_a_config_it_could_not_read() {
        assert_eq!(remove_from_mcp_json(Some(JSONC), "okf-wiki"), None);
        assert_eq!(remove_from_opencode_json(Some(JSONC), "okf-wiki"), None);
    }
}
