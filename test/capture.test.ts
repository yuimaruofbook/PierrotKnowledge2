/**
 * Naming a file dropped in from outside.
 *
 * The name comes from another machine's filesystem, so it is the one part of a
 * dropped file that can reach for a path of its own. What survives is checked
 * here rather than at the bundle boundary, so the boundary check stays a last
 * line of defence instead of the only one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Bundle } from "../src/bun/okf/bundle";
import { capturePathFor, capturedFileName } from "../src/shared/okf/capture";
import { removeTempDir } from "./helpers";

describe("capturedFileName", () => {
  test("keeps the name the file already had", () => {
    // The whole point of dropping a file in is finding it again by its name.
    expect(capturedFileName("2026-08-08-記事.html")).toBe("2026-08-08-記事.html");
    expect(capturedFileName("notes.md")).toBe("notes.md");
  });

  test("takes the basename, whatever separator was used", () => {
    expect(capturedFileName("folder/sub/page.html")).toBe("page.html");
    expect(capturedFileName("C:\\Users\\me\\page.html")).toBe("page.html");
  });

  test("cannot climb out with dots", () => {
    expect(capturedFileName("../../etc/passwd")).toBe("passwd");
    expect(capturedFileName("..")).toBe("captured");
    expect(capturedFileName("...")).toBe("captured");
  });

  test("strips what a filesystem rejects", () => {
    expect(capturedFileName('a:b*c?d"e<f>g|h.html')).toBe("abcdefgh.html");
    expect(capturedFileName("bell\u0007.html")).toBe("bell.html");
  });

  test("falls back when nothing usable is left", () => {
    expect(capturedFileName("")).toBe("captured");
    expect(capturedFileName("   ")).toBe("captured");
    expect(capturedFileName("///")).toBe("captured");
  });

  test("does not leave a hidden file or a trailing dot", () => {
    // A leading dot hides the capture; a trailing one is invalid on Windows.
    expect(capturedFileName(".env")).toBe("env");
    expect(capturedFileName("report.")).toBe("report");
  });

  test("bounds the length without losing the extension", () => {
    const long = `${"あ".repeat(300)}.html`;
    const named = capturedFileName(long);
    expect(named.length).toBeLessThanOrEqual(120);
    expect(named.endsWith(".html")).toBe(true);
  });
});

describe("capturePathFor", () => {
  test("lands in the raw/ inbox", () => {
    expect(capturePathFor("記事.html")).toBe("raw/記事.html");
  });

  test("a name reaching for another layer cannot get there", () => {
    expect(capturePathFor("../wiki/AGENTS.md")).toBe("raw/AGENTS.md");
  });
});

/** What the `captureFiles` handler does, against a real bundle. */
describe("capturing a dropped file", () => {
  let root: string;
  let bundle: Bundle;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okf-capture-test-"));
    await mkdir(join(root, "wiki"), { recursive: true });
    await mkdir(join(root, "raw"), { recursive: true });
    bundle = await Bundle.open(root);
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  test("an HTML page keeps its markup and its name", async () => {
    const page = "<!DOCTYPE html>\n<html><body><h1>記事</h1></body></html>\n";
    const { path } = await bundle.importToRaw(capturePathFor("記事.html"), page, {
      actor: "human:local",
    });

    expect(path).toBe("raw/記事.html");
    // Verbatim: a captured source that was rewritten on the way in is not a
    // record of anything.
    expect(await readFile(join(root, "raw", "記事.html"), "utf8")).toBe(page);
  });

  test("dropping the same file twice keeps both", async () => {
    const first = await bundle.importToRaw(capturePathFor("page.html"), "<p>1</p>");
    const second = await bundle.importToRaw(capturePathFor("page.html"), "<p>2</p>");

    expect(second.path).not.toBe(first.path);
    expect(await readFile(join(root, first.path), "utf8")).toBe("<p>1</p>");
  });

  test("a name aimed at another layer is refused at the boundary too", async () => {
    // capturePathFor already reduces it to a filename; this is the second lock.
    await expect(bundle.importToRaw("wiki/injected.html", "<p>x</p>")).rejects.toThrow(/raw\//);
  });
});
