/**
 * Extracting the release archive on someone else's machine.
 *
 * Two ways this failed outside Windows: a stock Ubuntu has neither `unzip` nor
 * bsdtar (GNU tar cannot read a zip), and the 0.8.x archives recorded their
 * top-level folder as a 0644 file, which `unzip` applied — leaving a folder
 * nobody could enter, so the update found no package.json in it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { extractCommands, makeTraversable } from "../src/bun/update-zip";
import { removeTempDir } from "./helpers";

describe("extractCommands", () => {
  test("Unix falls back to Python when neither unzip nor bsdtar exists", () => {
    const names = extractCommands("linux", "/tmp/a.zip", "/tmp/out").map((c) => c[0]);
    expect(names).toEqual(["unzip", "bsdtar", "tar", "python3"]);
  });

  test("Python is asked for its own zipfile extractor, with the paths as arguments", () => {
    const python = extractCommands("darwin", "/tmp/a b.zip", "/tmp/o u t").find((c) => c[0] === "python3")!;
    expect(python).toEqual(["python3", "-m", "zipfile", "-e", "/tmp/a b.zip", "/tmp/o u t"]);
  });

  test("Windows uses Expand-Archive with quotes escaped", () => {
    const [command] = extractCommands("win32", "C:\\x\\it's.zip", "C:\\out");
    expect(command![0]).toBe("powershell");
    expect(command!.at(-1)).toContain("'C:\\x\\it''s.zip'");
  });
});

const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("makeTraversable", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "okf-zip-"));
  });

  afterEach(async () => {
    await chmod(join(dir, "top"), 0o755).catch(() => {});
    await removeTempDir(dir);
  });

  test("a folder extracted as 0644 can be entered and read again", async () => {
    const top = join(dir, "top");
    await mkdir(join(top, "src"), { recursive: true });
    await writeFile(join(top, "package.json"), "{}");
    await chmod(top, 0o644);

    await makeTraversable(dir);

    expect((await stat(top)).mode & 0o700).toBe(0o700);
    expect(await readFile(join(top, "package.json"), "utf8")).toBe("{}");
  });
});
