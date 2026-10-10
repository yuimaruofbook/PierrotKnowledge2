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

import { readFileSync } from "fs";
import { lstat, readFile, rm, rename, writeFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { isInside } from "../shared/update";
import { CONNECT_TARGETS, type ConnectTarget } from "./connect/targets";
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

/**
 * Whether there is anything at this path to act on.
 *
 * `lstat`, not `stat`: these paths are about to be unlinked, and the macOS
 * launcher on a pre-0.5.0 install is a symlink into `build/` — which is
 * regenerated and no longer holds a desktop app. `stat` follows the link,
 * fails on the missing target, and reports the dead icon as absent, leaving it
 * on the Desktop after a "successful" uninstall.
 */
async function exists(path: string): Promise<boolean> {
  return !!(await lstat(path).catch(() => null));
}

/**
 * Whether a target keeps its config inside the knowledge bundle.
 *
 * Asked of the target rather than declared on it, so a bundle-scoped host added
 * later cannot be missed by forgetting a flag — the one failure mode that made
 * this worth fixing. Two probes: a path that changes with the bundle root is
 * one that lives under it.
 */
function isBundleScoped(target: ConnectTarget): boolean {
  return target.configPath("/okf-probe-a") !== target.configPath("/okf-probe-b");
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

  // Every bundle, not just the first.
  //
  // Three of the targets keep their config *inside* the bundle
  // (`<bundle>/.mcp.json`, `<bundle>/.cursor/mcp.json`,
  // `<bundle>/.agents/mcp_config.json`), so which bundle we ask about decides
  // which registrations get cleaned up. Asking only about `knownBundles[0]`
  // left the second bundle's three entries behind — and when nothing was known
  // at all, `configPath("")` produced a *relative* path resolved against the
  // process's own directory, so the real bundle's entries survived an uninstall
  // that reported success.
  const bundleRoots = options.knownBundles.filter((bundle) => bundle && isAbsolute(bundle));
  const seenConfigs = new Set<string>();

  for (const target of CONNECT_TARGETS) {
    // A target whose path does not depend on the bundle still has to be swept
    // once, which is what the empty-string case is for here — its result is
    // the same whatever is passed.
    const roots = isBundleScoped(target) ? bundleRoots : [bundleRoots[0] ?? ""];

    for (const root of roots) {
      const path = target.configPath(root);
      // The same file can be named by two targets, or by two bundles.
      if (seenConfigs.has(path)) continue;
      seenConfigs.add(path);

      if (target.cliRemove) {
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
  }

  for (const launcher of options.launcherPaths ?? []) {
    if (!(await exists(launcher))) continue;
    items.push({ what: "ランチャー / ショートカット", path: launcher, action: "remove" });
  }

  // The script setup writes for the desktop shortcuts to run. It lives inside
  // the install directory, which the user deletes by hand — but it is listed so
  // the plan accounts for everything setup created, rather than leaving one
  // file unexplained.
  const launchScript = join(options.installDir, ".launch-ui.sh");
  if (await exists(launchScript)) {
    items.push({ what: "起動スクリプト", path: launchScript, action: "remove" });
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
        // Recursive because a launcher is not always a file: the macOS `.app`
        // from a pre-0.5.0 install is a directory when it was copied rather
        // than symlinked, and a plain `rm` throws EISDIR on it — turning a
        // successful uninstall into a reported failure.
        await rm(item.path, { recursive: true, force: true });
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
export function launcherPathsFor(appName: string, desktopDirs?: readonly string[]): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return [];

  const desktops = desktopDirs?.length ? desktopDirs : desktopDirectories(home);

  if (process.platform === "win32") return desktops.map((d) => join(d, `${appName}.lnk`));

  if (process.platform === "darwin") {
    return desktops.flatMap((d) => [join(d, `${appName}.app`), join(d, `${appName}.command`)]);
  }

  const applications = join(home, ".local", "share", "applications");
  return [
    ...desktops.flatMap((d) => [join(d, "okf-wiki.desktop"), join(d, `${appName}.desktop`)]),
    join(applications, "okf-wiki.desktop"),
    join(applications, `${appName}.desktop`),
  ];
}

/**
 * Every directory that might be the desktop, current setting first.
 *
 * `~/Desktop` is only the desktop on an English-locale machine: a Japanese
 * GNOME puts it at `~/デスクトップ`, a Spanish one at `~/Escritorio`. Setup
 * asks `xdg-user-dir` and writes the launcher wherever that says, so an
 * uninstall that looks only in `~/Desktop` leaves a menu entry pointing at an
 * application that is gone.
 *
 * All candidates are returned rather than just the configured one, because the
 * setting can have changed since the launcher was written — and every path
 * here is only ever probed for existence before being touched.
 */
export function desktopDirectories(home: string): string[] {
  const found: string[] = [];
  const add = (dir: string | undefined): void => {
    if (dir && !found.includes(dir)) found.push(dir);
  };

  add(readXdgDesktopDir(home));
  add(process.env.XDG_DESKTOP_DIR);
  add(join(home, "Desktop"));
  return found;
}

/**
 * The desktop from `user-dirs.dirs`, read rather than shelled out to.
 *
 * `xdg-user-dir` is a binary that minimal installs do not carry, but the file
 * it reads is plain text and always present when the setting exists.
 */
function readXdgDesktopDir(home: string): string | undefined {
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  let text: string;
  try {
    text = readFileSync(join(config, "user-dirs.dirs"), "utf8");
  } catch {
    return undefined;
  }

  const match = /^\s*XDG_DESKTOP_DIR\s*=\s*"([^"]*)"/m.exec(text);
  const raw = match?.[1]?.replace(/\/+$/, "");
  if (!raw) return undefined;

  // The file writes the home-relative form as `$HOME/Desktop`. Rejoined rather
  // than concatenated so the result carries this platform's separator, like
  // every other path here.
  const relative = /^\$HOME\/?/.exec(raw);
  return relative ? join(home, raw.slice(relative[0].length)) : raw;
}

/** Every app-data location, including the pre-rename one. */
export function appDataLocations(file: string): string[] {
  return appDataReadPaths(file);
}
