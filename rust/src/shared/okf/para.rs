//! PARA: Projects, Areas, Resources, Archive (`src/shared/okf/para.ts`).
//!
//! The four classes are an explicit *priority order*, not just four boxes. The
//! class is the *folder*, so archiving is a move a person can see and undo, and
//! ranking uses the same order: a passage from an active project outranks the
//! same passage from something shelved a year ago.

use crate::shared::js_compat::locale_compare;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParaClass {
    Project,
    Area,
    Resource,
    Archive,
}

impl ParaClass {
    /// The TS string value (`"project"`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Area => "area",
            Self::Resource => "resource",
            Self::Archive => "archive",
        }
    }

    /// Directory name, numbered so the tree sorts by priority on its own.
    pub fn dir(self) -> &'static str {
        match self {
            Self::Project => "1-projects",
            Self::Area => "2-areas",
            Self::Resource => "3-resources",
            Self::Archive => "4-archive",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Project => "プロジェクト",
            Self::Area => "エリア",
            Self::Resource => "リソース",
            Self::Archive => "アーカイブ",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Project => "現在進行中で、終わりのあるもの",
            Self::Area => "期日はないが、優先したい関心ごと",
            Self::Resource => "役に立つ知識。必要なときに参照する",
            Self::Archive => "現在使っていないもの。記録として残す",
        }
    }

    /// Retrieval weight, multiplied into the BM25 score so relevance decides
    /// *what* matches and PARA decides which of two comparable matches comes
    /// first. Archive is penalised rather than excluded.
    pub fn weight(self) -> f64 {
        match self {
            Self::Project => 1.5,
            Self::Area => 1.2,
            Self::Resource => 1.0,
            Self::Archive => 0.25,
        }
    }
}

/// Highest priority first. The order is the point of the method.
pub const PARA_ORDER: [ParaClass; 4] = [
    ParaClass::Project,
    ParaClass::Area,
    ParaClass::Resource,
    ParaClass::Archive,
];

/// Anything not filed anywhere is a Resource, the neutral, useful default.
pub const DEFAULT_PARA: ParaClass = ParaClass::Resource;

fn class_of_dir(dir: &str) -> Option<ParaClass> {
    PARA_ORDER.into_iter().find(|cls| cls.dir() == dir)
}

/// First path segment of a wiki-relative path, with `\` as `/` and no leading `/`.
fn first_segment(wiki_rel_path: &str) -> String {
    let normalized = wiki_rel_path.replace('\\', "/");
    normalized
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Which PARA class a wiki-relative path falls in.
///
/// Only the first segment counts: a folder called `1-projects` nested deeper is
/// just a folder, so the class of a note is always visible from its path.
pub fn para_of(wiki_rel_path: &str) -> ParaClass {
    class_of_dir(&first_segment(wiki_rel_path).to_lowercase()).unwrap_or(DEFAULT_PARA)
}

/// True when the path is filed in one of the four folders.
pub fn is_filed(wiki_rel_path: &str) -> bool {
    class_of_dir(&first_segment(wiki_rel_path).to_lowercase()).is_some()
}

pub fn is_archived(wiki_rel_path: &str) -> bool {
    para_of(wiki_rel_path) == ParaClass::Archive
}

/// Parse a user- or agent-supplied class name, tolerantly.
///
/// Accepts the folder name and the bare number too: an agent that read the tree
/// will have seen `1-projects`, not `project`.
pub fn parse_para_class(value: &str) -> Option<ParaClass> {
    let key = crate::shared::js_compat::js_trim(value).to_lowercase();
    if let Some(cls) = PARA_ORDER.into_iter().find(|cls| cls.as_str() == key) {
        return Some(cls);
    }
    if let Some(cls) = class_of_dir(&key) {
        return Some(cls);
    }
    match key.as_str() {
        "1" => Some(ParaClass::Project),
        "2" => Some(ParaClass::Area),
        "3" => Some(ParaClass::Resource),
        "4" => Some(ParaClass::Archive),
        _ => None,
    }
}

/// Where a note would live under a different class, keeping its sub-path.
///
/// `1-projects/q3/notes.md` -> archive -> `4-archive/q3/notes.md`. An unfiled
/// note keeps its whole path and gains a prefix, so filing something for the
/// first time does not flatten the structure someone already built.
pub fn reclassify(wiki_rel_path: &str, to: ParaClass) -> String {
    let normalized = wiki_rel_path.replace('\\', "/");
    let clean = normalized.trim_start_matches('/');
    let segments: Vec<&str> = clean.split('/').collect();
    let rest = if is_filed(clean) {
        &segments[1..]
    } else {
        &segments[..]
    };
    let mut out = vec![to.dir()];
    out.extend_from_slice(rest);
    out.join("/")
}

/// Sort comparator: priority order, then path (`localeCompare`, see
/// [`locale_compare`] for the ICU approximation).
pub fn by_para_priority(a: &str, b: &str) -> Ordering {
    let rank = |p: &str| {
        PARA_ORDER
            .iter()
            .position(|c| *c == para_of(p))
            .unwrap_or(0)
    };
    rank(a).cmp(&rank(b)).then_with(|| locale_compare(a, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_classes_are_in_priority_order() {
        let names: Vec<&str> = PARA_ORDER.iter().map(|c| c.as_str()).collect();
        assert_eq!(names, ["project", "area", "resource", "archive"]);
    }

    #[test]
    fn the_folder_decides_the_class() {
        assert_eq!(para_of("1-projects/q3.md"), ParaClass::Project);
        assert_eq!(para_of("2-areas/health.md"), ParaClass::Area);
        assert_eq!(para_of("3-resources/okf.md"), ParaClass::Resource);
        assert_eq!(para_of("4-archive/old.md"), ParaClass::Archive);
    }

    #[test]
    fn only_the_first_segment_counts() {
        // A folder called 1-projects nested deeper is just a folder.
        assert_eq!(
            para_of("3-resources/1-projects/note.md"),
            ParaClass::Resource
        );
    }

    #[test]
    fn anything_unfiled_is_a_resource() {
        assert_eq!(para_of("loose-note.md"), DEFAULT_PARA);
        assert_eq!(para_of("topics/deep/note.md"), ParaClass::Resource);
    }

    #[test]
    fn class_names_are_parsed_tolerantly() {
        // An agent that read the tree saw `4-archive`, not `archive`.
        assert_eq!(parse_para_class("archive"), Some(ParaClass::Archive));
        assert_eq!(parse_para_class("4-archive"), Some(ParaClass::Archive));
        assert_eq!(parse_para_class("4"), Some(ParaClass::Archive));
        assert_eq!(parse_para_class("Project"), Some(ParaClass::Project));
        assert_eq!(parse_para_class("nonsense"), None);
    }

    #[test]
    fn reclassifying_keeps_the_sub_path() {
        assert_eq!(
            reclassify("1-projects/q3/notes.md", ParaClass::Archive),
            "4-archive/q3/notes.md"
        );
        // Filing something for the first time must not flatten existing structure.
        assert_eq!(
            reclassify("topics/deep/note.md", ParaClass::Project),
            "1-projects/topics/deep/note.md"
        );
    }

    #[test]
    fn archive_ranks_far_below_everything_else() {
        assert!(ParaClass::Project.weight() > ParaClass::Area.weight());
        assert!(ParaClass::Area.weight() > ParaClass::Resource.weight());
        assert!(ParaClass::Resource.weight() > ParaClass::Archive.weight());
    }

    #[test]
    fn the_scaffolded_folders_sort_by_priority() {
        assert!(ParaClass::Project.dir().starts_with("1-"));
        assert!(ParaClass::Archive.dir().starts_with("4-"));
    }

    #[test]
    fn is_archived_reads_straight_off_the_path() {
        assert!(is_archived("4-archive/x.md"));
        assert!(!is_archived("1-projects/x.md"));
    }

    #[test]
    fn priority_then_path_ordering() {
        let mut paths = vec![
            "4-archive/a.md",
            "b.md",
            "1-projects/z.md",
            "1-projects/a.md",
        ];
        paths.sort_by(|a, b| by_para_priority(a, b));
        assert_eq!(
            paths,
            [
                "1-projects/a.md",
                "1-projects/z.md",
                "b.md",
                "4-archive/a.md"
            ]
        );
    }

    #[test]
    fn serializes_as_the_ts_string() {
        assert_eq!(
            serde_json::to_string(&ParaClass::Archive).unwrap(),
            "\"archive\""
        );
    }
}
