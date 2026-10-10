/**
 * Unix permissions inside a ZIP built on Windows.
 *
 * A zip records each entry's mode in the high 16 bits of the central
 * directory's external-attributes field, and that is where `unzip` reads it
 * from when extracting on macOS or Linux. Built on Windows there is no Unix
 * mode to report, so bsdtar writes 0666 for every file and 0777 for every
 * directory. Both are wrong in ways that only show up on someone else's
 * machine: nothing arrives executable, so the first command a macOS or Linux
 * user is told to type fails, and everything arrives world-writable — which
 * goes unnoticed only because `unzip` applies the umask.
 *
 * Rewriting those two bytes per entry changes no offset and no length, so the
 * archive stays byte-compatible with every reader.
 *
 * Separate from `release.ts` because that script runs its work at import time;
 * this is the part worth testing on its own.
 */

/** `stat` mode for a directory at 0755. */
const DIR_MODE = 0o040755;
/** `stat` mode for a regular file at 0755. */
const EXEC_MODE = 0o100755;
/** `stat` mode for a regular file at 0644. */
const FILE_MODE = 0o100644;

const CENTRAL_HEADER = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
/** A zip comment is at most 65535 bytes, plus the 22-byte record itself. */
const MAX_EOCD_SEARCH = 65_557;

export interface NormalizeResult {
  /** Entries given the executable mode, by archive-relative path. */
  executables: string[];
  /** Every entry seen, so a caller can assert on the whole archive. */
  entries: Array<{ path: string; mode: number }>;
}

/**
 * Find the end-of-central-directory record.
 *
 * Scanned backwards because the record sits at the very end, behind a comment
 * of unknown length.
 */
function findEocd(view: DataView, length: number): number {
  for (let i = length - 22; i >= 0 && i > length - MAX_EOCD_SEARCH; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Give every entry the mode it should have had, in place.
 *
 * `executablePaths` are archive-relative — the staging folder every entry is
 * nested under is stripped before matching, so callers name files the way they
 * appear in the project.
 *
 * Returns null when the central directory cannot be read, rather than writing
 * a half-patched archive.
 */
export function normalizeZipPermissions(
  zip: Uint8Array,
  executablePaths: readonly string[]
): NormalizeResult | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  const eocd = findEocd(view, zip.length);
  if (eocd === -1) return null;

  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const wanted = new Set(executablePaths);

  const executables: string[] = [];
  const entries: Array<{ path: string; mode: number }> = [];

  let p = offset;
  const end = offset + size;

  while (p < end - 4 && view.getUint32(p, true) === CENTRAL_HEADER) {
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));

    // Entries are nested under the staging folder; `bsdtar` writes `/` and
    // `Compress-Archive` writes `\`, so both are normalised before matching.
    const relative = name.replace(/\\/g, "/").replace(/^[^/]*\//, "");
    const isDirectory = relative.endsWith("/");
    const executable = wanted.has(relative);

    // Written literally rather than by adding execute to what was there: that
    // was 0666, and `chmod +x` arithmetic on it yields 0777.
    const mode = isDirectory ? DIR_MODE : executable ? EXEC_MODE : FILE_MODE;

    const external = view.getUint32(p + 38, true);
    view.setUint32(p + 38, (mode << 16) | (external & 0xffff), true);

    entries.push({ path: relative, mode });
    if (executable) executables.push(relative);

    p += 46 + nameLen + extraLen + commentLen;
  }

  return { executables, entries };
}

/** Read back the mode recorded for each entry, without changing anything. */
export function readZipPermissions(zip: Uint8Array): Array<{ path: string; mode: number }> | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  const eocd = findEocd(view, zip.length);
  if (eocd === -1) return null;

  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  const out: Array<{ path: string; mode: number }> = [];
  let p = offset;
  const end = offset + size;

  while (p < end - 4 && view.getUint32(p, true) === CENTRAL_HEADER) {
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));

    out.push({
      path: name.replace(/\\/g, "/").replace(/^[^/]*\//, ""),
      mode: (view.getUint32(p + 38, true) >>> 16) & 0xffff,
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}
