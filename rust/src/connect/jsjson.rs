//! `JSON.stringify(value, null, 2)` and `String(number)` as JavaScript writes
//! them, over `serde_json::Value`.
//!
//! The merges in [`super::merge`] must produce the bytes the TypeScript does
//! for the same input, because a second run is compared against the first to
//! decide whether anything needs writing (and a backup taken). serde_json
//! differs from V8 in three observable ways, all handled here:
//!
//! * numbers: `1.0` is `1`, `1e21` is `1e+21`, and integers beyond 2^53 lose
//!   precision because JS has only doubles;
//! * key order: integer-like keys of an object come first, ascending;
//! * non-finite numbers are `null`.

use serde_json::{Map, Value};

/// `String(x)` for a JS number (ECMAScript `Number::toString`).
pub fn js_number_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity".into() } else { "Infinity".into() };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Shortest round-trip digits: Rust's `{:e}` gives `d.ddde<exp>`.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exp + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let esign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{esign}{}", e.abs())
        } else {
            format!("{}.{}e{esign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

/// A canonical array index: what V8 keeps in front of named properties.
pub fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// The entries of an object in JS enumeration order.
pub fn js_ordered(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut rest: Vec<(&String, &Value)> = Vec::new();
    for (k, v) in map {
        match array_index(k) {
            Some(n) => indexed.push((n, k, v)),
            None => rest.push((k, v)),
        }
    }
    if indexed.is_empty() {
        return rest;
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    indexed
        .into_iter()
        .map(|(_, k, v)| (k, v))
        .chain(rest)
        .collect()
}

/// `JSON.stringify(string)`.
pub fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// A JSON number as the double JS would hold, or `None` when it prints `null`.
pub fn number_f64(n: &serde_json::Number) -> Option<f64> {
    n.as_f64().filter(|x| x.is_finite())
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, 0, &mut out);
    out
}

fn write_value(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match number_f64(n) {
            Some(x) => out.push_str(&js_number_string(x)),
            None => out.push_str("null"),
        },
        Value::String(s) => out.push_str(&json_string(s)),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                push_indent(out, depth + 1);
                write_value(item, depth + 1, out);
                out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            push_indent(out, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            let entries = js_ordered(map);
            let last = entries.len();
            for (i, (k, v)) in entries.into_iter().enumerate() {
                push_indent(out, depth + 1);
                out.push_str(&json_string(k));
                out.push_str(": ");
                write_value(v, depth + 1, out);
                out.push_str(if i + 1 < last { ",\n" } else { "\n" });
            }
            push_indent(out, depth);
            out.push('}');
        }
    }
}

fn push_indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

// ---- JSON.parse -----------------------------------------------------------------

/// Deepest nesting accepted. JS parses far deeper; a config nested this far is
/// refused (as unparseable) rather than risking the stack.
const MAX_DEPTH: usize = 1000;

struct Parser<'a> {
    src: &'a [u8],
    text: &'a str,
    pos: usize,
}

/// `JSON.parse(text)`, or `None` where JS throws.
///
/// Differs from serde_json in the places the merges can observe: a number
/// beyond the double range is `Infinity` in JS (held here as `null`, which is
/// what `JSON.stringify` writes for it) instead of an error, and the nesting
/// limit is far higher than serde's 128. Duplicate keys keep the first
/// position and the last value, as in a JS object. A lone surrogate escape
/// becomes U+FFFD, as Rust strings cannot hold one.
pub fn parse(text: &str) -> Option<Value> {
    let mut p = Parser { src: text.as_bytes(), text, pos: 0 };
    p.skip_ws();
    let value = p.value(0)?;
    p.skip_ws();
    (p.pos == p.src.len()).then_some(value)
}

impl Parser<'_> {
    fn skip_ws(&mut self) {
        while matches!(self.src.get(self.pos), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.src.get(self.pos) == Some(&byte) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Option<Value> {
        if self.src[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            Some(value)
        } else {
            None
        }
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        match *self.src.get(self.pos)? {
            b'{' => {
                self.pos += 1;
                let mut map = Map::new();
                self.skip_ws();
                if self.eat(b'}') {
                    return Some(Value::Object(map));
                }
                loop {
                    self.skip_ws();
                    let key = self.string()?;
                    self.skip_ws();
                    if !self.eat(b':') {
                        return None;
                    }
                    self.skip_ws();
                    let value = self.value(depth + 1)?;
                    map.insert(key, value);
                    self.skip_ws();
                    if self.eat(b',') {
                        continue;
                    }
                    return self.eat(b'}').then_some(Value::Object(map));
                }
            }
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                self.skip_ws();
                if self.eat(b']') {
                    return Some(Value::Array(items));
                }
                loop {
                    self.skip_ws();
                    items.push(self.value(depth + 1)?);
                    self.skip_ws();
                    if self.eat(b',') {
                        continue;
                    }
                    return self.eat(b']').then_some(Value::Array(items));
                }
            }
            b'"' => self.string().map(Value::String),
            b't' => self.literal("true", Value::Bool(true)),
            b'f' => self.literal("false", Value::Bool(false)),
            b'n' => self.literal("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while self.src.get(self.pos).is_some_and(u8::is_ascii_digit) {
            self.pos += 1;
        }
        self.pos - start
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.pos;
        self.eat(b'-');
        match self.src.get(self.pos)? {
            b'0' => self.pos += 1,
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return None,
        }
        if self.eat(b'.') && self.digits() == 0 {
            return None;
        }
        if matches!(self.src.get(self.pos), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.src.get(self.pos), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return None;
            }
        }
        let x: f64 = self.text[start..self.pos].parse().ok()?;
        Some(if !x.is_finite() {
            Value::Null
        } else if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
            Value::Number(serde_json::Number::from(x as i64))
        } else {
            serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
        })
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = self.text.get(self.pos..self.pos + 4)?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.pos += 4;
        u32::from_str_radix(digits, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        if !self.eat(b'"') {
            return None;
        }
        let mut out = String::new();
        loop {
            let c = self.text[self.pos..].chars().next()?;
            self.pos += c.len_utf8();
            match c {
                '"' => return Some(out),
                '\\' => {
                    let esc = self.text[self.pos..].chars().next()?;
                    self.pos += esc.len_utf8();
                    match esc {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let first = self.hex4()?;
                            let mut code = first;
                            if (0xD800..0xDC00).contains(&first) && self.text[self.pos..].starts_with("\\u") {
                                // A surrogate pair spelled as two escapes.
                                let save = self.pos;
                                self.pos += 2;
                                match self.hex4() {
                                    Some(low) if (0xDC00..0xE000).contains(&low) => {
                                        code = 0x10000 + ((first - 0xD800) << 10) + (low - 0xDC00);
                                    }
                                    _ => self.pos = save,
                                }
                            }
                            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                        }
                        _ => return None,
                    }
                }
                c if (c as u32) < 0x20 => return None,
                c => out.push(c),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_v8() {
        for (x, want) in [
            (1.0, "1"),
            (-0.0, "0"),
            (0.1, "0.1"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (9007199254740993.0, "9007199254740992"),
            (-12.5, "-12.5"),
        ] {
            assert_eq!(js_number_string(x), want, "{x}");
        }
    }

    #[test]
    fn integer_keys_come_first() {
        let v: Value = serde_json::from_str(r#"{"b":1,"2":2,"a":3,"1":4}"#).unwrap();
        assert_eq!(
            stringify_pretty(&v),
            "{\n  \"1\": 4,\n  \"2\": 2,\n  \"b\": 1,\n  \"a\": 3\n}"
        );
    }

    #[test]
    fn parse_matches_json_parse() {
        let v = parse(r#" {"a":[1],"b":{"c":null},"a":3,"s":"\u00e9\ud83d\ude00\n"} "#).unwrap();
        assert_eq!(
            stringify_pretty(&v),
            "{\n  \"a\": 3,\n  \"b\": {\n    \"c\": null\n  },\n  \"s\": \"é😀\\n\"\n}"
        );
        let v = parse("[1,2.50,-0,1e400,12345678901234567890]").unwrap();
        assert_eq!(
            stringify_pretty(&v),
            "[\n  1,\n  2.5,\n  0,\n  null,\n  12345678901234567000\n]"
        );
        for bad in [
            "", "{", "[1,]", "{\"a\":1,}", "'a'", "01", "1.", ".5", "+1", "\"\\x\"", "\"a\nb\"", "nul",
            "{\"a\"}", "[] x", "\u{feff}{}",
        ] {
            assert!(parse(bad).is_none(), "{bad:?}");
        }
        assert_eq!(parse("  [ ]  "), Some(Value::Array(vec![])));
        assert!(parse(&format!("{}{}", "[".repeat(5000), "]".repeat(5000))).is_none());
        assert!(parse(&format!("{}{}", "[".repeat(900), "]".repeat(900))).is_some());
    }

    #[test]
    fn floats_and_empties() {
        let v: Value = serde_json::from_str(r#"{"a":1.0,"b":[],"c":{},"d":[1,2.50]}"#).unwrap();
        assert_eq!(
            stringify_pretty(&v),
            "{\n  \"a\": 1,\n  \"b\": [],\n  \"c\": {},\n  \"d\": [\n    1,\n    2.5\n  ]\n}"
        );
    }
}
