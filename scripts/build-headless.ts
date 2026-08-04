/**
 * Build the headless MCP server as a single self-contained executable.
 *
 * Headless is the mode to run when an agent is the only user: it is the same
 * `Workspace` the interface drives, without a browser attached — which is
 * where most of the desktop build's memory goes.
 *
 * Compiled rather than shipped as a script so an agent host can spawn it
 * directly. `bun run …/standalone.ts` works too, but requires Bun on PATH and
 * pays module resolution on every spawn; MCP hosts start servers often.
 */

import { mkdir, open, stat } from "fs/promises";
import { join, resolve } from "path";

const root = resolve(import.meta.dir, "..");
const outDir = join(root, "build", "headless");
const outFile = join(outDir, process.platform === "win32" ? "okf-mcp.exe" : "okf-mcp");

await mkdir(outDir, { recursive: true });

/**
 * Is the existing binary running right now?
 *
 * Asked *before* building, not inferred from the failure afterwards. This file
 * is what agent hosts spawn, and a host holds it open for the whole session —
 * Claude Code does — so rebuilding while an agent is connected is the common
 * case, not an edge one. Bun reports it as a bare `EPERM` naming a path on one
 * run and a bare "Bundle failed" on the next, neither of which says that
 * something is using the file.
 *
 * Opening for write is the check: Windows refuses with `EBUSY` on a loaded
 * image, POSIX with `ETXTBSY`.
 */
async function isInUse(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "r+");
    await handle.close();
    return false;
  } catch (cause) {
    const reason = String(cause);
    if (/ENOENT/.test(reason)) return false; // Nothing built yet.
    return /EBUSY|ETXTBSY|EPERM|EACCES/.test(reason);
  }
}

if (await isInUse(outFile)) {
  console.error("");
  console.error("  実行中のため置き換えられません:");
  console.error(`    ${outFile}`);
  console.error("");
  console.error("  エージェントホスト（Claude Code / Codex / opencode / Hermes）が");
  console.error("  このサーバーを起動したままだと、ファイルを差し替えられません。");
  console.error("  そのセッションを終了してから、もう一度実行してください。");
  console.error("");
  console.error("  いま入っているバイナリはそのまま動きます。ビルドし直さなくても");
  console.error("  エージェントは使い続けられます。");
  console.error("");
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: [join(root, "src", "bun", "mcp", "standalone.ts")],
  compile: { outfile: outFile },
  minify: true,
  target: "bun",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const { size } = await stat(outFile);
console.log(`  ${outFile}`);
console.log(`  ${(size / 1024 / 1024).toFixed(1)} MB — self-contained, no Bun install required`);
console.log("");
console.log("  MCP host config:");
console.log(`    "command": ${JSON.stringify(outFile.replace(/\\/g, "/"))}`);
console.log('    "env": { "OKF_BUNDLE": "/path/to/your-bundle" }');
