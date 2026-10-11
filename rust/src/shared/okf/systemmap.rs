//! SYSTEMMAP.md: the map of the system itself (`src/shared/okf/systemmap.ts`).
//!
//! Two halves. The prose is written once (then yours: edit it freely). The
//! section between the markers is generated from the open bundle by
//! `system_map { refresh: true }`, and only that section is ever rewritten, so
//! what you wrote around it survives byte for byte. The prose itself is the
//! files in `templates/`, shared with the Bun build.

use crate::shared::okf::canvas::clip;
use crate::shared::okf::para::{ParaClass, PARA_ORDER};

pub const SYSTEMMAP_START: &str = "<!-- okf:systemmap:start -->";
pub const SYSTEMMAP_END: &str = "<!-- okf:systemmap:end -->";

const HEAD: &str = include_str!("../../../../templates/systemmap-head.md");
const TAIL: &str = include_str!("../../../../templates/systemmap-tail.md");

#[derive(Debug, Clone)]
pub struct BaseFact {
    pub path: String,
    pub views: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CanvasFact {
    pub path: String,
    pub nodes: usize,
    pub edges: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct KindFact {
    pub name: String,
    pub from: Option<Vec<String>>,
    pub to: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct SchemaFact {
    pub types: Option<Vec<String>>,
    pub kinds: Option<Vec<KindFact>>,
}

#[derive(Debug, Clone)]
pub struct SystemMapFacts {
    pub concepts: usize,
    pub dead: usize,
    pub knowhow: usize,
    pub tool_count: usize,
    /// Concepts per PARA class, in `PARA_ORDER`.
    pub para: [usize; 4],
    /// Concept types with their counts, most used first.
    pub types: Vec<(String, usize)>,
    pub bases: Vec<BaseFact>,
    pub canvases: Vec<CanvasFact>,
    pub skills: Vec<(String, String)>,
    pub loops: Vec<(String, String)>,
    pub schema: Option<SchemaFact>,
}

fn one_line(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    clip(collapsed.trim(), 120)
}

fn cell(text: &str) -> String {
    text.replace('|', "\\|")
}

fn code(text: &str) -> String {
    format!("`{}`", text.replace('`', "'"))
}

fn para_index(class: ParaClass) -> usize {
    PARA_ORDER.iter().position(|c| *c == class).unwrap_or(0)
}

/// The generated section, markers included, without a trailing newline.
pub fn render_generated_section(facts: Option<&SystemMapFacts>) -> String {
    let mut lines: Vec<String> = vec!["## 現在の状態（自動生成）".into(), String::new()];
    lines.push("この範囲は `system_map { refresh: true }` が書き換えます。手で編集しないでください".into());
    lines.push("（範囲の外に書いたことは、更新しても消えません）。".into());
    lines.push(String::new());

    let Some(facts) = facts else {
        lines.push("まだ生成されていません。`system_map { refresh: true }` を呼ぶと、ここに現在の件数と一覧が入ります。".into());
        return wrap_section(lines);
    };

    lines.push("| 項目 | 数 |".into());
    lines.push("|---|---|".into());
    let dead = if facts.dead > 0 { format!("（DEAD {} 件を含む）", facts.dead) } else { String::new() };
    lines.push(format!("| 概念 | {}{dead} |", facts.concepts));
    lines.push(format!("| ノウハウ | {} |", facts.knowhow));
    lines.push(format!("| ベース | {} |", facts.bases.len()));
    lines.push(format!("| キャンバス | {} |", facts.canvases.len()));
    lines.push(format!("| スキル | {} |", facts.skills.len()));
    lines.push(format!("| ループ | {} |", facts.loops.len()));
    lines.push(format!("| MCP ツール | {} |", facts.tool_count));
    lines.push(String::new());

    lines.push("### 概念（PARA 別）".into());
    lines.push(String::new());
    lines.push("| PARA | 件数 |".into());
    lines.push("|---|---|".into());
    for class in PARA_ORDER {
        lines.push(format!("| {}（{}） | {} |", class.dir(), class.label(), facts.para[para_index(class)]));
    }
    lines.push(String::new());

    lines.push("### 概念（型別）".into());
    lines.push(String::new());
    if facts.types.is_empty() {
        lines.push("なし。".into());
    } else {
        lines.push("| 型 | 件数 |".into());
        lines.push("|---|---|".into());
        for (ty, count) in &facts.types {
            lines.push(format!("| {} | {count} |", cell(ty)));
        }
    }
    lines.push(String::new());

    lines.push("### ベース".into());
    lines.push(String::new());
    if facts.bases.is_empty() {
        lines.push("なし。".into());
    }
    for base in &facts.bases {
        lines.push(match &base.error {
            Some(error) => format!("- {} — 読めません: {}", code(&base.path), one_line(error)),
            None => format!(
                "- {} — ビュー: {}",
                code(&base.path),
                if base.views.is_empty() { "なし".to_string() } else { base.views.join(", ") }
            ),
        });
    }
    lines.push(String::new());

    lines.push("### キャンバス".into());
    lines.push(String::new());
    if facts.canvases.is_empty() {
        lines.push("なし。".into());
    }
    for canvas in &facts.canvases {
        lines.push(match &canvas.error {
            Some(error) => format!("- {} — 読めません: {}", code(&canvas.path), one_line(error)),
            None => format!("- {} — {} ノード / {} エッジ", code(&canvas.path), canvas.nodes, canvas.edges),
        });
    }
    lines.push(String::new());

    lines.push("### スキル".into());
    lines.push(String::new());
    if facts.skills.is_empty() {
        lines.push("なし。".into());
    }
    for (name, description) in &facts.skills {
        lines.push(format!("- {} — {}", code(name), one_line(description)));
    }
    lines.push(String::new());

    lines.push("### ループ".into());
    lines.push(String::new());
    if facts.loops.is_empty() {
        lines.push("なし。".into());
    }
    for (name, goal) in &facts.loops {
        lines.push(format!("- {} — {}", code(name), one_line(goal)));
    }
    lines.push(String::new());

    lines.push("### グラフスキーマ".into());
    lines.push(String::new());
    match &facts.schema {
        None => lines.push(
            "`wiki/graph/schema.md` がありません。作ると、型と関係の種類を宣言できます（下の「拡張のしかた」）。".into(),
        ),
        Some(schema) => {
            let types = match &schema.types {
                None => "（宣言なし）".to_string(),
                Some(t) if t.is_empty() => "なし".to_string(),
                Some(t) => t.join(", "),
            };
            lines.push(format!("- 型: {types}"));
            match &schema.kinds {
                None => lines.push("- 関係: （宣言なし）".into()),
                Some(kinds) if kinds.is_empty() => lines.push("- 関係: なし".into()),
                Some(kinds) => {
                    for kind in kinds {
                        let ends = if kind.from.is_some() || kind.to.is_some() {
                            let star = vec!["*".to_string()];
                            format!(
                                "（{} → {}）",
                                kind.from.as_ref().unwrap_or(&star).join("|"),
                                kind.to.as_ref().unwrap_or(&star).join("|")
                            )
                        } else {
                            String::new()
                        };
                        lines.push(format!("- 関係: {}{ends}", code(&kind.name)));
                    }
                }
            }
        }
    }

    wrap_section(lines)
}

/// The markers around the body. Anything user-derived (skill descriptions, loop
/// goals, type and kind names) could spell a marker; `<!--` is neutralised so a
/// refresh can never grow a second section or end the first one early.
fn wrap_section(lines: Vec<String>) -> String {
    let mut all: Vec<String> = Vec::with_capacity(lines.len() + 2);
    all.push(SYSTEMMAP_START.into());
    all.extend(lines.into_iter().map(|l| l.replace("<!--", "&lt;!--")));
    all.push(SYSTEMMAP_END.into());
    all.join("\n")
}

/// The file's new text. With a previous version, only the marked section is
/// replaced; a previous file without markers keeps its text and gains the
/// section at the end. Without one, the whole template.
///
/// Exactly one start marker followed by exactly one end marker is a section.
/// Any other mix (an orphan, reversed, duplicated) is an error: guessing which
/// half to trust could delete the human's text, so the file is left for them to
/// fix.
pub fn render_system_map(previous: Option<&str>, facts: Option<&SystemMapFacts>) -> Result<String, String> {
    let section = render_generated_section(facts);
    let Some(previous) = previous else {
        return Ok(format!("{HEAD}\n{section}\n{TAIL}"));
    };

    let starts = previous.matches(SYSTEMMAP_START).count();
    let ends = previous.matches(SYSTEMMAP_END).count();
    if starts == 0 && ends == 0 {
        let newline = if previous.ends_with('\n') { "" } else { "\n" };
        return Ok(format!("{previous}{newline}\n{section}\n"));
    }

    if let (1, 1, Some(start), Some(end)) = (starts, ends, previous.find(SYSTEMMAP_START), previous.find(SYSTEMMAP_END)) {
        if start < end {
            return Ok(format!("{}{section}{}", &previous[..start], &previous[end + SYSTEMMAP_END.len()..]));
        }
    }
    let fix = if starts > 1 || ends > 1 {
        format!("keep exactly one {SYSTEMMAP_START} followed by one {SYSTEMMAP_END}")
    } else if starts == 1 && ends == 0 {
        format!("restore {SYSTEMMAP_END} after the generated section")
    } else if starts == 0 {
        format!("restore {SYSTEMMAP_START} before the generated section")
    } else {
        format!("put {SYSTEMMAP_START} before {SYSTEMMAP_END}")
    };
    Err(format!(
        "SYSTEMMAP.md has {starts} start and {ends} end markers, so the generated section cannot be found: {fix}, then refresh again. Nothing was written."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_template_has_one_marked_section() {
        let text = render_system_map(None, None).unwrap();
        assert_eq!(text.matches(SYSTEMMAP_START).count(), 1);
        assert_eq!(text.matches(SYSTEMMAP_END).count(), 1);
        assert!(text.contains("## 拡張のしかた"));
    }

    #[test]
    fn a_refresh_replaces_only_the_marked_section() {
        let first = render_system_map(None, None).unwrap();
        let edited = format!("MY NOTE\r\n{first}\n\ttrailing  \n");
        let next = render_system_map(Some(&edited), None).unwrap();
        assert_eq!(next, edited);
        let facts = SystemMapFacts {
            concepts: 3,
            dead: 1,
            knowhow: 0,
            tool_count: 54,
            para: [1, 0, 2, 0],
            types: vec![("Concept".into(), 3)],
            bases: vec![],
            canvases: vec![],
            skills: vec![],
            loops: vec![],
            schema: None,
        };
        let next = render_system_map(Some(&edited), Some(&facts)).unwrap();
        assert!(next.starts_with("MY NOTE\r\n"));
        assert!(next.ends_with("\n\ttrailing  \n"));
        assert!(next.contains("| 概念 | 3（DEAD 1 件を含む） |"));
    }

    #[test]
    fn a_file_without_markers_keeps_its_text_and_gains_the_section() {
        let next = render_system_map(Some("# mine\nno markers"), None).unwrap();
        assert!(next.starts_with("# mine\nno markers\n\n"));
        assert!(next.ends_with(&format!("{SYSTEMMAP_END}\n")));
    }

    #[test]
    fn any_marker_mix_but_one_pair_is_refused() {
        let (s, e) = (SYSTEMMAP_START, SYSTEMMAP_END);
        let cases = [
            (format!("a\n{s}\nb\n"), "1 start and 0 end", e),
            (format!("a\n{e}\nb\n"), "0 start and 1 end", s),
            (format!("{e}\nx\n{s}\n"), "1 start and 1 end", "put"),
            (format!("{s}\n{s}\n{e}\n"), "2 start and 1 end", "exactly one"),
            (format!("{s}\n{e}\n{e}\n"), "1 start and 2 end", "exactly one"),
        ];
        for (text, counts, hint) in cases {
            let error = render_system_map(Some(&text), None).unwrap_err();
            assert!(error.contains(counts) && error.contains(hint) && error.ends_with("Nothing was written."), "{error}");
        }
    }

    #[test]
    fn generated_text_cannot_spell_a_marker() {
        let facts = SystemMapFacts {
            concepts: 0,
            dead: 0,
            knowhow: 0,
            tool_count: 0,
            para: [0; 4],
            types: vec![(format!("T{SYSTEMMAP_END}"), 1)],
            bases: vec![],
            canvases: vec![],
            skills: vec![("s".into(), format!("evil {SYSTEMMAP_END} {SYSTEMMAP_START}"))],
            loops: vec![],
            schema: None,
        };
        let first = render_system_map(Some(&render_system_map(None, None).unwrap()), Some(&facts)).unwrap();
        assert_eq!(first.matches(SYSTEMMAP_START).count(), 1);
        assert_eq!(first.matches(SYSTEMMAP_END).count(), 1);
        assert_eq!(render_system_map(Some(&first), Some(&facts)).unwrap(), first);
    }
}
