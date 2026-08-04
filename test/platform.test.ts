/**
 * The native folder dialog, without a desktop session.
 *
 * This is the capability the desktop build used to own exclusively — the last
 * argument for shipping a 633 MB window. What is tested here is the part that
 * can be: which command each OS gets, how its output is read, and the rule
 * that a user who pressed Cancel is not shown a second dialog.
 */

import { describe, expect, test } from "bun:test";
import {
  folderDialogCommands,
  parseFolderDialogOutput,
  runFolderDialog,
  type DialogCommand,
  type DialogOutcome,
} from "../src/bun/platform";

describe("folderDialogCommands", () => {
  test("Windows uses powershell.exe in a single-threaded apartment", () => {
    // WinForms throws without -STA, and `powershell.exe` rather than `pwsh`
    // because every Windows 10/11 has 5.1 and not everyone has installed 7.
    const [command, ...rest] = folderDialogCommands("win32", { title: "選択" });

    expect(rest).toHaveLength(0);
    expect(command!.command).toBe("powershell.exe");
    expect(command!.args).toContain("-STA");
    expect(command!.args).toContain("-NoProfile");

    const script = command!.args.at(-1)!;
    expect(script).toContain("FolderBrowserDialog");
    expect(script).toContain("選択");
  });

  test("Windows opens the dialog in front of the browser window", () => {
    // Without an owner form marked TopMost it appears behind the page the
    // user was just looking at, which reads as the button doing nothing.
    const script = folderDialogCommands("win32", { title: "x" })[0]!.args.at(-1)!;

    expect(script).toContain("$owner.TopMost = $true");
    expect(script).toContain("ShowDialog($owner)");
  });

  test("Windows carries the wording on the label, not the title bar", () => {
    // `UseDescriptionForTitle` is .NET Core 3.0+ WinForms only, and
    // `powershell.exe` is always .NET Framework — verified on 4.8.9337, where
    // the property is absent from the type. Setting it would throw for a
    // title bar we cannot have anyway.
    const script = folderDialogCommands("win32", { title: "選択" })[0]!.args.at(-1)!;

    expect(script).toContain("$d.Description = '選択'");
    expect(script).not.toContain("UseDescriptionForTitle =");
  });

  test("a quote in the title cannot break out of the PowerShell literal", () => {
    const script = folderDialogCommands("win32", { title: "it's here" })[0]!.args.at(-1)!;

    expect(script).toContain("'it''s here'");
  });

  test("macOS asks AppleScript for a POSIX path", () => {
    const [command] = folderDialogCommands("darwin", { title: "選択" });

    expect(command!.command).toBe("osascript");
    expect(command!.args[0]).toBe("-e");
    expect(command!.args[1]).toContain("choose folder");
    // Without this the script returns an alias, not something openable.
    expect(command!.args[1]).toContain("POSIX path of");
  });

  test("a quote in the title cannot break out of the AppleScript literal", () => {
    const script = folderDialogCommands("darwin", { title: 'say "hi"' })[0]!.args[1]!;

    expect(script).toContain('\\"hi\\"');
  });

  test("Linux offers both toolkits, GNOME first", () => {
    // There is no single answer on Linux: a machine may have zenity, kdialog,
    // both or neither, and which one is present is not knowable in advance.
    const commands = folderDialogCommands("linux", { title: "選択" });

    expect(commands.map((c) => c.command)).toEqual(["zenity", "kdialog"]);
    expect(commands[0]!.args).toContain("--directory");
    expect(commands[1]!.args).toContain("--getexistingdirectory");
  });

  test("an OS with no dialog returns nothing rather than a guess", () => {
    // The caller falls back to asking for the path as text, which is a real
    // answer. Spawning something that is not there is not.
    expect(folderDialogCommands("aix", { title: "x" })).toEqual([]);
  });

  test("the starting folder is passed through when there is one", () => {
    expect(folderDialogCommands("win32", { title: "x", start: "C:/notes" })[0]!.args.at(-1))
      .toContain("C:/notes");
    expect(folderDialogCommands("darwin", { title: "x", start: "/notes" })[0]!.args[1])
      .toContain("/notes");
    expect(folderDialogCommands("linux", { title: "x", start: "/notes" })[0]!.args.join(" "))
      .toContain("/notes");
  });
});

describe("parseFolderDialogOutput", () => {
  test("takes the path off the line", () => {
    expect(parseFolderDialogOutput("C:\\Users\\me\\notes\r\n")).toBe("C:\\Users\\me\\notes");
  });

  test("drops the trailing slash macOS adds", () => {
    // Same folder, different string — and this value gets compared against
    // bundle roots.
    expect(parseFolderDialogOutput("/Users/me/notes/\n")).toBe("/Users/me/notes");
  });

  test("keeps a root path that is only a slash", () => {
    expect(parseFolderDialogOutput("/\n")).toBe("/");
  });

  test("nothing chosen is null, not an empty path", () => {
    expect(parseFolderDialogOutput("")).toBeNull();
    expect(parseFolderDialogOutput("  \n ")).toBeNull();
  });
});

describe("runFolderDialog", () => {
  const command = (name: string): DialogCommand => ({ command: name, args: [] });

  test("returns the first dialog's answer", async () => {
    const tried: string[] = [];
    const picked = await runFolderDialog([command("zenity"), command("kdialog")], async (c) => {
      tried.push(c.command);
      return { kind: "picked", path: "/notes" } satisfies DialogOutcome;
    });

    expect(picked).toBe("/notes");
    expect(tried).toEqual(["zenity"]);
  });

  test("moves on when the tool is not installed", async () => {
    const tried: string[] = [];
    const picked = await runFolderDialog([command("zenity"), command("kdialog")], async (c) => {
      tried.push(c.command);
      return c.command === "zenity"
        ? ({ kind: "unavailable" } satisfies DialogOutcome)
        : ({ kind: "picked", path: "/notes" } satisfies DialogOutcome);
    });

    expect(picked).toBe("/notes");
    expect(tried).toEqual(["zenity", "kdialog"]);
  });

  test("a cancel is respected instead of opening the next dialog", async () => {
    // The failure this prevents: press Cancel, and a second dialog appears
    // from the other toolkit — which reads as the app refusing to take no.
    const tried: string[] = [];
    const picked = await runFolderDialog([command("zenity"), command("kdialog")], async (c) => {
      tried.push(c.command);
      return { kind: "cancelled" } satisfies DialogOutcome;
    });

    expect(picked).toBeNull();
    expect(tried).toEqual(["zenity"]);
  });

  test("no candidates at all is null, not a throw", async () => {
    expect(await runFolderDialog([], async () => ({ kind: "picked", path: "/x" }))).toBeNull();
  });
});
