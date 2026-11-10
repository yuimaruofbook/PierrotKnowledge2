//! Headless MCP server (`src/bun/mcp/standalone.ts`).
//!
//!   OKF_BUNDLE=/path/to/bundle okf-mcp
//!   okf-mcp /path/to/bundle

fn main() {
    let bundle_path = std::env::var("OKF_BUNDLE").ok().or_else(|| std::env::args().nth(1));
    okf::mcp::stdio::run_standalone(bundle_path.as_deref());
}
