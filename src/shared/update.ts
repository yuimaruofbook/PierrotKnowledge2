/**
 * The rules an update has to satisfy before anything is written to disk.
 *
 * Kept pure and apart from the download so they can be tested without a
 * network or a filesystem. Every one of them exists because getting it wrong
 * destroys something that cannot be recovered:
 *
 *   - **Knowledge is never in the install directory.** A bundle is the user's
 *     notes; an update replaces application files. If the two overlap, an
 *     update is a delete. This is checked, not assumed.
 *   - **Never install something older.** Tags on this project's releases have
 *     been `2026/0803`, `20260802`, `PierrotKnowledge2` — no ordering can be
 *     recovered from those, so the version in the artifact decides, and a
 *     lower one is refused outright.
 *   - **The download must match the digest GitHub computed.** Not a checksum
 *     the archive carries about itself, which proves nothing.
 */

/** A release as this app cares about it. */
export interface ReleaseInfo {
  tag: string;
  /** Human title of the release, e.g. "2026/08/03緊急アプデ". */
  name: string;
  /** The release notes, as Markdown. What actually changed. */
  notes: string;
  /** The page a person would open to read this release. */
  htmlUrl: string;
  publishedAt: string;
  /** From the artifact's own manifest, not the tag. Null when it has none. */
  version: string | null;
  assetName: string;
  assetUrl: string;
  assetSize: number;
  /** `sha256:<hex>` as GitHub reports it, or null if it did not. */
  digest: string | null;
}

/** What is installed now. */
export interface InstalledInfo {
  version: string;
  /** Tag of the release this came from, when it came from one. */
  tag?: string;
  /** `published_at` of that release. */
  publishedAt?: string;
}

export type UpdateVerdict =
  | { action: "update"; reason: string }
  | { action: "up-to-date"; reason: string }
  | { action: "refuse"; reason: string };

/** `1.2.3` → [1,2,3]. Anything unparseable yields null rather than a guess. */
export function parseVersion(value: string | null | undefined): number[] | null {
  if (!value) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1, 0 or 1. Null for either side means "cannot be compared". */
export function compareVersions(a: string | null, b: string | null): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Decide what to do, given what is installed and what is published.
 *
 * The date is only consulted when both sides carry the same version — that is
 * the state this project is actually in today, with several releases all
 * reporting `0.2.0`. It is a transitional allowance, and it still requires the
 * remote to be strictly newer.
 */
export function decideUpdate(installed: InstalledInfo, release: ReleaseInfo): UpdateVerdict {
  if (!release.digest) {
    return {
      action: "refuse",
      reason:
        "リリースに digest がありません。改竄の検出ができないため中止します。" +
        "GitHub にアップロードし直すと付与されます。",
    };
  }

  const order = compareVersions(release.version, installed.version);

  if (order === 1) {
    return { action: "update", reason: `${installed.version} → ${release.version}` };
  }

  if (order === -1) {
    return {
      action: "refuse",
      reason:
        `公開されている ${release.version} は、いま入っている ${installed.version} より古いバージョンです。` +
        "巻き戻すと現在の作業が失われるため中止します。",
    };
  }

  if (order === 0) {
    // Same version. Only a strictly newer publish date is worth taking, and
    // only because tags cannot currently be ordered.
    const newer =
      installed.publishedAt !== undefined &&
      release.publishedAt > installed.publishedAt;

    if (newer) {
      return {
        action: "update",
        reason:
          `バージョンは同じ (${release.version}) ですが、公開日時が新しいものです ` +
          `(${installed.publishedAt} → ${release.publishedAt})`,
      };
    }

    return { action: "up-to-date", reason: `最新です (${installed.version})` };
  }

  // One side has no parseable version. Refusing is the safe answer: without a
  // version there is no way to tell an upgrade from a downgrade, and a
  // downgrade here overwrites source that may exist nowhere else.
  return {
    action: "refuse",
    reason:
      `バージョンを比較できないため中止します（リリース: ${release.version ?? "なし"} / ` +
      `インストール済み: ${installed.version}）。\n` +
      "  リリースの zip に okf-release.json が必要です。`bun run release --version x.y.z` で\n" +
      "  作った zip を添付し直してください。タグ名ではなくこのファイルの version で判定します。",
  };
}

/**
 * Whether a path sits inside another.
 *
 * Used to prove a bundle is not inside the install directory, so the answer
 * has to be right for the awkward cases: a sibling whose name merely starts
 * with the same characters is *not* inside.
 */
export function isInside(parent: string, child: string): boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(`${a}/`);
}

export interface SafetyCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Refuse to update when doing so would overwrite knowledge.
 *
 * The one configuration that turns an update into data loss is a bundle kept
 * inside the application directory. It is unusual but entirely possible — the
 * app will open any folder — so it is detected rather than hoped against.
 */
export function checkSafeToUpdate(options: {
  installDir: string;
  /** Every bundle path this app knows about: the open one, the saved one. */
  knownBundles: readonly string[];
}): SafetyCheck {
  const problems: string[] = [];

  for (const bundle of options.knownBundles) {
    if (!bundle) continue;
    if (isInside(options.installDir, bundle)) {
      problems.push(
        `知識バンドルがアプリのフォルダ内にあります: ${bundle}\n` +
          `  更新はアプリのフォルダを置き換えるため、このままではノートが消えます。\n` +
          `  バンドルを外（例: ドキュメント）へ移してからやり直してください。`
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Read `sha256:<hex>` into just the hex, or null when it is not that. */
export function sha256FromDigest(digest: string | null): string | null {
  if (!digest) return null;
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest.trim());
  return match ? match[1]!.toLowerCase() : null;
}
