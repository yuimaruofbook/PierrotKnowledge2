/**
 * Deciding whether a file is text.
 *
 * Reading a SQLite database as UTF-8 and putting it in the editor produces a
 * screen of replacement characters that looks exactly like a character-encoding
 * failure. It is not one — it is a binary file being shown as text — but the
 * user has no way to tell those apart, so the app must never do it.
 */

/** Bytes inspected before deciding. Enough to catch a header and some content. */
const SAMPLE_BYTES = 8192;

/**
 * Magic numbers worth naming, so the UI can say what the file actually is
 * rather than only that it is not text.
 */
const SIGNATURES: Array<{ bytes: number[]; label: string }> = [
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66], label: "SQLite データベース" },
  { bytes: [0x89, 0x50, 0x4e, 0x47], label: "PNG 画像" },
  { bytes: [0xff, 0xd8, 0xff], label: "JPEG 画像" },
  { bytes: [0x47, 0x49, 0x46, 0x38], label: "GIF 画像" },
  { bytes: [0x25, 0x50, 0x44, 0x46], label: "PDF" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], label: "ZIP アーカイブ" },
  { bytes: [0x1f, 0x8b], label: "gzip アーカイブ" },
];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

/** A human-readable file type from its magic number, when recognisable. */
export function detectFileType(bytes: Uint8Array): string | null {
  for (const { bytes: signature, label } of SIGNATURES) {
    if (startsWith(bytes, signature)) return label;
  }
  return null;
}

/**
 * Whether a byte sequence should be treated as binary.
 *
 * A NUL byte is decisive: valid UTF-8 text never contains one. Beyond that,
 * a high proportion of control characters means the decoder would produce
 * mostly replacement characters, which is not worth showing either.
 *
 * UTF-16 files start with a BOM and are full of NULs; they are reported as
 * binary rather than mangled, which is honest — this app writes UTF-8.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, SAMPLE_BYTES);
  if (sample.length === 0) return false;

  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    // Tab, newline and carriage return are ordinary in text.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }

  return control / sample.length > 0.1;
}

export interface TextCheck {
  binary: boolean;
  /** Recognised type, for a message the user can act on. */
  fileType: string | null;
}

export function inspect(bytes: Uint8Array): TextCheck {
  return { binary: looksBinary(bytes), fileType: detectFileType(bytes) };
}
