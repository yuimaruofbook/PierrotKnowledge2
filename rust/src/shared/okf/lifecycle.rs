//! Lifecycle tags: `Product` and `DEAD` (`src/shared/okf/lifecycle.ts`).
//!
//! PARA says how current a note is; lifecycle says what kind of status it has.
//! A Product concept is finished, trusted output; a DEAD concept is retired
//! material that must stop showing up in an agent's context without being
//! deleted. Stored as ordinary frontmatter tags, matched case-sensitively
//! (only exactly `Product` and `DEAD` count, so a bundle's own `product` or
//! `dead` tag keeps its meaning) and written in the canonical spelling.

use crate::shared::js_compat::{js_trim, js_trim_start};
use crate::shared::okf::frontmatter::split_frontmatter;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Product,
    Dead,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Lifecycle::Product => "product",
            Lifecycle::Dead => "dead",
        }
    }

    /// The canonical tag written for this lifecycle.
    pub fn tag(self) -> &'static str {
        match self {
            Lifecycle::Product => "Product",
            Lifecycle::Dead => "DEAD",
        }
    }
}

/// `Lifecycle | "none"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleChoice {
    None,
    Set(Lifecycle),
}

impl LifecycleChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            LifecycleChoice::None => "none",
            LifecycleChoice::Set(l) => l.as_str(),
        }
    }
}

/// Ranking factor for a Product concept.
///
/// It multiplies the BM25 score like a PARA weight, but is deliberately
/// smaller than one PARA step (resource 1.0 to area 1.2): a nudge that settles
/// ties in favour of the finished page, never one that lets a Product note
/// outrank a clearly better match or jump a priority class.
pub const PRODUCT_WEIGHT: f64 = 1.1;

fn lifecycle_of_str(tag: &str) -> Option<Lifecycle> {
    match tag {
        "DEAD" => Some(Lifecycle::Dead),
        "Product" => Some(Lifecycle::Product),
        _ => None,
    }
}

fn lifecycle_of_value(tag: &Value) -> Option<Lifecycle> {
    tag.as_str().and_then(lifecycle_of_str)
}

fn choice_of(tags: impl IntoIterator<Item = Option<Lifecycle>>) -> LifecycleChoice {
    let mut found = LifecycleChoice::None;
    for lifecycle in tags {
        match lifecycle {
            Some(Lifecycle::Dead) => return LifecycleChoice::Set(Lifecycle::Dead),
            Some(Lifecycle::Product) => found = LifecycleChoice::Set(Lifecycle::Product),
            None => {}
        }
    }
    found
}

/// The lifecycle a list of string tags expresses.
///
/// A hand-edited concept can carry both tags; DEAD wins, because the cost of
/// wrongly hiding a note is a lookup with `include_dead`, while wrongly
/// surfacing retired material is silent.
pub fn lifecycle_of<S: AsRef<str>>(tags: &[S]) -> LifecycleChoice {
    choice_of(tags.iter().map(|t| lifecycle_of_str(t.as_ref())))
}

/// Same, over JSON values (non-strings never match).
pub fn lifecycle_of_values(tags: &[Value]) -> LifecycleChoice {
    choice_of(tags.iter().map(lifecycle_of_value))
}

/// Ranking multiplier for a tag list (1 unless Product).
pub fn lifecycle_weight<S: AsRef<str>>(tags: &[S]) -> f64 {
    if lifecycle_of(tags) == LifecycleChoice::Set(Lifecycle::Product) {
        PRODUCT_WEIGHT
    } else {
        1.0
    }
}

/// The tag list after setting a lifecycle.
///
/// Both lifecycle tags are removed first (a concept is never both), then the
/// canonical one is put back in the place the first matching tag held, so the
/// author's tag order is kept. Other tags (`product`, `dead`, non-strings) are
/// left exactly as they were.
pub fn with_lifecycle(tags: &[Value], to: LifecycleChoice) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut placed = false;

    for tag in tags {
        match lifecycle_of_value(tag) {
            None => out.push(tag.clone()),
            Some(found) => {
                if LifecycleChoice::Set(found) == to && !placed {
                    out.push(Value::String(found.tag().to_string()));
                    placed = true;
                }
            }
        }
    }

    if let LifecycleChoice::Set(lifecycle) = to {
        if !placed {
            out.push(Value::String(lifecycle.tag().to_string()));
        }
    }
    out
}

/// Parse an agent-supplied choice, tolerantly.
pub fn parse_lifecycle(value: &str) -> Option<LifecycleChoice> {
    match js_trim(value).to_ascii_lowercase().as_str() {
        "product" => Some(LifecycleChoice::Set(Lifecycle::Product)),
        "dead" => Some(LifecycleChoice::Set(Lifecycle::Dead)),
        "none" => Some(LifecycleChoice::None),
        _ => None,
    }
}

// ---- raw frontmatter edit ---------------------------------------------------

/// One element of the new tag list: an original item to keep, or new text.
enum Slot {
    Keep(usize),
    New(String),
}

/// Which original items survive in `with_lifecycle(current, to)`, in order.
///
/// A lifecycle tag already in the list keeps its own raw text (quotes and
/// all); only a tag that is new is written as the bare canonical spelling.
fn plan_slots(current: &[Value], to: LifecycleChoice) -> Vec<Slot> {
    let kept: Vec<usize> =
        (0..current.len()).filter(|&i| lifecycle_of_value(&current[i]).is_none()).collect();
    let mut used = vec![false; current.len()];
    let mut next = 0;
    let mut slots = Vec::new();
    for tag in with_lifecycle(current, to) {
        if lifecycle_of_value(&tag).is_none() {
            slots.push(Slot::Keep(kept[next]));
            next += 1;
            continue;
        }
        match (0..current.len()).find(|&i| current[i] == tag && !used[i]) {
            Some(at) => {
                used[at] = true;
                slots.push(Slot::Keep(at));
            }
            None => slots.push(Slot::New(tag.as_str().unwrap_or_default().to_string())),
        }
    }
    slots
}

/// `line.replace(/\r?\n$/, "")`
fn strip_eol(line: &str) -> &str {
    line.strip_suffix('\n').map_or(line, |l| l.strip_suffix('\r').unwrap_or(l))
}

fn is_flow_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}

/// `/^[ \t]*(?:#.*)?$/` on one line without its terminator.
fn is_blank_or_comment(line: &str) -> bool {
    let rest = line.trim_start_matches([' ', '\t']);
    rest.is_empty() || (rest.starts_with('#') && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
}

/// `/^(?:tags|"tags"|'tags')[ \t]*:/`
fn is_tags_key(line: &str) -> bool {
    ["tags", "\"tags\"", "'tags'"].iter().any(|key| {
        line.strip_prefix(key).is_some_and(|rest| rest.trim_start_matches([' ', '\t']).starts_with(':'))
    })
}

/// `/^([ \t]*)-(?:[ \t]|$)/`: the indent of a block-sequence item line.
fn block_item_indent(line: &str) -> Option<&str> {
    let rest = line.trim_start_matches([' ', '\t']);
    let indent = &line[..line.len() - rest.len()];
    let after = rest.strip_prefix('-')?;
    (after.is_empty() || after.starts_with([' ', '\t'])).then_some(indent)
}

/// Walk a flow sequence from its opening `[`, reporting where it closes and
/// its top-level items as written.
///
/// A quote only opens a string at the start of an item: an apostrophe inside
/// a plain scalar (`don't`) is just a character.
fn scan_flow(text: &str, open: usize) -> Option<(usize, Vec<String>)> {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut item_start = false;
    let mut from = open + 1;
    let mut items: Vec<String> = Vec::new();
    let mut it = text[open..].char_indices().map(|(i, c)| (open + i, c));
    while let Some((i, c)) = it.next() {
        if let Some(q) = quote {
            if q == '"' && c == '\\' {
                it.next();
            } else if c == q {
                quote = None;
            }
            continue;
        }
        if (c == '"' || c == '\'') && item_start {
            quote = Some(c);
            item_start = false;
        } else if c == '[' || c == '{' {
            depth += 1;
            item_start = true;
        } else if c == ']' || c == '}' {
            depth -= 1;
            if depth == 0 {
                let last = js_trim(&text[from..i]);
                if !last.is_empty() {
                    items.push(last.to_string());
                }
                return Some((i, items));
            }
        } else if c == ',' && depth == 1 {
            items.push(js_trim(&text[from..i]).to_string());
            from = i + 1;
            item_start = true;
        } else if !is_flow_space(c) {
            item_start = false;
        }
    }
    None
}

/// The file text with a lifecycle applied to its `tags` entry, and nothing
/// else touched.
///
/// Re-serialising the whole frontmatter would drop comments and change
/// quoting (`version: 1.10` becomes `1.1`). This edits only the lines of the
/// `tags` entry (flow `[a, b]`, block `- a`, or absent) and leaves every other
/// byte as written. `None` means the entry has a shape it cannot edit safely
/// (an alias, a comment inside a multi-line list, items it cannot count); the
/// caller refuses rather than guess.
///
/// `current` is the parsed tag list, used to check that the raw items counted
/// here are the ones the YAML parser saw.
pub fn set_lifecycle_in_document(raw: &str, current: &[Value], to: LifecycleChoice) -> Option<String> {
    let bom = if raw.starts_with('\u{FEFF}') { '\u{FEFF}'.len_utf8() } else { 0 };
    let after_bom = &raw[bom..];
    let fence_len = {
        let rest = after_bom.strip_prefix("---")?;
        let trimmed = rest.trim_start_matches([' ', '\t']);
        let nl = trimmed
            .strip_prefix("\r\n")
            .map(|_| 2)
            .or_else(|| trimmed.strip_prefix('\n').map(|_| 1))?;
        after_bom.len() - trimmed.len() + nl
    };
    let split = split_frontmatter(raw);
    let yaml = split.yaml?;
    let start = bom + fence_len;

    let edited = edit_tags_yaml(&yaml, split.eol.as_str(), current, to)?;
    Some(format!("{}{}{}", &raw[..start], edited, &raw[start + yaml.len()..]))
}

fn edit_tags_yaml(yaml: &str, eol: &str, current: &[Value], to: LifecycleChoice) -> Option<String> {
    let slots = plan_slots(current, to);
    let mut lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    if lines.is_empty() {
        lines.push("");
    }
    let flow_of = |items: &[String]| format!("[{}]", items.join(", "));
    let new_texts = |slots: &[Slot]| -> Vec<String> {
        slots
            .iter()
            .map(|s| match s {
                Slot::New(text) => text.clone(),
                Slot::Keep(_) => String::new(),
            })
            .collect()
    };
    let ends_with_newline = lines[lines.len() - 1].ends_with('\n');

    // Replace lines [from, until) with `text` (no final newline); "" deletes them.
    let splice = |from: usize, until: usize, text: &str| -> String {
        let at_eof = until >= lines.len() && !ends_with_newline;
        let mut out = lines[..from].concat();
        if !text.is_empty() {
            out.push_str(text);
            if !at_eof {
                out.push_str(eol);
            }
        } else if at_eof {
            out = strip_eol(&out).to_string();
        }
        out + &lines[until.min(lines.len())..].concat()
    };

    let Some(key_at) = lines.iter().position(|l| is_tags_key(l)) else {
        if slots.is_empty() {
            return Some(yaml.to_string());
        }
        let sep = if ends_with_newline { "" } else { eol };
        return Some(format!("{yaml}{sep}tags: {}", flow_of(&new_texts(&slots))));
    };

    let key_line = strip_eol(lines[key_at]);
    let colon = key_line.find(':')?;
    let rest = &key_line[colon + 1..];
    let value = js_trim_start(rest);
    let value_at = colon + 1 + (rest.len() - value.len());
    let line_offset: usize = lines[..key_at].iter().map(|l| l.len()).sum();

    if value.starts_with('[') {
        let open = line_offset + value_at;
        let (close, flow_items) = scan_flow(yaml, open)?;

        let mut end = key_at;
        let mut end_start = line_offset;
        while end_start + lines[end].len() <= close {
            end_start += lines[end].len();
            end += 1;
        }
        let suffix = &strip_eol(lines[end])[close - end_start + 1..];
        if !is_blank_or_comment(suffix) {
            return None;
        }

        let inner = &yaml[open + 1..close];
        if inner.contains('\n') && inner.contains('#') {
            return None;
        }
        if flow_items.len() != current.len() {
            return None;
        }
        if slots.is_empty() {
            return Some(splice(key_at, end + 1, ""));
        }
        let items: Vec<String> = slots
            .iter()
            .map(|s| match s {
                Slot::Keep(i) => flow_items[*i].clone(),
                Slot::New(text) => text.clone(),
            })
            .collect();
        let text = format!("{}{}{suffix}", &key_line[..value_at], flow_of(&items));
        return Some(splice(key_at, end + 1, &text));
    }

    let comment_at = value
        .char_indices()
        .find(|&(i, c)| c == '#' && (i == 0 || matches!(value.as_bytes()[i - 1], b' ' | b'\t')))
        .map(|(i, _)| i.saturating_sub(1));
    let bare = js_trim(comment_at.map_or(value, |at| &value[..at]));
    if !bare.is_empty() && bare != "~" && bare != "null" {
        return None;
    }
    let comment = comment_at.map_or(String::new(), |at| format!(" {}", js_trim_start(&value[at..])));

    // Block items follow only when the value itself is empty.
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut indent = "";
    let mut last_body = key_at;
    if bare.is_empty() {
        for (i, line) in lines.iter().enumerate().skip(key_at + 1) {
            let text = strip_eol(line);
            if is_blank_or_comment(text) {
                continue;
            }
            match block_item_indent(text) {
                Some(item_indent) if groups.is_empty() || item_indent == indent => {
                    if groups.is_empty() {
                        indent = item_indent;
                    }
                    groups.push((i, i + 1));
                }
                _ if groups.is_empty() || text.len() - js_trim_start(text).len() <= indent.len() => break,
                _ => {}
            }
            last_body = i;
        }
    }
    // Comments between two items stay with the item above them.
    for i in 0..groups.len() {
        groups[i].1 = if i + 1 < groups.len() { groups[i + 1].0 } else { last_body + 1 };
    }

    if groups.len() != current.len() {
        return None;
    }
    if groups.is_empty() {
        if slots.is_empty() {
            return Some(yaml.to_string());
        }
        let text = format!("{} {}{comment}", &key_line[..colon + 1], flow_of(&new_texts(&slots)));
        return Some(splice(key_at, key_at + 1, &text));
    }
    if slots.is_empty() {
        return Some(splice(key_at, last_body + 1, ""));
    }

    let mut block = String::new();
    for slot in &slots {
        match slot {
            Slot::New(text) => block.push_str(&format!("{indent}- {text}{eol}")),
            Slot::Keep(i) => {
                for line in &lines[groups[*i].0..groups[*i].1] {
                    block.push_str(line);
                    if !line.ends_with('\n') {
                        block.push_str(eol);
                    }
                }
            }
        }
    }
    Some(splice(key_at + 1, last_body + 1, strip_eol(&block)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vals(items: &[Value]) -> Vec<Value> {
        items.to_vec()
    }

    #[test]
    fn only_the_exact_tags_count_and_dead_beats_product() {
        let set = |l| LifecycleChoice::Set(l);
        assert_eq!(lifecycle_of(&["x", "Product"]), set(Lifecycle::Product));
        assert_eq!(lifecycle_of(&["DEAD"]), set(Lifecycle::Dead));
        assert_eq!(lifecycle_of(&["Product", "DEAD"]), set(Lifecycle::Dead));
        // A bundle may already use these spellings for something else.
        assert_eq!(lifecycle_of(&["product", "Dead", "PRODUCT", "dead"]), LifecycleChoice::None);
        assert_eq!(lifecycle_weight(&["product"]), 1.0);
        assert_eq!(lifecycle_of(&["other"]), LifecycleChoice::None);
        assert_eq!(lifecycle_of::<&str>(&[]), LifecycleChoice::None);
        assert_eq!(
            lifecycle_of_values(&[json!("other"), json!(5), Value::Null]),
            LifecycleChoice::None
        );
    }

    #[test]
    fn setting_one_removes_the_other_with_the_canonical_spelling() {
        let product = LifecycleChoice::Set(Lifecycle::Product);
        let dead = LifecycleChoice::Set(Lifecycle::Dead);
        assert_eq!(
            with_lifecycle(&vals(&[json!("a"), json!("DEAD"), json!("b")]), product),
            vals(&[json!("a"), json!("b"), json!("Product")])
        );
        assert_eq!(
            with_lifecycle(&vals(&[json!("a"), json!("Product"), json!("b")]), product),
            vals(&[json!("a"), json!("Product"), json!("b")])
        );
        assert_eq!(
            with_lifecycle(&vals(&[json!("Product"), json!("DEAD"), json!("x")]), dead),
            vals(&[json!("DEAD"), json!("x")])
        );
        assert_eq!(
            with_lifecycle(
                &vals(&[json!("DEAD"), json!("Product"), json!("DEAD")]),
                LifecycleChoice::None
            ),
            Vec::<Value>::new()
        );
        // Only the canonical spelling is removed; the author's own tags stay.
        assert_eq!(
            with_lifecycle(&vals(&[json!("dead"), json!("product"), json!("DEAD")]), product),
            vals(&[json!("dead"), json!("product"), json!("Product")])
        );
        assert_eq!(
            with_lifecycle(&vals(&[json!("dead")]), LifecycleChoice::None),
            vals(&[json!("dead")])
        );
        assert_eq!(
            with_lifecycle(&vals(&[json!("a"), json!(7)]), dead),
            vals(&[json!("a"), json!(7), json!("DEAD")])
        );
    }

    #[test]
    fn product_is_a_nudge_smaller_than_one_para_step() {
        assert_eq!(lifecycle_weight(&["Product"]), PRODUCT_WEIGHT);
        assert_eq!(lifecycle_weight(&["x"]), 1.0);
        const { assert!(PRODUCT_WEIGHT > 1.0 && PRODUCT_WEIGHT < 1.2) };
    }

    #[test]
    fn parse_is_tolerant() {
        assert_eq!(parse_lifecycle(" Product "), Some(LifecycleChoice::Set(Lifecycle::Product)));
        assert_eq!(parse_lifecycle("DEAD"), Some(LifecycleChoice::Set(Lifecycle::Dead)));
        assert_eq!(parse_lifecycle("none"), Some(LifecycleChoice::None));
        assert_eq!(parse_lifecycle("alive"), None);
        assert_eq!(LifecycleChoice::Set(Lifecycle::Dead).as_str(), "dead");
    }
}
