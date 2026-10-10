//! Where this app keeps small per-user files, and where it used to
//! (`src/bun/app-paths.ts`).
//!
//! The application data folder carries the app's display name, so renaming the
//! app moves it. An existing install has a session and a registry of MCP
//! servers in the old folder; moving without looking there would present as
//! data loss, with the app coming up blank and every connection gone.
//!
//! So writes go to the current location and reads fall back to the previous
//! one. Nothing is copied or deleted behind the user's back: the old file stays
//! where it is until they overwrite it by saving.

use crate::okf::nodepath;
use crate::shared::app::{APP_DIR, APP_ID, LEGACY_APP_DIR};

fn home_dir() -> String {
    std::env::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn base_for(dir_name: &str) -> String {
    if cfg!(windows) {
        let base = std::env::var("APPDATA")
            .unwrap_or_else(|_| nodepath::join(&[&home_dir(), "AppData", "Roaming"]));
        return nodepath::join(&[&base, dir_name]);
    }
    if cfg!(target_os = "macos") {
        return nodepath::join(&[&home_dir(), "Library", "Application Support", dir_name]);
    }
    // Linux uses the stable machine id rather than the display name, so it is
    // unaffected by the rename and needs no fallback.
    let base = std::env::var("XDG_CONFIG_HOME")
        .unwrap_or_else(|_| nodepath::join(&[&home_dir(), ".config"]));
    nodepath::join(&[&base, APP_ID])
}

/// The path to write to.
pub fn app_data_path(file: &str) -> String {
    nodepath::join(&[&base_for(APP_DIR), file])
}

/// Paths to try when reading, current first.
///
/// One entry on Linux, where the directory never changed.
pub fn app_data_read_paths(file: &str) -> Vec<String> {
    let current = app_data_path(file);
    let legacy = nodepath::join(&[&base_for(LEGACY_APP_DIR), file]);
    if current == legacy {
        vec![current]
    } else {
        vec![current, legacy]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_paths_put_the_current_location_first() {
        let paths = app_data_read_paths("session.json");
        assert_eq!(paths[0], app_data_path("session.json"));
        if cfg!(any(windows, target_os = "macos")) {
            assert_eq!(paths.len(), 2);
            assert!(paths[0].contains(APP_DIR));
            assert!(paths[1].contains(LEGACY_APP_DIR));
        }
    }
}
