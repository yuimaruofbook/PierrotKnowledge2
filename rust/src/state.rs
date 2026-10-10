//! Session state that survives a restart (`src/bun/state.ts`).
//!
//! Without this the app opens blank every launch and the first thing a user
//! has to do, every single time, is find their folder again. The knowledge base
//! is still entirely in the Markdown files; this only remembers *which* folder
//! was open, so losing or deleting it costs one click, never any data.

use crate::app_paths::{app_data_path, app_data_read_paths};
use crate::okf::{error, nodepath};
use crate::shared::js_compat::{js_round, serialize_js_f64};
use serde::Serialize;
use serde_json::Value;

const FILE: &str = "session.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// Absolute path of the last opened bundle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_path: Option<String>,
    /// Bundle-relative path of the last opened document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_file: Option<String>,
    /// Width of the writing column, as a percentage of the pane.
    ///
    /// A view preference rather than knowledge, so it lives here beside the
    /// other things that would otherwise have to be redone on every launch.
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "serialize_opt_f64")]
    pub editor_width: Option<f64>,
}

fn serialize_opt_f64<S: serde::Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(v) => serialize_js_f64(v, s),
        None => s.serialize_none(),
    }
}

/// Where the OS expects an application to keep small state.
///
/// Deliberately outside the bundle: the bundle holds knowledge, and scattering
/// app preferences through it would break "the folder is just Markdown".
pub fn state_file_path() -> String {
    app_data_path(FILE)
}

/// Read the saved session.
///
/// Any failure (missing file, unreadable, corrupt JSON) yields an empty
/// session rather than an error. State this cheap to rebuild is never worth
/// failing a launch over.
pub fn load_session() -> SessionState {
    // Current location first, then the pre-rename one: an existing install
    // must still open on the folder it had open rather than coming up blank. A
    // miss moves on to the next candidate; only running out yields an empty one.
    for path in app_data_read_paths(FILE) {
        let Ok(text) = error::read_text(&path) else { continue };
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };

        let mut state = SessionState::default();
        if let Some(Value::String(s)) = record.get("bundlePath") {
            state.bundle_path = Some(s.clone());
        }
        if let Some(Value::String(s)) = record.get("lastFile") {
            state.last_file = Some(s.clone());
        }
        // Clamped on read: a hand-edited or older file must not be able to set
        // a width that leaves the text unreadable or off-screen.
        if let Some(Value::Number(n)) = record.get("editorWidth") {
            if let Some(w) = n.as_f64().filter(|w| w.is_finite()) {
                state.editor_width = Some(js_round(w).clamp(40.0, 100.0));
            }
        }
        return state;
    }

    SessionState::default()
}

pub fn save_session(state: &SessionState) {
    // Losing the pointer costs one click next launch; never surface it.
    let path = state_file_path();
    if error::mkdir_p(&nodepath::dirname(&path)).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = error::write_text(&path, &format!("{json}\n"));
    }
}

/// Merge a partial update into the saved session: fields set in `patch` win.
pub fn update_session(patch: &SessionState) {
    let mut state = load_session();
    if patch.bundle_path.is_some() {
        state.bundle_path = patch.bundle_path.clone();
    }
    if patch.last_file.is_some() {
        state.last_file = patch.last_file.clone();
    }
    if patch.editor_width.is_some() {
        state.editor_width = patch.editor_width;
    }
    save_session(&state);
}

pub fn clear_session() {
    // Nothing to do on failure; the next save overwrites it anyway.
    let _ = std::fs::remove_file(state_file_path());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The functions read the platform's data-directory variables, which are
    /// process-wide, so tests that point them at a temp dir take turns.
    static ENV: Mutex<()> = Mutex::new(());

    fn with_data_dir(f: impl FnOnce(&std::path::Path)) {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let old = (std::env::var("APPDATA").ok(), std::env::var("XDG_CONFIG_HOME").ok());
        // SAFETY: serialised by ENV; no other thread in this crate reads these.
        unsafe {
            std::env::set_var("APPDATA", dir.path());
            std::env::set_var("XDG_CONFIG_HOME", dir.path());
        }
        f(dir.path());
        unsafe {
            match old.0 {
                Some(v) => std::env::set_var("APPDATA", v),
                None => std::env::remove_var("APPDATA"),
            }
            match old.1 {
                Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
                None => std::env::remove_var("XDG_CONFIG_HOME"),
            }
        }
    }

    #[test]
    fn round_trips_and_merges() {
        if !cfg!(any(windows, target_os = "linux")) {
            return; // macOS keys off the home directory instead
        }
        with_data_dir(|_| {
            assert_eq!(load_session(), SessionState::default());
            save_session(&SessionState {
                bundle_path: Some("/b".into()),
                last_file: Some("a.md".into()),
                editor_width: Some(60.0),
            });
            update_session(&SessionState {
                last_file: Some("b.md".into()),
                ..Default::default()
            });
            let s = load_session();
            assert_eq!(s.bundle_path.as_deref(), Some("/b"));
            assert_eq!(s.last_file.as_deref(), Some("b.md"));
            assert_eq!(s.editor_width, Some(60.0));
            let text = std::fs::read_to_string(state_file_path()).unwrap();
            assert_eq!(
                text,
                "{\n  \"bundlePath\": \"/b\",\n  \"lastFile\": \"b.md\",\n  \"editorWidth\": 60\n}\n"
            );
            clear_session();
            assert_eq!(load_session(), SessionState::default());
        });
    }

    #[test]
    fn corrupt_or_odd_files_yield_defaults_and_width_is_clamped() {
        if !cfg!(any(windows, target_os = "linux")) {
            return;
        }
        with_data_dir(|_| {
            let path = state_file_path();
            std::fs::create_dir_all(nodepath::dirname(&path)).unwrap();
            std::fs::write(&path, "{not json").unwrap();
            assert_eq!(load_session(), SessionState::default());
            std::fs::write(&path, "[1]").unwrap();
            assert_eq!(load_session(), SessionState::default());
            std::fs::write(&path, r#"{"bundlePath":5,"editorWidth":500}"#).unwrap();
            let s = load_session();
            assert_eq!(s.bundle_path, None);
            assert_eq!(s.editor_width, Some(100.0));
            std::fs::write(&path, r#"{"editorWidth":3.4}"#).unwrap();
            assert_eq!(load_session().editor_width, Some(40.0));
        });
    }

    #[test]
    fn falls_back_to_the_legacy_folder() {
        if !cfg!(windows) {
            return;
        }
        with_data_dir(|dir| {
            let legacy = dir.join(crate::shared::app::LEGACY_APP_DIR);
            std::fs::create_dir_all(&legacy).unwrap();
            std::fs::write(legacy.join("session.json"), r#"{"bundlePath":"/old"}"#).unwrap();
            assert_eq!(load_session().bundle_path.as_deref(), Some("/old"));
            save_session(&SessionState {
                bundle_path: Some("/new".into()),
                ..Default::default()
            });
            assert_eq!(load_session().bundle_path.as_deref(), Some("/new"));
        });
    }
}
