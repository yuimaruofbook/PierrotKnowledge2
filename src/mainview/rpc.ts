/**
 * Webview end of the RPC bridge.
 *
 * The view holds no filesystem capability of its own; every path it knows came
 * from the Bun side, and every mutation goes back through here.
 *
 * One transport: a WebSocket to `okf ui`. There used to be two — the same
 * bundle also spoke an in-process bridge when it ran inside a packaged desktop
 * shell — but that shell is gone. It cost 633 MB resident against 135 MB for
 * the identical interface in a browser, and by the end its only exclusive
 * capability was a folder dialog the OS will open for any process that asks
 * (see `bun/platform.ts`).
 */

import type { BundleInfo } from "../shared/types";
import type { FileChangedMessage, OkfRpcSchema } from "../shared/rpc-schema";
import type { AgentStep } from "../shared/agent-types";

export interface ViewEvents {
  onBundleOpened?: (info: BundleInfo) => void;
  onBundleClosed?: () => void;
  onFileChanged?: (message: FileChangedMessage) => void;
  onAgentStep?: (step: AgentStep) => void;
}

type Requests = OkfRpcSchema["bun"]["requests"];

export interface ViewRpc {
  request: {
    [K in keyof Requests]: (params: Requests[K]["params"]) => Promise<Requests[K]["response"]>;
  };
}

/**
 * Connect to the server that served this page.
 *
 * Calls made before the socket opens are queued rather than rejected: the page
 * starts asking for state immediately, and losing that race would show as an
 * empty window with an error in the status bar.
 */
export function connect(events: ViewEvents): ViewRpc {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const url = `ws://${location.host}/rpc?token=${encodeURIComponent(token)}`;

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const queue: string[] = [];
  const socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    for (const line of queue.splice(0)) socket.send(line);
  });

  socket.addEventListener("message", (event) => {
    let message: {
      id?: number;
      result?: unknown;
      error?: string;
      type?: string;
      payload?: unknown;
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    // A push, not a reply to anything.
    if (message.type) {
      if (message.type === "fileChanged") {
        events.onFileChanged?.(message.payload as FileChangedMessage);
      } else if (message.type === "agentStep") {
        events.onAgentStep?.(message.payload as AgentStep);
      } else if (message.type === "bundleOpened") {
        events.onBundleOpened?.(message.payload as BundleInfo);
      } else if (message.type === "bundleClosed") {
        events.onBundleClosed?.();
      }
      return;
    }

    if (typeof message.id !== "number") return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);

    if (message.error) waiting.reject(new Error(message.error));
    else waiting.resolve(message.result);
  });

  // The server is this app's own process, so a dropped socket means the app
  // is gone. Reconnecting forever would hide that behind a spinner; failing
  // the outstanding calls says what actually happened.
  socket.addEventListener("close", () => {
    for (const [, waiting] of pending) {
      waiting.reject(new Error("サーバーとの接続が切れました。okf ui を実行し直してください。"));
    }
    pending.clear();
  });

  const call = (method: string, params: unknown) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const line = JSON.stringify({ id, method, params });
      if (socket.readyState === WebSocket.OPEN) socket.send(line);
      else queue.push(line);
    });

  // Every method on the schema without listing any of them: the proxy answers
  // to whatever `main.ts` asks for, so adding an RPC never means editing here.
  const request = new Proxy(
    {},
    { get: (_target, method: string) => (params: unknown) => call(method, params) }
  ) as ViewRpc["request"];

  return { request };
}
