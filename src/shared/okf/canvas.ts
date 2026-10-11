/**
 * Canvases: `.canvas` files in the JSON Canvas 1.0 format (jsoncanvas.org),
 * which Obsidian reads and writes.
 *
 * This module owns what does not depend on where the text came from: checking
 * a canvas against the spec within fixed bounds, and describing one as a
 * compact text outline an agent can read without a renderer. A canvas is saved
 * exactly as given (nothing is re-serialised), so keys this app does not know
 * and the order of nodes and edges survive a round trip with Obsidian.
 *
 * Supported subset: every field of the 1.0 spec. Node types text, file, link
 * and group; edge sides, ends, colours (preset "1"-"6" or hex) and labels.
 * Unknown keys are kept and ignored. The one thing checked beyond the spec is
 * size: a canvas is user data that agents also write, so it is bounded.
 *
 * Group membership is geometric (a group "contains" what lies inside its
 * rectangle), as in Obsidian. It is resolved with a total order, so groups that
 * overlap or contain each other cannot form a cycle.
 *
 * The Rust port is `rust/src/shared/okf/canvas.rs`; both must give the same
 * errors and the same outline.
 *
 * Pure and DOM-free.
 */

export const CANVAS_EXT = ".canvas";

/** Largest canvas file read or written. */
export const MAX_CANVAS_BYTES = 1_048_576;
export const MAX_CANVAS_NODES = 2_000;
export const MAX_CANVAS_EDGES = 5_000;
/** JSON nesting, checked before parsing so a bracket bomb never reaches the parser. */
export const MAX_CANVAS_DEPTH = 32;
/** Coordinates and sizes stay well inside the range where integers are exact. */
export const MAX_COORD = 10_000_000;
export const MAX_ID_CHARS = 128;
/** How many errors a message spells out; the rest are counted. */
export const MAX_ERRORS_SHOWN = 10;

export function isCanvasPath(path: string): boolean {
  return path.toLowerCase().endsWith(CANVAS_EXT);
}

export type CanvasNodeType = "text" | "file" | "link" | "group";

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
  [key: string]: unknown;
}

export type CanvasSide = "top" | "right" | "bottom" | "left";

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface Canvas {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
  [key: string]: unknown;
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

/** Length in code points, which is what Rust's `chars().count()` gives. */
function cpLength(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** First `max` code points of `text`, with an ellipsis when it was cut. */
export function clip(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join("")}…`;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---- validation --------------------------------------------------------------------

const NODE_TYPES = ["text", "file", "link", "group"];
const SIDES = ["top", "right", "bottom", "left"];
const ENDS = ["none", "arrow"];
const BG_STYLES = ["cover", "ratio", "repeat"];
const PRESET_COLOR_RE = /^[1-6]$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function validId(v: unknown): v is string {
  return typeof v === "string" && v !== "" && cpLength(v) <= MAX_ID_CHARS;
}

/** The spec's problems with a parsed canvas, in the order found. Empty when it is valid. */
export function validateCanvas(value: unknown): string[] {
  if (!isDict(value)) return ["the canvas must be a JSON object"];
  const errors: string[] = [];

  const nodes = value.nodes;
  const edges = value.edges;
  if (nodes !== undefined && !Array.isArray(nodes)) errors.push("nodes must be an array");
  if (edges !== undefined && !Array.isArray(edges)) errors.push("edges must be an array");
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const edgeList = Array.isArray(edges) ? edges : [];
  if (nodeList.length > MAX_CANVAS_NODES) errors.push(`too many nodes: the limit is ${MAX_CANVAS_NODES}`);
  if (edgeList.length > MAX_CANVAS_EDGES) errors.push(`too many edges: the limit is ${MAX_CANVAS_EDGES}`);
  if (errors.length > 0) return errors;

  const ids = new Set<string>();
  const color = (item: Dict, where: string) => {
    const c = item.color;
    if (c === undefined) return;
    if (typeof c !== "string" || !(PRESET_COLOR_RE.test(c) || HEX_COLOR_RE.test(c))) {
      errors.push(`${where}.color must be "1" to "6" or a #hex colour`);
    }
  };
  const optString = (item: Dict, key: string, where: string) => {
    if (item[key] !== undefined && typeof item[key] !== "string") errors.push(`${where}.${key} must be a string`);
  };

  nodeList.forEach((node, i) => {
    const where = `nodes[${i}]`;
    if (!isDict(node)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!validId(node.id)) errors.push(`${where}.id must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
    else if (ids.has(node.id)) errors.push(`${where}.id '${clip(node.id, 40)}' is used twice`);
    else ids.add(node.id);

    if (typeof node.type !== "string" || !NODE_TYPES.includes(node.type)) {
      errors.push(`${where}.type must be text, file, link or group`);
    }
    for (const key of ["x", "y"]) {
      if (!isInt(node[key], -MAX_COORD, MAX_COORD)) errors.push(`${where}.${key} must be an integer from -${MAX_COORD} to ${MAX_COORD}`);
    }
    for (const key of ["width", "height"]) {
      if (!isInt(node[key], 1, MAX_COORD)) errors.push(`${where}.${key} must be an integer from 1 to ${MAX_COORD}`);
    }
    color(node, where);

    switch (node.type) {
      case "text":
        if (typeof node.text !== "string") errors.push(`${where}.text must be a string`);
        break;
      case "file":
        if (typeof node.file !== "string" || node.file === "" || node.file.includes("\0")) {
          errors.push(`${where}.file must be a non-empty path`);
        }
        if (node.subpath !== undefined && (typeof node.subpath !== "string" || !node.subpath.startsWith("#"))) {
          errors.push(`${where}.subpath must be a string starting with #`);
        }
        break;
      case "link":
        if (typeof node.url !== "string" || node.url === "") errors.push(`${where}.url must be a non-empty string`);
        break;
      case "group":
        optString(node, "label", where);
        optString(node, "background", where);
        if (node.backgroundStyle !== undefined && !(typeof node.backgroundStyle === "string" && BG_STYLES.includes(node.backgroundStyle))) {
          errors.push(`${where}.backgroundStyle must be cover, ratio or repeat`);
        }
        break;
    }
  });

  const edgeIds = new Set<string>();
  edgeList.forEach((edge, i) => {
    const where = `edges[${i}]`;
    if (!isDict(edge)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!validId(edge.id)) errors.push(`${where}.id must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
    else if (edgeIds.has(edge.id)) errors.push(`${where}.id '${clip(edge.id, 40)}' is used twice`);
    else edgeIds.add(edge.id);

    for (const key of ["fromNode", "toNode"]) {
      const target = edge[key];
      if (typeof target !== "string") errors.push(`${where}.${key} must be a node id`);
      else if (!ids.has(target)) errors.push(`${where}.${key} '${clip(target, 40)}' is not a node`);
    }
    for (const key of ["fromSide", "toSide"]) {
      if (edge[key] !== undefined && !(typeof edge[key] === "string" && SIDES.includes(edge[key] as string))) {
        errors.push(`${where}.${key} must be top, right, bottom or left`);
      }
    }
    for (const key of ["fromEnd", "toEnd"]) {
      if (edge[key] !== undefined && !(typeof edge[key] === "string" && ENDS.includes(edge[key] as string))) {
        errors.push(`${where}.${key} must be none or arrow`);
      }
    }
    color(edge, where);
    optString(edge, "label", where);
  });

  return errors;
}

/** At most `MAX_ERRORS_SHOWN` errors, then how many were left out. */
export function describeCanvasErrors(errors: readonly string[]): string {
  const shown = errors.slice(0, MAX_ERRORS_SHOWN).join("; ");
  return errors.length > MAX_ERRORS_SHOWN ? `${shown}; and ${errors.length - MAX_ERRORS_SHOWN} more` : shown;
}

/** Deepest bracket nesting in JSON text, outside strings. Stops counting past the limit. */
function jsonDepthExceeds(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 1; // backslash: the next character cannot end the string
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > limit) return true;
    } else if (c === 0x7d || c === 0x5d) depth -= 1;
  }
  return false;
}

export type CanvasParse = { ok: true; value: Canvas } | { ok: false; errors: string[] };

/** Size, nesting, JSON and the spec, in that order: the cheap refusals come first. */
export function parseCanvas(text: string): CanvasParse {
  if (utf8Length(text) > MAX_CANVAS_BYTES) {
    return { ok: false, errors: [`the canvas is larger than ${MAX_CANVAS_BYTES} bytes`] };
  }
  if (jsonDepthExceeds(text, MAX_CANVAS_DEPTH)) {
    return { ok: false, errors: [`the canvas is nested deeper than ${MAX_CANVAS_DEPTH} levels`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["the content is not valid JSON"] };
  }
  const errors = validateCanvas(value);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as Canvas };
}

// ---- groups -------------------------------------------------------------------------

/**
 * The group each node sits in: the smallest group whose rectangle holds it.
 *
 * A group holds a node when it is strictly larger, or the same size and drawn
 * earlier. That makes "holds" an order, so a chain of parents always ends: two
 * identical groups do not contain each other, and nothing contains itself.
 * Returns, per node index, the parent group's index or -1.
 */
export function groupParents(nodes: readonly CanvasNode[]): number[] {
  const area = (n: CanvasNode) => n.width * n.height;
  const groups: number[] = [];
  nodes.forEach((n, i) => {
    if (n.type === "group") groups.push(i);
  });

  return nodes.map((node, i) => {
    let best = -1;
    for (const g of groups) {
      if (g === i) continue;
      const group = nodes[g]!;
      const inside =
        group.x <= node.x &&
        group.y <= node.y &&
        group.x + group.width >= node.x + node.width &&
        group.y + group.height >= node.y + node.height;
      if (!inside) continue;
      if (!(area(group) > area(node) || (area(group) === area(node) && g < i))) continue;
      // The nearest group is the smallest; among equals, the one drawn last.
      if (best === -1 || area(group) < area(nodes[best]!) || (area(group) === area(nodes[best]!) && g > best)) best = g;
    }
    return best;
  });
}

// ---- outline ------------------------------------------------------------------------

/** What a file node points at, if it is a concept. */
export interface ResolvedFile {
  title: string;
  description?: string;
}

const LABEL_CHARS = 80;

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return clip(line.trim(), LABEL_CHARS);
}

/** How a node is named in the outline and in edges. */
function nodeName(node: CanvasNode, resolve: (file: string) => ResolvedFile | null): string {
  switch (node.type) {
    case "file": {
      const found = resolve(String(node.file));
      return found ? found.title : String(node.file);
    }
    case "text":
      return `"${firstLine(String(node.text))}"`;
    case "link":
      return String(node.url);
    default:
      return typeof node.label === "string" && node.label !== "" ? clip(node.label, LABEL_CHARS) : `(group ${node.id})`;
  }
}

function nodeLine(node: CanvasNode, resolve: (file: string) => ResolvedFile | null): string {
  const head = `- [${node.id}] ${node.type}`;
  switch (node.type) {
    case "file": {
      const file = `${String(node.file)}${typeof node.subpath === "string" ? node.subpath : ""}`;
      const found = resolve(String(node.file));
      if (found) return `${head} ${file} — ${found.title}${found.description ? `: ${found.description}` : ""}`;
      return /\.md$/i.test(String(node.file)) ? `${head} ${file} (not found)` : `${head} ${file}`;
    }
    case "text":
      return `${head} ${nodeName(node, resolve)}`;
    case "link":
      return `${head} ${String(node.url)}`;
    default:
      return `${head} ${nodeName(node, resolve)}`;
  }
}

/**
 * A canvas as text: nodes by group (file nodes resolved to their concept's
 * title and description), then the edges with their labels.
 *
 * Sections are left out when empty. Groups are listed in file order, each with
 * the nodes it holds directly; a nested group appears as a member of its
 * parent and again as a section of its own.
 */
export function canvasOutline(
  canvas: Canvas,
  resolve: (file: string) => ResolvedFile | null,
  path?: string
): string {
  const nodes = canvas.nodes ?? [];
  const edges = canvas.edges ?? [];
  const lines: string[] = [
    `Canvas${path ? ` ${path}` : ""}: ${nodes.length} node${nodes.length === 1 ? "" : "s"}, ${edges.length} edge${edges.length === 1 ? "" : "s"}`,
  ];

  const parents = groupParents(nodes);
  const members = (parent: number): number[] => {
    const out: number[] = [];
    parents.forEach((p, i) => {
      if (p === parent) out.push(i);
    });
    return out;
  };

  nodes.forEach((group, g) => {
    if (group.type !== "group") return;
    const held = members(g);
    lines.push("", `## Group [${group.id}] ${nodeName(group, resolve)} (${held.length} node${held.length === 1 ? "" : "s"})`);
    for (const i of held) lines.push(nodeLine(nodes[i]!, resolve));
  });

  const loose = members(-1).filter((i) => nodes[i]!.type !== "group");
  if (loose.length > 0) {
    lines.push("", `## ${nodes.some((n) => n.type === "group") ? "Ungrouped" : "Nodes"} (${loose.length})`);
    for (const i of loose) lines.push(nodeLine(nodes[i]!, resolve));
  }

  if (edges.length > 0) {
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    lines.push("", `## Edges (${edges.length})`);
    for (const edge of edges) {
      const from = byId.get(edge.fromNode);
      const to = byId.get(edge.toNode);
      const fromArrow = edge.fromEnd === "arrow";
      const toArrow = edge.toEnd === undefined || edge.toEnd === "arrow";
      const arrow = fromArrow && toArrow ? "<->" : toArrow ? "->" : fromArrow ? "<-" : "--";
      const label = typeof edge.label === "string" && edge.label !== "" ? ` [${clip(edge.label, LABEL_CHARS)}]` : "";
      lines.push(`- ${from ? nodeName(from, resolve) : edge.fromNode} ${arrow} ${to ? nodeName(to, resolve) : edge.toNode}${label}`);
    }
  }

  return lines.join("\n");
}
