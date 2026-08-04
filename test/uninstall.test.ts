/**
 * Uninstalling.
 *
 * Two things are being held down here. First, that removing the application
 * never removes the notes — the plan has to say so before anything happens.
 * Second, that taking our entry out of someone else's config leaves the rest
 * of that file exactly as it was; these are files other tools depend on, and
 * a bad edit breaks a working install of something we do not own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  mergeHermesYaml,
  mergeMcpJson,
  mergeOpencodeJson,
  removeFromCodexToml,
  removeFromHermesYaml,
  removeFromMcpJson,
  removeFromOpencodeJson,
  type StdioServer,
} from "../src/bun/connect/merge";
import { planUninstall } from "../src/bun/uninstall";
import { removeTempDir } from "./helpers";

const SERVER: StdioServer = {
  command: "bun",
  args: ["run", "C:/proj/standalone.ts"],
  env: { OKF_BUNDLE: "C:/notes" },
};

describe("taking our entry back out", () => {
  test("mcp.json: ours goes, everything else stays", () => {
    const existing = JSON.stringify({
      mcpServers: {
        notion: { command: "npx", args: ["-y", "notion"] },
        "okf-wiki": { command: "old" },
      },
      otherSetting: { keep: true },
    });

    const parsed = JSON.parse(removeFromMcpJson(existing, "okf-wiki")!);

    expect(parsed.mcpServers["okf-wiki"]).toBeUndefined();
    expect(parsed.mcpServers.notion.command).toBe("npx");
    expect(parsed.otherSetting.keep).toBe(true);
  });

  test("mcp.json: the key itself goes when it only held ours", () => {
    // So a config we were the only occupant of comes back looking untouched.
    const once = mergeMcpJson(null, "okf-wiki", SERVER);
    const parsed = JSON.parse(removeFromMcpJson(once, "okf-wiki")!);

    expect(parsed.mcpServers).toBeUndefined();
  });

  test("a round trip leaves the user's own settings exactly as they were", () => {
    for (const [merge, remove] of [
      [mergeMcpJson, removeFromMcpJson],
      [mergeOpencodeJson, removeFromOpencodeJson],
    ] as const) {
      const before = { keep: 1, other: { a: 2 } };
      const after = JSON.parse(
        remove(merge(`${JSON.stringify(before, null, 2)}\n`, "okf-wiki", SERVER), "okf-wiki")!
      ) as Record<string, unknown>;

      expect(after.keep).toBe(1);
      expect(after.other).toEqual({ a: 2 });
      // Our server is gone from wherever that dialect keeps them.
      expect(JSON.stringify(after)).not.toContain("okf-wiki");
    }
  });

  test("opencode's $schema hint is left behind, deliberately", () => {
    // Merging adds it because opencode wants it; removing does not take it
    // away, because there is no way to tell whether the user already had it —
    // and a stray, valid `$schema` costs nothing while deleting one they
    // wrote would be an edit we were never asked to make.
    const merged = mergeOpencodeJson('{"keep":1}', "okf-wiki", SERVER);
    const after = JSON.parse(removeFromOpencodeJson(merged, "okf-wiki")!) as Record<string, unknown>;

    expect(after.$schema).toBeDefined();
    expect(after.mcp).toBeUndefined();
  });

  test("codex: our table goes and the next one survives", () => {
    const existing = [
      'model = "gpt-5.6-terra"',
      "",
      "[mcp_servers.okf-wiki]",
      'command = "bun"',
      "",
      "[mcp_servers.keep-me]",
      'command = "npx"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      "",
    ].join("\n");

    const next = removeFromCodexToml(existing, "okf-wiki")!;

    expect(next).not.toContain("[mcp_servers.okf-wiki]");
    expect(next).toContain("[mcp_servers.keep-me]");
    expect(next).toContain("[windows]");
    expect(next).toContain('model = "gpt-5.6-terra"');
  });

  test("codex: comments and key order survive, because it is text surgery", () => {
    const existing = ["# my notes", 'model = "x"', "", "[mcp_servers.okf-wiki]", 'command = "bun"', ""].join("\n");
    const next = removeFromCodexToml(existing, "okf-wiki")!;

    expect(next).toContain("# my notes");
  });

  test("hermes: ours goes, the other server stays", () => {
    const existing = mergeHermesYaml("model: hermes-4\nmcp_servers:\n  fs:\n    command: npx\n", "okf-wiki", SERVER);
    const next = removeFromHermesYaml(existing, "okf-wiki")!;

    expect(next).toContain("fs:");
    expect(next).not.toContain("okf-wiki");
    expect(next).toContain("hermes-4");
  });

  test("a file that never had our entry is left alone", () => {
    // Null means "nothing to do", so the caller does not rewrite — and
    // reformat — a config for no reason.
    expect(removeFromMcpJson('{"mcpServers":{"notion":{}}}', "okf-wiki")).toBeNull();
    expect(removeFromCodexToml('model = "x"', "okf-wiki")).toBeNull();
    expect(removeFromHermesYaml("model: hermes-4", "okf-wiki")).toBeNull();
    expect(removeFromOpencodeJson('{"mcp":{"other":{}}}', "okf-wiki")).toBeNull();
  });

  test("an empty or missing file is not an error", () => {
    expect(removeFromMcpJson(null, "okf-wiki")).toBeNull();
    expect(removeFromCodexToml("", "okf-wiki")).toBeNull();
  });
});

describe("planning an uninstall", () => {
  let install: string;

  beforeEach(async () => {
    install = await mkdtemp(join(tmpdir(), "okf-uninstall-"));
    await writeFile(join(install, "package.json"), '{"name":"x"}', "utf8");
  });

  afterEach(async () => {
    await removeTempDir(install);
  });

  test("the bundle is listed as surviving, not as being removed", async () => {
    // The only question anyone uninstalling has.
    const plan = await planUninstall({
      installDir: install,
      knownBundles: ["C:/Users/me/Documents/Notes"],
    });

    expect(plan.preserved).toContain("C:/Users/me/Documents/Notes");
    expect(plan.items.map((i) => i.path)).not.toContain("C:/Users/me/Documents/Notes");
    expect(plan.blockers).toEqual([]);
  });

  test("a bundle inside the install directory blocks everything", async () => {
    // There, removing the app is removing the notes.
    const plan = await planUninstall({
      installDir: install,
      knownBundles: [join(install, "my-notes")],
    });

    expect(plan.blockers.length).toBe(1);
    expect(plan.blockers[0]).toContain("my-notes");
  });

  test("the same bundle given twice is listed once", async () => {
    // It arrives from the saved session and from OKF_BUNDLE, differing only
    // in slash direction.
    const plan = await planUninstall({
      installDir: install,
      knownBundles: ["C:/Users/me/Notes", "C:\\Users\\me\\Notes"],
    });

    expect(plan.preserved.filter((p) => /Notes$/i.test(p))).toHaveLength(1);
  });

  test("settings survive unless asked for", async () => {
    const plan = await planUninstall({
      installDir: install,
      knownBundles: [],
    });

    // Matched on the settings item's own shape, not on the word 設定 appearing
    // anywhere in a label. "<host> の設定から MCP エントリを削除" contains that
    // word too, and it is a legitimate item — so the loose test failed on any
    // machine that happened to have an agent host configured.
    expect(plan.items.some((i) => i.what.startsWith("設定 ("))).toBe(false);
    expect(plan.items.some((i) => i.action === "remove" && /session\.json$/.test(i.path))).toBe(
      false
    );
  });

  test("the install directory is never an item to delete", async () => {
    // A running process cannot remove its own executable; on Windows it half
    // succeeds and leaves a mess. The user does it, afterwards.
    const plan = await planUninstall({
      installDir: install,
      knownBundles: ["C:/Users/me/Notes"],
    });

    expect(plan.items.map((i) => i.path)).not.toContain(install);
    expect(plan.installDir).toBe(install);
  });
});
