//! Helpers that reproduce JavaScript string/number semantics.
//!
//! The TypeScript original leans on `String.prototype.trim`, `\s`, `.length`,
//! `slice`, `encodeURI`, `Number()` and `localeCompare`. Each of those differs
//! subtly from the Rust standard library, and a byte-for-byte parity test makes
//! the differences observable. They are collected here so every module uses the
//! same definition.
//!
//! **UTF-16 offsets.** JS indexes strings in UTF-16 code units. Wherever an
//! offset or length is observable (snippets, chunk sizes, highlight spans) the
//! port computes it in UTF-16 units too. Slicing that would split a surrogate
//! pair yields a lone surrogate in JS; Rust strings cannot hold one, so
//! [`from_utf16`] substitutes U+FFFD. That is the only known divergence.

use regex::Regex;
use serde::Serializer;
use std::cmp::Ordering;

/// Contents of a regex character class matching exactly what JS `\s` matches.
///
/// JS: `[\t\n\v\f\r    -     　﻿]`.
/// Rust's `\s` differs (it includes U+0085 and excludes U+FEFF).
pub const JS_WS_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Contents of a class matching what JS `.` matches (no line terminators).
pub const JS_DOT_CLASS_NEG: &str = r"\n\r\x{2028}\x{2029}";

/// Build a [`Regex`] from a pattern written with JS-flavoured placeholders.
///
/// * `<S>` / `<NS>` stand for JS `\s` / `\S` outside a character class
/// * `<WS>` is the raw class body, for use inside `[...]`
/// * `<DOT>` stands for JS `.` (anything but a line terminator)
/// * `<D>` stands for JS `\d` (ASCII digits only)
///
/// Panics on an invalid pattern: every call site passes a literal.
pub fn js_regex(pattern: &str) -> Regex {
    let expanded = pattern
        .replace("<NS>", &format!("[^{JS_WS_CLASS}]"))
        .replace("<S>", &format!("[{JS_WS_CLASS}]"))
        .replace("<WS>", JS_WS_CLASS)
        .replace("<DOT>", &format!("[^{JS_DOT_CLASS_NEG}]"))
        .replace("<D>", "[0-9]");
    Regex::new(&expanded).unwrap_or_else(|e| panic!("invalid regex {pattern:?}: {e}"))
}

/// True for what JS treats as white space or a line terminator (`\s`, `trim`).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// True for a JS line terminator (`.` never matches these; `^`/`$` with `m`).
pub fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `String.prototype.trimStart`.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// `String.prototype.trimEnd`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

/// `s.split(/\r?\n/)`: split at `\n`, swallowing one `\r` before it.
///
/// A lone `\r` is not a separator, and a trailing `\r` on the last piece stays.
pub fn split_crlf(s: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = s.split('\n').collect();
    let last = parts.len() - 1;
    for part in parts.iter_mut().take(last) {
        if let Some(stripped) = part.strip_suffix('\r') {
            *part = stripped;
        }
    }
    parts
}

/// Byte offset of the first `prefix` that sits at the start of a JS "line"
/// (offset 0, or right after `\n`, `\r`, U+2028 or U+2029): `/^prefix/m`.
pub fn find_at_line_start(s: &str, prefix: &str) -> Option<usize> {
    let mut at_start = true;
    for (i, c) in s.char_indices() {
        if at_start && s[i..].starts_with(prefix) {
            return Some(i);
        }
        at_start = is_js_line_terminator(c);
    }
    None
}

// ---- UTF-16 ---------------------------------------------------------------

/// JS `.length`.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The UTF-16 code units of `s`.
pub fn to_utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Back to a `String`; a lone surrogate becomes U+FFFD (see module docs).
pub fn from_utf16(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// JS `s.slice(start, end)` over UTF-16 units, with indices already clamped to
/// non-negative values. `start >= end` or out of range yields an empty slice.
pub fn slice16(units: &[u16], start: usize, end: usize) -> &[u16] {
    let end = end.min(units.len());
    if start >= end {
        &[]
    } else {
        &units[start..end]
    }
}

/// JS `haystack.indexOf(needle, from)` over UTF-16 units.
pub fn index_of16(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    let from = from.min(haystack.len());
    if needle.is_empty() {
        return Some(from);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&i| haystack[i..i + needle.len()] == *needle)
}

/// True for a UTF-16 unit that is JS white space.
pub fn is_js_space16(unit: u16) -> bool {
    char::from_u32(unit as u32).is_some_and(is_js_space)
}

/// JS `trim` over UTF-16 units.
pub fn trim16(units: &[u16]) -> &[u16] {
    let mut start = 0;
    let mut end = units.len();
    while start < end && is_js_space16(units[start]) {
        start += 1;
    }
    while end > start && is_js_space16(units[end - 1]) {
        end -= 1;
    }
    &units[start..end]
}

// ---- URI encoding -----------------------------------------------------------

const URI_UNRESERVED_MARKS: &str = "-_.!~*'()";
const URI_RESERVED: &str = ";/?:@&=+$,#";

fn percent_encode(s: &str, keep: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(s.len());
    let mut buf = [0u8; 4];
    for c in s.chars() {
        if keep(c) {
            out.push(c);
        } else {
            for byte in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

/// JS `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    percent_encode(s, |c| {
        c.is_ascii_alphanumeric() || URI_UNRESERVED_MARKS.contains(c)
    })
}

/// JS `encodeURI`.
pub fn encode_uri(s: &str) -> String {
    percent_encode(s, |c| {
        c.is_ascii_alphanumeric() || URI_UNRESERVED_MARKS.contains(c) || URI_RESERVED.contains(c)
    })
}

/// JS `decodeURIComponent`; `None` where JS would throw `URIError`.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ---- case-insensitive ASCII helpers -------------------------------------------

/// Whether `s` ends with `suffix`, comparing ASCII letters case-insensitively.
///
/// JS `/\.md$/i` folds only ASCII here, whereas Rust's Unicode `(?i)` would
/// also fold e.g. the Kelvin sign into `k`.
pub fn ends_with_ascii_ci(s: &str, suffix: &str) -> bool {
    let (s, suffix) = (s.as_bytes(), suffix.as_bytes());
    s.len() >= suffix.len() && s[s.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

// ---- numbers ------------------------------------------------------------------

/// JS `Math.round`: half rounds toward +infinity.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// JS `Number(string)`; `NaN` where JS yields `NaN`.
pub fn js_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return match u128::from_str_radix(rest, radix) {
                Ok(v) if !rest.starts_with(['+', '-']) => v as f64,
                _ => f64::NAN,
            };
        }
    }
    let (negative, body) = match t.as_bytes()[0] {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    if body == "Infinity" {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let valid = !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    match valid.then(|| body.parse::<f64>().ok()).flatten() {
        Some(v) => {
            if negative {
                -v
            } else {
                v
            }
        }
        None => f64::NAN,
    }
}

/// Serde helper: write an `f64` the way `JSON.stringify` does for ordinary
/// values (a whole number carries no `.0`). Use with
/// `#[serde(serialize_with = "...")]`.
///
/// Known gap: values below 1e-6 or at/above 1e16 use serde_json's exponent
/// layout, which differs from JS. Neither occurs for timestamps or scores.
pub fn serialize_js_f64<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

/// JS `String(number)` (`Number::toString`): shortest round-trip digits, laid
/// out the way ECMAScript does (`1e+21`, `1.5e-7`, `-0` is `0`).
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity" } else { "Infinity" }.into();
    }
    if x < 0.0 {
        return format!("-{}", js_number_to_string(-x));
    }
    // `{:e}` prints the shortest digits that round-trip: `d.ddde<exp>`.
    let sci = format!("{x:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        return format!("{digits}{}", "0".repeat((n - k) as usize));
    }
    if 0 < n && n <= 21 {
        return format!("{}.{}", &digits[..n as usize], &digits[n as usize..]);
    }
    if -6 < n && n <= 0 {
        return format!("0.{}{digits}", "0".repeat((-n) as usize));
    }
    let sign = if n - 1 < 0 { "-" } else { "+" };
    let e = (n - 1).abs();
    if k == 1 {
        format!("{digits}e{sign}{e}")
    } else {
        format!("{}.{}e{sign}{e}", &digits[..1], &digits[1..])
    }
}

/// JS `Number.prototype.toFixed`: the exact binary value rounded half up.
///
/// Rust's own `{:.N}` breaks exact ties to even (`2.5` gives `2`), JS to the
/// larger value (`"3"`), so the exact expansion is rounded by hand.
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return js_number_to_string(x);
    }
    let negative = x < 0.0;
    // A finite f64 has at most 1074 fractional digits, so this is exact.
    let exact = format!("{:.1074}", x.abs());
    let (int_part, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut all: Vec<u8> = int_part.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    let round_up = frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5');
    if round_up {
        let mut i = all.len();
        loop {
            if i == 0 {
                all.insert(0, 1);
                break;
            }
            i -= 1;
            if all[i] == 9 {
                all[i] = 0;
            } else {
                all[i] += 1;
                break;
            }
        }
    }
    let text: String = all.iter().map(|d| (d + b'0') as char).collect();
    let split = text.len() - digits;
    let body = if digits == 0 { text } else { format!("{}.{}", &text[..split], &text[split..]) };
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

// ---- localeCompare ----------------------------------------------------------------

/// The collator `String.prototype.localeCompare` uses: ICU for the host's
/// default locale (Bun reads it from the OS), tertiary strength, no
/// punctuation skipping. The locale matters for CJK: under `ja-JP` Han
/// characters follow the Japanese tailoring, not the root code point order.
fn collator() -> &'static icu_collator::CollatorBorrowed<'static> {
    use icu_collator::{Collator, CollatorPreferences};
    use icu_locale::Locale;
    use std::sync::OnceLock;

    static COLLATOR: OnceLock<icu_collator::CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR.get_or_init(|| {
        let host: Option<Locale> = sys_locale::get_locale().and_then(|name| name.parse().ok());
        let build = |locale: &Locale| {
            Collator::try_new(CollatorPreferences::from(locale), Default::default()).ok()
        };
        host.as_ref()
            .and_then(build)
            .or_else(|| build(&Locale::UNKNOWN))
            .expect("root collation data is compiled in")
    })
}

/// Whether the host locale is Japanese.
fn host_is_japanese() -> bool {
    use std::sync::OnceLock;
    static JA: OnceLock<bool> = OnceLock::new();
    *JA.get_or_init(|| sys_locale::get_locale().is_some_and(|name| name.starts_with("ja")))
}

/// Fold the distinctions the host's collation ignores at tertiary strength.
///
/// Measured against Bun on a ja-JP host: `あ`, `ア` and `ｱ` compare equal, as do
/// `test` and `ｔｅｓｔ`, while `a` < `A` still holds. The ICU data bundled here
/// ranks them apart, so under a Japanese locale width variants are folded
/// (NFKC) and katakana is mapped onto hiragana before comparing, leaving equal
/// strings equal and the stable sort in charge of the tie, as in JS.
fn fold_for_japanese(s: &str) -> String {
    use icu_normalizer::ComposingNormalizerBorrowed;
    ComposingNormalizerBorrowed::new_nfkc()
        .normalize(s)
        .chars()
        .map(|c| match c {
            '\u{30A1}'..='\u{30F6}' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
            _ => c,
        })
        .collect()
}

/// `a.localeCompare(b)`.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    if host_is_japanese() && !(a.is_ascii() && b.is_ascii()) {
        return collator().compare(&fold_for_japanese(a), &fold_for_japanese(b));
    }
    collator().compare(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_whitespace_differs_from_rust() {
        assert!(is_js_space('\u{FEFF}'));
        assert!(!is_js_space('\u{85}'));
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
    }

    #[test]
    fn crlf_split_matches_js() {
        assert_eq!(split_crlf("a\r\nb\nc\r"), vec!["a", "b", "c\r"]);
    }

    #[test]
    fn uri_round_trip() {
        assert_eq!(encode_uri_component("topics/a b"), "topics%2Fa%20b");
        assert_eq!(encode_uri("/a b/é.md"), "/a%20b/%C3%A9.md");
        assert_eq!(decode_uri_component("%E3%81%82"), Some("あ".to_string()));
        assert_eq!(decode_uri_component("%E3%81"), None);
        assert_eq!(decode_uri_component("100%"), None);
    }

    #[test]
    fn js_number_cases() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 7 "), 7.0);
        assert!(js_number("abc").is_nan());
        assert!(js_number("inf").is_nan());
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e3"), 1000.0);
    }

    #[test]
    fn locale_compare_ascii_identifiers() {
        assert_eq!(locale_compare("a-b", "ab"), Ordering::Less);
        assert_eq!(locale_compare("a1", "ab"), Ordering::Less);
        assert_eq!(locale_compare("a", "A"), Ordering::Less);
        assert_eq!(locale_compare("B", "a"), Ordering::Greater);
    }
}

#[cfg(test)]
mod number_tests {
    use super::*;

    #[test]
    fn number_to_string_follows_ecmascript() {
        for (x, want) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (f64::INFINITY, "Infinity"),
            (f64::NAN, "NaN"),
        ] {
            assert_eq!(js_number_to_string(x), want, "{x}");
        }
    }

    #[test]
    fn to_fixed_rounds_ties_up_on_the_exact_value() {
        assert_eq!(js_to_fixed(2.5, 0), "3");
        assert_eq!(js_to_fixed(1.005, 2), "1.00");
        assert_eq!(js_to_fixed(0.125, 2), "0.13");
        assert_eq!(js_to_fixed(9.995, 2), "9.99");
        assert_eq!(js_to_fixed(99.5, 0), "100");
        assert_eq!(js_to_fixed(-1.5, 0), "-2");
        assert_eq!(js_to_fixed(-0.001, 2), "-0.00");
        assert_eq!(js_to_fixed(0.0, 2), "0.00");
        assert_eq!(js_to_fixed(1234.5678, 1), "1234.6");
    }
}

#[cfg(test)]
mod locale_tests {
    use super::*;

    /// Input order of the sample sorted by Bun's `localeCompare` on a ja-JP host.
    const SAMPLE: [&str; 31] = [
        "あ", "ア", "ｱ", "亜", "阿", "日本", "日記", "にほん", "a", "A", "Z", "ー", "漢字", "かんじ", "_", "-",
        "1", "10", "2", "テスト", "てすと", "ｔｅｓｔ", "test", "é", "e", "ö", "ä", "ñ", "ß", "Ａ", "０",
    ];
    const BUN_JA_ORDER: [&str; 31] = [
        "_", "-", "ー", "０", "1", "10", "2", "a", "A", "Ａ", "ä", "e", "é", "ñ", "ö", "ß", "ｔｅｓｔ",
        "test", "Z", "あ", "ア", "ｱ", "かんじ", "テスト", "てすと", "にほん", "亜", "阿", "漢字", "日記",
        "日本",
    ];

    #[test]
    fn matches_bun_on_a_japanese_host() {
        if !host_is_japanese() {
            return; // the expected order is locale-specific
        }
        let mut sample: Vec<&str> = SAMPLE.to_vec();
        sample.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(sample, BUN_JA_ORDER);
    }
}
