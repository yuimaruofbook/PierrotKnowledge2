//! Path resolution and the layer contract (`src/bun/okf/paths.ts`).
//!
//! Every path that reaches the filesystem goes through here. The MCP server
//! hands untrusted, agent-authored strings to the same read/write calls the UI
//! uses, so containment cannot be a caller responsibility: [`BundlePaths::resolve`]
//! is the only way to turn a relative path into an absolute one, and it refuses
//! anything that escapes the bundle.

use super::error::{OkfError, Result};
use super::nodepath;
use crate::shared::messages;
use crate::shared::okf::daily::DAILY_DIR;
use crate::shared::okf::workspace_files::{HUMAN_FILE, MAP_FILE, TASK_FILE};
use crate::shared::types::Layer;

pub const RAW_DIR: &str = "raw";
pub const RAG_DIR: &str = ".rag";
pub const WIKI_DIR: &str = "wiki";
pub const SKILLS_DIR: &str = "skills";
pub const LOOPS_DIR: &str = "loops";
pub const AGENTS_FILE: &str = "AGENTS.md";

/// Who is asking. The layer contract is a question of authority, not of path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Actor {
    #[default]
    Human,
    Agent,
}

/// Whether two paths differing only in case name the same file.
///
/// macOS counts, not just Windows: APFS and HFS+ are case-insensitive by
/// default. Treating them as two would let `RAW/x.md` pass the check that keeps
/// agents out of `raw/` and then land in `raw/` anyway. A case-sensitive macOS
/// volume only ever makes containment match more paths, which blocks more
/// writes rather than fewer.
const CASE_INSENSITIVE: bool = cfg!(any(windows, target_os = "macos"));

fn comparable(path: &str) -> String {
    if CASE_INSENSITIVE {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

/// Normalise any bundle-relative path to `/`-separated with no leading slash.
pub fn to_posix(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string()
}

/// True when two paths name the same file.
///
/// Shares [`comparable`] with [`is_contained`]: on Windows and macOS `WIKI` and
/// `wiki` are one directory, and a `==` would hand an agent a guard it can step
/// around by changing the case of a path.
pub fn same_path(a: &str, b: &str) -> bool {
    comparable(&nodepath::resolve1(a)) == comparable(&nodepath::resolve1(b))
}

/// True when `child` is `parent` itself or lives beneath it.
pub fn is_contained(parent: &str, child: &str) -> bool {
    let p = comparable(&nodepath::resolve1(parent));
    let c = comparable(&nodepath::resolve1(child));
    if c == p {
        return true;
    }
    if p.ends_with(nodepath::SEP) {
        c.starts_with(&p)
    } else {
        c.starts_with(&format!("{p}{}", nodepath::SEP))
    }
}

/// `/^[a-z]:/i`
fn has_drive_prefix(path: &str) -> bool {
    let mut chars = path.chars();
    matches!((chars.next(), chars.next()), (Some(d), Some(':')) if d.is_ascii_alphabetic())
}

/// One of the orientation files and where it used to live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyOrientation {
    pub from: String,
    pub to: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct BundlePaths {
    /// Absolute, normalised bundle root.
    pub root: String,
    /// Bundle-relative wiki directory: `"wiki"` for a full LLM-Wiki layout, or
    /// `""` when an arbitrary Markdown folder was opened directly.
    pub wiki_dir: String,
}

impl BundlePaths {
    pub fn new(root: &str, wiki_dir: &str) -> Self {
        Self {
            root: nodepath::resolve1(root),
            wiki_dir: to_posix(wiki_dir),
        }
    }

    fn at_root(&self, name: &str) -> String {
        nodepath::resolve(&[&self.root, name])
    }

    /// Absolute path of the wiki layer (Layer 2).
    pub fn wiki_root(&self) -> String {
        if self.wiki_dir.is_empty() {
            self.root.clone()
        } else {
            nodepath::resolve(&[&self.root, &self.wiki_dir])
        }
    }

    /// Absolute path of the immutable source layer (Layer 1).
    pub fn raw_root(&self) -> String {
        self.at_root(RAW_DIR)
    }

    /// Absolute path of the derived index layer (Layer 3).
    pub fn rag_root(&self) -> String {
        self.at_root(RAG_DIR)
    }

    /// SkillSpace, inside the wiki layer.
    ///
    /// Skills are curated content about the wiki, so they belong to layer 2.
    /// They are excluded from the *concept* scan though (see
    /// [`is_subsystem_path`](Self::is_subsystem_path)): a procedure is not a
    /// fact, and mixing the two would put instructions in the same search
    /// results as knowledge.
    pub fn skills_root(&self) -> String {
        nodepath::resolve(&[&self.wiki_root(), SKILLS_DIR])
    }

    /// Loop designs and their history, inside the wiki layer.
    pub fn loops_root(&self) -> String {
        nodepath::resolve(&[&self.wiki_root(), LOOPS_DIR])
    }

    /// Daily notes, inside the wiki layer and deliberately *not* a subsystem:
    /// they are indexed as ordinary concepts so "what did I decide last
    /// Tuesday" can be answered from the search index.
    pub fn daily_root(&self) -> String {
        nodepath::resolve(&[&self.wiki_root(), DAILY_DIR])
    }

    /// Files inside the wiki layer that are not concepts: `skills/` and
    /// `loops/` are skipped by the concept scan, the search index and
    /// conformance checking.
    pub fn is_subsystem_path(&self, rel_path: &str) -> bool {
        let abs = nodepath::resolve(&[&self.root, &to_posix(rel_path)]);
        is_contained(&self.skills_root(), &abs) || is_contained(&self.loops_root(), &abs)
    }

    /// The agent contract, inside the wiki layer.
    pub fn agents_md_path(&self) -> String {
        nodepath::resolve(&[&self.wiki_root(), AGENTS_FILE])
    }

    /// Where older bundles kept it. Read-only fallback: refusing to read it
    /// would silently strip an agent of its instructions.
    pub fn legacy_agents_md_path(&self) -> String {
        self.at_root(AGENTS_FILE)
    }

    /// `MAP.md`, at the bundle root beside the three layers. Deliberately
    /// outside them: it, `human.md` and `Task.md` are not knowledge, not
    /// derived from knowledge. `AGENTS.md` stays in `wiki/` because it is the
    /// contract for editing that layer.
    pub fn map_md_path(&self) -> String {
        self.at_root(MAP_FILE)
    }

    /// What the agent should know about the person it works for.
    pub fn human_md_path(&self) -> String {
        self.at_root(HUMAN_FILE)
    }

    /// Open and recently finished work.
    pub fn task_md_path(&self) -> String {
        self.at_root(TASK_FILE)
    }

    /// Where the orientation files lived before they were lifted out of
    /// `wiki/`: read-only fallbacks, and the source for the migration on open.
    pub fn legacy_orientation_paths(&self) -> Vec<LegacyOrientation> {
        [MAP_FILE, HUMAN_FILE, TASK_FILE]
            .into_iter()
            .map(|name| LegacyOrientation {
                from: nodepath::resolve(&[&self.wiki_root(), name]),
                to: self.at_root(name),
                name: name.to_string(),
            })
            .collect()
    }

    pub fn index_md_path(&self) -> String {
        nodepath::resolve(&[&self.wiki_root(), "index.md"])
    }

    pub fn log_md_path(&self) -> String {
        nodepath::resolve(&[&self.wiki_root(), "log.md"])
    }

    /// Resolve a bundle-relative path to an absolute one.
    ///
    /// Rejects absolute inputs outside the bundle, NUL bytes and anything that
    /// normalises outside the root: `../`, `..\`, symlink-free traversal and
    /// Windows drive-relative forms all collapse to the same check.
    pub fn resolve(&self, rel_path: &str) -> Result<String> {
        if rel_path.contains('\0') {
            return Err(OkfError::path_escape(rel_path));
        }
        let cleaned = rel_path.replace('\\', "/");
        let cleaned = cleaned.trim_start_matches('/');
        if nodepath::is_absolute(rel_path) || has_drive_prefix(rel_path) {
            // Accept an absolute path only when it already points inside the bundle.
            let abs = nodepath::resolve1(rel_path);
            if !is_contained(&self.root, &abs) {
                return Err(OkfError::path_escape(rel_path));
            }
            return Ok(abs);
        }
        let abs = nodepath::resolve(&[&self.root, cleaned]);
        if !is_contained(&self.root, &abs) {
            return Err(OkfError::path_escape(rel_path));
        }
        Ok(abs)
    }

    /// Convert an absolute path back to a `/`-separated bundle-relative one.
    pub fn to_rel(&self, abs_path: &str) -> String {
        to_posix(&nodepath::relative(&self.root, &nodepath::resolve1(abs_path)))
    }

    /// Path relative to the wiki root: this is what concept ids are built from.
    pub fn to_wiki_rel(&self, abs_path: &str) -> String {
        to_posix(&nodepath::relative(&self.wiki_root(), &nodepath::resolve1(abs_path)))
    }

    /// Bundle-relative path of a concept id.
    pub fn rel_path_of_id(&self, id: &str) -> String {
        let rel = format!("{}.md", to_posix(id));
        if self.wiki_dir.is_empty() {
            rel
        } else {
            format!("{}/{rel}", self.wiki_dir)
        }
    }

    /// Which layer a bundle-relative path belongs to, if any.
    pub fn layer_of(&self, rel_path: &str) -> Option<Layer> {
        let abs = nodepath::resolve(&[&self.root, &to_posix(rel_path)]);
        if is_contained(&self.raw_root(), &abs) {
            return Some(Layer::Raw);
        }
        if is_contained(&self.rag_root(), &abs) {
            return Some(Layer::Rag);
        }
        // skills/ and loops/ fall through to "wiki" on purpose: they are inside it.
        if is_contained(&self.wiki_root(), &abs) {
            return Some(Layer::Wiki);
        }
        None
    }

    /// Enforce the layer contract for writes.
    ///
    /// The rule is about *who*, not about which layer is precious. `raw/` is
    /// the human's inbox: it is the record of what was actually received, and
    /// material an agent produced was not received from anywhere. `wiki/` and
    /// `.rag/` are open to both.
    pub fn assert_writable(&self, rel_path: &str, by: Actor) -> Result<String> {
        let abs = self.resolve(rel_path)?;
        let layer = self.layer_of(&self.to_rel(&abs));
        if layer == Some(Layer::Raw) && by != Actor::Human {
            return Err(OkfError::layer_violation(rel_path, messages::RAW_IS_HUMAN_ONLY));
        }
        Ok(abs)
    }

    /// Whether this actor may move a file between these layers.
    ///
    /// Same rule as [`assert_writable`](Self::assert_writable), applied to both
    /// ends. Moving *out of* `raw/` is the moment somebody takes responsibility
    /// for unreviewed material, which is not a call an agent can make.
    pub fn assert_movable(&self, from: &str, to: &str, by: Actor) -> Result<()> {
        if by == Actor::Human {
            return Ok(());
        }
        if self.layer_of(&to_posix(from)) == Some(Layer::Raw) {
            return Err(OkfError::layer_violation(from, messages::RAW_PROMOTION_IS_HUMAN_ONLY));
        }
        if self.layer_of(&to_posix(to)) == Some(Layer::Raw) {
            return Err(OkfError::layer_violation(to, messages::RAW_IS_HUMAN_ONLY));
        }
        Ok(())
    }
}
