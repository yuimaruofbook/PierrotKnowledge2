/**
 * Command palette / quick switcher (Ctrl+P).
 *
 * Jumping to a note by name is the single most-used action in a note app;
 * without it, navigation collapses to clicking through a tree, which stops
 * scaling at a few hundred files.
 */

import { rankByFuzzy } from "../../shared/fuzzy";
import { clear, el } from "../dom";

export interface PaletteItem {
  id: string;
  /** Primary line. */
  label: string;
  /** Secondary line. */
  detail?: string;
  /** Right-aligned tag. */
  badge?: string;
  run: () => void;
}

export interface PaletteOptions {
  root: HTMLElement;
  input: HTMLInputElement;
  list: HTMLElement;
  empty: HTMLElement;
}

export class CommandPalette {
  private items: PaletteItem[] = [];
  private filtered: PaletteItem[] = [];
  private active = 0;
  private open = false;

  constructor(private readonly ui: PaletteOptions) {
    ui.input.addEventListener("input", () => this.refresh());
    ui.input.addEventListener("keydown", (event) => this.onKeyDown(event));
    ui.root.addEventListener("mousedown", (event) => {
      if (event.target === ui.root) this.close();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(items: PaletteItem[], placeholder = "ファイルを検索…"): void {
    this.items = items;
    this.ui.input.placeholder = placeholder;
    this.ui.input.value = "";
    this.ui.root.hidden = false;
    this.open = true;
    this.refresh();
    this.ui.input.focus();
  }

  close(): void {
    this.ui.root.hidden = true;
    this.open = false;
  }

  private onKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        this.close();
        break;
      case "ArrowDown":
        event.preventDefault();
        this.move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.move(-1);
        break;
      case "Enter": {
        event.preventDefault();
        const item = this.filtered[this.active];
        if (item) {
          this.close();
          item.run();
        }
        break;
      }
    }
  }

  private move(delta: number): void {
    if (this.filtered.length === 0) return;
    this.active = (this.active + delta + this.filtered.length) % this.filtered.length;
    this.render();
    this.ui.list.children[this.active]?.scrollIntoView({ block: "nearest" });
  }

  private refresh(): void {
    const query = this.ui.input.value.trim();

    this.filtered = rankByFuzzy(this.items, query, (item) => [item.label, item.detail ?? ""]);

    this.active = 0;
    this.render();
  }

  private render(): void {
    clear(this.ui.list);
    this.ui.empty.hidden = this.filtered.length > 0;

    this.filtered.forEach((item, index) => {
      const row = el("li", { className: `palette-item${index === this.active ? " active" : ""}` });
      row.appendChild(el("span", { className: "palette-label", text: item.label }));
      if (item.detail) {
        row.appendChild(el("span", { className: "palette-detail", text: item.detail }));
      }
      if (item.badge) {
        row.appendChild(el("span", { className: "badge", text: item.badge }));
      }
      // mousedown, not click: the input's blur would otherwise close the
      // palette before the click lands.
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.close();
        item.run();
      });
      this.ui.list.appendChild(row);
    });
  }
}
