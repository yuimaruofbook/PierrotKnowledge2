/**
 * Standalone MCP entry point for external agents (Claude Code, etc.).
 *
 *   OKF_BUNDLE=/path/to/bundle bun run src/bun/mcp/standalone.ts
 *
 * Diagnostics go to stderr only: stdout carries the JSON-RPC stream, and a
 * stray log line there corrupts the protocol.
 */

import { Workspace } from "../workspace";
import { runStdioServer } from "./stdio";

const bundlePath = process.env.OKF_BUNDLE ?? process.argv[2];

// Watching costs nothing here and keeps a long-lived agent session consistent
// with edits the human makes in the GUI at the same time.
const workspace = new Workspace({
  watch: true,
  onError: (error) => console.error("[okf-wiki mcp]", error),
});

if (bundlePath) {
  try {
    const info = await workspace.open(bundlePath);
    console.error(`[okf-wiki mcp] opened ${info.root} (${info.conceptCount} concepts)`);
  } catch (error) {
    console.error(`[okf-wiki mcp] failed to open ${bundlePath}:`, error);
  }
} else {
  console.error("[okf-wiki mcp] no OKF_BUNDLE set — call the open_bundle tool first");
}

const shutdown = () => {
  void workspace.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await runStdioServer(workspace);
await workspace.close();
