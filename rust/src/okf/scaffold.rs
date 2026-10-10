//! Create a new bundle with the full three-layer layout
//! (`src/bun/okf/scaffold.ts`).
//!
//! Scaffolding is idempotent: it never overwrites an existing file, so it is
//! safe to run against a folder that already holds notes in order to add the
//! missing pieces (AGENTS.md, the reserved files, the layer directories).

use super::error::{self, Result};
use super::nodepath;
use super::paths::{LOOPS_DIR, RAG_DIR, RAW_DIR, SKILLS_DIR, WIKI_DIR};
use crate::shared::okf::para::PARA_ORDER;
use crate::shared::okf::reserved::{empty_log_md, render_index_md, IndexOptions, OKF_VERSION};
use crate::shared::okf::workspace_files::{
    render_human_template, render_map, render_tasks, TaskFile, HUMAN_FILE, MAP_FILE, TASK_FILE,
};

const AGENTS_MD_TEMPLATE: &str = include_str!("../../../templates/AGENTS.md");
const HELLO_TEMPLATE: &str = include_str!("../../../templates/bundle-skeleton/wiki/hello.md");
const INGEST_SKILL: &str = include_str!("../../../templates/bundle-skeleton/skills/okf-ingest/SKILL.md");
const INGEST_REFERENCE: &str =
    include_str!("../../../templates/bundle-skeleton/skills/okf-ingest/reference.md");
const ANSWER_SKILL: &str = include_str!("../../../templates/bundle-skeleton/skills/wiki-answer/SKILL.md");
const LINT_SKILL: &str = include_str!("../../../templates/bundle-skeleton/skills/wiki-lint/SKILL.md");
const LOOPS_README: &str = include_str!("../../../templates/bundle-skeleton/loops/README.md");
const INGEST_LOOP: &str = include_str!("../../../templates/bundle-skeleton/loops/ingest-notes.md");
const LINT_LOOP: &str = include_str!("../../../templates/bundle-skeleton/loops/weekly-lint.md");

const RAW_README: &str = "# raw/ — 元資料を置く場所

エクスポート、議事録、書き起こし、PDF などの原本をここに置きます。

このディレクトリは**不変**です。AI エージェントは読み取り専用でアクセスし、
アプリからの書き込みも拒否されます。整理・要約は `../wiki/` 側で行い、
元資料はそのまま残します。
";

const RAG_GITIGNORE: &str = "# wiki 層から生成される派生インデックス。削除しても再構築されます。
*
";

/// Write a file only when it is absent. Returns true when it was created.
fn write_if_missing(path: &str, content: &str) -> Result<bool> {
    if error::path_exists(path) {
        return Ok(false);
    }
    error::write_text(path, content)?;
    Ok(true)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScaffoldResult {
    pub root: String,
    /// Bundle-relative, `/`-separated.
    pub created: Vec<String>,
}

pub fn scaffold_bundle(root: &str) -> Result<ScaffoldResult> {
    let abs_root = nodepath::resolve1(root);
    let mut created: Vec<String> = Vec::new();

    error::mkdir_p(&nodepath::join(&[&abs_root, RAW_DIR]))?;
    error::mkdir_p(&nodepath::join(&[&abs_root, WIKI_DIR]))?;
    error::mkdir_p(&nodepath::join(&[&abs_root, RAG_DIR]))?;
    // skills/ and loops/ live inside the wiki layer: they are curated content
    // about the wiki, not layers of their own.
    let wiki_root = nodepath::join(&[&abs_root, WIKI_DIR]);

    // PARA, as folders. Numbered so the tree sorts by priority on its own.
    for class in PARA_ORDER {
        error::mkdir_p(&nodepath::join(&[&wiki_root, class.dir()]))?;
    }

    // Skills are grouped by category: skills/<category>/<name>/SKILL.md
    error::mkdir_p(&nodepath::join(&[&wiki_root, SKILLS_DIR, "ingest", "okf-ingest"]))?;
    error::mkdir_p(&nodepath::join(&[&wiki_root, SKILLS_DIR, "query", "wiki-answer"]))?;
    error::mkdir_p(&nodepath::join(&[&wiki_root, SKILLS_DIR, "quality", "wiki-lint"]))?;
    error::mkdir_p(&nodepath::join(&[&wiki_root, LOOPS_DIR]))?;

    let skills = |category: &str, name: &str, file: &str| {
        nodepath::join(&[WIKI_DIR, SKILLS_DIR, category, name, file])
    };
    let files: Vec<(String, String)> = vec![
        (nodepath::join(&[WIKI_DIR, "AGENTS.md"]), AGENTS_MD_TEMPLATE.to_string()),
        // The orientation files, at the root beside the layers rather than
        // inside one: they are not the material the layers stage. MAP is what
        // an agent reads first, so it exists from the moment the bundle does;
        // the other two start as templates because an empty prompt is answered
        // and an empty file is not.
        (MAP_FILE.to_string(), render_map(None)),
        (HUMAN_FILE.to_string(), render_human_template()),
        (
            TASK_FILE.to_string(),
            render_tasks(&TaskFile {
                tasks: Vec::new(),
                done_ever: 0,
            }),
        ),
        (nodepath::join(&[RAW_DIR, "README.md"]), RAW_README.to_string()),
        (nodepath::join(&[RAG_DIR, ".gitignore"]), RAG_GITIGNORE.to_string()),
        (
            nodepath::join(&[WIKI_DIR, "index.md"]),
            render_index_md(
                &basename(&abs_root),
                &[],
                &IndexOptions {
                    okf_version: Some(OKF_VERSION.to_string()),
                },
            ),
        ),
        (nodepath::join(&[WIKI_DIR, "log.md"]), empty_log_md("Log")),
        (nodepath::join(&[WIKI_DIR, "hello.md"]), HELLO_TEMPLATE.to_string()),
        // Three starter skills covering the whole cycle: ingest, answer, lint.
        // A SkillSpace with nothing in it teaches nobody what a skill is for.
        (skills("ingest", "okf-ingest", "SKILL.md"), INGEST_SKILL.to_string()),
        (skills("ingest", "okf-ingest", "reference.md"), INGEST_REFERENCE.to_string()),
        (skills("query", "wiki-answer", "SKILL.md"), ANSWER_SKILL.to_string()),
        (skills("quality", "wiki-lint", "SKILL.md"), LINT_SKILL.to_string()),
        (nodepath::join(&[WIKI_DIR, LOOPS_DIR, "README.md"]), LOOPS_README.to_string()),
        // Two starter designs, so the unit is concrete rather than a concept
        // the user has to invent before they can use it.
        (nodepath::join(&[WIKI_DIR, LOOPS_DIR, "ingest-notes.md"]), INGEST_LOOP.to_string()),
        (nodepath::join(&[WIKI_DIR, LOOPS_DIR, "weekly-lint.md"]), LINT_LOOP.to_string()),
    ];

    for (rel, content) in files {
        if write_if_missing(&nodepath::join(&[&abs_root, &rel]), &content)? {
            created.push(rel.replace('\\', "/"));
        }
    }

    Ok(ScaffoldResult {
        root: abs_root,
        created,
    })
}

fn basename(path: &str) -> String {
    path.split(['/', '\\'])
        .rfind(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffolds_the_three_layers_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("My Bundle");
        let first = scaffold_bundle(root.to_str().unwrap()).unwrap();

        assert!(first.created.contains(&"wiki/AGENTS.md".to_string()));
        assert!(first.created.contains(&"MAP.md".to_string()));
        assert!(first.created.contains(&"wiki/skills/ingest/okf-ingest/SKILL.md".to_string()));
        assert!(root.join("raw").is_dir());
        assert!(root.join(".rag/.gitignore").is_file());
        assert!(root.join("wiki/loops/weekly-lint.md").is_file());

        let second = scaffold_bundle(root.to_str().unwrap()).unwrap();
        assert!(second.created.is_empty());
    }

    #[test]
    fn never_overwrites_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/hello.md"), "mine").unwrap();
        let result = scaffold_bundle(root.to_str().unwrap()).unwrap();
        assert!(!result.created.contains(&"wiki/hello.md".to_string()));
        assert_eq!(std::fs::read_to_string(root.join("wiki/hello.md")).unwrap(), "mine");
    }

    #[test]
    fn basename_handles_both_separators() {
        assert_eq!(basename("C:\\a\\b\\"), "b");
        assert_eq!(basename("/a/b"), "b");
    }
}
