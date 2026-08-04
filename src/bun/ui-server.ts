/**
 * The same interface, served to a browser you already have open.
 *
 * The desktop build spent its memory on a runtime nobody asked for: measured
 * at 633 MB resident, of which ~360 MB was the six renderer processes Windows
 * starts for one system-WebView window and ~232 MB a second copy of the Bun
 * runtime. Our own code is about 10 MB of heap. Serving the identical Vite
 * bundle to a browser that is already running deleted both of those costs and
 * changed nothing about the application — which is why, at 0.5.0, this became
 * the only interface.
 *
 * ## Why this is locked down
 *
 * This process can read and write every file in the bundle, and it now
 * answers HTTP. Two things follow, and neither is optional:
 *
 *   - **It binds to 127.0.0.1.** Not `0.0.0.0`. Otherwise the knowledge base
 *     is served to the network the laptop happens to be on.
 *   - **Every request carries a token minted for this run.** Without one, any
 *     page open in the same browser could POST to `localhost` and drive the
 *     RPC — the browser attaches no origin restriction the server can trust,
 *     and DNS rebinding defeats an Origin check on its own. The token is in
 *     the URL the user is handed and is never written to disk.
 */

import { randomBytes } from "crypto";
import { join } from "path";
import type { ServerWebSocket } from "bun";
import type { Connections } from "./connections";
import { createRequestHandlers } from "./rpc";
import { nativePlatform, type Platform } from "./platform";
import type { Workspace } from "./workspace";

/** Message shapes on the socket. Deliberately tiny — this is not JSON-RPC. */
interface CallMessage {
  id: number;
  method: string;
  params?: unknown;
}

type Handlers = Record<string, (params: never) => unknown>;

export interface UiServerOptions {
  workspace: Workspace;
  connections: Connections;
  /** Directory holding the built view (index.html and assets/). */
  viewRoot: string;
  /** 0 asks the OS for a free one, which is the sane default. */
  port?: number;
  /**
   * How to reach the desktop session, if there is one.
   *
   * Defaults to the OS itself: `okf ui` runs on the machine the user is
   * sitting at, so the folder dialog and the link opener are available to it
   * even though the page is in a browser. Overridden with `browserPlatform`
   * where there is no session to talk to — a container, a test.
   */
  platform?: Platform;
}

export interface UiServer {
  url: string;
  port: number;
  stop(): void;
  /** Push a message to every attached browser tab. */
  broadcast(type: string, payload: unknown): void;
}

/**
 * Constant-time-ish comparison.
 *
 * The token is compared on every request, and a plain `===` leaks its prefix
 * through timing. Cheap to avoid, so avoided.
 */
function tokenMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot)]) ?? "application/octet-stream";
}

export function startUiServer(options: UiServerOptions): UiServer {
  const token = randomBytes(24).toString("hex");
  const sockets = new Set<ServerWebSocket<unknown>>();

  const broadcast = (type: string, payload: unknown) => {
    const line = JSON.stringify({ type, payload });
    for (const socket of sockets) socket.send(line);
  };

  const handlers = createRequestHandlers(
    options.workspace,
    options.connections,
    options.platform ?? nativePlatform,
    (step) => broadcast("agentStep", step)
  ) as unknown as Handlers;

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    // Loopback only. The bundle is not something to put on a network by
    // accident, and this is the one line that decides it.
    hostname: "127.0.0.1",
    port: options.port ?? 0,

    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
        let call: CallMessage;
        try {
          call = JSON.parse(String(raw)) as CallMessage;
        } catch {
          return;
        }

        const handler = handlers[call.method];
        if (!handler) {
          ws.send(JSON.stringify({ id: call.id, error: `unknown method: ${call.method}` }));
          return;
        }

        try {
          const result = await handler(call.params as never);
          ws.send(JSON.stringify({ id: call.id, result: result ?? null }));
        } catch (error) {
          // The message, not the stack: it is shown in the status bar.
          ws.send(
            JSON.stringify({
              id: call.id,
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      },
    },

    // The annotation is required, not stylistic: `fetch` refers to `server`,
    // which is still being initialised, so its type cannot be inferred.
    async fetch(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      const queryToken = url.searchParams.get("token") ?? "";
      const hasQueryToken = tokenMatches(queryToken, token);

      /**
       * The RPC endpoint demands the token itself, not the cookie.
       *
       * Cookies ignore the port, so every local server on 127.0.0.1 shares a
       * cookie jar with this one. `SameSite=Strict` already stops a page on
       * another origin from having its cookie attached, but the capability
       * here is read/write over the whole bundle — worth a second lock that
       * only the page we handed the URL to can open.
       */
      if (url.pathname === "/rpc") {
        if (!hasQueryToken) return new Response("forbidden", { status: 403 });
        // The second argument is required by Bun.serve typings even when
        // there is no per-socket data to attach.
        return server.upgrade(request, { data: {} })
          ? undefined
          : new Response("expected websocket", { status: 400 });
      }

      // Assets are fetched by the page with no query string of their own —
      // the token only ever rides on the document URL — so the cookie set
      // alongside the document is what authorises them.
      const cookie = request.headers.get("cookie") ?? "";
      const cookieToken = /(?:^|;\s*)okf_token=([a-f0-9]+)/.exec(cookie)?.[1] ?? "";
      if (!hasQueryToken && !tokenMatches(cookieToken, token)) {
        return new Response("forbidden", { status: 403 });
      }

      // Static files. `join` on a URL path is not enough on its own — a
      // request for `/../../secrets` would escape — so the result is checked
      // against the root it must stay inside.
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const path = join(options.viewRoot, rel);
      if (!path.startsWith(options.viewRoot)) return new Response("forbidden", { status: 403 });

      const file = Bun.file(path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });

      const headers = new Headers({ "content-type": contentTypeFor(path) });
      if (hasQueryToken) {
        // HttpOnly so no script can read it back out; Strict so it is never
        // attached to a request started by any other origin.
        headers.set("set-cookie", `okf_token=${token}; Path=/; HttpOnly; SameSite=Strict`);
      }

      return new Response(file, { headers });
    },
  });

  // Non-null: Bun assigns a port on a TCP listener, and this one always is.
  const port = server.port!;
  return {
    port,
    url: `http://127.0.0.1:${port}/?token=${token}`,
    stop: () => server.stop(true),
    broadcast,
  };
}
