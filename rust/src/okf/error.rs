//! Errors and filesystem helpers shared by the bundle layer.
//!
//! The TypeScript original lets Node's `fs` errors propagate, and their
//! messages reach agents verbatim (`ENOENT: no such file or directory, open
//! '...'`). A parity test compares those strings, so the helpers here name the
//! failing syscall and format the message the way Node/Bun do.

use crate::shared::messages;
use std::fmt;
use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// A filesystem failure, formatted like a Node `fs` error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsError {
    /// `ENOENT`, `EEXIST`, ...
    pub code: &'static str,
    /// The failing call as Node names it: `open`, `mkdir`, `stat`, ...
    pub syscall: &'static str,
    /// The path as the caller passed it. `None` where Node omits it (EISDIR on read).
    pub path: Option<String>,
    /// Second path for `rename` and `copyfile`.
    pub dest: Option<String>,
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self.code {
            "ENOENT" => "no such file or directory",
            "EEXIST" => "file already exists",
            "EACCES" => "permission denied",
            "EPERM" => "operation not permitted",
            "EISDIR" => "illegal operation on a directory",
            "ENOTDIR" => "not a directory",
            "ENOTEMPTY" => "directory not empty",
            "EBUSY" => "resource busy or locked",
            _ => "i/o error",
        };
        write!(f, "{}: {text}, {}", self.code, self.syscall)?;
        if let Some(path) = &self.path {
            write!(f, " '{path}'")?;
            if let Some(dest) = &self.dest {
                write!(f, " -> '{dest}'")?;
            }
        }
        Ok(())
    }
}

/// Everything the bundle layer can fail with. `Display` is the TS
/// `error.message`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OkfError {
    /// `PathEscapeError`
    PathEscape(String),
    /// `LayerViolationError`
    LayerViolation(String),
    /// A filesystem error from Node's `fs`.
    Fs(FsError),
    /// A plain `Error(message)`.
    Message(String),
}

impl OkfError {
    pub fn message(msg: impl Into<String>) -> Self {
        Self::Message(msg.into())
    }

    /// `PathEscapeError(path)`.
    pub fn path_escape(path: &str) -> Self {
        Self::PathEscape(messages::path_escapes_bundle(path))
    }

    /// `LayerViolationError(path, reason)`.
    pub fn layer_violation(path: &str, reason: &str) -> Self {
        Self::LayerViolation(messages::layer_violation(reason, path))
    }

    /// The JS `error.name`, where callers branch on it.
    pub fn name(&self) -> &'static str {
        match self {
            Self::PathEscape(_) => "PathEscapeError",
            Self::LayerViolation(_) => "LayerViolationError",
            _ => "Error",
        }
    }
}

impl fmt::Display for OkfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PathEscape(m) | Self::LayerViolation(m) | Self::Message(m) => f.write_str(m),
            Self::Fs(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for OkfError {}

impl From<FsError> for OkfError {
    fn from(e: FsError) -> Self {
        Self::Fs(e)
    }
}

pub type Result<T> = std::result::Result<T, OkfError>;

/// Map an `io::Error` onto the Node error code it would have carried.
fn code_of(e: &io::Error) -> &'static str {
    if let Some(os) = e.raw_os_error() {
        if cfg!(windows) {
            match os {
                2 | 3 | 123 => return "ENOENT",
                5 => return "EPERM",
                32 => return "EBUSY",
                80 | 183 => return "EEXIST",
                145 => return "ENOTEMPTY",
                267 => return "ENOTDIR",
                _ => {}
            }
        }
    }
    match e.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        _ => "EIO",
    }
}

fn fs_error(e: &io::Error, syscall: &'static str, path: &str) -> FsError {
    FsError {
        code: code_of(e),
        syscall,
        path: Some(path.to_string()),
        dest: None,
    }
}

/// `fs.stat`: metadata, or the Node error.
pub fn stat(path: &str) -> std::result::Result<fs::Metadata, FsError> {
    fs::metadata(path).map_err(|e| fs_error(&e, "stat", path))
}

/// `stat(path)` succeeded.
pub fn path_exists(path: &str) -> bool {
    fs::metadata(path).is_ok()
}

/// `stat(path)` succeeded and it is a directory.
pub fn is_directory(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_dir())
}

/// `stat(path)` succeeded and it is a regular file.
pub fn is_file(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// `stat(path).mtimeMs`, computed as Node does (`sec * 1e3 + nsec / 1e6`).
pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    match meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()) {
        Some(d) => d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6,
        None => 0.0,
    }
}

/// `readFile(path)` as bytes.
pub fn read_bytes(path: &str) -> std::result::Result<Vec<u8>, FsError> {
    fs::read(path).map_err(|e| {
        if Path::new(path).is_dir() {
            // Node reports the read, not the open, and omits the path.
            return FsError {
                code: "EISDIR",
                syscall: "read",
                path: None,
                dest: None,
            };
        }
        fs_error(&e, "open", path)
    })
}

/// `readFile(path, "utf8")`: invalid sequences become U+FFFD, a BOM is kept.
pub fn read_text(path: &str) -> std::result::Result<String, FsError> {
    Ok(String::from_utf8_lossy(&read_bytes(path)?).into_owned())
}

/// `writeFile(path, content, "utf8")`.
pub fn write_text(path: &str, content: &str) -> std::result::Result<(), FsError> {
    write_bytes(path, content.as_bytes())
}

/// `writeFile(path, bytes)`.
pub fn write_bytes(path: &str, content: &[u8]) -> std::result::Result<(), FsError> {
    fs::write(path, content).map_err(|e| {
        if Path::new(path).is_dir() {
            // Bun reports opening a directory for writing as EEXIST.
            return FsError {
                code: "EEXIST",
                syscall: "open",
                path: Some(path.to_string()),
                dest: None,
            };
        }
        fs_error(&e, "open", path)
    })
}

/// `mkdir(path, { recursive: true })`.
pub fn mkdir_p(path: &str) -> std::result::Result<(), FsError> {
    fs::create_dir_all(path).map_err(|e| fs_error(&e, "mkdir", path))
}

/// `rename(from, to)`.
pub fn rename(from: &str, to: &str) -> std::result::Result<(), FsError> {
    fs::rename(from, to).map_err(|e| FsError {
        code: code_of(&e),
        syscall: "rename",
        path: Some(from.to_string()),
        dest: Some(to.to_string()),
    })
}

/// `copyFile(from, to)`.
pub fn copy_file(from: &str, to: &str) -> std::result::Result<(), FsError> {
    fs::copy(from, to).map(|_| ()).map_err(|e| FsError {
        code: code_of(&e),
        syscall: "copyfile",
        path: Some(from.to_string()),
        dest: Some(to.to_string()),
    })
}

/// `rm(path, { recursive, force: false })`.
pub fn remove(path: &str, recursive: bool) -> std::result::Result<(), FsError> {
    let meta = fs::symlink_metadata(path).map_err(|e| fs_error(&e, "rm", path))?;
    let result = if meta.is_dir() {
        if recursive {
            fs::remove_dir_all(path)
        } else {
            return Err(FsError {
                code: "EISDIR",
                syscall: "rm",
                path: Some(path.to_string()),
                dest: None,
            });
        }
    } else {
        fs::remove_file(path)
    };
    result.map_err(|e| fs_error(&e, "rm", path))
}

/// One `readdir(path, { withFileTypes: true })` entry.
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    /// `isDirectory()`: a symlink to a directory is not one, as in Node.
    pub is_dir: bool,
    /// `isFile()`.
    pub is_file: bool,
}

/// `readdir(path, { withFileTypes: true })`, in the order the OS returns.
pub fn read_dir(path: &str) -> std::result::Result<Vec<DirEntry>, FsError> {
    let iter = fs::read_dir(path).map_err(|e| fs_error(&e, "scandir", path))?;
    let mut out = Vec::new();
    for entry in iter {
        let entry = entry.map_err(|e| fs_error(&e, "scandir", path))?;
        let ty = entry.file_type().map_err(|e| fs_error(&e, "scandir", path))?;
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: ty.is_dir(),
            is_file: ty.is_file(),
        });
    }
    Ok(out)
}

/// `readdir(path)` names only.
pub fn read_dir_names(path: &str) -> std::result::Result<Vec<String>, FsError> {
    Ok(read_dir(path)?.into_iter().map(|e| e.name).collect())
}

/// The ISO 8601 form of `new Date().toISOString()`.
pub fn now_iso() -> String {
    iso_of(chrono::Utc::now())
}

/// `date.toISOString()`.
pub fn iso_of(date: chrono::DateTime<chrono::Utc>) -> String {
    date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
