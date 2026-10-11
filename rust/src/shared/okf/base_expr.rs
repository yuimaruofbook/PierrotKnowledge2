//! The expression language of `.base` files (`src/shared/okf/base-expr.ts`).
//!
//! A small, safe subset of what Obsidian Bases accepts in filters, formulas and
//! custom summaries. It is parsed and evaluated here and nowhere else: no
//! `eval`, no host objects (a name that is not a frontmatter key is simply
//! empty), nothing callable but the fixed functions. Dates are evaluated in
//! UTC. The TS file documents the supported subset; the two must agree on every
//! result and every error message.

use crate::shared::js_compat::{
    from_utf16, is_js_space, js_number, js_number_to_string, js_regex, js_round, js_to_fixed,
    js_trim, locale_compare, to_utf16,
};
use crate::shared::okf::para::para_of;
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Map, Number, Value as Json};
use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::LazyLock;

// ---- values ------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Value>),
    Obj(Vec<(String, Value)>),
    Date(f64),
    Link {
        target: String,
        display: Option<String>,
    },
    Dur {
        months: f64,
        ms: f64,
    },
}

/// A failure while evaluating: the cell, filter or summary becomes empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalError(pub String);

/// A failure while parsing: the whole base is rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExprError(pub String);

type Eval<T = Value> = Result<T, EvalError>;

fn err<T>(message: impl Into<String>) -> Eval<T> {
    Err(EvalError(message.into()))
}

// ---- limits ------------------------------------------------------------------------
// A `.base` file may come from an agent or the web, so no expression in it may be
// able to exhaust the stack, memory or time. The TS port uses the same numbers.

/// Deepest syntax tree, counting every level (operators and `.a.b` chains too).
pub const MAX_AST_DEPTH: usize = 128;
/// Most syntax nodes in one expression.
pub const MAX_AST_NODES: usize = 10_000;
/// Deepest evaluation, including formulas and lambdas that call into each other.
pub const MAX_EVAL_DEPTH: usize = 256;
/// Longest chain of formulas that refer to one another.
pub const MAX_FORMULA_DEPTH: usize = 32;
/// Evaluation steps one query may take; each node costs 1, big results cost more.
pub const EVAL_STEP_BUDGET: i64 = 3_000_000;
/// Largest value an expression may build: 1 per item, plus 1 per UTF-16 unit of text.
pub const MAX_VALUE_WEIGHT: usize = 1_000_000;
/// A result is charged weight >> COST_SHIFT steps: bulk copying is far cheaper than a node.
const COST_SHIFT: u32 = 8;
/// Dates beyond this are not representable (the JS Date range).
const MAX_DATE_MS: f64 = 8.64e15;

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Weight of a value, counting no further once it passes `limit`.
fn weight(v: &Value, limit: usize) -> usize {
    fn walk(x: &Value, total: &mut usize, limit: usize) {
        if *total > limit {
            return;
        }
        *total += 1;
        match x {
            Value::Str(s) => *total += utf16_len(s),
            Value::List(items) => {
                for y in items {
                    walk(y, total, limit);
                    if *total > limit {
                        return;
                    }
                }
            }
            Value::Obj(entries) => {
                for (k, y) in entries {
                    *total += utf16_len(k);
                    walk(y, total, limit);
                    if *total > limit {
                        return;
                    }
                }
            }
            _ => {}
        }
    }
    let mut total = 0;
    walk(v, &mut total, limit);
    total
}

/// A date the engine can represent; anything else is an evaluation error, never a panic.
fn date_at(ms: f64) -> Eval {
    if !ms.is_finite() || ms.abs() > MAX_DATE_MS {
        return err("date is out of range");
    }
    Ok(Value::Date(ms))
}

pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Num(_) => "number",
        Value::Str(_) => "string",
        Value::List(_) => "list",
        Value::Date(_) => "date",
        Value::Link { .. } => "link",
        Value::Dur { .. } => "duration",
        Value::Obj(_) => "object",
    }
}

/// A frontmatter / YAML value as an evaluator value.
pub fn from_json(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Value::Str(s.clone()),
        Json::Array(items) => Value::List(items.iter().map(from_json).collect()),
        Json::Object(map) => {
            Value::Obj(map.iter().map(|(k, x)| (k.clone(), from_json(x))).collect())
        }
    }
}

fn obj_get<'a>(entries: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

pub fn is_plain_object(v: &Value) -> bool {
    matches!(v, Value::Obj(_))
}

// ---- numbers and dates -----------------------------------------------------------

const DAY_MS: f64 = 86_400_000.0;

pub fn num_str(x: f64) -> String {
    js_number_to_string(x)
}

fn floor_div(a: f64, b: f64) -> f64 {
    (a / b).floor()
}

pub fn days_from_civil(y: f64, m: f64, d: f64) -> f64 {
    let yy = if m <= 2.0 { y - 1.0 } else { y };
    let era = floor_div(yy, 400.0);
    let yoe = yy - era * 400.0;
    let doy = floor_div(153.0 * (m + if m > 2.0 { -3.0 } else { 9.0 }) + 2.0, 5.0) + d - 1.0;
    let doe = yoe * 365.0 + floor_div(yoe, 4.0) - floor_div(yoe, 100.0) + doy;
    era * 146_097.0 + doe - 719_468.0
}

pub fn civil_from_days(days: f64) -> (f64, f64, f64) {
    let z = days + 719_468.0;
    let era = floor_div(z, 146_097.0);
    let doe = z - era * 146_097.0;
    let yoe = floor_div(
        doe - floor_div(doe, 1460.0) + floor_div(doe, 36_524.0) - floor_div(doe, 146_096.0),
        365.0,
    );
    let y = yoe + era * 400.0;
    let doy = doe - (365.0 * yoe + floor_div(yoe, 4.0) - floor_div(yoe, 100.0));
    let mp = floor_div(5.0 * doy + 2.0, 153.0);
    let d = doy - floor_div(153.0 * mp + 2.0, 5.0) + 1.0;
    let m = mp + if mp < 10.0 { 3.0 } else { -9.0 };
    (if m <= 2.0 { y + 1.0 } else { y }, m, d)
}

fn days_in_month(y: f64, m: f64) -> f64 {
    let (ny, nm) = if m == 12.0 {
        (y + 1.0, 1.0)
    } else {
        (y, m + 1.0)
    };
    days_from_civil(ny, nm, 1.0) - days_from_civil(y, m, 1.0)
}

struct DateParts {
    year: f64,
    month: f64,
    day: f64,
    hour: f64,
    minute: f64,
    second: f64,
    millisecond: f64,
    weekday: usize,
}

fn parts_of(ms: f64) -> DateParts {
    let days = floor_div(ms, DAY_MS);
    let rest = ms - days * DAY_MS;
    let (year, month, day) = civil_from_days(days);
    DateParts {
        year,
        month,
        day,
        hour: floor_div(rest, 3_600_000.0),
        minute: floor_div(rest % 3_600_000.0, 60_000.0),
        second: floor_div(rest % 60_000.0, 1000.0),
        millisecond: rest % 1000.0,
        weekday: ((((days + 4.0) % 7.0) + 7.0) % 7.0) as usize,
    }
}

fn pad(n: f64, width: usize) -> String {
    format!("{:0>width$}", num_str(n))
}

/// `YYYY-MM-DD`, plus ` HH:mm:ss` (and `.SSS`) only when there is a time.
pub fn date_str(ms: f64) -> String {
    let p = parts_of(ms);
    let mut s = format!("{}-{}-{}", pad(p.year, 4), pad(p.month, 2), pad(p.day, 2));
    if p.hour != 0.0 || p.minute != 0.0 || p.second != 0.0 || p.millisecond != 0.0 {
        s.push_str(&format!(
            " {}:{}:{}",
            pad(p.hour, 2),
            pad(p.minute, 2),
            pad(p.second, 2)
        ));
        if p.millisecond != 0.0 {
            s.push_str(&format!(".{}", pad(p.millisecond, 3)));
        }
    }
    s
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

fn format_date(ms: f64, format: &str) -> String {
    let p = parts_of(ms);
    let h12 = if p.hour % 12.0 == 0.0 {
        12.0
    } else {
        p.hour % 12.0
    };
    let month_name = MONTHS[p.month as usize - 1];
    let weekday_name = WEEKDAYS[p.weekday];
    let tokens: Vec<(&str, String)> = vec![
        ("YYYY", pad(p.year, 4)),
        ("MMMM", month_name.to_string()),
        ("MMM", month_name[..3].to_string()),
        ("dddd", weekday_name.to_string()),
        ("ddd", weekday_name[..3].to_string()),
        ("SSS", pad(p.millisecond, 3)),
        ("YY", pad(p.year % 100.0, 2)),
        ("MM", pad(p.month, 2)),
        ("DD", pad(p.day, 2)),
        ("HH", pad(p.hour, 2)),
        ("hh", pad(h12, 2)),
        ("mm", pad(p.minute, 2)),
        ("ss", pad(p.second, 2)),
        ("M", num_str(p.month)),
        ("D", num_str(p.day)),
        ("H", num_str(p.hour)),
        ("h", num_str(h12)),
        ("m", num_str(p.minute)),
        ("s", num_str(p.second)),
        ("A", if p.hour < 12.0 { "AM" } else { "PM" }.to_string()),
        ("a", if p.hour < 12.0 { "am" } else { "pm" }.to_string()),
    ];
    let chars: Vec<char> = format.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(close) = chars[i + 1..].iter().position(|c| *c == ']') {
                out.extend(&chars[i + 1..i + 1 + close]);
                i += close + 2;
                continue;
            }
        }
        let rest: String = chars[i..(i + 4).min(chars.len())].iter().collect();
        if let Some((token, text)) = tokens.iter().find(|(t, _)| rest.starts_with(t)) {
            out.push_str(text);
            i += token.chars().count();
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

static DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?)?Z?$")
        .unwrap()
});

/// `YYYY-MM-DD`, optionally with `[T ]HH:mm[:ss[.SSS]]` and a trailing `Z`.
pub fn parse_date(s: &str) -> Option<f64> {
    let caps = DATE_RE.captures(js_trim(s))?;
    let num = |i: usize| -> f64 {
        caps.get(i)
            .map_or(0.0, |m| m.as_str().parse::<f64>().unwrap_or(0.0))
    };
    let (y, mo, d) = (num(1), num(2), num(3));
    if !(1.0..=12.0).contains(&mo) || d < 1.0 || d > days_in_month(y, mo) {
        return None;
    }
    let (hh, mi, ss) = (num(4), num(5), num(6));
    let ms = caps.get(7).map_or(0.0, |m| {
        format!("{:0<3}", m.as_str()).parse::<f64>().unwrap_or(0.0)
    });
    if hh > 23.0 || mi > 59.0 || ss > 59.0 {
        return None;
    }
    Some(days_from_civil(y, mo, d) * DAY_MS + hh * 3_600_000.0 + mi * 60_000.0 + ss * 1000.0 + ms)
}

/// "1M", "2 weeks", "1y 2M": calendar units are kept apart from fixed ones.
pub fn parse_duration(s: &str) -> Option<(f64, f64)> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let (mut months, mut ms) = (0.0, 0.0);
    let mut any = false;
    let space = |i: &mut usize| {
        while *i < chars.len() && is_js_space(chars[*i]) {
            *i += 1;
        }
    };
    space(&mut i);
    while i < chars.len() {
        let mut num = String::new();
        if chars[i] == '-' {
            num.push('-');
            i += 1;
        }
        let start = i;
        while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
            num.push(chars[i]);
            i += 1;
        }
        let n = js_number(&num);
        if i == start || n.is_nan() {
            return None;
        }
        space(&mut i);
        let mut unit = String::new();
        while i < chars.len() && chars[i].is_ascii_alphabetic() {
            unit.push(chars[i]);
            i += 1;
        }
        // The units Obsidian documents: one letter (`M` months and `m` minutes differ by
        // case), or the full word, singular or plural. `ms` and the rest are not units.
        let word: &str = if unit.len() > 1 {
            match unit.to_lowercase().as_str() {
                "year" | "years" => "y",
                "month" | "months" => "M",
                "week" | "weeks" => "w",
                "day" | "days" => "d",
                "hour" | "hours" => "h",
                "minute" | "minutes" => "m",
                "second" | "seconds" => "s",
                _ => return None,
            }
        } else {
            unit.as_str()
        };
        match word {
            "y" => months += (n * 12.0).trunc(),
            "M" => months += n.trunc(),
            "w" => ms += n * 7.0 * DAY_MS,
            "d" => ms += n * DAY_MS,
            "h" => ms += n * 3_600_000.0,
            "m" => ms += n * 60_000.0,
            "s" => ms += n * 1000.0,
            _ => return None,
        }
        any = true;
        space(&mut i);
    }
    any.then_some((months, ms))
}

fn add_duration(ms: f64, months: f64, dur_ms: f64, sign: f64) -> f64 {
    let mut out = ms;
    if months != 0.0 {
        let days = floor_div(out, DAY_MS);
        let rest = out - days * DAY_MS;
        let (y, m, d) = civil_from_days(days);
        let index = y * 12.0 + (m - 1.0) + sign * months;
        let ny = floor_div(index, 12.0);
        let nm = index - ny * 12.0 + 1.0;
        out = days_from_civil(ny, nm, d.min(days_in_month(ny, nm))) * DAY_MS + rest;
    }
    out + sign * dur_ms
}

// ---- syntax --------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Expr {
    Num(f64),
    Str(String),
    Bool(bool),
    Null,
    List(Vec<Expr>),
    Id(String),
    Member(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    Call {
        obj: Option<Box<Expr>>,
        name: String,
        args: Vec<Expr>,
    },
    Unary(char, Box<Expr>),
    Bin(String, Box<Expr>, Box<Expr>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TokKind {
    Num,
    Str,
    Id,
    Op,
    End,
}

struct Tok {
    kind: TokKind,
    v: String,
}

static IDENT_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}_]$").unwrap());
static IDENT_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}\p{M}_]$").unwrap());
const TWO_CHAR: [&str; 6] = ["==", "!=", ">=", "<=", "&&", "||"];
const ONE_CHAR: &str = "+-*/%()[],.!<>";
const MAX_DEPTH: usize = 64;

fn char_matches(re: &Regex, c: char) -> bool {
    let mut buf = [0u8; 4];
    re.is_match(c.encode_utf8(&mut buf))
}

fn tokenize(src: &str) -> Result<Vec<Tok>, ExprError> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if is_js_space(c) {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() {
            let mut n = String::new();
            while i < chars.len() && chars[i].is_ascii_digit() {
                n.push(chars[i]);
                i += 1;
            }
            if chars.get(i) == Some(&'.') && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()) {
                n.push('.');
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    n.push(chars[i]);
                    i += 1;
                }
            }
            out.push(Tok {
                kind: TokKind::Num,
                v: n,
            });
            continue;
        }
        if c == '"' || c == '\'' {
            let mut s = String::new();
            i += 1;
            loop {
                if i >= chars.len() {
                    return Err(ExprError("unterminated string".into()));
                }
                let d = chars[i];
                i += 1;
                if d == c {
                    break;
                }
                if d == '\\' && i < chars.len() {
                    let e = chars[i];
                    i += 1;
                    match e {
                        'n' => s.push('\n'),
                        't' => s.push('\t'),
                        '\\' | '"' | '\'' => s.push(e),
                        _ => {
                            s.push('\\');
                            s.push(e);
                        }
                    }
                } else {
                    s.push(d);
                }
            }
            out.push(Tok {
                kind: TokKind::Str,
                v: s,
            });
            continue;
        }
        if char_matches(&IDENT_START, c) {
            let mut name = String::new();
            while i < chars.len() && char_matches(&IDENT_PART, chars[i]) {
                name.push(chars[i]);
                i += 1;
            }
            out.push(Tok {
                kind: TokKind::Id,
                v: name,
            });
            continue;
        }
        let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
        if TWO_CHAR.contains(&two.as_str()) {
            out.push(Tok {
                kind: TokKind::Op,
                v: two,
            });
            i += 2;
            continue;
        }
        if ONE_CHAR.contains(c) {
            out.push(Tok {
                kind: TokKind::Op,
                v: c.to_string(),
            });
            i += 1;
            continue;
        }
        return Err(ExprError(format!("unexpected character '{c}'")));
    }
    out.push(Tok {
        kind: TokKind::End,
        v: String::new(),
    });
    Ok(out)
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
    depth: usize,
    nodes: usize,
}

/// Levels in a tree. Only called on a node whose children were already checked, so it is shallow.
fn expr_depth(e: &Expr) -> usize {
    1 + match e {
        Expr::List(items) => items.iter().map(expr_depth).max().unwrap_or(0),
        Expr::Member(obj, _) => expr_depth(obj),
        Expr::Index(obj, idx) => expr_depth(obj).max(expr_depth(idx)),
        Expr::Call { obj, args, .. } => obj
            .as_deref()
            .map_or(0, expr_depth)
            .max(args.iter().map(expr_depth).max().unwrap_or(0)),
        Expr::Unary(_, x) => expr_depth(x),
        Expr::Bin(_, l, r) => expr_depth(l).max(expr_depth(r)),
        _ => 0,
    }
}

type Parse<T = Expr> = Result<T, ExprError>;

impl Parser {
    fn peek(&self) -> &Tok {
        &self.toks[self.pos]
    }

    fn is_op(&self, v: &str) -> bool {
        self.peek().kind == TokKind::Op && self.peek().v == v
    }

    fn fail<T>(&self) -> Parse<T> {
        let tok = self.peek();
        Err(ExprError(if tok.kind == TokKind::End {
            "unexpected end of expression".into()
        } else {
            format!("unexpected '{}'", tok.v)
        }))
    }

    fn expect_op(&mut self, v: &str) -> Parse<()> {
        if !self.is_op(v) {
            return self.fail();
        }
        self.pos += 1;
        Ok(())
    }

    fn enter(&mut self) -> Parse<()> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(ExprError("expression is nested too deeply".into()));
        }
        Ok(())
    }

    /// Every node passes through here, so a chain of operators or `.a.b.c` calls cannot
    /// build a tree deeper than evaluation (or dropping it) can follow.
    fn built(&mut self, e: Expr) -> Parse {
        self.nodes += 1;
        if self.nodes > MAX_AST_NODES {
            return Err(ExprError("expression is too large".into()));
        }
        if expr_depth(&e) > MAX_AST_DEPTH {
            return Err(ExprError("expression is nested too deeply".into()));
        }
        Ok(e)
    }

    fn binary(&mut self, level: usize) -> Parse {
        const LEVELS: [&[&str]; 6] = [
            &["||"],
            &["&&"],
            &["==", "!="],
            &["<", ">", "<=", ">="],
            &["+", "-"],
            &["*", "/", "%"],
        ];
        if level == LEVELS.len() {
            return self.unary();
        }
        let mut l = self.binary(level + 1)?;
        while self.peek().kind == TokKind::Op && LEVELS[level].contains(&self.peek().v.as_str()) {
            let op = self.toks[self.pos].v.clone();
            self.pos += 1;
            let r = self.binary(level + 1)?;
            l = self.built(Expr::Bin(op, Box::new(l), Box::new(r)))?;
        }
        Ok(l)
    }

    fn unary(&mut self) -> Parse {
        if self.is_op("!") || self.is_op("-") {
            let op = self.toks[self.pos].v.chars().next().unwrap_or('!');
            self.pos += 1;
            self.enter()?;
            let e = self.unary()?;
            self.depth -= 1;
            return self.built(Expr::Unary(op, Box::new(e)));
        }
        self.postfix()
    }

    fn args(&mut self) -> Parse<Vec<Expr>> {
        self.expect_op("(")?;
        let mut list = Vec::new();
        self.enter()?;
        if !self.is_op(")") {
            list.push(self.binary(0)?);
            while self.is_op(",") {
                self.pos += 1;
                list.push(self.binary(0)?);
            }
        }
        self.depth -= 1;
        self.expect_op(")")?;
        Ok(list)
    }

    fn postfix(&mut self) -> Parse {
        let mut e = self.primary()?;
        loop {
            if self.is_op(".") {
                self.pos += 1;
                if self.peek().kind != TokKind::Id {
                    return self.fail();
                }
                let name = self.toks[self.pos].v.clone();
                self.pos += 1;
                let next = if self.is_op("(") {
                    Expr::Call {
                        obj: Some(Box::new(e)),
                        name,
                        args: self.args()?,
                    }
                } else {
                    Expr::Member(Box::new(e), name)
                };
                e = self.built(next)?;
            } else if self.is_op("[") {
                self.pos += 1;
                self.enter()?;
                let idx = self.binary(0)?;
                self.depth -= 1;
                self.expect_op("]")?;
                e = self.built(Expr::Index(Box::new(e), Box::new(idx)))?;
            } else {
                return Ok(e);
            }
        }
    }

    fn primary(&mut self) -> Parse {
        let (kind, v) = (self.peek().kind, self.peek().v.clone());
        match kind {
            TokKind::Num => {
                self.pos += 1;
                self.built(Expr::Num(v.parse::<f64>().unwrap_or(f64::NAN)))
            }
            TokKind::Str => {
                self.pos += 1;
                self.built(Expr::Str(v))
            }
            TokKind::Id => {
                self.pos += 1;
                if v == "true" || v == "false" {
                    return self.built(Expr::Bool(v == "true"));
                }
                if v == "null" {
                    return self.built(Expr::Null);
                }
                if self.is_op("(") {
                    let args = self.args()?;
                    return self.built(Expr::Call {
                        obj: None,
                        name: v,
                        args,
                    });
                }
                self.built(Expr::Id(v))
            }
            _ if self.is_op("(") => {
                self.pos += 1;
                self.enter()?;
                let e = self.binary(0)?;
                self.depth -= 1;
                self.expect_op(")")?;
                Ok(e)
            }
            _ if self.is_op("[") => {
                self.pos += 1;
                let mut items = Vec::new();
                self.enter()?;
                if !self.is_op("]") {
                    items.push(self.binary(0)?);
                    while self.is_op(",") {
                        self.pos += 1;
                        items.push(self.binary(0)?);
                    }
                }
                self.depth -= 1;
                self.expect_op("]")?;
                self.built(Expr::List(items))
            }
            _ => self.fail(),
        }
    }
}

pub fn parse_expr(src: &str) -> Result<Expr, ExprError> {
    let mut p = Parser {
        toks: tokenize(src)?,
        pos: 0,
        depth: 0,
        nodes: 0,
    };
    let result = p.binary(0)?;
    if p.peek().kind != TokKind::End {
        return p.fail();
    }
    Ok(result)
}

// ---- what is callable ----------------------------------------------------------

const GLOBALS: &[&str] = &[
    "if",
    "number",
    "min",
    "max",
    "list",
    "date",
    "duration",
    "now",
    "today",
    "link",
    "escapeHTML",
];
const UNSUPPORTED_GLOBALS: &[&str] = &["file", "html", "image", "icon", "random"];

const METHODS: &[&str] = &[
    "isTruthy",
    "isType",
    "toString",
    "isEmpty",
    "contains",
    "containsAll",
    "containsAny",
    "endsWith",
    "startsWith",
    "lower",
    "replace",
    "repeat",
    "reverse",
    "slice",
    "split",
    "title",
    "trim",
    "abs",
    "ceil",
    "floor",
    "round",
    "toFixed",
    "filter",
    "flat",
    "join",
    "map",
    "reduce",
    "sort",
    "unique",
    "sum",
    "mean",
    "min",
    "max",
    "median",
    "date",
    "format",
    "time",
    "keys",
    "values",
    "hasTag",
    "inFolder",
    "hasProperty",
    "hasLink",
    "asLink",
];
const UNSUPPORTED_METHODS: &[&str] = &["relative", "asFile", "linksTo", "matches"];

pub const FILE_PROPS: &[&str] = &[
    "name",
    "basename",
    "path",
    "folder",
    "ext",
    "mtime",
    "tags",
    "links",
    "properties",
    "para",
];
pub const UNSUPPORTED_FILE_PROPS: &[&str] = &["size", "ctime", "embeds", "backlinks"];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Findings {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Names and references that cannot work, found without evaluating anything.
pub fn check_expr(e: &Expr, formulas: &HashSet<String>, out: &mut Findings) {
    match e {
        Expr::List(items) => items.iter().for_each(|x| check_expr(x, formulas, out)),
        Expr::Id(name) => {
            if name == "this" {
                out.warnings.push("this is not supported".into());
            }
        }
        Expr::Member(obj, name) => match &**obj {
            Expr::Id(o) if o == "file" => {
                if UNSUPPORTED_FILE_PROPS.contains(&name.as_str()) {
                    out.warnings.push(format!("file.{name} is not supported"));
                } else if !FILE_PROPS.contains(&name.as_str()) {
                    out.warnings
                        .push(format!("file.{name} is not a known file property"));
                }
            }
            Expr::Id(o) if o == "formula" && !formulas.contains(name) => {
                out.warnings.push(format!("formula.{name} is not defined"));
            }
            other => check_expr(other, formulas, out),
        },
        Expr::Index(obj, idx) => {
            check_expr(obj, formulas, out);
            check_expr(idx, formulas, out);
        }
        Expr::Call { obj, name, args } => {
            if let Some(obj) = obj {
                check_expr(obj, formulas, out);
                if UNSUPPORTED_METHODS.contains(&name.as_str()) {
                    out.warnings.push(format!("{name}() is not supported"));
                } else if !METHODS.contains(&name.as_str()) {
                    out.errors.push(format!("unknown function '{name}'"));
                }
            } else if UNSUPPORTED_GLOBALS.contains(&name.as_str()) {
                out.warnings.push(format!("{name}() is not supported"));
            } else if !GLOBALS.contains(&name.as_str()) {
                out.errors.push(format!("unknown function '{name}'"));
            }
            args.iter().for_each(|x| check_expr(x, formulas, out));
        }
        Expr::Unary(_, x) => check_expr(x, formulas, out),
        Expr::Bin(_, l, r) => {
            check_expr(l, formulas, out);
            check_expr(r, formulas, out);
        }
        _ => {}
    }
}

/// The `formula.NAME` references inside an expression, in first-seen order.
pub fn formula_refs(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::List(items) => items.iter().for_each(|x| formula_refs(x, out)),
        Expr::Member(obj, name) => match &**obj {
            Expr::Id(o) if o == "formula" => {
                if !out.contains(name) {
                    out.push(name.clone());
                }
            }
            other => formula_refs(other, out),
        },
        Expr::Index(obj, idx) => {
            formula_refs(obj, out);
            formula_refs(idx, out);
        }
        Expr::Call { obj, args, .. } => {
            if let Some(obj) = obj {
                formula_refs(obj, out);
            }
            args.iter().for_each(|x| formula_refs(x, out));
        }
        Expr::Unary(_, x) => formula_refs(x, out),
        Expr::Bin(_, l, r) => {
            formula_refs(l, out);
            formula_refs(r, out);
        }
        _ => {}
    }
}

// ---- evaluation ----------------------------------------------------------------

/// What an expression sees about one concept.
#[derive(Debug, Clone)]
pub struct BaseRow {
    /// Bundle-relative path, `/`-separated.
    pub path: String,
    /// Path relative to the wiki layer.
    pub wiki_path: String,
    pub id: String,
    pub mtime_ms: f64,
    pub frontmatter: Map<String, Json>,
    /// `(target, resolved)` for each link in the body.
    pub links: Vec<(String, Option<String>)>,
}

pub struct EvalEnv<'a> {
    pub now: f64,
    /// Formula source by name, for `formula.NAME`.
    pub formulas: Option<&'a IndexMap<String, Expr>>,
    /// Where a formula that fails reports it.
    pub warnings: Option<&'a RefCell<Vec<String>>>,
    /// Steps left for the whole query, shared by every evaluator of it.
    pub budget: Cell<i64>,
}

fn ascii_lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

fn base_name(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

fn folder_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::Str(s) => !s.is_empty(),
        Value::Num(n) => *n != 0.0 && !n.is_nan(),
        _ => true,
    }
}

fn dur_number(months: f64, ms: f64) -> f64 {
    ms + months * 30.0 * DAY_MS
}

/// How a value reads in a table cell or inside a string.
pub fn display(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) => num_str(*n),
        Value::Str(s) => s.clone(),
        Value::List(items) => items.iter().map(display).collect::<Vec<_>>().join(", "),
        Value::Date(ms) => date_str(*ms),
        Value::Link { target, display } => display.clone().unwrap_or_else(|| target.clone()),
        Value::Dur { months, ms } => num_str(dur_number(*months, *ms)),
        Value::Obj(_) => serde_json::to_string(&to_json(v)).unwrap_or_default(),
    }
}

/// A JS number as JSON: whole numbers carry no fraction, NaN/Infinity are null.
pub fn json_num(x: f64) -> Json {
    if !x.is_finite() {
        return Json::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        return Json::Number(Number::from(x as i64));
    }
    Number::from_f64(x).map_or(Json::Null, Json::Number)
}

/// The JSON form returned to callers: dates and links become strings.
pub fn to_json(v: &Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Bool(b) => Json::Bool(*b),
        Value::Num(n) => json_num(*n),
        Value::Str(s) => Json::String(s.clone()),
        Value::List(items) => Json::Array(items.iter().map(to_json).collect()),
        Value::Date(ms) => Json::String(date_str(*ms)),
        Value::Link { target, display } => Json::String(match display {
            None => format!("[[{target}]]"),
            Some(d) => format!("[[{target}|{d}]]"),
        }),
        Value::Dur { months, ms } => json_num(dur_number(*months, *ms)),
        Value::Obj(entries) => {
            let mut map = Map::new();
            for (k, x) in entries {
                map.insert(k.clone(), to_json(x));
            }
            Json::Object(map)
        }
    }
}

/// A string that reads as a date, where a date is expected.
fn as_date(v: &Value) -> Option<f64> {
    match v {
        Value::Date(ms) => Some(*ms),
        Value::Str(s) => parse_date(s),
        _ => None,
    }
}

pub fn values_equal(a: &Value, b: &Value) -> bool {
    if matches!(a, Value::Null) || matches!(b, Value::Null) {
        return matches!((a, b), (Value::Null, Value::Null));
    }
    if matches!(a, Value::Date(_)) || matches!(b, Value::Date(_)) {
        return match (as_date(a), as_date(b)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        };
    }
    match (a, b) {
        (Value::List(x), Value::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| values_equal(p, q))
        }
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Num(x), Value::Num(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Link { target: x, .. }, Value::Link { target: y, .. }) => x == y,
        (Value::Dur { months: m1, ms: s1 }, Value::Dur { months: m2, ms: s2 }) => {
            m1 == m2 && s1 == s2
        }
        (Value::Obj(x), Value::Obj(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| obj_get(y, k).is_some_and(|w| values_equal(v, w)))
        }
        _ => false,
    }
}

fn rank(v: &Value) -> i32 {
    match v {
        Value::Null => 7,
        Value::Bool(_) => 0,
        Value::Num(_) => 1,
        Value::Date(_) => 2,
        Value::Str(_) => 3,
        Value::Link { .. } => 4,
        Value::List(_) => 5,
        _ => 6,
    }
}

fn cmp_f64(a: f64, b: f64) -> i32 {
    if a < b {
        -1
    } else if a > b {
        1
    } else {
        0
    }
}

fn ord_i32(o: Ordering) -> i32 {
    match o {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

/// A total order for sorting and grouping: empty last, then by type, then by value (NaN after numbers).
pub fn compare_values(a: &Value, b: &Value) -> i32 {
    let (ra, rb) = (rank(a), rank(b));
    if ra != rb {
        return ra - rb;
    }
    match (a, b) {
        (Value::Num(x), Value::Num(y)) => {
            // NaN sorts after every number (and equal to another NaN), so the order stays total.
            match (x.is_nan(), y.is_nan()) {
                (true, true) => 0,
                (true, false) => 1,
                (false, true) => -1,
                _ => cmp_f64(*x, *y),
            }
        }
        (Value::Bool(x), Value::Bool(y)) => *x as i32 - *y as i32,
        (Value::Date(x), Value::Date(y)) => cmp_f64(*x, *y),
        (Value::Str(x), Value::Str(y)) => ord_i32(locale_compare(x, y)),
        (Value::Link { target: x, .. }, Value::Link { target: y, .. }) => {
            ord_i32(locale_compare(x, y))
        }
        (Value::Null, _) | (_, Value::Null) => 0,
        _ => {
            let sa = serde_json::to_string(&to_json(a)).unwrap_or_default();
            let sb = serde_json::to_string(&to_json(b)).unwrap_or_default();
            ord_i32(locale_compare(&sa, &sb))
        }
    }
}

fn order_op(op: &str, a: &Value, b: &Value) -> bool {
    let c: Option<i32> = match (a, b) {
        (Value::Num(x), Value::Num(y)) => {
            if x < y {
                Some(-1)
            } else if x > y {
                Some(1)
            } else if x == y {
                Some(0)
            } else {
                None
            }
        }
        (Value::Str(x), Value::Str(y)) => Some(ord_i32(locale_compare(x, y))),
        _ if matches!(a, Value::Date(_)) || matches!(b, Value::Date(_)) => {
            match (as_date(a), as_date(b)) {
                (Some(x), Some(y)) => Some(cmp_f64(x, y)),
                _ => None,
            }
        }
        (Value::Bool(x), Value::Bool(y)) => Some(*x as i32 - *y as i32),
        _ => None,
    };
    match c {
        None => false,
        Some(c) => match op {
            "<" => c < 0,
            ">" => c > 0,
            "<=" => c <= 0,
            _ => c >= 0,
        },
    }
}

/// Tags as a list of strings, without a leading `#`.
pub fn tags_of(fm: &Map<String, Json>) -> Vec<String> {
    let list: Vec<String> = match fm.get("tags") {
        Some(Json::Array(items)) => items
            .iter()
            .filter_map(|t| t.as_str().map(str::to_string))
            .collect(),
        Some(Json::String(s)) => s
            .split(|c: char| c == ',' || is_js_space(c))
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    list.into_iter()
        .map(|t| t.strip_prefix('#').map_or(t.clone(), str::to_string))
        .filter(|t| !t.is_empty())
        .collect()
}

fn norm_folder(f: &str) -> &str {
    f.trim_matches('/')
}

fn link_key(s: &str) -> String {
    let t = s.strip_prefix("[[").unwrap_or(s);
    let t = t.strip_suffix("]]").unwrap_or(t);
    let t = t.find(['|', '#']).map_or(t, |i| &t[..i]);
    let lower = t.to_ascii_lowercase();
    if lower.ends_with(".md") {
        t[..t.len() - 3].to_string()
    } else {
        t.to_string()
    }
}

type Frame = Vec<(String, Value)>;

fn shadowed(scope: &[Frame], name: &str) -> bool {
    scope.iter().any(|f| f.iter().any(|(k, _)| k == name))
}

pub struct Evaluator<'a> {
    row: &'a BaseRow,
    env: &'a EvalEnv<'a>,
    cache: IndexMap<String, Value>,
    active: HashSet<String>,
    depth: usize,
}

static TITLE_RE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"(^|<S>)(<NS>)"));

impl<'a> Evaluator<'a> {
    pub fn new(row: &'a BaseRow, env: &'a EvalEnv<'a>) -> Self {
        Self {
            row,
            env,
            cache: IndexMap::new(),
            active: HashSet::new(),
            depth: 0,
        }
    }

    fn charge(&self, steps: i64) -> Eval<()> {
        let left = self.env.budget.get().saturating_sub(steps);
        self.env.budget.set(left);
        if left < 0 {
            return err("evaluation budget exceeded");
        }
        Ok(())
    }

    /// A value an expression built: it must stay small, and it costs in proportion to its size.
    fn made(&self, v: Value) -> Eval {
        let w = weight(&v, MAX_VALUE_WEIGHT);
        if w > MAX_VALUE_WEIGHT {
            return err("value is too large");
        }
        self.charge(1 + (w >> COST_SHIFT) as i64)?;
        Ok(v)
    }

    fn warn(&self, message: String) {
        if let Some(w) = self.env.warnings {
            let mut list = w.borrow_mut();
            if !list.contains(&message) {
                list.push(message);
            }
        }
    }

    /// A column or sort key: `file.x`, `formula.x`, `note.x` or a bare name.
    pub fn property(&mut self, id: &str) -> Eval {
        if let Some(rest) = id.strip_prefix("file.") {
            return self.file_prop(rest);
        }
        if let Some(rest) = id.strip_prefix("formula.") {
            return self.formula(rest);
        }
        Ok(self.note(id.strip_prefix("note.").unwrap_or(id)))
    }

    fn note(&self, name: &str) -> Value {
        self.row
            .frontmatter
            .get(name)
            .map_or(Value::Null, from_json)
    }

    fn formula(&mut self, name: &str) -> Eval {
        if let Some(v) = self.cache.get(name) {
            return Ok(v.clone());
        }
        let Some(expr) = self.env.formulas.and_then(|f| f.get(name)) else {
            return err(format!("formula.{name} is not defined"));
        };
        if self.active.contains(name) {
            return err(format!("formula.{name} refers to itself"));
        }
        if self.active.len() >= MAX_FORMULA_DEPTH {
            return err("formula references are nested too deeply");
        }
        self.active.insert(name.to_string());
        let value = match self.eval(expr, &mut Vec::new()) {
            Ok(v) => v,
            Err(EvalError(m)) => {
                self.warn(format!("formula.{name}: {m}"));
                Value::Null
            }
        };
        self.active.remove(name);
        self.cache.insert(name.to_string(), value.clone());
        Ok(value)
    }

    fn file_prop(&self, name: &str) -> Eval {
        let r = self.row;
        Ok(match name {
            "name" => Value::Str(base_name(&r.path).to_string()),
            "basename" => {
                let n = base_name(&r.path);
                Value::Str(n.rfind('.').map_or(n, |i| &n[..i]).to_string())
            }
            "path" => Value::Str(r.path.clone()),
            "folder" => Value::Str(folder_of(&r.path).to_string()),
            "ext" => Value::Str("md".into()),
            "mtime" => Value::Date(r.mtime_ms.floor()),
            "tags" => Value::List(
                tags_of(&r.frontmatter)
                    .into_iter()
                    .map(Value::Str)
                    .collect(),
            ),
            "links" => Value::List(
                r.links
                    .iter()
                    .map(|(target, resolved)| Value::Link {
                        target: resolved.clone().unwrap_or_else(|| target.clone()),
                        display: None,
                    })
                    .collect(),
            ),
            "properties" => from_json(&Json::Object(r.frontmatter.clone())),
            "para" => Value::Str(para_of(&r.wiki_path).as_str().to_string()),
            _ => {
                if UNSUPPORTED_FILE_PROPS.contains(&name) {
                    return err(format!("file.{name} is not supported"));
                }
                return err(format!("file.{name} is not a known file property"));
            }
        })
    }

    pub fn eval(&mut self, e: &Expr, scope: &mut Vec<Frame>) -> Eval {
        if self.depth >= MAX_EVAL_DEPTH {
            return err("expression is nested too deeply");
        }
        self.charge(1)?;
        self.depth += 1;
        let out = self.eval_node(e, scope);
        self.depth -= 1;
        out
    }

    fn eval_node(&mut self, e: &Expr, scope: &mut Vec<Frame>) -> Eval {
        match e {
            Expr::Num(n) => Ok(Value::Num(*n)),
            Expr::Str(s) => Ok(Value::Str(s.clone())),
            Expr::Bool(b) => Ok(Value::Bool(*b)),
            Expr::Null => Ok(Value::Null),
            Expr::List(items) => {
                let mut out = Vec::with_capacity(items.len());
                for x in items {
                    out.push(self.eval(x, scope)?);
                }
                self.made(Value::List(out))
            }
            Expr::Id(name) => {
                for frame in scope.iter().rev() {
                    if let Some((_, v)) = frame.iter().find(|(k, _)| k == name) {
                        return Ok(v.clone());
                    }
                }
                match name.as_str() {
                    "file" => Ok(Value::Link {
                        target: self.row.path.clone(),
                        display: None,
                    }),
                    "note" => Ok(from_json(&Json::Object(self.row.frontmatter.clone()))),
                    "formula" | "this" => err(format!("{name} cannot be used on its own")),
                    _ => Ok(self.note(name)),
                }
            }
            Expr::Member(obj, name) => {
                if let Expr::Id(o) = &**obj {
                    if !shadowed(scope, o) {
                        match o.as_str() {
                            "file" => return self.file_prop(name),
                            "note" => return Ok(self.note(name)),
                            "formula" => return self.formula(name),
                            _ => {}
                        }
                    }
                }
                let target = self.eval(obj, scope)?;
                Ok(member(&target, name))
            }
            Expr::Index(obj, idx) => {
                let obj = self.eval(obj, scope)?;
                let idx = self.eval(idx, scope)?;
                Ok(match (&obj, &idx) {
                    (Value::Null, _) | (_, Value::Null) => Value::Null,
                    (Value::List(items), Value::Num(n)) => {
                        if n.fract() == 0.0 && *n >= 0.0 && (*n as usize) < items.len() {
                            items[*n as usize].clone()
                        } else {
                            Value::Null
                        }
                    }
                    (Value::Obj(entries), Value::Str(key)) => {
                        obj_get(entries, key).cloned().unwrap_or(Value::Null)
                    }
                    _ => Value::Null,
                })
            }
            Expr::Unary(op, inner) => {
                let v = self.eval(inner, scope)?;
                if *op == '!' {
                    return Ok(Value::Bool(!truthy(&v)));
                }
                match v {
                    Value::Null => Ok(Value::Null),
                    Value::Num(n) => Ok(Value::Num(-n)),
                    other => err(format!("cannot apply '-' to {}", type_name(&other))),
                }
            }
            Expr::Bin(op, l, r) => self.binary(op, l, r, scope),
            Expr::Call { obj, name, args } => self.call(obj.as_deref(), name, args, scope),
        }
    }

    fn binary(&mut self, op: &str, l: &Expr, r: &Expr, scope: &mut Vec<Frame>) -> Eval {
        if op == "&&" {
            let lv = self.eval(l, scope)?;
            return if truthy(&lv) {
                self.eval(r, scope)
            } else {
                Ok(lv)
            };
        }
        if op == "||" {
            let lv = self.eval(l, scope)?;
            return if truthy(&lv) {
                Ok(lv)
            } else {
                self.eval(r, scope)
            };
        }
        let lv = self.eval(l, scope)?;
        let rv = self.eval(r, scope)?;
        match op {
            "==" => Ok(Value::Bool(values_equal(&lv, &rv))),
            "!=" => Ok(Value::Bool(!values_equal(&lv, &rv))),
            "<" | ">" | "<=" | ">=" => Ok(Value::Bool(order_op(op, &lv, &rv))),
            _ => {
                let v = arithmetic(op, &lv, &rv)?;
                self.made(v)
            }
        }
    }

    fn call(
        &mut self,
        obj: Option<&Expr>,
        name: &str,
        args: &[Expr],
        scope: &mut Vec<Frame>,
    ) -> Eval {
        let Some(obj) = obj else {
            let v = self.global(name, args, scope)?;
            return if name == "if" { Ok(v) } else { self.made(v) };
        };

        // `file.method(...)` reads the concept itself, not a value.
        if let Expr::Id(o) = obj {
            if o == "file" && !shadowed(scope, "file") {
                let mut values = Vec::with_capacity(args.len());
                for a in args {
                    values.push(self.eval(a, scope)?);
                }
                return self.file_method(name, &values);
            }
        }

        let recv = self.eval(obj, scope)?;
        let lazy = matches!(name, "filter" | "map" | "reduce");
        if lazy {
            if let Value::List(list) = &recv {
                let v = self.list_lambda(name, list, args, scope)?;
                return self.made(v);
            }
        }
        let mut values = Vec::new();
        if !lazy {
            for a in args {
                values.push(self.eval(a, scope)?);
            }
        }
        let v = self.method(&recv, name, &values)?;
        self.made(v)
    }

    fn list_lambda(
        &mut self,
        name: &str,
        list: &[Value],
        args: &[Expr],
        scope: &mut Vec<Frame>,
    ) -> Eval {
        let Some(body) = args.first() else {
            return err(format!("{name}() needs an expression"));
        };
        let frame_eval = |this: &mut Self, scope: &mut Vec<Frame>, frame: Frame| -> Eval {
            scope.push(frame);
            let out = this.eval(body, scope);
            scope.pop();
            out
        };
        match name {
            "filter" => {
                let mut out = Vec::new();
                for (i, value) in list.iter().enumerate() {
                    let frame = vec![
                        ("value".to_string(), value.clone()),
                        ("index".to_string(), Value::Num(i as f64)),
                    ];
                    if truthy(&frame_eval(self, scope, frame)?) {
                        out.push(value.clone());
                    }
                }
                Ok(Value::List(out))
            }
            "map" => {
                let mut out = Vec::new();
                for (i, value) in list.iter().enumerate() {
                    let frame = vec![
                        ("value".to_string(), value.clone()),
                        ("index".to_string(), Value::Num(i as f64)),
                    ];
                    out.push(frame_eval(self, scope, frame)?);
                }
                Ok(Value::List(out))
            }
            _ => {
                let mut acc = match args.get(1) {
                    Some(init) => self.eval(init, scope)?,
                    None => Value::Null,
                };
                for (i, value) in list.iter().enumerate() {
                    let frame = vec![
                        ("value".to_string(), value.clone()),
                        ("index".to_string(), Value::Num(i as f64)),
                        ("acc".to_string(), acc),
                    ];
                    acc = frame_eval(self, scope, frame)?;
                }
                Ok(acc)
            }
        }
    }

    fn global(&mut self, name: &str, args: &[Expr], scope: &mut Vec<Frame>) -> Eval {
        if name == "if" {
            if args.len() < 2 || args.len() > 3 {
                return err("if() takes 2 or 3 arguments");
            }
            let cond = self.eval(&args[0], scope)?;
            return if truthy(&cond) {
                self.eval(&args[1], scope)
            } else if let Some(other) = args.get(2) {
                self.eval(other, scope)
            } else {
                Ok(Value::Null)
            };
        }
        let mut values = Vec::with_capacity(args.len());
        for a in args {
            values.push(self.eval(a, scope)?);
        }
        let need = |n: usize| -> Eval<()> {
            if values.len() < n {
                return err(format!(
                    "{name}() needs {n} argument{}",
                    if n == 1 { "" } else { "s" }
                ));
            }
            Ok(())
        };
        match name {
            "now" => Ok(Value::Date(self.env.now)),
            "today" => Ok(Value::Date(floor_div(self.env.now, DAY_MS) * DAY_MS)),
            "number" => {
                need(1)?;
                Ok(match &values[0] {
                    Value::Num(n) => Value::Num(*n),
                    Value::Bool(b) => Value::Num(if *b { 1.0 } else { 0.0 }),
                    Value::Date(ms) => Value::Num(*ms),
                    Value::Dur { months, ms } => Value::Num(dur_number(*months, *ms)),
                    Value::Str(s) => {
                        if js_trim(s).is_empty() {
                            Value::Null
                        } else {
                            let n = js_number(s);
                            if n.is_nan() {
                                Value::Null
                            } else {
                                Value::Num(n)
                            }
                        }
                    }
                    _ => Value::Null,
                })
            }
            "min" | "max" => {
                need(1)?;
                let mut nums = Vec::new();
                for v in &values {
                    let items: Vec<&Value> = match v {
                        Value::List(l) => l.iter().collect(),
                        other => vec![other],
                    };
                    for item in items {
                        match item {
                            Value::Num(n) => nums.push(*n),
                            _ => return err(format!("{name}() takes numbers")),
                        }
                    }
                }
                if nums.is_empty() {
                    return Ok(Value::Null);
                }
                // `Math.min` / `Math.max`: NaN wins.
                let mut best = nums[0];
                for n in &nums {
                    if n.is_nan() || best.is_nan() {
                        best = f64::NAN;
                    } else if (name == "min" && *n < best) || (name == "max" && *n > best) {
                        best = *n;
                    }
                }
                Ok(Value::Num(best))
            }
            "list" => {
                need(1)?;
                Ok(match &values[0] {
                    Value::List(l) => Value::List(l.clone()),
                    other => Value::List(vec![other.clone()]),
                })
            }
            "date" => {
                need(1)?;
                match as_date(&values[0]) {
                    Some(ms) => Ok(Value::Date(ms)),
                    None => err("date() cannot read that value"),
                }
            }
            "duration" => {
                need(1)?;
                match &values[0] {
                    Value::Str(s) => match parse_duration(s) {
                        Some((months, ms)) => Ok(Value::Dur { months, ms }),
                        None => err("duration() cannot read that value"),
                    },
                    Value::Dur { months, ms } => Ok(Value::Dur {
                        months: *months,
                        ms: *ms,
                    }),
                    _ => err("duration() cannot read that value"),
                }
            }
            "link" => {
                need(1)?;
                let target = match &values[0] {
                    Value::Str(s) => s.clone(),
                    Value::Link { target, .. } => target.clone(),
                    _ => return err("link() needs a path"),
                };
                let shown = match values.get(1) {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(display(v)),
                };
                Ok(Value::Link {
                    target,
                    display: shown,
                })
            }
            "escapeHTML" => {
                need(1)?;
                Ok(Value::Str(
                    display(&values[0])
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                        .replace('"', "&quot;")
                        .replace('\'', "&#39;"),
                ))
            }
            _ => err(format!("{name}() is not supported")),
        }
    }

    fn file_method(&self, name: &str, args: &[Value]) -> Eval {
        let r = self.row;
        let strs = || -> Eval<Vec<&str>> {
            let mut out = Vec::new();
            for a in args {
                match a {
                    Value::Str(s) => out.push(s.as_str()),
                    _ => return err(format!("{name}() takes text")),
                }
            }
            Ok(out)
        };
        match name {
            "hasTag" => {
                let tags: Vec<String> = tags_of(&r.frontmatter)
                    .iter()
                    .map(|t| ascii_lower(t))
                    .collect();
                Ok(Value::Bool(strs()?.iter().any(|want| {
                    let w = ascii_lower(want.strip_prefix('#').unwrap_or(want));
                    tags.iter()
                        .any(|t| *t == w || t.starts_with(&format!("{w}/")))
                })))
            }
            "inFolder" => {
                let list = strs()?;
                let Some(folder_arg) = list.first() else {
                    return err("inFolder() needs a folder");
                };
                let f = norm_folder(folder_arg);
                if f.is_empty() {
                    return Ok(Value::Bool(true));
                }
                let within = |p: &str| p == f || p.starts_with(&format!("{f}/"));
                Ok(Value::Bool(
                    within(folder_of(&r.path)) || within(folder_of(&r.wiki_path)),
                ))
            }
            "hasProperty" => {
                let list = strs()?;
                Ok(Value::Bool(
                    list.first().is_some_and(|p| r.frontmatter.contains_key(*p)),
                ))
            }
            "hasLink" => {
                let want = match args.first() {
                    Some(Value::Link { target, .. }) => target.clone(),
                    Some(Value::Str(s)) => s.clone(),
                    _ => return err("hasLink() needs a file name or link"),
                };
                let key = link_key(&want);
                let tail = base_name(&key).to_string();
                Ok(Value::Bool(r.links.iter().any(|(target, resolved)| {
                    [target.as_str(), resolved.as_deref().unwrap_or("")]
                        .iter()
                        .any(|c| {
                            !c.is_empty() && (link_key(c) == key || base_name(&link_key(c)) == tail)
                        })
                })))
            }
            "asLink" => Ok(Value::Link {
                target: r.path.clone(),
                display: match args.first() {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(display(v)),
                },
            }),
            _ => err(format!("file has no method '{name}'")),
        }
    }
}

fn member(obj: &Value, name: &str) -> Value {
    match obj {
        Value::Null => Value::Null,
        Value::Str(s) => {
            if name == "length" {
                Value::Num(s.chars().count() as f64)
            } else {
                Value::Null
            }
        }
        Value::List(l) => {
            if name == "length" {
                Value::Num(l.len() as f64)
            } else {
                Value::Null
            }
        }
        Value::Date(ms) => {
            let p = parts_of(*ms);
            match name {
                "year" => Value::Num(p.year),
                "month" => Value::Num(p.month),
                "day" => Value::Num(p.day),
                "hour" => Value::Num(p.hour),
                "minute" => Value::Num(p.minute),
                "second" => Value::Num(p.second),
                "millisecond" => Value::Num(p.millisecond),
                _ => Value::Null,
            }
        }
        Value::Obj(entries) => obj_get(entries, name).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn arithmetic(op: &str, l: &Value, r: &Value) -> Eval {
    if matches!(l, Value::Null) || matches!(r, Value::Null) {
        return Ok(Value::Null);
    }
    let bad = || -> Eval {
        err(format!(
            "cannot apply '{op}' to {} and {}",
            type_name(l),
            type_name(r)
        ))
    };
    if let (Value::Num(a), Value::Num(b)) = (l, r) {
        return Ok(Value::Num(match op {
            "+" => a + b,
            "-" => a - b,
            "*" => a * b,
            "/" => a / b,
            _ => a % b,
        }));
    }
    if op == "+"
        && (matches!(l, Value::Str(_)) || matches!(r, Value::Str(_)))
        && !matches!(l, Value::Date(_))
    {
        if matches!(l, Value::Str(_)) && matches!(r, Value::Date(_)) {
            return bad();
        }
        return Ok(Value::Str(display(l) + &display(r)));
    }
    match l {
        Value::Date(ms) => {
            if op == "-" {
                if let Value::Date(other) = r {
                    return Ok(Value::Num(ms - other));
                }
            }
            if op == "+" || op == "-" {
                let dur = match r {
                    Value::Dur { months, ms } => Some((*months, *ms)),
                    Value::Str(s) => parse_duration(s),
                    _ => None,
                };
                let Some((months, dur_ms)) = dur else {
                    return bad();
                };
                return date_at(add_duration(
                    *ms,
                    months,
                    dur_ms,
                    if op == "+" { 1.0 } else { -1.0 },
                ));
            }
            bad()
        }
        Value::Dur { months, ms } => match (op, r) {
            ("*", Value::Num(n)) => Ok(Value::Dur {
                months: (months * n).trunc(),
                ms: ms * n,
            }),
            ("+", Value::Dur { months: m2, ms: s2 }) => Ok(Value::Dur {
                months: months + m2,
                ms: ms + s2,
            }),
            ("-", Value::Dur { months: m2, ms: s2 }) => Ok(Value::Dur {
                months: months - m2,
                ms: ms - s2,
            }),
            ("+", Value::Date(d)) => date_at(add_duration(*d, *months, *ms, 1.0)),
            _ => bad(),
        },
        _ => bad(),
    }
}

/// `value.slice(start, end)` argument: JS `ToIntegerOrInfinity`, then clamped
/// into `0..=len` with negative values counted from the end.
fn slice_bound(raw: f64, len: usize) -> usize {
    let n = if raw.is_nan() { 0.0 } else { raw.trunc() };
    let len_f = len as f64;
    if n < 0.0 {
        (len_f + n).max(0.0) as usize
    } else {
        n.min(len_f) as usize
    }
}

impl Evaluator<'_> {
    fn method(&self, recv: &Value, name: &str, args: &[Value]) -> Eval {
        // Valid on every type.
        match name {
            "isTruthy" => return Ok(Value::Bool(truthy(recv))),
            "toString" => return Ok(Value::Str(display(recv))),
            "isType" => {
                return match args.first() {
                    Some(Value::Str(t)) => Ok(Value::Bool(type_name(recv) == t)),
                    _ => err("isType() needs a type name"),
                };
            }
            _ => {}
        }
        if matches!(recv, Value::Null) {
            return Ok(match name {
                "isEmpty" => Value::Bool(true),
                "contains" | "containsAll" | "containsAny" => Value::Bool(false),
                _ => Value::Null,
            });
        }
        let num = |i: usize| -> Eval<f64> {
            match args.get(i) {
                Some(Value::Num(n)) => Ok(*n),
                _ => err(format!("{name}() needs a number")),
            }
        };
        let text = |i: usize| -> Eval<&str> {
            match args.get(i) {
                Some(Value::Str(s)) => Ok(s.as_str()),
                _ => err(format!("{name}() needs text")),
            }
        };
        let missing = || -> Eval { err(format!("{} has no method '{name}'", type_name(recv))) };

        match recv {
            Value::Str(s) => match name {
                "isEmpty" => Ok(Value::Bool(s.is_empty())),
                "contains" => Ok(Value::Bool(s.contains(text(0)?))),
                "containsAll" => {
                    for i in 0..args.len() {
                        if !s.contains(text(i)?) {
                            return Ok(Value::Bool(false));
                        }
                    }
                    Ok(Value::Bool(true))
                }
                "containsAny" => {
                    for i in 0..args.len() {
                        if s.contains(text(i)?) {
                            return Ok(Value::Bool(true));
                        }
                    }
                    Ok(Value::Bool(false))
                }
                "startsWith" => Ok(Value::Bool(s.starts_with(text(0)?))),
                "endsWith" => Ok(Value::Bool(s.ends_with(text(0)?))),
                "lower" => Ok(Value::Str(s.to_lowercase())),
                "trim" => Ok(Value::Str(js_trim(s).to_string())),
                "title" => Ok(Value::Str(
                    TITLE_RE
                        .replace_all(s, |c: &regex::Captures| {
                            format!("{}{}", &c[1], c[2].to_uppercase())
                        })
                        .into_owned(),
                )),
                "reverse" => Ok(Value::Str(s.chars().rev().collect())),
                "repeat" => {
                    let n = num(0)?;
                    if !(0.0..=10000.0).contains(&n) {
                        return err("repeat() count must be between 0 and 10000");
                    }
                    // Checked before building, so a huge result is never allocated.
                    if utf16_len(s).saturating_mul(n.trunc() as usize) > MAX_VALUE_WEIGHT {
                        return err("value is too large");
                    }
                    Ok(Value::Str(s.repeat(n.trunc() as usize)))
                }
                "replace" => {
                    let (pattern, replacement) = (text(0)?, text(1)?);
                    Ok(Value::Str(s.replacen(pattern, replacement, 1)))
                }
                "slice" => {
                    let units = to_utf16(s);
                    let start = slice_bound(num(0)?, units.len());
                    let end = if args.len() > 1 {
                        slice_bound(num(1)?, units.len())
                    } else {
                        units.len()
                    };
                    Ok(Value::Str(if start >= end {
                        String::new()
                    } else {
                        from_utf16(&units[start..end])
                    }))
                }
                "split" => {
                    let sep = text(0)?;
                    let parts: Vec<String> = if sep.is_empty() {
                        s.chars().map(|c| c.to_string()).collect()
                    } else {
                        s.split(sep).map(str::to_string).collect()
                    };
                    let parts = if args.len() > 1 {
                        let end = slice_bound(num(1)?, parts.len());
                        parts.into_iter().take(end).collect()
                    } else {
                        parts
                    };
                    Ok(Value::List(parts.into_iter().map(Value::Str).collect()))
                }
                _ => missing(),
            },
            Value::Num(x) => match name {
                "isEmpty" => Ok(Value::Bool(false)),
                "abs" => Ok(Value::Num(x.abs())),
                "ceil" => Ok(Value::Num(x.ceil())),
                "floor" => Ok(Value::Num(x.floor())),
                "round" => {
                    if args.is_empty() {
                        return Ok(Value::Num(js_round(*x)));
                    }
                    let f = 10f64.powi(num(0)?.trunc() as i32);
                    Ok(Value::Num(js_round(x * f) / f))
                }
                "toFixed" => {
                    let p = num(0)?;
                    if !(0.0..=100.0).contains(&p) {
                        return err("toFixed() precision must be between 0 and 100");
                    }
                    Ok(Value::Str(js_to_fixed(*x, p.trunc() as usize)))
                }
                _ => missing(),
            },
            Value::List(items) => {
                self.charge((items.len() * args.len().max(1)) as i64)?;
                match name {
                    "isEmpty" => Ok(Value::Bool(items.is_empty())),
                    "contains" => {
                        let want = args.first().cloned().unwrap_or(Value::Null);
                        Ok(Value::Bool(items.iter().any(|x| values_equal(x, &want))))
                    }
                    "containsAll" => Ok(Value::Bool(
                        args.iter()
                            .all(|a| items.iter().any(|x| values_equal(x, a))),
                    )),
                    "containsAny" => Ok(Value::Bool(
                        args.iter()
                            .any(|a| items.iter().any(|x| values_equal(x, a))),
                    )),
                    "flat" => {
                        fn push(items: &[Value], out: &mut Vec<Value>) {
                            for x in items {
                                match x {
                                    Value::List(inner) => push(inner, out),
                                    other => out.push(other.clone()),
                                }
                            }
                        }
                        let mut out = Vec::new();
                        push(items, &mut out);
                        Ok(Value::List(out))
                    }
                    "join" => {
                        let sep = if args.is_empty() { "," } else { text(0)? };
                        Ok(Value::Str(
                            items.iter().map(display).collect::<Vec<_>>().join(sep),
                        ))
                    }
                    "reverse" => Ok(Value::List(items.iter().rev().cloned().collect())),
                    "slice" => {
                        let start = slice_bound(num(0)?, items.len());
                        let end = if args.len() > 1 {
                            slice_bound(num(1)?, items.len())
                        } else {
                            items.len()
                        };
                        Ok(Value::List(if start >= end {
                            Vec::new()
                        } else {
                            items[start..end].to_vec()
                        }))
                    }
                    "sort" => {
                        let mut out = items.clone();
                        out.sort_by(|a, b| compare_values(a, b).cmp(&0));
                        Ok(Value::List(out))
                    }
                    "unique" => {
                        let mut out: Vec<Value> = Vec::new();
                        for x in items {
                            self.charge((out.len() >> 4) as i64)?;
                            if !out.iter().any(|y| values_equal(x, y)) {
                                out.push(x.clone());
                            }
                        }
                        Ok(Value::List(out))
                    }
                    "sum" | "mean" | "min" | "max" | "median" => {
                        let nums: Vec<f64> = items
                            .iter()
                            .filter_map(|x| match x {
                                Value::Num(n) if n.is_finite() => Some(*n),
                                _ => None,
                            })
                            .collect();
                        Ok(aggregate(name, &nums).map_or(Value::Null, Value::Num))
                    }
                    _ => missing(),
                }
            }
            Value::Date(ms) => match name {
                "isEmpty" => Ok(Value::Bool(false)),
                "date" => Ok(Value::Date(floor_div(*ms, DAY_MS) * DAY_MS)),
                "format" => Ok(Value::Str(format_date(*ms, text(0)?))),
                "time" => {
                    let p = parts_of(*ms);
                    Ok(Value::Str(format!(
                        "{}:{}:{}",
                        pad(p.hour, 2),
                        pad(p.minute, 2),
                        pad(p.second, 2)
                    )))
                }
                _ => missing(),
            },
            Value::Bool(_) | Value::Link { .. } | Value::Dur { .. } => {
                if name == "isEmpty" {
                    Ok(Value::Bool(false))
                } else {
                    missing()
                }
            }
            Value::Obj(entries) => match name {
                "isEmpty" => Ok(Value::Bool(entries.is_empty())),
                "keys" => Ok(Value::List(
                    entries.iter().map(|(k, _)| Value::Str(k.clone())).collect(),
                )),
                "values" => Ok(Value::List(
                    entries.iter().map(|(_, v)| v.clone()).collect(),
                )),
                _ => missing(),
            },
            _ => missing(),
        }
    }
}

/// The arithmetic summaries over a list of finite numbers; `None` when empty.
pub fn aggregate(name: &str, nums: &[f64]) -> Option<f64> {
    if nums.is_empty() {
        return None;
    }
    let mut sum = 0.0;
    for n in nums {
        sum += n;
    }
    let len = nums.len() as f64;
    Some(match name {
        "sum" => sum,
        "mean" => sum / len,
        "min" => nums
            .iter()
            .copied()
            .reduce(|a, b| if b < a { b } else { a })
            .unwrap_or(f64::NAN),
        "max" => nums
            .iter()
            .copied()
            .reduce(|a, b| if b > a { b } else { a })
            .unwrap_or(f64::NAN),
        "median" => {
            let mut s = nums.to_vec();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
            let mid = s.len() >> 1;
            if s.len() % 2 == 1 {
                s[mid]
            } else {
                (s[mid - 1] + s[mid]) / 2.0
            }
        }
        _ => {
            // stddev: the population standard deviation.
            let mean = sum / len;
            let mut sq = 0.0;
            for n in nums {
                sq += (n - mean) * (n - mean);
            }
            (sq / len).sqrt()
        }
    })
}

/// Evaluate one expression against one concept.
pub fn eval_expression(src: &str, row: &BaseRow, env: &EvalEnv) -> Result<Value, String> {
    let expr = parse_expr(src).map_err(|e| e.0)?;
    let mut found = Findings::default();
    let names: HashSet<String> = env
        .formulas
        .map(|f| f.keys().cloned().collect())
        .unwrap_or_default();
    check_expr(&expr, &names, &mut found);
    if let Some(first) = found.errors.first() {
        return Err(first.clone());
    }
    Evaluator::new(row, env)
        .eval(&expr, &mut Vec::new())
        .map_err(|e| e.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(fm: Json) -> BaseRow {
        BaseRow {
            path: "wiki/x/note.md".into(),
            wiki_path: "x/note.md".into(),
            id: "x/note".into(),
            mtime_ms: 1_768_003_200_000.5,
            frontmatter: fm.as_object().cloned().unwrap_or_default(),
            links: vec![("alpha".into(), Some("1-projects/alpha".into()))],
        }
    }

    const NOW: f64 = 1_768_478_400_000.0; // 2026-01-15T12:00:00Z

    fn ev(src: &str, fm: Json) -> Json {
        let env = EvalEnv {
            now: NOW,
            formulas: None,
            warnings: None,
            budget: Cell::new(EVAL_STEP_BUDGET),
        };
        match eval_expression(src, &row(fm), &env) {
            Ok(v) => to_json(&v),
            Err(e) => json!({ "error": e }),
        }
    }

    #[test]
    fn arithmetic_strings_and_comparison() {
        assert_eq!(ev("1 + 2 * 3", json!({})), json!(7));
        assert_eq!(ev("(1 + 2) * 3 % 4", json!({})), json!(1));
        assert_eq!(ev(r#""a" + "b""#, json!({})), json!("ab"));
        assert_eq!(ev(r#""n=" + 5"#, json!({})), json!("n=5"));
        assert_eq!(
            ev("price > 5 && price < 20", json!({"price": 10})),
            json!(true)
        );
        assert_eq!(ev("!missing", json!({})), json!(true));
        assert_eq!(ev("-price", json!({"price": 4})), json!(-4));
        assert_eq!(ev("null == null", json!({})), json!(true));
        assert_eq!(ev("price + 1", json!({})), Json::Null);
        assert_eq!(ev("price.toFixed(2)", json!({})), Json::Null);
    }

    #[test]
    fn file_properties_and_methods() {
        assert_eq!(ev("file.name", json!({})), json!("note.md"));
        assert_eq!(ev("file.basename", json!({})), json!("note"));
        assert_eq!(ev("file.folder", json!({})), json!("wiki/x"));
        assert_eq!(ev("file.para", json!({})), json!("resource"));
        let fm = json!({"tags": ["Project/Alpha", "#plain"]});
        assert_eq!(ev(r#"file.hasTag("project")"#, fm.clone()), json!(true));
        assert_eq!(ev(r#"file.hasTag("proj")"#, fm.clone()), json!(false));
        assert_eq!(ev("file.tags.length", fm), json!(2));
        assert_eq!(ev(r#"file.inFolder("x")"#, json!({})), json!(true));
        assert_eq!(ev(r#"file.inFolder("xy")"#, json!({})), json!(false));
        assert_eq!(ev(r#"file.hasLink("alpha")"#, json!({})), json!(true));
        assert_eq!(ev("file.mtime.year", json!({})), json!(2026));
    }

    #[test]
    fn methods_and_dates() {
        assert_eq!(
            ev(r#""hello world".title()"#, json!({})),
            json!("Hello World")
        );
        assert_eq!(ev(r#""abcdef".slice(1, -1)"#, json!({})), json!("bcde"));
        assert_eq!(ev("(2.5).toFixed(0)", json!({})), json!("3"));
        assert_eq!(ev("(1.005).toFixed(2)", json!({})), json!("1.00"));
        assert_eq!(ev("(2.71828).round(2)", json!({})), json!(2.72));
        assert_eq!(
            ev(
                "[1, 2, 3].map(value * 2).filter(value > 2).join(\",\")",
                json!({})
            ),
            json!("4,6")
        );
        assert_eq!(ev("[1, 2, 3].reduce(acc + value, 0)", json!({})), json!(6));
        assert_eq!(
            ev(r#""a,b,c".split(",").join("-")"#, json!({})),
            json!("a-b-c")
        );
        assert_eq!(
            ev(
                r#"(date("2026-01-31") + "1M").format("YYYY-MM-DD")"#,
                json!({})
            ),
            json!("2026-02-28")
        );
        assert_eq!(
            ev(r#"date("2026-01-02") - date("2026-01-01")"#, json!({})),
            json!(86_400_000)
        );
        assert_eq!(
            ev(
                r#"date("2026-03-04 05:06:07").format("YYYY/MM/DD HH:mm")"#,
                json!({})
            ),
            json!("2026/03/04 05:06")
        );
        assert_eq!(
            ev(r#"due > date("2026-01-31")"#, json!({"due": "2026-02-01"})),
            json!(true)
        );
        assert_eq!(
            ev(r#"(duration("1d") * 2) == duration("48h")"#, json!({})),
            json!(true)
        );
        assert_eq!(ev("today().hour", json!({})), json!(0));
    }

    #[test]
    fn code_cannot_be_smuggled_in() {
        for src in [
            "process.exit(1)",
            "constructor.constructor('x')()",
            "a = 1",
            "1 +",
            "\"open",
        ] {
            assert!(ev(src, json!({})).get("error").is_some(), "{src}");
        }
        assert_eq!(ev("x.__proto__", json!({})), Json::Null);
        assert_eq!(ev("toString", json!({})), Json::Null);
        assert_eq!(ev("constructor", json!({})), Json::Null);
    }

    // ---- limits: hostile input must come back as errors, quickly, on a small stack ----

    /// The Windows main thread has 1 MB of stack; every hostile case must fit in that.
    fn small_stack<F: FnOnce() + Send + 'static>(f: F) {
        std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(f)
            .unwrap()
            .join()
            .unwrap();
    }

    fn err_of(src: &str) -> String {
        match ev(src, json!({})) {
            Json::Object(m) => m
                .get("error")
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string(),
            other => panic!("{src:.60}: expected an error, got {other}"),
        }
    }

    fn within(f: impl FnOnce()) {
        let start = std::time::Instant::now();
        f();
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn long_chains_are_a_parse_error_not_a_stack_overflow() {
        small_stack(|| {
            within(|| {
                for op in ["+", "&&", "-", "*", "=="] {
                    let src = vec!["1"; 50_000].join(&format!(" {op} "));
                    assert_eq!(err_of(&src), "expression is nested too deeply", "{op}");
                }
                assert_eq!(
                    err_of(&format!("a{}", ".b".repeat(50_000))),
                    "expression is nested too deeply"
                );
                assert_eq!(
                    err_of(&format!("\"x\"{}", ".trim()".repeat(50_000))),
                    "expression is nested too deeply"
                );
                assert_eq!(
                    err_of(&format!("a{}", "[0]".repeat(50_000))),
                    "expression is nested too deeply"
                );
                assert_eq!(
                    err_of(&format!("{}1", "-".repeat(50_000))),
                    "expression is nested too deeply"
                );
                assert_eq!(
                    err_of(&format!("[{}]", vec!["1"; 20_000].join(","))),
                    "expression is too large"
                );
            });
        });
    }

    #[test]
    fn the_limits_leave_ordinary_long_expressions_alone() {
        assert_eq!(ev(&vec!["1"; 100].join(" + "), json!({})), json!(100));
        assert_eq!(
            ev(&format!("\"x\"{}", ".trim()".repeat(100)), json!({})),
            json!("x")
        );
    }

    #[test]
    fn repeat_doubling_and_nested_maps_end_in_an_evaluation_error() {
        small_stack(|| {
            within(|| {
                assert_eq!(
                    err_of(r#""x".repeat(10000).repeat(10000)"#),
                    "value is too large"
                );
                let twenty = vec!["1"; 20].join(",");
                assert_eq!(
                    err_of(&format!(r#"[{twenty}].reduce(acc + acc, "ab")"#)),
                    "value is too large"
                );
                let h = r#""x".repeat(100).split("")"#;
                let nested = format!("{h}.map({h}.map({h}.map({h}.map(value))))");
                assert!(!err_of(&nested).is_empty());
                assert!(!err_of(r#""x".repeat(100).split("").map(value.repeat(10000))"#).is_empty());
            });
        });
    }

    #[test]
    fn dates_beyond_the_representable_range_are_an_error() {
        small_stack(|| {
            let zeros = "0".repeat(400);
            for src in [
                r#"date("2026-01-01") + duration("999999999999999999y")"#.to_string(),
                format!(r#"date("2026-01-01") + duration("1{zeros}y")"#),
                format!(r#"(duration("1{zeros}d") + date("2026-01-01")).format("MMMM")"#),
            ] {
                assert_eq!(err_of(&src), "date is out of range", "{src}");
            }
        });
    }

    #[test]
    fn durations_use_the_documented_units_only() {
        assert_eq!(
            ev(
                r#"(date("2026-01-31 00:00") + "30m").format("HH:mm")"#,
                json!({})
            ),
            json!("00:30")
        );
        assert_eq!(
            ev(
                r#"(date("2026-01-31") + "1M").format("YYYY-MM-DD")"#,
                json!({})
            ),
            json!("2026-02-28")
        );
        assert_eq!(
            ev(
                r#"(date("2026-01-31") + "2 Months").format("YYYY-MM-DD")"#,
                json!({})
            ),
            json!("2026-03-31")
        );
        assert_eq!(
            ev(
                r#"(date("2026-01-01 00:00") + "90 minutes").format("HH:mm")"#,
                json!({})
            ),
            json!("01:30")
        );
        assert_eq!(
            ev(
                r#"(date("2026-01-01 00:00") + "1h 30m").format("HH:mm")"#,
                json!({})
            ),
            json!("01:30")
        );
        for unit in ["ms", "MS", "Ms", "msec", "mins", "sec", "hrs", "Y", "H", "D"] {
            assert_eq!(
                err_of(&format!(r#"duration("5{unit}")"#)),
                "duration() cannot read that value",
                "{unit}"
            );
            assert_eq!(
                err_of(&format!(r#"date("2026-01-01") + "5{unit}""#)),
                "cannot apply '+' to date and string",
                "{unit}"
            );
        }
        assert_eq!(
            err_of(r#"duration("5")"#),
            "duration() cannot read that value"
        );
    }

    #[test]
    fn nan_sorts_after_every_number_and_the_order_is_total() {
        assert_eq!(
            ev(r#"[2, 0 / 0, 1, 0 / 0, 3].sort().join(",")"#, json!({})),
            json!("1,2,3,NaN,NaN")
        );
        // A comparator that is not a total order can make `sort` panic; many NaNs must not.
        let many = vec!["0 / 0", "1", "2", "3"]
            .into_iter()
            .cycle()
            .take(400)
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(
            ev(&format!("[{many}].sort()[0]"), json!({})),
            json!(1)
        );
    }
}
