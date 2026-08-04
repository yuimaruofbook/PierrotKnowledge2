/**
 * The list of external MCP servers this app may connect to.
 *
 * Kept in the OS config directory, never in the bundle. A bundle is knowledge
 * that gets committed and shared; API tokens must not travel with it.
 *
 * Nothing here is started implicitly. A server only runs when the user asks for
 * it, because a registry entry is a command line — that is the whole mechanism
 * MCP uses, and it deserves to be visible rather than hidden behind a toggle.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { appDataPath, appDataReadPaths } from "../app-paths";
import { VAULT_PLACEHOLDER } from "../../shared/mcp-types";
import type { McpServerSpec } from "./client";

const FILE = "mcp-servers.json";


export interface RegisteredServer extends McpServerSpec {
  /** Stable key used by the UI and RPC. */
  id: string;
  /** Human-readable name. */
  label: string;
}

/** Where the registry lives, per platform. */
export function registryPath(): string {
  return appDataPath(FILE);
}

function coerce(value: unknown): RegisteredServer | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const id = typeof record.id === "string" ? record.id.trim() : "";
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!id || !command) return null;

  const server: RegisteredServer = {
    id,
    label: typeof record.label === "string" && record.label.trim() ? record.label : id,
    command,
  };

  if (Array.isArray(record.args)) {
    server.args = record.args.filter((a): a is string => typeof a === "string");
  }
  if (record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(record.env as Record<string, unknown>)) {
      if (typeof val === "string") env[key] = val;
    }
    if (Object.keys(env).length) server.env = env;
  }
  if (typeof record.cwd === "string" && record.cwd.trim()) server.cwd = record.cwd;

  return server;
}

/**
 * Read the registry.
 *
 * A malformed file yields an empty list rather than an error: the app must
 * still start, and the user can fix the file at their leisure.
 */
export async function loadServers(): Promise<RegisteredServer[]> {
  // Current location first, then the pre-rename one, so a rename does not
  // present as "every connection you registered is gone".
  for (const path of appDataReadPaths(FILE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }

    // Accept both a bare array and the `{ mcpServers: {...} }` shape that
    // agent configs use, so an existing config can be pasted in unchanged.
    if (Array.isArray(parsed)) {
      return parsed.map(coerce).filter((s): s is RegisteredServer => s !== null);
    }

    if (parsed && typeof parsed === "object") {
      const map = (parsed as Record<string, unknown>).mcpServers;
      if (map && typeof map === "object" && !Array.isArray(map)) {
        return Object.entries(map as Record<string, unknown>)
          .map(([id, spec]) => coerce({ id, label: id, ...(spec as object) }))
          .filter((s): s is RegisteredServer => s !== null);
      }
    }
  }

  return [];
}

export async function saveServers(servers: readonly RegisteredServer[]): Promise<void> {
  const path = registryPath();
  await mkdir(dirname(path), { recursive: true });
  // Written in the `mcpServers` shape so the file can be copied straight into
  // an agent's own configuration, and vice versa.
  const mcpServers: Record<string, Omit<RegisteredServer, "id">> = {};
  for (const { id, ...rest } of servers) mcpServers[id] = rest;
  await writeFile(path, `${JSON.stringify({ mcpServers }, null, 2)}\n`, "utf8");
}

export async function upsertServer(server: RegisteredServer): Promise<RegisteredServer[]> {
  const servers = await loadServers();
  const at = servers.findIndex((s) => s.id === server.id);
  if (at === -1) servers.push(server);
  else servers[at] = server;
  await saveServers(servers);
  return servers;
}

export async function removeServer(id: string): Promise<RegisteredServer[]> {
  const servers = (await loadServers()).filter((s) => s.id !== id);
  await saveServers(servers);
  return servers;
}

/**
 * Ready-made entries for the services this app is expected to pull from.
 *
 * Tokens are deliberately left as empty strings: the user pastes their own, and
 * a template that shipped with a credential in it would be a trap.
 */
export const SERVER_PRESETS: ReadonlyArray<RegisteredServer & { note: string }> = [
  {
    id: "notion",
    label: "Notion",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { NOTION_TOKEN: "" },
    note: "Notion のインテグレーションを作成し、取り込みたいページに接続してからトークンを設定してください。",
  },
  {
    id: "github",
    label: "GitHub",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    note: "repo 読み取り権限のある Personal Access Token が必要です。",
  },
  {
    id: "gdrive",
    label: "Google Drive",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    env: {},
    note: "初回は別途 OAuth 認証が必要です（サーバー側の手順に従ってください）。",
  },
  {
    // Read-only by design. `obsidian-mcp` also exists and can write, but its
    // own README opens by asking you to back the vault up first — for moving
    // notes *out* of Obsidian nothing needs writing, so the server that cannot
    // touch the vault is the correct one.
    id: "obsidian",
    label: "Obsidian",
    command: "npx",
    args: ["-y", "mcp-obsidian", VAULT_PLACEHOLDER],
    env: {},
    note:
      `args の "${VAULT_PLACEHOLDER}" を Vault フォルダの絶対パスに書き換えてください。` +
      "読み取り専用なので Vault は変更されません。取り込んだノートは raw/ に入ります。",
  },
];
