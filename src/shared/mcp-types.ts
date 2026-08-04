/**
 * Types describing external MCP servers, shared by both processes.
 *
 * The client itself is Bun-only (it spawns processes); the view needs to
 * render what it reports, so the shapes live here rather than being imported
 * across the process boundary.
 */

/**
 * Stand-in for a path only the user can supply.
 *
 * Most presets are complete except for a token, which goes in `env` and is
 * edited in the config file. Obsidian is the exception: its vault path is a
 * positional argument. The marker is left obviously wrong on purpose — a
 * plausible-looking default would fail with "no such directory" and send
 * someone hunting for a bug instead of reading the note.
 *
 * Shared because the panel warns about it and the registry writes it.
 */
export const VAULT_PLACEHOLDER = "<VAULT_PATH>";

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema?: unknown;
}

export interface ServerStatus {
  id: string;
  label: string;
  /** The command line, shown so the user can see what will run. */
  command: string;
  connected: boolean;
  serverName?: string;
  toolCount?: number;
  /** Last failure, so the panel can explain rather than just fail. */
  error?: string;
}
