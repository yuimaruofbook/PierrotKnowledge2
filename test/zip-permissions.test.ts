/**
 * The permissions recorded inside the release archive.
 *
 * Built on Windows there is no Unix mode to report, so bsdtar writes 0666 for
 * every file and 0777 for every directory. Neither is visible to whoever built
 * the archive; both land on whoever downloads it. Nothing arrives executable,
 * so the first command a macOS or Linux user is told to type fails — and
 * everything arrives world-writable, which goes unnoticed only because `unzip`
 * applies the umask.
 *
 * That makes this the one piece of the release path worth testing directly: a
 * regression here is silent on the machine that ships it.
 */

import { describe, expect, test } from "bun:test";
import { normalizeZipPermissions, readZipPermissions } from "../scripts/zip-permissions";

/**
 * A minimal but structurally real zip: local headers, a central directory and
 * an EOCD, all stored (method 0). Built by hand so the test does not depend on
 * a zip tool being installed, and so the external-attributes field starts out
 * exactly as bsdtar-on-Windows leaves it.
 */
function buildZip(
  entries: ReadonlyArray<{ name: string; body?: string; mode: number }>
): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = encoder.encode(entry.body ?? "");

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, body.length, true); // compressed size
    lv.setUint32(22, body.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 30, true); // made by Unix
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, body.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, entry.mode << 16, true); // external attributes
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** What bsdtar on Windows actually produces. */
const AS_BUILT = [
  { name: "PK-0.5.1/PierrotKnowledge2", body: "#!/bin/sh\n", mode: 0o100666 },
  { name: "PK-0.5.1/SETUP.command", body: "#!/bin/sh\n", mode: 0o100666 },
  { name: "PK-0.5.1/scripts/", mode: 0o040777 },
  { name: "PK-0.5.1/scripts/setup.sh", body: "#!/bin/sh\n", mode: 0o100666 },
  { name: "PK-0.5.1/README.md", body: "# hi\n", mode: 0o100666 },
  { name: "PK-0.5.1/package.json", body: "{}\n", mode: 0o100666 },
];

const EXECUTABLE = ["PierrotKnowledge2", "SETUP.command", "scripts/setup.sh"];

describe("normalizeZipPermissions", () => {
  test("the launcher and the scripts come out executable", () => {
    const zip = buildZip(AS_BUILT);
    const result = normalizeZipPermissions(zip, EXECUTABLE)!;

    expect(result.executables.sort()).toEqual([...EXECUTABLE].sort());

    const modes = new Map(readZipPermissions(zip)!.map((e) => [e.path, e.mode]));
    for (const name of EXECUTABLE) expect(modes.get(name)).toBe(0o100755);
  });

  test("everything else is 0644, and directories 0755", () => {
    const zip = buildZip(AS_BUILT);
    normalizeZipPermissions(zip, EXECUTABLE);

    const modes = new Map(readZipPermissions(zip)!.map((e) => [e.path, e.mode]));
    expect(modes.get("README.md")).toBe(0o100644);
    expect(modes.get("package.json")).toBe(0o100644);
    expect(modes.get("scripts/")).toBe(0o040755);
  });

  test("nothing is left world-writable", () => {
    // The as-built archive is world-writable throughout; only the umask hid it.
    const zip = buildZip(AS_BUILT);
    expect(readZipPermissions(zip)!.every((e) => e.mode & 0o002)).toBe(true);

    normalizeZipPermissions(zip, EXECUTABLE);
    expect(readZipPermissions(zip)!.some((e) => e.mode & 0o002)).toBe(false);
  });

  test("no offset or length changes, so the archive stays readable", () => {
    const zip = buildZip(AS_BUILT);
    const before = zip.length;
    const names = readZipPermissions(zip)!.map((e) => e.path);

    normalizeZipPermissions(zip, EXECUTABLE);

    expect(zip.length).toBe(before);
    expect(readZipPermissions(zip)!.map((e) => e.path)).toEqual(names);
  });

  test("the top-level folder is a traversable directory, not a 0644 file", () => {
    // Stripping the staging prefix leaves "" for the folder itself, which was
    // then taken for a file. `unzip` applied 0644 to it on macOS and Linux, so
    // nobody could `cd` into the download — or read package.json from an
    // update extracted there.
    const zip = buildZip([{ name: "PK-0.5.1/", mode: 0o040777 }, ...AS_BUILT]);
    normalizeZipPermissions(zip, EXECUTABLE);

    const top = readZipPermissions(zip)!.find((e) => e.path === "");
    expect(top?.mode).toBe(0o040755);
  });

  test("a backslash-terminated folder is a directory too", () => {
    const zip = buildZip([{ name: "PK-0.5.1\\scripts\\", mode: 0o040777 }]);
    normalizeZipPermissions(zip, EXECUTABLE);

    expect(readZipPermissions(zip)![0]!.mode).toBe(0o040755);
  });

  test("backslash separators are matched too", () => {
    // Compress-Archive writes them, and it is still the fallback.
    const zip = buildZip([
      { name: "PK-0.5.1\\scripts\\setup.sh", body: "#!/bin/sh\n", mode: 0o100666 },
    ]);
    const result = normalizeZipPermissions(zip, ["scripts/setup.sh"])!;

    expect(result.executables).toEqual(["scripts/setup.sh"]);
  });

  test("an executable that is not in the archive is simply absent", () => {
    const zip = buildZip([{ name: "PK-0.5.1/README.md", body: "x", mode: 0o100666 }]);
    const result = normalizeZipPermissions(zip, ["UNINSTALL.command"])!;

    expect(result.executables).toEqual([]);
  });

  test("a buffer that is not a zip is refused rather than half-patched", () => {
    expect(normalizeZipPermissions(new Uint8Array(64), EXECUTABLE)).toBeNull();
    expect(readZipPermissions(new Uint8Array(8))).toBeNull();
  });
});
