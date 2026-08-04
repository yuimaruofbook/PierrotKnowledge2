/**
 * The rules that stop an update from destroying something.
 *
 * Every test here is a data-loss scenario, not a feature. The update path
 * replaces application files on a machine that also holds the only copy of
 * someone's notes, so the interesting cases are all refusals.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkSafeToUpdate,
  compareVersions,
  decideUpdate,
  isInside,
  parseVersion,
  sha256FromDigest,
  type InstalledInfo,
  type ReleaseInfo,
} from "../src/shared/update";
import {
  applyUpdate,
  digestMatches,
  pickAsset,
  rollback,
  staleCompiledArtifacts,
  REPLACED_PATHS,
} from "../src/bun/update";
import { removeTempDir } from "./helpers";

const release = (over: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  tag: "v0.3.0",
  name: "v0.3.0",
  notes: "# 変更点\n\n- なにか",
  htmlUrl: "https://example.invalid/releases/v0.3.0",
  publishedAt: "2026-08-03T12:00:00Z",
  version: "0.3.0",
  assetName: "app.zip",
  assetUrl: "https://example.invalid/app.zip",
  assetSize: 1,
  digest: "sha256:" + "a".repeat(64),
  ...over,
});

const installed = (over: Partial<InstalledInfo> = {}): InstalledInfo => ({
  version: "0.2.0",
  publishedAt: "2026-08-03T09:00:00Z",
  ...over,
});

describe("comparing versions", () => {
  test("parses only real versions", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("v0.2.0")).toEqual([0, 2, 0]);
    // The tags this project has actually used are not versions.
    expect(parseVersion("2026/0803")).toBeNull();
    expect(parseVersion("20260802")).toBeNull();
    expect(parseVersion("PierrotKnowledge2")).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  test("orders by component, not lexically", () => {
    // "0.10.0" < "0.9.0" as strings, which is the classic way to ship a
    // downgrade as an upgrade.
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.3.0")).toBe(-1);
  });

  test("an unparseable version compares to nothing", () => {
    expect(compareVersions("2026/0803", "0.2.0")).toBeNull();
  });
});

describe("deciding whether to update", () => {
  test("a newer version is taken", () => {
    expect(decideUpdate(installed(), release()).action).toBe("update");
  });

  test("an older version is refused, not installed", () => {
    // The scenario that would have destroyed a day's work: a release built
    // before the local changes.
    const verdict = decideUpdate(installed({ version: "0.3.0" }), release({ version: "0.2.0" }));

    expect(verdict.action).toBe("refuse");
    expect(verdict.reason).toContain("古い");
  });

  test("the same version with a newer publish date is taken", () => {
    // Transitional: several releases currently all report 0.2.0, so the date
    // is the only thing separating them.
    const verdict = decideUpdate(
      installed({ version: "0.2.0", publishedAt: "2026-08-03T09:00:00Z" }),
      release({ version: "0.2.0", publishedAt: "2026-08-03T12:00:00Z" })
    );

    expect(verdict.action).toBe("update");
  });

  test("the same version and an older publish date is already current", () => {
    const verdict = decideUpdate(
      installed({ version: "0.2.0", publishedAt: "2026-08-03T12:00:00Z" }),
      release({ version: "0.2.0", publishedAt: "2026-08-03T09:00:00Z" })
    );

    expect(verdict.action).toBe("up-to-date");
  });

  test("no digest means no install", () => {
    // Without it there is nothing to verify the download against, and the
    // archive's own claims about itself prove nothing.
    const verdict = decideUpdate(installed(), release({ digest: null }));

    expect(verdict.action).toBe("refuse");
    expect(verdict.reason).toContain("digest");
  });

  test("an unversioned release is refused rather than guessed at", () => {
    // Without a version there is no way to tell an upgrade from a downgrade,
    // and the message has to say what to do about it.
    const verdict = decideUpdate(installed(), release({ version: null }));
    expect(verdict.action).toBe("refuse");
    expect(verdict.reason).toContain("okf-release.json");
  });
});

describe("choosing which attachment to install", () => {
  test("the versioned archive wins over the legacy full one", () => {
    // The real release carries both: a 285 MB archive with no manifest and a
    // 0.57 MB one built by `bun run release`. Only the second can be judged.
    const picked = pickAsset([
      { name: "Pierrot.KnowledgeV2.zip", size: 299118979 },
      { name: "PierrotKnowledge2-0.3.0.zip", size: 597000 },
    ]);
    expect(picked?.name).toBe("PierrotKnowledge2-0.3.0.zip");
  });

  test("the highest version wins when several are attached", () => {
    const picked = pickAsset([
      { name: "PierrotKnowledge2-0.9.0.zip" },
      { name: "PierrotKnowledge2-0.10.0.zip" },
      { name: "PierrotKnowledge2-0.3.0.zip" },
    ]);
    // 0.10.0 beats 0.9.0, which string ordering would get backwards.
    expect(picked?.name).toBe("PierrotKnowledge2-0.10.0.zip");
  });

  test("falls back to any zip when none is versioned", () => {
    expect(pickAsset([{ name: "app.zip" }])?.name).toBe("app.zip");
    expect(pickAsset([{ name: "notes.txt" }])).toBeUndefined();
  });
});

describe("keeping knowledge out of the blast radius", () => {
  test("a bundle inside the install directory blocks the update", () => {
    // This is the one configuration where an update is a deletion.
    const check = checkSafeToUpdate({
      installDir: "C:/apps/PierrotKnowledge2",
      knownBundles: ["C:/apps/PierrotKnowledge2/my-notes"],
    });

    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain("my-notes");
  });

  test("a bundle elsewhere is fine", () => {
    const check = checkSafeToUpdate({
      installDir: "C:/apps/PierrotKnowledge2",
      knownBundles: ["C:/Users/me/Documents/OKF Wiki"],
    });

    expect(check.ok).toBe(true);
  });

  test("a sibling that merely shares a prefix is not inside", () => {
    // `C:/apps/PierrotKnowledge2-notes` starts with the install path as a
    // string but is a different directory; refusing it would be a false alarm.
    expect(isInside("C:/apps/PierrotKnowledge2", "C:/apps/PierrotKnowledge2-notes")).toBe(false);
    expect(isInside("C:/apps/PierrotKnowledge2", "C:/apps/PierrotKnowledge2/wiki")).toBe(true);
  });

  test("case and separators do not defeat the check on Windows", () => {
    expect(isInside("C:/apps/App", "c:\\apps\\app\\wiki")).toBe(true);
  });
});

describe("verifying the download", () => {
  test("only an exact sha256 passes", () => {
    const hex = "b".repeat(64);
    expect(digestMatches(`sha256:${hex}`, hex)).toBe(true);
    expect(digestMatches(`sha256:${hex}`, "c".repeat(64))).toBe(false);
    expect(digestMatches(null, hex)).toBe(false);
  });

  test("a digest in another algorithm is not accepted as sha256", () => {
    expect(sha256FromDigest("md5:" + "a".repeat(32))).toBeNull();
    expect(sha256FromDigest("sha256:tooshort")).toBeNull();
  });
});

describe("applying and undoing", () => {
  let install: string;
  let staged: string;

  beforeEach(async () => {
    install = await mkdtemp(join(tmpdir(), "okf-install-"));
    staged = await mkdtemp(join(tmpdir(), "okf-staged-"));

    await mkdir(join(install, "src"), { recursive: true });
    await writeFile(join(install, "src", "old.ts"), "old", "utf8");
    await writeFile(join(install, "package.json"), '{"version":"0.2.0"}', "utf8");

    await mkdir(join(staged, "src"), { recursive: true });
    await writeFile(join(staged, "src", "new.ts"), "new", "utf8");
    await writeFile(join(staged, "package.json"), '{"version":"0.3.0"}', "utf8");
  });

  afterEach(async () => {
    await removeTempDir(install);
    await removeTempDir(staged);
  });

  test("the new tree lands and the old one is kept, not deleted", async () => {
    const result = await applyUpdate({ installDir: install, stagedRoot: staged });

    expect(await readFile(join(install, "src", "new.ts"), "utf8")).toBe("new");
    expect(await readFile(join(install, "package.json"), "utf8")).toContain("0.3.0");

    // Nothing was destroyed: the previous copy is in the backup.
    expect(await readFile(join(result.backupDir, "src", "old.ts"), "utf8")).toBe("old");
  });

  test("rollback puts the previous version back", async () => {
    const result = await applyUpdate({ installDir: install, stagedRoot: staged });
    await rollback(install, result.backupDir);

    expect(await readFile(join(install, "src", "old.ts"), "utf8")).toBe("old");
    expect(await readFile(join(install, "package.json"), "utf8")).toContain("0.2.0");
  });

  test("files outside the replaced set are left alone", async () => {
    // node_modules and build/ are regenerated locally and are not in the
    // archive; an update that removed them would break the install.
    await mkdir(join(install, "node_modules", "x"), { recursive: true });
    await writeFile(join(install, "node_modules", "x", "keep.js"), "keep", "utf8");

    await applyUpdate({ installDir: install, stagedRoot: staged });

    expect(await readFile(join(install, "node_modules", "x", "keep.js"), "utf8")).toBe("keep");
  });
});

/**
 * The update that appears to have done nothing.
 *
 * `build/` is left alone on purpose, and both compiled artefacts are preferred
 * over the source that was just replaced: the launcher runs `build/cli/okf`
 * when it exists, and agent hosts spawn `build/headless/okf-mcp` by the path
 * written into their own config. Until they are rebuilt, the new release is on
 * disk and nothing at all is running it.
 */
describe("staleCompiledArtifacts", () => {
  let install: string;

  const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

  beforeEach(async () => {
    install = await mkdtemp(join(tmpdir(), "okf-stale-"));
  });

  afterEach(async () => {
    await removeTempDir(install);
  });

  test("an install that never compiled anything has nothing stale", async () => {
    expect(await staleCompiledArtifacts(install)).toEqual([]);
  });

  test("names the compiled CLI, and how to rebuild it", async () => {
    await mkdir(join(install, "build", "cli"), { recursive: true });
    await writeFile(join(install, "build", "cli", exe("okf")), "", "utf8");

    const stale = await staleCompiledArtifacts(install);

    expect(stale).toHaveLength(1);
    expect(stale[0]!.path).toContain("cli");
    expect(stale[0]!.rebuild).toBe("bun run build:cli");
  });

  test("names the headless binary, which is the one agents spawn", async () => {
    await mkdir(join(install, "build", "headless"), { recursive: true });
    await writeFile(join(install, "build", "headless", exe("okf-mcp")), "", "utf8");

    const stale = await staleCompiledArtifacts(install);

    expect(stale).toHaveLength(1);
    expect(stale[0]!.rebuild).toBe("bun run build:headless");
  });

  test("reports both when both exist", async () => {
    await mkdir(join(install, "build", "cli"), { recursive: true });
    await mkdir(join(install, "build", "headless"), { recursive: true });
    await writeFile(join(install, "build", "cli", exe("okf")), "", "utf8");
    await writeFile(join(install, "build", "headless", exe("okf-mcp")), "", "utf8");

    expect(await staleCompiledArtifacts(install)).toHaveLength(2);
  });

  test("the licence and the changelog travel with an update", async () => {
    // Neither was in the replaced set, so the LICENSE added at 0.5.0 would
    // never have reached an existing install.
    expect(REPLACED_PATHS).toContain("LICENSE");
    expect(REPLACED_PATHS).toContain("CHANGELOG.md");
  });
});
