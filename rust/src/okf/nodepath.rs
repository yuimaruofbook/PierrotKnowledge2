//! The parts of Node's `path` module the bundle layer relies on.
//!
//! `std::path` normalises differently (it keeps `..` against a relative base,
//! treats `C:foo` as a prefix, and so on). Containment checks run on the
//! result of `resolve`, so the exact algorithm is ported rather than
//! approximated. On Windows the `win32` flavour applies, elsewhere `posix`.

/// Path separator of the host (`path.sep`).
#[cfg(windows)]
pub const SEP: char = '\\';
#[cfg(not(windows))]
pub const SEP: char = '/';

fn current_dir() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| if cfg!(windows) { "C:\\".into() } else { "/".into() })
}

/// `path.resolve(...parts)`.
pub fn resolve(parts: &[&str]) -> String {
    if cfg!(windows) {
        win32_resolve(parts, &current_dir())
    } else {
        posix_resolve(parts, &current_dir())
    }
}

/// `path.resolve(a)`.
pub fn resolve1(a: &str) -> String {
    resolve(&[a])
}

/// `path.join(...parts)`.
pub fn join(parts: &[&str]) -> String {
    if cfg!(windows) {
        win32_join(parts)
    } else {
        posix_join(parts)
    }
}

/// `path.isAbsolute(p)`.
pub fn is_absolute(p: &str) -> bool {
    if cfg!(windows) {
        let b: Vec<char> = p.chars().take(3).collect();
        match b.as_slice() {
            [c, ..] if is_sep(*c) => true,
            [d, ':', s, ..] => d.is_ascii_alphabetic() && is_sep(*s),
            _ => false,
        }
    } else {
        p.starts_with('/')
    }
}

/// `path.relative(from, to)`.
pub fn relative(from: &str, to: &str) -> String {
    if cfg!(windows) {
        win32_relative(from, to, &current_dir())
    } else {
        posix_relative(from, to, &current_dir())
    }
}

/// `path.dirname(p)` for an already-resolved path.
pub fn dirname(p: &str) -> String {
    if cfg!(windows) {
        win32_dirname(p)
    } else {
        posix_dirname(p)
    }
}

// ---- shared ---------------------------------------------------------------

fn is_sep(c: char) -> bool {
    c == '/' || c == '\\'
}

/// `normalizeString`: resolve `.` and `..` in `path`, joining with `sep`.
fn normalize_string(path: &str, allow_above_root: bool, sep: char, is_sep: fn(char) -> bool) -> String {
    let mut res: Vec<&str> = Vec::new();
    let mut leading_dotdot = 0usize;
    for seg in path.split(is_sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if res.last().is_some_and(|last| *last != "..") && res.len() > leading_dotdot {
                    res.pop();
                } else if allow_above_root {
                    res.push("..");
                    leading_dotdot = res.len();
                }
            }
            other => res.push(other),
        }
    }
    res.join(&sep.to_string())
}

// ---- posix ----------------------------------------------------------------

fn posix_sep(c: char) -> bool {
    c == '/'
}

fn posix_resolve(parts: &[&str], cwd: &str) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    let mut i = parts.len() as isize - 1;
    while i >= -1 && !absolute {
        let path: &str = if i >= 0 { parts[i as usize] } else { cwd };
        i -= 1;
        if path.is_empty() {
            continue;
        }
        resolved = format!("{path}/{resolved}");
        absolute = path.starts_with('/');
    }
    let tail = normalize_string(&resolved, !absolute, '/', posix_sep);
    if absolute {
        format!("/{tail}")
    } else if tail.is_empty() {
        ".".into()
    } else {
        tail
    }
}

fn posix_join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".into();
    }
    let joined = joined.join("/");
    let absolute = joined.starts_with('/');
    let trailing = joined.ends_with('/');
    let mut norm = normalize_string(&joined, !absolute, '/', posix_sep);
    if norm.is_empty() {
        if absolute {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        norm.push('/');
    }
    if absolute {
        format!("/{norm}")
    } else {
        norm
    }
}

fn posix_relative(from: &str, to: &str, cwd: &str) -> String {
    let from = posix_resolve(&[from], cwd);
    let to = posix_resolve(&[to], cwd);
    if from == to {
        return String::new();
    }
    let f: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let t: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    let mut out: Vec<&str> = vec![".."; f.len() - common];
    out.extend(&t[common..]);
    out.join("/")
}

fn posix_dirname(p: &str) -> String {
    match p.rfind('/') {
        None => ".".into(),
        Some(0) => "/".into(),
        Some(i) => p[..i].to_string(),
    }
}

// ---- win32 ----------------------------------------------------------------

/// Root of a win32 path: `(device, root_end, is_absolute)`.
fn win32_root(path: &str) -> (String, usize, bool) {
    let chars: Vec<char> = path.chars().collect();
    let len = chars.len();
    if len == 0 {
        return (String::new(), 0, false);
    }
    if len == 1 {
        return if is_sep(chars[0]) {
            (String::new(), 1, true)
        } else {
            (String::new(), 0, false)
        };
    }
    if is_sep(chars[0]) {
        // `\\server\share` is a UNC root; a lone leading separator is not.
        if is_sep(chars[1]) {
            let mut j = 2;
            let start = j;
            while j < len && !is_sep(chars[j]) {
                j += 1;
            }
            if j < len && j != start {
                let server: String = chars[start..j].iter().collect();
                j += 1;
                let share_start = j;
                while j < len && !is_sep(chars[j]) {
                    j += 1;
                }
                if j == len {
                    let share: String = chars[share_start..j].iter().collect();
                    return (format!("\\\\{server}\\{share}"), j, true);
                }
                if j != share_start {
                    let share: String = chars[share_start..j].iter().collect();
                    return (format!("\\\\{server}\\{share}"), j + 1, true);
                }
            }
        }
        return (String::new(), 1, true);
    }
    if chars[0].is_ascii_alphabetic() && chars[1] == ':' {
        let device: String = chars[..2].iter().collect();
        if len > 2 && is_sep(chars[2]) {
            return (device, 3, true);
        }
        return (device, 2, false);
    }
    (String::new(), 0, false)
}

/// Byte offset of the `n`th char of `s`.
fn byte_at(s: &str, n: usize) -> usize {
    s.char_indices().nth(n).map_or(s.len(), |(i, _)| i)
}

fn win32_resolve(parts: &[&str], cwd: &str) -> String {
    let mut resolved_device = String::new();
    let mut resolved_tail = String::new();
    let mut resolved_absolute = false;

    let mut i = parts.len() as isize - 1;
    while i >= -1 {
        let path: String = if i >= 0 {
            parts[i as usize].to_string()
        } else if resolved_device.is_empty() {
            cwd.to_string()
        } else {
            // The per-drive working directory (`=C:`) is rarely set; fall back
            // to the drive root unless the cwd is on that drive.
            let cwd_dev = cwd.get(..2).unwrap_or("");
            if cwd_dev.eq_ignore_ascii_case(&resolved_device) && cwd.chars().nth(2) == Some('\\') {
                cwd.to_string()
            } else {
                format!("{resolved_device}\\")
            }
        };
        i -= 1;
        if path.is_empty() {
            continue;
        }

        let (device, root_end, is_abs) = win32_root(&path);
        if !device.is_empty()
            && !resolved_device.is_empty()
            && device.to_lowercase() != resolved_device.to_lowercase()
        {
            continue;
        }
        if resolved_device.is_empty() && !device.is_empty() {
            resolved_device = device;
        }
        if !resolved_absolute {
            let rest = &path[byte_at(&path, root_end)..];
            resolved_tail = format!("{rest}\\{resolved_tail}");
            resolved_absolute = is_abs;
        }
        if resolved_absolute && !resolved_device.is_empty() {
            break;
        }
    }

    let tail = normalize_string(&resolved_tail, !resolved_absolute, '\\', is_sep);
    if resolved_absolute {
        format!("{resolved_device}\\{tail}")
    } else {
        let out = format!("{resolved_device}{tail}");
        if out.is_empty() {
            ".".into()
        } else {
            out
        }
    }
}

fn win32_join(parts: &[&str]) -> String {
    let non_empty: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if non_empty.is_empty() {
        return ".".into();
    }
    let mut joined = non_empty.join("\\");
    // A leading UNC-looking join must not turn `\\a` into a UNC root by accident.
    let first_is_unc = non_empty[0].chars().take(2).all(is_sep) && non_empty[0].chars().count() >= 2;
    if !first_is_unc {
        let mut count = 0;
        while joined.chars().nth(count).is_some_and(is_sep) {
            count += 1;
        }
        if count >= 2 {
            joined = format!("\\{}", &joined[count - 1..]);
        }
    }
    win32_normalize(&joined)
}

fn win32_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let (device, root_end, is_abs) = win32_root(path);
    let rest = &path[byte_at(path, root_end)..];
    let mut tail = if rest.is_empty() {
        String::new()
    } else {
        normalize_string(rest, !is_abs, '\\', is_sep)
    };
    if tail.is_empty() && !is_abs {
        tail = ".".into();
    }
    if !tail.is_empty() && path.ends_with(is_sep) {
        tail.push('\\');
    }
    let device = device.replace('/', "\\");
    if is_abs {
        format!("{device}\\{tail}")
    } else if device.is_empty() {
        tail
    } else {
        format!("{device}{tail}")
    }
}

fn win32_relative(from: &str, to: &str, cwd: &str) -> String {
    let from = win32_resolve(&[from], cwd);
    let to = win32_resolve(&[to], cwd);
    if from == to || from.to_lowercase() == to.to_lowercase() {
        return String::new();
    }
    let (fdev, fend, _) = win32_root(&from);
    let (tdev, tend, _) = win32_root(&to);
    if fdev.to_lowercase() != tdev.to_lowercase() {
        return to;
    }
    let ftail = &from[byte_at(&from, fend)..];
    let ttail = &to[byte_at(&to, tend)..];
    let f: Vec<&str> = ftail.split('\\').filter(|s| !s.is_empty()).collect();
    let t: Vec<&str> = ttail.split('\\').filter(|s| !s.is_empty()).collect();
    let common = f
        .iter()
        .zip(&t)
        .take_while(|(a, b)| a.to_lowercase() == b.to_lowercase())
        .count();
    let mut out: Vec<&str> = vec![".."; f.len() - common];
    out.extend(&t[common..]);
    out.join("\\")
}

fn win32_dirname(p: &str) -> String {
    let (device, root_end, is_abs) = win32_root(p);
    let chars: Vec<(usize, char)> = p.char_indices().collect();
    let root_byte = byte_at(p, root_end);
    let mut end: Option<usize> = None;
    for (idx, c) in chars.iter().rev() {
        if *idx < root_byte {
            break;
        }
        if is_sep(*c) {
            end = Some(*idx);
            break;
        }
    }
    match end {
        Some(e) if e > root_byte => p[..e].to_string(),
        Some(_) | None => {
            if root_byte > 0 {
                let _ = (device, is_abs);
                p[..root_byte].to_string()
            } else {
                ".".into()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_resolution() {
        assert_eq!(posix_resolve(&["/a/b", "../c"], "/cwd"), "/a/c");
        assert_eq!(posix_resolve(&["x/y"], "/cwd"), "/cwd/x/y");
        assert_eq!(posix_resolve(&["/a/b/../../.."], "/cwd"), "/");
        assert_eq!(posix_relative("/a/b", "/a/c/d", "/"), "../c/d");
        assert_eq!(posix_relative("/a", "/a", "/"), "");
    }

    #[test]
    fn win32_resolution() {
        let cwd = "C:\\work";
        assert_eq!(win32_resolve(&["C:\\a\\b", "..\\c"], cwd), "C:\\a\\c");
        assert_eq!(win32_resolve(&["C:/a//b/"], cwd), "C:\\a\\b");
        assert_eq!(win32_resolve(&["x/y"], cwd), "C:\\work\\x\\y");
        assert_eq!(win32_resolve(&["/etc/passwd"], cwd), "C:\\etc\\passwd");
        assert_eq!(win32_resolve(&["C:foo"], cwd), "C:\\work\\foo");
        assert_eq!(win32_resolve(&["D:foo"], cwd), "D:\\foo");
        assert_eq!(win32_resolve(&["C:\\a\\..\\..\\.."], cwd), "C:\\");
        assert_eq!(win32_resolve(&["\\\\srv\\share\\x\\..\\y"], cwd), "\\\\srv\\share\\y");
    }

    #[test]
    fn win32_relative_is_case_insensitive() {
        assert_eq!(win32_relative("C:\\Bundle", "c:\\bundle\\Wiki\\a.md", "C:\\"), "Wiki\\a.md");
        assert_eq!(win32_relative("C:\\a\\b", "C:\\a\\c", "C:\\"), "..\\c");
        assert_eq!(win32_relative("C:\\a", "D:\\x", "C:\\"), "D:\\x");
    }

    #[test]
    fn dirnames() {
        assert_eq!(win32_dirname("C:\\a\\b"), "C:\\a");
        assert_eq!(win32_dirname("C:\\a"), "C:\\");
        assert_eq!(posix_dirname("/a/b"), "/a");
        assert_eq!(posix_dirname("/a"), "/");
    }
}
