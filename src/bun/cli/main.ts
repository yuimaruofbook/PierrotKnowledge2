/**
 * `okf` — the command-line surface, for agents.
 *
 * A third front end onto the same `Workspace` the served interface and the MCP
 * server drive. It is built *on* the MCP tool table rather than beside it: every tool
 * becomes a subcommand automatically, so a tool added for agents over MCP is a
 * CLI command the same day and the two can never disagree about what exists.
 *
 * Agent-first, which mostly means being boring:
 *
 *   - **Never interactive.** No prompts, no pagers, no colour when piped.
 *   - **`--json` prints machine-readable output**, and errors go to stderr so
 *     stdout stays parseable even when something fails.
 *   - **Exit codes mean something**: 0 ok, 1 tool error, 2 usage error.
 */

import { APP_NAME } from "../../shared/app";
import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import { TOOLS, callTool, type ToolDefinition } from "../mcp/tools";
import { Workspace } from "../workspace";
import { loadSession } from "../state";
import { buildToolArgs, parseArgv, RESERVED_FLAGS, type ParsedArgs } from "./args";
import {
  agentWorkspacePlan,
  capabilities,
  diagnose,
  hasSession,
  isBrokenInstall,
  jobPlan,
  killSession,
  listSessions,
  listWindows,
  MAIN_WINDOW,
  okfPaneCommand,
  paneSnapshot,
  parseCollected,
  parseSnapshot,
  renderPlan,
  RMUX_SESSION,
  sendKeys,
  WATCH_WINDOW,
  windowTarget,
  type RmuxCommand,
} from "./rmux";

const EXIT_OK = 0;
const EXIT_TOOL_ERROR = 1;
const EXIT_USAGE = 2;

/**
 * How to type this command, in the shell the user is actually in.
 *
 * Setup does not put the install folder on PATH, and no shell runs a program
 * from the current directory unasked — PowerShell answers
 * `CommandNotFoundException`, a POSIX shell "command not found". Printing the
 * bare name told people to type something that cannot work, and they did.
 */
const SELF = `${process.platform === "win32" ? ".\\" : "./"}${APP_NAME}`;

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

/** `skill_find` → `skill-find`. Hyphens read better on a command line. */
const commandName = (tool: string) => tool.replace(/_/g, "-");

/** Shorter names for the things an agent reaches for constantly. */
const ALIASES: Record<string, string> = {
  find: "skill_find",
  ask: "retrieve",
  ls: "list_files",
  lint: "check_conformance",
  gaps: "unresolved_links",
  agents: "read_agents_md",
  map: "read_map",
  who: "read_human",
  tasks: "list_tasks",
  todo: "add_task",
  today: "daily_note",
  para: "list_para",
  archive: "set_para",
};

function resolveTool(name: string): ToolDefinition | undefined {
  const wanted = ALIASES[name] ?? name.replace(/-/g, "_");
  return TOOLS.find((tool) => tool.name === wanted);
}

function usage(): string {
  const groups: Array<[string, string[]]> = [
    ["知識を読む", ["retrieve", "search", "read_file", "list_concepts", "backlinks"]],
    ["知識を書く", ["create_concept", "write_file", "move_file", "delete_file"]],
    ["方向づけ", ["read_map", "read_human", "list_tasks", "add_task", "update_task"]],
    ["デイリーノート", ["daily_note", "collect_daily_tasks"]],
    ["PARA", ["list_para", "set_para"]],
    ["スキル", ["skill_find", "skill_list", "skill_open", "skill_read"]],
    ["ループ", ["loop_list", "loop_start", "loop_note", "loop_end", "loop_read"]],
    ["点検", ["check_conformance", "unresolved_links", "rebuild_index", "rebuild_rag"]],
  ];

  const lines = [
    `okf — ${APP_NAME} のコマンドライン`,
    "",
    `  ${SELF} <コマンド> [引数] [--flag 値]`,
    "  okf <コマンド> …                （短縮形。他ツールと衝突しうるので非推奨）",
    "",
    `  先頭の ${process.platform === "win32" ? ".\\" : "./"} は必須です`,
    "  （インストール先は PATH に入っていません）",
    "",
    "共通フラグ:",
    "  --bundle <path>   対象バンドル（既定: $OKF_BUNDLE、なければ前回開いたもの）",
    "  --json            機械可読な JSON で出力する",
    "  --help            そのコマンドの引数を表示する",
    "",
  ];

  for (const [label, tools] of groups) {
    lines.push(`${label}:`);
    for (const name of tools) {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) continue;
      lines.push(`  ${commandName(name).padEnd(20)} ${firstSentence(tool.description)}`);
    }
    lines.push("");
  }

  lines.push(
    "その他:",
    "  ui                   ブラウザに UI を出す（常駐 135 MB・推奨）",
    "  Update               新しいリリースを確認する（--apply で適用）",
    "  Uninstall            削除の計画を表示する（--apply で実行）",
    "  serve                MCP サーバーとして起動（ヘッドレス・常駐 85 MB）",
    "  mcp-config           他のツールに貼る MCP 設定を出力する",
    "                       （--format json | toml | opencode | yaml | command）",
    "  watch                log.md を追尾して変更を表示する",
    "  info                 バンドルの概要",
    "  rmux <サブコマンド>  エージェント用の rmux セッション（下記）",
    "",
    "rmux:",
    "  rmux setup           作業セッションを作る（main / watch、再実行しても安全）",
    "  rmux plan            実行されるコマンドを表示するだけ（何もしない）",
    "  rmux run <コマンド>  専用ウィンドウで実行し、終了まで待って出力を返す",
    "  rmux send <コマンド> main ウィンドウに投げるだけ（待たない）",
    "  rmux capture         ウィンドウの内容を読む（--window <名前>）",
    "  rmux status          セッション一覧",
    "  rmux windows         ウィンドウ一覧",
    "  rmux doctor          rmux の対応機能を表示する",
    "  rmux kill            セッションを終了する",
    "",
    "エイリアス: " + Object.entries(ALIASES).map(([a, t]) => `${a}=${commandName(t)}`).join(", "),
  );

  return lines.join("\n");
}

function firstSentence(text: string): string {
  const cut = text.search(/(?<=[.。])\s/);
  const sentence = cut === -1 ? text : text.slice(0, cut + 1);
  return sentence.length > 76 ? `${sentence.slice(0, 73)}…` : sentence.trim();
}

function toolHelp(tool: ToolDefinition): string {
  const properties = tool.inputSchema.properties as Record<
    string,
    { type?: string; description?: string }
  >;
  const required = new Set(tool.inputSchema.required ?? []);

  const lines = [`okf ${commandName(tool.name)} — ${tool.title}`, "", tool.description, ""];
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    lines.push("引数はありません。");
  } else {
    lines.push("引数:");
    for (const [name, schema] of entries) {
      const mark = required.has(name) ? "*" : " ";
      const type = schema.type ? `<${schema.type}>` : "";
      lines.push(`  ${mark} --${name} ${type}`.padEnd(30) + (schema.description ?? ""));
    }
    if (required.size > 0) {
      lines.push("", "* は必須。必須引数は順番に位置引数としても渡せます。");
    }
  }

  return lines.join("\n");
}

/**
 * Which bundle to act on.
 *
 * `--bundle` wins, then `OKF_BUNDLE`, then whatever the app had open last. The
 * fallback is what makes the CLI usable next to the window without repeating
 * a path on every call.
 */
async function resolveBundle(parsed: ParsedArgs): Promise<string | null> {
  const flag = parsed.flags.bundle;
  if (typeof flag === "string" && flag) return resolve(flag);
  if (process.env.OKF_BUNDLE) return resolve(process.env.OKF_BUNDLE);
  const session = await loadSession();
  return session.bundlePath ? resolve(session.bundlePath) : null;
}

const INSTALL_HINT = [
  "  irm https://rmux.io/install.ps1 | iex     # 事前ビルド（Windows x64）",
  "  cargo install rmux --locked              # ソースからビルド",
].join("\n");

/**
 * Run an rmux command, translating its two failure modes into advice.
 *
 * Not installed and installed-but-broken look the same to a caller but are
 * fixed differently, so they are reported differently. The second is not
 * hypothetical: the Windows prebuilt of 0.9.1 ships `rmux.exe` without the
 * private helper it needs, so `rmux -V` reports a version while every command
 * that starts a server fails. Repeating the install line there would send the
 * user back to the same broken zip.
 */
async function runRmux(command: RmuxCommand): Promise<{ ok: boolean; output: string }> {
  let out: string;
  let err: string;
  let code: number;

  try {
    const proc = Bun.spawn(["rmux", ...command.argv], { stdout: "pipe", stderr: "pipe" });
    [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    code = await proc.exited;
  } catch {
    return { ok: false, output: `rmux が見つかりません。インストール:\n${INSTALL_HINT}` };
  }

  const output = (out + err).trim();

  if (code !== 0 && isBrokenInstall(output)) {
    return {
      ok: false,
      output:
        `rmux は入っていますが、補助バイナリが欠けています:\n  ${output}\n\n` +
        "事前ビルド版の既知の欠落です。ソースからビルドし直してください:\n" +
        "  cargo install rmux --locked",
    };
  }

  return { ok: code === 0, output };
}

async function handleRmux(parsed: ParsedArgs, bundle: string | null): Promise<number> {
  const [, sub = "status", ...rest] = parsed.positional;
  const session = typeof parsed.flags.session === "string" ? parsed.flags.session : RMUX_SESSION;
  // Quoted here, rather than at the call sites that interpolate it, because
  // both forms of the path may contain spaces.
  const okf = okfPaneCommand({
    entry: process.argv[1],
    execPath: process.execPath,
  });

  const asJson = parsed.flags.json === true;

  if (sub === "plan" || sub === "setup") {
    if (!bundle) {
      console.error("バンドルが指定されていません（--bundle か OKF_BUNDLE）");
      return EXIT_USAGE;
    }
    const plan = agentWorkspacePlan({ bundle, session, okf });

    if (sub === "plan") {
      // A dry run, because `setup` starts processes on the user's machine.
      console.log(`rmux セッション "${plan.session}" を次の手順で作ります:\n`);
      console.log(renderPlan(plan));
      return EXIT_OK;
    }

    // Repeating setup must not build a second copy of the workspace on top of
    // the first, which is what happened before this check: the windows stacked
    // up and `watch` ran twice against the same log.
    if ((await runRmux(hasSession(session))).ok) {
      console.log(`セッション "${session}" は既にあります。`);
      console.log(`接続: rmux attach-session -t ${session}`);
      return EXIT_OK;
    }

    for (const command of plan.commands) {
      const result = await runRmux(command);
      if (!result.ok) {
        console.error(`失敗: rmux ${command.argv.join(" ")}\n${result.output}`);
        return EXIT_TOOL_ERROR;
      }
    }
    console.log(`セッション "${plan.session}" を作成しました（${MAIN_WINDOW} / ${WATCH_WINDOW}）。`);
    console.log(`接続: rmux attach-session -t ${plan.session}`);
    return EXIT_OK;
  }

  if (sub === "run") return rmuxRun({ session, okf, args: rest, asJson, parsed });
  if (sub === "send") return rmuxSend({ session, okf, args: rest });
  if (sub === "capture") return rmuxCapture({ session, parsed, asJson });

  const dispatch: Record<string, () => RmuxCommand> = {
    kill: () => killSession(session),
    status: () => listSessions(),
    windows: () => listWindows(session),
    diagnose: () => diagnose(),
    doctor: () => capabilities(),
  };

  const build = dispatch[sub];
  if (!build) {
    console.error(`不明な rmux サブコマンド: ${sub}`);
    console.error(
      "使えるもの: setup, plan, run, send, capture, status, windows, doctor, diagnose, kill"
    );
    return EXIT_USAGE;
  }

  const result = await runRmux(build());
  console.log(result.output || "(出力なし)");
  return result.ok ? EXIT_OK : EXIT_TOOL_ERROR;
}

/**
 * Run an `okf` command to completion in its own window and print its output.
 *
 * The blocking counterpart to `send`, and the one an agent should reach for.
 * It is built on `collect-pane-output --until-pane-exit`, so it returns
 * exactly when the command does — no polling, no guessing whether output has
 * stopped growing, and no marker injected into the command line.
 */
async function rmuxRun(options: {
  session: string;
  okf: string;
  args: string[];
  asJson: boolean;
  parsed: ParsedArgs;
}): Promise<number> {
  if (options.args.length === 0) {
    console.error("実行するコマンドがありません: okf rmux run <コマンド> [引数]");
    return EXIT_USAGE;
  }

  const maxBytes =
    typeof options.parsed.flags.max_bytes === "string"
      ? Number(options.parsed.flags.max_bytes)
      : undefined;

  const job = jobPlan({
    session: options.session,
    command: `${options.okf} ${options.args.join(" ")}`,
    // Spread rather than assigned: the key is optional, so "absent" and
    // "present and undefined" are different things to the callee.
    ...(Number.isFinite(maxBytes) ? { maxBytes: maxBytes as number } : {}),
  });

  const started = await runRmux(job.start);
  if (!started.ok) {
    console.error(`ジョブを開始できません:\n${started.output}`);
    return EXIT_TOOL_ERROR;
  }

  const collected = await runRmux(job.collect);
  // The window is normally gone with its command; this clears a job that was
  // killed part way through and would otherwise hold the name.
  await runRmux(job.cleanup);

  if (!collected.ok) {
    console.error(`出力を収集できません:\n${collected.output}`);
    return EXIT_TOOL_ERROR;
  }

  const output = parseCollected(collected.output);
  if (!output) {
    console.error(`rmux の応答を解釈できません:\n${collected.output}`);
    return EXIT_TOOL_ERROR;
  }

  if (options.asJson) {
    console.log(
      JSON.stringify(
        {
          ok: output.ok,
          command: options.args.join(" "),
          output: output.text,
          bytes: output.bytes,
          truncated: output.truncated,
          // Deliberately passed through as null rather than assumed: rmux does
          // not observe a pane's exit status on Windows.
          exit_status: output.exitStatus,
        },
        null,
        2
      )
    );
  } else {
    console.log(output.text.trimEnd() || "(出力なし)");
    if (output.truncated) {
      console.error(`\n（出力が ${output.bytes} バイトで打ち切られました）`);
    }
  }

  return output.ok ? EXIT_OK : EXIT_TOOL_ERROR;
}

/** Start a command in the shell window and return immediately. */
async function rmuxSend(options: {
  session: string;
  okf: string;
  args: string[];
}): Promise<number> {
  if (options.args.length === 0) {
    console.error("送るコマンドがありません: okf rmux send <コマンド> [引数]");
    return EXIT_USAGE;
  }

  const target = windowTarget(options.session, MAIN_WINDOW);
  const result = await runRmux(sendKeys(target, `${options.okf} ${options.args.join(" ")}`));
  if (!result.ok) {
    console.error(result.output);
    return EXIT_TOOL_ERROR;
  }

  console.log(`${target} に送信しました。出力: okf rmux capture`);
  return EXIT_OK;
}

/** Read a window's current contents. */
async function rmuxCapture(options: {
  session: string;
  parsed: ParsedArgs;
  asJson: boolean;
}): Promise<number> {
  const window =
    typeof options.parsed.flags.window === "string" ? options.parsed.flags.window : MAIN_WINDOW;
  const target = windowTarget(options.session, window);

  const result = await runRmux(paneSnapshot(target));
  if (!result.ok) {
    console.error(result.output);
    return EXIT_TOOL_ERROR;
  }

  const view = parseSnapshot(result.output);
  if (!view) {
    console.error(`rmux の応答を解釈できません:\n${result.output}`);
    return EXIT_TOOL_ERROR;
  }

  if (options.asJson) {
    console.log(
      JSON.stringify({ ok: view.ok, target, cols: view.cols, rows: view.rows, output: view.text }, null, 2)
    );
  } else {
    console.log(view.text || "(出力なし)");
  }

  return view.ok ? EXIT_OK : EXIT_TOOL_ERROR;
}

/**
 * Update from the newest GitHub release.
 *
 * Nothing is written without `--apply`, and even then only after the download
 * has been verified against the digest GitHub computed. See `bun/update.ts`
 * for the ordering that makes this safe.
 */
async function runUpdate(parsed: ParsedArgs): Promise<number> {
  const {
    DEFAULT_SOURCE,
    MANIFEST_NAME,
    applyUpdate,
    digestMatches,
    downloadAndHash,
    fetchLatestRelease,
    findInstallDir,
    readInstalled,
    rollback,
    staleCompiledArtifacts,
    writeInstallRecord,
  } = await import("../update");
  const { checkSafeToUpdate, decideUpdate } = await import("../../shared/update");
  const { extractZip, readManifestFromZip } = await import("../update-zip");

  const installDir = await findInstallDir();
  if (!installDir) {
    console.error("インストール先を特定できませんでした。アプリのフォルダで実行してください。");
    return EXIT_TOOL_ERROR;
  }

  // Rollback is its own path: it needs none of the checks below.
  if (parsed.flags.rollback) {
    const dir = String(parsed.flags.rollback);
    const restored = await rollback(installDir, dir);
    console.log(`${restored.length} 件を戻しました: ${restored.join(", ")}`);
    console.log(`\n次に実行してください:\n${REBUILD_HINT}`);
    return EXIT_OK;
  }

  const installed = await readInstalled(installDir);
  console.log(`インストール済み : ${installed.version}${installed.tag ? ` (${installed.tag})` : ""}`);

  // The bundle must not live inside what is about to be replaced.
  const session = await loadSession();
  const knownBundles = [
    ...(session.bundlePath ? [session.bundlePath] : []),
    ...(process.env.OKF_BUNDLE ? [process.env.OKF_BUNDLE] : []),
  ];
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
  console.log(`アセット         : ${release.assetName} ${(release.assetSize / 1048576).toFixed(1)} MB`);
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
  console.log(`検証 OK (${(bytes / 1048576).toFixed(1)} MB)\n`);

  // The version lives in the archive, not in the tag.
  const manifest = await readManifestFromZip(archive, MANIFEST_NAME);
  release.version = manifest?.version ?? null;

  const verdict = decideUpdate(installed, release);
  console.log(`判定: ${verdict.action} — ${verdict.reason}\n`);

  if (verdict.action !== "update") {
    await rm(staging, { recursive: true, force: true });
    return verdict.action === "up-to-date" ? EXIT_OK : EXIT_TOOL_ERROR;
  }

  if (!parsed.flags.apply) {
    console.log("適用するには次を実行してください:");
    console.log(`  ${SELF} Update --apply`);
    console.log(`（ダウンロード済み: ${archive}）`);
    return EXIT_OK;
  }

  console.log("展開中…");
  const extracted = join(staging, "extracted");
  const stagedRoot = await extractZip(archive, extracted);

  console.log("適用中…");
  const result = await applyUpdate({ installDir, stagedRoot });
  await writeInstallRecord(installDir, {
    version: release.version ?? installed.version,
    tag: release.tag,
    publishedAt: release.publishedAt,
  });

  console.log(`\n完了。置き換えた項目: ${result.replaced.join(", ")}`);
  console.log(`旧版の退避先       : ${result.backupDir}`);
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
  const stale = await staleCompiledArtifacts(installDir);
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
async function runUninstall(parsed: ParsedArgs): Promise<number> {
  const { findInstallDir } = await import("../update");
  const { applyUninstall, launcherPathsFor, planUninstall } = await import("../uninstall");
  const { APP_NAME } = await import("../../shared/app");

  const installDir = await findInstallDir();
  if (!installDir) {
    console.error("インストール先を特定できませんでした。アプリのフォルダで実行してください。");
    return EXIT_TOOL_ERROR;
  }

  const session = await loadSession();
  const knownBundles = [
    ...(session.bundlePath ? [session.bundlePath] : []),
    ...(process.env.OKF_BUNDLE ? [process.env.OKF_BUNDLE] : []),
  ];

  const plan = await planUninstall({
    installDir,
    knownBundles,
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

  if (!parsed.flags.apply) {
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

/**
 * Serve the interface to a browser instead of shipping a window with it.
 *
 * The desktop build measured 633 MB resident, of which about 570 MB was the
 * system WebView's process tree and a second Bun runtime. This mode drops
 * both: the same Vite bundle is handed to a browser that is already open. It
 * is the only interface as of 0.5.0.
 */
/**
 * Print the MCP entry for a host this app has no target for.
 *
 * The nine known hosts are connected from the app in one press. This is for
 * everything else on the machine that speaks MCP — a tool whose config format
 * we have not verified, or one installed after this release. Printing rather
 * than writing, because editing a config whose shape has not been checked is
 * how the Hermes connection was silently wrong for a release.
 *
 * The command it prints is `serverSpecFor`'s, so it names the compiled
 * headless binary once that exists and falls back to `bun run` before then —
 * the same answer the one-press connection writes.
 */
async function printMcpConfig(parsed: ParsedArgs, bundlePath: string | null): Promise<number> {
  if (!bundlePath) {
    console.error("バンドルが指定されていません（--bundle か OKF_BUNDLE）");
    return EXIT_USAGE;
  }

  const { renderServerConfig, serverCommandLine, findInstallRoot, headlessBinaryPath } =
    await import("../connect/targets");

  const projectRoot = findInstallRoot() ?? resolve(import.meta.dir, "..", "..", "..");
  const asked = typeof parsed.flags.format === "string" ? parsed.flags.format : "json";

  const formats: Record<string, () => string> = {
    json: () => renderServerConfig("mcp-json", projectRoot, bundlePath),
    toml: () => renderServerConfig("codex-toml", projectRoot, bundlePath),
    opencode: () => renderServerConfig("opencode-json", projectRoot, bundlePath),
    yaml: () => renderServerConfig("hermes-yaml", projectRoot, bundlePath),
    command: () => serverCommandLine(projectRoot, bundlePath),
  };

  const render = formats[asked];
  if (!render) {
    console.error(`未対応の形式です: ${asked}`);
    console.error(`  --format ${Object.keys(formats).join(" | ")}`);
    return EXIT_USAGE;
  }

  console.log(render());

  // Everything after this is guidance, so it goes to stderr: piping the
  // command into a config file must not pick it up.
  if (asked === "command") {
    console.error(`\nOKF_BUNDLE=${bundlePath.replace(/\\/g, "/")}`);
  }
  if (!existsSync(headlessBinaryPath(projectRoot))) {
    console.error(
      "\n※ ヘッドレスの実行ファイルが未ビルドのため、bun 経由の起動になっています。" +
        "\n  `bun run build:headless` を実行すると、Bun のインストールに依存しない形になります。"
    );
  }

  return EXIT_OK;
}

async function serveUi(parsed: ParsedArgs): Promise<number> {
  const bundlePath = await resolveBundle(parsed);
  if (!bundlePath) {
    console.error("バンドルが指定されていません（--bundle か OKF_BUNDLE）");
    return EXIT_USAGE;
  }

  const viewRoot = await findViewRoot();
  if (!viewRoot) {
    console.error("ビューがビルドされていません。`bun run build:view` を実行してください。");
    return EXIT_TOOL_ERROR;
  }

  const { Workspace } = await import("../workspace");
  const { Connections } = await import("../connections");
  const { startUiServer } = await import("../ui-server");

  const workspace = new Workspace({
    watch: true,
    onExternalChange: (paths, info) => server.broadcast("fileChanged", { paths, info }),
    onError: (error) => console.error("[okf ui]", error),
  });
  const connections = new Connections();

  await workspace.open(bundlePath);

  const port = typeof parsed.flags.port === "string" ? Number(parsed.flags.port) : undefined;
  const server = startUiServer({
    workspace,
    connections,
    viewRoot,
    ...(Number.isFinite(port) ? { port: port as number } : {}),
  });

  console.log(`${bundlePath}\n`);
  console.log(`  ${server.url}\n`);
  console.log("ブラウザで上の URL を開いてください（トークン付き）。Ctrl+C で終了します。");

  if (parsed.flags.open !== false) {
    // Best effort: the URL is printed above either way.
    const opener =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", server.url]
        : process.platform === "darwin"
          ? ["open", server.url]
          : ["xdg-open", server.url];
    try {
      Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
    } catch {
      // No opener on this machine; the printed URL is the fallback.
    }
  }

  const shutdown = () => {
    server.stop();
    void connections.closeAll();
    void workspace.close();
    process.exit(EXIT_OK);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Hold the process open; the server is the program from here.
  await new Promise<void>(() => {});
  return EXIT_OK;
}

/**
 * Locate the built view.
 *
 * Two places, because the CLI runs both from source and as a compiled binary
 * sitting in `build/cli/`.
 */
async function findViewRoot(): Promise<string | null> {
  const here = process.execPath.split(/[\\/]/).slice(0, -1).join("/");
  const candidates = [
    resolve(import.meta.dir, "../../mainview/dist"),
    resolve(here, "../../src/mainview/dist"),
    resolve(process.cwd(), "src/mainview/dist"),
  ];

  for (const candidate of candidates) {
    if (await Bun.file(resolve(candidate, "index.html")).exists()) return candidate;
  }
  return null;
}

/** Follow `log.md`, which is where every write from either side lands. */
async function watch(workspace: Workspace): Promise<number> {
  const bundle = workspace.requireBundle();
  const logPath = bundle.paths.logMdPath;
  let lastSize = (await Bun.file(logPath).exists()) ? Bun.file(logPath).size : 0;

  console.log(`${logPath} を追尾しています。Ctrl+C で終了。`);

  // Polling rather than watching: this runs inside an rmux pane for hours, and
  // a poll that costs one stat per second is cheaper to reason about than a
  // watcher that has to be torn down correctly on every exit path.
  for (;;) {
    await Bun.sleep(1000);
    const file = Bun.file(logPath);
    if (!(await file.exists())) continue;
    if (file.size <= lastSize) {
      lastSize = file.size;
      continue;
    }
    const text = await file.text();
    process.stdout.write(text.slice(-(file.size - lastSize)));
    lastSize = file.size;
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv);
  // Lower-cased because the documented spelling is `PierrotKnowledge2 Update`,
  // which reads as a proper noun and a verb rather than as a flag. Command
  // names here are ASCII, so this cannot fold two distinct ones together.
  const command = parsed.positional[0]?.toLowerCase();
  const wantsJson = parsed.flags.json === true || parsed.flags.json === "true";

  if (!command || parsed.flags.help === true || command === "help") {
    const tool = command && command !== "help" ? resolveTool(command) : undefined;
    console.log(tool ? toolHelp(tool) : usage());
    return command ? EXIT_OK : EXIT_USAGE;
  }

  const bundle = await resolveBundle(parsed);

  if (command === "rmux") return handleRmux(parsed, bundle);

  if (command === "serve") {
    // The MCP server is its own entry point; exec it rather than duplicating
    // the transport here.
    await import("../mcp/standalone");
    return EXIT_OK;
  }

  if (command === "ui") return serveUi(parsed);
  if (command === "update") return runUpdate(parsed);
  if (command === "uninstall") return runUninstall(parsed);
  if (command === "mcp-config") return printMcpConfig(parsed, bundle);

  const tool = resolveTool(command);
  const isInfo = command === "info";
  if (!tool && !isInfo && command !== "watch") {
    console.error(`不明なコマンド: ${command}`);
    console.error("`okf --help` で一覧を表示します。");
    return EXIT_USAGE;
  }

  if (!bundle) {
    console.error(
      "バンドルが指定されていません。--bundle <path> を渡すか、OKF_BUNDLE を設定してください。"
    );
    return EXIT_USAGE;
  }

  const workspace = new Workspace({ watch: false });
  try {
    await workspace.open(bundle);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_TOOL_ERROR;
  }

  try {
    if (command === "watch") return await watch(workspace);

    if (isInfo) {
      const info = await workspace.info();
      if (wantsJson) console.log(JSON.stringify(info, null, 2));
      else {
        console.log(`bundle : ${info?.root}`);
        console.log(`概念   : ${info?.conceptCount} 件`);
        console.log(`非準拠 : ${info?.nonConformantCount} 件`);
      }
      return EXIT_OK;
    }

    // positional[0] is the command itself; only what follows is an argument.
    const { args, missing } = buildToolArgs(tool!.inputSchema, {
      ...parsed,
      positional: parsed.positional.slice(1),
    });
    if (missing.length > 0) {
      console.error(`引数が足りません: ${missing.map((m) => `--${m}`).join(", ")}`);
      console.error("");
      console.error(toolHelp(tool!));
      return EXIT_USAGE;
    }

    const result = await callTool(workspace, tool!.name, args);
    const body = result.content.map((block) => block.text).join("\n");

    if (wantsJson) {
      // Tool output is already JSON for the structured tools; wrapping it keeps
      // one predictable envelope for every command.
      console.log(JSON.stringify({ ok: !result.isError, tool: tool!.name, output: body }, null, 2));
    } else if (result.isError) {
      console.error(body);
    } else {
      console.log(body);
    }

    return result.isError ? EXIT_TOOL_ERROR : EXIT_OK;
  } finally {
    await workspace.close();
  }
}

// Only run when invoked directly, so the module stays importable by tests.
if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}

export { RESERVED_FLAGS };
