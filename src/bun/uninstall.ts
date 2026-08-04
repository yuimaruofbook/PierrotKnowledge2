/**
 * Removing this application, without removing what it was holding.
 *
 * Uninstalling is the most dangerous thing here. The knowledge bundle is
 * ordinary files in an ordinary folder, and a folder is exactly what an
 * uninstaller deletes — so the entire design is about making that impossible
 * rather than merely unlikely:
 *
 *   - **Nothing is deleted without `--apply`.** The default is a plan.
 *   - **Bundles are named in the plan as things that will survive**, so the
 *     user sees their notes are safe before agreeing to anything.
 *   - **A bundle inside the install directory aborts the whole operation.**
 *     There, removing the app *is* removing the notes.
 *   - **The install directory is not deleted by this code at all.** The user
 *     deletes it, after the app has stopped. Anything else means a running
 *     process trying to remove its own executable, which on Windows half
 *     succeeds and leaves a mess.
 *
 * What it does do is the part a person cannot easily do by hand: take our
 * entry back out of every agent host's config. Left behind, each of those
 * reports a broken MCP server on every launch, and the user has to work out
 * which tool is complaining about a program that no longer exists.
 */

import { readFile, rm, rename, stat, writeFile } from "fs/promises";
import { join } from "path";
import { isInside } from "../shared/update";
import { CONNECT_TARGETS } from "./connect/targets";
import {
  removeFromCodexToml,
  removeFromHermesYaml,
  removeFromMcpJson,
  removeFromOpencodeJson,
} from "./connect/merge";
import { appDataPath, appDataReadPaths } from "./app-paths";

const SERVER_NAME = "okf-wiki";

const REMOVERS: Record<string, (existing: string | null, name: string) => string | null> = {
  "mcp-json": removeFromMcpJson,
  "codex-toml": removeFromCodexToml,
  "opencode-json": removeFromOpencodeJson,
  "hermes-yaml": removeFromHermesYaml,
};

export interface UninstallItem {
  /** What it is, in the user's terms. */
  what: string;
  path: string;
  /**
   * `remove` deletes; `edit` takes our entry out and leaves the file; `run`
   * asks the tool to undo its own registration.
   *
   * `run` exists because a tool that registered us through its own CLI keeps
   * state beside the config entry — enabled tool lists, OAuth tokens — and
   * deleting the entry by hand leaves that behind.
   */
  action: "remove" | "edit" | "run";
  /** For `run`: the command, and anything its prompt needs on stdin. */
  command?: { command: string; args: string[]; stdin?: string };
  /**
   * Which dialect to edit, carried from the plan.
   *
   * Not re-derived when applying: doing that meant matching a config path back
   * to a target, which needs the bundle root — and by then the nearest string
   * to hand was an app-data path. A near miss there edits the wrong file or
   * silently does nothing.
   */
  format?: string;
}

export interface UninstallPlan {
  /** Things this will act on. */
  items: UninstallItem[];
  /** Paths that will be left exactly as they are, and said so out loud. */
  preserved: string[];
  /** Reasons the whole thing must not proceed. */
  blockers: string[];
  /** The folder the user deletes by hand once the app has stopped. */
  installDir: string;
}

export interface UninstallOptions {
  installDir: string;
  /** Every bundle this app knows about. */
  knownBundles: readonly string[];
  /** Also remove the session and the MCP server registry. */
  purgeSettings?: boolean;
  /** Desktop and menu launchers, when any exist. */
  launcherPaths?: readonly string[];
}

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => null));
}

/** Work out what would happen, touching nothing. */
export async function planUninstall(options: UninstallOptions): Promise<UninstallPlan> {
  const items: UninstallItem[] = [];
  const preserved: string[] = [];
  const blockers: string[] = [];

  // The bundles. Named first and named as survivors, because that is the
  // question anyone uninstalling this actually has.
  //
  // Deduplicated on a normalised form: the same folder arrives twice, once
  // from the saved session and once from OKF_BUNDLE, differing only in slash
  // direction. Listing it twice makes the reader wonder which one is real.
  const seen = new Set<string>();
  for (const bundle of options.knownBundles) {
    if (!bundle) continue;

    const key = bundle.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (isInside(options.installDir, bundle)) {
      blockers.push(
        `知識バンドルがアプリのフォルダ内にあります: ${bundle}\n` +
          `  アプリを消すとノートも消えます。先に外（例: ドキュメント）へ移動してください。`
      );
      continue;
    }
    preserved.push(bundle);
  }

  // Our entry in each agent host's config.
  for (const target of CONNECT_TARGETS) {
    if (target.cliRemove) {
      const path = target.configPath(options.knownBundles[0] ?? "");
      // Only if we are actually in there: `hermes mcp remove` on an absent
      // server is a failure, and a plan that always fails is worse than one
      // that leaves nothing behind.
      const existing = await readFile(path, "utf8").catch(() => null);
      if (!existing?.includes(SERVER_NAME)) continue;

      items.push({
        what: `${target.label} の設定から MCP エントリを削除`,
        path,
        action: "run",
        command: target.cliRemove(SERVER_NAME),
      });
      continue;
    }

    if (!target.format) continue;
    const path = target.configPath(options.knownBundles[0] ?? "");
    if (!(await exists(path))) continue;

    const existing = await readFile(path, "utf8").catch(() => null);
    const remover = REMOVERS[target.format];
    if (!remover || remover(existing, SERVER_NAME) === null) continue;

    items.push({
      what: `${target.label} の設定から MCP エントリを削除`,
      path,
      action: "edit",
      format: target.format,
    });
  }

  for (const launcher of options.launcherPaths ?? []) {
    if (!(await exists(launcher))) continue;
    items.push({ what: "ランチャー / ショートカット", path: launcher, action: "remove" });
  }

  // App data holds the session pointer and the registry of external MCP
  // servers. Neither is knowledge, but the registry is work the user did, so
  // it goes only when asked.
  for (const file of ["session.json", "mcp-servers.json", "runtimes.json"]) {
    const path = appDataPath(file);
    if (!(await exists(path))) continue;

    if (options.purgeSettings) {
      items.push({ what: `設定 (${file})`, path, action: "remove" });
    } else {
      preserved.push(path);
    }
  }

  return { items, preserved, blockers, installDir: options.installDir };
}

export interface UninstallResult {
  done: string[];
  failed: Array<{ path: string; reason: string }>;
  /** Backups taken before editing someone else's config. */
  backups: string[];
}

/**
 * Carry out a plan.
 *
 * Every config this edits belongs to another tool, so each one is copied aside
 * first — the same courtesy connecting extends, for the same reason.
 */
export async function applyUninstall(plan: UninstallPlan): Promise<UninstallResult> {
  if (plan.blockers.length > 0) {
    throw new Error(`中止しました:\n${plan.blockers.join("\n")}`);
  }

  const done: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  const backups: string[] = [];

  for (const item of plan.items) {
    try {
      if (item.action === "remove") {
        await rm(item.path, { force: true });
        done.push(item.what);
        continue;
      }

      if (item.action === "run") {
        if (!item.command) continue;
        const proc = Bun.spawn([item.command.command, ...item.command.args], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        if (item.command.stdin) proc.stdin.write(item.command.stdin);
        await proc.stdin.end();
        const output = await new Response(proc.stderr).text();
        if ((await proc.exited) !== 0) throw new Error(output.trim() || item.what);
        done.push(item.what);
        continue;
      }

      const remover = item.format ? REMOVERS[item.format] : undefined;
      if (!remover) continue;

      const existing = await readFile(item.path, "utf8");
      const next = remover(existing, SERVER_NAME);
      if (next === null) continue;

      const backup = `${item.path}.okf-backup-${Date.now()}`;
      await rename(item.path, backup);
      backups.push(backup);
      await writeFile(item.path, next, "utf8");
      done.push(item.what);
    } catch (error) {
      failed.push({
        path: item.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { done, failed, backups };
}

/**
 * Every launcher `setup` might have created, on this platform.
 *
 * More than one candidate per platform because setup has branched over time
 * and an install predating this version is still an install: macOS now always
 * writes a `.command`, but a symlinked `.app` exists on any machine set up
 * before the desktop build was removed at 0.5.0, and Linux gets a `.desktop`
 * file on the Desktop *and* a copy in the applications menu. Uninstalling has
 * to clear whichever were actually made, or the user is left with a menu entry
 * that launches nothing.
 *
 * The Linux files are still named `okf-wiki.desktop` — setup wrote that name
 * before the rename — so both names are looked for.
 */
export function launcherPathsFor(appName: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return [];

  const desktop = join(home, "Desktop");

  if (process.platform === "win32") return [join(desktop, `${appName}.lnk`)];

  if (process.platform === "darwin") {
    return [join(desktop, `${appName}.app`), join(desktop, `${appName}.command`)];
  }

  const applications = join(home, ".local", "share", "applications");
  return [
    join(desktop, "okf-wiki.desktop"),
    join(desktop, `${appName}.desktop`),
    join(applications, "okf-wiki.desktop"),
    join(applications, `${appName}.desktop`),
  ];
}

/** Every app-data location, including the pre-rename one. */
export function appDataLocations(file: string): string[] {
  return appDataReadPaths(file);
}
