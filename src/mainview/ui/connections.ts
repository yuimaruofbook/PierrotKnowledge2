/**
 * The connections panel — everything this app talks to, on one page.
 *
 * Three sections, stacked and scrolled rather than put behind tabs:
 *
 *   1. **外部サービス (MCP)** — register a server, connect, pick a tool, fill
 *      in its arguments, capture the result into `raw/`. Deliberately generic:
 *      the tool list and the argument fields are built from whatever the
 *      server declares in its JSON Schema, so Notion, GitHub, Google Drive and
 *      anything else that speaks MCP work through the same screen with no
 *      per-service code.
 *   2. **エージェント接続** — write this app into an agent host's config, or
 *      point at a local model server. A host gets a config file written; a
 *      model server does not speak MCP at all and is driven by section 3.
 *   3. **ローカル実行** — run the built-in agent loop against a local model.
 *
 * They were tabs, and before that two of them lived in SkillSpace. Both splits
 * had the same fault: "what is this app connected to?" is one question, and an
 * answer you have to click through is not an answer. On one page the state of
 * all three is visible at once.
 *
 * Each section owns a container and re-renders only itself. A whole-page
 * render would be simpler but would wipe a half-filled import form every time
 * a local agent streamed a step into the section below it.
 */

import { VAULT_PLACEHOLDER, type McpToolDefinition, type ServerStatus } from "../../shared/mcp-types";
import type { BulkConnectOutcome, BulkConnectStatus } from "../../shared/connect-types";
import type { AgentRunResult, AgentStep } from "../../shared/agent-types";
import { collectArguments, fieldsOf } from "../../shared/tool-form";
import { clear, el } from "../dom";

export interface ConnectTargetStatus {
  id: string;
  label: string;
  kind: "mcp-host" | "model-server";
  configPath: string;
  installed: boolean;
  note: string;
  endpoint?: string;
  /** Present when the host is configured by its own CLI rather than by us. */
  setupCommand?: string;
  connected: boolean;
}

export interface ConnectionsPanelOptions {
  root: HTMLElement;
  /** The scrolling page all three sections are built into. */
  body: HTMLElement;
  closeButton: HTMLElement;

  listServers: () => Promise<ServerStatus[]>;
  connect: (id: string) => Promise<ServerStatus>;
  disconnect: (id: string) => Promise<void>;
  listTools: (id: string) => Promise<McpToolDefinition[]>;
  importFrom: (
    id: string,
    tool: string,
    args: Record<string, unknown>,
    title?: string
  ) => Promise<{ path: string }>;
  addPreset: (preset: string) => Promise<{ servers: ServerStatus[]; note: string }>;
  configPath: () => Promise<string>;

  listTargets: () => Promise<ConnectTargetStatus[]>;
  previewConnect: (id: string) => Promise<{ path: string; content: string }>;
  applyConnect: (id: string) => Promise<{ path: string; backup?: string }>;
  connectAll: (includeMissing: boolean) => Promise<BulkConnectOutcome[]>;
  listLocalModels: (id: string) => Promise<string[]>;
  runLocalAgent: (id: string, model: string, task: string) => Promise<AgentRunResult>;

  /** A file was captured into `raw/` — the caller opens it. */
  onImported: (path: string) => void;
  /** Something to tell the user that is not a bundle path. */
  onNotice: (message: string) => void;
  onError: (error: unknown) => void;
}

/** A section to bring into view when the panel is opened for a purpose. */
export type ConnectionsSection = "mcp" | "connect" | "agent";

const SECTION_TITLES: Record<ConnectionsSection, string> = {
  mcp: "外部サービス (MCP)",
  connect: "エージェント接続",
  agent: "ローカル実行",
};

/**
 * How each outcome of the one-touch sweep reads.
 *
 * "変更なし" is a success, not a shrug: pressing the button again is the
 * normal way to re-point every agent at a moved bundle, and most rows saying
 * nothing changed is exactly what should happen the second time.
 */
const BULK_STATUS: Record<BulkConnectStatus, { text: string; badge: string }> = {
  connected: { text: "登録しました", badge: "ok" },
  unchanged: { text: "変更なし（登録済み）", badge: "ok" },
  manual: { text: "コマンドの実行が必要", badge: "warn" },
  skipped: { text: "未検出のためスキップ", badge: "" },
  failed: { text: "失敗", badge: "bad" },
};

export class ConnectionsPanel {
  private servers: ServerStatus[] = [];
  private selected: string | null = null;
  private tools: McpToolDefinition[] = [];
  private activeTool: string | null = null;
  private targets: ConnectTargetStatus[] = [];
  private steps: AgentStep[] = [];
  private running = false;
  /** The one-touch sweep: in flight, its last report, and its one option. */
  private bulkRunning = false;
  private bulkReport: BulkConnectOutcome[] | null = null;
  private bulkIncludeMissing = false;
  /** Set by "このモデルで実行" so the run controls open on that server. */
  private preferredServer: string | null = null;

  /**
   * One container per section, created once.
   *
   * Re-rendering only the section that changed is what keeps a half-filled
   * import form alive while the local agent below it streams its steps.
   */
  private sections: Record<ConnectionsSection, HTMLElement> | null = null;

  constructor(private readonly ui: ConnectionsPanelOptions) {
    ui.closeButton.addEventListener("click", () => this.close());
    ui.root.addEventListener("mousedown", (event) => {
      if (event.target === ui.root) this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !ui.root.hidden) this.close();
    });
  }

  async open(focus?: ConnectionsSection): Promise<void> {
    this.ui.root.hidden = false;
    this.mount();
    await this.refresh();

    // Opened from a command that named a purpose: put that section where the
    // user is already looking rather than making them find it.
    if (focus && this.sections) {
      this.sections[focus].scrollIntoView({ block: "start" });
    }
  }

  close(): void {
    this.ui.root.hidden = true;
  }

  /** Called from the RPC message stream while the local agent works. */
  pushStep(step: AgentStep): void {
    if (!this.running) return;
    this.steps.push(step);
    this.renderAgent();
  }

  /** Build the three section shells, once. */
  private mount(): void {
    if (this.sections) return;

    clear(this.ui.body);
    const made = {} as Record<ConnectionsSection, HTMLElement>;

    for (const id of ["mcp", "connect", "agent"] as const) {
      const section = el("section", { className: "conn-section" });
      section.appendChild(el("h2", { className: "conn-section-head", text: SECTION_TITLES[id] }));

      const content = el("div", { className: "conn-section-body" });
      section.appendChild(content);
      this.ui.body.appendChild(section);
      made[id] = content;
    }

    this.sections = made;
  }

  private async refresh(): Promise<void> {
    const [servers, targets] = await Promise.all([
      this.ui.listServers().catch((error) => {
        this.ui.onError(error);
        return [] as ServerStatus[];
      }),
      this.ui.listTargets().catch((error) => {
        this.ui.onError(error);
        return [] as ConnectTargetStatus[];
      }),
    ]);

    this.servers = servers;
    this.targets = targets;

    this.renderMcp();
    this.renderConnect();
    this.renderAgent();
  }

  /**
   * The MCP section: every registered server, with the selected one expanded.
   *
   * Inline rather than the master/detail pair this used to be. A second column
   * inside one section of a scrolling page reads as a panel within a panel,
   * and the detail is only ever wanted for one server at a time anyway.
   */
  private renderMcp(): void {
    if (!this.sections) return;
    const body = this.sections.mcp;
    clear(body);

    body.appendChild(
      el("p", {
        className: "conn-hint",
        text: "取り込んだ内容は raw/ にのみ保存されます。wiki/ には自動で入りません。",
      })
    );

    if (this.servers.length === 0) {
      body.appendChild(el("div", { className: "empty", text: "接続先がまだ登録されていません。" }));
    }

    for (const server of this.servers) {
      const row = el("div", {
        className: `conn-item${server.id === this.selected ? " selected" : ""}`,
      });

      const head = el("button", { className: "conn-row" });
      head.type = "button";
      head.appendChild(
        el("span", {
          className: `conn-dot${server.connected ? " on" : ""}`,
          title: server.connected ? "接続中" : "未接続",
        })
      );
      head.appendChild(el("span", { className: "conn-label", text: server.label }));
      if (server.toolCount !== undefined) {
        head.appendChild(el("span", { className: "badge", text: `${server.toolCount} ツール` }));
      }
      head.addEventListener("click", () => void this.select(server.id));
      row.appendChild(head);

      if (server.id === this.selected) {
        const detail = el("div", { className: "conn-detail" });
        this.renderServerDetail(detail, server);
        row.appendChild(detail);
      }

      body.appendChild(row);
    }

    const presets = el("div", { className: "conn-presets" });
    presets.appendChild(el("div", { className: "conn-presets-head", text: "追加" }));
    for (const [id, label] of [
      ["notion", "Notion"],
      ["github", "GitHub"],
      ["gdrive", "Google Drive"],
      ["obsidian", "Obsidian"],
    ] as const) {
      if (this.servers.some((s) => s.id === id)) continue;
      const button = el("button", { className: "chip", text: `＋ ${label}` });
      button.type = "button";
      button.addEventListener("click", () => void this.addPreset(id));
      presets.appendChild(button);
    }
    body.appendChild(presets);
  }

  private async addPreset(id: string): Promise<void> {
    try {
      const { servers, note } = await this.ui.addPreset(id);
      this.servers = servers;
      this.selected = id;
      this.renderMcp();
      // What the service needs before it can answer — a Notion integration
      // has to exist and be given the pages you want. Shown now, because now
      // is when it is acted on.
      if (note) this.ui.onNotice(note);
    } catch (error) {
      this.ui.onError(error);
    }
  }

  /** Selecting the open server again collapses it. */
  private async select(id: string): Promise<void> {
    if (this.selected === id) {
      this.selected = null;
      this.tools = [];
      this.activeTool = null;
      this.renderMcp();
      return;
    }

    this.selected = id;
    this.tools = [];
    this.activeTool = null;
    this.renderMcp();

    const server = this.servers.find((s) => s.id === id);
    if (server?.connected) await this.loadTools();
  }

  private async loadTools(): Promise<void> {
    if (!this.selected) return;
    try {
      this.tools = await this.ui.listTools(this.selected);
      this.activeTool = this.tools[0]?.name ?? null;
    } catch (error) {
      this.ui.onError(error);
      this.tools = [];
    }
    this.renderMcp();
  }

  private renderServerDetail(detail: HTMLElement, server: ServerStatus): void {
    detail.appendChild(el("div", { className: "conn-command", text: server.command }));

    // A preset still carrying its placeholder cannot connect, and the failure
    // it produces — a directory that does not exist — does not say why. Say it
    // here, before the user presses 接続 and goes looking for a bug.
    if (server.command.includes(VAULT_PLACEHOLDER)) {
      detail.appendChild(
        el("div", {
          className: "conn-error",
          text:
            `設定ファイルの ${VAULT_PLACEHOLDER} を、Vault フォルダの絶対パスに` +
            "書き換えてください。このままでは接続できません。",
        })
      );
    }

    const actions = el("div", { className: "conn-actions" });
    const toggle = el("button", {
      className: `btn ${server.connected ? "" : "btn-primary"}`,
      text: server.connected ? "切断" : "接続",
    });
    toggle.type = "button";
    toggle.addEventListener("click", () => void this.toggle(server));
    actions.appendChild(toggle);

    const config = el("button", { className: "btn", text: "設定ファイルの場所" });
    config.type = "button";
    config.addEventListener("click", () => void this.showConfigPath());
    actions.appendChild(config);
    detail.appendChild(actions);

    if (server.error) {
      detail.appendChild(el("pre", { className: "conn-error", text: server.error }));
    }

    if (!server.connected) {
      detail.appendChild(
        el("div", {
          className: "conn-hint",
          text: "トークンなどの設定は「設定ファイルの場所」を開いて編集してください。編集後に再接続します。",
        })
      );
      return;
    }

    if (this.tools.length === 0) {
      detail.appendChild(el("div", { className: "empty", text: "ツールを読み込み中…" }));
      return;
    }

    this.renderToolPicker(detail);
  }

  private renderToolPicker(detail: HTMLElement): void {
    detail.appendChild(el("div", { className: "panel-head", text: "ツール" }));

    const select = el("select", { className: "conn-select" }) as HTMLSelectElement;
    for (const tool of this.tools) {
      const option = document.createElement("option");
      option.value = tool.name;
      option.textContent = tool.title ? `${tool.name} — ${tool.title}` : tool.name;
      if (tool.name === this.activeTool) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      this.activeTool = select.value;
      // Only this section: a different tool means different argument fields,
      // but nothing elsewhere on the page has changed.
      this.renderMcp();
    });
    detail.appendChild(select);

    const tool = this.tools.find((t) => t.name === this.activeTool);
    if (!tool) return;

    if (tool.description) {
      detail.appendChild(el("p", { className: "conn-desc", text: tool.description }));
    }

    const form = el("div", { className: "conn-form" });
    const inputs = new Map<string, HTMLInputElement>();

    const fields = fieldsOf(tool);

    for (const field of fields) {
      const row = el("label", { className: "conn-field" });
      row.appendChild(
        el("span", {
          className: "conn-field-name",
          text: field.required ? `${field.name} *` : field.name,
          ...(field.schema.description ? { title: field.schema.description } : {}),
        })
      );
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = field.schema.description ?? field.schema.type ?? "";
      row.appendChild(input);
      inputs.set(field.name, input);
      form.appendChild(row);
    }

    const titleRow = el("label", { className: "conn-field" });
    titleRow.appendChild(el("span", { className: "conn-field-name", text: "保存名" }));
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "省略するとツール名になります";
    titleRow.appendChild(titleInput);
    form.appendChild(titleRow);

    detail.appendChild(form);

    const run = el("button", { className: "btn btn-primary", text: "raw/ に取り込む" });
    run.type = "button";
    run.addEventListener("click", () => {
      const args = collectArguments(fields, (name) => inputs.get(name)?.value ?? "");
      void this.runImport(tool.name, args, titleInput.value);
    });

    const footer = el("div", { className: "conn-actions" });
    footer.appendChild(run);
    detail.appendChild(footer);
  }

  private async runImport(
    tool: string,
    args: Record<string, unknown>,
    title: string
  ): Promise<void> {
    if (!this.selected) return;
    try {
      const { path } = await this.ui.importFrom(this.selected, tool, args, title.trim() || undefined);
      this.ui.onImported(path);
      this.close();
    } catch (error) {
      this.ui.onError(error);
    }
  }

  private async toggle(server: ServerStatus): Promise<void> {
    try {
      if (server.connected) {
        await this.ui.disconnect(server.id);
        this.tools = [];
      } else {
        await this.ui.connect(server.id);
      }
      await this.refresh();
      if (!server.connected) await this.loadTools();
    } catch (error) {
      this.ui.onError(error);
      await this.refresh();
    }
  }

  /**
   * Show where the registry lives.
   *
   * Tokens are edited by hand in that file rather than typed into this panel:
   * they would otherwise have to be held, echoed and stored by the app, and the
   * file is already the thing every other MCP host uses.
   */
  private async showConfigPath(): Promise<void> {
    try {
      this.ui.onNotice(`設定ファイル: ${await this.ui.configPath()}`);
    } catch (error) {
      this.ui.onError(error);
    }
  }

  // ---- エージェント接続 ----

  private renderConnect(): void {
    if (!this.sections) return;
    const body = this.sections.connect;
    clear(body);

    const hosts = this.targets.filter((t) => t.kind === "mcp-host");
    const servers = this.targets.filter((t) => t.kind === "model-server");

    body.appendChild(this.bulkConnect(hosts));

    body.appendChild(el("div", { className: "panel-head", text: "MCP ホスト" }));
    body.appendChild(
      el("p", {
        className: "conn-hint",
        text: "設定ファイルに 1 項目だけ追記します。既存の設定は変更せず、上書き前に必ずバックアップを取ります。",
      })
    );
    for (const target of hosts) body.appendChild(this.targetRow(target));

    body.appendChild(el("div", { className: "panel-head", text: "ローカルモデルサーバー" }));
    body.appendChild(
      el("p", {
        className: "conn-hint",
        text: "これらは MCP クライアントではありません。本アプリ内蔵のエージェントから使います（「ローカル実行」タブ）。",
      })
    );
    for (const target of servers) body.appendChild(this.targetRow(target));
  }

  /**
   * One button that wires this bundle into every agent on the machine.
   *
   * Above the per-host rows rather than below them, because it is the answer
   * to what someone opening this section came for: the rows are for the case
   * where you want one particular tool, and that is the rarer one. Knowing a
   * knowledge base exists is worth nothing to an agent that was never told
   * about it, and eight hosts connected one at a time is how people end up
   * with it wired into two.
   *
   * The count is on the button because it is the only honest preview of a
   * one-touch action: 5 means five config files are about to be touched, and
   * 0 means pressing it would do nothing — so it is disabled instead.
   */
  private bulkConnect(hosts: ConnectTargetStatus[]): HTMLElement {
    const box = el("div", { className: "conn-bulk" });

    // Hosts we write for. The ones carrying a `setupCommand` are ours to
    // report, never ours to write, so they are not part of the count.
    const writable = hosts.filter((t) => !t.setupCommand);
    const targets = this.bulkIncludeMissing ? writable : writable.filter((t) => t.installed);

    box.appendChild(
      el("p", {
        className: "conn-bulk-lede",
        text: "このバンドルを、見つかったエージェントすべての RAG として一度に登録します。",
      })
    );

    const actions = el("div", { className: "conn-actions" });
    const run = el("button", {
      className: "btn btn-primary btn-lg",
      text: this.bulkRunning ? "登録中…" : `すべてのエージェントに登録（${targets.length}）`,
    });
    run.type = "button";
    run.disabled = this.bulkRunning || targets.length === 0;
    run.addEventListener("click", () => void this.runBulkConnect());
    actions.appendChild(run);
    box.appendChild(actions);

    // A CLI that is not on PATH is not a missing tool — Cursor on Windows is
    // usually installed and usually invisible to `where`. Without this, the
    // sweep would quietly leave out a host the user does have.
    const toggle = el("label", { className: "conn-toggle" });
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = this.bulkIncludeMissing;
    check.addEventListener("change", () => {
      this.bulkIncludeMissing = check.checked;
      this.renderConnect();
    });
    toggle.appendChild(check);
    toggle.appendChild(
      el("span", { text: "未検出のツールにも書き込む（CLI が PATH に無いだけの場合）" })
    );
    box.appendChild(toggle);

    if (this.bulkReport) box.appendChild(this.bulkResults(this.bulkReport));

    return box;
  }

  /** What the sweep actually did, per host — including what it did not do. */
  private bulkResults(report: readonly BulkConnectOutcome[]): HTMLElement {
    const list = el("div", { className: "conn-results" });

    for (const outcome of report) {
      const row = el("div", { className: "conn-result" });

      const head = el("div", { className: "conn-result-head" });
      head.appendChild(el("span", { className: "conn-result-name", text: outcome.label }));
      const status = BULK_STATUS[outcome.status];
      head.appendChild(
        el("span", { className: `badge${status.badge ? ` ${status.badge}` : ""}`, text: status.text })
      );
      row.appendChild(head);

      // The command for a host we must not write, verbatim and copyable —
      // otherwise "コマンドの実行が必要" is a dead end.
      if (outcome.command) {
        const how = el("div", { className: "update-how" });
        how.appendChild(el("div", { text: "次のコマンドを実行してください:" }));
        how.appendChild(el("code", { text: outcome.command }));
        row.appendChild(how);
      } else {
        row.appendChild(
          el("div", { className: "conn-command", text: outcome.reason ?? outcome.path })
        );
      }

      if (outcome.backup) {
        row.appendChild(el("div", { className: "conn-command", text: `退避: ${outcome.backup}` }));
      }

      list.appendChild(row);
    }

    return list;
  }

  private async runBulkConnect(): Promise<void> {
    if (this.bulkRunning) return;

    this.bulkRunning = true;
    this.bulkReport = null;
    this.renderConnect();

    try {
      const report = await this.ui.connectAll(this.bulkIncludeMissing);
      this.bulkReport = report;

      const done = report.filter(
        (r) => r.status === "connected" || r.status === "unchanged"
      ).length;
      const failed = report.filter((r) => r.status === "failed").length;
      const manual = report.filter((r) => r.status === "manual").length;

      // The counts that need acting on are named; the rest is in the report
      // below, which is already on screen.
      this.ui.onNotice(
        [
          `${done} 件のエージェントに登録しました`,
          ...(failed ? [`失敗 ${failed} 件`] : []),
          ...(manual ? [`手動コマンド ${manual} 件`] : []),
        ].join(" · ")
      );
    } catch (error) {
      this.ui.onError(error);
    } finally {
      this.bulkRunning = false;
      // Re-reads every target, so the dots beside the rows below agree with
      // the report that was just written.
      await this.refresh();
      // That rebuild resets the page's scroll position, which put the report
      // the user just asked for above the top of the panel — the one thing
      // they were waiting to read.
      this.sections?.connect
        .querySelector(".conn-results")
        ?.scrollIntoView({ block: "start" });
    }
  }

  private targetRow(target: ConnectTargetStatus): HTMLElement {
    const row = el("div", { className: "skill-row" });

    const head = el("div", { className: "skill-head" });
    head.appendChild(
      el("span", {
        className: `conn-dot${target.connected ? " on" : ""}`,
        title: target.connected ? "設定済み" : "未設定",
      })
    );
    head.appendChild(el("span", { className: "skill-name", text: target.label }));
    head.appendChild(
      el("span", {
        className: `badge${target.installed ? "" : " warn"}`,
        text: target.installed ? "インストール済み" : "未検出",
      })
    );
    row.appendChild(head);

    row.appendChild(el("div", { className: "conn-command", text: target.configPath }));
    row.appendChild(el("p", { className: "skill-desc", text: target.note }));

    const actions = el("div", { className: "conn-actions" });

    // A host whose config we deliberately do not write: show the command
    // instead of a button that would edit a file we should not touch.
    if (target.setupCommand) {
      const how = el("div", { className: "update-how" });
      how.appendChild(el("div", { text: "次のコマンドを実行してください:" }));
      how.appendChild(el("code", { text: target.setupCommand }));
      row.appendChild(how);
      return row;
    }

    if (target.kind === "mcp-host") {
      const preview = el("button", { className: "btn", text: "変更内容を見る" });
      preview.type = "button";
      preview.addEventListener("click", () => void this.previewTarget(target));
      actions.appendChild(preview);

      const apply = el("button", {
        className: "btn btn-primary",
        text: target.connected ? "設定を更新" : "ワンタッチ接続",
      });
      apply.type = "button";
      apply.addEventListener("click", () => void this.applyTarget(target));
      actions.appendChild(apply);
    } else {
      // The run controls are further down the same page now, so this scrolls
      // to them and preselects this server rather than switching views.
      const use = el("button", { className: "btn btn-primary", text: "このモデルで実行" });
      use.type = "button";
      use.addEventListener("click", () => {
        this.preferredServer = target.id;
        this.renderAgent();
        this.sections?.agent.scrollIntoView({ block: "center" });
      });
      actions.appendChild(use);
    }

    row.appendChild(actions);
    return row;
  }

  private async previewTarget(target: ConnectTargetStatus): Promise<void> {
    try {
      const { path, content } = await this.ui.previewConnect(target.id);
      this.sections?.connect.prepend(
        el("pre", { className: "conn-error preview", text: `${path}\n\n${content}` })
      );
    } catch (error) {
      this.ui.onError(error);
    }
  }

  private async applyTarget(target: ConnectTargetStatus): Promise<void> {
    try {
      const result = await this.ui.applyConnect(target.id);
      this.ui.onNotice(
        result.backup
          ? `${target.label}: ${result.path}（退避: ${result.backup}）`
          : `${target.label}: ${result.path}`
      );
      await this.refresh();
    } catch (error) {
      this.ui.onError(error);
    }
  }

  // ---- ローカル実行 ----

  private renderAgent(): void {
    if (!this.sections) return;
    const body = this.sections.agent;
    clear(body);

    const servers = this.targets.filter((t) => t.kind === "model-server");

    const controls = el("div", { className: "conn-form" });

    const serverRow = el("label", { className: "conn-field" });
    serverRow.appendChild(el("span", { className: "conn-field-name", text: "サーバー" }));
    const serverSelect = el("select", { className: "conn-select" }) as HTMLSelectElement;
    for (const server of servers) {
      const option = document.createElement("option");
      option.value = server.id;
      option.textContent = `${server.label} — ${server.endpoint ?? ""}`;
      if (server.id === this.preferredServer) option.selected = true;
      serverSelect.appendChild(option);
    }
    serverRow.appendChild(serverSelect);
    controls.appendChild(serverRow);

    const modelRow = el("label", { className: "conn-field" });
    modelRow.appendChild(el("span", { className: "conn-field-name", text: "モデル" }));
    const modelSelect = el("select", { className: "conn-select" }) as HTMLSelectElement;
    modelRow.appendChild(modelSelect);
    controls.appendChild(modelRow);

    const loadModels = async () => {
      clear(modelSelect);
      try {
        for (const model of await this.ui.listLocalModels(serverSelect.value)) {
          const option = document.createElement("option");
          option.value = model;
          option.textContent = model;
          modelSelect.appendChild(option);
        }
      } catch (error) {
        const option = document.createElement("option");
        option.textContent = "（サーバーに接続できません）";
        modelSelect.appendChild(option);
        this.ui.onError(error);
      }
    };
    serverSelect.addEventListener("change", () => void loadModels());
    void loadModels();

    const taskRow = el("label", { className: "conn-field" });
    taskRow.appendChild(el("span", { className: "conn-field-name", text: "依頼" }));
    const taskInput = document.createElement("input");
    taskInput.type = "text";
    taskInput.placeholder = "例: raw/ の議事録を wiki/ に整理して";
    taskRow.appendChild(taskInput);
    controls.appendChild(taskRow);

    body.appendChild(controls);

    const run = el("button", {
      className: "btn btn-primary",
      text: this.running ? "実行中…" : "実行",
    });
    run.type = "button";
    (run as HTMLButtonElement).disabled = this.running;
    run.addEventListener("click", () => {
      void this.runAgent(serverSelect.value, modelSelect.value, taskInput.value);
    });

    const actions = el("div", { className: "conn-actions" });
    actions.appendChild(run);
    body.appendChild(actions);

    if (this.steps.length) body.appendChild(this.transcript());
  }

  /** Show what the agent did, so its token spend is visible rather than implied. */
  private transcript(): HTMLElement {
    const list = el("div", { className: "agent-log" });

    for (const step of this.steps) {
      if (step.kind === "tool") {
        const item = el("div", { className: `agent-step${step.isError ? " error" : ""}` });
        item.appendChild(el("span", { className: "agent-tool", text: step.name ?? "" }));
        item.appendChild(
          el("span", {
            className: "agent-args",
            text: JSON.stringify(step.arguments ?? {}).slice(0, 120),
          })
        );
        list.appendChild(item);
      } else {
        list.appendChild(el("div", { className: "agent-answer", text: step.text ?? "" }));
      }
    }

    return list;
  }

  private async runAgent(serverId: string, model: string, task: string): Promise<void> {
    if (!task.trim() || this.running) return;

    this.running = true;
    this.steps = [];
    this.renderAgent();

    try {
      const result = await this.ui.runLocalAgent(serverId, model, task.trim());
      this.ui.onNotice(
        `完了（${result.rounds} ラウンド · ${result.promptTokens + result.completionTokens} tok · ${result.stopReason}）`
      );
    } catch (error) {
      this.ui.onError(error);
    } finally {
      this.running = false;
      this.renderAgent();
    }
  }
}
