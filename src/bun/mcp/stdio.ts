/**
 * MCP over stdio: newline-delimited JSON-RPC 2.0.
 *
 * MCP's stdio transport frames one JSON object per line — it is *not* the
 * LSP `Content-Length` framing, and a server that emits headers is silently
 * unreadable by every client. Messages must therefore never contain a raw
 * newline, which is why responses are stringified compactly.
 */

import { APP_NAME } from "../../shared/app";
import type { Workspace } from "../workspace";
import { TOOLS, callTool } from "./tools";

export const SERVER_NAME = "okf-wiki";
export const SERVER_VERSION = "0.2.0";

/** Protocol revisions this server implements, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Negotiate a protocol version, preferring the client's when we speak it. */
export function negotiateProtocol(requested: unknown): string {
  const versions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;
  if (typeof requested === "string" && versions.includes(requested)) return requested;
  return versions[0]!;
}

/**
 * Handle one decoded message.
 *
 * Returns `null` for notifications — a JSON-RPC notification has no `id` and
 * must not be answered, and replying to `notifications/initialized` is enough
 * to make strict clients abort the session.
 */
export async function handleMessage(
  workspace: Workspace,
  message: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  const { method, params } = message;
  const id = message.id ?? null;
  const isNotification = message.id === undefined || message.id === null;

  // A notification carries no id and must never draw a response — not even an
  // error, and not for methods that would otherwise return one.
  if (isNotification) return null;

  if (typeof method !== "string") {
    return error(id, JSONRPC_INVALID_REQUEST, "Missing 'method'");
  }

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateProtocol(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: APP_NAME, version: SERVER_VERSION },
        // MAP first, deliberately. It is a small routing table that names the
        // one file answering each kind of question, so the alternative — read
        // several files to find out where things are — is paid once and never
        // again.
        instructions:
          "Call read_map first. MAP.md is small and tells you which single file or tool " +
          "answers each question: read_human for who the user is, list_tasks for what to " +
          "work on, read_agents_md for this bundle's rules, retrieve/search for knowledge. " +
          "Go straight to the one you need. raw/ is immutable to you; .rag/ is derived.",
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      if (!name) return error(id, JSONRPC_INVALID_REQUEST, "Missing tool name");
      const args =
        params?.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return ok(id, await callTool(workspace, name, args));
      } catch (cause) {
        return error(
          id,
          JSONRPC_INTERNAL_ERROR,
          cause instanceof Error ? cause.message : String(cause)
        );
      }
    }

    default:
      return error(id, JSONRPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

export interface StdioOptions {
  input?: AsyncIterable<Uint8Array>;
  write?: (line: string) => void;
}

/** Run the newline-delimited JSON-RPC loop until stdin closes. */
export async function runStdioServer(
  workspace: Workspace,
  options: StdioOptions = {}
): Promise<void> {
  const input = options.input ?? Bun.stdin.stream();
  const write = options.write ?? ((line: string) => process.stdout.write(line));

  const send = (response: JsonRpcResponse) => write(`${JSON.stringify(response)}\n`);
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");

      if (!line) continue;

      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line) as JsonRpcRequest;
      } catch {
        send(error(null, JSONRPC_PARSE_ERROR, "Parse error"));
        continue;
      }

      const response = await handleMessage(workspace, message);
      if (response) send(response);
    }
  }
}
