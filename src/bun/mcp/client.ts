/**
 * MCP client.
 *
 * The mirror of `stdio.ts`: that exposes this bundle *to* agents, this connects
 * this app *to* other people's MCP servers — Notion, Google Drive, GitHub — so
 * their content can be pulled into the wiki.
 *
 * Hand-written rather than pulled from an SDK for the same reason the server
 * side is: the protocol surface we need is small (initialize, tools/list,
 * tools/call), and the framing rules are the ones already established and
 * tested here. It is verified end to end against this project's own server.
 */

import { APP_ID, APP_NAME } from "../../shared/app";
import { messages } from "../../shared/messages";
import type { McpToolDefinition } from "../../shared/mcp-types";

export type { McpToolDefinition };

/** Protocol revisions this client can speak, newest first. */
export const CLIENT_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const CLIENT_INFO = { name: APP_ID, title: APP_NAME, version: "0.2.0" };

/** How long a single request may take before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Extra grace for `initialize`, which may run an `npx` download first. */
const HANDSHAKE_TIMEOUT_MS = 120_000;

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpServerSpec {
  /** Executable to run, e.g. `npx`. */
  command: string;
  args?: string[];
  /** Extra environment, typically API tokens. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A live connection to one MCP server.
 *
 * The transport is stdio: the server is a child process, messages are
 * newline-delimited JSON on its stdin/stdout, and its stderr is captured for
 * diagnostics rather than parsed — that is where servers put their logs.
 */
export class McpClient {
  private child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private stderr: string[] = [];
  private closed = false;

  /** Populated by `connect()`. */
  serverInfo: { name?: string; title?: string; version?: string } | null = null;
  protocolVersion: string | null = null;

  constructor(
    readonly id: string,
    private readonly spec: McpServerSpec
  ) {}

  get isConnected(): boolean {
    return this.child !== null && !this.closed;
  }

  /** Recent stderr from the server, for showing why a connection failed. */
  get diagnostics(): string {
    return this.stderr.join("").trim();
  }

  async connect(): Promise<void> {
    if (this.child) return;

    try {
      this.child = Bun.spawn([this.spec.command, ...(this.spec.args ?? [])], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // The child inherits our environment plus whatever the server needs;
        // tokens live in the spec, never in the bundle.
        env: { ...process.env, ...(this.spec.env ?? {}) },
        ...(this.spec.cwd ? { cwd: this.spec.cwd } : {}),
      }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    } catch (cause) {
      throw new Error(
        messages.mcpSpawnFailed(this.spec.command, cause instanceof Error ? cause.message : String(cause))
      );
    }

    void this.readStdout();
    void this.readStderr();
    void this.watchExit();

    const result = (await this.request(
      "initialize",
      {
        protocolVersion: CLIENT_PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      HANDSHAKE_TIMEOUT_MS
    )) as { protocolVersion?: string; serverInfo?: Record<string, string> };

    this.protocolVersion = result?.protocolVersion ?? null;
    this.serverInfo = result?.serverInfo ?? null;

    // Required by the spec: the server may not send anything until it arrives.
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDefinition[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as McpToolResult;

    return {
      content: Array.isArray(result?.content) ? result.content : [],
      ...(result?.isError ? { isError: true } : {}),
    };
  }

  /** Concatenate a tool result's text blocks, which is what callers want. */
  static textOf(result: McpToolResult): string {
    return result.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(messages.mcpDisconnected));
    }
    this.pending.clear();

    try {
      this.child?.stdin?.end();
      this.child?.kill();
    } catch {
      // Already gone; nothing to clean up.
    }
    this.child = null;
  }

  // ---- transport ----

  private request(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(messages.mcpDisconnected));
    }

    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(messages.mcpTimeout(method, timeoutMs)));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.child!.stdin!.write(payload);
        this.child!.stdin!.flush?.();
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(cause instanceof Error ? cause.message : String(cause)));
      }
    });
  }

  private notify(method: string, params: unknown = {}): void {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      this.child.stdin!.flush?.();
    } catch {
      // A notification that cannot be delivered is not worth failing over.
    }
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.child!.stdout) {
        this.buffer += decoder.decode(chunk, { stream: true });

        let newline = this.buffer.indexOf("\n");
        while (newline !== -1) {
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          newline = this.buffer.indexOf("\n");
          if (line) this.handleLine(line);
        }
      }
    } catch {
      // The stream ends when the child exits; `watchExit` reports that.
    }
  }

  private handleLine(line: string): void {
    let message: {
      id?: number | string | null;
      result?: unknown;
      error?: { code: number; message: string };
    };

    try {
      message = JSON.parse(line);
    } catch {
      // Servers that print to stdout instead of stderr are common enough that
      // this must not be fatal — the line is simply not a response.
      return;
    }

    if (typeof message.id !== "number") return; // notification or request from server
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(messages.mcpServerError(message.error.message, message.error.code)));
      return;
    }
    pending.resolve(message.result);
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.child!.stderr) {
        this.stderr.push(decoder.decode(chunk, { stream: true }));
        // Keep only the tail: a chatty server should not grow without bound.
        if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200);
      }
    } catch {
      // Nothing to do; stderr is best-effort diagnostics.
    }
  }

  private async watchExit(): Promise<void> {
    const code = await this.child?.exited;
    if (this.closed) return;

    this.closed = true;
    const reason = messages.mcpExited(code ?? -1, this.diagnostics);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
