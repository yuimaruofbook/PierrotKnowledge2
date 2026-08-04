/**
 * Merging our server entry into somebody else's config file.
 *
 * These files belong to other tools and usually contain settings the user
 * spent time on. So every function here is a *merge*, never a rewrite: it adds
 * or replaces one entry and leaves every other byte alone wherever the format
 * allows it.
 *
 * That constraint is why TOML is edited as text rather than parsed and
 * re-emitted. A round-trip through a TOML serialiser is correct but not
 * faithful — it reorders keys, drops comments, and rewrites quoting, which
 * turns "we added one server" into an unreviewable diff of someone's editor
 * configuration.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface StdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Merge into a `mcpServers`-style JSON config (Claude Code).
 *
 * Unparseable input is treated as absent rather than fatal: the caller has
 * already taken a backup, and refusing to proceed because a config file is
 * broken leaves the user with a broken file and no server.
 */
export function mergeMcpJson(existing: string | null, name: string, server: StdioServer): string {
  const root = safeJson(existing);
  const servers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};

  servers[name] = {
    command: server.command,
    args: server.args,
    ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
  };

  return `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`;
}

/**
 * Merge into an opencode config.
 *
 * Different shape from every other MCP host: the key is `mcp`, each entry
 * needs an explicit `"type": "local"` discriminator, `command` is a single
 * array with the executable at the front, and environment variables live under
 * `environment` rather than `env`.
 */
export function mergeOpencodeJson(existing: string | null, name: string, server: StdioServer): string {
  const root = safeJson(existing);
  const mcp = isRecord(root.mcp) ? { ...root.mcp } : {};

  mcp[name] = {
    type: "local",
    command: [server.command, ...server.args],
    enabled: true,
    ...(server.env && Object.keys(server.env).length ? { environment: server.env } : {}),
  };

  return `${JSON.stringify(
    { $schema: "https://opencode.ai/config.json", ...root, mcp },
    null,
    2
  )}\n`;
}

/**
 * The `[mcp_servers.<name>]` table and everything up to the next table.
 *
 * Horizontal whitespace only, deliberately. `\s` matches newlines, and under
 * the `m` flag `^\s*` therefore starts the match at the *previous* blank line
 * — so replacing the table swallowed the blank line in front of it, and the
 * one in front of the table after it. Connect runs on every setup, so the
 * user's file lost a blank line and gained a backup every time, for an edit
 * they never made.
 */
const HSPACE = "[^\\S\\r\\n]*";

function tomlTableRange(source: string, name: string): { start: number; end: number } | null {
  const header = new RegExp(
    `^${HSPACE}\\[mcp_servers\\.(?:"${escapeRe(name)}"|${escapeRe(name)})\\]${HSPACE}$`,
    "m"
  );
  const match = header.exec(source);
  if (!match) return null;

  const start = match.index;
  const after = start + match[0].length;
  // A table runs until the next table header at line start.
  const next = new RegExp(`^${HSPACE}\\[[^\\]]+\\]${HSPACE}$`, "m").exec(source.slice(after));
  return { start, end: next ? after + next.index : source.length };
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Merge into Codex's `config.toml`.
 *
 * Text surgery rather than a parse: replace our own table if it is already
 * there, otherwise append. Everything else in the file — model choice,
 * per-project trust levels, comments — is untouched.
 */
export function mergeCodexToml(existing: string | null, name: string, server: StdioServer): string {
  const source = existing ?? "";
  const quoted = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);

  const lines = [
    `[mcp_servers.${quoted}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
  ];
  if (server.env && Object.keys(server.env).length) {
    const pairs = Object.entries(server.env).map(([k, v]) => `${k} = ${tomlString(v)}`);
    lines.push(`env = { ${pairs.join(", ")} }`);
  }
  const table = `${lines.join("\n")}\n`;

  const range = tomlTableRange(source, name);
  if (range) {
    // Carry over the separator that was there. The range runs to the next
    // table header, so it includes the blank line between the two, and a
    // replacement ending in a single "\n" would quietly close the gap.
    const original = source.slice(range.start, range.end);
    const separator = /(?:[^\S\r\n]*\r?\n)*$/.exec(original)?.[0] || "\n";
    return source.slice(0, range.start) + table.replace(/\n$/, "") + separator + source.slice(range.end);
  }

  if (!source.trim()) return table;
  return `${source.replace(/\n*$/, "")}\n\n${table}`;
}

/** TOML basic strings: the escapes a Windows path actually needs. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Merge into Hermes Agent's `config.yaml`.
 *
 * YAML is significant-whitespace, so text surgery is not safe here the way it
 * is for TOML — a parse and re-emit is the correct trade even though it
 * reformats. The backup is what makes that acceptable.
 */
export function mergeHermesYaml(existing: string | null, name: string, server: StdioServer): string {
  let root: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed = parseYaml(existing);
      if (isRecord(parsed)) root = parsed;
    } catch {
      // Treated as absent; the caller holds a backup.
    }
  }

  const servers = isRecord(root.mcp_servers) ? { ...root.mcp_servers } : {};
  servers[name] = {
    command: server.command,
    args: server.args,
    ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    enabled: true,
  };

  return stringifyYaml({ ...root, mcp_servers: servers });
}

function safeJson(text: string | null): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Take our entry back out.
 *
 * The inverse of each merge above, and the reason uninstalling is more than
 * deleting a folder: an agent host left pointing at a binary that no longer
 * exists reports a failed MCP server on every single launch, and the user has
 * to work out which of their tools is complaining and why.
 *
 * Each of these returns null when there was nothing of ours to remove, so a
 * caller can leave the file alone rather than rewrite it for no reason.
 */
export function removeFromMcpJson(existing: string | null, name: string): string | null {
  if (!existing?.trim()) return null;
  const root = safeJson(existing);
  if (!isRecord(root.mcpServers) || !(name in root.mcpServers)) return null;

  const servers = { ...root.mcpServers };
  delete servers[name];

  // Drop the key entirely when it was only ever holding ours, so an untouched
  // config comes back looking untouched.
  const next = Object.keys(servers).length ? { ...root, mcpServers: servers } : omit(root, "mcpServers");
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function removeFromOpencodeJson(existing: string | null, name: string): string | null {
  if (!existing?.trim()) return null;
  const root = safeJson(existing);
  if (!isRecord(root.mcp) || !(name in root.mcp)) return null;

  const mcp = { ...root.mcp };
  delete mcp[name];

  const next = Object.keys(mcp).length ? { ...root, mcp } : omit(root, "mcp");
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function removeFromCodexToml(existing: string | null, name: string): string | null {
  if (!existing?.trim()) return null;

  const range = tomlTableRange(existing, name);
  if (!range) return null;

  // Text surgery again, for the same reason: a parse and re-emit would lose
  // the comments and key order in a file the user maintains by hand.
  const next = existing.slice(0, range.start) + existing.slice(range.end);
  return `${next.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "")}`;
}

export function removeFromHermesYaml(existing: string | null, name: string): string | null {
  if (!existing?.trim()) return null;

  let root: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(existing);
    if (isRecord(parsed)) root = parsed;
  } catch {
    return null;
  }

  const servers = root.mcp_servers;
  if (!isRecord(servers) || !(name in servers)) return null;

  const next = { ...servers };
  delete next[name];

  const out = Object.keys(next).length
    ? { ...root, mcp_servers: next }
    : omit(root, "mcp_servers");
  return stringifyYaml(out);
}

function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}
