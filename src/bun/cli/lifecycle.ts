/**
 * `Update` and `Uninstall`: the two commands that change the install itself.
 *
 * Kept apart from the tool commands in `main.ts`, which never touch anything
 * outside a bundle. Both show what they are about to do first and act only on
 * `--apply`, or on an explicit yes when `--confirm` asks — the one place this
 * CLI is interactive, and only because UPDATE.bat and UNINSTALL.bat ask for it.
 */

import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { APP_NAME } from "../../shared/app";
import { loadSession } from "../state";
import type { ParsedArgs } from "./args";
import { EXIT_OK, EXIT_TOOL_ERROR, SELF } from "./common";

/**
 * What to rebuild after the source changes underneath an install.
 *
 * Named per mode since 0.5.0: there is no single `build` any more, and an
 * agent that keeps seeing old behaviour needs the headless binary rebuilt,
 * not the page.
 */
const REBUILD_HINT = [
  "  bun install",
  "  bun run build:view       # 画面（Web UI）",
  "  bun run build:headless   # エージェントが起動する MCP サーバー（使っている場合）",
].join("\n");

/**
 * Whether a console answer is consent to update or uninstall.
 *
 * Only an explicit yes: a stray Enter, a closed console (`prompt` returns
 * null) or anything ambiguous must leave the machine as it was.
 */
export function isConsent(answer: string | null): boolean {
  if (answer === null) return false;
  return /^(y|yes|はい)$/i.test(answer.trim());
}

/** Ask once, for the `--confirm` mode that UPDATE.bat and UNINSTALL.bat use. */
function askConsent(question: string): boolean {
  const answer = isConsent(prompt(`${question} [y/N]`));
  if (!answer) console.log("何も変更せずに終了します。");
  return answer;
}

/** `--apply`, or a yes to `question` under `--confirm`. */
function shouldApply(parsed: ParsedArgs, question: string): boolean {
  return Boolean(parsed.flags.apply) || (parsed.flags.confirm === true && askConsent(question));
}

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Where this app is installed, and the bundles that must not be inside it.
 *
 * Both commands refuse to run without the first and check the second, so it
 * is found the same way for each. Null after saying why.
 */
async function locateInstall(): Promise<{ installDir: string; knownBundles: string[] } | null> {
  const { findInstallDir } = await import("../update");
  const installDir = await findInstallDir();
  if (!installDir) {
    console.error("インストール先を特定できませんでした。アプリのフォルダで実行してください。");
    return null;
  }
  const session = await loadSession();
  const knownBundles = [session.bundlePath, process.env.OKF_BUNDLE].filter((path): path is string => Boolean(path));
  return { installDir, knownBundles };
}

/**
 * The `bun` argv lists that bring `build/` level with freshly updated source.
 *
 * Dependencies first, because the new release may need packages the old one
 * did not; then the page; then only the binaries that were built here before,
 * so an update never compiles something the user never asked for.
 */
export function rebuildSteps(staleRebuilds: readonly string[]): string[][] {
  return [
    ["install"],
    ["run", "build:view"],
    ...staleRebuilds.map((command) => command.replace(/^bun\s+/, "").split(/\s+/)),
  ];
}

/**
 * Run `rebuildSteps` so a one-touch update leaves nothing for the user to do.
 *
 * Each step runs even when an earlier one fails: a headless binary held open
 * by a connected agent cannot be replaced, and that is no reason to skip the
 * page. Failures are returned, not thrown, so the caller can name them.
 */
async function runRebuild(installDir: string, staleRebuilds: readonly string[]): Promise<string[]> {
  const bun = bunExecutable();
  const failed: string[] = [];
  for (const step of rebuildSteps(staleRebuilds)) {
    const label = `bun ${step.join(" ")}`;
    console.log(`\n▶ ${label}`);
    try {
      const proc = Bun.spawn([bun, ...step], { cwd: installDir, stdout: "inherit", stderr: "inherit" });
      if ((await proc.exited) !== 0) failed.push(label);
    } catch {
      failed.push(label);
    }
  }
  return failed;
}

/**
 * The Bun to rebuild with.
 *
 * Under the compiled CLI, execPath is okf.exe rather than bun; and a Bun
 * installed by setup moments ago is not on PATH until the next login, so the
 * place its installer puts it is tried before giving up on a bare `bun`.
 */
function bunExecutable(): string {
  if (basename(process.execPath).toLowerCase().startsWith("bun")) return process.execPath;
  const onPath = Bun.which("bun");
  if (onPath) return onPath;
  const installed = join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  return existsSync(installed) ? installed : "bun";
}

/**
 * Rebuild after the source changed underneath `build/`, and say how it went.
 *
 * A compiled artefact that is the running program is left out: Windows will
 * not replace a running .exe, so that step could only ever fail, and retrying
 * would not help. It is named with its command instead.
 */
async function rebuildAndReport(
  installDir: string,
  stale: ReadonlyArray<{ path: string; rebuild: string }>
): Promise<boolean> {
  const self = resolve(process.execPath).toLowerCase();
  const running = stale.filter((artefact) => resolve(artefact.path).toLowerCase() === self);
  const others = stale.filter((artefact) => !running.includes(artefact));

  console.log("\n新しいソースに合わせてビルドし直します…");
  const failed = await runRebuild(installDir, others.map((artefact) => artefact.rebuild));

  if (failed.length > 0) {
    console.error("\n⚠ 次の手順が失敗しました。エージェントやアプリを終了してから、もう一度実行してください:");
    for (const label of failed) console.error(`  ${label}`);
  }
  for (const artefact of running) {
    console.log(`\n実行中のため再ビルドできませんでした。終了後に実行してください:\n  ${artefact.rebuild}`);
  }
  if (failed.length === 0 && running.length === 0) {
    console.log("\nビルドまで完了しました。アプリを開き直すと新しい版で動きます。");
  }
  return failed.length === 0;
}

/**
 * Update from the newest GitHub release.
 *
 * Nothing is written without `--apply`, and even then only after the download
 * has been verified against the digest GitHub computed. See `bun/update.ts`
 * for the ordering that makes this safe.
 */
export async function runUpdate(parsed: ParsedArgs): Promise<number> {
  const {
    DEFAULT_SOURCE,
    MANIFEST_NAME,
    applyUpdate,
    digestMatches,
    downloadAndHash,
    fetchLatestRelease,
    readInstalled,
    rollback,
    staleCompiledArtifacts,
    writeInstallRecord,
  } = await import("../update");
  const { checkSafeToUpdate, decideUpdate } = await import("../../shared/update");
  const { extractZip, readManifestFromZip } = await import("../update-zip");

  const install = await locateInstall();
  if (!install) return EXIT_TOOL_ERROR;
  const { installDir, knownBundles } = install;

  // Rollback is its own path: it needs none of the checks below.
  if (parsed.flags.rollback) {
    const dir = String(parsed.flags.rollback);
    const restored = await rollback(installDir, dir);
    console.log(`${restored.length} 件を戻しました: ${restored.join(", ")}`);
    // The rolled-back source needs `build/` rebuilt exactly as an update does.
    if (parsed.flags.rebuild === true) {
      return (await rebuildAndReport(installDir, await staleCompiledArtifacts(installDir))) ? EXIT_OK : EXIT_TOOL_ERROR;
    }
    console.log(`\n次に実行してください:\n${REBUILD_HINT}`);
    return EXIT_OK;
  }

  const installed = await readInstalled(installDir);
  console.log(`インストール済み : ${installed.version}${installed.tag ? ` (${installed.tag})` : ""}`);

  // The bundle must not live inside what is about to be replaced.
  const safety = checkSafeToUpdate({ installDir, knownBundles });
  if (!safety.ok) {
    console.error(`\n中止します。\n\n${safety.problems.join("\n\n")}`);
    return EXIT_TOOL_ERROR;
  }

  const release = await fetchLatestRelease(DEFAULT_SOURCE);
  if (!release) {
    console.error("リリース情報を取得できませんでした。");
    return EXIT_TOOL_ERROR;
  }

  console.log(`公開されている   : ${release.name || release.tag} (${release.publishedAt})`);
  console.log(`アセット         : ${release.assetName} ${megabytes(release.assetSize)}`);
  console.log(`digest           : ${release.digest ?? "なし"}\n`);

  if (release.notes.trim()) {
    // What actually changed, before deciding whether to take it. Truncated
    // unless asked for in full: these notes run to thousands of characters
    // and the decision rarely needs all of them.
    const full = parsed.flags.notes === true;
    const notes = release.notes.replace(/\r\n/g, "\n").trim();
    const shown = full ? notes : notes.split("\n").slice(0, 24).join("\n");

    console.log("─".repeat(60));
    console.log(shown);
    if (!full && notes.split("\n").length > 24) {
      console.log(`\n… 全文は --notes、または ${release.htmlUrl}`);
    }
    console.log(`${"─".repeat(60)}\n`);
  }

  if (!release.digest) {
    console.error("digest が無いため検証できません。中止します。");
    return EXIT_TOOL_ERROR;
  }

  const staging = join(installDir, ".okf-update");
  await mkdir(staging, { recursive: true });
  const archive = join(staging, release.assetName || "release.zip");

  console.log("ダウンロード中…");
  let lastShown = 0;
  const { sha256, bytes } = await downloadAndHash(release.assetUrl, archive, (got, total) => {
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= lastShown + 10) {
      lastShown = pct;
      process.stderr.write(`  ${pct}%\n`);
    }
  });

  if (!digestMatches(release.digest, sha256)) {
    await rm(staging, { recursive: true, force: true });
    console.error(
      `\n検証に失敗しました。ダウンロードを破棄します。\n` +
        `  期待: ${release.digest}\n  実際: sha256:${sha256}`
    );
    return EXIT_TOOL_ERROR;
  }
  console.log(`検証 OK (${megabytes(bytes)})\n`);

  // The version lives in the archive, not in the tag.
  const manifest = await readManifestFromZip(archive, MANIFEST_NAME);
  release.version = manifest?.version ?? null;

  const verdict = decideUpdate(installed, release);
  console.log(`判定: ${verdict.action} — ${verdict.reason}\n`);

  if (verdict.action !== "update") {
    await rm(staging, { recursive: true, force: true });
    return verdict.action === "up-to-date" ? EXIT_OK : EXIT_TOOL_ERROR;
  }

  if (!shouldApply(parsed, "このリリースに更新しますか？")) {
    if (parsed.flags.confirm === true) {
      await rm(staging, { recursive: true, force: true });
      return EXIT_OK;
    }
    console.log("適用するには次を実行してください:");
    console.log(`  ${SELF} Update --apply`);
    console.log(`（ダウンロード済み: ${archive}）`);
    return EXIT_OK;
  }

  console.log("展開中…");
  const extracted = join(staging, "extracted");
  const stagedRoot = await extractZip(archive, extracted);

  console.log("適用中…");
  let result: Awaited<ReturnType<typeof applyUpdate>>;
  try {
    result = await applyUpdate({ installDir, stagedRoot });
  } catch (error) {
    // applyUpdate has already put the previous files back. The usual cause on
    // Windows is a folder held open — an Explorer window, an editor, the app.
    console.error(`\n適用できませんでした。元の状態に戻しています。\n  ${error instanceof Error ? error.message : String(error)}`);
    console.error("  アプリ・エージェント・このフォルダを開いているエクスプローラーやエディターを閉じてから、もう一度実行してください。");
    return EXIT_TOOL_ERROR;
  }
  await writeInstallRecord(installDir, {
    version: release.version ?? installed.version,
    tag: release.tag,
    publishedAt: release.publishedAt,
  });
  // The archive and its extracted copy are spent; left behind they cost the
  // size of a release on every update.
  await rm(staging, { recursive: true, force: true }).catch(() => {});

  console.log(`\n完了。置き換えた項目: ${result.replaced.join(", ")}`);
  console.log(`旧版の退避先       : ${result.backupDir}`);

  const stale = await staleCompiledArtifacts(installDir);

  // `--rebuild` (what UPDATE.bat passes) does that follow-up itself.
  if (parsed.flags.rebuild === true) {
    const ok = await rebuildAndReport(installDir, stale);
    console.log(`\n問題があれば戻せます:\n  ${SELF} Update --rollback "${result.backupDir}" --rebuild`);
    return ok ? EXIT_OK : EXIT_TOOL_ERROR;
  }

  console.log(`\n次に実行してください:\n${REBUILD_HINT}`);

  /*
   * The failure this prevents: an update that appears to do nothing.
   *
   * `build/` is not replaced by an update, and both compiled artefacts are
   * preferred over the source that was just replaced — the launcher runs
   * `build/cli/okf.exe` when it exists, and agent hosts spawn
   * `build/headless/okf-mcp.exe` by the path in their own config. Until they
   * are rebuilt, the new release is on disk and nothing is running it.
   */
  if (stale.length > 0) {
    console.log("\n⚠ 次のバイナリは古いままです。再ビルドするまで、更新後のコードは動きません:");
    for (const artefact of stale) {
      console.log(`  ${artefact.path}`);
      console.log(`    → ${artefact.rebuild}`);
    }
  }

  console.log(`\n問題があれば戻せます:\n  ${SELF} Update --rollback "${result.backupDir}"`);
  // Said at the end, where it is read: `okf` is a short generic word and this
  // is the name that will not collide with another tool on the same PATH.
  console.log(`\n次回以降のアップデートは \`${SELF} Update\` と入力してください。`);
  return EXIT_OK;
}

/**
 * Show, and optionally carry out, what removing this application involves.
 *
 * The plan is the default because the question anyone uninstalling has is
 * "will this take my notes with it", and the answer has to be visible before
 * they agree to anything. The install folder itself is never deleted here —
 * see `bun/uninstall.ts`.
 */
export async function runUninstall(parsed: ParsedArgs): Promise<number> {
  const { applyUninstall, launcherPathsFor, planUninstall } = await import("../uninstall");

  const install = await locateInstall();
  if (!install) return EXIT_TOOL_ERROR;

  const plan = await planUninstall({
    ...install,
    purgeSettings: parsed.flags.purge_settings === true,
    launcherPaths: launcherPathsFor(APP_NAME),
  });

  if (plan.blockers.length > 0) {
    console.error(`中止します。\n\n${plan.blockers.join("\n\n")}`);
    return EXIT_TOOL_ERROR;
  }

  // Survivors first. This is the answer to the only question that matters.
  console.log("残るもの（削除しません）:");
  if (plan.preserved.length === 0) console.log("  （なし）");
  for (const path of plan.preserved) console.log(`  ✅ ${path}`);

  console.log("\n削除・変更するもの:");
  if (plan.items.length === 0) console.log("  （なし）");
  for (const item of plan.items) {
    console.log(`  ${item.action === "remove" ? "削除" : "編集"}  ${item.what}`);
    console.log(`        ${item.path}`);
  }

  console.log(
    `\nアプリのフォルダは削除しません:\n  ${plan.installDir}\n` +
      "  実行中のプログラム自身は消せないため、アプリを終了してから手で削除してください。"
  );

  if (!shouldApply(parsed, "\n上の内容でアンインストールしますか？")) {
    if (parsed.flags.confirm === true) return EXIT_OK;
    console.log(`\n実行するには:\n  ${SELF} Uninstall --apply`);
    console.log("設定も消すなら --purge-settings を付けてください。");
    return EXIT_OK;
  }

  const result = await applyUninstall(plan);

  console.log(`\n完了: ${result.done.length} 件`);
  for (const what of result.done) console.log(`  ${what}`);
  if (result.backups.length) {
    console.log("\n他ツールの設定は、変更前に退避しています:");
    for (const backup of result.backups) console.log(`  ${backup}`);
  }
  if (result.failed.length) {
    console.error("\n失敗:");
    for (const f of result.failed) console.error(`  ${f.path}\n    ${f.reason}`);
  }

  console.log(`\n最後に、アプリを終了してからこのフォルダを削除してください:\n  ${plan.installDir}`);
  return result.failed.length ? EXIT_TOOL_ERROR : EXIT_OK;
}
