/**
 * Prebuilt Rust binaries, for machines without a Rust toolchain.
 *
 * The names are a contract with `.github/workflows/native.yml`, which uploads
 * them: a name that drifts on one side means every setup silently falls back
 * to the 94 MB Bun build.
 */

import { describe, expect, test } from "bun:test";
import { nativeAssetName, nativePlatform, pickNativeAsset, releaseTagsFor } from "../src/bun/native-binary";

describe("prebuilt native binaries", () => {
  test("names the platforms the workflow builds", () => {
    expect(nativePlatform("win32", "x64")).toBe("windows-x64");
    expect(nativePlatform("darwin", "arm64")).toBe("macos-arm64");
    expect(nativePlatform("darwin", "x64")).toBe("macos-x64");
    expect(nativePlatform("linux", "x64")).toBe("linux-x64");
  });

  test("a platform nobody builds for has no prebuilt binary", () => {
    expect(nativePlatform("linux", "arm64")).toBeNull();
    expect(nativePlatform("freebsd", "x64")).toBeNull();
  });

  test("asset names carry the binary, the platform and the Windows extension", () => {
    expect(nativeAssetName("okf-mcp", "windows-x64")).toBe("okf-mcp-windows-x64.exe");
    expect(nativeAssetName("okf", "windows-x64")).toBe("okf-windows-x64.exe");
    expect(nativeAssetName("okf-mcp", "macos-arm64")).toBe("okf-mcp-macos-arm64");
  });

  test("looks for both tag spellings this repository has used", () => {
    // Releases so far are tagged V0.5.2; `bun run release` recommends v0.6.0.
    expect(releaseTagsFor("0.7.0")).toEqual(["V0.7.0", "v0.7.0"]);
  });

  test("only an asset GitHub reported a digest for is usable", () => {
    // Without a digest there is nothing to verify the download against, and a
    // binary agents will spawn is not something to install on trust.
    const assets = [
      { name: "okf-mcp-linux-x64", browser_download_url: "https://x/1", digest: null },
      { name: "okf-mcp-windows-x64.exe", browser_download_url: "https://x/2", digest: "sha256:ab" },
    ];
    expect(pickNativeAsset(assets, "okf-mcp-linux-x64")).toBeNull();
    expect(pickNativeAsset(assets, "okf-mcp-windows-x64.exe")?.browser_download_url).toBe("https://x/2");
    expect(pickNativeAsset(assets, "okf-windows-x64.exe")).toBeNull();
  });
});
