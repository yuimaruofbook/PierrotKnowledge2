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

import { mkdir, open, rename, rm, stat } from "fs/promises";
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

/**
 * Move a running server out of the way instead of refusing to build.
 *
 * Windows will not overwrite an executable that is running, but it will rename
 * one: the sessions using it keep their image, and every host that starts the
 * server afterwards gets the new build. Refusing here is what left agents on a
 * stale server — 39 tools while the source had 41 — because some host always
 * had it open. The parked copy is removed by the next build that can.
 */
const parked = `${outFile}.old`;
await rm(parked, { force: true }).catch(() => {
  // Still running from an earlier park; the rename below then fails and says so.
});

let didPark = false;
if (await isInUse(outFile)) {
  try {
    await rename(outFile, parked);
    didPark = true;
    console.log("  実行中のサーバーを退避しました（使用中のセッションはそのまま動きます）:");
    console.log(`    ${parked}`);
  } catch {
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
}

// Bun.build may reject instead of reporting `success: false`; both are a
// failed build here.
const result = await Bun.build({
  entrypoints: [join(root, "src", "bun", "mcp", "standalone.ts")],
  compile: { outfile: outFile },
  minify: true,
  target: "bun",
}).catch((cause: unknown) => ({ success: false as const, logs: [cause] }));

if (!result.success) {
  for (const log of result.logs) console.error(log);
  // Never leave hosts with nothing to start: the parked build still works.
  if (didPark) {
    await rm(outFile, { force: true }).catch(() => {});
    await rename(parked, outFile).catch(() => {
      console.error(`  元のサーバーを戻せませんでした。手動で戻してください: ${parked}`);
    });
  }
  process.exit(1);
}

const { size } = await stat(outFile);
console.log(`  ${outFile}`);
console.log(`  ${(size / 1024 / 1024).toFixed(1)} MB — self-contained, no Bun install required`);
console.log("");
console.log("  MCP host config:");
console.log(`    "command": ${JSON.stringify(outFile.replace(/\\/g, "/"))}`);
console.log('    "env": { "OKF_BUNDLE": "/path/to/your-bundle" }');
