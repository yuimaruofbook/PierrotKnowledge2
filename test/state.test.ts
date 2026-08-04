/**
 * Session persistence.
 *
 * This is what stops the app opening blank on every launch, so its failure
 * modes matter: it must never throw, and a stale pointer must degrade to the
 * welcome screen rather than an error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearSession,
  loadSession,
  saveSession,
  stateFilePath,
  updateSession,
} from "../src/bun/state";
import { removeTempDir } from "./helpers";

let sandbox: string;
let originalAppData: string | undefined;
let originalXdg: string | undefined;
let originalHome: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "okf-state-test-"));

  // Redirect the platform's state location into the sandbox so the test never
  // touches the real user profile.
  originalAppData = process.env.APPDATA;
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalHome = process.env.HOME;
  process.env.APPDATA = sandbox;
  process.env.XDG_CONFIG_HOME = sandbox;
  process.env.HOME = sandbox;
});

afterEach(async () => {
  process.env.APPDATA = originalAppData;
  process.env.XDG_CONFIG_HOME = originalXdg;
  process.env.HOME = originalHome;
  await removeTempDir(sandbox);
});

describe("stateFilePath", () => {
  test("lives outside any bundle", () => {
    // The bundle is knowledge; app preferences must not leak into it.
    expect(stateFilePath()).toContain(sandbox);
    expect(stateFilePath()).toMatch(/session\.json$/);
  });
});

describe("saving and loading", () => {
  test("round-trips a session", async () => {
    await saveSession({ bundlePath: "C:/notes", lastFile: "wiki/a.md" });
    expect(await loadSession()).toEqual({ bundlePath: "C:/notes", lastFile: "wiki/a.md" });
  });

  test("an absent file is an empty session, not an error", async () => {
    expect(await loadSession()).toEqual({});
  });

  test("the editor width round-trips", async () => {
    await saveSession({ editorWidth: 65 });
    expect((await loadSession()).editorWidth).toBe(65);
  });

  test("an out-of-range width is clamped rather than trusted", async () => {
    // A hand-edited or older file must not be able to leave the writing column
    // unreadably narrow or wider than the pane.
    // Seed the file so the directory exists, as the other raw-write tests do.
    await saveSession({ bundlePath: "C:/notes" });

    for (const [stored, expected] of [
      [5, 40],
      [0, 40],
      [1000, 100],
      [-20, 40],
      [72.4, 72],
    ] as const) {
      await writeFile(stateFilePath(), JSON.stringify({ editorWidth: stored }), "utf8");
      expect((await loadSession()).editorWidth).toBe(expected);
    }
  });

  test("a non-numeric width is ignored", async () => {
    await saveSession({ bundlePath: "C:/notes" });

    await writeFile(stateFilePath(), '{"editorWidth":"wide"}', "utf8");
    expect((await loadSession()).editorWidth).toBeUndefined();

    await writeFile(stateFilePath(), '{"editorWidth":null}', "utf8");
    expect((await loadSession()).editorWidth).toBeUndefined();
  });

  test("corrupt JSON degrades to an empty session", async () => {
    await saveSession({ bundlePath: "C:/notes" });
    await writeFile(stateFilePath(), "{ not json", "utf8");
    expect(await loadSession()).toEqual({});
  });

  test("a non-object payload degrades to an empty session", async () => {
    await saveSession({ bundlePath: "C:/notes" });
    await writeFile(stateFilePath(), '"just a string"', "utf8");
    expect(await loadSession()).toEqual({});
  });

  test("unexpected field types are ignored rather than trusted", async () => {
    await saveSession({ bundlePath: "C:/notes" });
    await writeFile(stateFilePath(), JSON.stringify({ bundlePath: 42, lastFile: [] }), "utf8");
    expect(await loadSession()).toEqual({});
  });

  test("updateSession merges instead of replacing", async () => {
    await saveSession({ bundlePath: "C:/notes", lastFile: "wiki/a.md" });
    await updateSession({ lastFile: "wiki/b.md" });

    expect(await loadSession()).toEqual({
      bundlePath: "C:/notes",
      lastFile: "wiki/b.md",
    });
  });

  test("clearSession removes the pointer", async () => {
    await saveSession({ bundlePath: "C:/notes" });
    await clearSession();
    expect(await loadSession()).toEqual({});
  });

  test("clearing an already-absent session is harmless", async () => {
    await clearSession();
    await clearSession();
    expect(await loadSession()).toEqual({});
  });

  test("the file is human-readable JSON", async () => {
    await saveSession({ bundlePath: "C:/notes" });
    const raw = await readFile(stateFilePath(), "utf8");
    expect(raw).toContain("\n");
    expect(JSON.parse(raw)).toMatchObject({ bundlePath: "C:/notes" });
  });
});

describe("what is worth restoring", () => {
  test("a Layer 3 artifact is never remembered", async () => {
    const { Workspace } = await import("../src/bun/workspace");
    const { isWorthRestoring } = await import("../src/bun/rpc");
    const { mkdir, writeFile } = await import("node:fs/promises");

    const root = join(sandbox, "bundle");
    await mkdir(join(root, "wiki"), { recursive: true });
    await writeFile(join(root, "wiki", "a.md"), "---\ntype: Concept\n---\n", "utf8");

    const workspace = new Workspace({ watch: false });
    await workspace.open(root);
    try {
      // Restoring a SQLite WAL would put binary noise in the editor.
      expect(isWorthRestoring(workspace, ".rag/fts.sqlite-wal")).toBe(false);
      expect(isWorthRestoring(workspace, ".rag/fts.sqlite")).toBe(false);
      expect(isWorthRestoring(workspace, "")).toBe(false);

      expect(isWorthRestoring(workspace, "wiki/a.md")).toBe(true);
      expect(isWorthRestoring(workspace, "AGENTS.md")).toBe(true);
    } finally {
      await workspace.close();
    }
  });

  test("with no bundle open, nothing is worth restoring", async () => {
    const { Workspace } = await import("../src/bun/workspace");
    const { isWorthRestoring } = await import("../src/bun/rpc");
    expect(isWorthRestoring(new Workspace({ watch: false }), "wiki/a.md")).toBe(false);
  });
});
