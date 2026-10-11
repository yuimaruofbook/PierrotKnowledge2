/**
 * Build the archive that goes on a GitHub release.
 *
 * Deliberately source-only. The archives uploaded so far were 285 MB, of which
 * 504 MB uncompressed was `node_modules` and 305 MB was `build/` — both of
 * which every machine regenerates from `bun install` and the build scripts. What
 * actually differs between releases is `src/`, which is under a megabyte.
 *
 * A manifest is written into the archive carrying the version, because the tag
 * cannot be trusted to: the tags on this project have been `2026/0803`,
 * `20260802` and `PierrotKnowledge2`, none of which can be ordered. The
 * updater reads the manifest and refuses anything older than what is
 * installed.
 *
 *   bun run release            # dist/PierrotKnowledge2-<version>.zip
 *   bun run release --version 0.3.0
 */

import { mkdir, rm, cp, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { EXECUTABLE_PATHS } from "../src/bun/update";
import { normalizeZipPermissions, readZipPermissions } from "./zip-permissions";

const ROOT = resolve(import.meta.dir, "..");

/**
 * What ships.
 *
 * An allowlist rather than an ignore list: a new directory of build output
 * should not silently start being published because nobody remembered to
 * exclude it.
 */
const INCLUDE = [
  "src",
  "test",
  "docs",
  "templates",
  "scripts",
  "assets",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "tsconfig.view.json",
  "vite.config.ts",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SETUP.bat",
  "SETUP.command",
  "UNINSTALL.bat",
  "UNINSTALL.command",
  "UPDATE.bat",
  "UPDATE.command",
  "PierrotKnowledge2.bat",
  "PierrotKnowledge2",
  ".gitignore",
  // The Rust port's sources, entry by entry rather than `rust/`: an update
  // replaces each listed entry wholesale, and `rust/target` is gigabytes of a
  // developer's build cache, not something a release owns.
  "rust/Cargo.toml",
  "rust/Cargo.lock",
  "rust/src",
];

const args = process.argv.slice(2);
const versionArg = args.indexOf("--version");

const pkg = JSON.parse(await Bun.file(join(ROOT, "package.json")).text()) as { version: string };
const version = versionArg !== -1 ? args[versionArg + 1]! : pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`version が semver ではありません: ${version}`);
  console.error("リリースのタグと版は x.y.z 形式にしてください（更新の新旧判定に使います）。");
  process.exit(2);
}

const name = `PierrotKnowledge2-${version}`;
const dist = join(ROOT, "dist");
const staging = join(dist, name);

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

let copied = 0;
for (const entry of INCLUDE) {
  const from = join(ROOT, entry);
  if (!(await Bun.file(from).exists())) {
    // Directories report false from Bun.file; try the copy and let it tell us.
    try {
      await cp(from, join(staging, entry), { recursive: true });
      copied++;
      continue;
    } catch {
      console.warn(`  skip (無し): ${entry}`);
      continue;
    }
  }
  await cp(from, join(staging, entry), { recursive: true });
  copied++;
}

/**
 * Line endings each platform's interpreter insists on, enforced on the copy.
 *
 * A checkout's line endings depend on the machine and its git settings, and
 * both failures are silent where the release is built: bash on macOS or Linux
 * stops at `set -o pipefail\r`, and cmd.exe can miss a `goto` label in an
 * LF-only batch file.
 */
const lineEndings = [
  ...EXECUTABLE_PATHS.map((rel) => ({ rel, eol: "\n" })),
  ...INCLUDE.filter((rel) => rel.endsWith(".bat")).map((rel) => ({ rel, eol: "\r\n" })),
];
for (const { rel, eol } of lineEndings) {
  const path = join(staging, rel);
  if (!(await Bun.file(path).exists())) continue;
  const text = (await Bun.file(path).text()).replace(/\r\n/g, "\n");
  await writeFile(path, eol === "\n" ? text : text.replace(/\n/g, eol), "utf8");
}

// The version travels with the bytes, not with the tag.
await writeFile(
  join(staging, "okf-release.json"),
  `${JSON.stringify({ version, builtAt: new Date().toISOString(), contains: INCLUDE }, null, 2)}\n`,
  "utf8"
);

// Keep package.json's version in step, so a fresh clone reports the same thing.
if (version !== pkg.version) {
  const text = await Bun.file(join(staging, "package.json")).text();
  await writeFile(
    join(staging, "package.json"),
    text.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`),
    "utf8"
  );
}

const archive = join(dist, `${name}.zip`);
await rm(archive, { force: true });

/**
 * How to build the zip, best first.
 *
 * `bsdtar` leads on Windows because `Compress-Archive` writes **backslashes**
 * as path separators, which the ZIP spec forbids (4.4.17.1: paths use forward
 * slashes). Info-ZIP's `unzip` warns and recovers, but what any other extractor
 * does with it is its own business — some treat the separator as a literal
 * character and drop the whole tree into one flatly-named file. That is the
 * archive macOS and Linux users download, so it should not be malformed.
 *
 * `tar.exe` is bsdtar and has shipped in System32 since Windows 10 1803;
 * `Compress-Archive` stays as the fallback for anything older.
 *
 * Named by absolute path, not as `tar`: a developer machine with Git for
 * Windows on PATH resolves that to GNU tar, which cannot write a zip at all —
 * it silently produced a tar file with a .zip name until this was pinned.
 */
const windowsBsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

const candidates: string[][] =
  process.platform === "win32"
    ? [
        [windowsBsdtar, "-a", "-cf", archive, name],
        [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Compress-Archive -Path '${staging.replace(/'/g, "''")}' -DestinationPath '${archive.replace(/'/g, "''")}' -Force`,
        ],
      ]
    : [
        ["zip", "-qr", archive, name],
        ["tar", "-a", "-cf", archive, name],
      ];

let archived = false;
const problems: string[] = [];

for (const command of candidates) {
  try {
    const proc = Bun.spawn(command, { cwd: dist, stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) === 0) {
      archived = true;
      break;
    }
    problems.push(`${command[0]}: ${(await new Response(proc.stderr).text()).trim()}`);
  } catch {
    problems.push(`${command[0]}: 見つかりません`);
  }
}

if (!archived) {
  console.error(`アーカイブを作成できませんでした:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}

/**
 * Files that have to arrive executable on macOS and Linux.
 *
 * The same list the updater restores after replacing them, imported rather
 * than repeated: a file added to one and not the other is a launcher that
 * works on a fresh install and breaks on the next update, or the reverse.
 */
const EXECUTABLE: readonly string[] = EXECUTABLE_PATHS;

// Built on Windows there is no Unix mode to record, so every entry would
// arrive unrunnable and world-writable. See scripts/zip-permissions.ts.
const zipBytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
const stamped = normalizeZipPermissions(zipBytes, EXECUTABLE);

if (!stamped) {
  console.error("zip の中央ディレクトリを読めませんでした。実行権限を付与できません。");
  process.exit(1);
}

await Bun.write(archive, zipBytes);

// Read it back rather than trusting the write: this is the difference between
// a download that runs and one that does not.
const recorded = readZipPermissions(new Uint8Array(await Bun.file(archive).arrayBuffer())) ?? [];
const modes = new Map(recorded.map((entry) => [entry.path, entry.mode]));
const missing = EXECUTABLE.filter((name) => ((modes.get(name) ?? 0) & 0o111) === 0);
if (missing.length > 0) {
  console.error(`実行権限を付与できなかったファイルがあります: ${missing.join(", ")}`);
  process.exit(1);
}

// The staging tree has served its purpose. Left behind it would be picked up
// by the test runner and the type checker as a second copy of the project.
await rm(staging, { recursive: true, force: true });

const size = Bun.file(archive).size;
console.log(`\n${archive}`);
console.log(`  ${(size / 1048576).toFixed(2)} MB  (${copied} 項目)`);
console.log(`  version ${version}`);
console.log(`\nGitHub のリリースにこの zip を添付してください。`);
console.log(`タグは v${version} を推奨します（更新の新旧判定は manifest の version で行います）。`);
