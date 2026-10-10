//! Concept (de)serialisation (`src/bun/okf/parser.ts`).
//!
//! The TS owns the only YAML dependency (npm `yaml` 2.x, YAML 1.2 core
//! schema). This port parses with `yaml-rust2` events, resolving plain scalars
//! by the core-schema rules and rejecting what `yaml` rejects (duplicate keys,
//! several documents), and writes with a hand-written emitter that follows the
//! algorithm of `yaml`'s `stringify(value, { lineWidth: 0 })`: block style,
//! plain scalars unless they would read back as something else, literal block
//! scalars for multi-line text, no line folding.

use crate::shared::js_compat::{find_at_line_start, js_trim, js_trim_end, utf16_len};
use crate::shared::okf::concept::{concept_id_from_rel_path, DEFAULT_CONCEPT_TYPE};
use crate::shared::okf::frontmatter::{join_frontmatter, split_frontmatter, Eol};
use crate::shared::okf::links::extract_links;
use crate::shared::types::{ConceptDocument, ConceptFrontmatter};
use regex::Regex;
use serde_json::{Map, Number, Value};
use std::collections::HashSet;
use std::sync::LazyLock;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// Frontmatter keys emitted first, so hand-editing stays pleasant.
const KEY_ORDER: [&str; 5] = ["type", "title", "description", "tags", "status"];

#[derive(Debug, Clone)]
pub struct ParseConceptOptions<'a> {
    /// Concept id, i.e. wiki-relative path without `.md`.
    pub id: String,
    /// Bundle-relative path.
    pub rel_path: String,
    /// Absolute path on disk.
    pub abs_path: String,
    pub raw: String,
    pub mtime_ms: Option<f64>,
    /// Ids used to resolve `[[wikilinks]]`; omit during a first pass.
    pub known_ids: Option<&'a HashSet<String>>,
}

// ---- YAML parsing -----------------------------------------------------------

/// Result of resolving a plain scalar under the YAML 1.2 core schema.
fn resolve_plain(text: &str) -> Value {
    static INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+]?[0-9]+$").unwrap());
    static OCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0o[0-7]+$").unwrap());
    static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0x[0-9a-fA-F]+$").unwrap());
    static NAN_INF: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$").unwrap());
    static FLOAT_EXP: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$").unwrap()
    });
    static FLOAT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$").unwrap());

    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    if INT.is_match(text) {
        return number_value(text.trim_start_matches('+').parse::<f64>().unwrap_or(f64::NAN));
    }
    if OCT.is_match(text) {
        return number_value(u64::from_str_radix(&text[2..], 8).map_or(f64::NAN, |v| v as f64));
    }
    if HEX.is_match(text) {
        return number_value(u64::from_str_radix(&text[2..], 16).map_or(f64::NAN, |v| v as f64));
    }
    if NAN_INF.is_match(text) {
        // JSON has no Infinity or NaN; `JSON.stringify` writes null for both.
        return Value::Null;
    }
    if FLOAT_EXP.is_match(text) || FLOAT.is_match(text) {
        let t = text.trim_start_matches('+');
        let t = if t.starts_with('.') {
            format!("0{t}")
        } else if t.starts_with("-.") {
            format!("-0{}", &t[1..])
        } else {
            t.to_string()
        };
        return number_value(t.parse::<f64>().unwrap_or(f64::NAN));
    }
    Value::String(text.to_string())
}

/// A JS number as a JSON value: whole numbers carry no fraction.
fn number_value(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        return Value::Number(Number::from(x as i64));
    }
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// `String(number)` for a key that was written as a number.
fn js_number_string(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e21 {
        return format!("{}", x as i128);
    }
    let abs = x.abs();
    if (1e-6..1e21).contains(&abs) {
        return format!("{x}");
    }
    // JS writes exponents as `1e+21` / `1e-7`.
    let s = format!("{x:e}");
    match s.split_once('e') {
        Some((mant, exp)) if !exp.starts_with('-') => format!("{mant}e+{exp}"),
        _ => s,
    }
}

/// The JS property key for a YAML key node.
fn key_string(key: &Value) -> Option<String> {
    Some(match key {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(n.as_f64()?),
        _ => return None,
    })
}

/// Integer-like keys come first in ascending order in a JS object.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

fn js_object(entries: Vec<(String, Value)>) -> Map<String, Value> {
    let mut map = Map::new();
    for (k, v) in entries {
        map.insert(k, v);
    }
    if map.keys().any(|k| array_index(k).is_some()) {
        let mut indexed: Vec<(u32, String, Value)> = Vec::new();
        let mut rest: Vec<(String, Value)> = Vec::new();
        for (k, v) in map {
            match array_index(&k) {
                Some(n) => indexed.push((n, k, v)),
                None => rest.push((k, v)),
            }
        }
        indexed.sort_by_key(|(n, _, _)| *n);
        let mut ordered = Map::new();
        for (_, k, v) in indexed {
            ordered.insert(k, v);
        }
        for (k, v) in rest {
            ordered.insert(k, v);
        }
        return ordered;
    }
    map
}

enum Frame {
    Seq(Vec<Value>, usize),
    Map {
        pairs: Vec<(Value, Value)>,
        key: Option<Value>,
        anchor: usize,
    },
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    anchors: std::collections::HashMap<usize, Value>,
    documents: usize,
    root: Option<Value>,
    failed: bool,
}

impl Builder {
    fn finish(&mut self, value: Value, anchor: usize) {
        if anchor != 0 {
            self.anchors.insert(anchor, value.clone());
        }
        match self.stack.last_mut() {
            None => self.root = Some(value),
            Some(Frame::Seq(items, _)) => items.push(value),
            Some(Frame::Map { pairs, key, .. }) => match key.take() {
                None => *key = Some(value),
                Some(k) => {
                    // `yaml` refuses duplicate keys ("Map keys must be unique").
                    if pairs.iter().any(|(existing, _)| *existing == k) {
                        self.failed = true;
                    }
                    pairs.push((k, value));
                }
            },
        }
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, ev: Event, _mark: Marker) {
        match ev {
            Event::DocumentStart => self.documents += 1,
            Event::Scalar(text, style, anchor, tag) => {
                let value = match &tag {
                    // A core-schema tag forces the type whatever the style.
                    Some(t) if t.handle == "tag:yaml.org,2002:" => match t.suffix.as_str() {
                        "str" => Value::String(text),
                        "null" | "bool" | "int" | "float" => match resolve_plain(&text) {
                            v @ (Value::Null | Value::Bool(_) | Value::Number(_)) => v,
                            _ => Value::String(text),
                        },
                        _ if style != TScalarStyle::Plain => Value::String(text),
                        _ => resolve_plain(&text),
                    },
                    // An unresolvable tag leaves the text as a string.
                    Some(_) => Value::String(text),
                    None if style != TScalarStyle::Plain => Value::String(text),
                    None => resolve_plain(&text),
                };
                self.finish(value, anchor);
            }
            Event::Alias(id) => match self.anchors.get(&id).cloned() {
                Some(v) => self.finish(v, 0),
                None => self.failed = true,
            },
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq(Vec::new(), anchor)),
            Event::SequenceEnd => {
                if let Some(Frame::Seq(items, anchor)) = self.stack.pop() {
                    self.finish(Value::Array(items), anchor);
                }
            }
            Event::MappingStart(anchor, _) => self.stack.push(Frame::Map {
                pairs: Vec::new(),
                key: None,
                anchor,
            }),
            Event::MappingEnd => {
                if let Some(Frame::Map { pairs, anchor, .. }) = self.stack.pop() {
                    let mut entries = Vec::with_capacity(pairs.len());
                    for (k, v) in pairs {
                        match key_string(&k) {
                            Some(k) => entries.push((k, v)),
                            None => self.failed = true,
                        }
                    }
                    self.finish(Value::Object(js_object(entries)), anchor);
                }
            }
            _ => {}
        }
    }
}

/// `parseYaml(source)`: the document as JSON, or `None` where `yaml` throws.
///
/// A document with no content parses to `null`.
pub fn parse_yaml(source: &str) -> Option<Value> {
    let mut builder = Builder::default();
    let mut parser = Parser::new_from_str(source);
    parser.load(&mut builder, true).ok()?;
    if builder.failed || builder.documents > 1 {
        return None;
    }
    Some(builder.root.unwrap_or(Value::Null))
}

/// Parse frontmatter into the object the TS holds in `ConceptFrontmatter`.
///
/// A YAML document can legally be a scalar, a list or null, none of which is a
/// mapping: those are treated as "no usable frontmatter" rather than crashing
/// on property access. `type` is normalised *after* the spread, otherwise a
/// missing or non-string `type` in the file would overwrite the default.
pub fn parse_frontmatter_map(yaml: Option<&str>) -> Map<String, Value> {
    let default = || {
        let mut m = Map::new();
        m.insert("type".into(), Value::String(DEFAULT_CONCEPT_TYPE.into()));
        m
    };
    let Some(yaml) = yaml else { return default() };
    if js_trim(yaml).is_empty() {
        return default();
    }
    let Some(Value::Object(mut record)) = parse_yaml(yaml) else {
        return default();
    };
    let trimmed = match record.get("type") {
        Some(Value::String(t)) if !js_trim(t).is_empty() => js_trim(t).to_string(),
        _ => DEFAULT_CONCEPT_TYPE.to_string(),
    };
    // `{ ...record, type }`: an existing key keeps its position.
    record.insert("type".into(), Value::String(trimmed));
    record
}

/// [`parse_frontmatter_map`] as the typed value used across the crate.
pub fn parse_frontmatter(yaml: Option<&str>) -> ConceptFrontmatter {
    ConceptFrontmatter::from_map(&parse_frontmatter_map(yaml))
}

pub fn parse_concept(opts: ParseConceptOptions) -> ConceptDocument {
    let split = split_frontmatter(&opts.raw);
    let frontmatter = parse_frontmatter(split.yaml.as_deref());
    let id = if opts.id.is_empty() {
        concept_id_from_rel_path(&opts.rel_path)
    } else {
        opts.id.clone()
    };
    let body = split.body.trim_start_matches(['\r', '\n']).to_string();
    let links = extract_links(&body, &id, opts.known_ids);

    ConceptDocument {
        id,
        path: opts.abs_path,
        rel_path: opts.rel_path,
        frontmatter,
        body,
        links,
        mtime_ms: opts.mtime_ms.unwrap_or(0.0),
    }
}

/// Serialise frontmatter + body back to a file, with a stable key order.
pub fn serialize_concept(frontmatter: &Map<String, Value>, body: &str) -> String {
    let mut entries: Vec<(String, Value)> = Vec::new();
    for key in KEY_ORDER {
        if let Some(v) = frontmatter.get(key) {
            entries.push((key.to_string(), v.clone()));
        }
    }
    for (key, value) in frontmatter {
        if !KEY_ORDER.contains(&key.as_str()) {
            entries.push((key.clone(), value.clone()));
        }
    }
    // A JS object lists integer-like keys first, whatever the insertion order.
    let ordered = js_object(entries);
    let yaml = stringify_yaml(&ordered);
    join_frontmatter(js_trim_end(&yaml), body, Eol::Lf)
}

#[derive(Debug, Clone, Default)]
pub struct ConceptSkeletonOptions {
    pub r#type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub body: Option<String>,
    pub generated_by: Option<String>,
    /// `new Date()`; defaults to now.
    pub now: Option<chrono::DateTime<chrono::Utc>>,
}

/// Build a minimal OKF-conformant concept file.
pub fn skeleton_concept(opts: &ConceptSkeletonOptions) -> String {
    let mut fm = Map::new();
    let ty = js_trim(&opts.r#type);
    fm.insert(
        "type".into(),
        Value::String(if ty.is_empty() { DEFAULT_CONCEPT_TYPE } else { ty }.to_string()),
    );
    if let Some(title) = opts.title.as_deref().filter(|s| !s.is_empty()) {
        fm.insert("title".into(), Value::String(title.to_string()));
    }
    if let Some(d) = opts.description.as_deref().filter(|s| !s.is_empty()) {
        fm.insert("description".into(), Value::String(d.to_string()));
    }
    if !opts.tags.is_empty() {
        fm.insert(
            "tags".into(),
            Value::Array(opts.tags.iter().cloned().map(Value::String).collect()),
        );
    }
    if let Some(by) = opts.generated_by.as_deref().filter(|s| !s.is_empty()) {
        let mut g = Map::new();
        g.insert("by".into(), Value::String(by.to_string()));
        g.insert(
            "at".into(),
            Value::String(super::error::iso_of(opts.now.unwrap_or_else(chrono::Utc::now))),
        );
        fm.insert("generated".into(), Value::Object(g));
    }
    fm.insert("status".into(), Value::String("draft".into()));

    let heading = match opts.title.as_deref().filter(|s| !s.is_empty()) {
        Some(t) => format!("# {t}\n\n"),
        None => String::new(),
    };
    let text = format!("{heading}{}", opts.body.as_deref().unwrap_or(""));
    serialize_concept(&fm, &format!("{}\n", js_trim_end(&text)))
}

// ---- YAML emitting ------------------------------------------------------------

/// `yaml.stringify(value, { lineWidth: 0 })` for a plain JSON object.
pub fn stringify_yaml(map: &Map<String, Value>) -> String {
    let mut out = if map.is_empty() {
        "{}".to_string()
    } else {
        block_map(map, "")
    };
    out.push('\n');
    out
}

const INDENT_STEP: &str = "  ";

fn block_map(map: &Map<String, Value>, indent: &str) -> String {
    let lines: Vec<String> = map
        .iter()
        .map(|(key, value)| stringify_pair(key, value, indent))
        .collect();
    lines.join(&format!("\n{indent}"))
}

fn block_seq(items: &[Value], indent: &str) -> String {
    let item_indent = format!("{indent}{INDENT_STEP}");
    let lines: Vec<String> = items
        .iter()
        .map(|item| format!("- {}", stringify_value(item, &item_indent)))
        .collect();
    lines.join(&format!("\n{indent}"))
}

/// A collection or scalar as it appears after `- ` or `key: `.
fn stringify_value(value: &Value, indent: &str) -> String {
    match value {
        Value::Object(m) if m.is_empty() => "{}".into(),
        Value::Object(m) => block_map(m, indent),
        Value::Array(a) if a.is_empty() => "[]".into(),
        Value::Array(a) => block_seq(a, indent),
        scalar => stringify_scalar(scalar, indent),
    }
}

fn stringify_pair(key: &str, value: &Value, indent: &str) -> String {
    let key_str = stringify_string(key, indent, true);
    let value_indent = format!("{indent}{INDENT_STEP}");
    match value {
        Value::Object(m) if !m.is_empty() => {
            format!("{key_str}:\n{value_indent}{}", block_map(m, &value_indent))
        }
        Value::Array(a) if !a.is_empty() => {
            format!("{key_str}:\n{value_indent}{}", block_seq(a, &value_indent))
        }
        other => format!("{key_str}: {}", stringify_value(other, &value_indent)),
    }
}

fn stringify_scalar(value: &Value, indent: &str) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(x) if n.is_f64() => js_number_string(x),
            _ => n.to_string(),
        },
        Value::String(s) => stringify_string(s, indent, false),
        _ => unreachable!("collections are handled by the caller"),
    }
}

static PLAIN_FORBIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^[\n\t ,\[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"#)
        .unwrap()
});

/// Core-schema tags other than `str`: a plain string matching one of these
/// would read back as a different type, so it is quoted.
fn reads_back_as_non_string(s: &str) -> bool {
    static TESTS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"^(?:~|[Nn]ull|NULL)?$",
            r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$",
            r"^0o[0-7]+$",
            r"^[-+]?[0-9]+$",
            r"^0x[0-9a-fA-F]+$",
            r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$",
            r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$",
            r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    });
    TESTS.iter().any(|re| re.is_match(s))
}

/// `containsDocumentMarker`: `/^(%|---|\.\.\.)/m`.
fn contains_document_marker(s: &str) -> bool {
    ["%", "---", "..."]
        .iter()
        .any(|p| find_at_line_start(s, p).is_some())
}

/// `stringifyString` with the default string type PLAIN.
fn stringify_string(value: &str, indent: &str, implicit_key: bool) -> String {
    // Control characters (other than tab and newline) force double quotes.
    let force_double = value.chars().any(|c| {
        matches!(c as u32, 0x00..=0x08 | 0x0b..=0x1f | 0x7f..=0x9f)
    });
    if force_double {
        return plain_double_quoted(value, indent, implicit_key);
    }
    plain_string(value, indent, implicit_key)
}

fn plain_string(value: &str, indent: &str, implicit_key: bool) -> String {
    if implicit_key && value.contains('\n') {
        return quoted_string(value, indent, implicit_key);
    }
    if PLAIN_FORBIDDEN.is_match(value) {
        return if implicit_key || !value.contains('\n') {
            quoted_string(value, indent, implicit_key)
        } else {
            block_string(value, indent, implicit_key, false)
        };
    }
    if !implicit_key && value.contains('\n') {
        return block_string(value, indent, implicit_key, false);
    }
    if contains_document_marker(value) {
        if implicit_key && (indent.is_empty() || indent == INDENT_STEP) {
            return quoted_string(value, indent, implicit_key);
        } else if indent.is_empty() {
            return block_string(value, indent, implicit_key, true);
        }
    }
    if reads_back_as_non_string(value) {
        return quoted_string(value, indent, implicit_key);
    }
    value.to_string()
}

fn quoted_string(value: &str, indent: &str, implicit_key: bool) -> String {
    let has_double = value.contains('"');
    let has_single = value.contains('\'');
    if has_double && !has_single {
        single_quoted_string(value, indent, implicit_key)
    } else {
        plain_double_quoted(value, indent, implicit_key)
    }
}

fn single_quoted_string(value: &str, indent: &str, implicit_key: bool) -> String {
    let around_newline = value.contains(" \n")
        || value.contains("\t\n")
        || value.contains("\n ")
        || value.contains("\n\t");
    if (implicit_key && value.contains('\n')) || around_newline {
        return plain_double_quoted(value, indent, implicit_key);
    }
    let indent = if !indent.is_empty() {
        indent
    } else if contains_document_marker(value) {
        INDENT_STEP
    } else {
        ""
    };
    let escaped = value.replace('\'', "''");
    // `\n+` -> `$&\n<indent>`
    let mut out = String::from("'");
    let mut chars = escaped.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c == '\n' && chars.peek() != Some(&'\n') {
            out.push('\n');
            out.push_str(indent);
        }
    }
    out.push('\'');
    out
}

/// `JSON.stringify(string)`.
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `doubleQuotedString`, including its multi-line layout (lines are not
/// folded because `lineWidth` is 0).
fn plain_double_quoted(value: &str, indent: &str, implicit_key: bool) -> String {
    const MIN_MULTI_LINE_LENGTH: usize = 40;
    let json: Vec<char> = json_string(value).chars().collect();
    let json_len16 = utf16_len(&json.iter().collect::<String>());
    let at = |i: usize| json.get(i).copied();
    let slice = |a: usize, b: usize| -> String { json[a.min(json.len())..b.min(json.len())].iter().collect() };
    let indent = if !indent.is_empty() {
        indent
    } else if contains_document_marker(value) {
        INDENT_STEP
    } else {
        ""
    };

    let mut out = String::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < json.len() {
        let mut ch = json[i];
        if ch == ' ' && at(i + 1) == Some('\\') && at(i + 2) == Some('n') {
            out.push_str(&slice(start, i));
            out.push_str("\\ ");
            i += 1;
            start = i;
            ch = '\\';
        }
        if ch == '\\' {
            match at(i + 1) {
                Some('u') => {
                    out.push_str(&slice(start, i));
                    let code = slice(i + 2, i + 6);
                    match code.as_str() {
                        "0000" => out.push_str("\\0"),
                        "0007" => out.push_str("\\a"),
                        "000b" => out.push_str("\\v"),
                        "001b" => out.push_str("\\e"),
                        "0085" => out.push_str("\\N"),
                        "00a0" => out.push_str("\\_"),
                        "2028" => out.push_str("\\L"),
                        "2029" => out.push_str("\\P"),
                        c if c.starts_with("00") => {
                            out.push_str("\\x");
                            out.push_str(&c[2..]);
                        }
                        _ => out.push_str(&slice(i, i + 6)),
                    }
                    i += 5;
                    start = i + 1;
                }
                Some('n') => {
                    if implicit_key || at(i + 2) == Some('"') || json_len16 < MIN_MULTI_LINE_LENGTH {
                        i += 1;
                    } else {
                        out.push_str(&slice(start, i));
                        out.push_str("\n\n");
                        while at(i + 2) == Some('\\') && at(i + 3) == Some('n') && at(i + 4) != Some('"') {
                            out.push('\n');
                            i += 2;
                        }
                        out.push_str(indent);
                        if at(i + 2) == Some(' ') {
                            out.push('\\');
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    if start > 0 {
        out.push_str(&slice(start, json.len()));
        out
    } else {
        json.iter().collect()
    }
}

/// `blockString` for literal block scalars (the only kind `lineWidth: 0`
/// produces).
fn block_string(value: &str, indent_ctx: &str, implicit_key: bool, force_block_indent: bool) -> String {
    // A block can't end in whitespace unless the last line is non-empty.
    static TRAILING_WS_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[\t ]+$").unwrap());
    if TRAILING_WS_LINE.is_match(value) {
        return quoted_string(value, indent_ctx, implicit_key);
    }
    let indent = if !indent_ctx.is_empty() {
        indent_ctx
    } else if force_block_indent || contains_document_marker(value) {
        INDENT_STEP
    } else {
        ""
    };
    if value.is_empty() {
        return "|\n".into();
    }

    // Chomping from the whitespace at the end of the value.
    let end_start = value
        .trim_end_matches(['\n', '\t', ' '])
        .len();
    let mut end = &value[end_start..];
    let chomp = match end.find('\n') {
        None => "-",
        Some(pos) if value == end || pos != end.len() - 1 => "+",
        Some(_) => "",
    };
    let mut body = &value[..end_start];
    let end_text;
    if !end.is_empty() {
        if let Some(stripped) = end.strip_suffix('\n') {
            end = stripped;
        }
        // Newline runs that are neither last nor followed by another newline
        // get the indent after them.
        let mut s = String::new();
        let mut chars = end.chars().peekable();
        while let Some(c) = chars.next() {
            s.push(c);
            if c == '\n' && chars.peek().is_some_and(|n| *n != '\n') {
                s.push_str(indent);
            }
        }
        end_text = s;
    } else {
        end_text = String::new();
    }

    // Indent indicator from whitespace at the start.
    let mut start_with_space = false;
    let mut start_end = body.len();
    let mut start_nl: isize = -1;
    for (i, c) in body.char_indices() {
        match c {
            ' ' => start_with_space = true,
            '\n' => start_nl = i as isize,
            _ => {
                start_end = i;
                break;
            }
        }
    }
    let cut = if start_nl < start_end as isize {
        (start_nl + 1) as usize
    } else {
        start_end
    };
    let mut start = body[..cut].to_string();
    if !start.is_empty() {
        body = &body[cut..];
        start = add_indent_after_newlines(&start, indent);
    }
    let indent_size = if indent.is_empty() { "1" } else { "2" };
    let header = format!("{}{chomp}", if start_with_space { indent_size } else { "" });
    let body = add_indent_after_newlines(body, indent);
    format!("|{header}\n{indent}{start}{body}{end_text}")
}

/// `s.replace(/\n+/g, "$&" + indent)`.
fn add_indent_after_newlines(s: &str, indent: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c == '\n' && chars.peek() != Some(&'\n') {
            out.push_str(indent);
        }
    }
    out
}
