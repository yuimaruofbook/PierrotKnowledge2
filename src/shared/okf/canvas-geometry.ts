/**
 * The geometry of a canvas on screen: where an edge leaves and enters a node,
 * the curve between, where the view should sit to show everything, and the
 * text a canvas is saved as.
 *
 * Kept out of the view so it can be tested without a DOM. Nothing here knows
 * about SVG: points are `[x, y]` in canvas coordinates.
 *
 * Pure and DOM-free.
 */

import type { Canvas, CanvasEdge, CanvasNode, CanvasSide } from "./canvas";

export type Point = readonly [number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The point on a node's border that a side names: the middle of that side. */
export function anchorPoint(node: Rect, side: CanvasSide): Point {
  switch (side) {
    case "top":
      return [node.x + node.width / 2, node.y];
    case "right":
      return [node.x + node.width, node.y + node.height / 2];
    case "bottom":
      return [node.x + node.width / 2, node.y + node.height];
    default:
      return [node.x, node.y + node.height / 2];
  }
}

/** The direction a side faces: an edge leaves along it. */
export function sideNormal(side: CanvasSide): Point {
  switch (side) {
    case "top":
      return [0, -1];
    case "right":
      return [1, 0];
    case "bottom":
      return [0, 1];
    default:
      return [-1, 0];
  }
}

/** The side of `node` that faces the point `to`: the horizontal one when the point is more beside than above. */
export function sideFacing(node: Rect, to: Point): CanvasSide {
  const dx = to[0] - (node.x + node.width / 2);
  const dy = to[1] - (node.y + node.height / 2);
  // Compare in units of the node's own half-extent, so a wide node still leaves from its top or bottom.
  if (Math.abs(dx) / Math.max(1, node.width) >= Math.abs(dy) / Math.max(1, node.height)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

export interface EdgeGeometry {
  from: Point;
  to: Point;
  fromSide: CanvasSide;
  toSide: CanvasSide;
  /** SVG path data of the curve. */
  d: string;
  /** Where a label sits: the middle of the curve. */
  mid: Point;
}

/**
 * The curve for an edge. A side the file does not give is the one facing the
 * other node, as Obsidian draws it.
 */
export function edgeGeometry(
  edge: Pick<CanvasEdge, "fromSide" | "toSide">,
  from: Rect,
  to: Rect
): EdgeGeometry {
  const center = (r: Rect): Point => [r.x + r.width / 2, r.y + r.height / 2];
  const fromSide = edge.fromSide ?? sideFacing(from, center(to));
  const toSide = edge.toSide ?? sideFacing(to, center(from));
  const p0 = anchorPoint(from, fromSide);
  const p1 = anchorPoint(to, toSide);
  const n0 = sideNormal(fromSide);
  const n1 = sideNormal(toSide);
  // Control points reach out along each side's normal, farther for longer edges.
  const reach = Math.min(200, Math.max(30, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 2));
  const c0: Point = [p0[0] + n0[0] * reach, p0[1] + n0[1] * reach];
  const c1: Point = [p1[0] + n1[0] * reach, p1[1] + n1[1] * reach];
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    from: p0,
    to: p1,
    fromSide,
    toSide,
    d: `M ${round(p0[0])} ${round(p0[1])} C ${round(c0[0])} ${round(c0[1])}, ${round(c1[0])} ${round(c1[1])}, ${round(p1[0])} ${round(p1[1])}`,
    // The cubic's point at t = 1/2.
    mid: [(p0[0] + 3 * c0[0] + 3 * c1[0] + p1[0]) / 8, (p0[1] + 3 * c0[1] + 3 * c1[1] + p1[1]) / 8],
  };
}

/** The three corners of an arrowhead whose tip is `tip` and which sits on a side facing `side`. */
export function arrowHead(tip: Point, side: CanvasSide, size = 12): string {
  const n = sideNormal(side);
  const back: Point = [tip[0] + n[0] * size, tip[1] + n[1] * size];
  const half = size / 2;
  const a: Point = [back[0] - n[1] * half, back[1] + n[0] * half];
  const b: Point = [back[0] + n[1] * half, back[1] - n[0] * half];
  const r = (n: number) => Math.round(n * 100) / 100;
  return `${r(tip[0])},${r(tip[1])} ${r(a[0])},${r(a[1])} ${r(b[0])},${r(b[1])}`;
}

/** The smallest rectangle holding every node, or `null` for none. */
export function boundsOf(nodes: readonly Rect[]): Rect | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface View {
  /** Where the canvas origin is on screen, in pixels. */
  x: number;
  y: number;
  /** Pixels per canvas unit. */
  k: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

/** A view that shows `bounds` centred in a `width` x `height` viewport, never magnified past 1. */
export function fitView(bounds: Rect | null, width: number, height: number, padding = 48): View {
  if (!bounds || width <= 0 || height <= 0) return { x: width / 2, y: height / 2, k: 1 };
  const k = Math.min(
    1,
    Math.max(MIN_ZOOM, Math.min((width - 2 * padding) / Math.max(1, bounds.width), (height - 2 * padding) / Math.max(1, bounds.height)))
  );
  return {
    k,
    x: width / 2 - (bounds.x + bounds.width / 2) * k,
    y: height / 2 - (bounds.y + bounds.height / 2) * k,
  };
}

/** Zoom by `factor` keeping the canvas point under the screen point `(sx, sy)` where it is. */
export function zoomAt(view: View, factor: number, sx: number, sy: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
  const real = k / view.k;
  return { k, x: sx - (sx - view.x) * real, y: sy - (sy - view.y) * real };
}

/** Preset colours of the spec, by number. The values are the app's to choose; the spec leaves them open. */
export const PRESET_COLOR_NAMES: Record<string, string> = {
  "1": "赤",
  "2": "橙",
  "3": "黄",
  "4": "緑",
  "5": "水色",
  "6": "紫",
};

/**
 * The text a canvas is saved as: the way Obsidian lays it out (tabs, one node
 * or edge per line), with every other key kept in the order it had.
 */
export function stringifyCanvas(canvas: Canvas): string {
  const lines = Object.keys(canvas).map((key) => {
    const value = canvas[key];
    if ((key === "nodes" || key === "edges") && Array.isArray(value)) {
      return value.length === 0
        ? `\t${JSON.stringify(key)}:[]`
        : `\t${JSON.stringify(key)}:[\n${value.map((item) => `\t\t${JSON.stringify(item)}`).join(",\n")}\n\t]`;
    }
    return `\t${JSON.stringify(key)}:${JSON.stringify(value)}`;
  });
  return lines.length === 0 ? "{}" : `{\n${lines.join(",\n")}\n}`;
}

/** A node id nobody has used in this canvas: 16 random hex digits, as Obsidian writes them. */
export function freshId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < 16; i++) id += Math.floor(random() * 16).toString(16);
    if (!taken.has(id)) return id;
  }
}

/**
 * Nodes held by any of `groups`, however deep: one linear pass, memoising each
 * node's answer along its chain of parents (so a gesture that moves several
 * groups does not walk every chain once per group).
 */
export function heldByAny(parents: readonly number[], groups: ReadonlySet<number>): number[] {
  const memo = new Map<number, boolean>();
  const held = (start: number): boolean => {
    const chain: number[] = [];
    let result = false;
    for (let at = parents[start] ?? -1, guard = 0; at !== -1 && guard <= parents.length; at = parents[at] ?? -1, guard++) {
      if (groups.has(at)) {
        result = true;
        break;
      }
      const known = memo.get(at);
      if (known !== undefined) {
        result = known;
        break;
      }
      chain.push(at);
    }
    for (const c of chain) memo.set(c, result);
    return result;
  };
  const out: number[] = [];
  parents.forEach((_, i) => {
    if (held(i)) out.push(i);
  });
  return out;
}

/** Nodes held by a group: those lying inside its rectangle, however deep. */
export function heldBy(nodes: readonly CanvasNode[], parents: readonly number[], group: number): number[] {
  const held: number[] = [];
  nodes.forEach((_, i) => {
    // Walk up the chain of parents; it ends because `groupParents` never forms a cycle.
    for (let at = parents[i] ?? -1, guard = 0; at !== -1 && guard <= nodes.length; at = parents[at] ?? -1, guard++) {
      if (at === group) {
        held.push(i);
        return;
      }
    }
  });
  return held;
}
