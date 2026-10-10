//! SkillSpace: discovery and on-demand loading of the `skills/` layer
//! (`src/bun/okf/skills.ts`).
//!
//! The design goal is that having many skills costs almost nothing until one
//! is used, so three tiers are kept strictly apart:
//!
//!   1. [`SkillSpace::summaries`]: name, description, size. Always affordable.
//!   2. [`SkillSpace::open`]: the SKILL.md body. Paid for once, on purpose.
//!   3. [`SkillSpace::read_resource`]: a supporting file the body pointed at.
//!
//! Nothing in tier 1 reads a body for anything but measuring it, and nothing in
//! tier 2 reads a resource.

use super::error::{self, OkfError, Result};
use super::nodepath;
use super::paths::{is_contained, to_posix, BundlePaths};
use crate::shared::js_compat::{js_round, locale_compare};
use crate::shared::messages;
use crate::shared::okf::para::ParaClass;
use crate::shared::okf::skill::{estimate_tokens, parse_skill, SkillDocument, SkillSummary, SKILL_FILE};
use crate::shared::okf::skill_rank::{rank_skills, selection_confidence, Confidence, RankableSkill};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;

/// Files inside a skill folder that are never offered as resources.
const HIDDEN_PREFIXES: [&str; 2] = [".", "_"];

/// Cap on how deep a skill folder is walked when listing its resources.
const MAX_RESOURCE_DEPTH: usize = 3;

/// A resource has to be text to be worth handing to a model.
const TEXT_EXTENSIONS: [&str; 17] = [
    ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".js", ".ts", ".py", ".sh",
    ".ps1", ".sql", ".html", ".css", ".xml",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RankedEntry {
    pub name: String,
    pub description: String,
    #[serde(serialize_with = "crate::shared::js_compat::serialize_js_f64")]
    pub score: f64,
    pub matched: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFindResult {
    pub ranked: Vec<RankedEntry>,
    pub confidence: Confidence,
    /// What it would cost to open the top result.
    pub top_tokens: u64,
}

/// `SkillDocument & { resources }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenedSkill {
    #[serde(flatten)]
    pub document: SkillDocument,
    pub resources: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillResource {
    pub path: String,
    pub content: String,
}

#[derive(Clone)]
struct CacheEntry {
    document: SkillDocument,
    resources: Vec<String>,
    mtime_ms: f64,
}

#[derive(Debug, Clone)]
struct FolderName {
    category: String,
    name: String,
}

/// JS default `Array.prototype.sort()`: UTF-16 code unit order.
fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn hidden(name: &str) -> bool {
    HIDDEN_PREFIXES.iter().any(|p| name.starts_with(p))
}

pub struct SkillSpace {
    paths: BundlePaths,
    cache: HashMap<String, CacheEntry>,
    /// Cleared wholesale on any change; a skill catalogue is small enough.
    listing: Option<Vec<SkillSummary>>,
}

impl SkillSpace {
    pub fn new(paths: BundlePaths) -> Self {
        Self {
            paths,
            cache: HashMap::new(),
            listing: None,
        }
    }

    /// Drop everything. Called when the watcher sees `skills/` change.
    pub fn invalidate(&mut self) {
        self.cache.clear();
        self.listing = None;
    }

    /// The cheap tier: every skill's routing information and nothing else.
    ///
    /// Bodies are read here only to measure them; the text is discarded rather
    /// than cached for skills nobody opens.
    pub fn summaries(&mut self) -> Vec<SkillSummary> {
        if let Some(listing) = &self.listing {
            return listing.clone();
        }

        let mut summaries: Vec<SkillSummary> = Vec::new();
        for FolderName { name, .. } in self.folder_names() {
            let Ok(entry) = self.load(&name) else { continue };
            // A skill with no description can never be selected, so listing it
            // would only spend tokens telling an agent about something it
            // cannot use.
            if entry.document.description.is_empty() {
                continue;
            }
            summaries.push(SkillSummary {
                name: entry.document.name.clone(),
                category: entry.document.category.clone(),
                para: entry.document.para,
                description: entry.document.description.clone(),
                tags: entry.document.tags.clone(),
                body_tokens: estimate_tokens(&entry.document.body),
                resources: entry.resources.clone(),
            });
        }

        // Category first, then name: the listing reads like the folder tree.
        summaries.sort_by(|a, b| {
            locale_compare(&a.category, &b.category).then_with(|| locale_compare(&a.name, &b.name))
        });
        self.listing = Some(summaries.clone());
        summaries
    }

    /// Rank the catalogue against a request without loading any body.
    ///
    /// `limit` defaults to 3 in the TS.
    pub fn find(&mut self, task: &str, limit: Option<usize>) -> SkillFindResult {
        // Archived skills are kept and can still be opened by name, but they
        // are never proposed: an archived procedure is one somebody decided to
        // stop using, and suggesting it would undo that decision silently.
        let summaries: Vec<SkillSummary> = self
            .summaries()
            .into_iter()
            .filter(|s| s.para != ParaClass::Archive)
            .collect();
        let mut with_when: Vec<RankableSkill> = Vec::new();
        let mut tokens: HashMap<String, u64> = HashMap::new();
        for summary in &summaries {
            let when = self
                .load(&summary.name)
                .map(|e| e.document.when.clone())
                .unwrap_or_default();
            tokens.insert(summary.name.clone(), summary.body_tokens);
            with_when.push(RankableSkill {
                name: summary.name.clone(),
                description: summary.description.clone(),
                when,
                tags: summary.tags.clone(),
            });
        }

        let ranked = rank_skills(task, &with_when, Some(limit.unwrap_or(3)));
        SkillFindResult {
            confidence: selection_confidence(&ranked),
            top_tokens: ranked
                .first()
                .and_then(|r| tokens.get(&r.skill.name))
                .copied()
                .unwrap_or(0),
            ranked: ranked
                .iter()
                .map(|r| RankedEntry {
                    name: r.skill.name.clone(),
                    description: r.skill.description.clone(),
                    score: js_round(r.score * 100.0) / 100.0,
                    matched: r.matched.clone(),
                })
                .collect(),
        }
    }

    /// The paid tier: a skill's full procedure.
    pub fn open(&mut self, name: &str) -> Result<OpenedSkill> {
        let entry = self.load(name)?;
        Ok(OpenedSkill {
            document: entry.document,
            resources: entry.resources,
        })
    }

    /// Read one supporting file from inside a skill folder.
    ///
    /// The path is resolved and then checked for containment rather than
    /// filtered as a string: a skill body is content, and content that can
    /// name a file is a traversal vector like any other.
    pub fn read_resource(&self, name: &str, resource_path: &str) -> Result<SkillResource> {
        let folder = self.folder_of(name)?;
        let abs = nodepath::resolve(&[&folder, &to_posix(resource_path)]);

        if !is_contained(&folder, &abs) {
            return Err(OkfError::message(messages::skill_resource_escapes(resource_path, name)));
        }
        if !error::is_file(&abs) {
            return Err(OkfError::message(messages::skill_resource_missing(resource_path, name)));
        }

        Ok(SkillResource {
            path: to_posix(&nodepath::relative(&folder, &abs)),
            content: error::read_text(&abs)?,
        })
    }

    fn skill_rel(&self, category: &str, name: &str) -> String {
        let base = to_posix(&nodepath::relative(&self.paths.root, &self.paths.skills_root()));
        [base.as_str(), category, name, SKILL_FILE]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("/")
    }

    /// Bundle-relative path of a skill's `SKILL.md`, for opening it in the editor.
    pub fn rel_path_of(&self, name: &str) -> String {
        self.skill_rel(&self.category_of(name), name)
    }

    /// Where a *new* skill would be created, under an optional category.
    pub fn new_skill_path(&self, name: &str, category: &str) -> String {
        self.skill_rel(&to_posix(category), name)
    }

    // ---- internals ----

    /// Every skill, as `{ category, name }`.
    ///
    /// Two shapes are accepted: `skills/<category>/<name>/SKILL.md`, and the
    /// older flat `skills/<name>/SKILL.md`. A directory is a category when it
    /// has no SKILL.md of its own, so adding a category to an existing bundle
    /// is just making a folder and dragging skills into it.
    fn folder_names(&self) -> Vec<FolderName> {
        let root = self.paths.skills_root();
        let mut found = Vec::new();

        for entry in error::read_dir(&root).unwrap_or_default() {
            if !entry.is_dir || hidden(&entry.name) {
                continue;
            }
            let dir = nodepath::join(&[&root, &entry.name]);
            if error::stat(&nodepath::join(&[&dir, SKILL_FILE])).is_ok() {
                found.push(FolderName {
                    category: String::new(),
                    name: entry.name.clone(),
                });
                continue;
            }
            for child in error::read_dir(&dir).unwrap_or_default() {
                if !child.is_dir || hidden(&child.name) {
                    continue;
                }
                if error::stat(&nodepath::join(&[&dir, &child.name, SKILL_FILE])).is_ok() {
                    found.push(FolderName {
                        category: entry.name.clone(),
                        name: child.name.clone(),
                    });
                }
            }
        }
        found
    }

    /// Categories currently in use, for grouping in the UI.
    pub fn categories(&self) -> Vec<String> {
        let mut cats: Vec<String> = Vec::new();
        for n in self.folder_names() {
            if !n.category.is_empty() && !cats.contains(&n.category) {
                cats.push(n.category);
            }
        }
        cats.sort_by(|a, b| cmp_utf16(a, b));
        cats
    }

    /// Locate a skill's folder by name, whatever category it sits in.
    ///
    /// Names stay flat even though the folders are nested: an agent refers to
    /// a skill by name, and making it also know the category would mean every
    /// reference breaks when a skill is filed differently.
    fn folder_of(&self, name: &str) -> Result<String> {
        let clean = to_posix(name);
        // `name` arrives from agents and tool arguments, so it is untrusted
        // even though it looks like a bare identifier.
        if clean.contains('/') || clean.contains("..") {
            return Err(OkfError::message(messages::skill_unknown(name)));
        }

        let skills_root = self.paths.skills_root();
        for entry in self.folder_names() {
            if entry.name != clean {
                continue;
            }
            let folder = if entry.category.is_empty() {
                nodepath::resolve(&[&skills_root, &entry.name])
            } else {
                nodepath::resolve(&[&skills_root, &entry.category, &entry.name])
            };
            if !is_contained(&skills_root, &folder) {
                break;
            }
            return Ok(folder);
        }

        Err(OkfError::message(messages::skill_unknown(name)))
    }

    /// The category a skill is filed under, or "" when uncategorised.
    fn category_of(&self, name: &str) -> String {
        self.folder_names()
            .into_iter()
            .find(|e| e.name == name)
            .map(|e| e.category)
            .unwrap_or_default()
    }

    fn load(&mut self, name: &str) -> Result<CacheEntry> {
        let folder = self.folder_of(name)?;
        let skill_file = nodepath::join(&[&folder, SKILL_FILE]);

        let info = error::stat(&skill_file).ok().filter(|m| m.is_file());
        let Some(info) = info else {
            return Err(OkfError::message(messages::skill_missing_file(name)));
        };
        let mtime_ms = error::mtime_ms(&info);

        if let Some(cached) = self.cache.get(name) {
            if cached.mtime_ms == mtime_ms {
                return Ok(cached.clone());
            }
        }

        let raw = error::read_text(&skill_file)?;
        let entry = CacheEntry {
            // The category comes from the folder, not the frontmatter: the
            // tree is where a person files things, so the tree decides.
            document: parse_skill(&raw, name, &self.category_of(name)),
            resources: self.resources_of(&folder, 0),
            mtime_ms,
        };
        self.cache.insert(name.to_string(), entry.clone());
        Ok(entry)
    }

    /// List the text files beside `SKILL.md`, without reading any of them.
    fn resources_of(&self, folder: &str, depth: usize) -> Vec<String> {
        if depth >= MAX_RESOURCE_DEPTH {
            return Vec::new();
        }

        let mut found: Vec<String> = Vec::new();
        for entry in error::read_dir(folder).unwrap_or_default() {
            if hidden(&entry.name) {
                continue;
            }
            if entry.is_dir {
                let nested = self.resources_of(&nodepath::join(&[folder, &entry.name]), depth + 1);
                found.extend(nested.into_iter().map(|child| format!("{}/{child}", entry.name)));
                continue;
            }
            if entry.name == SKILL_FILE {
                continue;
            }
            let ext = entry
                .name
                .rfind('.')
                .map(|d| entry.name[d..].to_lowercase())
                .unwrap_or_default();
            if TEXT_EXTENSIONS.contains(&ext.as_str()) {
                found.push(entry.name.clone());
            }
        }
        found.sort_by(|a, b| cmp_utf16(a, b));
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn skill(root: &std::path::Path, rel: &str, desc: &str) {
        let p = root.join("wiki/skills").join(rel);
        fs::create_dir_all(&p).unwrap();
        fs::write(
            p.join("SKILL.md"),
            format!(
                "---\nname: {}\ndescription: {desc}\n---\n\n# Body\n\nsteps\n",
                rel.rsplit('/').next().unwrap()
            ),
        )
        .unwrap();
    }

    fn space(root: &std::path::Path) -> SkillSpace {
        SkillSpace::new(BundlePaths::new(root.to_str().unwrap(), "wiki"))
    }

    #[test]
    fn lists_categorised_and_flat_skills() {
        let dir = tempfile::tempdir().unwrap();
        skill(dir.path(), "ingest/okf-ingest", "ingest notes");
        skill(dir.path(), "flat-one", "a flat skill");
        let mut s = space(dir.path());
        let names: Vec<_> = s.summaries().into_iter().map(|x| (x.category, x.name)).collect();
        assert_eq!(
            names,
            vec![
                (String::new(), "flat-one".to_string()),
                ("ingest".to_string(), "okf-ingest".to_string())
            ]
        );
        assert_eq!(s.rel_path_of("okf-ingest"), "wiki/skills/ingest/okf-ingest/SKILL.md");
        assert_eq!(s.categories(), vec!["ingest"]);
    }

    #[test]
    fn skills_without_a_description_are_not_listed() {
        let dir = tempfile::tempdir().unwrap();
        skill(dir.path(), "a-skill", "\"\"");
        assert!(space(dir.path()).summaries().is_empty());
    }

    #[test]
    fn unknown_and_traversing_names_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        skill(dir.path(), "a-skill", "does things");
        let mut s = space(dir.path());
        assert_eq!(s.open("nope").unwrap_err().to_string(), messages::skill_unknown("nope"));
        assert!(s.open("../a-skill").is_err());
    }

    #[test]
    fn resources_are_listed_and_contained() {
        let dir = tempfile::tempdir().unwrap();
        skill(dir.path(), "a-skill", "does things");
        let folder = dir.path().join("wiki/skills/a-skill");
        fs::write(folder.join("ref.md"), "ref").unwrap();
        fs::write(folder.join("_hidden.md"), "no").unwrap();
        fs::write(folder.join("image.png"), "no").unwrap();
        let mut s = space(dir.path());
        assert_eq!(s.open("a-skill").unwrap().resources, vec!["ref.md"]);
        assert_eq!(s.read_resource("a-skill", "ref.md").unwrap().content, "ref");
        let err = s.read_resource("a-skill", "../../../x.md").unwrap_err().to_string();
        assert_eq!(err, messages::skill_resource_escapes("../../../x.md", "a-skill"));
        assert!(s.read_resource("a-skill", "missing.md").is_err());
    }

    #[test]
    fn find_ranks_and_reports_cost() {
        let dir = tempfile::tempdir().unwrap();
        skill(dir.path(), "ingest-notes", "ingest meeting notes into the wiki");
        skill(dir.path(), "other", "something unrelated");
        let mut s = space(dir.path());
        let found = s.find("ingest notes", None);
        assert_eq!(found.ranked[0].name, "ingest-notes");
        assert!(found.top_tokens > 0);
    }
}
