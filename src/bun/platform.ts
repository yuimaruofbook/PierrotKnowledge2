/**
 * The two things the RPC handlers cannot do by themselves.
 *
 * Everything else in `rpc.ts` is a delegation to `Workspace`, which knows
 * nothing about windows. These two are genuinely host-specific: picking a
 * folder needs a native dialog, and opening a URL needs whatever the host uses
 * to hand it to the OS.
 *
 * They are injected rather than imported so the same handlers serve both
 * front ends: the interface in a browser, and a test or a container with no
 * desktop session to talk to.
 *
 * ## Why a native dialog lives here now
 *
 * The folder dialog used to be the desktop build's one exclusive capability,
 * and it was the last argument for shipping a window: 633 MB resident against
 * 135 MB, plus a patched pin of a young framework, for one dialog. The OS
 * already ships that dialog and will open it for any process that asks — so
 * `okf ui` asks, and the window stops being the only way to point the app at
 * a folder.
 */

import { stat } from "fs/promises";

export interface Platform {
  /**
   * Ask the user for a folder, or return null when this host cannot ask.
   *
   * Null is a real answer, not a failure: a host with no desktop session — a
   * container, an SSH shell — has no way to show a dialog, and the caller
   * falls back to asking for the path as text.
   *
   * `start` is where the dialog opens. Switching bundles means landing near
   * the one already open far more often than at the filesystem root.
   */
  pickDirectory(options?: { start?: string }): Promise<string | null>;

  /** Hand a URL to the OS. Returns false when it was refused. */
  openExternal(url: string): boolean | Promise<boolean>;
}

/**
 * The browser-served host, with nothing native behind it.
 *
 * Kept for hosts that genuinely cannot show a dialog, and as the honest
 * default for anything that is not a desktop session.
 */
export const browserPlatform: Platform = {
  pickDirectory: async () => null,
  openExternal: () => false,
};

export interface DialogCommand {
  command: string;
  args: string[];
}

/**
 * What asking for a folder can end in.
 *
 * `unavailable` and `cancelled` are deliberately different: a missing `zenity`
 * means try the next candidate, while a user who pressed Cancel must not be
 * shown a second dialog for having declined the first.
 */
export type DialogOutcome =
  | { kind: "picked"; path: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

/** Wrap a value for PowerShell's single-quoted string literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Wrap a value for an AppleScript double-quoted string literal. */
function asQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The Windows dialog, as a script for `powershell.exe`.
 *
 * `-STA` is not optional: WinForms requires a single-threaded apartment, and
 * `FolderBrowserDialog` throws without one. `powershell.exe` (5.1) is chosen
 * over `pwsh` because every Windows 10/11 has it, and this must not depend on
 * the user having installed PowerShell 7.
 *
 * The dummy owner form is the difference between a dialog the user sees and
 * one that opens behind the browser window they were just looking at.
 */
function windowsScript(title: string, start?: string): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    // The title bar is the OS's own ("Browse For Folder", localised), and
    // stays that way: `UseDescriptionForTitle` exists only on .NET Core 3.0+
    // WinForms, and `powershell.exe` is always .NET Framework — checked on
    // 4.8.9337, where the property is absent from the type entirely. So the
    // wording goes in the label the dialog does show.
    `$d.Description = ${psQuote(title)}`,
    "$d.ShowNewFolderButton = $true",
    ...(start ? [`$d.SelectedPath = ${psQuote(start)}`] : []),
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
    "$owner.Dispose()",
  ].join("\n");
}

/**
 * Every way this OS might be able to show a folder dialog, best first.
 *
 * A list rather than one command because Linux has no single answer: GNOME
 * ships `zenity`, KDE ships `kdialog`, and a machine may have either, both or
 * neither. Windows and macOS each have exactly one entry — their dialog is
 * part of the OS.
 */
export function folderDialogCommands(
  platform: string,
  options: { title: string; start?: string } = { title: "" }
): DialogCommand[] {
  const title = options.title || "フォルダを選択";

  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-STA", "-Command", windowsScript(title, options.start)],
      },
    ];
  }

  if (platform === "darwin") {
    const prompt = `choose folder with prompt ${asQuote(title)}`;
    const withStart = options.start
      ? `${prompt} default location POSIX file ${asQuote(options.start)}`
      : prompt;
    return [{ command: "osascript", args: ["-e", `POSIX path of (${withStart})`] }];
  }

  if (platform === "linux") {
    return [
      {
        command: "zenity",
        args: [
          "--file-selection",
          "--directory",
          `--title=${title}`,
          ...(options.start ? [`--filename=${options.start.replace(/\/?$/, "/")}`] : []),
        ],
      },
      {
        command: "kdialog",
        args: ["--getexistingdirectory", options.start ?? "."],
      },
    ];
  }

  // An OS we have no dialog for. Saying so is better than spawning something
  // that is not there and reporting its ENOENT as a failed pick.
  return [];
}

/**
 * Turn a dialog's stdout into a path.
 *
 * macOS returns a POSIX path with a trailing slash, which is the same folder
 * but not the same string — and this value goes on to be compared against
 * bundle roots.
 */
export function parseFolderDialogOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const withoutTrailingSlash = trimmed.replace(/(?<=.)[/\\]+$/, "");
  return withoutTrailingSlash || trimmed;
}

/**
 * Try each candidate until one of them actually asks the user.
 *
 * Split from the spawning so the order — and the rule that a cancel stops the
 * search — can be tested without a desktop session.
 */
export async function runFolderDialog(
  candidates: readonly DialogCommand[],
  run: (candidate: DialogCommand) => Promise<DialogOutcome>
): Promise<string | null> {
  for (const candidate of candidates) {
    const outcome = await run(candidate);
    if (outcome.kind === "picked") return outcome.path;
    if (outcome.kind === "cancelled") return null;
  }
  return null;
}

/** Spawn one dialog and classify how it ended. */
async function spawnDialog(candidate: DialogCommand): Promise<DialogOutcome> {
  let proc;
  try {
    proc = Bun.spawn([candidate.command, ...candidate.args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    // Not installed. The next candidate may be.
    return { kind: "unavailable" };
  }

  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;

  const path = parseFolderDialogOutput(stdout);
  if (code === 0 && path) return { kind: "picked", path };

  // Everything else is a user who declined: `zenity` and `osascript` both exit
  // non-zero for Cancel, and Windows simply prints nothing. A dialog that
  // failed for its own reasons lands here too, and null is the right answer
  // for that as well — the caller asks for the path as text instead.
  return { kind: "cancelled" };
}

/** Reject a path the dialog gave us that is not a usable folder. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The OS opener, by platform.
 *
 * `start` needs its empty-title argument on Windows, or a quoted URL is read
 * as the window title and nothing opens.
 */
function openCommand(platform: string, url: string): DialogCommand | null {
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "linux") return { command: "xdg-open", args: [url] };
  return null;
}

/**
 * The browser-served host, using the desktop session it is running on.
 *
 * One dialog at a time: the folder button is easy to press twice, and the
 * second press should join the dialog already open rather than stack another
 * on top of it.
 */
let pending: Promise<string | null> | null = null;

export const nativePlatform: Platform = {
  async pickDirectory(options?: { start?: string }): Promise<string | null> {
    if (pending) return pending;

    pending = (async () => {
      const candidates = folderDialogCommands(process.platform, {
        title: "バンドルのフォルダを選択",
        ...(options?.start ? { start: options.start } : {}),
      });
      const picked = await runFolderDialog(candidates, spawnDialog);
      if (!picked) return null;
      // A dialog cannot normally return a folder that is not there, but this
      // value becomes a bundle root — so it is checked rather than trusted.
      return (await isDirectory(picked)) ? picked : null;
    })();

    try {
      return await pending;
    } finally {
      pending = null;
    }
  },

  openExternal(url: string): boolean {
    const command = openCommand(process.platform, url);
    if (!command) return false;
    try {
      Bun.spawn([command.command, ...command.args], { stdout: "ignore", stderr: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
};
