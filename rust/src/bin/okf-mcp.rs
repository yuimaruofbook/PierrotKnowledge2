//! Headless MCP server (`src/bun/mcp/standalone.ts`).
//!
//!   OKF_BUNDLE=/path/to/bundle okf-mcp
//!   okf-mcp /path/to/bundle
//!
//! Diagnostics go to stderr only: stdout carries the JSON-RPC stream, and a
//! stray log line there corrupts the protocol.

use okf::mcp::stdio::run_stdio_server;
use okf::workspace::{Workspace, WorkspaceOptions};
use std::io::Write;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn main() {
    let bundle_path = std::env::var("OKF_BUNDLE")
        .ok()
        .or_else(|| std::env::args().nth(1));

    // Watching costs nothing here and keeps a long-lived agent session
    // consistent with edits the human makes in the GUI at the same time.
    let mut workspace = Workspace::new(WorkspaceOptions {
        watch: Some(true),
        on_error: Some(Rc::new(|message| eprintln!("[okf-wiki mcp] {message}"))),
        ..Default::default()
    });

    match bundle_path.as_deref().filter(|p| !p.is_empty()) {
        Some(path) => match workspace.open(path) {
            Ok(info) => eprintln!("[okf-wiki mcp] opened {} ({} concepts)", info.root, info.concept_count),
            Err(error) => eprintln!("[okf-wiki mcp] failed to open {path}: {error}"),
        },
        None => eprintln!("[okf-wiki mcp] no OKF_BUNDLE set — call the open_bundle tool first"),
    }

    // SIGINT/SIGTERM only raise a flag; the loop notices it within a tick and
    // closes the workspace (WAL checkpoint) before exiting.
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    if let Err(error) = ctrlc::set_handler(move || flag.store(true, Ordering::SeqCst)) {
        eprintln!("[okf-wiki mcp] cannot install signal handler: {error}");
    }

    let stdout = std::io::stdout();
    run_stdio_server(
        &mut workspace,
        std::io::stdin(),
        |line| {
            let mut out = stdout.lock();
            // A closed pipe means the client is gone; the read side ends too.
            let _ = out.write_all(line.as_bytes()).and_then(|()| out.flush());
        },
        &stop,
    );
    workspace.close();
}
