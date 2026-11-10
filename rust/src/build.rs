//! Compiles the built page, the icon and the release version into the binary,
//! so an install can be `okf` and nothing else.
//!
//! A checkout that has not built the page (`bun run build:view`) still
//! compiles: the table is empty and `okf ui` serves `src/mainview/dist` from
//! disk, as it always has.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.parent().unwrap();

    // The version people see is package.json's; Cargo.toml's is the crate's.
    let package = fs::read_to_string(root.join("package.json")).unwrap_or_default();
    let version = package.split("\"version\"").nth(1).and_then(|rest| rest.split('"').nth(1)).unwrap_or("0.0.0");
    println!("cargo:rustc-env=OKF_VERSION={version}");
    println!("cargo:rerun-if-changed={}", root.join("package.json").display());

    let dist = root.join("src").join("mainview").join("dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    let mut files = Vec::new();
    collect(&dist, &mut files);
    files.sort();

    let mut code = String::from("pub static VIEW: &[(&str, &[u8])] = &[\n");
    for file in &files {
        let name = file.strip_prefix(&dist).unwrap().to_string_lossy().replace('\\', "/");
        writeln!(code, "    ({name:?}, include_bytes!({:?})),", file.to_string_lossy()).unwrap();
    }
    code.push_str("];\n");

    for (name, file) in [("ICON_ICO", "icon.ico"), ("ICON_PNG", "icon.png")] {
        let path = root.join("assets").join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        if path.is_file() {
            writeln!(code, "pub static {name}: &[u8] = include_bytes!({:?});", path.to_string_lossy()).unwrap();
        } else {
            writeln!(code, "pub static {name}: &[u8] = &[];").unwrap();
        }
    }

    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("embedded.rs"), code).unwrap();
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else {
            out.push(path);
        }
    }
}
