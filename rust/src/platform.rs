//! The two things the RPC handlers cannot do by themselves
//! (`src/bun/platform.ts`): picking a folder needs a native dialog, and
//! opening a URL needs whatever the host uses to hand it to the OS.
//!
//! They are injected rather than imported so the same handlers serve a
//! browser-served front end, a test, or a container with no desktop session.
//!
//! The TS dedupes concurrent dialogs by sharing one pending promise. Calls here
//! are synchronous, so a second caller waits for the first dialog to close
//! (a lock) and then opens its own.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;

pub trait Platform: Send + Sync {
    /// Ask the user for a folder, or `None` when this host cannot ask.
    ///
    /// `None` is a real answer, not a failure: a host with no desktop session
    /// has no way to show a dialog, and the caller falls back to asking for the
    /// path as text. `start` is where the dialog opens.
    fn pick_directory(&self, start: Option<&str>) -> Option<String>;

    /// Hand a URL to the OS. Returns false when it was refused.
    fn open_external(&self, url: &str) -> bool;
}

/// The browser-served host, with nothing native behind it.
pub struct BrowserPlatform;

impl Platform for BrowserPlatform {
    fn pick_directory(&self, _start: Option<&str>) -> Option<String> {
        None
    }
    fn open_external(&self, _url: &str) -> bool {
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogCommand {
    pub command: String,
    pub args: Vec<String>,
}

/// What asking for a folder can end in.
///
/// `Unavailable` and `Cancelled` are deliberately different: a missing
/// `zenity` means try the next candidate, while a user who pressed Cancel must
/// not be shown a second dialog for having declined the first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogOutcome {
    Picked(String),
    Cancelled,
    Unavailable,
}

/// Wrap a value for PowerShell's single-quoted string literal.
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Wrap a value for an AppleScript double-quoted string literal.
fn as_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The Windows dialog, as a script for `powershell.exe`.
///
/// `-STA` is not optional: WinForms requires a single-threaded apartment. The
/// dummy owner form is the difference between a dialog the user sees and one
/// that opens behind the browser window they were just looking at.
fn windows_script(title: &str, start: Option<&str>) -> String {
    let mut lines = vec![
        "Add-Type -AssemblyName System.Windows.Forms".to_string(),
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog".to_string(),
        // The title bar is the OS's own; the wording goes in the label.
        format!("$d.Description = {}", ps_quote(title)),
        "$d.ShowNewFolderButton = $true".to_string(),
    ];
    if let Some(start) = start.filter(|s| !s.is_empty()) {
        lines.push(format!("$d.SelectedPath = {}", ps_quote(start)));
    }
    lines.extend([
        "$owner = New-Object System.Windows.Forms.Form".to_string(),
        "$owner.TopMost = $true".to_string(),
        "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }".to_string(),
        "$owner.Dispose()".to_string(),
    ]);
    lines.join("\n")
}

/// Every way this OS might be able to show a folder dialog, best first.
///
/// A list rather than one command because Linux has no single answer: GNOME
/// ships `zenity`, KDE ships `kdialog`, and a machine may have either, both or
/// neither. `title` empty means the default title.
pub fn folder_dialog_commands(platform: &str, title: &str, start: Option<&str>) -> Vec<DialogCommand> {
    let title = if title.is_empty() { "フォルダを選択" } else { title };
    let start = start.filter(|s| !s.is_empty());
    let cmd = |command: &str, args: Vec<String>| DialogCommand {
        command: command.to_string(),
        args,
    };

    match platform {
        "win32" => vec![cmd(
            "powershell.exe",
            vec!["-NoProfile".into(), "-STA".into(), "-Command".into(), windows_script(title, start)],
        )],
        "darwin" => {
            let prompt = format!("choose folder with prompt {}", as_quote(title));
            let with_start = match start {
                Some(s) => format!("{prompt} default location POSIX file {}", as_quote(s)),
                None => prompt,
            };
            vec![cmd("osascript", vec!["-e".into(), format!("POSIX path of ({with_start})")])]
        }
        "linux" => {
            let mut zenity = vec![
                "--file-selection".to_string(),
                "--directory".to_string(),
                format!("--title={title}"),
            ];
            if let Some(s) = start {
                // `start.replace(/\/?$/, "/")`: exactly one trailing slash.
                let with_slash = if s.ends_with('/') { s.to_string() } else { format!("{s}/") };
                zenity.push(format!("--filename={with_slash}"));
            }
            vec![
                cmd("zenity", zenity),
                cmd("kdialog", vec!["--getexistingdirectory".into(), start.unwrap_or(".").to_string()]),
            ]
        }
        // An OS we have no dialog for. Saying so is better than spawning
        // something that is not there and reporting its ENOENT as a failed pick.
        _ => Vec::new(),
    }
}

/// Turn a dialog's stdout into a path.
///
/// macOS returns a POSIX path with a trailing slash, which is the same folder
/// but not the same string, and this value goes on to be compared against
/// bundle roots.
pub fn parse_folder_dialog_output(stdout: &str) -> Option<String> {
    let trimmed = crate::shared::js_compat::js_trim(stdout);
    if trimmed.is_empty() {
        return None;
    }
    // `/(?<=.)[/\\]+$/`: trailing separators, but never the first character.
    let mut chars = trimmed.char_indices();
    let first_len = chars.next().map_or(0, |(_, c)| c.len_utf8());
    let rest = &trimmed[first_len..];
    let kept = rest.trim_end_matches(['/', '\\']);
    let without = &trimmed[..first_len + kept.len()];
    Some(if without.is_empty() { trimmed } else { without }.to_string())
}

/// Try each candidate until one of them actually asks the user.
///
/// Split from the spawning so the order, and the rule that a cancel stops the
/// search, can be tested without a desktop session.
pub fn run_folder_dialog(
    candidates: &[DialogCommand],
    run: &mut dyn FnMut(&DialogCommand) -> DialogOutcome,
) -> Option<String> {
    for candidate in candidates {
        match run(candidate) {
            DialogOutcome::Picked(path) => return Some(path),
            DialogOutcome::Cancelled => return None,
            DialogOutcome::Unavailable => {}
        }
    }
    None
}

/// Spawn one dialog and classify how it ended.
fn spawn_dialog(candidate: &DialogCommand) -> DialogOutcome {
    let Ok(mut child) = Command::new(&candidate.command)
        .args(&candidate.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        // Not installed. The next candidate may be.
        return DialogOutcome::Unavailable;
    };

    let mut bytes = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_end(&mut bytes);
    }
    let code = child.wait().ok().and_then(|s| s.code());

    let path = parse_folder_dialog_output(&String::from_utf8_lossy(&bytes));
    if let (Some(0), Some(path)) = (code, path) {
        return DialogOutcome::Picked(path);
    }

    // Everything else is a user who declined: `zenity` and `osascript` both
    // exit non-zero for Cancel, and Windows simply prints nothing. A dialog
    // that failed for its own reasons lands here too, and `None` is the right
    // answer for that as well.
    DialogOutcome::Cancelled
}

/// The OS opener, by platform.
///
/// `start` needs its empty-title argument on Windows, or a quoted URL is read
/// as the window title and nothing opens.
fn open_command(platform: &str, url: &str) -> Option<DialogCommand> {
    let (command, args): (&str, Vec<&str>) = match platform {
        "win32" => ("cmd", vec!["/c", "start", "", url]),
        "darwin" => ("open", vec![url]),
        "linux" => ("xdg-open", vec![url]),
        _ => return None,
    };
    Some(DialogCommand {
        command: command.to_string(),
        args: args.into_iter().map(str::to_string).collect(),
    })
}

/// `process.platform`.
pub fn current_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// The browser-served host, using the desktop session it is running on.
pub struct NativePlatform;

static DIALOG_LOCK: Mutex<()> = Mutex::new(());

impl Platform for NativePlatform {
    fn pick_directory(&self, start: Option<&str>) -> Option<String> {
        let _guard = DIALOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let candidates = folder_dialog_commands(current_platform(), "バンドルのフォルダを選択", start);
        let picked = run_folder_dialog(&candidates, &mut |c| spawn_dialog(c))?;
        // A dialog cannot normally return a folder that is not there, but this
        // value becomes a bundle root, so it is checked rather than trusted.
        crate::okf::error::is_directory(&picked).then_some(picked)
    }

    fn open_external(&self, url: &str) -> bool {
        let Some(command) = open_command(current_platform(), url) else {
            return false;
        };
        Command::new(&command.command)
            .args(&command.args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_commands_per_platform() {
        let win = folder_dialog_commands("win32", "T", Some("C:\\it's"));
        assert_eq!(win.len(), 1);
        assert_eq!(win[0].command, "powershell.exe");
        assert_eq!(win[0].args[..3], ["-NoProfile", "-STA", "-Command"]);
        assert!(win[0].args[3].contains("$d.Description = 'T'"));
        assert!(win[0].args[3].contains("$d.SelectedPath = 'C:\\it''s'"));

        let mac = folder_dialog_commands("darwin", "", Some("/a\"b"));
        assert_eq!(
            mac[0].args[1],
            "POSIX path of (choose folder with prompt \"フォルダを選択\" default location POSIX file \"/a\\\"b\")"
        );

        let linux = folder_dialog_commands("linux", "T", Some("/home/u"));
        assert_eq!(linux.len(), 2);
        assert!(linux[0].args.contains(&"--filename=/home/u/".to_string()));
        assert_eq!(linux[1].args, ["--getexistingdirectory", "/home/u"]);
        assert!(folder_dialog_commands("freebsd", "T", None).is_empty());
    }

    #[test]
    fn output_loses_trailing_separators_but_not_the_root() {
        assert_eq!(parse_folder_dialog_output("  /Users/a/\n"), Some("/Users/a".into()));
        assert_eq!(parse_folder_dialog_output("C:\\x\\\\"), Some("C:\\x".into()));
        assert_eq!(parse_folder_dialog_output("/"), Some("/".into()));
        assert_eq!(parse_folder_dialog_output("   "), None);
    }

    #[test]
    fn a_cancel_stops_the_search_and_unavailable_moves_on() {
        let cmds = folder_dialog_commands("linux", "T", None);
        let mut seen = Vec::new();
        let picked = run_folder_dialog(&cmds, &mut |c| {
            seen.push(c.command.clone());
            if c.command == "zenity" {
                DialogOutcome::Unavailable
            } else {
                DialogOutcome::Picked("/x".into())
            }
        });
        assert_eq!(picked.as_deref(), Some("/x"));
        assert_eq!(seen, ["zenity", "kdialog"]);

        let mut calls = 0;
        let cancelled = run_folder_dialog(&cmds, &mut |_| {
            calls += 1;
            DialogOutcome::Cancelled
        });
        assert_eq!((cancelled, calls), (None, 1));
    }

    #[test]
    fn opener_commands() {
        assert_eq!(open_command("win32", "u").unwrap().args, ["/c", "start", "", "u"]);
        assert!(open_command("plan9", "u").is_none());
        assert!(!BrowserPlatform.open_external("u"));
        assert_eq!(BrowserPlatform.pick_directory(None), None);
    }
}

/// The assertions of `test/platform.test.ts` that the compact tests above do
/// not spell out one by one.
#[cfg(test)]
mod ts_parity_tests {
    use super::*;

    fn last_arg(c: &DialogCommand) -> &str {
        c.args.last().unwrap()
    }

    #[test]
    fn windows_uses_powershell_exe_in_a_single_threaded_apartment() {
        let commands = folder_dialog_commands("win32", "選択", None);
        assert_eq!(commands.len(), 1);
        let command = &commands[0];
        assert_eq!(command.command, "powershell.exe");
        assert!(command.args.contains(&"-STA".to_string()));
        assert!(command.args.contains(&"-NoProfile".to_string()));
        assert!(last_arg(command).contains("FolderBrowserDialog"));
        assert!(last_arg(command).contains("選択"));
    }

    #[test]
    fn windows_opens_the_dialog_in_front_of_the_browser_window() {
        let commands = folder_dialog_commands("win32", "x", None);
        let script = last_arg(&commands[0]);
        assert!(script.contains("$owner.TopMost = $true"));
        assert!(script.contains("ShowDialog($owner)"));
    }

    #[test]
    fn windows_carries_the_wording_on_the_label_not_the_title_bar() {
        let commands = folder_dialog_commands("win32", "選択", None);
        let script = last_arg(&commands[0]);
        assert!(script.contains("$d.Description = '選択'"));
        assert!(!script.contains("UseDescriptionForTitle ="));
    }

    #[test]
    fn a_quote_in_the_title_cannot_break_out_of_the_powershell_literal() {
        let commands = folder_dialog_commands("win32", "it's here", None);
        assert!(last_arg(&commands[0]).contains("'it''s here'"));
    }

    #[test]
    fn macos_asks_applescript_for_a_posix_path() {
        let commands = folder_dialog_commands("darwin", "選択", None);
        assert_eq!(commands[0].command, "osascript");
        assert_eq!(commands[0].args[0], "-e");
        assert!(commands[0].args[1].contains("choose folder"));
        // Without this the script returns an alias, not something openable.
        assert!(commands[0].args[1].contains("POSIX path of"));
    }

    #[test]
    fn a_quote_in_the_title_cannot_break_out_of_the_applescript_literal() {
        let commands = folder_dialog_commands("darwin", "say \"hi\"", None);
        assert!(commands[0].args[1].contains("\\\"hi\\\""));
    }

    #[test]
    fn linux_offers_both_toolkits_gnome_first() {
        let commands = folder_dialog_commands("linux", "選択", None);
        let names: Vec<&str> = commands.iter().map(|c| c.command.as_str()).collect();
        assert_eq!(names, ["zenity", "kdialog"]);
        assert!(commands[0].args.contains(&"--directory".to_string()));
        assert!(commands[1].args.contains(&"--getexistingdirectory".to_string()));
    }

    #[test]
    fn the_starting_folder_is_passed_through_when_there_is_one() {
        assert!(last_arg(&folder_dialog_commands("win32", "x", Some("C:/notes"))[0]).contains("C:/notes"));
        assert!(folder_dialog_commands("darwin", "x", Some("/notes"))[0].args[1].contains("/notes"));
        assert!(folder_dialog_commands("linux", "x", Some("/notes"))[0].args.join(" ").contains("/notes"));
    }

    #[test]
    fn output_takes_the_path_off_the_line_and_nothing_chosen_is_none() {
        assert_eq!(
            parse_folder_dialog_output("C:\\Users\\me\\notes\r\n").as_deref(),
            Some("C:\\Users\\me\\notes")
        );
        assert_eq!(parse_folder_dialog_output("/Users/me/notes/\n").as_deref(), Some("/Users/me/notes"));
        assert_eq!(parse_folder_dialog_output(""), None);
        assert_eq!(parse_folder_dialog_output("  \n "), None);
    }

    #[test]
    fn run_returns_the_first_answer_and_tries_nothing_after_it() {
        let command = |name: &str| DialogCommand { command: name.into(), args: vec![] };
        let mut tried: Vec<String> = Vec::new();
        let picked = run_folder_dialog(&[command("zenity"), command("kdialog")], &mut |c| {
            tried.push(c.command.clone());
            DialogOutcome::Picked("/notes".into())
        });
        assert_eq!(picked.as_deref(), Some("/notes"));
        assert_eq!(tried, ["zenity"]);
        assert_eq!(run_folder_dialog(&[], &mut |_| DialogOutcome::Picked("/x".into())), None);
    }
}
