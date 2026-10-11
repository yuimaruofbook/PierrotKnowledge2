/**
 * The rendered face of a `.base` file: tabs per view, a table or cards
 * layout, group headers and a summary row.
 *
 * Nothing is computed here. The Bun side runs the view (`baseView`) and this
 * only draws what came back, so the table a person sees is the one an agent
 * gets from `base_query`.
 */

import type { BaseGroup, BaseResult, BaseResultRow, BaseSummary, BaseViewResponse } from "../../shared/okf/base";
import { clear, el } from "../dom";
import { errorMessage } from "../../shared/errors";

export interface BaseViewOptions {
  /** Run one view of a base; without a name, the first. */
  run: (path: string, view?: string) => Promise<BaseViewResponse>;
  /** Open a concept (a bundle-relative path). */
  openConcept: (path: string) => void;
  /** Switch the pane to the raw YAML. */
  editSource: () => void;
}

const SUPPORTED = new Set(["table", "cards"]);

export class BaseView {
  /** The tab last chosen for each base, so coming back lands where you were. */
  private readonly chosen = new Map<string, string>();
  /** Ignores a slow answer that arrives after the person has moved on. */
  private generation = 0;

  constructor(private readonly options: BaseViewOptions) {}

  async show(root: HTMLElement, path: string): Promise<void> {
    const generation = ++this.generation;
    root.classList.add("base-root");

    const attempt = async (view: string | undefined): Promise<BaseViewResponse> => {
      try {
        return await this.options.run(path, view);
      } catch (error) {
        return { views: [], error: errorMessage(error) };
      }
    };
    const remembered = this.chosen.get(path);
    let response = await attempt(remembered);
    // The file was edited since: a tab that no longer exists falls back to the first view.
    if (remembered !== undefined && response.views.length > 0 && !response.views.some((v) => v.name === remembered)) {
      this.chosen.delete(path);
      response = await attempt(undefined);
    }
    if (generation !== this.generation) return;

    clear(root);
    root.appendChild(this.toolbar(root, path, response));
    root.appendChild(response.error !== undefined ? this.errorPanel(response.error) : this.body(response.result!));
  }

  private toolbar(root: HTMLElement, path: string, response: BaseViewResponse): HTMLElement {
    const bar = el("div", { className: "base-toolbar" });
    const tabs = el("div", { className: "segmented base-tabs" });
    tabs.setAttribute("role", "tablist");

    const active = response.result?.view ?? this.chosen.get(path);
    for (const view of response.views) {
      const supported = SUPPORTED.has(view.type);
      const tab = el("button", {
        text: view.name,
        title: supported ? `${view.type}` : `${view.type}（未対応のレイアウト）`,
      });
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.disabled = !supported;
      const selected = view.name === active;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.addEventListener("click", () => {
        this.chosen.set(path, view.name);
        void this.show(root, path);
      });
      tabs.appendChild(tab);
    }
    bar.appendChild(tabs);
    bar.appendChild(el("span", { className: "spacer" }));

    const result = response.result;
    if (result) {
      bar.appendChild(
        el("span", {
          className: "base-count",
          text: `${result.shown} / ${result.total} 件`,
          title: result.shown < result.total ? "表示上限で切り詰められています" : "",
        })
      );
    }

    const edit = el("button", { className: "btn", text: "YAML を編集", title: "この base のソースを編集する" });
    edit.type = "button";
    edit.addEventListener("click", () => this.options.editSource());
    bar.appendChild(edit);
    return bar;
  }

  private errorPanel(message: string): HTMLElement {
    const panel = el("div", { className: "base-error" });
    panel.appendChild(el("div", { className: "notice-title", text: "この base を表示できません" }));
    panel.appendChild(el("div", { className: "notice-detail", text: message }));
    panel.appendChild(el("div", { className: "notice-hint", text: "「YAML を編集」で内容を直してください。" }));
    return panel;
  }

  private body(result: BaseResult): HTMLElement {
    const wrap = el("div", { className: "base-body" });
    if (result.shown === 0) {
      wrap.appendChild(el("div", { className: "empty", text: "一致する概念がありません" }));
    } else if (result.type === "cards") {
      wrap.appendChild(this.cards(result));
    } else {
      wrap.appendChild(this.table(result));
    }

    if (result.warnings?.length) {
      const details = el("details", { className: "base-warnings" });
      details.appendChild(el("summary", { text: `警告 ${result.warnings.length} 件` }));
      const list = el("ul");
      for (const warning of result.warnings) list.appendChild(el("li", { text: warning }));
      details.appendChild(list);
      wrap.appendChild(details);
    }
    return wrap;
  }

  // ---- table ----

  private table(result: BaseResult): HTMLElement {
    const table = el("table", { className: "base-table" });
    const head = el("thead");
    const headRow = el("tr");
    for (const column of result.columns) headRow.appendChild(el("th", { text: column.name, title: column.id }));
    head.appendChild(headRow);
    table.appendChild(head);

    const span = result.columns.length;
    if (result.groups) {
      for (const group of result.groups) table.appendChild(this.groupBody(result, group, span));
    } else {
      const body = el("tbody");
      for (const row of result.rows ?? []) body.appendChild(this.tableRow(row));
      table.appendChild(body);
    }

    const summary = this.summaryRow(result, result.summaries);
    if (summary) {
      const foot = el("tfoot");
      foot.appendChild(summary);
      table.appendChild(foot);
    }
    return table;
  }

  private groupBody(result: BaseResult, group: BaseGroup, span: number): HTMLElement {
    const body = el("tbody", { className: "base-group" });
    const header = el("tr", { className: "base-group-row" });
    const cell = el("th");
    cell.colSpan = span;
    cell.tabIndex = 0;
    cell.appendChild(el("span", { className: "base-group-caret", text: "▾" }));
    cell.appendChild(el("span", { className: "base-group-label", text: group.label }));
    cell.appendChild(el("span", { className: "base-group-count", text: countText(group), title: truncatedTitle(group) }));
    const toggle = () => {
      const collapsed = body.classList.toggle("collapsed");
      cell.setAttribute("aria-expanded", String(!collapsed));
    };
    cell.setAttribute("aria-expanded", "true");
    cell.addEventListener("click", toggle);
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    header.appendChild(cell);
    body.appendChild(header);

    for (const row of group.rows) body.appendChild(this.tableRow(row));
    const summary = this.summaryRow(result, group.summaries);
    if (summary) body.appendChild(summary);
    return body;
  }

  private tableRow(row: BaseResultRow): HTMLElement {
    const tr = el("tr", { className: "base-row", title: row.path });
    tr.tabIndex = 0;
    for (const value of row.cells) {
      const td = el("td");
      if (typeof value === "number") td.classList.add("num");
      renderValue(td, value);
      tr.appendChild(td);
    }
    this.makeOpenable(tr, row.path);
    return tr;
  }

  private summaryRow(result: BaseResult, summaries: BaseSummary[]): HTMLElement | null {
    if (summaries.length === 0) return null;
    const tr = el("tr", { className: "base-summary" });
    for (const column of result.columns) {
      const td = el("td");
      const hit = summaries.find((s) => s.column === column.id);
      if (hit) {
        td.appendChild(el("span", { className: "base-sum-name", text: hit.summary }));
        const value = el("span", { className: "base-sum-value" });
        renderValue(value, hit.value);
        td.appendChild(value);
      }
      tr.appendChild(td);
    }
    return tr;
  }

  // ---- cards ----

  private cards(result: BaseResult): HTMLElement {
    const root = el("div", { className: "base-cards-root" });
    const grid = (rows: BaseResultRow[]): HTMLElement => {
      const list = el("div", { className: "base-cards" });
      for (const row of rows) list.appendChild(this.card(result, row));
      return list;
    };

    if (result.groups) {
      for (const group of result.groups) {
        const section = el("section", { className: "base-card-group" });
        const heading = el("h3", { className: "base-card-group-head" });
        heading.appendChild(el("span", { text: group.label }));
        heading.appendChild(el("span", { className: "base-group-count", text: countText(group), title: truncatedTitle(group) }));
        section.appendChild(heading);
        section.appendChild(grid(group.rows));
        const line = this.summaryLine(result, group.summaries);
        if (line) section.appendChild(line);
        root.appendChild(section);
      }
    } else {
      root.appendChild(grid(result.rows ?? []));
    }
    const line = this.summaryLine(result, result.summaries);
    if (line) root.appendChild(line);
    return root;
  }

  private card(result: BaseResult, row: BaseResultRow): HTMLElement {
    const card = el("article", { className: "base-card", title: row.path });
    card.tabIndex = 0;
    // The first column is the card's title; the rest are its facts.
    const title = el("div", { className: "base-card-title" });
    renderValue(title, row.cells[0] ?? null);
    if (!title.textContent) title.textContent = row.path;
    card.appendChild(title);

    const facts = el("dl", { className: "base-card-facts" });
    result.columns.slice(1).forEach((column, i) => {
      const value = row.cells[i + 1] ?? null;
      if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return;
      facts.appendChild(el("dt", { text: column.name }));
      const dd = el("dd");
      renderValue(dd, value);
      facts.appendChild(dd);
    });
    card.appendChild(facts);
    this.makeOpenable(card, row.path);
    return card;
  }

  private summaryLine(result: BaseResult, summaries: BaseSummary[]): HTMLElement | null {
    if (summaries.length === 0) return null;
    const names = new Map(result.columns.map((c) => [c.id, c.name]));
    const line = el("div", { className: "base-summary-line" });
    for (const s of summaries) {
      const item = el("span", { className: "base-summary-item" });
      item.appendChild(el("span", { className: "base-sum-name", text: `${names.get(s.column) ?? s.column} ${s.summary}` }));
      const value = el("span", { className: "base-sum-value" });
      renderValue(value, s.value);
      item.appendChild(value);
      line.appendChild(item);
    }
    return line;
  }

  private makeOpenable(node: HTMLElement, path: string): void {
    node.addEventListener("click", () => this.options.openConcept(path));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.options.openConcept(path);
    });
  }
}

/** A group's size; when the row cap cut its rows short, how many are listed. */
function countText(group: BaseGroup): string {
  return group.truncated ? `${group.rows.length} / ${group.count}` : String(group.count);
}

function truncatedTitle(group: BaseGroup): string {
  return group.truncated ? "表示上限のため、このグループの行は一部のみ表示しています" : "";
}

/** One cell's value: text, chips for a list, a tick for a boolean. Never HTML. */
function renderValue(target: HTMLElement, value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      const chip = el("span", { className: "base-chip" });
      renderValue(chip, item);
      target.appendChild(chip);
    }
    return;
  }
  if (typeof value === "boolean") {
    target.textContent = value ? "✓" : "✗";
    target.classList.add("base-bool");
    return;
  }
  if (typeof value === "object") {
    target.textContent = JSON.stringify(value);
    return;
  }
  target.textContent = String(value);
}
