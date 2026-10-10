//! Argument parsing for the `okf` CLI (`src/bun/cli/args.ts`).
//!
//! Deliberately small and dependency-free. The CLI's whole job is to hand a
//! JSON object to the same tool dispatcher the MCP server uses, so the only
//! real work here is turning `--flag value` into that shape with the types the
//! tool's JSON Schema declares.
//!
//! Pure, so the mapping can be tested without spawning a process.

use crate::connect::jsjson;
use crate::shared::js_compat::{js_number, js_trim};
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Map, Number, Value};
use std::sync::LazyLock;

/// What a flag holds: bare `--flag` is `true`, anything else is its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlagValue {
    Bool(bool),
    Str(String),
}

impl FlagValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s),
            Self::Bool(_) => None,
        }
    }

    /// Whether the flag is a bare `--flag` (the TS `=== true`).
    pub fn is_true(&self) -> bool {
        matches!(self, Self::Bool(true))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedArgs {
    /// Positional arguments, in order.
    pub positional: Vec<String>,
    /// `--key value`, `--key=value`, and `--flag` (true), under underscore names.
    pub flags: IndexMap<String, FlagValue>,
}

impl ParsedArgs {
    pub fn flag(&self, name: &str) -> Option<&FlagValue> {
        self.flags.get(name)
    }

    /// Whether the flag is set to anything at all (JS truthiness of the value).
    pub fn flag_set(&self, name: &str) -> bool {
        match self.flags.get(name) {
            Some(FlagValue::Bool(b)) => *b,
            Some(FlagValue::Str(s)) => !s.is_empty(),
            None => false,
        }
    }
}

/// Whether a token is a flag rather than a value.
///
/// A flag name begins with a letter, which is what separates `--limit` from a
/// value that merely opens with dashes (Markdown frontmatter starts `---`).
/// `--` itself counts even though it names no flag: it is the terminator, and
/// letting a preceding bare flag eat it would lose it.
fn is_flag_token(token: &str) -> bool {
    match token.strip_prefix("--") {
        Some(rest) => rest.chars().next().is_none_or(|c| c.is_ascii_alphabetic()),
        None => false,
    }
}

/// Normalise a flag name to the underscore spelling the code reads, so that
/// `--purge-settings` (the spelling the help prints) reaches `purge_settings`.
fn flag_name(name: &str) -> String {
    name.replace('-', "_")
}

pub fn parse_argv<S: AsRef<str>>(argv: &[S]) -> ParsedArgs {
    let mut positional: Vec<String> = Vec::new();
    let mut flags: IndexMap<String, FlagValue> = IndexMap::new();

    let mut i = 0;
    while i < argv.len() {
        let token = argv[i].as_ref();

        if token == "--" {
            // Everything after `--` is positional, so a query can start with a dash.
            positional.extend(argv[i + 1..].iter().map(|a| a.as_ref().to_string()));
            break;
        }

        if !token.starts_with("--") {
            positional.push(token.to_string());
            i += 1;
            continue;
        }

        let body = &token[2..];
        if let Some(eq) = body.find('=') {
            flags.insert(flag_name(&body[..eq]), FlagValue::Str(body[eq + 1..].to_string()));
            i += 1;
            continue;
        }

        // A bare flag is `true`; anything else consumes the following token.
        match argv.get(i + 1).map(|a| a.as_ref()) {
            Some(next) if !is_flag_token(next) => {
                flags.insert(flag_name(body), FlagValue::Str(next.to_string()));
                i += 1;
            }
            _ => {
                flags.insert(flag_name(body), FlagValue::Bool(true));
            }
        }
        i += 1;
    }

    ParsedArgs { positional, flags: js_object_order(flags) }
}

/// Integer-like names come first in ascending order in a JS object, wherever
/// they were written (`--5` after `--query`).
fn js_object_order(flags: IndexMap<String, FlagValue>) -> IndexMap<String, FlagValue> {
    if !flags.keys().any(|k| jsjson::array_index(k).is_some()) {
        return flags;
    }
    let mut indexed: Vec<(u32, String, FlagValue)> = Vec::new();
    let mut rest: Vec<(String, FlagValue)> = Vec::new();
    for (k, v) in flags {
        match jsjson::array_index(&k) {
            Some(n) => indexed.push((n, k, v)),
            None => rest.push((k, v)),
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

/// A JS number as a JSON value: whole numbers carry no fraction.
fn number_value(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        return Value::Number(Number::from(x as i64));
    }
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// Coerce a flag value to the type the tool's schema asks for.
///
/// The same forgiving rules as the connections panel: a schema is a contract
/// with the tool, not with the person typing, and a server that declares
/// `number` should still accept something it can parse. `schema` is one
/// property of the tool's `inputSchema` (only `type` is read).
pub fn coerce(value: &FlagValue, schema: &Value) -> Value {
    let text = match value {
        FlagValue::Bool(b) => return Value::Bool(*b),
        FlagValue::Str(s) => s,
    };

    static FALSEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)^(?:false|0|no|off)$").unwrap());

    match schema.get("type").and_then(Value::as_str) {
        Some("number") | Some("integer") => {
            let parsed = js_number(text);
            if parsed.is_finite() {
                number_value(parsed)
            } else {
                Value::String(text.clone())
            }
        }
        Some("boolean") => Value::Bool(!FALSEY.is_match(text)),
        Some("array") => Value::Array(
            text.split(',')
                .map(js_trim)
                .filter(|part| !part.is_empty())
                .map(|part| Value::String(part.to_string()))
                .collect(),
        ),
        Some("object") => jsjson::parse(text).unwrap_or_else(|| Value::String(text.clone())),
        _ => Value::String(text.clone()),
    }
}

/// The parts of a tool's `inputSchema` the mapping reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolSchema {
    pub properties: Map<String, Value>,
    pub required: Vec<String>,
}

impl ToolSchema {
    /// From the JSON Schema object a tool declares.
    pub fn from_json(schema: &Value) -> Self {
        Self {
            properties: schema
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            required: schema
                .get("required")
                .and_then(Value::as_array)
                .map(|r| r.iter().filter_map(|k| k.as_str().map(String::from)).collect())
                .unwrap_or_default(),
        }
    }
}

/// Flags handled by the CLI itself rather than passed to a tool.
pub const RESERVED_FLAGS: [&str; 5] = ["bundle", "json", "quiet", "help", "version"];

/// Build a tool's argument object from the command line.
///
/// Positional arguments fill the schema's `required` fields in order, so
/// `okf search "設計"` works without naming `--query`. Flags always win, so the
/// explicit form stays available when a value would look like a flag. Returns
/// the arguments and the required keys still missing.
pub fn build_tool_args(schema: &ToolSchema, parsed: &ParsedArgs) -> (Map<String, Value>, Vec<String>) {
    let mut args: Map<String, Value> = Map::new();

    for (key, value) in &parsed.flags {
        // Flags the CLI itself owns are not tool arguments.
        if RESERVED_FLAGS.contains(&key.as_str()) {
            continue;
        }
        let Some(property) = schema.properties.get(key) else { continue };
        args.insert(key.clone(), coerce(value, property));
    }

    let empty = Value::Object(Map::new());
    let mut next = 0;
    for key in &schema.required {
        if args.contains_key(key) {
            continue;
        }
        let Some(positional) = parsed.positional.get(next) else { continue };
        next += 1;
        args.insert(
            key.clone(),
            coerce(&FlagValue::Str(positional.clone()), schema.properties.get(key).unwrap_or(&empty)),
        );
    }

    let missing = schema.required.iter().filter(|k| !args.contains_key(*k)).cloned().collect();
    (args, missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn str_flag(s: &str) -> FlagValue {
        FlagValue::Str(s.to_string())
    }

    // ---- argument parsing

    #[test]
    fn splits_positionals_from_flags() {
        let parsed = parse_argv(&["search", "設計", "--limit", "5"]);
        assert_eq!(parsed.positional, ["search", "設計"]);
        assert_eq!(parsed.flag("limit"), Some(&str_flag("5")));
    }

    #[test]
    fn accepts_key_equals_value() {
        assert_eq!(parse_argv(&["--budget_chars=6000"]).flag("budget_chars"), Some(&str_flag("6000")));
        // Only the first `=` splits; the rest belongs to the value.
        assert_eq!(parse_argv(&["--q=a=b"]).flag("q"), Some(&str_flag("a=b")));
    }

    #[test]
    fn a_value_that_opens_with_dashes_is_a_value_not_the_next_flag() {
        // Markdown frontmatter starts `---`. Reading it as a flag left --content
        // valueless, and write-file then wrote an empty file over what was passed.
        let body = "---\ntype: Note\n---\n\nbody\n";
        let parsed = parse_argv(&["write-file", "--path", "wiki/a.md", "--content", body]);
        assert_eq!(parsed.flag("content"), Some(&str_flag(body)));
        assert_eq!(parsed.flag("path"), Some(&str_flag("wiki/a.md")));
    }

    #[test]
    fn a_real_flag_still_terminates_the_one_before_it() {
        let parsed = parse_argv(&["--json", "--limit", "5"]);
        assert_eq!(parsed.flag("json"), Some(&FlagValue::Bool(true)));
        assert_eq!(parsed.flag("limit"), Some(&str_flag("5")));
    }

    #[test]
    fn a_bare_flag_does_not_swallow_the_terminator() {
        // `--quiet` used to consume `--`, which lost the terminator and let the
        // positional after it be reparsed as a flag: the query vanished.
        let parsed = parse_argv(&["search", "--quiet", "--", "--設計"]);
        assert_eq!(parsed.flag("quiet"), Some(&FlagValue::Bool(true)));
        assert_eq!(parsed.positional, ["search", "--設計"]);
        assert_eq!(parsed.flag("設計"), None);
    }

    #[test]
    fn a_hyphenated_flag_reaches_the_code_under_its_underscore_name() {
        assert_eq!(parse_argv(&["--purge-settings"]).flag("purge_settings"), Some(&FlagValue::Bool(true)));
        assert_eq!(parse_argv(&["--purge_settings"]).flag("purge_settings"), Some(&FlagValue::Bool(true)));
        assert_eq!(parse_argv(&["--path-prefix=wiki/"]).flag("path_prefix"), Some(&str_flag("wiki/")));
    }

    #[test]
    fn a_bare_flag_is_true() {
        assert_eq!(parse_argv(&["lint", "--json"]).flag("json"), Some(&FlagValue::Bool(true)));
        let both = parse_argv(&["--json", "--quiet"]);
        assert_eq!(both.flag("json"), Some(&FlagValue::Bool(true)));
        assert_eq!(both.flag("quiet"), Some(&FlagValue::Bool(true)));
    }

    #[test]
    fn everything_after_the_terminator_is_positional() {
        let parsed = parse_argv(&["search", "--", "--not-a-flag"]);
        assert_eq!(parsed.positional, ["search", "--not-a-flag"]);
    }

    #[test]
    fn a_repeated_flag_keeps_its_first_position_and_the_last_value() {
        let parsed = parse_argv(&["--a", "1", "--b", "2", "--a", "3"]);
        let entries: Vec<_> = parsed.flags.iter().map(|(k, v)| (k.as_str(), v.as_str().unwrap())).collect();
        assert_eq!(entries, [("a", "3"), ("b", "2")]);
    }

    #[test]
    fn a_trailing_flag_with_no_value_is_true_and_flag_set_follows_js_truthiness() {
        let parsed = parse_argv(&["x", "--apply", "--rollback=", "--notes"]);
        assert!(parsed.flag_set("apply"));
        assert!(!parsed.flag_set("rollback"));
        assert!(parsed.flag("notes").unwrap().is_true());
        assert!(!parsed.flag_set("missing"));
    }

    // ---- coercion

    #[test]
    fn numbers_booleans_and_arrays() {
        assert_eq!(coerce(&str_flag("8"), &json!({"type": "number"})), json!(8));
        assert_eq!(coerce(&str_flag("false"), &json!({"type": "boolean"})), json!(false));
        assert_eq!(coerce(&str_flag("true"), &json!({"type": "boolean"})), json!(true));
        assert_eq!(coerce(&str_flag("a, b ,c"), &json!({"type": "array"})), json!(["a", "b", "c"]));
    }

    #[test]
    fn boolean_falsey_words_are_case_insensitive_and_anything_else_is_true() {
        for word in ["false", "FALSE", "0", "No", "OFF"] {
            assert_eq!(coerce(&str_flag(word), &json!({"type": "boolean"})), json!(false), "{word}");
        }
        for word in ["yes", "1", "", "falsey", "false\n"] {
            assert_eq!(coerce(&str_flag(word), &json!({"type": "boolean"})), json!(true), "{word:?}");
        }
        assert_eq!(coerce(&FlagValue::Bool(true), &json!({"type": "number"})), json!(true));
    }

    #[test]
    fn numbers_follow_js_number_semantics() {
        let n = json!({"type": "number"});
        assert_eq!(coerce(&str_flag(" 5 "), &n), json!(5));
        assert_eq!(coerce(&str_flag("0x10"), &n), json!(16));
        assert_eq!(coerce(&str_flag("2.5"), &n), json!(2.5));
        assert_eq!(coerce(&str_flag(""), &n), json!(0));
        assert_eq!(coerce(&str_flag("1e3"), &n), json!(1000));
        assert_eq!(coerce(&str_flag("Infinity"), &n), json!("Infinity"));
    }

    #[test]
    fn a_value_that_cannot_convert_is_passed_through_for_the_tool_to_reject() {
        assert_eq!(coerce(&str_flag("many"), &json!({"type": "number"})), json!("many"));
        assert_eq!(coerce(&str_flag("{oops"), &json!({"type": "object"})), json!("{oops"));
        assert_eq!(coerce(&str_flag("{\"a\":1}"), &json!({"type": "object"})), json!({"a": 1}));
    }

    #[test]
    fn japanese_survives_untouched() {
        assert_eq!(coerce(&str_flag("  設計原則  "), &json!({"type": "string"})), json!("  設計原則  "));
        assert_eq!(coerce(&str_flag("x"), &json!({})), json!("x"));
    }

    #[test]
    fn array_items_are_trimmed_with_js_whitespace_and_empties_dropped() {
        assert_eq!(coerce(&str_flag("a,,\u{3000}b\u{3000},"), &json!({"type": "array"})), json!(["a", "b"]));
    }

    // ---- filling a tool's arguments

    fn search() -> ToolSchema {
        ToolSchema::from_json(&json!({
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "number"}},
            "required": ["query"]
        }))
    }

    fn parsed(positional: &[&str], flags: &[(&str, FlagValue)]) -> ParsedArgs {
        ParsedArgs {
            positional: positional.iter().map(|p| p.to_string()).collect(),
            flags: flags.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
        }
    }

    #[test]
    fn required_arguments_can_be_given_positionally() {
        let (args, missing) = build_tool_args(&search(), &parsed(&["日本語検索"], &[]));
        assert_eq!(args.get("query"), Some(&json!("日本語検索")));
        assert!(missing.is_empty());
    }

    #[test]
    fn flags_win_over_positionals() {
        let (args, _) = build_tool_args(&search(), &parsed(&["ignored"], &[("query", str_flag("explicit"))]));
        assert_eq!(args.get("query"), Some(&json!("explicit")));
    }

    #[test]
    fn missing_required_arguments_are_reported_not_guessed() {
        let (_, missing) = build_tool_args(&search(), &parsed(&[], &[]));
        assert_eq!(missing, ["query"]);
    }

    #[test]
    fn the_clis_own_flags_are_never_passed_to_a_tool() {
        let (args, _) = build_tool_args(
            &search(),
            &parsed(&["q"], &[("json", FlagValue::Bool(true)), ("bundle", str_flag("C:/x"))]),
        );
        assert!(args.get("json").is_none());
        assert!(args.get("bundle").is_none());
    }

    #[test]
    fn unknown_flags_are_ignored_rather_than_sent_as_junk() {
        let (args, _) = build_tool_args(&search(), &parsed(&["q"], &[("nonsense", str_flag("x"))]));
        assert!(args.get("nonsense").is_none());
    }

    #[test]
    fn flags_are_coerced_by_their_property_type_and_positionals_fill_in_order() {
        let schema = ToolSchema::from_json(&json!({
            "type": "object",
            "properties": {"a": {"type": "string"}, "b": {"type": "number"}, "c": {"type": "boolean"}},
            "required": ["a", "b", "c"]
        }));
        // `b` is given by flag, so the two positionals fill `a` and `c`.
        let (args, missing) = build_tool_args(&schema, &parsed(&["one", "no"], &[("b", str_flag("7"))]));
        assert_eq!(Value::Object(args), json!({"b": 7, "a": "one", "c": false}));
        assert!(missing.is_empty());
    }

    #[test]
    fn a_schema_with_no_properties_or_required_builds_nothing() {
        let (args, missing) = build_tool_args(&ToolSchema::from_json(&json!({"type": "object"})), &parsed(&["x"], &[]));
        assert!(args.is_empty() && missing.is_empty());
    }
}
