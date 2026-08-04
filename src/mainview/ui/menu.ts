/**
 * A small context menu.
 *
 * Right-click on a file is where rename, move and delete belong in a note app;
 * putting them only behind a command palette hides the operations people reach
 * for while looking at the tree.
 */

import { clear, el } from "../dom";

export interface MenuEntry {
  label: string;
  danger?: boolean;
  run: () => void;
}

export class ContextMenu {
  private onDismiss: (() => void) | null = null;

  constructor(private readonly root: HTMLElement) {
    // Capture phase: dismiss before the click reaches whatever is underneath.
    document.addEventListener("mousedown", (event) => {
      if (!this.root.hidden && !this.root.contains(event.target as Node)) this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
    window.addEventListener("blur", () => this.close());
  }

  open(entries: MenuEntry[], at: { x: number; y: number }): void {
    clear(this.root);

    for (const entry of entries) {
      const item = el("button", {
        className: `menu-item${entry.danger ? " danger" : ""}`,
        text: entry.label,
      });
      item.type = "button";
      item.addEventListener("click", () => {
        this.close();
        entry.run();
      });
      this.root.appendChild(item);
    }

    this.root.hidden = false;

    // Position after unhiding so the measured size is real, then keep the menu
    // inside the window.
    const rect = this.root.getBoundingClientRect();
    const x = Math.min(at.x, window.innerWidth - rect.width - 8);
    const y = Math.min(at.y, window.innerHeight - rect.height - 8);
    this.root.style.left = `${Math.max(4, x)}px`;
    this.root.style.top = `${Math.max(4, y)}px`;
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.onDismiss?.();
  }
}
