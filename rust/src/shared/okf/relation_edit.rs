//! Keeping typed relations pointing at a concept that moves
//! (`src/shared/okf/relation-edit.ts`).
//!
//! `relations:` lives in the frontmatter, where the YAML is the author's: key
//! order, quoting, comments and indentation all stay as written. So this edits
//! only the text of the relation entries that must change, in place, and
//! refuses (reports the entry) when it cannot be sure it found the right text.
//! The TS file documents the shapes it reads; this makes the same edits.

use crate::shared::js_compat::{js_trim, js_trim_end};
use crate::shared::okf::frontmatter::split_frontmatter;
use crate::shared::okf::graph_schema::normalize_relation_target;
use crate::shared::okf::links::resolve_link_target;
use crate::shared::okf::rename::relative_id_path;
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// A scalar's text in the frontmatter source.
#[derive(Debug, Clone)]
struct Token {
    start: usize,
    end: usize,
    /// `"`, `'`, or `\0` for an unquoted scalar.
    quote: char,
    /// The scalar as the YAML parser reads it.
    value: String,
    flow: bool,
}

/// An entry of a list. `None`: present, but not a scalar this editor can place.
type Item = Option<Token>;

#[derive(Debug, Clone, Default)]
pub struct RelationEditResult {
    pub raw: String,
    /// Entries rewritten.
    pub count: usize,
    /// Entries that needed a rewrite and could not be edited safely: `(kind, target)`.
    pub unsafe_entries: Vec<(String, String)>,
}

fn is_blank(c: char) -> bool {
    c == ' ' || c == '\t'
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

static COMMENT_TAIL: LazyLock<Regex> = LazyLock::new(|| re(r"^[ \t]+#"));
static KEY_DQ: LazyLock<Regex> = LazyLock::new(|| re(r#"^[ \t]*"([^"\\]*)"[ \t]*:(?:[ \t]+(.*))?$"#));
static KEY_SQ: LazyLock<Regex> = LazyLock::new(|| re(r"^[ \t]*'([^']*)'[ \t]*:(?:[ \t]+(.*))?$"));
static KEY_PLAIN: LazyLock<Regex> =
    LazyLock::new(|| re(r#"^[ \t]*([^\s"'#\-?:\[\]{},&*!|>%@`][^:]*?)[ \t]*:(?:[ \t]+(.*))?$"#));
static ITEM_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^[ \t]*-(?:[ \t]|$)"));
static SKIPPABLE: LazyLock<Regex> = LazyLock::new(|| re(r"^[ \t]*(?:#.*)?$"));

fn skippable(t: &str) -> bool {
    SKIPPABLE.is_match(t)
}

fn indent_of(t: &str) -> usize {
    t.len() - t.trim_start_matches(is_blank).len()
}

fn first_comment(s: &str) -> Option<usize> {
    [s.find(" #"), s.find("\t#")].into_iter().flatten().min()
}

/// The scalar at the start of `text` (leading blanks skipped), or `None` if it is not a plain/quoted one.
fn scalar_token(text: &str, base: usize, flow: bool) -> Option<Token> {
    let s = text.trim_start_matches(is_blank);
    let at = base + (text.len() - s.len());
    let q = s.chars().next()?;
    if q == '"' || q == '\'' {
        let mut value = String::new();
        let mut chars = s.char_indices().skip(1).peekable();
        let mut close = None;
        while let Some((i, c)) = chars.next() {
            if q == '"' {
                if c == '\\' {
                    match chars.next() {
                        Some((_, n)) if n == '\\' || n == '"' => value.push(n),
                        _ => return None,
                    }
                    continue;
                }
                if c == '"' {
                    close = Some(i);
                    break;
                }
            } else if c == '\'' {
                if let Some(&(_, '\'')) = chars.peek() {
                    chars.next();
                    value.push('\'');
                    continue;
                }
                close = Some(i);
                break;
            }
            value.push(c);
        }
        let i = close?;
        let rest = &s[i + 1..];
        let tail = if flow {
            js_trim(rest).is_empty()
        } else {
            js_trim(rest).is_empty() || COMMENT_TAIL.is_match(rest)
        };
        return tail.then(|| Token { start: at, end: at + i + 1, quote: q, value, flow });
    }
    if "&*!|>%@`[]{}#,".contains(q) {
        return None;
    }
    let mut plain = s;
    if !flow {
        if let Some(hash) = first_comment(s) {
            plain = &s[..hash];
        }
    }
    let plain = js_trim_end(plain);
    if plain.is_empty() || plain.contains(": ") || plain.ends_with(':') {
        return None;
    }
    if flow && plain.contains([',', '[', ']', '{', '}']) {
        return None;
    }
    Some(Token { start: at, end: at + plain.len(), quote: '\0', value: plain.to_string(), flow })
}

/// A single-line `[a, "b"]` starting at `text`'s first non-blank: its items, or `None` when it is not editable.
fn flow_items(text: &str, base: usize) -> Option<Vec<Item>> {
    let s = text.trim_start_matches(is_blank);
    let lead = text.len() - s.len();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut close = None;
    let mut cuts: Vec<usize> = Vec::new();
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        if let Some(q) = quote {
            if q == '"' && c == '\\' {
                chars.next();
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '[' | '{' => depth += 1,
            ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            ',' if depth == 1 => cuts.push(i),
            _ => {}
        }
    }
    let close = close?;
    let tail = &s[close + 1..];
    if !js_trim(tail).is_empty() && !COMMENT_TAIL.is_match(tail) {
        return None;
    }
    if js_trim(&s[1..close]).is_empty() {
        return Some(Vec::new());
    }

    let mut bounds = vec![0usize];
    bounds.extend(cuts);
    bounds.push(close);
    let mut items: Vec<Item> = Vec::new();
    for k in 0..bounds.len() - 1 {
        let from = bounds[k] + 1;
        let piece = &s[from..bounds[k + 1]];
        if js_trim(piece).is_empty() {
            // A trailing comma is allowed; an empty slot elsewhere is not a list this reads.
            if k + 2 == bounds.len() && k > 0 {
                continue;
            }
            return None;
        }
        items.push(scalar_token(piece, base + lead + from, true));
    }
    Some(items)
}

struct Line<'a> {
    text: &'a str,
    start: usize,
}

struct Current {
    name: String,
    block: bool,
    seq_indent: Option<usize>,
}

/// Every kind under the top-level `relations:` key, with the text of its entries. `None` when it cannot be read at all.
fn scan_relations(yaml: &str) -> Option<HashMap<String, Option<Vec<Item>>>> {
    let mut lines: Vec<Line> = Vec::new();
    let mut pos = 0;
    for piece in yaml.split_inclusive('\n') {
        let text = piece.strip_suffix('\n').unwrap_or(piece);
        let text = text.strip_suffix('\r').unwrap_or(text);
        lines.push(Line { text, start: pos });
        pos += piece.len();
    }

    let key_at = lines.iter().position(|l| {
        l.text
            .strip_prefix("relations")
            .is_some_and(|rest| rest.trim_start_matches(is_blank).starts_with(':'))
    })?;
    let key_text = lines[key_at].text;
    if !skippable(&key_text[key_text.find(':')? + 1..]) {
        return None;
    }

    let mut block: Vec<&Line> = Vec::new();
    for l in &lines[key_at + 1..] {
        if !skippable(l.text) && !l.text.starts_with(is_blank) {
            break;
        }
        block.push(l);
    }
    if block.iter().any(|l| !skippable(l.text) && l.text[..indent_of(l.text)].contains('\t')) {
        return None;
    }
    let mut out: HashMap<String, Option<Vec<Item>>> = HashMap::new();
    let Some(first) = block.iter().find(|l| !skippable(l.text)) else {
        return Some(out);
    };
    let kind_indent = indent_of(first.text);

    let mut current: Option<Current> = None;
    for line in block {
        if skippable(line.text) {
            continue;
        }
        let ind = indent_of(line.text);
        if ind < kind_indent {
            return None;
        }
        let is_item = ITEM_LINE.is_match(line.text);

        if ind == kind_indent && !is_item {
            current = None;
            let Some(m) = KEY_DQ
                .captures(line.text)
                .or_else(|| KEY_SQ.captures(line.text))
                .or_else(|| KEY_PLAIN.captures(line.text))
            else {
                continue;
            };
            let name = m[1].to_string();
            let rest = m.get(2).map_or("", |r| r.as_str());
            let rest_at = line.start + line.text.len() - rest.len();
            let mut cur = Current { name: name.clone(), block: false, seq_indent: None };
            let trimmed = rest.trim_start_matches(is_blank);
            let items = if js_trim(rest).is_empty() || trimmed.starts_with('#') {
                cur.block = true;
                Some(Vec::new())
            } else if trimmed.starts_with('[') {
                flow_items(rest, rest_at)
            } else {
                scalar_token(rest, rest_at, false).map(|t| vec![Some(t)])
            };
            out.insert(name, items);
            current = Some(cur);
            continue;
        }

        let Some(cur) = current.as_mut() else { continue };
        if out.get(&cur.name).is_none_or(Option::is_none) {
            continue;
        }
        if !cur.block || !is_item {
            out.insert(cur.name.clone(), None);
            continue;
        }
        match cur.seq_indent {
            None => cur.seq_indent = Some(ind),
            Some(seq) if seq != ind => {
                out.insert(cur.name.clone(), None);
                continue;
            }
            Some(_) => {}
        }
        let dash = line.text.find('-').unwrap_or(0);
        let value_text = &line.text[dash + 1..];
        let item = if js_trim(value_text).is_empty() {
            None
        } else {
            scalar_token(value_text, line.start + dash + 1, false)
        };
        if let Some(Some(items)) = out.get_mut(&cur.name) {
            items.push(item);
        }
    }
    Some(out)
}

/// Can `text` stand as an unquoted scalar where `flow` says it will be?
fn plain_safe(text: &str, flow: bool) -> bool {
    let Some(first) = text.chars().next() else { return false };
    if text != js_trim(text) {
        return false;
    }
    if "-?:,[]{}#&*!|>'\"%@`".contains(first) {
        return false;
    }
    if text.contains(": ") || text.contains(" #") || text.ends_with(':') {
        return false;
    }
    if flow && text.contains([',', '[', ']', '{', '}']) {
        return false;
    }
    !text.contains(['\n', '\r'])
}

fn encode(token: &Token, text: &str) -> Option<String> {
    if text.contains(['\n', '\r']) {
        return None;
    }
    match token.quote {
        '"' => Some(format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))),
        '\'' => Some(format!("'{}'", text.replace('\'', "''"))),
        _ => plain_safe(text, token.flow).then(|| text.to_string()),
    }
}

/// What `decide` answers for one entry.
pub enum Decision {
    /// Leave it.
    Keep,
    /// Needs changing, but cannot be written.
    Unsafe,
    /// The new text of the entry.
    To(String),
}

/// Apply `decide` to every string entry of `relations` (the parsed value) and
/// rewrite those it answers for.
pub fn edit_relation_entries(raw: &str, relations: Option<&Value>, decide: impl Fn(&str) -> Decision) -> RelationEditResult {
    let mut result = RelationEditResult { raw: raw.to_string(), count: 0, unsafe_entries: Vec::new() };
    let Some(Value::Object(map)) = relations else { return result };

    struct Wanted {
        name: String,
        kind: String,
        index: usize,
        length: usize,
        entry: String,
        to: Option<String>,
    }
    let mut wanted: Vec<Wanted> = Vec::new();
    for (name, entries) in map {
        let list: Vec<&Value> = match entries {
            Value::String(_) => vec![entries],
            Value::Array(a) => a.iter().collect(),
            _ => continue,
        };
        let length = list.len();
        for (index, entry) in list.into_iter().enumerate() {
            let Value::String(entry) = entry else { continue };
            let to = match decide(entry) {
                Decision::Keep => continue,
                Decision::Unsafe => None,
                Decision::To(text) => Some(text),
            };
            wanted.push(Wanted { name: name.clone(), kind: js_trim(name).to_string(), index, length, entry: entry.clone(), to });
        }
    }
    if wanted.is_empty() {
        return result;
    }

    let bom = if raw.starts_with('\u{FEFF}') { '\u{FEFF}'.len_utf8() } else { 0 };
    let after_bom = &raw[bom..];
    let fence_len = after_bom.strip_prefix("---").and_then(|rest| {
        let trimmed = rest.trim_start_matches([' ', '\t']);
        let nl = trimmed
            .strip_prefix("\r\n")
            .map(|_| 2)
            .or_else(|| trimmed.strip_prefix('\n').map(|_| 1))?;
        Some(after_bom.len() - trimmed.len() + nl)
    });
    let yaml = split_frontmatter(raw).yaml;
    let scan = match (&fence_len, &yaml) {
        (Some(_), Some(yaml)) => scan_relations(yaml),
        _ => None,
    };
    let origin = bom + fence_len.unwrap_or(0);

    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for w in &wanted {
        let token = scan
            .as_ref()
            .and_then(|s| s.get(&w.name))
            .and_then(|items| items.as_ref())
            .filter(|items| items.len() == w.length)
            .and_then(|items| items[w.index].as_ref());
        let text = match (token, &w.to) {
            (Some(t), Some(to)) if t.value == w.entry => encode(t, to).map(|text| (t.start, t.end, text)),
            _ => None,
        };
        match text {
            Some((start, end, text)) => edits.push((origin + start, origin + end, text)),
            None => result.unsafe_entries.push((w.kind.clone(), w.entry.clone())),
        }
    }

    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut next = raw.to_string();
    for (start, end, text) in &edits {
        next.replace_range(*start..*end, text);
    }
    result.raw = next;
    result.count = edits.len();
    result
}

/// An entry rewritten to name `new_id`, in the form it was written in; `None` when it has no form this knows.
fn retarget(entry: &str, from_id: &str, new_id: &str, wiki_dir: &str) -> Option<String> {
    let core = js_trim(entry);
    let lead_len = entry.find(core).unwrap_or(0);
    let lead = &entry[..lead_len];
    let trail = &entry[lead_len + core.len()..];

    if core.starts_with("[[") && core.ends_with("]]") && core.len() >= 4 {
        let inner = &core[2..core.len() - 2];
        // `([^|#]*)(#[^|]*)?(\|.*)?`: target, then an optional fragment, then an optional label.
        let target_end = inner.find(['|', '#']).unwrap_or(inner.len());
        let rest = &inner[target_end..];
        let (fragment, label) = if rest.starts_with('#') {
            match rest.find('|') {
                Some(bar) => (&rest[..bar], &rest[bar..]),
                None => (rest, ""),
            }
        } else {
            ("", rest)
        };
        return Some(format!("{lead}[[{new_id}{fragment}{label}]]{trail}"));
    }
    if core.contains(['|', '\\']) {
        return None;
    }
    let (path, fragment) = match core.find('#') {
        Some(hash) => (&core[..hash], &core[hash..]),
        None => (core, ""),
    };
    let lower = path.to_ascii_lowercase();
    let ext = if lower.ends_with(".markdown") {
        &path[path.len() - ".markdown".len()..]
    } else if lower.ends_with(".md") {
        &path[path.len() - ".md".len()..]
    } else {
        ""
    };
    let head = if !wiki_dir.is_empty() && path.starts_with(&format!("{wiki_dir}/")) {
        format!("{wiki_dir}/{new_id}")
    } else if path.starts_with('/') {
        format!("/{new_id}")
    } else if path.starts_with("./") || path.starts_with("../") {
        relative_id_path(from_id, new_id)
    } else {
        new_id.to_string()
    };
    Some(format!("{lead}{head}{ext}{fragment}{trail}"))
}

fn resolves_to(entry: &str, wiki_dir: &str, from_id: &str, known: &HashSet<String>, want: &str) -> bool {
    normalize_relation_target(entry, wiki_dir)
        .and_then(|check| resolve_link_target(&check, from_id, Some(known)))
        .as_deref()
        == Some(want)
}

/// `relations` entries of the document `from_id` that point at `old_id`,
/// rewritten to `new_id`. `known_ids` is the id set before the move, which is
/// what made each entry resolve the way it does. A rewrite is kept only if it
/// resolves to `new_id` afterwards.
pub fn relations_after_move(
    raw: &str,
    relations: Option<&Value>,
    from_id: &str,
    old_id: &str,
    new_id: &str,
    known_ids: &HashSet<String>,
    wiki_dir: &str,
) -> RelationEditResult {
    let mut after = known_ids.clone();
    after.remove(old_id);
    after.insert(new_id.to_string());
    edit_relation_entries(raw, relations, |entry| {
        let Some(target) = normalize_relation_target(entry, wiki_dir) else { return Decision::Keep };
        if resolve_link_target(&target, from_id, Some(known_ids)).as_deref() != Some(old_id) {
            return Decision::Keep;
        }
        match retarget(entry, from_id, new_id, wiki_dir) {
            Some(next) if resolves_to(&next, wiki_dir, from_id, &after, new_id) => Decision::To(next),
            _ => Decision::Unsafe,
        }
    })
}

/// The moved document's own `relations`: an entry written relative to its old
/// folder (or pointing at itself) is rewritten if it would resolve elsewhere
/// from the new one.
pub fn rebase_own_relations(
    raw: &str,
    relations: Option<&Value>,
    old_id: &str,
    new_id: &str,
    known_ids: &HashSet<String>,
    wiki_dir: &str,
) -> RelationEditResult {
    let mut after = known_ids.clone();
    after.remove(old_id);
    after.insert(new_id.to_string());
    edit_relation_entries(raw, relations, |entry| {
        let Some(target) = normalize_relation_target(entry, wiki_dir) else { return Decision::Keep };
        let Some(before) = resolve_link_target(&target, old_id, Some(known_ids)) else { return Decision::Keep };
        let want = if before == old_id { new_id.to_string() } else { before };
        if resolve_link_target(&target, new_id, Some(&after)).as_deref() == Some(want.as_str()) {
            return Decision::Keep;
        }
        match retarget(entry, new_id, &want, wiki_dir) {
            Some(next) if resolves_to(&next, wiki_dir, new_id, &after, &want) => Decision::To(next),
            _ => Decision::Unsafe,
        }
    })
}
