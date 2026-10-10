//! Move a bundle written with the old layout into the corrected one
//! (`src/bun/okf/migrate.ts`).
//!
//! An earlier version put `AGENTS.md`, `skills/` and `loops/` at the bundle
//! root, as siblings of `raw/`, `wiki/` and `.rag/`. That turned the LLM Wiki
//! pattern's three layers into five and lost the meaning of the split: all
//! three are curated content *about* the wiki, so they belong inside it.
//!
//! Runs on open, and does nothing when there is nothing to move. Never
//! overwrites: if a destination already exists the source is left alone and
//! reported, because a half-migrated bundle that silently lost a skill would
//! be worse than one that needs a manual decision.

use super::error::{self, Result};
use super::nodepath;
use super::paths::{BundlePaths, AGENTS_FILE, LOOPS_DIR, SKILLS_DIR};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationResult {
    /// Bundle-relative paths that were moved, as `from -> to`.
    pub moved: Vec<String>,
    /// Sources left in place because the destination already existed.
    pub skipped: Vec<String>,
}

fn exists(path: &str) -> bool {
    error::path_exists(path)
}

/// Relocate one entry, refusing to clobber.
///
/// A directory that exists at both ends is merged entry by entry rather than
/// replaced wholesale: a user who created one new skill under the corrected
/// layout should not lose the twenty that were still under the old one.
fn relocate(from: &str, to: &str, label: &str, result: &mut MigrationResult) -> Result<()> {
    if !exists(from) {
        return Ok(());
    }

    if !exists(to) {
        error::rename(from, to)?;
        result.moved.push(label.to_string());
        return Ok(());
    }

    if !error::stat(from)?.is_dir() {
        result.skipped.push(label.to_string());
        return Ok(());
    }

    let mut merged = 0;
    for entry in error::read_dir_names(from)? {
        let child_from = nodepath::join(&[from, &entry]);
        let child_to = nodepath::join(&[to, &entry]);
        if exists(&child_to) {
            result.skipped.push(format!("{label}/{entry}"));
            continue;
        }
        error::rename(&child_from, &child_to)?;
        merged += 1;
    }
    if merged > 0 {
        result.moved.push(format!("{label} ({merged} 件)"));
    }
    Ok(())
}

/// Migrate a bundle in place.
///
/// Only acts when the bundle actually has a `wiki/` directory: a folder opened
/// directly as the wiki layer has nowhere to move things *to*, and its
/// `skills/` already resolves to the right place.
pub fn migrate_layout(paths: &BundlePaths) -> Result<MigrationResult> {
    let mut result = MigrationResult::default();

    // With no wiki subdirectory the roots already coincide; moving would be a
    // no-op at best and a rename onto itself at worst.
    if paths.wiki_dir.is_empty() {
        return Ok(result);
    }
    if !exists(&paths.wiki_root()) {
        return Ok(result);
    }

    relocate(
        &nodepath::join(&[&paths.root, AGENTS_FILE]),
        &paths.agents_md_path(),
        AGENTS_FILE,
        &mut result,
    )?;
    relocate(
        &nodepath::join(&[&paths.root, SKILLS_DIR]),
        &paths.skills_root(),
        &format!("{SKILLS_DIR}/"),
        &mut result,
    )?;
    relocate(
        &nodepath::join(&[&paths.root, LOOPS_DIR]),
        &paths.loops_root(),
        &format!("{LOOPS_DIR}/"),
        &mut result,
    )?;

    // The opposite direction: MAP.md, human.md and Task.md were briefly inside
    // wiki/ and now sit beside the layers. They are not knowledge, so they were
    // never part of the material the three layers describe.
    for item in paths.legacy_orientation_paths() {
        relocate(&item.from, &item.to, &item.name, &mut result)?;
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &std::path::Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn moves_legacy_root_entries_into_the_wiki() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "wiki/a.md", "x");
        write(root, "AGENTS.md", "agents");
        write(root, "skills/s/SKILL.md", "s");
        write(root, "wiki/MAP.md", "map");
        let paths = BundlePaths::new(root.to_str().unwrap(), "wiki");

        let result = migrate_layout(&paths).unwrap();

        assert_eq!(result.moved, vec!["AGENTS.md", "skills/", "MAP.md"]);
        assert!(root.join("wiki/AGENTS.md").exists());
        assert!(root.join("wiki/skills/s/SKILL.md").exists());
        assert!(root.join("MAP.md").exists());
        assert!(!root.join("AGENTS.md").exists());
    }

    #[test]
    fn merges_directories_without_clobbering() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "wiki/skills/new/SKILL.md", "new");
        write(root, "skills/old/SKILL.md", "old");
        write(root, "skills/new/SKILL.md", "stale");
        let paths = BundlePaths::new(root.to_str().unwrap(), "wiki");

        let result = migrate_layout(&paths).unwrap();

        assert_eq!(result.moved, vec!["skills/ (1 件)"]);
        assert_eq!(result.skipped, vec!["skills//new"]);
        assert_eq!(fs::read_to_string(root.join("wiki/skills/new/SKILL.md")).unwrap(), "new");
        assert!(root.join("wiki/skills/old/SKILL.md").exists());
    }

    #[test]
    fn does_nothing_without_a_wiki_directory() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "skills/s/SKILL.md", "s");
        let paths = BundlePaths::new(dir.path().to_str().unwrap(), "");
        assert_eq!(migrate_layout(&paths).unwrap(), MigrationResult::default());
    }
}
