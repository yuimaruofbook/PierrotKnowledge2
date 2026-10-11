/**
 * Prebuilt Rust binaries from a GitHub release.
 *
 * Most machines running setup have no Rust toolchain, and without this they
 * get the 94 MB Bun build of the same server. `.github/workflows/native.yml`
 * attaches the Rust builds to each release; this finds the one for this
 * platform and this version, and installs it only if it matches the digest
 * GitHub computed for it — the same check the updater applies to the release
 * archive.
 */

import { chmod, rm } from "fs/promises";
import { DEFAULT_SOURCE, digestMatches, downloadAndHash, type GithubSource } from "./update";

/** The platforms the workflow builds, by the names its assets use. */
const PLATFORMS: Record<string, string> = {
  "win32-x64": "windows-x64",
  "darwin-arm64": "macos-arm64",
  "darwin-x64": "macos-x64",
  "linux-x64": "linux-x64",
};

export function nativePlatform(platform: string, arch: string): string | null {
  return PLATFORMS[`${platform}-${arch}`] ?? null;
}

export function nativeAssetName(bin: string, plat: string): string {
  return `${bin}-${plat}${plat.startsWith("windows") ? ".exe" : ""}`;
}

/** Releases have been tagged `V0.5.2`; `bun run release` recommends `v…`. */
export function releaseTagsFor(version: string): string[] {
  return [`V${version}`, `v${version}`];
}

export interface NativeAsset {
  name?: string;
  browser_download_url?: string;
  digest?: string | null;
}

/** The named asset, only if GitHub reported a digest to verify it against. */
export function pickNativeAsset(assets: readonly NativeAsset[], name: string): NativeAsset | null {
  const asset = assets.find((a) => a.name === name);
  return asset?.browser_download_url && asset.digest ? asset : null;
}

/** A setup on a black-holed network has to fall back, not hang. */
const LOOKUP_TIMEOUT_MS = 15_000;

async function releaseAssets(source: GithubSource, version: string): Promise<NativeAsset[]> {
  for (const tag of releaseTagsFor(version)) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${source.owner}/${source.repo}/releases/tags/${tag}`,
        {
          headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        }
      );
      // A captive portal answers 200 with HTML; that is "no release", not a crash.
      if (response.ok) return ((await response.json()) as { assets?: NativeAsset[] }).assets ?? [];
    } catch {
      // Unreachable or unreadable: try the other tag spelling, then give up.
    }
  }
  return [];
}

/**
 * Whether the downloaded binary starts on this machine.
 *
 * The digest proves it is the file the release published, not that this
 * system can run it — a Linux build linked against a newer glibc than this
 * distribution has fails only when spawned, and here that would be every
 * agent host's spawn. The server exits 0 on end of input; the CLI on `help` (`--help` exits 2).
 */
async function startsHere(path: string, bin: string): Promise<boolean> {
  // Windows Defender holds a freshly written executable while it scans it:
  // spawning in the first half second fails with EBUSY even though our own
  // handle is closed. That is "not yet", not "cannot run", so wait it out.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const result = Bun.spawnSync([path, ...(bin === "okf" ? ["help"] : [])], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, OKF_BUNDLE: "" },
        timeout: 10_000,
      });
      return result.exitCode === 0;
    } catch (cause) {
      if (!/EBUSY/.test(String(cause)) || Date.now() > deadline) return false;
      await Bun.sleep(100);
    }
  }
}

/**
 * Download the prebuilt `bin` for this machine and version to `to`.
 *
 * Returns why not, rather than throwing: every "no" here means falling back
 * to a Bun build, which is a slower binary, not a failed setup.
 */
export async function downloadNativeBinary(options: {
  bin: string;
  version: string;
  to: string;
  source?: GithubSource;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const plat = nativePlatform(process.platform, process.arch);
  if (!plat) return { ok: false, reason: `${process.platform}-${process.arch} 向けのビルド済みバイナリはありません` };

  const name = nativeAssetName(options.bin, plat);
  const asset = pickNativeAsset(await releaseAssets(options.source ?? DEFAULT_SOURCE, options.version), name);
  if (!asset) return { ok: false, reason: `リリース ${options.version} に ${name} がありません` };

  try {
    const { sha256 } = await downloadAndHash(asset.browser_download_url!, options.to);
    if (!digestMatches(asset.digest ?? null, sha256)) {
      await rm(options.to, { force: true });
      return { ok: false, reason: `${name} のハッシュが一致しません（破損または改ざんの可能性）` };
    }
    if (process.platform !== "win32") await chmod(options.to, 0o755);
    if (!(await startsHere(options.to, options.bin))) {
      await rm(options.to, { force: true });
      return { ok: false, reason: `${name} がこのマシンで起動しません` };
    }
    return { ok: true };
  } catch (cause) {
    await rm(options.to, { force: true }).catch(() => {});
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
