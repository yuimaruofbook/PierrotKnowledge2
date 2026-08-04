/**
 * Opening a folder must not depend on being able to create `index.md`.
 *
 * A user reported binding a folder failing with a bare
 * `ENOENT: no such file or directory, open 'C:\...\PierrotKnowledge2\index.md'`.
 * Every note in the folder was readable; the open aborted because the two
 * reserved files could not be written. An entry point and a history are a
 * convenience, and losing them is not worth losing the bundle.
 *
 * A name occupied by a broken link is the reproduction used here — the write
 * follows the link, finds nothing at the other end, and fails with ENOENT
 * naming a path that plainly exists. The behaviour under test is the general
 * one: whatever makes the reserved file unwritable, the folder still opens and
 * the reason is reported.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Bundle } from "../src/bun/okf/bundle";
import { Workspace } from "../src/bun/workspace";
import { removeTempDir } from "./helpers";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okf-reserved-"));
});

afterEach(async () => {
  // Unlink junctions before removing the tree: a recursive delete that follows
  // one would take the target's contents with it.
  for (const name of ["index.md", "log.md"]) {
    const proc = Bun.spawn(["cmd", "/c", "rmdir", join(root, name)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  }
  await removeTempDir(root);
});

/** Leave `name` as a directory entry that exists but leads nowhere. */
async function danglingLink(name: string): Promise<boolean> {
  const target = join(root, "target-to-remove");
  await mkdir(target, { recursive: true });
  const proc = Bun.spawn(["cmd", "/c", "mklink", "/J", join(root, name), target], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  await rm(target, { recursive: true, force: true });
  return (await proc.exited) === 0;
}

const windowsOnly = process.platform === "win32" ? describe : describe.skip;

windowsOnly("a reserved file that cannot be written", () => {
  test("does not stop the folder from opening", async () => {
    if (!(await danglingLink("index.md"))) return; // no junction support here
    await writeFile(join(root, "note.md"), "---\ntype: Concept\n---\n\n# note\n", "utf8");

    const workspace = new Workspace({ watch: false });
    try {
      const info = await workspace.open(root);
      expect(info.root).toBe(root);
      // The actual notes are what the user came for, and they are all here.
      expect(info.conceptCount).toBe(1);
    } finally {
      await workspace.close();
    }
  });

  test("is reported rather than swallowed", async () => {
    if (!(await danglingLink("index.md"))) return;

    const bundle = await Bundle.open(root);
    await bundle.ensureReservedFiles();
    const info = await bundle.info();

    expect(info.warnings.length).toBe(1);
    expect(info.warnings[0]).toContain("index.md");
    // The path is stated once, by us — not repeated out of the raw errno text.
    expect(info.warnings[0]).not.toContain("open '");
    expect(info.hasIndex).toBe(false);
  });

  test("still lets the readable notes be read", async () => {
    if (!(await danglingLink("index.md"))) return;
    await writeFile(join(root, "note.md"), "---\ntype: Concept\n---\n\n# note\n", "utf8");

    const workspace = new Workspace({ watch: false });
    try {
      await workspace.open(root);
      const file = await workspace.readFile("note.md");
      expect(file.content).toContain("# note");
    } finally {
      await workspace.close();
    }
  });
});

describe("a healthy folder", () => {
  test("opens with no warnings and gets both reserved files", async () => {
    const workspace = new Workspace({ watch: false });
    try {
      const info = await workspace.open(root);
      expect(info.warnings).toEqual([]);
      expect(info.hasIndex).toBe(true);
      expect(info.hasLog).toBe(true);
    } finally {
      await workspace.close();
    }
  });
});
