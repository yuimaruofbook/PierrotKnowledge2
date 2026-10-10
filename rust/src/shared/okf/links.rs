//! Link extraction and resolution (`src/shared/okf/links.ts`).
//!
//! OKF expresses relations as standard Markdown links; wiki-style `[[id]]` is
//! supported on top because it is what note-takers actually type. Both resolve
//! to the same concept-id space, so the graph is uniform.
//!
//! Offsets returned by regexes over the masked text are **byte offsets**, and
//! [`mask_code`] preserves byte length, so they apply directly to the original.

use super::concept::concept_id_from_rel_path;
use crate::shared::js_compat::{
    decode_uri_component, encode_uri_component, ends_with_ascii_ci, js_regex, js_trim,
};
use crate::shared::types::{ConceptLink, LinkKind};
use fancy_regex::RegexBuilder;
use regex::Regex;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

static FENCE_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]*(`{3,}|~{3,})").unwrap());

/// `/(`+)(?:[^`]|(?!\1)`)*\1/g`: needs a backreference and a lookahead, which
/// the `regex` crate cannot do. The backtrack limit is raised so pathological
/// lines behave as in JS (slow) rather than erroring out.
static INLINE_CODE_RE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    RegexBuilder::new(r"(`+)(?:[^`]|(?!\1)`)*\1")
        .backtrack_limit(usize::MAX)
        .build()
        .unwrap()
});

pub(crate) static WIKILINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[\[([^\[\]|#]+)(?:#([^\[\]|]*))?(?:\|([^\[\]]*))?\]\]").unwrap()
});

pub(crate) static MDLINK_RE: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r#"(!?)\[([^\]]*)\]\(<S>*<?([^)<><WS>]+)>?(?:<S>+"[^"]*")?<S>*\)"#));

/// Replace every character of `s` (but never `\n`) with spaces of the same
/// UTF-8 length, so byte offsets stay aligned with the source.
fn blank(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c == '\n' {
                "\n".to_string()
            } else {
                " ".repeat(c.len_utf8())
            }
        })
        .collect()
}

/// A source text together with its code-masked copy.
///
/// Regexes run on the mask and edits apply to the original by byte offset. Text
/// *captured* from the mask (labels, targets) is later written back out by the
/// TS, so [`Masked::group`] reproduces what the TS would see there: a blanked
/// character reads as one space per UTF-16 unit, not per UTF-8 byte.
pub(crate) struct Masked<'a> {
    orig: &'a str,
    pub(crate) text: String,
}

impl<'a> Masked<'a> {
    pub(crate) fn new(orig: &'a str) -> Self {
        Self {
            orig,
            text: mask_code(orig),
        }
    }

    /// Capture group `index` as the TS sees it (empty when the group is absent).
    pub(crate) fn group(&self, caps: &regex::Captures<'_>, index: usize) -> String {
        let Some(m) = caps.get(index) else {
            return String::new();
        };
        let mut out = String::with_capacity(m.as_str().len());
        for (offset, c) in self.orig[m.start()..m.end()].char_indices() {
            let at = m.start() + offset;
            let len = c.len_utf8();
            if self.text.as_bytes()[at..at + len] == self.orig.as_bytes()[at..at + len] {
                out.push(c);
            } else {
                out.push_str(&" ".repeat(c.len_utf16()));
            }
        }
        out
    }
}

/// Blank out code spans and fenced blocks, replacing them with spaces so every
/// offset and line number in the result still lines up with the source.
/// Callers match against the mask and edit the original by offset.
///
/// Without this, every fenced example containing `[[foo]]` would pollute the
/// link graph, and a rename would rewrite links inside code samples.
///
/// Scanned line by line: fences are a line-oriented construct. (The TS blanks
/// per UTF-16 unit; this blanks per UTF-8 byte so byte offsets line up. Only the
/// number of spaces differs, which no match can observe.)
pub fn mask_code(body: &str) -> String {
    // The opening fence marker while inside a block, else `None`.
    let mut fence: Option<String> = None;
    let mut masked: Vec<String> = Vec::new();

    for line in body.split('\n') {
        let marker = FENCE_OPEN_RE.captures(line).map(|c| c[1].to_string());

        match &fence {
            None => {
                if let Some(marker) = marker {
                    fence = Some(marker);
                    masked.push(blank(line));
                } else {
                    masked.push(mask_inline_code(line));
                }
            }
            Some(open) => {
                // A closing fence must use the same character and be at least as long.
                if let Some(marker) = marker {
                    if marker.as_bytes()[0] == open.as_bytes()[0] && marker.len() >= open.len() {
                        fence = None;
                    }
                }
                masked.push(blank(line));
            }
        }
    }

    masked.join("\n")
}

fn mask_inline_code(line: &str) -> String {
    if !line.contains('`') {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len());
    let mut last = 0;
    for m in INLINE_CODE_RE.find_iter(line) {
        // A backtracking-limit error ends masking for the rest of the line.
        let Ok(m) = m else { break };
        out.push_str(&line[last..m.start()]);
        out.push_str(&blank(m.as_str()));
        last = m.end();
    }
    out.push_str(&line[last..]);
    out
}

/// `/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i` or a leading `#`: a URL, `mailto:` etc.
pub fn is_external_target(target: &str) -> bool {
    if target.starts_with("//") || target.starts_with('#') {
        return true;
    }
    let mut chars = target.char_indices();
    match chars.next() {
        Some((_, c)) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for (_, c) in chars {
        if c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-') {
            continue;
        }
        return c == ':';
    }
    false
}

/// Normalise a POSIX-ish path, resolving `.` and `..` segments.
fn normalize_segments(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            out.pop();
        } else {
            out.push(segment);
        }
    }
    out.join("/")
}

fn strip_fragment(target: &str) -> &str {
    let before_hash = target.split('#').next().unwrap_or("");
    before_hash.split('?').next().unwrap_or("")
}

fn decode(target: &str) -> String {
    decode_uri_component(target).unwrap_or_else(|| target.to_string())
}

/// `/\.[a-z0-9]+$/i`: ends in a dot followed by a non-empty ASCII alnum run.
fn has_extension(path: &str) -> bool {
    match path.rsplit_once('.') {
        Some((_, ext)) => !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric()),
        None => false,
    }
}

/// Resolve a link target to a concept id (OKF §6).
///
/// The spec defines two forms: **absolute**, beginning with `/` and interpreted
/// from the bundle root, and **relative**, an ordinary Markdown path. The form
/// written decides how it resolves; a leading `/` is not a hint to be weighed
/// against alternatives.
///
/// A bare wiki-style `[[name]]` is neither form, so it falls back to a *unique*
/// basename match anywhere in the bundle. Ambiguous names stay unresolved.
///
/// Broken links are not an error: §6 requires consumers to tolerate a target
/// that does not exist, since it may simply be knowledge not yet written.
pub fn resolve_link_target(
    target: &str,
    from_id: &str,
    known_ids: Option<&HashSet<String>>,
) -> Option<String> {
    let raw = js_trim(strip_fragment(target));
    if raw.is_empty() || is_external_target(target) {
        return None;
    }

    let cleaned = decode(raw).replace('\\', "/");
    if !(ends_with_ascii_ci(&cleaned, ".md") || ends_with_ascii_ci(&cleaned, ".markdown"))
        && has_extension(&cleaned)
    {
        // A link to a non-Markdown asset is a valid relation but not a concept.
        return None;
    }

    let without_ext = concept_id_from_rel_path(&cleaned);

    if cleaned.starts_with('/') {
        let absolute = normalize_segments(without_ext.strip_prefix('/').unwrap_or(&without_ext));
        return match known_ids {
            None => Some(absolute),
            Some(ids) => ids.contains(&absolute).then_some(absolute),
        };
    }

    let from_dir = match from_id.rfind('/') {
        Some(i) => &from_id[..i],
        None => "",
    };
    let relative = normalize_segments(&if from_dir.is_empty() {
        without_ext.clone()
    } else {
        format!("{from_dir}/{without_ext}")
    });

    let Some(ids) = known_ids else {
        return Some(relative);
    };
    if ids.contains(&relative) {
        return Some(relative);
    }

    // Explicitly relative paths (`./x`, `../x`) mean what they say; only a bare
    // name may be a wikilink searching the whole bundle.
    if cleaned.starts_with("./") || cleaned.starts_with("../") {
        return None;
    }

    let bundle_rooted = normalize_segments(&without_ext);
    if ids.contains(&bundle_rooted) {
        return Some(bundle_rooted);
    }

    if !without_ext.contains('/') {
        let mut matches = ids
            .iter()
            .filter(|id| id.rsplit('/').next().unwrap_or(id) == without_ext);
        if let (Some(only), None) = (matches.next(), matches.next()) {
            return Some(only.clone());
        }
    }

    None
}

/// Extract every outbound link from a concept body.
///
/// Image embeds (`![alt](src)`) are skipped: they are asset references, not
/// knowledge relations.
pub fn extract_links(
    body: &str,
    from_id: &str,
    known_ids: Option<&HashSet<String>>,
) -> Vec<ConceptLink> {
    let mk = Masked::new(body);
    let mut links: Vec<ConceptLink> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut push = |link: ConceptLink| {
        let key = format!(
            "{}:{}:{}",
            if link.kind == LinkKind::Wikilink {
                "wikilink"
            } else {
                "markdown"
            },
            link.target,
            link.label.as_deref().unwrap_or("")
        );
        if seen.insert(key) {
            links.push(link);
        }
    };

    for caps in WIKILINK_RE.captures_iter(&mk.text) {
        let target = mk.group(&caps, 1);
        let target = js_trim(&target);
        if target.is_empty() {
            continue;
        }
        let label = mk.group(&caps, 3);
        let label = js_trim(&label);
        push(ConceptLink {
            target: target.to_string(),
            label: (!label.is_empty()).then(|| label.to_string()),
            kind: LinkKind::Wikilink,
            resolved: resolve_link_target(target, from_id, known_ids),
        });
    }

    for caps in MDLINK_RE.captures_iter(&mk.text) {
        if caps.get(1).is_some_and(|m| !m.as_str().is_empty()) {
            continue; // image embed
        }
        let target = mk.group(&caps, 3);
        let target = js_trim(&target);
        if target.is_empty() {
            continue;
        }
        let label = mk.group(&caps, 2);
        let label = js_trim(&label);
        push(ConceptLink {
            target: target.to_string(),
            label: (!label.is_empty()).then(|| label.to_string()),
            kind: LinkKind::Markdown,
            resolved: resolve_link_target(target, from_id, known_ids),
        });
    }

    links
}

/// Invert an id -> outbound-links map into id -> inbound-ids (sorted).
///
/// The input is a `BTreeMap` so iteration is deterministic; the lists are
/// sorted afterwards, which makes the result independent of input order, as in
/// the TS. Sorting is by UTF-8 bytes (JS sorts by UTF-16 units; identical
/// except for astral characters against U+E000..U+FFFF).
pub fn build_backlinks(graph: &BTreeMap<String, Vec<ConceptLink>>) -> HashMap<String, Vec<String>> {
    let mut backlinks: HashMap<String, Vec<String>> = HashMap::new();
    for (from, links) in graph {
        for link in links {
            let Some(resolved) = &link.resolved else {
                continue;
            };
            if resolved == from {
                continue;
            }
            let list = backlinks.entry(resolved.clone()).or_default();
            if !list.contains(from) {
                list.push(from.clone());
            }
        }
    }
    for list in backlinks.values_mut() {
        list.sort();
    }
    backlinks
}

/// Internal scheme used to smuggle a wikilink target through the parser.
pub const WIKILINK_SCHEME: &str = "okf-wiki:";

/// Rewrite `[[target|label]]` into a Markdown link carrying the raw target.
///
/// Done before parsing so wikilinks inherit the Markdown parser's escaping, and
/// so fenced code is handled by the parser rather than by a second regex pass.
pub fn expand_wikilinks(source: &str) -> String {
    // Matches are found against a copy with code blanked out, then applied to
    // the original by offset. Rewriting `[[x]]` inside backticks would leak the
    // internal scheme into documentation that is *about* wikilink syntax.
    let mk = Masked::new(source);
    let mut out = String::with_capacity(source.len());
    let mut last = 0;

    for caps in WIKILINK_RE.captures_iter(&mk.text) {
        let target = mk.group(&caps, 1);
        let target = js_trim(&target);
        if target.is_empty() {
            continue;
        }
        let label = mk.group(&caps, 3);
        let label = js_trim(&label);
        let text = if label.is_empty() { target } else { label };
        let whole = caps.get(0).expect("group 0 always present");
        out.push_str(&source[last..whole.start()]);
        out.push_str(&format!(
            "[{text}]({WIKILINK_SCHEME}{})",
            encode_uri_component(target)
        ));
        last = whole.end();
    }
    out.push_str(&source[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    // ---- maskCode ----

    #[test]
    fn blanks_fenced_blocks_but_preserves_line_count() {
        let source = "a\n```\n[[hidden]]\n```\nb";
        let masked = mask_code(source);
        assert!(!masked.contains("[[hidden]]"));
        assert_eq!(masked.split('\n').count(), source.split('\n').count());
        assert_eq!(masked.len(), source.len());
    }

    #[test]
    fn blanks_inline_code() {
        assert!(!mask_code("use `[[not-a-link]]` here").contains("[[not-a-link]]"));
    }

    #[test]
    fn masking_preserves_byte_length_for_multibyte_text() {
        let source = "日本語 `コード` 😀 ```x``` 終";
        assert_eq!(mask_code(source).len(), source.len());
    }

    #[test]
    fn a_longer_backtick_run_closes_only_with_the_same_length() {
        let masked = mask_code("a ``x ` y`` b `[[z]]`");
        assert!(masked.starts_with("a "));
        assert!(!masked.contains("[[z]]"));
        assert!(masked.contains(" b "));
    }

    #[test]
    fn a_fence_closes_with_the_same_char_and_at_least_the_same_length() {
        let masked = mask_code("````\n```\n[[in]]\n````\n[[out]]");
        assert!(!masked.contains("[[in]]"));
        assert!(masked.contains("[[out]]"));
    }

    // ---- extractLinks ----

    #[test]
    fn finds_wikilinks_and_markdown_links() {
        let ids = known(&["a", "topics/b", "topics/deep/c"]);
        let links = extract_links("see [[topics/b]] and [B](./topics/b.md)", "a", Some(&ids));
        assert_eq!(links.len(), 2);
        assert!(links
            .iter()
            .all(|l| l.resolved.as_deref() == Some("topics/b")));
    }

    #[test]
    fn ignores_links_inside_code() {
        let ids = known(&["a", "topics/b", "topics/deep/c"]);
        assert!(extract_links("```\n[[topics/b]]\n```", "a", Some(&ids)).is_empty());
    }

    #[test]
    fn ignores_image_embeds() {
        let ids = known(&["a"]);
        assert!(extract_links("![alt](./pic.png)", "a", Some(&ids)).is_empty());
    }

    #[test]
    fn leaves_external_links_unresolved() {
        let ids = known(&["a"]);
        let links = extract_links("[x](https://example.com)", "a", Some(&ids));
        assert_eq!(links[0].resolved, None);
    }

    #[test]
    fn captures_a_wikilink_label() {
        let ids = known(&["a", "topics/b"]);
        let links = extract_links("[[topics/b|Nice name]]", "a", Some(&ids));
        assert_eq!(links[0].label.as_deref(), Some("Nice name"));
    }

    #[test]
    fn deduplicates_repeated_targets() {
        let ids = known(&["a", "topics/b"]);
        assert_eq!(
            extract_links("[[a]] [[a]] [[a]]", "topics/b", Some(&ids)).len(),
            1
        );
    }

    #[test]
    fn markdown_link_with_title_and_angle_brackets() {
        let ids = known(&["a", "topics/b"]);
        let links = extract_links("[B]( <./topics/b.md> \"title\" )", "a", Some(&ids));
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "./topics/b.md");
        assert_eq!(links[0].label.as_deref(), Some("B"));
    }

    // ---- resolveLinkTarget ----

    #[test]
    fn resolves_relative_to_the_linking_document() {
        let ids = known(&["a", "topics/b", "topics/deep/c"]);
        assert_eq!(
            resolve_link_target("./deep/c.md", "topics/b", Some(&ids)).as_deref(),
            Some("topics/deep/c")
        );
        assert_eq!(
            resolve_link_target("../a.md", "topics/b", Some(&ids)).as_deref(),
            Some("a")
        );
    }

    #[test]
    fn resolves_a_bare_name_by_unique_basename() {
        let ids = known(&["a", "topics/b", "topics/deep/c"]);
        assert_eq!(
            resolve_link_target("c", "a", Some(&ids)).as_deref(),
            Some("topics/deep/c")
        );
    }

    #[test]
    fn refuses_to_guess_an_ambiguous_basename() {
        let ids = known(&["x/note", "y/note"]);
        assert_eq!(resolve_link_target("note", "a", Some(&ids)), None);
    }

    #[test]
    fn drops_the_fragment_before_resolving() {
        let ids = known(&["a", "topics/b"]);
        assert_eq!(
            resolve_link_target("topics/b#section", "a", Some(&ids)).as_deref(),
            Some("topics/b")
        );
    }

    #[test]
    fn returns_none_for_external_targets_and_non_markdown_assets() {
        let ids = known(&["a"]);
        assert_eq!(
            resolve_link_target("https://example.com", "a", Some(&ids)),
            None
        );
        assert_eq!(resolve_link_target("mailto:x@y.z", "a", Some(&ids)), None);
        assert_eq!(resolve_link_target("./diagram.png", "a", Some(&ids)), None);
    }

    #[test]
    fn without_known_ids_the_path_is_normalised_not_checked() {
        assert_eq!(
            resolve_link_target("../x.md", "topics/deep/c", None).as_deref(),
            Some("topics/x")
        );
        assert_eq!(
            resolve_link_target("/x/y.md", "a", None).as_deref(),
            Some("x/y")
        );
    }

    #[test]
    fn percent_encoded_targets_are_decoded() {
        let ids = known(&["メモ"]);
        assert_eq!(
            resolve_link_target("%E3%83%A1%E3%83%A2.md", "a", Some(&ids)).as_deref(),
            Some("メモ")
        );
        // Malformed escapes fall back to the raw text instead of failing.
        assert_eq!(
            resolve_link_target("100%.md", "a", None).as_deref(),
            Some("100%")
        );
    }

    // ---- buildBacklinks ----

    fn link(target: &str, kind: LinkKind, resolved: &str) -> ConceptLink {
        ConceptLink {
            target: target.into(),
            label: None,
            kind,
            resolved: Some(resolved.into()),
        }
    }

    #[test]
    fn inverts_the_link_graph_and_ignores_self_links() {
        let mut graph = BTreeMap::new();
        graph.insert("a".to_string(), vec![link("b", LinkKind::Wikilink, "b")]);
        graph.insert(
            "c".to_string(),
            vec![
                link("b", LinkKind::Markdown, "b"),
                link("c", LinkKind::Wikilink, "c"),
            ],
        );
        let backlinks = build_backlinks(&graph);
        assert_eq!(
            backlinks.get("b"),
            Some(&vec!["a".to_string(), "c".to_string()])
        );
        assert!(!backlinks.contains_key("c"));
    }

    // ---- cross-linking forms (OKF §6) ----

    #[test]
    fn an_absolute_link_is_bundle_rooted_never_relative() {
        let ids = known(&["a", "other", "topics/a", "topics/other", "topics/deep/c"]);
        assert_eq!(
            resolve_link_target("/other.md", "topics/a", Some(&ids)).as_deref(),
            Some("other")
        );
    }

    #[test]
    fn a_relative_link_is_anchored_to_the_linking_document() {
        let ids = known(&["a", "other", "topics/a", "topics/other", "topics/deep/c"]);
        assert_eq!(
            resolve_link_target("./other.md", "topics/a", Some(&ids)).as_deref(),
            Some("topics/other")
        );
        assert_eq!(
            resolve_link_target("../other.md", "topics/deep/c", Some(&ids)).as_deref(),
            Some("topics/other")
        );
    }

    #[test]
    fn an_explicitly_relative_link_does_not_fall_back_to_a_bundle_root_match() {
        let ids = known(&["a", "other", "topics/a", "topics/other", "topics/deep/c"]);
        assert_eq!(
            resolve_link_target("./nope.md", "topics/a", Some(&ids)),
            None
        );
    }

    #[test]
    fn an_absolute_link_to_a_missing_target_is_simply_unresolved() {
        let ids = known(&["a", "other"]);
        assert_eq!(resolve_link_target("/nowhere.md", "a", Some(&ids)), None);
    }

    // ---- expandWikilinks ----

    #[test]
    fn expands_a_real_wikilink() {
        assert!(expand_wikilinks("see [[topics/a]]").contains("okf-wiki:topics%2Fa"));
    }

    #[test]
    fn leaves_a_wikilink_inside_inline_code_alone() {
        // Documentation *about* wikilink syntax must render as written.
        assert_eq!(
            expand_wikilinks("write `[[hello]]` to link"),
            "write `[[hello]]` to link"
        );
    }

    #[test]
    fn leaves_a_wikilink_inside_a_fenced_block_alone() {
        let out = expand_wikilinks("```\n[[hello]]\n```\n\nreal [[hello]]");
        assert!(out.contains("```\n[[hello]]\n```"));
        assert!(out.contains("okf-wiki:hello"));
    }

    #[test]
    fn uses_the_label_when_one_is_given() {
        assert!(expand_wikilinks("[[a|表示名]]").contains("[表示名]("));
    }

    #[test]
    fn external_target_detection() {
        assert!(is_external_target("https://x"));
        assert!(is_external_target("mailto:a@b"));
        assert!(is_external_target("//cdn/x"));
        assert!(is_external_target("#frag"));
        assert!(!is_external_target("topics/a"));
        assert!(!is_external_target("./a:b"));
        assert!(!is_external_target("1http://x"));
    }
}
