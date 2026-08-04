/**
 * The application's identity, in one place.
 *
 * Its name appears in the window title, the brand, the MCP handshake, the
 * agent's system prompt and the per-user data directory. Spread across those,
 * a rename becomes an exercise in finding every copy — so there is one copy.
 */

/** Shown to people: window title, setup script, MCP `serverInfo.title`. */
export const APP_NAME = "PierrotKnowledge2";

/** Split for the brand mark, where the second half is set dimmer. */
export const APP_BRAND = { head: "Pierrot", tail: "Knowledge2" } as const;

/** Stable machine identifier. Unchanged by the rename, on purpose: it is what
 *  agent configs already reference, and breaking it would silently orphan
 *  every `mcpServers` entry this app has already written. */
export const APP_ID = "okf-wiki";

/**
 * Folder name under the OS's per-user application data directory.
 *
 * Renamed with the app, but see `LEGACY_APP_DIR`: the old folder still holds
 * a real user's session and MCP server registry, and a rename that silently
 * dropped them would look exactly like data loss.
 */
export const APP_DIR = APP_NAME;

/** Where this app's data lived before the rename. Read-only fallback. */
export const LEGACY_APP_DIR = "OKF Wiki";
