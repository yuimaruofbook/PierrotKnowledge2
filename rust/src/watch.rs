//! Filesystem watching (`src/bun/watch.ts`).
//!
//! The symmetry principle only holds if an edit made outside the app is
//! indistinguishable from one made inside it. Without a watcher, a file an
//! agent writes over MCP stays invisible to the open editor until reopened.
//!
//! The TS fires its callback from a timer. This port has no event loop, so the
//! owner calls [`BundleWatcher::poll`] between requests; the debounce is
//! measured from the last event, as in the TS.

use indexmap::IndexSet;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

/// Coalescing window; editors emit several events per save.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(120);

const IGNORED_SEGMENTS: [&str; 4] = [".rag", ".git", ".obsidian", "node_modules"];
const IGNORED_SUFFIXES: [&str; 4] = ["~", ".tmp", ".swp", ".crswap"];

/// Whether a bundle-relative, `/`-separated path is noise rather than an edit.
pub fn should_ignore(rel_path: &str) -> bool {
    if rel_path.is_empty() {
        return true;
    }
    let segments: Vec<&str> = rel_path.split('/').collect();
    if segments.iter().any(|s| IGNORED_SEGMENTS.contains(s)) {
        return true;
    }
    // Editors write `.foo.md.swp`-style siblings during a save.
    let name = segments.last().copied().unwrap_or("");
    if name.starts_with('.') {
        return true;
    }
    IGNORED_SUFFIXES.iter().any(|s| name.ends_with(s))
}

pub struct BundleWatcher {
    root: PathBuf,
    debounce: Duration,
    on_error: Rc<dyn Fn(&str)>,
    watcher: Option<RecommendedWatcher>,
    rx: Option<Receiver<notify::Result<Event>>>,
    pending: IndexSet<String>,
    last_event: Option<Instant>,
}

impl BundleWatcher {
    /// `on_error` receives watcher failures as text; losing live refresh is a
    /// degraded experience, not a broken app.
    pub fn new(root: &str, debounce: Option<Duration>, on_error: Rc<dyn Fn(&str)>) -> Self {
        Self {
            root: PathBuf::from(root),
            debounce: debounce.unwrap_or(DEFAULT_DEBOUNCE),
            on_error,
            watcher: None,
            rx: None,
            pending: IndexSet::new(),
            last_event: None,
        }
    }

    pub fn start(&mut self) -> bool {
        if self.watcher.is_some() {
            return true;
        }
        let (tx, rx) = channel();
        let result = notify::recommended_watcher(tx)
            .and_then(|mut w| w.watch(&self.root, RecursiveMode::Recursive).map(|()| w));
        match result {
            Ok(watcher) => {
                self.watcher = Some(watcher);
                self.rx = Some(rx);
                true
            }
            Err(error) => {
                (self.on_error)(&error.to_string());
                false
            }
        }
    }

    /// Bundle-relative `/`-separated path of an event path, if it is inside the root.
    fn relative(&self, path: &Path) -> Option<String> {
        let rel = match path.strip_prefix(&self.root) {
            Ok(rel) => rel.to_path_buf(),
            Err(_) => {
                // Windows paths compare case-insensitively.
                let root = self.root.to_string_lossy().replace('\\', "/").to_lowercase();
                let full = path.to_string_lossy().replace('\\', "/");
                let lowered = full.to_lowercase();
                let root = root.trim_end_matches('/');
                let rest = lowered.strip_prefix(root)?;
                if !rest.is_empty() && !rest.starts_with('/') {
                    return None;
                }
                // Same byte length: lowercasing ASCII path prefixes keeps offsets.
                let tail = full.get(root.len()..)?;
                return Some(tail.trim_start_matches('/').to_string());
            }
        };
        Some(
            rel.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/"),
        )
    }

    fn drain(&mut self) {
        let mut events = Vec::new();
        if let Some(rx) = &self.rx {
            while let Ok(event) = rx.try_recv() {
                events.push(event);
            }
        }
        for event in events {
            match event {
                Err(error) => (self.on_error)(&error.to_string()),
                Ok(event) => {
                    if matches!(event.kind, EventKind::Access(_)) {
                        continue;
                    }
                    for path in &event.paths {
                        let Some(rel) = self.relative(path) else { continue };
                        if should_ignore(&rel) {
                            continue;
                        }
                        self.pending.insert(rel);
                        self.last_event = Some(Instant::now());
                    }
                }
            }
        }
    }

    /// Collect new events and return the changed paths once the debounce
    /// window has passed without a further event.
    pub fn poll(&mut self) -> Vec<String> {
        self.drain();
        match self.last_event {
            Some(at) if !self.pending.is_empty() && at.elapsed() >= self.debounce => {
                self.last_event = None;
                self.pending.drain(..).collect()
            }
            _ => Vec::new(),
        }
    }

    /// Suppress events for a path the app is about to write itself, so a save
    /// does not bounce back as an "external change".
    pub fn ignore_next(&mut self, rel_path: &str) {
        self.pending.shift_remove(rel_path);
    }

    pub fn stop(&mut self) {
        self.pending.clear();
        self.last_event = None;
        self.watcher = None;
        self.rx = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_noise() {
        assert!(should_ignore(""));
        assert!(should_ignore(".rag/fts.sqlite"));
        assert!(should_ignore("wiki/.git/HEAD"));
        assert!(should_ignore("wiki/.hidden.md"));
        assert!(should_ignore("wiki/a.md~"));
        assert!(should_ignore("wiki/a.md.swp"));
        assert!(should_ignore("node_modules/x.md"));
        assert!(!should_ignore("wiki/a.md"));
    }

    #[test]
    fn reports_changes_after_debounce() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut w = BundleWatcher::new(&root, Some(Duration::from_millis(50)), Rc::new(|_| {}));
        assert!(w.start());
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        std::fs::write(dir.path().join("b.tmp"), "x").unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        while Instant::now() < deadline && seen.is_empty() {
            std::thread::sleep(Duration::from_millis(30));
            seen = w.poll();
        }
        assert_eq!(seen, vec!["a.md".to_string()]);
    }

    #[test]
    fn ignore_next_drops_a_pending_path() {
        let mut w = BundleWatcher::new("/x", None, Rc::new(|_| {}));
        w.pending.insert("a.md".into());
        w.ignore_next("a.md");
        assert!(w.pending.is_empty());
    }
}
