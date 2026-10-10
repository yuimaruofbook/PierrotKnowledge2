/**
 * Build the headless MCP server (or, with `cli`, the CLI) as a single
 * self-contained executable.
 *
 *   bun run scripts/build-headless.ts          build/headless/okf-mcp(.exe)
 *   bun run scripts/build-headless.ts cli      build/cli/okf(.exe)
 *
 * Headless is the mode to run when an agent is the only user: it is the same
 * `Workspace` the interface drives, without a browser attached — which is
 * where most of the desktop build's memory goes.
 *
 * The Rust port (`rust/`) is built when `cargo` is on PATH: 7 MB and 8 MB
 * resident against Bun's 94 MB and 90 MB, answering byte for byte the same
 * (`test/rust-parity.test.ts`). Without a Rust toolchain — most machines this
 * runs on during setup — the Rust build attached to this version's release is
 * downloaded and verified instead, and failing that Bun compiles the
 * TypeScript, so setup never requires anything it did not before.
 * `OKF_BUILD=bun` forces the Bun build.
 *
 * Compiled rather than shipped as a script so an agent host can spawn it
 * directly. `bun run …/standalone.ts` works too, but requires Bun on PATH and
 * pays module resolution on every spawn; MCP hosts start servers often.
 */

import { existsSync } from "fs";
import { copyFile, mkdir, open, rename, rm, stat } from "fs/promises";
import { join, resolve } from "path";
import { downloadNativeBinary } from "../src/bun/native-binary";

const root = resolve(import.meta.dir, "..");
const exe = process.platform === "win32" ? ".exe" : "";

const TARGETS = {
  headless: {
    dir: join(root, "build", "headless"),
    name: `okf-mcp${exe}`,
    rustBin: "okf-mcp",
    entry: join(root, "src", "bun", "mcp", "standalone.ts"),
  },
  cli: {
    dir: join(root, "build", "cli"),
    name: `okf${exe}`,
    rustBin: "okf",
    entry: join(root, "src", "bun", "cli", "main.ts"),
  },
} as const;

const which = (process.argv[2] ?? "headless") as keyof typeof TARGETS;
const target = TARGETS[which];
if (!target) {
  console.error(`  不明なビルド対象です: ${process.argv[2]}（headless か cli）`);
  process.exit(1);
}

const outFile = join(target.dir, target.name);
await mkdir(target.dir, { recursive: true });

/**
 * Is the existing binary running right now?
 *
 * Asked *before* replacing, not inferred from the failure afterwards. This file
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
 * Whether a Rust toolchain can build the port here.
 *
 * The sources have to be here too: an install updated by a 0.6 updater gets
 * the new scripts but no `rust/`, since that updater did not know to copy it.
 */
function hasCargo(): boolean {
  if (process.env.OKF_BUILD === "bun") return false;
  if (!existsSync(join(root, "rust", "Cargo.toml"))) return false;
  try {
    return Bun.spawnSync(["cargo", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Build the Rust binary into `rust/target`, before anything is moved.
 *
 * Building beside the installed file rather than over it means a failed
 * compile leaves the working server exactly where hosts expect it.
 */
function buildRust(): string | null {
  const result = Bun.spawnSync(
    ["cargo", "build", "--release", "--manifest-path", join(root, "rust", "Cargo.toml"), "--bin", target.rustBin],
    { stdout: "inherit", stderr: "inherit" }
  );
  if (result.exitCode !== 0) return null;
  return join(root, "rust", "target", "release", `${target.rustBin}${exe}`);
}

/**
 * The Rust build this release published, for a machine without cargo.
 *
 * Downloaded beside the target and verified against GitHub's digest before
 * anything is moved; any failure means the Bun build instead, never no build.
 */
async function downloadRust(): Promise<string | null> {
  const { version } = (await Bun.file(join(root, "package.json")).json()) as { version: string };
  const to = `${outFile}.download`;
  const result = await downloadNativeBinary({ bin: target.rustBin, version, to });
  if (result.ok) return to;
  console.log(`  ビルド済みの Rust 版は使えません（${result.reason}）。Bun 版をビルドします。`);
  return null;
}

// cargo, then the published build, then Bun. Each step that fails falls
// through to the next — offline, an old rustc, a platform nobody builds for —
// because setup must never need more than it did before the port.
let built: string | null = null;
if (hasCargo()) {
  built = buildRust();
  if (!built) console.log("  Rust 版のビルドに失敗しました。ビルド済みの版か Bun 版に切り替えます。");
}
if (!built && process.env.OKF_BUILD !== "bun") built = await downloadRust();
const useRust = built !== null;

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

/** Never leave hosts with nothing to start: the parked build still works. */
async function restoreParked(): Promise<void> {
  if (!didPark) return;
  await rm(outFile, { force: true }).catch(() => {});
  await rename(parked, outFile).catch(() => {
    console.error(`  元のサーバーを戻せませんでした。手動で戻してください: ${parked}`);
  });
}

if (built) {
  try {
    // Copied beside the target and renamed over it, never written in place:
    // macOS does not refuse to overwrite a running binary the way Windows
    // does, and rewriting a signed Mach-O under a live process gets the next
    // spawn killed for a code signature that no longer matches.
    const staged = built.endsWith(".download") ? built : `${outFile}.new`;
    if (staged !== built) await copyFile(built, staged);
    await rename(staged, outFile);
  } catch (cause) {
    console.error(cause);
    await restoreParked();
    process.exit(1);
  }
} else {
  // Bun.build may reject instead of reporting `success: false`; both are a
  // failed build here.
  const result = await Bun.build({
    entrypoints: [target.entry],
    compile: { outfile: outFile },
    minify: true,
    target: "bun",
  }).catch((cause: unknown) => ({ success: false as const, logs: [cause] }));

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    await restoreParked();
    process.exit(1);
  }
}

const { size } = await stat(outFile);
console.log(`  ${outFile}`);
console.log(
  `  ${(size / 1024 / 1024).toFixed(1)} MB — ${useRust ? "Rust 版" : "Bun 版"}、self-contained, no Bun install required`
);
if (which === "headless") {
  console.log("");
  console.log("  MCP host config:");
  console.log(`    "command": ${JSON.stringify(outFile.replace(/\\/g, "/"))}`);
  console.log('    "env": { "OKF_BUNDLE": "/path/to/your-bundle" }');
}
