//! Reading and extracting the release archive (`src/bun/update-zip.ts`).
//!
//! Extraction is delegated to the OS rather than reimplemented: Windows has
//! `Expand-Archive`, and everywhere else has `unzip` or `bsdtar`. A
//! hand-rolled inflater would be a second place for a path-traversal bug to
//! live, and the archive comes from the network.
//!
//! The manifest is read without extracting anything, because the version it
//! carries decides whether extraction should happen at all. Unlike the TS,
//! only the central directory and the one entry are read from disk, not the
//! whole (hundreds of megabytes) archive.

use crate::okf::error as fsx;
use crate::okf::nodepath;
use crate::update::{parse_manifest, ReleaseManifest};
use flate2::read::DeflateDecoder;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::process::Command;

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn read_at(file: &mut File, offset: u64, len: usize) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// Ceiling for an inflated manifest; real ones are under 1 KB.
const MAX_MANIFEST_BYTES: u64 = 1 << 20;

/// Pull one file out of a ZIP by reading its central directory.
///
/// Cheaper than extracting a 285 MB archive to read 100 bytes, and it happens
/// before the decision to install has been made. The first entry whose name
/// (backslashes read as slashes) ends with `manifest_name` is the one read.
/// `None` when the file is not a ZIP, the entry is absent, or its content is
/// not JSON; a truncated or inconsistent archive also yields `None` (the TS
/// throws a RangeError there).
pub fn read_manifest_from_zip(archive_path: &str, manifest_name: &str) -> Option<ReleaseManifest> {
    let mut file = File::open(archive_path).ok()?;
    let total = file.metadata().ok()?.len();
    if total < 22 {
        return None;
    }

    // End of central directory: scan back for the signature, at most 64 KiB
    // plus the record itself from the end.
    let window = total.min(65_557 + 22) as usize;
    let base = total - window as u64;
    let tail = read_at(&mut file, base, window)?;
    let eocd = (0..=window.checked_sub(22)?)
        .rev()
        .find(|&i| u32_at(&tail, i) == Some(EOCD_SIGNATURE))?;
    // The TS scan stops at `i > len - 65557`.
    if (base + eocd as u64) + 65_557 <= total {
        return None;
    }

    let cd_size = u32_at(&tail, eocd + 12)? as u64;
    let cd_offset = u32_at(&tail, eocd + 16)? as u64;
    if cd_offset.checked_add(cd_size)? > total {
        return None;
    }
    let directory = read_at(&mut file, cd_offset, cd_size as usize)?;

    let mut p = 0usize;
    while p + 4 < directory.len() && u32_at(&directory, p) == Some(CENTRAL_SIGNATURE) {
        let method = u16_at(&directory, p + 10)?;
        let compressed_size = u32_at(&directory, p + 20)? as usize;
        let name_len = u16_at(&directory, p + 28)? as usize;
        let extra_len = u16_at(&directory, p + 30)? as usize;
        let comment_len = u16_at(&directory, p + 32)? as usize;
        let local_offset = u32_at(&directory, p + 42)? as u64;
        let name_bytes = directory.get(p + 46..p + 46 + name_len)?;
        let name = String::from_utf8_lossy(name_bytes).replace('\\', "/");

        if name.ends_with(manifest_name) {
            // The local header repeats the name and extra fields, with its own
            // lengths; the central directory's are not usable here.
            let local = read_at(&mut file, local_offset, 30)?;
            let local_name_len = u16_at(&local, 26)? as u64;
            let local_extra_len = u16_at(&local, 28)? as u64;
            let data_at = local_offset + 30 + local_name_len + local_extra_len;
            // A corrupt header can claim gigabytes; the bytes have to be in
            // the file before anything is allocated for them.
            if data_at.checked_add(compressed_size as u64)? > total {
                return None;
            }
            let raw = read_at(&mut file, data_at, compressed_size)?;

            let bytes = if method == 0 {
                raw
            } else {
                // The manifest is a few hundred bytes; a decompression bomb
                // is cut off rather than inflated.
                let mut out = Vec::new();
                DeflateDecoder::new(raw.as_slice())
                    .take(MAX_MANIFEST_BYTES)
                    .read_to_end(&mut out)
                    .ok()?;
                out
            };
            // TextDecoder drops a leading BOM; `parse_manifest` does the same.
            return parse_manifest(&String::from_utf8_lossy(&bytes));
        }

        p += 46 + name_len + extra_len + comment_len;
    }

    None
}

/// Extract an archive and return the directory holding `package.json`.
///
/// These archives wrap everything in one top-level folder, so the caller wants
/// what is inside it rather than the extraction root.
pub fn extract_zip(archive_path: &str, into: &str) -> Result<String, String> {
    if fs::symlink_metadata(into).is_ok() {
        fs::remove_dir_all(into).or_else(|_| fs::remove_file(into)).map_err(|e| e.to_string())?;
    }
    fsx::mkdir_p(into).map_err(|e| e.to_string())?;

    // Extractors to try, in order. More than one on Unix because neither is
    // guaranteed: `unzip` is absent from minimal Linux images, and `bsdtar`
    // (as `tar`) is what macOS ships.
    let candidates: Vec<Vec<String>> = if cfg!(windows) {
        vec![vec![
            "powershell".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            format!(
                "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                archive_path.replace('\'', "''"),
                into.replace('\'', "''")
            ),
        ]]
    } else {
        vec![
            vec!["unzip".into(), "-q".into(), "-o".into(), archive_path.into(), "-d".into(), into.into()],
            // bsdtar reads zip; present on macOS and most desktop Linux.
            vec!["tar".into(), "-xf".into(), archive_path.into(), "-C".into(), into.into()],
        ]
    };

    let mut problems: Vec<String> = Vec::new();
    for command in &candidates {
        match Command::new(&command[0]).args(&command[1..]).output() {
            Err(_) => {
                problems.push(format!("{}: 見つかりません", command[0]));
                continue;
            }
            Ok(out) if !out.status.success() => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stderr = crate::shared::js_compat::js_trim(&stderr);
                let detail = if stderr.is_empty() {
                    format!("exit {}", out.status.code().unwrap_or(-1))
                } else {
                    stderr.to_string()
                };
                problems.push(format!("{}: {detail}", command[0]));
                continue;
            }
            Ok(_) => {}
        }
        return find_root(into);
    }

    let listed: Vec<String> = problems.iter().map(|p| format!("  {p}")).collect();
    Err(format!(
        "展開に失敗しました。\n{}\n{}",
        listed.join("\n"),
        if cfg!(windows) { "" } else { "  unzip か bsdtar を入れてから再実行してください。" }
    ))
}

/// The directory containing `package.json`, one level down at most.
fn find_root(dir: &str) -> Result<String, String> {
    let has_package = |d: &str| fs::metadata(nodepath::join(&[d, "package.json"])).is_ok_and(|m| m.is_file());
    if has_package(dir) {
        return Ok(dir.to_string());
    }
    for entry in fsx::read_dir(dir).map_err(|e| e.to_string())? {
        if !entry.is_dir {
            continue;
        }
        let candidate = nodepath::join(&[dir, &entry.name]);
        if has_package(&candidate) {
            return Ok(candidate);
        }
    }
    Err("展開結果に package.json が見つかりません。アーカイブの構成を確認してください。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::DeflateEncoder;
    use flate2::Compression;
    use std::io::Write;

    struct Entry<'a> {
        name: &'a str,
        body: &'a [u8],
        deflate: bool,
    }

    /// A structurally real zip: local headers, central directory, EOCD.
    fn build_zip(entries: &[Entry], comment_len: usize) -> Vec<u8> {
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();
        for e in entries {
            let data = if e.deflate {
                let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
                enc.write_all(e.body).unwrap();
                enc.finish().unwrap()
            } else {
                e.body.to_vec()
            };
            let offset = out.len() as u32;
            let method: u16 = if e.deflate { 8 } else { 0 };

            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0]);
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 8]);
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(e.body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(e.name.as_bytes());
            out.extend_from_slice(&data);

            central.extend_from_slice(&CENTRAL_SIGNATURE.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 8]);
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(e.body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(e.name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&(comment_len as u16).to_le_bytes());
        out.extend(std::iter::repeat_n(b'x', comment_len));
        out
    }

    fn write_zip(dir: &tempfile::TempDir, bytes: &[u8]) -> String {
        let path = dir.path().join("a.zip");
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    const MANIFEST: &[u8] = br#"{"version":"0.5.1","builtAt":"2026-08-03T12:00:00Z","contains":["package.json"]}"#;

    #[test]
    fn reads_a_stored_manifest_without_extracting() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write_zip(
            &dir,
            &build_zip(
                &[
                    Entry { name: "PK-0.5.1/README.md", body: b"# hi", deflate: false },
                    Entry { name: "PK-0.5.1/okf-release.json", body: MANIFEST, deflate: false },
                ],
                0,
            ),
        );
        let manifest = read_manifest_from_zip(&zip, "okf-release.json").unwrap();
        assert_eq!(manifest.version.as_deref(), Some("0.5.1"));
        assert_eq!(manifest.built_at.as_deref(), Some("2026-08-03T12:00:00Z"));
        assert_eq!(manifest.contains, Some(vec!["package.json".to_string()]));
    }

    #[test]
    fn reads_a_deflated_manifest_and_backslash_names() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write_zip(
            &dir,
            &build_zip(&[Entry { name: "PK-0.5.1\\okf-release.json", body: MANIFEST, deflate: true }], 0),
        );
        assert_eq!(
            read_manifest_from_zip(&zip, "okf-release.json").unwrap().version.as_deref(),
            Some("0.5.1")
        );
    }

    #[test]
    fn finds_the_directory_through_an_archive_comment() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write_zip(
            &dir,
            &build_zip(&[Entry { name: "okf-release.json", body: MANIFEST, deflate: false }], 100),
        );
        assert!(read_manifest_from_zip(&zip, "okf-release.json").is_some());
    }

    #[test]
    fn an_archive_without_the_manifest_or_not_a_zip_gives_none() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write_zip(
            &dir,
            &build_zip(&[Entry { name: "README.md", body: b"x", deflate: false }], 0),
        );
        assert!(read_manifest_from_zip(&zip, "okf-release.json").is_none());

        let junk = write_zip(&dir, &[7u8; 64]);
        assert!(read_manifest_from_zip(&junk, "okf-release.json").is_none());
        let tiny = write_zip(&dir, &[1u8; 8]);
        assert!(read_manifest_from_zip(&tiny, "okf-release.json").is_none());
        assert!(read_manifest_from_zip("/no/such/file.zip", "okf-release.json").is_none());
    }

    #[test]
    fn a_manifest_that_is_not_json_gives_none() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write_zip(
            &dir,
            &build_zip(&[Entry { name: "okf-release.json", body: b"{oops", deflate: false }], 0),
        );
        assert!(read_manifest_from_zip(&zip, "okf-release.json").is_none());
    }

    #[test]
    fn a_central_directory_pointing_past_the_file_gives_none() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = build_zip(&[Entry { name: "okf-release.json", body: MANIFEST, deflate: false }], 0);
        let at = bytes.len() - 22 + 16;
        bytes[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(read_manifest_from_zip(&write_zip(&dir, &bytes), "okf-release.json").is_none());
    }

    #[test]
    fn find_root_prefers_the_extraction_root_then_one_level_down() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        assert!(find_root(&root).unwrap_err().contains("package.json"));

        fs::create_dir_all(dir.path().join("wrapped")).unwrap();
        fs::write(dir.path().join("wrapped").join("package.json"), "{}").unwrap();
        assert_eq!(find_root(&root).unwrap(), nodepath::join(&[&root, "wrapped"]));

        fs::write(dir.path().join("package.json"), "{}").unwrap();
        assert_eq!(find_root(&root).unwrap(), root);
    }

    #[test]
    fn extract_refuses_a_bad_archive_with_a_message() {
        let dir = tempfile::tempdir().unwrap();
        let junk = write_zip(&dir, b"this is not a zip file at all");
        let into = nodepath::join(&[&dir.path().to_string_lossy(), "out"]);
        // Either the OS tool rejects it (listed per extractor), or it exits 0
        // having extracted nothing and the missing package.json is reported.
        let err = extract_zip(&junk, &into).unwrap_err();
        assert!(
            err.starts_with("展開に失敗しました。
  ") || err.starts_with("展開結果に package.json"),
            "{err}"
        );
    }

    #[test]
    fn extract_unpacks_a_real_archive_and_returns_the_wrapped_root() {
        let dir = tempfile::tempdir().unwrap();
        let zip = write_zip(
            &dir,
            &build_zip(
                &[
                    Entry { name: "PK-0.5.1/package.json", body: b"{\"name\":\"x\"}", deflate: true },
                    Entry { name: "PK-0.5.1/src/a.ts", body: b"export {}", deflate: false },
                ],
                0,
            ),
        );
        let into = nodepath::join(&[&dir.path().to_string_lossy(), "out"]);
        // Leftovers from an earlier run are cleared first.
        fs::create_dir_all(&into).unwrap();
        fs::write(nodepath::join(&[&into, "stale.txt"]), "x").unwrap();

        match extract_zip(&zip, &into) {
            Ok(root) => {
                assert_eq!(root, nodepath::join(&[&into, "PK-0.5.1"]));
                assert_eq!(fs::read_to_string(nodepath::join(&[&root, "src", "a.ts"])).unwrap(), "export {}");
                assert!(!Path::new(&nodepath::join(&[&into, "stale.txt"])).exists());
            }
            // A machine with no extractor at all reports it instead.
            Err(e) => assert!(e.starts_with("展開に失敗しました。"), "{e}"),
        }
    }

    use std::path::Path;
}
