/**
 * File tree.
 *
 * Children are fetched lazily on expand, so opening a vault with thousands of
 * notes costs one directory read rather than a full recursive walk.
 */

import type { FileNode } from "../../shared/types";
import { clear, el } from "../dom";

export interface TreeOptions {
  container: HTMLElement;
  listDir: (path: string) => Promise<FileNode[]>;
  onSelectFile: (path: string) => void;
  /** Right-click / long-press actions on a node. */
  onContextMenu?: (node: FileNode, at: { x: number; y: number }) => void;
  /** Drop a node onto a directory. */
  onMove?: (from: string, toDir: string) => void;
}

export class FileTree {
  private selected: string | null = null;
  private expanded = new Set<string>();

  constructor(private readonly options: TreeOptions) {}

  async refresh(): Promise<void> {
    const nodes = await this.options.listDir("");
    clear(this.options.container);
    await this.renderInto(this.options.container, nodes);
  }

  /** Highlight a path without triggering a load. */
  select(path: string | null): void {
    this.selected = path;
    for (const item of Array.from(this.options.container.querySelectorAll<HTMLElement>(".node"))) {
      item.classList.toggle("selected", item.dataset.path === path);
    }
  }

  private async renderInto(parent: HTMLElement, nodes: FileNode[]): Promise<void> {
    for (const node of nodes) {
      const item = el("li", { className: "tree-item" });
      const row = el("div", {
        className: `node ${node.type}${node.layer ? ` layer-${node.layer}` : ""}`,
        text: node.name,
        dataset: { path: node.path, type: node.type },
      });
      if (node.path === this.selected) row.classList.add("selected");
      if (node.layer) row.title = `${node.path} · layer: ${node.layer}`;

      item.appendChild(row);
      parent.appendChild(item);

      if (this.options.onContextMenu) {
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.options.onContextMenu?.(node, { x: event.clientX, y: event.clientY });
        });
      }

      // Layer 1 and 3 are read-only, so dragging out of them is disallowed
      // rather than left to fail at the write.
      const movable = node.layer !== "raw" && node.layer !== "rag";
      if (this.options.onMove && movable) {
        row.draggable = true;
        row.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData("text/okf-path", node.path);
          event.dataTransfer?.setData("text/plain", node.path);
        });
      }

      if (node.type === "file") {
        row.addEventListener("click", () => this.options.onSelectFile(node.path));
        continue;
      }

      if (this.options.onMove && movable) {
        row.addEventListener("dragover", (event) => {
          if (!event.dataTransfer?.types.includes("text/okf-path")) return;
          event.preventDefault();
          row.classList.add("drop-target");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          row.classList.remove("drop-target");
          const from = event.dataTransfer?.getData("text/okf-path");
          if (from && from !== node.path) this.options.onMove?.(from, node.path);
        });
      }

      const children = el("ul", { className: "tree" });
      children.hidden = true;
      item.appendChild(children);

      row.addEventListener("click", async () => {
        const isOpen = !children.hidden;
        children.hidden = isOpen;
        row.classList.toggle("open", !isOpen);
        if (isOpen) {
          this.expanded.delete(node.path);
          return;
        }
        this.expanded.add(node.path);
        if (children.childElementCount === 0) {
          await this.renderInto(children, await this.options.listDir(node.path));
        }
      });

      // Restore expansion across refreshes so a watcher event does not
      // collapse the tree the user is working in.
      if (this.expanded.has(node.path)) {
        children.hidden = false;
        row.classList.add("open");
        await this.renderInto(children, await this.options.listDir(node.path));
      }
    }
  }
}
