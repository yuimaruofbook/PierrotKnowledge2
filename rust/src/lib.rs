//! Rust port of the okf-wiki shared layer (`src/shared/` in the TypeScript
//! project): OKF v0.2 parsing helpers, text normalisation for search, wiki
//! workspace files, and the data types that cross the MCP boundary.
//!
//! Behaviour matches the TypeScript original, including message strings and
//! JSON shapes; see [`shared::js_compat`] for how JS string semantics are
//! reproduced.

pub mod shared;

/// The built page and icon, compiled in by `build.rs` (empty when not built).
pub mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded.rs"));
}

/// The release version (package.json's), compiled in by `build.rs`.
pub const VERSION: &str = env!("OKF_VERSION");
pub mod agent;
pub mod app_paths;
pub mod connections;
pub mod okf;
pub mod platform;
pub mod rpc;
pub mod rag;
pub mod state;
pub mod cli;
pub mod connect;
pub mod mcp;
pub mod native_binary;
pub mod ui_server;
pub mod uninstall;
pub mod update;
pub mod update_zip;
pub mod watch;
pub mod workspace;
