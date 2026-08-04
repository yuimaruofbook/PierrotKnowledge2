/**
 * Reading and extracting the release archive.
 *
 * Extraction is delegated to the OS rather than reimplemented: Windows has
 * `Expand-Archive`, and everywhere else has `unzip`. A hand-rolled inflater
 * would be a second place for a path-traversal bug to live, and the archive
 * comes from the network.
 *
 * The manifest is read without extracting anything, because the version it
 * carries decides whether extraction should happen at all.
 */

import { mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import type { ReleaseManifest } from "./update";

/**
 * Pull one file out of a ZIP by reading its central directory.
 *
 * Cheaper than extracting a 285 MB archive to read 100 bytes, and it happens
 * before the decision to install has been made.
 */
export async function readManifestFromZip(
  archivePath: string,
  manifestName: string
): Promise<ReleaseManifest | null> {
  const file = Bun.file(archivePath);
  const total = file.size;
  if (total < 22) return null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);

  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65_557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");

  let p = cdOffset;
  const end = cdOffset + cdSize;

  while (p < end - 4 && view.getUint32(p, true) === 0x02014b50) {
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (name.replace(/\\/g, "/").endsWith(manifestName)) {
      // The local header repeats the name and extra fields, with its own
      // lengths — the central directory's are not usable here.
      const lv = new DataView(bytes.buffer, localOffset);
      const localNameLen = lv.getUint16(26, true);
      const localExtraLen = lv.getUint16(28, true);
      const dataAt = localOffset + 30 + localNameLen + localExtraLen;
      const raw = bytes.subarray(dataAt, dataAt + compressedSize);

      const text =
        method === 0
          ? decoder.decode(raw)
          : decoder.decode(Bun.inflateSync(raw));

      try {
        return JSON.parse(text) as ReleaseManifest;
      } catch {
        return null;
      }
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}

/**
 * Extract an archive and return the directory holding `package.json`.
 *
 * These archives wrap everything in one top-level folder, so the caller wants
 * what is inside it rather than the extraction root.
 */
export async function extractZip(archivePath: string, into: string): Promise<string> {
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });

  /**
   * Extractors to try, in order.
   *
   * More than one on Unix because neither is guaranteed: `unzip` is absent
   * from plenty of minimal Linux images, and `bsdtar` (as `tar`) is what macOS
   * ships. Trying both and reporting what was missing beats a bare "command
   * not found" for a program the user never asked to run.
   */
  const candidates: string[][] =
    process.platform === "win32"
      ? [
          [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`,
          ],
        ]
      : [
          ["unzip", "-q", "-o", archivePath, "-d", into],
          // bsdtar reads zip; present on macOS and most desktop Linux.
          ["tar", "-xf", archivePath, "-C", into],
        ];

  const problems: string[] = [];

  for (const command of candidates) {
    let code: number;
    try {
      const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
      code = await proc.exited;
      if (code !== 0) {
        problems.push(`${command[0]}: ${(await new Response(proc.stderr).text()).trim() || `exit ${code}`}`);
        continue;
      }
    } catch {
      problems.push(`${command[0]}: 見つかりません`);
      continue;
    }

    return findRoot(into);
  }

  throw new Error(
    `展開に失敗しました。\n${problems.map((p) => `  ${p}`).join("\n")}\n` +
      (process.platform === "win32" ? "" : "  unzip か bsdtar を入れてから再実行してください。")
  );
}

/** The directory containing `package.json`, one level down at most. */
async function findRoot(dir: string): Promise<string> {
  if (await Bun.file(join(dir, "package.json")).exists()) return dir;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(dir, entry.name);
    if (await Bun.file(join(candidate, "package.json")).exists()) return candidate;
  }

  throw new Error("展開結果に package.json が見つかりません。アーカイブの構成を確認してください。");
}
