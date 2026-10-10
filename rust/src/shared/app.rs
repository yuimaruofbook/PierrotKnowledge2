//! The application's identity, in one place (`src/shared/app.ts`).
//!
//! Its name appears in the window title, the brand, the MCP handshake, the
//! agent's system prompt and the per-user data directory, so there is one copy.

/// Shown to people: window title, setup script, MCP `serverInfo.title`.
pub const APP_NAME: &str = "PierrotKnowledge2";

/// Split for the brand mark, where the second half is set dimmer.
pub struct AppBrand {
    pub head: &'static str,
    pub tail: &'static str,
}

pub const APP_BRAND: AppBrand = AppBrand {
    head: "Pierrot",
    tail: "Knowledge2",
};

/// Stable machine identifier. Unchanged by the rename on purpose: agent configs
/// already reference it, and changing it would orphan every `mcpServers` entry.
pub const APP_ID: &str = "okf-wiki";

/// Folder name under the OS's per-user application data directory.
pub const APP_DIR: &str = APP_NAME;

/// Where this app's data lived before the rename. Read-only fallback, because
/// that folder still holds a real user's session and MCP server registry.
pub const LEGACY_APP_DIR: &str = "OKF Wiki";
