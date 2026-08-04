/**
 * Webview entry point: wires the panels to the RPC bridge.
 *
 * Everything here is orchestration. Rendering lives in `ui/`, safety in
 * `markdown.ts`, and all knowledge of the filesystem on the Bun side.
 */

import type { ConceptSummary } from "../shared/rpc-schema";
import type { BundleInfo, FileNode, TagCount } from "../shared/types";
import { initialViewMode } from "../shared/view-mode";
import { messages as messagesText } from "../shared/messages";
import { clear, el, must } from "./dom";
import { connect } from "./rpc";
import { renderMarkdown } from "./markdown";
import type { FormatAction } from "../shared/markdown-format";
import { Editor, type PreviewMode } from "./ui/editor";
import { ContextMenu } from "./ui/menu";
import { ConnectionsPanel } from "./ui/connections";
import { SkillsPanel } from "./ui/skills";
import { CommandPalette, type PaletteItem } from "./ui/palette";
import { SearchPanel } from "./ui/search";
import { FileTree } from "./ui/tree";

const ui = {
  open: must<HTMLButtonElement>("btn-open"),
  create: must<HTMLButtonElement>("btn-create"),
  save: must<HTMLButtonElement>("btn-save"),
  modeGroup: must("mode-group"),
  formatBar: must("format-bar"),
  widthSlider: must<HTMLInputElement>("width-slider"),
  widthReadout: must("width-readout"),
  emptyState: must("empty-state"),
  openEmpty: must<HTMLButtonElement>("btn-open-empty"),
  rebuild: must<HTMLButtonElement>("btn-rebuild"),
  connect: must<HTMLButtonElement>("btn-connect"),
  skills: must<HTMLButtonElement>("btn-skills"),
  status: must("status"),
  bundleName: must("bundle-name"),
  tree: must("tree"),
  tagBar: must("tag-bar"),
  textarea: must<HTMLTextAreaElement>("editor"),
  preview: must("preview"),
  pane: must("pane"),
  pathLabel: must("current-path"),
  metaBar: must("meta"),
  backlinks: must("backlinks"),
  autocomplete: must("autocomplete"),
  binaryNotice: must("binary-notice"),
  searchInput: must<HTMLInputElement>("search"),
  searchPanel: must("search-panel"),
  searchList: must("hits"),
  searchEmpty: must("hits-empty"),
  paletteRoot: must("palette"),
  paletteInput: must<HTMLInputElement>("palette-input"),
  paletteList: must("palette-list"),
  paletteEmpty: must("palette-empty"),
  menu: must("context-menu"),
  connectionsRoot: must("connections"),
  connectionsBody: must("connections-body"),
  connectionsClose: must("connections-close"),
  skillsRoot: must("skills"),
  skillsBody: must("skills-body"),
  skillsClose: must("skills-close"),
  updateButton: must<HTMLButtonElement>("btn-update"),
  updateRoot: must("update"),
  updateTitle: must("update-title"),
  updateBody: must("update-body"),
  updateClose: must("update-close"),
};

let bundle: BundleInfo | null = null;
let concepts: ConceptSummary[] = [];
let activeTags: string[] = [];

function setStatus(message: string, tone: "info" | "error" = "info"): void {
  ui.status.textContent = message;
  ui.status.dataset.tone = tone;
}

/** Reflect the active view mode in the segmented control. */
function showActiveMode(mode: PreviewMode): void {
  for (const button of Array.from(
    ui.modeGroup.querySelectorAll<HTMLElement>("button[data-mode]")
  )) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

/**
 * Show the welcome panel whenever no document is open.
 *
 * An empty editor with a blinking cursor gives no hint that a folder has to be
 * opened first, which is the one thing a new user must do.
 */
function showEmptyState(visible: boolean): void {
  ui.emptyState.hidden = !visible;
}

function reportError(error: unknown): void {
  setStatus(error instanceof Error ? error.message : String(error), "error");
}

/** Bundle-relative path for a concept id, honouring the wiki layer layout. */
function pathOfConceptId(id: string): string {
  return bundle?.wikiDir ? `${bundle.wikiDir}/${id}.md` : `${id}.md`;
}

/** Concept id for a bundle-relative path, or null when it is not a concept. */
function conceptIdOfPath(path: string): string | null {
  if (!/\.md$/i.test(path)) return null;
  const withoutExt = path.replace(/\.md$/i, "");
  const prefix = bundle?.wikiDir ? `${bundle.wikiDir}/` : "";
  if (prefix && !withoutExt.startsWith(prefix)) return null;
  return withoutExt.slice(prefix.length);
}

const rpc = connect({
  onFileChanged: ({ paths, info }) => void handleFileChanged(paths, info),
  // The local agent can spend a minute per round, so its steps stream in
  // rather than arriving all at once when the run finishes.
  onAgentStep: (step) => connections.pushStep(step),
});

const menu = new ContextMenu(ui.menu);

const palette = new CommandPalette({
  root: ui.paletteRoot,
  input: ui.paletteInput,
  list: ui.paletteList,
  empty: ui.paletteEmpty,
});

const editor = new Editor({
  textarea: ui.textarea,
  preview: ui.preview,
  pane: ui.pane,
  pathLabel: ui.pathLabel,
  metaBar: ui.metaBar,
  backlinks: ui.backlinks,
  autocomplete: ui.autocomplete,
  binaryNotice: ui.binaryNotice,
  onDirtyChange: (dirty) => {
    ui.save.disabled = !dirty;
    ui.pathLabel.classList.toggle("dirty", dirty);
  },
  onAutosave: () => void save({ silent: true }),
  onFollowLink: (target, kind) => void followLink(target, kind),
  onOpenExternal: (url) => void rpc.request.openExternal({ url }).catch(reportError),
  onOpenConcept: (id) => void openFile(pathOfConceptId(id)),
  onCreateMissing: (target) => void createConcept(target),
  onPaste: (from) => {
    if (from === "html") setStatus(messagesText.pastedAsMarkdown);
  },
  onSelectionChange: (active) => showActiveFormats(active),
});

/** Light up the toolbar buttons that describe the caret's block. */
function showActiveFormats(active: ReadonlySet<string>): void {
  for (const button of Array.from(
    ui.formatBar.querySelectorAll<HTMLElement>("button[data-format]")
  )) {
    const on = active.has(button.dataset.format ?? "");
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }
}

// One listener on the bar rather than one per button: the set is fixed in the
// markup, and delegation keeps the wiring in step with it automatically.
/**
 * Set the writing column's width.
 *
 * The value is a percentage of the pane; the stylesheet turns it into side
 * padding, so the editor and the preview stay in step and the scrollbar keeps
 * to the pane edge.
 */
function applyEditorWidth(percent: number): void {
  const clamped = Math.min(100, Math.max(40, Math.round(percent)));
  document.documentElement.style.setProperty("--measure", `${clamped}%`);
  ui.widthSlider.value = String(clamped);
  ui.widthReadout.textContent = `${clamped}%`;
}

// Applied on every move so the change is visible as it is made, but only
// written back once the user settles — a save per pixel would be absurd.
ui.widthSlider.addEventListener("input", () => applyEditorWidth(Number(ui.widthSlider.value)));
ui.widthSlider.addEventListener("change", () => {
  void rpc.request
    .setEditorWidth({ width: Number(ui.widthSlider.value) })
    .catch(reportError);
});

ui.formatBar.addEventListener("mousedown", (event) => {
  // Prevent the default so the textarea keeps its selection — losing it would
  // make every command apply to an empty range.
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-format]");
  if (button) event.preventDefault();
});

// The slider is not a formatting command; keep it out of that delegation.
ui.widthSlider.addEventListener("mousedown", (event) => event.stopPropagation());

ui.formatBar.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-format]");
  const action = button?.dataset.format;
  if (action) editor.format(action as FormatAction);
});

for (const eventName of ["keyup", "mouseup", "focus"] as const) {
  ui.textarea.addEventListener(eventName, () => editor.reportSelection());
}

const tree = new FileTree({
  container: ui.tree,
  listDir: (path) => rpc.request.listDir({ path }),
  onSelectFile: (path) => void openFile(path),
  onContextMenu: (node, at) => openNodeMenu(node, at),
  onMove: (from, toDir) => void moveInto(from, toDir),
});

/**
 * External MCP servers — Notion, GitHub, Google Drive and anything else that
 * speaks the protocol.
 *
 * Whatever is imported lands in `raw/`, so the tree is refreshed and the file
 * opened: the user should see the captured source immediately, since curating
 * it into `wiki/` is the next thing they will want to do.
 */
const connections = new ConnectionsPanel({
  root: ui.connectionsRoot,
  body: ui.connectionsBody,
  closeButton: ui.connectionsClose,

  listServers: () => rpc.request.listConnections(),
  connect: (id) => rpc.request.connectServer({ id }),
  disconnect: (id) => rpc.request.disconnectServer({ id }),
  listTools: (id) => rpc.request.listRemoteTools({ id }),
  importFrom: (id, tool, args, title) =>
    rpc.request.importFromServer({ id, tool, args, ...(title ? { title } : {}) }),
  addPreset: (preset) => rpc.request.addServerPreset({ preset }),
  configPath: () => rpc.request.openServerConfig(),

  listTargets: () => rpc.request.listConnectTargets(),
  previewConnect: (id) => rpc.request.previewConnect({ id }),
  applyConnect: (id) => rpc.request.applyConnect({ id }),
  connectAll: (includeMissing) => rpc.request.connectAllTargets({ includeMissing }),
  listLocalModels: (id) => rpc.request.listLocalModels({ id }),
  runLocalAgent: (id, model, task) => rpc.request.runLocalAgent({ id, model, task }),

  onImported: (path) => {
    void tree
      .refresh()
      .then(() => openFile(path))
      .catch(reportError);
  },
  onNotice: (message) => setStatus(message),
  onError: reportError,
});

/**
 * SkillSpace.
 *
 * The panel deliberately shows what each skill costs to open: the saving comes
 * from skills staying closed, and a number is the only way that is visible.
 */
const skills = new SkillsPanel({
  root: ui.skillsRoot,
  body: ui.skillsBody,
  closeButton: ui.skillsClose,

  listSkills: () => rpc.request.listSkills(),
  findSkill: (task) => rpc.request.findSkill({ task }),
  openSkillFile: (name) => rpc.request.openSkillFile({ name }),
  createSkill: (name, description) => rpc.request.createSkill({ name, description }),

  onOpenFile: (path) => void openFile(path).then(() => tree.refresh()).catch(reportError),
  onNotice: (message) => setStatus(message),
  onError: reportError,
});

const search = new SearchPanel({
  input: ui.searchInput,
  panel: ui.searchPanel,
  list: ui.searchList,
  empty: ui.searchEmpty,
  search: (query) =>
    rpc.request.search({
      query,
      limit: 40,
      ...(activeTags.length ? { tags: activeTags } : {}),
    }),
  onOpenHit: (path) => void openFile(path),
});

// ---- documents ----

/**
 * Open today's note, creating it if this is the first time today.
 *
 * One action either way. Asking "does today exist yet" is exactly the friction
 * that stops a daily note from being used at all.
 */
/**
 * Look for a newer release, once, in the background.
 *
 * Silent on every failure. Someone writing notes offline should never see an
 * error about an update check, and the button simply stays hidden.
 */
type UpdateNotice = NonNullable<
  Awaited<ReturnType<typeof rpc.request.checkForUpdate>>
>;
let pendingUpdate: UpdateNotice | null = null;

async function lookForUpdate(): Promise<void> {
  try {
    const found = await rpc.request.checkForUpdate({});
    if (!found) return;

    pendingUpdate = found;
    ui.updateButton.hidden = false;
    ui.updateButton.title = `新しいバージョン ${found.version} があります`;
  } catch {
    // Offline, rate-limited, DNS down — none of it is the user's problem.
  }
}

/** Show what changed, and how to install it. */
function showUpdateNotice(): void {
  if (!pendingUpdate) return;
  const notice = pendingUpdate;

  ui.updateTitle.textContent = `アップデート — ${notice.name}`;
  clear(ui.updateBody);

  ui.updateBody.appendChild(
    el("div", {
      className: "update-meta",
      text: `新しいバージョン ${notice.version} が公開されています（${notice.publishedAt.slice(0, 10)}）`,
    })
  );

  // The notes are Markdown from GitHub, which is untrusted input like any
  // other document, so they go through the same sanitising renderer.
  const notes = el("div", { className: "update-notes" });
  notes.appendChild(renderMarkdown(notice.notes));
  ui.updateBody.appendChild(notes);

  const how = el("div", { className: "update-how" });
  how.appendChild(el("div", { text: "インストールするには、アプリのフォルダで次を実行してください:" }));
  const code = el("code", { text: "PierrotKnowledge2 Update" });
  how.appendChild(code);
  how.appendChild(
    el("div", {
      className: "update-meta",
      text: "内容を確認したうえで `PierrotKnowledge2 Update --apply` で適用します。ノートには触れません。",
    })
  );
  ui.updateBody.appendChild(how);

  ui.updateRoot.hidden = false;
}

ui.updateButton.addEventListener("click", () => showUpdateNotice());
ui.updateClose.addEventListener("click", () => {
  ui.updateRoot.hidden = true;
});
ui.updateRoot.addEventListener("mousedown", (event) => {
  if (event.target === ui.updateRoot) ui.updateRoot.hidden = true;
});

async function openDailyNote(): Promise<void> {
  try {
    const { path, created } = await rpc.request.openDaily({});
    if (created) await tree.refresh();
    await openFile(path);
    // Straight into the editor: you opened today's note to write in it, and
    // reading view would put a click between you and the cursor.
    editor.setMode("edit");
    showActiveMode("edit");
    if (created) setStatus(`今日のノートを作成しました: ${path}`);
  } catch (error) {
    reportError(error);
  }
}

async function openFile(path: string): Promise<void> {
  // Autosave means a dirty buffer is nearly always transient; flush it rather
  // than interrupting navigation with a prompt.
  if (editor.isDirty) await save({ silent: true });

  try {
    const result = await rpc.request.readFile({ path });
    editor.load(path, result);

    const mode = initialViewMode(path, result.binary);
    editor.setMode(mode);
    showActiveMode(mode);

    showEmptyState(false);
    tree.select(path);
    setStatus(path);
  } catch (error) {
    reportError(error);
  }
}

async function save(options: { silent?: boolean } = {}): Promise<void> {
  const path = editor.path;
  if (!path || !editor.isDirty) return;

  const content = editor.value;
  try {
    const result = await rpc.request.writeFile({ path, content });
    editor.markSaved(result.mtimeMs);

    if (result.warnings.length) {
      setStatus(`${path} — OKF警告: ${result.warnings.join("; ")}`, "error");
    } else if (!options.silent) {
      setStatus(`保存: ${path}`);
    }
    await refreshConcepts();
  } catch (error) {
    reportError(error);
  }
}

/**
 * Follow a link from the open document.
 *
 * Resolution runs on the Bun side against the real concept set, so a bare
 * `[[name]]` finds its target wherever it lives. An unresolved wikilink offers
 * to create the page — the main way notes get written in a wiki.
 */
async function followLink(target: string, kind: "wikilink" | "internal"): Promise<void> {
  const from = editor.path ? conceptIdOfPath(editor.path) : null;
  if (from === null) {
    setStatus(`リンクを解決できません: ${target}`, "error");
    return;
  }

  try {
    const resolved = await rpc.request.resolveLink({ from, target });
    if (resolved) {
      await openFile(pathOfConceptId(resolved));
      return;
    }

    if (kind === "wikilink") {
      if (confirm(`「${target}」はまだありません。作成しますか？`)) {
        await createConcept(target);
      }
      return;
    }

    const dir = editor.path!.includes("/")
      ? editor.path!.slice(0, editor.path!.lastIndexOf("/"))
      : "";
    await openFile(dir ? `${dir}/${target}` : target);
  } catch (error) {
    reportError(error);
  }
}

async function createConcept(suggestedId?: string): Promise<void> {
  if (!bundle) return;

  const name = suggestedId ?? prompt("新しい概念のパス（例: topics/my-note）");
  if (!name) return;

  const relPath = name.endsWith(".md") ? name : `${name}.md`;
  const path = bundle.wikiDir ? `${bundle.wikiDir}/${relPath}` : relPath;
  const type = prompt("OKF type", "Concept");
  if (type === null) return;

  try {
    await rpc.request.createConcept({
      path,
      type: type.trim() || "Concept",
      title: relPath.replace(/\.md$/i, "").split("/").pop() ?? relPath,
    });
    await Promise.all([tree.refresh(), refreshConcepts()]);
    await openFile(path);
  } catch (error) {
    reportError(error);
  }
}

// ---- file operations ----

function openNodeMenu(node: FileNode, at: { x: number; y: number }): void {
  const readOnly = node.layer === "raw" || node.layer === "rag";
  const entries = [];

  if (node.type === "dir") {
    entries.push({
      label: "新規ノート…",
      run: () => void createConceptIn(node.path),
    });
    entries.push({
      label: "新規フォルダ…",
      run: () => void createFolderIn(node.path),
    });
  }

  // Promotion is the curation step, and it is human-only by contract — an
  // agent cannot decide that unreviewed material belongs in the canon.
  if (node.layer === "raw" && node.type === "file") {
    entries.push({ label: "wiki/ に引き上げる…", run: () => void promoteNode(node) });
  }

  if (!readOnly) {
    entries.push({ label: "名前を変更…", run: () => void renameNode(node) });
    entries.push({ label: "削除…", danger: true, run: () => void deleteNode(node) });
  }

  if (entries.length === 0) {
    entries.push({ label: `${node.layer} は読み取り専用`, run: () => {} });
  }

  menu.open(entries, at);
}

/**
 * Bring a file up from `raw/` into the wiki layer.
 *
 * Defaults to keeping the original: `raw/` is the record of what was actually
 * received, and a wiki page whose source has been moved away can no longer be
 * checked against it. Moving is offered explicitly for the case where
 * something simply landed in the wrong place.
 */
async function promoteNode(node: FileNode): Promise<void> {
  const suggested = `${bundle?.wikiDir ? `${bundle.wikiDir}/` : ""}${node.name}`;
  const to = prompt("wiki/ 内の保存先", suggested);
  if (!to) return;

  const keepSource = confirm(
    [
      "raw/ の原本を残しますか？",
      "",
      "OK       : 複製して原本を残す（推奨・出典を辿れます）",
      "キャンセル: 移動して raw/ から削除する",
    ].join("\n")
  );

  try {
    const result = await rpc.request.promotePath({ from: node.path, to, keepSource });
    await tree.refresh();
    await openFile(result.promoted);
    setStatus(
      result.kept
        ? messagesText.promotedCopy(result.source, result.promoted)
        : messagesText.promoted(result.source, result.promoted)
    );
  } catch (error) {
    reportError(error);
  }
}

async function createConceptIn(dir: string): Promise<void> {
  const name = prompt("ノート名", "new-note");
  if (!name) return;
  const relPath = name.endsWith(".md") ? name : `${name}.md`;
  const path = dir ? `${dir}/${relPath}` : relPath;

  try {
    await rpc.request.createConcept({
      path,
      type: "Concept",
      title: name.replace(/\.md$/i, ""),
    });
    await Promise.all([tree.refresh(), refreshConcepts()]);
    await openFile(path);
  } catch (error) {
    reportError(error);
  }
}

async function createFolderIn(dir: string): Promise<void> {
  const name = prompt("フォルダ名");
  if (!name) return;
  try {
    await rpc.request.createDirectory({ path: dir ? `${dir}/${name}` : name });
    await tree.refresh();
  } catch (error) {
    reportError(error);
  }
}

async function renameNode(node: FileNode): Promise<void> {
  const dir = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
  const next = prompt("新しい名前", node.name);
  if (!next || next === node.name) return;

  await movePath(node.path, dir ? `${dir}/${next}` : next);
}

async function moveInto(from: string, toDir: string): Promise<void> {
  const name = from.split("/").pop()!;
  await movePath(from, `${toDir}/${name}`);
}

/** Move or rename, reporting how many links were rewritten to follow it. */
async function movePath(from: string, to: string): Promise<void> {
  if (editor.isDirty) await save({ silent: true });

  try {
    const result = await rpc.request.movePath({ from, to });
    await Promise.all([tree.refresh(), refreshConcepts()]);

    if (editor.path === from) await openFile(result.moved);
    else tree.select(editor.path);

    setStatus(
      result.linkCount
        ? `移動: ${result.moved} — ${result.updated.length} ファイルの ${result.linkCount} リンクを更新`
        : `移動: ${result.moved}`
    );
  } catch (error) {
    reportError(error);
  }
}

async function deleteNode(node: FileNode): Promise<void> {
  if (!confirm(`${node.path} を削除しますか？この操作は取り消せません。`)) return;

  try {
    const result = await rpc.request.deletePath({ path: node.path });
    if (editor.path === node.path) {
      editor.clearDocument();
      showEmptyState(true);
    }
    await Promise.all([tree.refresh(), refreshConcepts()]);

    setStatus(
      result.brokenLinksFrom.length
        ? `削除: ${result.deleted} — リンク切れ: ${result.brokenLinksFrom.join(", ")}`
        : `削除: ${result.deleted}`,
      result.brokenLinksFrom.length ? "error" : "info"
    );
  } catch (error) {
    reportError(error);
  }
}

// ---- palette ----

async function openQuickSwitcher(): Promise<void> {
  await refreshConcepts();
  const items: PaletteItem[] = concepts.map((concept) => ({
    id: concept.id,
    label: concept.title,
    detail: concept.id,
    badge: concept.type,
    run: () => void openFile(concept.path),
  }));
  palette.show(items, "ノートを検索… (Ctrl+P)");
}

function openCommandPalette(): void {
  const commands: PaletteItem[] = [
    { id: "new", label: "新規ノート…", run: () => void createConcept() },
    { id: "open", label: "フォルダを開く…", run: () => void openBundle() },
    { id: "save", label: "保存", run: () => void save() },
    { id: "rebuild", label: "index.md と検索インデックスを再構築", run: () => void rebuild() },
    {
      id: "gaps",
      label: "未解決リンクを一覧",
      run: () => void showUnresolvedLinks(),
    },
    {
      id: "daily",
      label: "今日のノート",
      run: () => void openDailyNote(),
    },
    {
      id: "conformance",
      label: "OKF 準拠チェック",
      run: () => void showConformance(),
    },
    {
      id: "connections",
      label: "外部サービスから取り込む (MCP)…",
      run: () => void connections.open("mcp"),
    },
    {
      id: "connections-connect",
      label: "エージェントを接続する (Claude Code / Codex / Ollama …)",
      run: () => void connections.open("connect"),
    },
    {
      id: "connections-agent",
      label: "ローカルモデルで実行する (Ollama / llama.cpp)",
      run: () => void connections.open("agent"),
    },
    { id: "skills", label: "SkillSpace — スキル一覧", run: () => void skills.open() },
  ];
  palette.show(commands, "コマンド… (Ctrl+Shift+P)");
}

async function showUnresolvedLinks(): Promise<void> {
  try {
    const gaps = await rpc.request.unresolvedLinks();
    if (gaps.length === 0) {
      setStatus("未解決リンクはありません");
      return;
    }
    palette.show(
      gaps.map((gap) => ({
        id: `${gap.from}->${gap.target}`,
        label: `＋ ${gap.target}`,
        detail: `${gap.from} から参照`,
        run: () => void createConcept(gap.target),
      })),
      "未解決リンク（選ぶと作成）"
    );
  } catch (error) {
    reportError(error);
  }
}

async function showConformance(): Promise<void> {
  try {
    const issues = await rpc.request.checkConformance();
    if (issues.length === 0) {
      setStatus("すべて OKF v0.2 に準拠しています");
      return;
    }
    palette.show(
      issues.map((issue) => ({
        id: issue.path,
        label: issue.path,
        detail: issue.errors.join("; "),
        run: () => void openFile(issue.path),
      })),
      `非準拠 ${issues.length} 件`
    );
  } catch (error) {
    reportError(error);
  }
}

// ---- bundle state ----

async function refreshConcepts(): Promise<void> {
  try {
    concepts = await rpc.request.listConcepts();
    editor.setConcepts(concepts);
    await refreshTags();
  } catch {
    // A stale autocomplete list is not worth surfacing as an error.
  }
}

async function refreshTags(): Promise<void> {
  const { tags } = await rpc.request.listTags();
  renderTagBar(tags);
}

function renderTagBar(tags: TagCount[]): void {
  clear(ui.tagBar);
  if (tags.length === 0) {
    ui.tagBar.hidden = true;
    return;
  }
  ui.tagBar.hidden = false;

  for (const { tag, count } of tags.slice(0, 24)) {
    const active = activeTags.includes(tag);
    const chip = el("button", {
      className: `chip${active ? " active" : ""}`,
      text: `#${tag} ${count}`,
    });
    chip.type = "button";
    chip.addEventListener("click", () => {
      activeTags = active ? activeTags.filter((t) => t !== tag) : [...activeTags, tag];
      renderTagBar(tags);
      search.rerun();
    });
    ui.tagBar.appendChild(chip);
  }
}

function applyBundleInfo(info: BundleInfo): void {
  bundle = info;
  ui.bundleName.textContent = info.root;
  ui.create.disabled = false;
  ui.rebuild.disabled = false;
  ui.connect.disabled = false;
  ui.skills.disabled = false;

  // A folder that opened with warnings is still open, but the warning names
  // something the user has to fix by hand — it outranks the counts.
  if (info.warnings.length > 0) {
    setStatus(info.warnings.join(" / "), "error");
    return;
  }

  const parts = [`概念 ${info.conceptCount} 件`];
  if (info.nonConformantCount) parts.push(`${info.nonConformantCount} 非準拠`);
  if (!info.hasAgentsMd) parts.push("AGENTS.md なし");
  setStatus(parts.join(" · "), info.nonConformantCount > 0 ? "error" : "info");
}

async function openBundle(): Promise<void> {
  try {
    // Null means this host cannot show a folder dialog — a browser has no way
    // to hand a page a filesystem path. Asking for it as text is the whole
    // fallback, and it is only reached in the browser-served mode.
    const picked = await rpc.request.pickBundleDir();
    const path =
      picked ??
      prompt("バンドルのフォルダを絶対パスで入力してください", bundle?.root ?? "")?.trim();
    if (!path) return;
    setStatus("開いています…");
    applyBundleInfo(await rpc.request.openBundle({ path }));
    editor.clearDocument();
    showEmptyState(true);
    activeTags = [];
    await Promise.all([tree.refresh(), refreshConcepts()]);
  } catch (error) {
    reportError(error);
  }
}

async function rebuild(): Promise<void> {
  try {
    setStatus("再構築中…");
    const [{ rows }, { indexed }] = await Promise.all([
      rpc.request.rebuildIndex(),
      rpc.request.rebuildRag(),
    ]);
    setStatus(`index.md: ${rows} 件 · 検索インデックス: ${indexed} 件`);
    await Promise.all([tree.refresh(), refreshConcepts()]);
  } catch (error) {
    reportError(error);
  }
}

/**
 * React to a change made outside the editor — an agent over MCP, or another
 * program. A clean buffer is refreshed silently; a dirty one is left alone and
 * flagged, because discarding unsaved work to win a race is never right.
 */
async function handleFileChanged(paths: string[], info: BundleInfo): Promise<void> {
  applyBundleInfo(info);
  await Promise.all([tree.refresh(), refreshConcepts()]);
  if (editor.path) tree.select(editor.path);

  const openPath = editor.path;
  if (!openPath || !paths.includes(openPath)) return;

  if (editor.isDirty) {
    setStatus(`${openPath} が外部で変更されました（未保存の変更あり）`, "error");
    return;
  }

  try {
    editor.adopt(await rpc.request.readFile({ path: openPath }));
    setStatus(`${openPath} を外部の変更で再読み込みしました`);
  } catch (error) {
    reportError(error);
  }
}

// ---- wiring ----

ui.open.addEventListener("click", () => void openBundle());
ui.openEmpty.addEventListener("click", () => void openBundle());
ui.create.addEventListener("click", () => void createConcept());
ui.save.addEventListener("click", () => void save());
ui.rebuild.addEventListener("click", () => void rebuild());
ui.connect.addEventListener("click", () => void connections.open());
ui.skills.addEventListener("click", () => void skills.open());

ui.modeGroup.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-mode]");
  const mode = button?.dataset.mode as PreviewMode | undefined;
  if (!mode) return;
  editor.setMode(mode);
  showActiveMode(mode);
});

window.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return;

  if (event.key === "s") {
    event.preventDefault();
    void save();
  } else if (event.key === "p" && event.shiftKey) {
    event.preventDefault();
    openCommandPalette();
  } else if (event.key === "p") {
    event.preventDefault();
    void openQuickSwitcher();
  } else if (event.key === "k" || event.key === "f") {
    event.preventDefault();
    search.focus();
  } else if (event.key === "o") {
    event.preventDefault();
    void openBundle();
  }
});

// Autosave makes an unsaved-work prompt mostly redundant, but a crash during
// the debounce window would still lose the last keystrokes.
window.addEventListener("beforeunload", (event) => {
  if (!editor.isDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

/**
 * Reopen the last session on launch.
 *
 * Starting on an empty window every time makes the app feel like it lost the
 * work, even though the notes were never anywhere but on disk.
 */
async function restore(): Promise<void> {
  try {
    setStatus("読み込み中…");
    const { info, lastFile, editorWidth } = await rpc.request.restoreSession();
    applyEditorWidth(editorWidth);

    if (!info) {
      setStatus("フォルダを開いてください (Ctrl+O)");
      return;
    }

    applyBundleInfo(info);
    await Promise.all([tree.refresh(), refreshConcepts()]);

    if (lastFile) {
      // The document may have been renamed or deleted since; falling back to
      // the welcome screen is better than an error about a file the user has
      // probably forgotten about.
      try {
        editor.load(lastFile, await rpc.request.readFile({ path: lastFile }));
        showEmptyState(false);
        tree.select(lastFile);
        setStatus(lastFile);
      } catch {
        setStatus(`概念 ${info.conceptCount} 件 · ${info.root}`);
      }
    }
  } catch (error) {
    reportError(error);
  }
}

void restore();

// Look for a newer release after the window is up, never before: the check
// touches the network and must not delay anything the user is waiting for.
void lookForUpdate();
