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
  "PierrotKnowledge2.bat",
  "PierrotKnowledge2",
  ".gitignore",
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

const command =
  process.platform === "win32"
    ? [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Path '${staging.replace(/'/g, "''")}' -DestinationPath '${archive.replace(/'/g, "''")}' -Force`,
      ]
    : ["zip", "-qr", archive, name];

const proc = Bun.spawn(command, { cwd: dist, stdout: "pipe", stderr: "pipe" });
if ((await proc.exited) !== 0) {
  console.error(await new Response(proc.stderr).text());
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
