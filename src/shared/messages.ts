/**
 * User-facing messages, in Japanese.
 *
 * Centralised rather than scattered through the modules that raise them, so
 * the wording stays consistent and a second language would be one file rather
 * than a hunt through the codebase.
 *
 * These strings reach three places: the app's status bar, the MCP tool results
 * an agent reads, and `log.md`. Paths and identifiers are kept verbatim inside
 * them — a message a person cannot map back to a file is not much use.
 */

export const messages = {
  // ---- workspace lifecycle ----

  noBundleOpen: "バンドルが開かれていません。先にフォルダを開いてください。",
  searchIndexClosed: "検索インデックスが開かれていません。",
  notADirectory: (path: string) => `フォルダではありません: ${path}`,
  /**
   * A registered server declares a credential it has not been given.
   *
   * Names the key and the file, because the fix is a two-minute edit and the
   * failure without this message is not: the server starts, reports itself
   * connected, lists every tool it has, and then answers each call with its
   * own 401 JSON — which reads as this app being broken.
   */
  /** The tool's own connect command ran and did not finish the job. */
  connectCliFailed: (label: string, command: string, output: string) =>
    `${label} への登録に失敗しました。\n  実行したコマンド: ${command}\n  出力: ${output}`,
  mcpCredentialMissing: (label: string, keys: readonly string[], configPath: string) =>
    `${label}: ${keys.join(", ")} が未設定です。${configPath} を開いて値を入れ、もう一度接続してください。`,
  /**
   * Opening succeeded; creating one of the two reserved files did not.
   *
   * The folder is usable — every note in it reads and writes normally — so
   * this is a warning in the status bar, not a failure to open. The most
   * common cause is the name being occupied by something that is not a
   * writable file: a broken shortcut or link, or a folder of the same name.
   */
  reservedFileNotCreated: (path: string, reason: string) =>
    `${path} を作成できませんでした（フォルダは開けています）: ${reason}`,

  // ---- path containment and the layer contract ----

  pathEscapesBundle: (path: string) => `バンドルの外を指すパスです: ${path}`,
  rawImmutable: "raw/ は人間が原本を置く場所です。エージェントは書き込めません",
  ragDerived: ".rag/ は派生インデックスです。再構築すると失われます",
  layerViolation: (reason: string, path: string) => `${reason}: ${path}`,

  // ---- file operations ----

  notFound: (path: string) => `見つかりません: ${path}`,
  alreadyExists: (path: string) => `既に存在します: ${path}`,
  reservedCannotDelete: (path: string) =>
    `${path} は予約ファイル（index.md / log.md）のため削除できません`,

  // ---- OKF conformance (§11) ----

  missingFrontmatter: "YAML frontmatter がありません",
  missingType: "frontmatter に非空の 'type' が必要です",
  reservedHasFrontmatter: "予約ファイル（index.md / log.md）に frontmatter は置けません",
  rootIndexExtraKeys: (keys: string[]) =>
    `ルートの index.md に置けるのは 'okf_version' のみです。検出: ${keys.join(", ")}`,

  // ---- non-text files ----

  binaryNotice: "このファイルはテキストではないため表示できません。",
  binaryHint: ".rag/ の索引ファイルなどはアプリが管理します。編集の必要はありません。",
  binaryFile: (type: string | null) => type ?? "テキストではないファイル",
  fileSize: (bytes: number) => {
    if (bytes < 1024) return bytes + " バイト";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  },

  // ---- external MCP servers ----

  mcpSpawnFailed: (command: string, reason: string) =>
    `MCP サーバーを起動できません（${command}）: ${reason}`,
  mcpDisconnected: "MCP サーバーに接続していません",
  mcpTimeout: (method: string, ms: number) =>
    `MCP サーバーが応答しません（${method}, ${Math.round(ms / 1000)} 秒）`,
  mcpServerError: (reason: string, code: number) => `MCP サーバーがエラーを返しました (${code}): ${reason}`,
  mcpExited: (code: number, diagnostics: string) =>
    `MCP サーバーが終了しました (code ${code})` + (diagnostics ? `\n${diagnostics}` : ""),
  mcpUnknownServer: (id: string) => `未登録の MCP サーバーです: ${id}`,
  mcpNoText: "取り込める本文がありませんでした",

  // ---- importing sources ----

  importedTo: (path: string) => `raw/ に取り込みました: ${path}`,
  importOutsideRaw: (path: string) => `取り込み先は raw/ の中でなければなりません: ${path}`,
  importEmpty: "取り込める本文がありませんでした",

  // ---- paste ----

  pastedAsMarkdown: "書式を Markdown に変換して貼り付けました（Ctrl+Shift+V で書式なし）",

  // ---- layer movement ----

  rawIsHumanOnly:
    "raw/ は人間が原本を置く場所です。エージェントは書き込めません",
  rawPromotionIsHumanOnly:
    "raw/ からの引き上げは人間の操作でのみ行えます。" +
    "未査読の資料を正典に載せる判断は、エージェントには委ねられません",
  promoted: (from: string, to: string) => `${from} を ${to} に引き上げました`,
  promotedCopy: (from: string, to: string) =>
    `${from} を ${to} に複製しました（原本は raw/ に残しています）`,

  // ---- PARA ----

  paraUnknownClass: (value: string) =>
    `PARA の分類は project / area / resource / archive のいずれかです: ${value}`,
  paraMoved: (from: string, to: string, label: string) =>
    `${from} を${label}に移しました: ${to}`,
  paraAlready: (path: string, label: string) => `${path} は既に${label}です`,
  paraArchived: (path: string) => `${path} をアーカイブしました`,

  // ---- SkillSpace ----

  skillUnknown: (name: string) => `そのスキルはありません: ${name}`,
  skillMissingFile: (name: string) => `スキル ${name} に SKILL.md がありません`,
  skillResourceMissing: (path: string, name: string) =>
    `スキル ${name} に ${path} がありません`,
  skillResourceEscapes: (path: string, name: string) =>
    `スキル ${name} のフォルダ外は読み取れません: ${path}`,
  skillNoneMatched: (task: string) =>
    `「${task}」に合うスキルが見つかりませんでした。skill_list で一覧を確認してください`,
  skillSpaceEmpty: "スキルがまだありません",

  // ---- loops ----

  loopUnknown: (name: string) =>
    `ループ設計 ${name} はありません。loop_list で一覧を確認するか、loop_define で作成してください`,
  loopBadName: (name: string) =>
    `ループ名は英小文字・数字・ハイフンのみ使えます: ${name}`,
  loopNeedsGoal: "ループ設計には目的 (goal) が必要です",
  loopAlreadyRunning: (name: string) =>
    `ループ ${name} が実行中です。1 度に 1 実行の原則により、新しい実行は始められません。` +
    `先に loop_end で閉じてください`,
  loopNoneRunning: "実行中のループがありません。先に loop_start を呼んでください",
  loopRegressed: "OKF 非準拠が増えています。閉じる前に直してください",

  // ---- local agent runtimes ----

  agentUnreachable: (label: string, url: string, reason: string) =>
    `${label} に接続できません（${url}）: ${reason}`,
  agentNoModel: (label: string) => `${label} で使うモデルを指定してください`,
  agentModelMissing: (model: string, label: string) =>
    `モデル ${model} が ${label} にありません`,
  agentNoTools: (label: string) =>
    `${label} のモデルはツール呼び出しに対応していません。tools 対応モデルを選んでください`,
  agentRoundLimit: (rounds: number) =>
    `ツール呼び出しが上限 (${rounds} 回) に達したため打ち切りました`,
  agentBudgetExceeded: (tokens: number) =>
    `トークン上限 (${tokens}) に達したため打ち切りました`,

  // ---- one-touch connect ----

  connectWrote: (label: string, path: string) => `${label} の設定を書き込みました: ${path}`,
  connectBackedUp: (path: string) => `既存の設定を退避しました: ${path}`,
  connectUnknownTarget: (id: string) => `未対応の接続先です: ${id}`,
  connectNotInstalled: (label: string) => `${label} が見つかりません`,

  // ---- editor metadata ----

  nonConceptFile: "予約ファイル / 概念以外",
  unresolvedLinks: (count: number) => `未解決リンク ${count}`,
} as const;
