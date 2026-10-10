//! `yaml.stringify(value)` of npm `yaml` 2.x with its *default* options, for
//! a JSON-shaped value.
//!
//! The Hermes merge re-emits a whole config file, so unlike the frontmatter
//! writer in `okf::parser` (which passes `lineWidth: 0`) it has to reproduce
//! the default 80-column folding of long plain, quoted and block scalars.
//! Everything else follows the same algorithm: block collections, two-space
//! indent, sequences indented under their key, plain scalars unless they would
//! read back as another type.
//!
//! Known gap: the TS re-emits a value that was an alias in the source as
//! `&a1` / `*a1` (the parsed object is shared); here aliases are expanded.

use super::jsjson::{js_number_string, js_ordered, number_f64};
use crate::shared::js_compat::{from_utf16, to_utf16, utf16_len};
use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

const INDENT_STEP: &str = "  ";
const LINE_WIDTH: usize = 80;
const MIN_CONTENT_WIDTH: usize = 20;
const DOUBLE_QUOTED_MIN_MULTI_LINE: usize = 40;

/// `yaml.stringify(map)`.
pub fn stringify(map: &Map<String, Value>) -> String {
    let mut out = if map.is_empty() {
        "{}".to_string()
    } else {
        block_map(map, "")
    };
    out.push('\n');
    out
}

fn block_map(map: &Map<String, Value>, indent: &str) -> String {
    let lines: Vec<String> = js_ordered(map)
        .into_iter()
        .map(|(key, value)| stringify_pair(key, value, indent))
        .collect();
    lines.join(&format!("\n{indent}"))
}

fn block_seq(items: &[Value], indent: &str) -> String {
    let item_indent = format!("{indent}{INDENT_STEP}");
    let lines: Vec<String> = items
        .iter()
        .map(|item| format!("- {}", stringify_value(item, &item_indent, None)))
        .collect();
    lines.join(&format!("\n{indent}"))
}

fn stringify_value(value: &Value, indent: &str, indent_at_start: Option<usize>) -> String {
    match value {
        Value::Object(m) if m.is_empty() => "{}".into(),
        Value::Object(m) => block_map(m, indent),
        Value::Array(a) if a.is_empty() => "[]".into(),
        Value::Array(a) => block_seq(a, indent),
        scalar => stringify_scalar(scalar, indent, indent_at_start),
    }
}

fn stringify_pair(key: &str, value: &Value, indent: &str) -> String {
    let value_indent = format!("{indent}{INDENT_STEP}");
    // The key is stringified with the pair's context, whose indent is one step in.
    let key_str = stringify_string(key, &value_indent, true, None);
    let head = format!("{key_str}:");
    match value {
        Value::Object(m) if !m.is_empty() => {
            format!("{head}\n{value_indent}{}", block_map(m, &value_indent))
        }
        Value::Array(a) if !a.is_empty() => {
            format!("{head}\n{value_indent}{}", block_seq(a, &value_indent))
        }
        Value::Object(_) | Value::Array(_) => {
            format!("{head} {}", stringify_value(value, &value_indent, None))
        }
        scalar => {
            let at_start = Some(utf16_len(&head) + 1);
            let text = stringify_scalar(scalar, &value_indent, at_start);
            // A scalar folded onto the next line carries its own newline.
            if text.is_empty() || text.starts_with('\n') {
                format!("{head}{text}")
            } else {
                format!("{head} {text}")
            }
        }
    }
}

fn stringify_scalar(value: &Value, indent: &str, indent_at_start: Option<usize>) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match number_f64(n) {
            Some(x) => js_number_string(x),
            None => ".nan".into(),
        },
        Value::String(s) => stringify_string(s, indent, false, indent_at_start),
        _ => unreachable!("collections are handled by the caller"),
    }
}

// ---- strings -----------------------------------------------------------------

struct Ctx<'a> {
    indent: &'a str,
    indent_at_start: Option<usize>,
    implicit_key: bool,
}

static PLAIN_FORBIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^[\n\t ,\[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"#)
        .unwrap()
});

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

/// `/^(%|---|\.\.\.)/m`, with JS line terminators.
fn contains_document_marker(s: &str) -> bool {
    let mut at_line_start = true;
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        if at_line_start && (rest.starts_with('%') || rest.starts_with("---") || rest.starts_with("...")) {
            return true;
        }
        at_line_start = matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        rest = &rest[c.len_utf8()..];
    }
    false
}

fn stringify_string(value: &str, indent: &str, implicit_key: bool, indent_at_start: Option<usize>) -> String {
    let ctx = Ctx { indent, indent_at_start, implicit_key };
    let force_double = value
        .chars()
        .any(|c| matches!(c as u32, 0x00..=0x08 | 0x0b..=0x1f | 0x7f..=0x9f));
    if force_double {
        return double_quoted(value, &ctx);
    }
    plain_string(value, &ctx)
}

fn plain_string(value: &str, ctx: &Ctx) -> String {
    if ctx.implicit_key && value.contains('\n') {
        return quoted_string(value, ctx);
    }
    if PLAIN_FORBIDDEN.is_match(value) {
        return if ctx.implicit_key || !value.contains('\n') {
            quoted_string(value, ctx)
        } else {
            block_string(value, ctx, false)
        };
    }
    if !ctx.implicit_key && value.contains('\n') {
        return block_string(value, ctx, false);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            return block_string(value, ctx, true);
        } else if ctx.implicit_key && ctx.indent == INDENT_STEP {
            return quoted_string(value, ctx);
        }
    }
    if reads_back_as_non_string(value) {
        return quoted_string(value, ctx);
    }
    if ctx.implicit_key {
        value.to_string()
    } else {
        fold_flow_lines(value, ctx.indent, Mode::Flow, ctx.indent_at_start).0
    }
}

fn quoted_string(value: &str, ctx: &Ctx) -> String {
    let has_double = value.contains('"');
    let has_single = value.contains('\'');
    if has_double && !has_single {
        single_quoted(value, ctx)
    } else {
        double_quoted(value, ctx)
    }
}

fn single_quoted(value: &str, ctx: &Ctx) -> String {
    let around_newline =
        value.contains(" \n") || value.contains("\t\n") || value.contains("\n ") || value.contains("\n\t");
    if (ctx.implicit_key && value.contains('\n')) || around_newline {
        return double_quoted(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() {
        ctx.indent
    } else if contains_document_marker(value) {
        INDENT_STEP
    } else {
        ""
    };
    let escaped = value.replace('\'', "''");
    let mut res = String::from("'");
    let mut chars = escaped.chars().peekable();
    while let Some(c) = chars.next() {
        res.push(c);
        if c == '\n' && chars.peek() != Some(&'\n') {
            res.push('\n');
            res.push_str(indent);
        }
    }
    res.push('\'');
    if ctx.implicit_key {
        res
    } else {
        fold_flow_lines(&res, indent, Mode::Flow, ctx.indent_at_start).0
    }
}

fn json_string(value: &str) -> String {
    super::jsjson::json_string(value)
}

fn double_quoted(value: &str, ctx: &Ctx) -> String {
    let json: Vec<char> = json_string(value).chars().collect();
    let json_len16 = utf16_len(&json.iter().collect::<String>());
    let at = |i: usize| json.get(i).copied();
    let slice = |a: usize, b: usize| -> String {
        json[a.min(json.len())..b.min(json.len())].iter().collect()
    };
    let indent = if !ctx.indent.is_empty() {
        ctx.indent
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
                    if ctx.implicit_key || at(i + 2) == Some('"') || json_len16 < DOUBLE_QUOTED_MIN_MULTI_LINE {
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
    let text = if start > 0 {
        out.push_str(&slice(start, json.len()));
        out
    } else {
        json.iter().collect()
    };
    if ctx.implicit_key {
        text
    } else {
        fold_flow_lines(&text, indent, Mode::Quoted, ctx.indent_at_start).0
    }
}

/// `lineLengthOverLimit`.
fn line_length_over_limit(s: &str, line_width: usize, indent_len: usize) -> bool {
    let units = to_utf16(s);
    let limit = line_width as isize - indent_len as isize;
    let len = units.len() as isize;
    if len <= limit {
        return false;
    }
    let mut start: isize = 0;
    let mut i: isize = 0;
    while i < len {
        if units[i as usize] == b'\n' as u16 {
            if i - start > limit {
                return true;
            }
            start = i + 1;
            if len - start <= limit {
                return false;
            }
        }
        i += 1;
    }
    true
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

fn block_string(value: &str, ctx: &Ctx, force_block_indent: bool) -> String {
    static TRAILING_WS_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[\t ]+$").unwrap());
    if TRAILING_WS_LINE.is_match(value) {
        return quoted_string(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() {
        ctx.indent
    } else if force_block_indent || contains_document_marker(value) {
        INDENT_STEP
    } else {
        ""
    };
    let literal = !line_length_over_limit(value, LINE_WIDTH, indent.len());
    if value.is_empty() {
        return if literal { "|\n".into() } else { ">\n".into() };
    }

    let end_start = value.trim_end_matches(['\n', '\t', ' ']).len();
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
        // `/(^|(?<!\n))\n+(?!\n|$)/g` -> "$&" + indent
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

    if !literal {
        let folded_value = folded_block_value(body, indent);
        let text = format!("{start}{folded_value}{end_text}");
        let (folded, overflow) = fold_flow_lines(&text, indent, Mode::Block, Some(indent.len()));
        if !overflow {
            return format!(">{header}\n{indent}{folded}");
        }
    }
    let body = add_indent_after_newlines(body, indent);
    format!("|{header}\n{indent}{start}{body}{end_text}")
}

/// The folded-scalar preparation: blank lines doubled, more-indented lines
/// left alone, indent added after every newline run.
fn folded_block_value(value: &str, indent: &str) -> String {
    static MORE_INDENTED: LazyLock<FancyRegex> = LazyLock::new(|| {
        FancyRegex::new(r"(?:^|\n)([\t ][^\n\r\x{2028}\x{2029}]*)(?:([\n\t ]*)\n(?![\n\t ]))?").unwrap()
    });
    // `.replace(/\n+/g, '\n$&')`
    let mut doubled = String::with_capacity(value.len() + 8);
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            let mut run = String::from("\n");
            while chars.peek() == Some(&'\n') {
                run.push('\n');
                chars.next();
            }
            doubled.push('\n');
            doubled.push_str(&run);
        } else {
            doubled.push(c);
        }
    }
    let mut joined = String::with_capacity(doubled.len());
    let mut last = 0usize;
    for caps in MORE_INDENTED.captures_iter(&doubled).flatten() {
        let whole = caps.get(0).expect("group 0 always exists");
        joined.push_str(&doubled[last..whole.start()]);
        joined.push_str(caps.get(1).map_or("", |m| m.as_str()));
        joined.push_str(caps.get(2).map_or("", |m| m.as_str()));
        last = whole.end();
    }
    joined.push_str(&doubled[last..]);
    add_indent_after_newlines(&joined, indent)
}

// ---- foldFlowLines -------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Flow,
    Block,
    Quoted,
}

const SP: u16 = b' ' as u16;
const NL: u16 = b'\n' as u16;
const TAB: u16 = b'\t' as u16;

/// Port of `foldFlowLines`; indices are UTF-16 code units, as in JS. Returns
/// the text and whether a line overflowed without a place to break (block
/// mode falls back to a literal scalar then).
fn fold_flow_lines(text: &str, indent: &str, mode: Mode, indent_at_start: Option<usize>) -> (String, bool) {
    let line_width = LINE_WIDTH as isize;
    let min_content_width = MIN_CONTENT_WIDTH as isize;
    let indent_len = indent.len() as isize;
    let end_step = (1 + min_content_width).max(1 + line_width - indent_len);
    let t = to_utf16(text);
    if t.len() as isize <= end_step {
        return (text.to_string(), false);
    }

    let get = |i: isize| -> Option<u16> {
        if i < 0 {
            None
        } else {
            t.get(i as usize).copied()
        }
    };

    let mut folds: Vec<isize> = Vec::new();
    let mut escaped_folds: Vec<isize> = Vec::new();
    let mut end = line_width - indent_len;
    if let Some(at_start) = indent_at_start {
        if at_start as isize > line_width - 2.max(min_content_width) {
            folds.push(0);
        } else {
            end = line_width - at_start as isize;
        }
    }
    let mut split: Option<isize> = None;
    let mut prev: Option<u16> = None;
    let mut overflow = false;
    let mut i: isize = -1;
    let mut esc_start: isize = -1;
    let mut esc_end: isize = -1;
    if mode == Mode::Block {
        i = consume_more_indented_lines(&t, i, indent_len);
        if i != -1 {
            end = i + end_step;
        }
    }
    loop {
        i += 1;
        let Some(ch) = get(i) else { break };
        if mode == Mode::Quoted && ch == b'\\' as u16 {
            esc_start = i;
            match get(i + 1) {
                Some(c) if c == b'x' as u16 => i += 3,
                Some(c) if c == b'u' as u16 => i += 5,
                Some(c) if c == b'U' as u16 => i += 9,
                _ => i += 1,
            }
            esc_end = i;
        }
        let mut cur: Option<u16> = Some(ch);
        if ch == NL {
            if mode == Mode::Block {
                i = consume_more_indented_lines(&t, i, indent_len);
            }
            end = i + indent_len + end_step;
            split = None;
        } else {
            if ch == SP && matches!(prev, Some(p) if p != SP && p != NL && p != TAB) {
                if let Some(next) = get(i + 1) {
                    if next != SP && next != NL && next != TAB {
                        split = Some(i);
                    }
                }
            }
            if i >= end {
                if let Some(s) = split {
                    folds.push(s);
                    end = s + end_step;
                    split = None;
                } else if mode == Mode::Quoted {
                    // White space collected at the end may stretch past the width.
                    while matches!(prev, Some(SP) | Some(TAB)) {
                        prev = cur;
                        i += 1;
                        cur = get(i);
                        overflow = true;
                    }
                    let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };
                    if escaped_folds.contains(&j) {
                        return (text.to_string(), overflow);
                    }
                    folds.push(j);
                    escaped_folds.push(j);
                    end = j + end_step;
                    split = None;
                } else {
                    overflow = true;
                }
            }
        }
        prev = cur;
    }
    if folds.is_empty() {
        return (text.to_string(), overflow);
    }

    let slice = |a: isize, b: isize| -> String {
        let a = a.clamp(0, t.len() as isize) as usize;
        let b = b.clamp(0, t.len() as isize) as usize;
        if a >= b {
            String::new()
        } else {
            from_utf16(&t[a..b])
        }
    };
    let mut res = slice(0, folds[0]);
    for (n, &fold) in folds.iter().enumerate() {
        let fold_end = match folds.get(n + 1) {
            Some(&e) if e != 0 => e,
            _ => t.len() as isize,
        };
        if fold == 0 {
            res = format!("\n{indent}{}", slice(0, fold_end));
        } else {
            if mode == Mode::Quoted && escaped_folds.contains(&fold) {
                res.push_str(&slice(fold, fold + 1));
                res.push('\\');
            }
            res.push_str(&format!("\n{indent}{}", slice(fold + 1, fold_end)));
        }
    }
    (res, overflow)
}

fn consume_more_indented_lines(t: &[u16], mut i: isize, indent: isize) -> isize {
    let get = |i: isize| -> Option<u16> {
        if i < 0 {
            None
        } else {
            t.get(i as usize).copied()
        }
    };
    let mut end = i;
    let mut start = i + 1;
    let mut ch = get(start);
    while matches!(ch, Some(SP) | Some(TAB)) {
        if i < start + indent {
            i += 1;
            ch = get(i);
        } else {
            loop {
                i += 1;
                ch = get(i);
                if ch.is_none() || ch == Some(NL) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = get(start);
        }
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(json: &str) -> Map<String, Value> {
        match serde_json::from_str::<Value>(json).unwrap() {
            Value::Object(m) => m,
            _ => panic!("object expected"),
        }
    }

    #[test]
    fn plain_and_nested() {
        let m = obj(r#"{"model":"hermes-4","mcp_servers":{"fs":{"command":"npx","args":["-y","x"],"env":{}}}}"#);
        assert_eq!(
            stringify(&m),
            "model: hermes-4\nmcp_servers:\n  fs:\n    command: npx\n    args:\n      - -y\n      - x\n    env: {}\n"
        );
    }

    #[test]
    fn quotes_what_would_read_back_differently() {
        let m = obj(r#"{"a":"true","b":"123","c":"x: y","d":"","e":"- x"}"#);
        assert_eq!(
            stringify(&m),
            "a: \"true\"\nb: \"123\"\nc: \"x: y\"\nd: \"\"\ne: \"- x\"\n"
        );
    }

    #[test]
    fn long_plain_scalars_fold_at_80_columns() {
        let long = "word ".repeat(30);
        let long = long.trim_end();
        let m = obj(&format!(r#"{{"k":"{long}"}}"#));
        let out = stringify(&m);
        assert!(out.lines().count() > 1, "{out}");
        assert!(out.lines().all(|l| l.chars().count() <= 82), "{out}");
    }
}
