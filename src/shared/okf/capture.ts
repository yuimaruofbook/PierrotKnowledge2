/**
 * Naming files captured from outside the bundle.
 *
 * Dropping a file onto the window is the other half of ingest: MCP pulls text
 * from a service, this takes what is already on disk — a page saved from a
 * browser, an export, a transcript. Both land in `raw/`, because both are
 * sources that have not been curated into knowledge yet.
 *
 * The name is the untrusted part. It comes from another filesystem and is the
 * only thing about a dropped file that could reach for a path of its own, so it
 * is reduced to a bare filename here. `Bundle.importToRaw` still refuses to
 * write outside `raw/`; this exists so that check is never the only one.
 */

/**
 * What is removed from an outside filename: control characters, both path
 * separators, and the characters Windows rejects in a name.
 *
 * Control characters are matched by the `\p{Cc}` property rather than a range,
 * so the class contains no `-` at all: a hyphen in a character class is a range
 * operator, and a sanitiser that quietly means sixty characters instead of the
 * ten it names shows up much later as mangled filenames.
 */
const UNSAFE_CHARS = /[\p{Cc}\\\/:*?"<>|]/gu;

/**
 * Bound on the stored name.
 *
 * Long enough that ordinary titles survive whole, short enough to stay well
 * clear of the 255-byte limit once a `-2` suffix is added for a collision and
 * the name is encoded as UTF-8.
 */
const MAX_NAME = 120;

/** Used when the name reduces to nothing, or to nothing but dots. */
const FALLBACK = "captured";

/**
 * Largest file that may be captured through a drop, in bytes.
 *
 * The limit is the transport, not the disk: the content crosses the RPC socket
 * as one JSON message, so a dropped video would stall the connection the whole
 * UI runs on. Notes, pages and exports are far below this.
 */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/**
 * Reduce an outside filename to a safe one, keeping it recognisable.
 *
 * Japanese, spaces and hyphens are all left alone: the name is how the file
 * gets found again, and rewriting it is a worse outcome than an unusual
 * character. Only what a path or a filesystem would take badly is removed.
 */
export function capturedFileName(name: string): string {
  // Everything before the last separator is a directory the drop does not get
  // to choose — including `..`, which is why this comes first.
  const base = name.split(/[\\/]/).pop() ?? "";

  const cleaned = base
    .replace(UNSAFE_CHARS, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();

  if (!cleaned) return FALLBACK;
  if (cleaned.length <= MAX_NAME) return cleaned;

  // Truncating blindly would take the extension with it, and the extension is
  // what decides how the file is read back and rendered.
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  const stem = ext ? cleaned.slice(0, dot) : cleaned;

  return stem.slice(0, Math.max(1, MAX_NAME - ext.length)) + ext;
}

/** Where a captured file lands: the `raw/` inbox, under its own name. */
export function capturePathFor(name: string): string {
  return `raw/${capturedFileName(name)}`;
}
