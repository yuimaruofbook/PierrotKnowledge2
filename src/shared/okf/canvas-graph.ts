/**
 * A canvas drawn from the link graph: the neighbourhood of some concepts,
 * laid out in layers.
 *
 * The layout is plain integer arithmetic so the same graph gives the same
 * coordinates in the Bun and the Rust build, and the same file every time:
 *
 *   - the neighbourhood is a breadth-first walk from the roots over links in
 *     both directions (outgoing and incoming), `depth` steps out;
 *   - a node's column is its distance from the nearest root; within a column
 *     nodes are ordered by path (by PARA class then path when grouping);
 *   - node and gap sizes are fixed, and a column is centred on the tallest one;
 *   - an edge leaves the right side and enters the left of a node in a later
 *     column (and the reverse), or runs bottom to top within a column.
 *
 * No randomness and no force simulation: a force layout is floating point and
 * path-dependent, which is exactly what two builds cannot be made to share.
 *
 * Plain links are drawn without a label; a typed relation carries its kind.
 * Links to missing concepts and links from a concept to itself are not drawn.
 *
 * The Rust port is `rust/src/shared/okf/canvas_graph.rs`.
 *
 * Pure and DOM-free.
 */

import { compareCodePoints } from "./graph-schema";
import { PARA_LABELS, PARA_ORDER, paraOf, withinParaDepth } from "./para";
import { MAX_CANVAS_EDGES, type Canvas, type CanvasEdge, type CanvasNode, type CanvasSide } from "./canvas";

/** Concepts drawn at most; the walk stops adding nodes past this. */
export const MAX_GRAPH_NODES = 150;

export const NODE_WIDTH = 280;
export const NODE_HEIGHT = 96;
const COLUMN_GAP = 160;
const ROW_GAP = 40;
/** Extra space between PARA clusters in a column, so their group frames do not touch. */
const CLUSTER_GAP = 96;
const GROUP_PAD = 24;
const COLUMN_PITCH = NODE_WIDTH + COLUMN_GAP;
const ROW_PITCH = NODE_HEIGHT + ROW_GAP;

/** Preset colours: a root is green, a retired (DEAD) concept red. */
const COLOR_ROOT = "4";
const COLOR_DEAD = "1";

export interface GraphConcept {
  id: string;
  /** Bundle-relative path: what a file node holds, and what ordering uses. */
  path: string;
  dead: boolean;
  links: ReadonlyArray<{ resolved: string | null; relation?: string }>;
}

export interface GraphOptions {
  roots: readonly string[];
  depth: number;
  includeDead: boolean;
  paraDepth?: number;
  groupByPara: boolean;
}

export interface GraphResult {
  canvas: Canvas;
  /** Concepts drawn (not counting group frames). */
  concepts: number;
  edges: number;
  /** The walk reached `MAX_GRAPH_NODES` or the edges reached `MAX_CANVAS_EDGES`, and some were left out. */
  truncated: boolean;
}

/** FNV-1a over the UTF-8 bytes, as 16 hex digits: a stable id that needs no counter. */
export function stableId(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function buildGraphCanvas(concepts: readonly GraphConcept[], options: GraphOptions): GraphResult {
  const byId = new Map(concepts.map((c) => [c.id, c] as const));
  const pathOf = (id: string) => byId.get(id)!.path;
  const byPath = (a: string, b: string) => compareCodePoints(pathOf(a), pathOf(b));

  // Links in both directions: what points at a concept is as much its
  // neighbourhood as what it points at.
  const adjacent = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    let set = adjacent.get(a);
    if (!set) adjacent.set(a, (set = new Set()));
    set.add(b);
  };
  for (const c of concepts) {
    for (const link of c.links) {
      const to = link.resolved;
      if (to === null || to === c.id || !byId.has(to)) continue;
      connect(c.id, to);
      connect(to, c.id);
    }
  }

  const roots = [...new Set(options.roots)].filter((id) => byId.has(id)).sort(byPath);
  const distance = new Map<string, number>();
  const included: string[] = [];
  for (const id of roots) {
    distance.set(id, 0);
    included.push(id);
  }

  let truncated = false;
  let frontier = roots;
  for (let hop = 1; hop <= options.depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of [...(adjacent.get(id) ?? [])].sort(byPath)) {
        if (distance.has(neighbour)) continue;
        const concept = byId.get(neighbour)!;
        if (concept.dead && !options.includeDead) continue;
        if (options.paraDepth !== undefined && !withinParaDepth(neighbour, options.paraDepth)) continue;
        if (included.length >= MAX_GRAPH_NODES) {
          truncated = true;
          continue;
        }
        distance.set(neighbour, hop);
        included.push(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next.sort(byPath);
  }

  // ---- edges: every link between drawn concepts, once, in a fixed order
  const edgeKeys = new Set<string>();
  const edges: Array<{ from: string; to: string; label: string | undefined }> = [];
  for (const id of included) {
    for (const link of byId.get(id)!.links) {
      const to = link.resolved;
      if (to === null || to === id || !distance.has(to)) continue;
      const key = `${id}\n${to}\n${link.relation ?? ""}\n${link.relation === undefined ? "p" : "r"}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ from: id, to, label: link.relation });
    }
  }
  edges.sort(
    (a, b) =>
      byPath(a.from, b.from) || byPath(a.to, b.to) || compareCodePoints(a.label ?? "", b.label ?? "")
  );

  // A dense neighbourhood (many typed relations) can carry more edges than a canvas
  // may hold; keep the first ones in the fixed order and say so, rather than let
  // canvasWrite refuse the whole drawing.
  if (edges.length > MAX_CANVAS_EDGES) {
    edges.length = MAX_CANVAS_EDGES;
    truncated = true;
  }

  // ---- columns
  const paraIndex = (id: string) => PARA_ORDER.indexOf(paraOf(id));
  const columns = new Map<number, string[]>();
  for (const id of included) {
    const col = distance.get(id)!;
    const list = columns.get(col);
    if (list) list.push(id);
    else columns.set(col, [id]);
  }
  const columnNumbers = [...columns.keys()].sort((a, b) => a - b);
  for (const list of columns.values()) {
    list.sort((a, b) => (options.groupByPara ? paraIndex(a) - paraIndex(b) : 0) || byPath(a, b));
  }

  // y within each column, before centring
  const ys = new Map<string, number>();
  const heights = new Map<number, number>();
  for (const col of columnNumbers) {
    const list = columns.get(col)!;
    let y = 0;
    list.forEach((id, i) => {
      if (i > 0) {
        y += options.groupByPara && paraIndex(id) !== paraIndex(list[i - 1]!) ? ROW_PITCH + CLUSTER_GAP : ROW_PITCH;
      }
      ys.set(id, y);
    });
    heights.set(col, y + NODE_HEIGHT);
  }
  const tallest = Math.max(0, ...heights.values());

  // ---- nodes
  const usedIds = new Set<string>();
  const uniqueId = (seed: string) => {
    let id = stableId(seed);
    for (let n = 2; usedIds.has(id); n++) id = `${stableId(seed)}-${n}`;
    usedIds.add(id);
    return id;
  };

  const nodeIds = new Map<string, string>();
  const position = new Map<string, { x: number; y: number }>();
  const fileNodes: CanvasNode[] = [];
  const groupNodes: CanvasNode[] = [];

  for (const col of columnNumbers) {
    const list = columns.get(col)!;
    const offset = Math.floor((tallest - heights.get(col)!) / 2);
    let clusterStart = 0;
    list.forEach((id, i) => {
      const x = col * COLUMN_PITCH;
      const y = ys.get(id)! + offset;
      position.set(id, { x, y });
      const concept = byId.get(id)!;
      const nodeId = uniqueId(concept.path);
      nodeIds.set(id, nodeId);
      const color = distance.get(id) === 0 ? COLOR_ROOT : concept.dead ? COLOR_DEAD : undefined;
      fileNodes.push({
        id: nodeId,
        type: "file",
        file: concept.path,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ...(color ? { color } : {}),
      });

      const last = i === list.length - 1;
      if (options.groupByPara && (last || paraIndex(list[i + 1]!) !== paraIndex(id))) {
        const top = position.get(list[clusterStart]!)!.y;
        const para = PARA_ORDER[paraIndex(id)]!;
        groupNodes.push({
          id: uniqueId(`group:${col}:${para}`),
          type: "group",
          x: x - GROUP_PAD,
          y: top - GROUP_PAD,
          width: NODE_WIDTH + 2 * GROUP_PAD,
          height: y - top + NODE_HEIGHT + 2 * GROUP_PAD,
          label: PARA_LABELS[para],
        });
        clusterStart = i + 1;
      }
    });
  }

  const canvasEdges: CanvasEdge[] = edges.map((edge) => {
    const a = position.get(edge.from)!;
    const b = position.get(edge.to)!;
    let fromSide: CanvasSide;
    let toSide: CanvasSide;
    if (a.x !== b.x) [fromSide, toSide] = a.x < b.x ? ["right", "left"] : ["left", "right"];
    else [fromSide, toSide] = a.y <= b.y ? ["bottom", "top"] : ["top", "bottom"];
    return {
      id: uniqueId(`edge:${edge.from}>${edge.to}>${edge.label ?? ""}`),
      fromNode: nodeIds.get(edge.from)!,
      fromSide,
      toNode: nodeIds.get(edge.to)!,
      toSide,
      ...(edge.label !== undefined ? { label: edge.label } : {}),
    };
  });

  return {
    // Frames first: they are drawn first, so they sit under the concepts.
    canvas: { nodes: [...groupNodes, ...fileNodes], edges: canvasEdges },
    concepts: fileNodes.length,
    edges: canvasEdges.length,
    truncated,
  };
}

/**
 * A canvas as text, the way Obsidian writes one: tab-indented, one node or
 * edge per line. Key order is the order the objects were built in.
 */
export function serializeCanvas(canvas: Canvas): string {
  const block = (key: string, items: readonly unknown[] | undefined) => {
    const list = items ?? [];
    return list.length === 0
      ? `\t"${key}":[]`
      : `\t"${key}":[\n${list.map((item) => `\t\t${JSON.stringify(item)}`).join(",\n")}\n\t]`;
  };
  return `{\n${block("nodes", canvas.nodes)},\n${block("edges", canvas.edges)}\n}`;
}
