/**
 * The interactive face of a `.canvas` file (JSON Canvas 1.0).
 *
 * Dependency-free: SVG for the world (nodes, edges, arrows, labels), HTML in a
 * `foreignObject` for the text inside a node so it wraps and renders Markdown
 * like the rest of the app.
 *
 * The canvas lives in the editor's text buffer, not on disk: every change
 * serialises the whole canvas back into the buffer (`onChange`), which marks
 * the file dirty and saves it through the normal write path. Because the model
 * is the parsed file itself, keys this view does not use and the order of nodes
 * and edges survive an edit.
 *
 * What you can do:
 *   - pan (drag the background or middle button), zoom (wheel, + / -, 0 to fit)
 *   - select (click; shift adds), move (drag), resize (corner handles),
 *     delete (Delete / Backspace), undo and redo (Ctrl+Z / Ctrl+Shift+Z)
 *   - add a text node (double-click the background, or the toolbar) and a file
 *     node (toolbar: pick a concept); edit text (double-click a text node)
 *   - connect: drag from a dot on a selected node's side to another node
 *   - open a file node's concept by clicking its body; the top bar of a node
 *     selects it without opening anything
 */

import {
  describeCanvasErrors,
  groupParents,
  parseCanvas,
  type Canvas,
  type CanvasEdge,
  type CanvasParse,
  type CanvasNode,
  type CanvasSide,
} from "../../shared/okf/canvas";
import {
  PRESET_COLOR_NAMES,
  anchorPoint,
  arrowHead,
  boundsOf,
  edgeGeometry,
  fitView,
  freshId,
  heldByAny,
  sideFacing,
  stringifyCanvas,
  zoomAt,
  type Rect,
  type View,
} from "../../shared/okf/canvas-geometry";
import { clear, el } from "../dom";
import { renderMarkdown } from "../markdown";

export interface CanvasViewOptions {
  /** What a file node's `file` points at, when it is a concept. */
  resolveFile: (file: string) => { title: string; description?: string } | null;
  /** The canvas changed: here is its new text. */
  onChange: (path: string, text: string) => void;
  /** Open a concept (a bundle-relative path). */
  openConcept: (path: string) => void;
  openUrl: (url: string) => void;
  /** Ask which concept to add as a file node: its bundle-relative path, or null. */
  pickConcept: () => Promise<string | null>;
  /** Switch the pane to the raw JSON. */
  editSource: () => void;
  /** Start the "make a relationship diagram" flow. */
  makeDiagram: () => void;
}

const NS = "http://www.w3.org/2000/svg";
const MIN_W = 60;
const MIN_H = 40;
const TEXT_W = 260;
const TEXT_H = 100;
const FILE_W = 280;
const FILE_H = 96;
const BAR_H = 22;
const HISTORY = 60;
/** Text nodes longer than this are shown as plain text: rendering Markdown for hundreds of them is not worth it. */
const MARKDOWN_MAX = 4000;
const PRESETS = ["1", "2", "3", "4", "5", "6"];

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  className?: string
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute("class", className);
  return node;
}

/** A canvas colour as CSS: a preset becomes a theme variable, a hex value stays. */
function cssColor(color: unknown): string | undefined {
  if (typeof color !== "string") return undefined;
  if (/^[1-6]$/.test(color)) return `var(--cv-c${color})`;
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : undefined;
}

const rectOf = (n: CanvasNode): Rect => ({ x: n.x, y: n.y, width: n.width, height: n.height });

type Gesture =
  | { kind: "pan"; sx: number; sy: number; view: View; moved: boolean }
  | {
      kind: "drag";
      id: string;
      sx: number;
      sy: number;
      moved: boolean;
      handle: boolean;
      origins: Map<string, { x: number; y: number }>;
    }
  | { kind: "resize"; id: string; corner: string; start: Rect; wx: number; wy: number }
  | { kind: "connect"; from: string; side: CanvasSide; wx: number; wy: number; line: SVGPathElement };

/** One open canvas: its model, its view and the elements that draw it. */
class CanvasSession {
  private canvas: Canvas;
  private view: View = { x: 0, y: 0, k: 1 };
  private selected = new Set<string>();
  private selectedEdge: string | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private gesture: Gesture | null = null;
  private editor: HTMLElement | null = null;

  private readonly svgEl: SVGSVGElement;
  private readonly world: SVGGElement;
  private readonly groupLayer: SVGGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly overlayLayer: SVGGElement;
  private readonly stage: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly countLabel: HTMLElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly swatches: HTMLElement;
  private nodeEls = new Map<string, SVGGElement>();
  private edgeEls = new Map<string, SVGGElement>();

  constructor(
    root: HTMLElement,
    private readonly path: string,
    canvas: Canvas,
    private readonly options: CanvasViewOptions,
    private readonly remember: (view: View) => void,
    initial: View | undefined
  ) {
    this.canvas = canvas;
    clear(root);
    root.classList.remove("base-root");
    root.classList.add("canvas-root");

    // ---- toolbar
    const bar = el("div", { className: "cv-toolbar" });
    const button = (label: string, title: string, run: () => void, className = "btn"): HTMLButtonElement => {
      const b = el("button", { className, text: label, title });
      b.type = "button";
      b.addEventListener("click", run);
      return b;
    };
    bar.appendChild(button("＋ テキスト", "テキストノードを追加（背景をダブルクリックでも）", () => this.addTextNode()));
    bar.appendChild(button("＋ ファイル", "概念をファイルノードとして追加", () => void this.addFileNode()));
    this.deleteButton = button("削除", "選択を削除 (Delete)", () => this.deleteSelection());
    bar.appendChild(this.deleteButton);
    this.swatches = el("div", { className: "cv-swatches" });
    this.swatches.setAttribute("role", "group");
    this.swatches.setAttribute("aria-label", "色");
    const none = el("button", { className: "cv-swatch cv-swatch-none", title: "色なし" });
    none.type = "button";
    none.addEventListener("click", () => this.setColor(undefined));
    this.swatches.appendChild(none);
    for (const preset of PRESETS) {
      const sw = el("button", { className: "cv-swatch", title: PRESET_COLOR_NAMES[preset] ?? preset });
      sw.type = "button";
      sw.style.background = `var(--cv-c${preset})`;
      sw.addEventListener("click", () => this.setColor(preset));
      this.swatches.appendChild(sw);
    }
    bar.appendChild(this.swatches);
    bar.appendChild(el("span", { className: "spacer" }));
    this.countLabel = el("span", { className: "base-count" });
    bar.appendChild(this.countLabel);
    bar.appendChild(button("−", "縮小 (-)", () => this.zoomBy(1 / 1.25), "btn cv-zoom"));
    this.zoomLabel = el("span", { className: "cv-zoom-label" });
    bar.appendChild(this.zoomLabel);
    bar.appendChild(button("＋", "拡大 (+)", () => this.zoomBy(1.25), "btn cv-zoom"));
    bar.appendChild(button("全体", "全体を表示 (0)", () => this.fit()));
    bar.appendChild(button("関係図を作る", "概念のまわりのリンクから関係図を作る", () => this.options.makeDiagram()));
    bar.appendChild(button("JSON を編集", "この canvas のソース（JSON）を編集する", () => this.options.editSource()));
    root.appendChild(bar);

    // ---- stage
    this.stage = el("div", { className: "cv-stage" });
    this.stage.tabIndex = 0;
    this.stage.setAttribute("aria-label", "キャンバス");
    this.svgEl = svg("svg", {}, "cv-svg");
    this.world = svg("g", {}, "cv-world");
    this.groupLayer = svg("g", {}, "cv-layer");
    this.edgeLayer = svg("g", {}, "cv-layer");
    this.nodeLayer = svg("g", {}, "cv-layer");
    this.overlayLayer = svg("g", {}, "cv-layer");
    this.world.append(this.groupLayer, this.edgeLayer, this.nodeLayer, this.overlayLayer);
    this.svgEl.appendChild(this.world);
    this.stage.appendChild(this.svgEl);
    this.hint = el("div", {
      className: "cv-hint",
      text: "背景をダブルクリックでテキストを追加 · 「＋ ファイル」で概念を追加 · 選んだノードの端の点から別のノードへドラッグでつなぐ",
    });
    this.stage.appendChild(this.hint);
    root.appendChild(this.stage);

    this.wire();
    this.renderAll();

    const rect = this.stage.getBoundingClientRect();
    this.view = initial ?? fitView(boundsOf((this.canvas.nodes ?? []).map(rectOf)), rect.width || 800, rect.height || 560);
    this.applyView();
    this.refreshChrome();
  }

  // ---- model ------------------------------------------------------------------

  private get nodes(): CanvasNode[] {
    if (!Array.isArray(this.canvas.nodes)) this.canvas.nodes = [];
    return this.canvas.nodes;
  }

  private get edges(): CanvasEdge[] {
    if (!Array.isArray(this.canvas.edges)) this.canvas.edges = [];
    return this.canvas.edges;
  }

  private nodeById(id: string): CanvasNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  private usedIds(): Set<string> {
    return new Set([...this.nodes.map((n) => n.id), ...this.edges.map((e) => e.id)]);
  }

  /** The canvas changed: remember the step for undo and hand the text to the editor. */
  private commit(): void {
    const text = stringifyCanvas(this.canvas);
    this.undoStack.push(this.snapshot);
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.snapshot = text;
    this.options.onChange(this.path, text);
    this.refreshChrome();
  }

  private snapshot = "";

  /** Take the text the file had when it was opened as the first undo state. */
  begin(text: string): void {
    this.snapshot = text;
  }

  private restore(text: string): void {
    const parsed = parseCanvas(text);
    if (!parsed.ok) return;
    this.canvas = parsed.value;
    this.snapshot = text;
    this.selected.clear();
    this.selectedEdge = null;
    this.renderAll();
    this.options.onChange(this.path, text);
    this.refreshChrome();
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (previous === undefined) return;
    this.redoStack.push(this.snapshot);
    this.restore(previous);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.snapshot);
    this.restore(next);
  }

  // ---- view -------------------------------------------------------------------

  private applyView(): void {
    this.world.setAttribute("transform", `translate(${this.view.x} ${this.view.y}) scale(${this.view.k})`);
    this.zoomLabel.textContent = `${Math.round(this.view.k * 100)}%`;
    this.remember({ ...this.view });
  }

  private fit(): void {
    const rect = this.stage.getBoundingClientRect();
    this.view = fitView(boundsOf(this.nodes.map(rectOf)), rect.width, rect.height);
    this.applyView();
  }

  private zoomBy(factor: number): void {
    const rect = this.stage.getBoundingClientRect();
    this.view = zoomAt(this.view, factor, rect.width / 2, rect.height / 2);
    this.applyView();
  }

  private toWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.stage.getBoundingClientRect();
    return [(clientX - rect.left - this.view.x) / this.view.k, (clientY - rect.top - this.view.y) / this.view.k];
  }

  private toScreen(x: number, y: number): [number, number] {
    return [x * this.view.k + this.view.x, y * this.view.k + this.view.y];
  }

  private centre(): [number, number] {
    const rect = this.stage.getBoundingClientRect();
    return this.toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  // ---- drawing ----------------------------------------------------------------

  private refreshChrome(): void {
    const n = this.nodes.length;
    const e = this.edges.length;
    this.countLabel.textContent = `${n} ノード / ${e} エッジ`;
    this.hint.hidden = n > 0;
    const any = this.selected.size > 0 || this.selectedEdge !== null;
    this.deleteButton.disabled = !any;
    this.swatches.classList.toggle("disabled", !any);
    for (const b of Array.from(this.swatches.querySelectorAll("button"))) b.disabled = !any;
  }

  private renderAll(): void {
    clear(this.groupLayer);
    clear(this.edgeLayer);
    clear(this.nodeLayer);
    clear(this.overlayLayer);
    this.nodeEls.clear();
    this.edgeEls.clear();
    // Groups sit at the bottom, then edges, then the rest in file order: the spec stacks by order.
    for (const node of this.nodes) if (node.type === "group") this.drawNode(node);
    for (const edge of this.edges) this.drawEdge(edge);
    for (const node of this.nodes) if (node.type !== "group") this.drawNode(node);
    this.paintSelection();
  }

  private drawNode(node: CanvasNode): void {
    this.nodeEls.get(node.id)?.remove();
    const g = svg("g", {}, `cv-node cv-${node.type}`);
    g.dataset.id = node.id;
    const color = cssColor(node.color);
    if (color) g.style.setProperty("--node-color", color);

    const box = svg("rect", { rx: 0 }, "cv-box");
    g.appendChild(box);

    if (node.type === "group") {
      const bar = svg("rect", {}, "cv-handle cv-group-bar");
      g.appendChild(bar);
      const label = svg("text", { x: 12, y: 17 }, "cv-group-label");
      label.textContent = typeof node.label === "string" ? node.label : "";
      g.appendChild(label);
    } else {
      const fo = svg("foreignObject", {}, "cv-fo");
      const body = document.createElement("div");
      body.className = "cv-body";
      fo.appendChild(body);
      g.appendChild(fo);
      this.fillBody(node, body);
      if (node.type !== "text") g.appendChild(svg("rect", {}, "cv-handle cv-bar"));
    }

    // Selection chrome, shown by CSS when the node is selected.
    g.appendChild(svg("rect", {}, "cv-sel"));
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const h = svg("rect", { width: 10, height: 10 }, "cv-resize");
      h.dataset.resize = corner;
      g.appendChild(h);
    }
    for (const side of ["top", "right", "bottom", "left"]) {
      const p = svg("circle", { r: 6 }, "cv-port");
      p.dataset.port = side;
      g.appendChild(p);
    }

    this.nodeEls.set(node.id, g);
    (node.type === "group" ? this.groupLayer : this.nodeLayer).appendChild(g);
    this.layoutNode(node);
  }

  /** Put the content of a text, file or link node into its body. */
  private fillBody(node: CanvasNode, body: HTMLElement): void {
    clear(body);
    if (node.type === "text") {
      const text = String(node.text ?? "");
      if (text.length > MARKDOWN_MAX) body.textContent = text;
      else body.appendChild(renderMarkdown(text));
      return;
    }
    if (node.type === "file") {
      const file = String(node.file ?? "");
      const found = this.options.resolveFile(file);
      body.appendChild(el("div", { className: "cv-file-title", text: found ? found.title : file.split("/").pop() ?? file }));
      if (found?.description) body.appendChild(el("div", { className: "cv-file-desc", text: found.description }));
      if (!found) body.appendChild(el("div", { className: "cv-file-desc", text: file }));
      return;
    }
    body.appendChild(el("div", { className: "cv-link-url", text: String(node.url ?? "") }));
  }

  /** Size and place one node's elements. Cheap: used while dragging and resizing. */
  private layoutNode(node: CanvasNode): void {
    const g = this.nodeEls.get(node.id);
    if (!g) return;
    const { width: w, height: h } = node;
    g.setAttribute("transform", `translate(${node.x} ${node.y})`);
    const set = (selector: string, attrs: Record<string, number>) => {
      const target = g.querySelector(selector);
      if (target) for (const [k, v] of Object.entries(attrs)) target.setAttribute(k, String(v));
    };
    set(".cv-box", { width: w, height: h });
    set(".cv-sel", { width: w, height: h });
    set(".cv-group-bar", { width: w, height: BAR_H + 6 });
    set(".cv-bar", { width: w, height: BAR_H });
    const hasBar = node.type === "file" || node.type === "link";
    set(".cv-fo", { x: 0, y: hasBar ? BAR_H : 0, width: w, height: Math.max(0, h - (hasBar ? BAR_H : 0)) });
    const corners: Record<string, [number, number]> = { nw: [0, 0], ne: [w, 0], sw: [0, h], se: [w, h] };
    for (const [corner, [cx, cy]] of Object.entries(corners)) set(`[data-resize="${corner}"]`, { x: cx - 5, y: cy - 5 });
    const ports: Record<string, [number, number]> = { top: [w / 2, 0], right: [w, h / 2], bottom: [w / 2, h], left: [0, h / 2] };
    for (const [side, [px, py]] of Object.entries(ports)) set(`[data-port="${side}"]`, { cx: px, cy: py });
    if (hasBar) {
      const bar = g.querySelector(".cv-bar");
      if (bar && !bar.nextElementSibling?.classList.contains("cv-bar-label")) {
        const label = svg("text", { x: 10, y: 15 }, "cv-bar-label");
        label.textContent = node.type === "file" ? String(node.file ?? "") : "リンク";
        bar.after(label);
      }
    }
  }

  private drawEdge(edge: CanvasEdge): void {
    this.edgeEls.get(edge.id)?.remove();
    const from = this.nodeById(edge.fromNode);
    const to = this.nodeById(edge.toNode);
    if (!from || !to) return;
    const geo = edgeGeometry(edge, rectOf(from), rectOf(to));
    const g = svg("g", {}, "cv-edge");
    g.dataset.id = edge.id;
    const color = cssColor(edge.color);
    if (color) g.style.setProperty("--edge-color", color);

    g.appendChild(svg("path", { d: geo.d }, "cv-edge-line"));
    g.appendChild(svg("path", { d: geo.d }, "cv-edge-hit"));
    if (edge.toEnd !== "none") g.appendChild(svg("polygon", { points: arrowHead(geo.to, geo.toSide) }, "cv-arrow"));
    if (edge.fromEnd === "arrow") g.appendChild(svg("polygon", { points: arrowHead(geo.from, geo.fromSide) }, "cv-arrow"));
    if (typeof edge.label === "string" && edge.label !== "") {
      const label = svg("text", { x: geo.mid[0], y: geo.mid[1], "text-anchor": "middle", "dominant-baseline": "central" }, "cv-edge-label");
      label.textContent = edge.label;
      g.appendChild(label);
    }
    this.edgeEls.set(edge.id, g);
    this.edgeLayer.appendChild(g);
    g.classList.toggle("selected", this.selectedEdge === edge.id);
  }

  private redrawEdgesOf(ids: ReadonlySet<string>): void {
    for (const edge of this.edges) if (ids.has(edge.fromNode) || ids.has(edge.toNode)) this.drawEdge(edge);
  }

  private paintSelection(): void {
    for (const [id, g] of this.nodeEls) g.classList.toggle("selected", this.selected.has(id));
    // Resize handles and ports only for a lone selection: with several, they would not say which one moves.
    const lone = this.selected.size === 1 ? [...this.selected][0] : undefined;
    for (const [id, g] of this.nodeEls) g.classList.toggle("lone", id === lone);
    for (const [id, g] of this.edgeEls) g.classList.toggle("selected", this.selectedEdge === id);
    this.refreshChrome();
  }

  private select(ids: Iterable<string>, edge: string | null = null): void {
    this.selected = new Set(ids);
    this.selectedEdge = edge;
    this.paintSelection();
  }

  // ---- editing ----------------------------------------------------------------

  private newNodeId(): string {
    return freshId(this.usedIds());
  }

  private addNode(node: CanvasNode): void {
    this.nodes.push(node);
    this.drawNode(node);
    this.select([node.id]);
    this.commit();
  }

  private addTextNode(at?: [number, number]): void {
    const [cx, cy] = at ?? this.centre();
    const node: CanvasNode = {
      id: this.newNodeId(),
      type: "text",
      text: "",
      x: Math.round(cx - TEXT_W / 2),
      y: Math.round(cy - TEXT_H / 2),
      width: TEXT_W,
      height: TEXT_H,
    };
    this.addNode(node);
    this.startEdit({ kind: "node", id: node.id });
  }

  private async addFileNode(): Promise<void> {
    const file = await this.options.pickConcept();
    if (!file) return;
    const [cx, cy] = this.centre();
    this.addNode({
      id: this.newNodeId(),
      type: "file",
      file,
      x: Math.round(cx - FILE_W / 2),
      y: Math.round(cy - FILE_H / 2),
      width: FILE_W,
      height: FILE_H,
    });
  }

  private deleteSelection(): void {
    if (this.selectedEdge !== null) {
      this.canvas.edges = this.edges.filter((e) => e.id !== this.selectedEdge);
    } else if (this.selected.size > 0) {
      const gone = new Set(this.selected);
      this.canvas.nodes = this.nodes.filter((n) => !gone.has(n.id));
      // An edge cannot outlive an end: the spec requires both to exist.
      this.canvas.edges = this.edges.filter((e) => !gone.has(e.fromNode) && !gone.has(e.toNode));
    } else return;
    this.selected.clear();
    this.selectedEdge = null;
    this.renderAll();
    this.commit();
  }

  private setColor(color: string | undefined): void {
    const targets: Array<CanvasNode | CanvasEdge> = [
      ...this.nodes.filter((n) => this.selected.has(n.id)),
      ...this.edges.filter((e) => e.id === this.selectedEdge),
    ];
    if (targets.length === 0) return;
    for (const t of targets) {
      if (color === undefined) delete t.color;
      else t.color = color;
    }
    this.renderAll();
    this.commit();
  }

  private createEdge(from: string, fromSide: CanvasSide, to: string, toSide: CanvasSide): void {
    const edge: CanvasEdge = { id: this.newNodeId(), fromNode: from, fromSide, toNode: to, toSide };
    this.edges.push(edge);
    this.drawEdge(edge);
    this.select([], edge.id);
    this.commit();
  }

  /**
   * Edit the text of a text node or the label of a group or edge, in place. The
   * target says which it is: a node and an edge may share an id, and looking the
   * id up in nodes first would edit the wrong one.
   */
  private startEdit(target: { kind: "node" | "edge"; id: string }): void {
    this.closeEditor(true);
    const node = target.kind === "node" ? this.nodeById(target.id) : undefined;
    const edge = target.kind === "edge" ? this.edges.find((e) => e.id === target.id) : undefined;
    if (!node && !edge) return;

    let rect: Rect;
    let value: string;
    let multiline: boolean;
    if (node) {
      const textual = node.type === "text";
      if (!textual && node.type !== "group") return;
      rect = textual ? rectOf(node) : { x: node.x, y: node.y, width: Math.min(node.width, 320), height: BAR_H + 6 };
      value = String(textual ? node.text ?? "" : node.label ?? "");
      multiline = textual;
    } else {
      const from = this.nodeById(edge!.fromNode);
      const to = this.nodeById(edge!.toNode);
      if (!from || !to) return;
      const mid = edgeGeometry(edge!, rectOf(from), rectOf(to)).mid;
      rect = { x: mid[0] - 80, y: mid[1] - 14, width: 160, height: 28 };
      value = String(edge!.label ?? "");
      multiline = false;
    }

    const [sx, sy] = this.toScreen(rect.x, rect.y);
    const input = multiline ? document.createElement("textarea") : document.createElement("input");
    input.className = "cv-editor";
    input.value = value;
    input.style.left = `${sx}px`;
    input.style.top = `${sy}px`;
    input.style.width = `${rect.width * this.view.k}px`;
    input.style.height = `${rect.height * this.view.k}px`;
    input.setAttribute("aria-label", node ? (multiline ? "テキスト" : "グループ名") : "ラベル");

    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      this.editor = null;
      const next = input.value;
      input.remove();
      this.stage.focus({ preventScroll: true });
      if (!commit || next === value) return;
      if (node) {
        if (node.type === "text") node.text = next;
        else if (next === "") delete node.label;
        else node.label = next;
        this.drawNode(node);
      } else if (edge) {
        if (next === "") delete edge.label;
        else edge.label = next;
        this.drawEdge(edge);
      }
      this.paintSelection();
      this.commit();
    };
    input.addEventListener("keydown", (raw) => {
      const event = raw as KeyboardEvent;
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      } else if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
      }
    });
    input.addEventListener("blur", () => finish(true));
    // Remembered so a click elsewhere can end the edit before it acts.
    this.editor = input;
    (input as HTMLElement & { finish?: (commit: boolean) => void }).finish = finish;
    this.stage.appendChild(input);
    input.focus();
    input.select();
  }

  private closeEditor(commit: boolean): void {
    const editor = this.editor as (HTMLElement & { finish?: (commit: boolean) => void }) | null;
    editor?.finish?.(commit);
  }

  // ---- input ------------------------------------------------------------------

  private wire(): void {
    const svgEl = this.svgEl;
    svgEl.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    svgEl.addEventListener("pointermove", (e) => this.onPointerMove(e));
    svgEl.addEventListener("pointerup", (e) => this.onPointerUp(e));
    svgEl.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    svgEl.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    svgEl.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = this.stage.getBoundingClientRect();
        this.view = zoomAt(this.view, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - rect.left, e.clientY - rect.top);
        this.applyView();
      },
      { passive: false }
    );
    this.stage.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  private onKeyDown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.deleteSelection();
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.select(this.nodes.map((n) => n.id));
    } else if (e.key === "Escape") {
      this.select([]);
    } else if (!mod && (e.key === "+" || e.key === "=")) {
      this.zoomBy(1.25);
    } else if (!mod && e.key === "-") {
      this.zoomBy(1 / 1.25);
    } else if (!mod && e.key === "0") {
      this.fit();
    } else if (e.key.startsWith("Arrow") && this.selected.size > 0) {
      e.preventDefault();
      const step = e.shiftKey ? 50 : 10;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      for (const n of this.nodes) {
        if (!this.selected.has(n.id)) continue;
        n.x += dx;
        n.y += dy;
        this.layoutNode(n);
      }
      this.redrawEdgesOf(this.selected);
      this.commit();
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    this.closeEditor(true);
    this.stage.focus({ preventScroll: true });
    const target = e.target as Element;
    const resize = target.closest<SVGElement>("[data-resize]");
    const port = target.closest<SVGElement>("[data-port]");
    const nodeG = target.closest<SVGGElement>("g.cv-node");
    const edgeG = target.closest<SVGGElement>("g.cv-edge");
    this.svgEl.setPointerCapture(e.pointerId);
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);

    if (e.button === 1 || (!resize && !port && !nodeG && !edgeG)) {
      this.gesture = { kind: "pan", sx: e.clientX, sy: e.clientY, view: { ...this.view }, moved: false };
      return;
    }
    if (edgeG && !nodeG) {
      this.select([], edgeG.dataset.id ?? null);
      return;
    }
    const id = nodeG?.dataset.id;
    const node = id ? this.nodeById(id) : undefined;
    if (!nodeG || !id || !node) return;

    if (resize) {
      this.gesture = { kind: "resize", id, corner: resize.dataset.resize ?? "se", start: rectOf(node), wx, wy };
      return;
    }
    if (port) {
      const side = (port.dataset.port ?? "right") as CanvasSide;
      const line = svg("path", {}, "cv-connect-line");
      this.overlayLayer.appendChild(line);
      this.gesture = { kind: "connect", from: id, side, wx, wy, line };
      this.updateConnectLine(line, node, side, wx, wy);
      return;
    }

    if (e.shiftKey) {
      const next = new Set(this.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      this.select(next);
    } else if (!this.selected.has(id)) this.select([id]);

    // Moving a group moves what lies inside it too.
    const moving = new Set(this.selected);
    // One pass over the parents for the whole gesture, not a walk per node per group.
    const parents = groupParents(this.nodes as CanvasNode[]);
    for (const j of heldByAny(parents, new Set(this.nodes.flatMap((n, i) => (n.type === "group" && this.selected.has(n.id) ? [i] : []))))) {
      moving.add(this.nodes[j]!.id);
    }
    const origins = new Map<string, { x: number; y: number }>();
    for (const n of this.nodes) if (moving.has(n.id)) origins.set(n.id, { x: n.x, y: n.y });
    this.gesture = {
      kind: "drag",
      id,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      handle: target.closest(".cv-handle") !== null || node.type === "text",
      origins,
    };
  }

  private updateConnectLine(line: SVGPathElement, from: CanvasNode, side: CanvasSide, wx: number, wy: number): void {
    const p = anchorPoint(rectOf(from), side);
    line.setAttribute("d", `M ${p[0]} ${p[1]} L ${wx} ${wy}`);
  }

  private onPointerMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pan") {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
      this.view = { ...g.view, x: g.view.x + dx, y: g.view.y + dy };
      this.applyView();
      return;
    }
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    if (g.kind === "drag") {
      if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return;
      g.moved = true;
      const dx = Math.round((e.clientX - g.sx) / this.view.k);
      const dy = Math.round((e.clientY - g.sy) / this.view.k);
      for (const n of this.nodes) {
        const o = g.origins.get(n.id);
        if (!o) continue;
        n.x = o.x + dx;
        n.y = o.y + dy;
        this.layoutNode(n);
      }
      this.redrawEdgesOf(new Set(g.origins.keys()));
    } else if (g.kind === "resize") {
      const node = this.nodeById(g.id);
      if (!node) return;
      const dx = wx - g.wx;
      const dy = wy - g.wy;
      let { x, y, width, height } = g.start;
      if (g.corner.includes("e")) width = Math.max(MIN_W, g.start.width + dx);
      if (g.corner.includes("s")) height = Math.max(MIN_H, g.start.height + dy);
      if (g.corner.includes("w")) {
        width = Math.max(MIN_W, g.start.width - dx);
        x = g.start.x + g.start.width - width;
      }
      if (g.corner.includes("n")) {
        height = Math.max(MIN_H, g.start.height - dy);
        y = g.start.y + g.start.height - height;
      }
      Object.assign(node, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
      this.layoutNode(node);
      this.redrawEdgesOf(new Set([node.id]));
    } else {
      const from = this.nodeById(g.from);
      if (from) this.updateConnectLine(g.line, from, g.side, wx, wy);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (this.svgEl.hasPointerCapture(e.pointerId)) this.svgEl.releasePointerCapture(e.pointerId);

    if (g.kind === "pan") {
      // A click on the background, not a drag, clears the selection.
      if (!g.moved) this.select([]);
      return;
    }
    if (g.kind === "drag") {
      const node = this.nodeById(g.id);
      if (g.moved) this.commit();
      else if (node && !g.handle && !e.shiftKey) this.activate(node);
      return;
    }
    if (g.kind === "resize") {
      const node = this.nodeById(g.id);
      const r = node ? rectOf(node) : g.start;
      if (r.x !== g.start.x || r.y !== g.start.y || r.width !== g.start.width || r.height !== g.start.height) {
        if (node?.type === "text" || node?.type === "file") this.drawNode(node);
        this.paintSelection();
        this.commit();
      }
      return;
    }

    // connect: released over a node joins them; over nothing, far enough, makes a new text node there
    g.line.remove();
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<SVGGElement>("g.cv-node");
    const toId = under?.dataset.id;
    const to = toId ? this.nodeById(toId) : undefined;
    if (to && to.id !== g.from) {
      this.createEdge(g.from, g.side, to.id, sideFacing(rectOf(to), anchorPoint(rectOf(this.nodeById(g.from)!), g.side)));
      return;
    }
    const from = this.nodeById(g.from);
    if (!to && from && Math.hypot(wx - g.wx, wy - g.wy) > 60) {
      const node: CanvasNode = {
        id: this.newNodeId(),
        type: "text",
        text: "",
        x: Math.round(wx - TEXT_W / 2),
        y: Math.round(wy - TEXT_H / 2),
        width: TEXT_W,
        height: TEXT_H,
      };
      this.nodes.push(node);
      this.drawNode(node);
      const back = sideFacing(rectOf(node), anchorPoint(rectOf(from), g.side));
      this.createEdge(g.from, g.side, node.id, back);
      this.startEdit({ kind: "node", id: node.id });
    }
  }

  /** A click on a node's body (not its bar): a file opens its concept, a link opens its address. */
  private activate(node: CanvasNode): void {
    if (node.type === "file" && typeof node.file === "string") this.options.openConcept(node.file);
    else if (node.type === "link" && typeof node.url === "string") this.options.openUrl(node.url);
  }

  private onDoubleClick(e: MouseEvent): void {
    const target = e.target as Element;
    const nodeG = target.closest<SVGGElement>("g.cv-node");
    const edgeG = target.closest<SVGGElement>("g.cv-edge");
    const id = nodeG?.dataset.id;
    if (id) {
      const node = this.nodeById(id);
      if (node?.type === "text" || node?.type === "group") this.startEdit({ kind: "node", id });
      return;
    }
    if (edgeG?.dataset.id) {
      this.startEdit({ kind: "edge", id: edgeG.dataset.id });
      return;
    }
    this.addTextNode(this.toWorld(e.clientX, e.clientY));
  }
}

export class CanvasView {
  /** Where each canvas was left, so toggling to the source and back lands in the same place. */
  private readonly views = new Map<string, View>();

  constructor(private readonly options: CanvasViewOptions) {}

  /** Draw the canvas whose text is `text`. A file that is not a valid canvas is explained, with the way to fix it. */
  show(root: HTMLElement, path: string, text: string): void {
    // An empty file is a new canvas, not an error.
    const parsed: CanvasParse = text.trim() === "" ? { ok: true, value: { nodes: [], edges: [] } } : parseCanvas(text);
    if (!parsed.ok) {
      clear(root);
      root.classList.remove("base-root");
      root.classList.add("canvas-root");
      const bar = el("div", { className: "cv-toolbar" });
      bar.appendChild(el("span", { className: "spacer" }));
      const edit = el("button", { className: "btn", text: "JSON を編集", title: "この canvas のソースを編集する" });
      edit.type = "button";
      edit.addEventListener("click", () => this.options.editSource());
      bar.appendChild(edit);
      root.appendChild(bar);
      const panel = el("div", { className: "base-error cv-error" });
      panel.appendChild(el("div", { className: "notice-title", text: "この canvas を表示できません" }));
      panel.appendChild(el("div", { className: "notice-detail", text: describeCanvasErrors(parsed.errors) }));
      panel.appendChild(el("div", { className: "notice-hint", text: "「JSON を編集」で内容を直してください。" }));
      root.appendChild(panel);
      return;
    }
    const session = new CanvasSession(
      root,
      path,
      parsed.value,
      this.options,
      (view) => this.views.set(path, view),
      this.views.get(path)
    );
    session.begin(text.trim() === "" ? stringifyCanvas(parsed.value) : text);
  }
}
