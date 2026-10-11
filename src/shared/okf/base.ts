/**
 * Bases: `.base` files as list and aggregate views over the concepts.
 *
 * A `.base` file is YAML in the format Obsidian Bases reads, so the same file
 * works in Obsidian and here. This module owns the part that does not depend
 * on where the YAML came from: checking a parsed document, and running one
 * view of it over a set of concepts into rows, groups and summaries.
 *
 * Supported subset (everything else is kept in the file and ignored):
 *   - top level: `filters`, `formulas`, `properties` (`displayName`),
 *     `summaries` (custom, over `values`), `views`
 *   - filters: an expression string, or `and` / `or` / `not` of them
 *     (`not` is true when none of its entries is)
 *   - views of type `table` and `cards`: `name`, `filters`, `order`, `sort`,
 *     `limit`, `groupBy`, `summaries`
 *   - summaries: Count, Average, Min, Max, Sum, Range, Median, Stddev, Earliest,
 *     Latest, Checked, Unchecked, Empty, Filled, Unique, or a custom one
 *
 * Ordering is deterministic: concepts by path, then the view's sort keys (an
 * empty value sorts last in both directions), then the path again.
 *
 * The Rust port is `rust/src/shared/okf/base.rs`; both must give the same
 * rows, the same JSON and the same messages.
 *
 * Pure and DOM-free.
 */

import {
  DateV,
  EVAL_STEP_BUDGET,
  Evaluator,
  ExprError,
  FILE_PROPS,
  MAX_FORMULA_DEPTH,
  UNSUPPORTED_FILE_PROPS,
  aggregate,
  checkExpr,
  compareValues,
  display,
  evalFailure,
  formulaRefs,
  isPlainObject,
  numStr,
  parseDate,
  parseExpr,
  toJson,
  truthy,
  valuesEqual,
  type BaseRow,
  type Expr,
  type Findings,
  type Value,
} from "./base-expr";

export type { BaseRow } from "./base-expr";

/** The file name a base must have. */
export const BASE_EXT = ".base";

/** Where the example base for new bundles lives. */
export const BASES_DIR = "bases";
export const BASES_TITLE = "Bases";

/** Rows an answer never exceeds, whatever the view or the caller asks for. */
export const MAX_ROWS = 500;

export class BaseError extends Error {}

export function isBasePath(path: string): boolean {
  return path.toLowerCase().endsWith(BASE_EXT);
}

// ---- compiled form -------------------------------------------------------------

type FilterNode =
  | { k: "expr"; expr: Expr }
  | { k: "and" | "or" | "not"; items: FilterNode[] };

interface SortKey {
  property: string;
  desc: boolean;
}

interface CompiledView {
  name: string;
  type: string;
  supported: boolean;
  filter: FilterNode | null;
  order: string[];
  sort: SortKey[];
  limit: number | null;
  groupBy: SortKey | null;
  summaries: Map<string, string>;
}

interface Compiled {
  filter: FilterNode | null;
  formulas: Map<string, Expr>;
  displayNames: Map<string, string>;
  summaries: Map<string, Expr>;
  views: CompiledView[];
}

const DEFAULT_SUMMARIES = [
  "Count", "Average", "Min", "Max", "Sum", "Range", "Median", "Stddev",
  "Earliest", "Latest", "Checked", "Unchecked", "Empty", "Filled", "Unique",
];

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

function own(d: Dict, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

function implicitView(): CompiledView {
  return {
    name: "Table",
    type: "table",
    supported: true,
    filter: null,
    order: [],
    sort: [],
    limit: null,
    groupBy: null,
    summaries: new Map(),
  };
}

/** One expression: parsed, and its static findings recorded under `where`. */
function compileExpr(src: string, where: string, formulas: ReadonlySet<string>, out: Findings): Expr | null {
  let expr: Expr;
  try {
    expr = parseExpr(src);
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    out.errors.push(`${where}: ${e.message}`);
    return null;
  }
  const found: Findings = { errors: [], warnings: [] };
  checkExpr(expr, formulas, found);
  for (const m of found.errors) out.errors.push(`${where}: ${m}`);
  for (const m of found.warnings) out.warnings.push(`${where}: ${m}`);
  return expr;
}

function compileFilter(node: unknown, where: string, formulas: ReadonlySet<string>, out: Findings): FilterNode | null {
  if (typeof node === "string") {
    const expr = compileExpr(node, where, formulas, out);
    return expr ? { k: "expr", expr } : null;
  }
  if (!isDict(node)) {
    out.errors.push(`${where}: must be an expression or an and / or / not mapping`);
    return null;
  }
  const keys = Object.keys(node);
  const unknown = keys.filter((k) => k !== "and" && k !== "or" && k !== "not");
  for (const k of unknown) out.errors.push(`${where}: unknown key '${k}' (use and, or, not)`);
  if (unknown.length > 0) return null;
  if (keys.length !== 1) {
    out.errors.push(`${where}: must have exactly one key (and, or, not)`);
    return null;
  }
  const key = keys[0] as "and" | "or" | "not";
  const list = node[key];
  if (!Array.isArray(list)) {
    out.errors.push(`${where}.${key}: must be a list`);
    return null;
  }
  const items: FilterNode[] = [];
  list.forEach((item, i) => {
    const child = compileFilter(item, `${where}.${key}[${i}]`, formulas, out);
    if (child) items.push(child);
  });
  return { k: key, items };
}

/** A property id in `order`, `sort`, `groupBy` or `summaries`, checked statically. */
function checkProperty(id: string, where: string, formulas: ReadonlySet<string>, out: Findings): void {
  if (id.startsWith("file.")) {
    const name = id.slice(5);
    if (UNSUPPORTED_FILE_PROPS.has(name)) out.warnings.push(`${where}: file.${name} is not supported`);
    else if (!FILE_PROPS.has(name)) out.warnings.push(`${where}: file.${name} is not a known file property`);
  } else if (id.startsWith("formula.") && !formulas.has(id.slice(8))) {
    out.warnings.push(`${where}: formula.${id.slice(8)} is not defined`);
  }
}

function compileSort(raw: unknown, where: string, formulas: ReadonlySet<string>, out: Findings): SortKey | null {
  if (!isDict(raw) || typeof raw.property !== "string") {
    out.errors.push(`${where}: property is required`);
    return null;
  }
  const dir = raw.direction;
  if (dir !== undefined && !(typeof dir === "string" && /^(asc|desc)$/i.test(dir))) {
    out.errors.push(`${where}: direction must be ASC or DESC`);
    return null;
  }
  checkProperty(raw.property, where, formulas, out);
  return { property: raw.property, desc: typeof dir === "string" && dir.toLowerCase() === "desc" };
}

/**
 * The formulas that can reach themselves (Tarjan's strongly connected components,
 * iterative so a long chain cannot overflow the stack).
 */
function formulasInCycles(refs: ReadonlyMap<string, string[]>): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  let counter = 0;
  const visit = (node: string, work: Array<{ node: string; i: number }>): void => {
    index.set(node, counter);
    low.set(node, counter++);
    stack.push(node);
    onStack.add(node);
    work.push({ node, i: 0 });
  };
  for (const root of refs.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; i: number }> = [];
    visit(root, work);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const next = refs.get(frame.node)![frame.i++];
      if (next !== undefined) {
        if (!index.has(next)) visit(next, work);
        else if (onStack.has(next)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const members: string[] = [];
        let top: string;
        do {
          top = stack.pop()!;
          onStack.delete(top);
          members.push(top);
        } while (top !== frame.node);
        if (members.length > 1 || refs.get(frame.node)!.includes(frame.node)) members.forEach((m) => cyclic.add(m));
      }
    }
  }
  return cyclic;
}

/** How many formulas deep each one goes (itself included); the graph must have no cycle. */
function formulaDepths(refs: ReadonlyMap<string, string[]>): Map<string, number> {
  const depth = new Map<string, number>();
  for (const root of refs.keys()) {
    if (depth.has(root)) continue;
    const work: Array<{ node: string; i: number }> = [{ node: root, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const list = refs.get(frame.node)!;
      if (frame.i < list.length) {
        const next = list[frame.i++]!;
        if (!depth.has(next)) work.push({ node: next, i: 0 });
        continue;
      }
      let deepest = 0;
      for (const n of list) deepest = Math.max(deepest, depth.get(n)!);
      depth.set(frame.node, 1 + deepest);
      work.pop();
    }
  }
  return depth;
}

/** Check a parsed `.base` document and, when it is usable, compile it. */
function compile(value: unknown): { found: Findings; compiled: Compiled | null } {
  const found: Findings = { errors: [], warnings: [] };
  const root: Dict = value === null || value === undefined ? {} : isDict(value) ? value : {};
  if (value !== null && value !== undefined && !isDict(value)) {
    found.errors.push("a base must be a YAML mapping");
    return { found, compiled: null };
  }

  // Formula names first: every expression is checked against them.
  const formulaSrc = own(root, "formulas");
  const formulas = new Map<string, Expr>();
  const formulaNames = new Set<string>();
  if (formulaSrc !== undefined && formulaSrc !== null) {
    if (!isDict(formulaSrc)) found.errors.push("formulas: must be a mapping of name to expression");
    else for (const name of Object.keys(formulaSrc)) formulaNames.add(name);
  }

  const filter =
    own(root, "filters") === undefined || own(root, "filters") === null
      ? null
      : compileFilter(own(root, "filters"), "filters", formulaNames, found);

  if (isDict(formulaSrc)) {
    for (const [name, src] of Object.entries(formulaSrc)) {
      if (typeof src !== "string") {
        found.errors.push(`formulas.${name}: must be an expression string`);
        continue;
      }
      const expr = compileExpr(src, `formulas.${name}`, formulaNames, found);
      if (expr) formulas.set(name, expr);
    }
    const refs = new Map<string, string[]>();
    for (const [name, expr] of formulas) refs.set(name, [...formulaRefs(expr)].filter((n) => formulas.has(n)));
    // A formula is in a cycle when it can reach itself.
    const cyclic = formulasInCycles(refs);
    for (const name of formulas.keys()) {
      if (cyclic.has(name)) found.errors.push(`formulas.${name}: circular reference`);
    }
    // Chains that are too long would recurse too deeply when evaluated.
    if (cyclic.size === 0) {
      const depth = formulaDepths(refs);
      for (const name of formulas.keys()) {
        if (depth.get(name)! > MAX_FORMULA_DEPTH) {
          found.errors.push(`formulas.${name}: references are nested more than ${MAX_FORMULA_DEPTH} deep`);
          break;
        }
      }
    }
  }

  const displayNames = new Map<string, string>();
  const props = own(root, "properties");
  if (props !== undefined && props !== null) {
    if (!isDict(props)) found.errors.push("properties: must be a mapping");
    else {
      for (const [id, conf] of Object.entries(props)) {
        if (isDict(conf) && typeof conf.displayName === "string") displayNames.set(id, conf.displayName);
      }
    }
  }

  const customSummaries = new Map<string, Expr>();
  const sums = own(root, "summaries");
  if (sums !== undefined && sums !== null) {
    if (!isDict(sums)) found.errors.push("summaries: must be a mapping of name to expression");
    else {
      for (const [name, src] of Object.entries(sums)) {
        if (typeof src !== "string") {
          found.errors.push(`summaries.${name}: must be an expression string`);
          continue;
        }
        const expr = compileExpr(src, `summaries.${name}`, formulaNames, found);
        if (expr) customSummaries.set(name, expr);
      }
    }
  }

  const views: CompiledView[] = [];
  const rawViews = own(root, "views");
  if (rawViews !== undefined && rawViews !== null) {
    if (!Array.isArray(rawViews)) found.errors.push("views: must be a list");
    else {
      rawViews.forEach((raw, i) => {
        const at = `views[${i}]`;
        if (!isDict(raw)) {
          found.errors.push(`${at}: must be a mapping`);
          return;
        }
        if (typeof raw.type !== "string" || raw.type === "") {
          found.errors.push(`${at}: type is required`);
          return;
        }
        const view: CompiledView = { ...implicitView(), type: raw.type };
        view.name = typeof raw.name === "string" && raw.name !== "" ? raw.name : `View ${i + 1}`;
        if (raw.name !== undefined && raw.name !== null && typeof raw.name !== "string") {
          found.errors.push(`${at}.name: must be text`);
        }
        view.supported = raw.type === "table" || raw.type === "cards";
        if (!view.supported) {
          found.warnings.push(`${at}: type '${raw.type}' is not supported (table and cards only)`);
          views.push(view);
          return;
        }

        if (raw.filters !== undefined && raw.filters !== null) {
          view.filter = compileFilter(raw.filters, `${at}.filters`, formulaNames, found);
        }
        if (raw.order !== undefined && raw.order !== null) {
          if (!Array.isArray(raw.order) || raw.order.some((x) => typeof x !== "string")) {
            found.errors.push(`${at}.order: must be a list of property names`);
          } else {
            view.order = raw.order as string[];
            view.order.forEach((id, j) => checkProperty(id, `${at}.order[${j}]`, formulaNames, found));
          }
        }
        if (raw.sort !== undefined && raw.sort !== null) {
          if (!Array.isArray(raw.sort)) found.errors.push(`${at}.sort: must be a list`);
          else {
            raw.sort.forEach((s, j) => {
              const key = compileSort(s, `${at}.sort[${j}]`, formulaNames, found);
              if (key) view.sort.push(key);
            });
          }
        }
        if (raw.limit !== undefined && raw.limit !== null) {
          if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1) {
            found.errors.push(`${at}.limit: must be a positive integer`);
          } else view.limit = raw.limit;
        }
        if (raw.groupBy !== undefined && raw.groupBy !== null) {
          if (!isDict(raw.groupBy) || typeof raw.groupBy.property !== "string") {
            found.errors.push(`${at}.groupBy: must be a mapping with a property`);
          } else {
            view.groupBy = compileSort(raw.groupBy, `${at}.groupBy`, formulaNames, found);
          }
        }
        if (raw.summaries !== undefined && raw.summaries !== null) {
          if (!isDict(raw.summaries)) {
            found.errors.push(`${at}.summaries: must be a mapping of property to summary name`);
          } else {
            for (const [id, name] of Object.entries(raw.summaries)) {
              if (typeof name !== "string" || !(DEFAULT_SUMMARIES.includes(name) || customSummaries.has(name))) {
                found.errors.push(`${at}.summaries.${id}: unknown summary '${String(name)}'`);
              } else {
                view.summaries.set(id, name);
                checkProperty(id, `${at}.summaries.${id}`, formulaNames, found);
              }
            }
          }
        }
        views.push(view);
      });
    }
  }
  if (views.length === 0 && (rawViews === undefined || rawViews === null || (Array.isArray(rawViews) && rawViews.length === 0))) {
    views.push(implicitView());
  }

  if (found.errors.length > 0) return { found, compiled: null };
  return { found, compiled: { filter, formulas, displayNames, summaries: customSummaries, views } };
}

/** Errors stop a write; warnings are for the author to read. */
export function validateBase(value: unknown): Findings {
  return compile(value).found;
}

/** The views a parsed base offers, read leniently (for listings). */
export function listViews(value: unknown): Array<{ name: string; type: string }> {
  const views = isDict(value) ? own(value, "views") : undefined;
  const out: Array<{ name: string; type: string }> = [];
  if (Array.isArray(views)) {
    views.forEach((raw, i) => {
      if (!isDict(raw)) return;
      out.push({
        name: typeof raw.name === "string" && raw.name !== "" ? raw.name : `View ${i + 1}`,
        type: typeof raw.type === "string" && raw.type !== "" ? raw.type : "unknown",
      });
    });
  }
  return out.length > 0 ? out : [{ name: "Table", type: "table" }];
}

// ---- running a view ---------------------------------------------------------------

export interface BaseColumn {
  id: string;
  name: string;
}
export interface BaseResultRow {
  path: string;
  cells: unknown[];
}
export interface BaseSummary {
  column: string;
  summary: string;
  value: unknown;
}
export interface BaseGroup {
  key: unknown;
  label: string;
  /** Every row of the group, whether or not the row cap let them all be listed. */
  count: number;
  /** Set when the row cap cut this group's `rows` short of `count`. */
  truncated?: true;
  rows: BaseResultRow[];
  summaries: BaseSummary[];
}
export interface BaseResult {
  view: string;
  type: string;
  columns: BaseColumn[];
  /** Rows that matched the filters, before any limit. */
  total: number;
  shown: number;
  rows?: BaseResultRow[];
  groups?: BaseGroup[];
  summaries: BaseSummary[];
  warnings?: string[];
}

/** What the interface asks for: the views on offer, and the one that ran (or why it did not). */
export interface BaseViewResponse {
  views: Array<{ name: string; type: string }>;
  result?: BaseResult;
  error?: string;
}

export interface RunOptions {
  view?: string;
  limit?: number;
  /** The clock, in epoch milliseconds; injected so tests are exact. */
  now: number;
}

function isEmptyValue(v: Value): boolean {
  if (v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return isPlainObject(v) && Object.keys(v).length === 0;
}

function dateOf(v: Value): DateV | null {
  if (v instanceof DateV) return v;
  const ms = typeof v === "string" ? parseDate(v) : null;
  return ms === null ? null : new DateV(ms);
}

function runSummary(name: string, values: Value[], custom: Expr | undefined, ev: Evaluator | null): Value {
  if (custom) return ev ? ev.eval(custom, [{ values }]) : null;
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  switch (name) {
    case "Count":
      return values.length;
    case "Average":
      return aggregate("mean", nums);
    case "Min":
      return aggregate("min", nums);
    case "Max":
      return aggregate("max", nums);
    case "Sum":
      return aggregate("sum", nums);
    case "Median":
      return aggregate("median", nums);
    case "Stddev":
      return aggregate("stddev", nums);
    case "Range": {
      const lo = aggregate("min", nums);
      const hi = aggregate("max", nums);
      return lo === null || hi === null ? null : hi - lo;
    }
    case "Earliest":
    case "Latest": {
      const dates = values.map(dateOf).filter((d): d is DateV => d !== null);
      if (dates.length === 0) return null;
      return dates.reduce((a, b) => (name === "Earliest" ? (b.ms < a.ms ? b : a) : b.ms > a.ms ? b : a));
    }
    case "Checked":
      return values.filter((v) => v === true).length;
    case "Unchecked":
      return values.filter((v) => v === false).length;
    case "Empty":
      return values.filter(isEmptyValue).length;
    case "Filled":
      return values.filter((v) => !isEmptyValue(v)).length;
    default: {
      // Unique: distinct non-empty values.
      const seen: Value[] = [];
      for (const v of values) if (!isEmptyValue(v) && !seen.some((s) => valuesEqual(s, v))) seen.push(v);
      return seen.length;
    }
  }
}

function pickView(c: Compiled, wanted: string | undefined): CompiledView {
  if (wanted === undefined) {
    const first = c.views[0]!;
    return first;
  }
  const hit = c.views.find((v) => v.name === wanted);
  if (!hit) throw new BaseError(`view '${wanted}' not found; available: ${c.views.map((v) => v.name).join(", ")}`);
  return hit;
}

/** Run one view of a parsed base over concepts. Throws `BaseError`. */
export function runBase(value: unknown, concepts: readonly BaseRow[], options: RunOptions): BaseResult {
  const { found, compiled } = compile(value);
  if (!compiled) throw new BaseError(`invalid base: ${found.errors.join("; ")}`);
  const view = pickView(compiled, options.view);
  if (!view.supported) {
    throw new BaseError(`view '${view.name}' has type '${view.type}', which is not supported (table and cards only)`);
  }

  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  // One budget for the whole query, so a hostile base ends in warnings, not a hang.
  const env = { now: options.now, formulas: compiled.formulas, warn, budget: { left: EVAL_STEP_BUDGET } };

  const rows = [...concepts].sort((a, b) => a.path.localeCompare(b.path));
  const evs = new Map<BaseRow, Evaluator>(rows.map((r) => [r, new Evaluator(r, env)]));
  const guard = <T>(where: string, fallback: T, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      // A RangeError or the like is still only this cell's failure, never the engine's.
      warn(`${where}: ${evalFailure(e).message}`);
      return fallback;
    }
  };

  const passes = (node: FilterNode | null, row: BaseRow): boolean => {
    if (node === null) return true;
    if (node.k === "expr") {
      return guard("filter", false, () => truthy(evs.get(row)!.eval(node.expr, [])));
    }
    if (node.k === "and") return node.items.every((n) => passes(n, row));
    if (node.k === "or") return node.items.some((n) => passes(n, row));
    return !node.items.some((n) => passes(n, row));
  };

  // 1. filters: global, then the view's own.
  const kept = rows.filter((r) => passes(compiled.filter, r) && passes(view.filter, r));
  const total = kept.length;

  // 2. sort (grouping is the outermost key).
  const keys: SortKey[] = [...(view.groupBy ? [view.groupBy] : []), ...view.sort];
  const keyValues = new Map<BaseRow, Value[]>();
  for (const r of kept) {
    keyValues.set(
      r,
      keys.map((k) => guard(`sort ${k.property}`, null as Value, () => evs.get(r)!.property(k.property)))
    );
  }
  kept.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const [x, y] = [keyValues.get(a)![i]!, keyValues.get(b)![i]!];
      let c: number;
      if (x === null || y === null) {
        // An empty value goes last whichever way the key runs: a gap is not the biggest or smallest.
        c = x === y ? 0 : x === null ? 1 : -1;
      } else {
        c = compareValues(x, y);
        if (keys[i]!.desc) c = -c;
      }
      if (c !== 0) return c;
    }
    return a.path.localeCompare(b.path);
  });

  // 3. limit: the view's, the caller's and the hard cap, whichever is smallest.
  // It caps the rows listed; counts and summaries still cover every match.
  const cap = Math.min(MAX_ROWS, view.limit ?? MAX_ROWS, options.limit ?? MAX_ROWS);
  const shownRows = kept.slice(0, cap);
  const isShown = new Set(shownRows);

  // 4. cells.
  const order = view.order.length > 0 ? view.order : ["file.name"];
  const columns: BaseColumn[] = order.map((id) => ({
    id,
    name: compiled.displayNames.get(id) ?? (id.startsWith("note.") ? id.slice(5) : id.startsWith("formula.") ? id.slice(8) : id),
  }));
  // A row that is not listed only needs the columns that have a summary.
  const cells = new Map<BaseRow, Value[]>();
  for (const r of kept) {
    cells.set(
      r,
      order.map((id) =>
        isShown.has(r) || view.summaries.has(id)
          ? guard(`column ${id}`, null as Value, () => evs.get(r)!.property(id))
          : null
      )
    );
  }
  const resultRow = (r: BaseRow): BaseResultRow => ({ path: r.path, cells: cells.get(r)!.map(toJson) });

  // 5. summaries, over the rows given (every match, not just the listed ones).
  const summarize = (subset: BaseRow[]): BaseSummary[] => {
    const out: BaseSummary[] = [];
    order.forEach((id, col) => {
      const name = view.summaries.get(id);
      if (name === undefined) return;
      const values = subset.map((r) => cells.get(r)![col]!);
      const custom = compiled.summaries.get(name);
      const probe = subset[0] ?? rows[0];
      const ev = probe ? (evs.get(probe) ?? null) : null;
      const v = guard(`summary ${name}`, null as Value, () => runSummary(name, values, custom, ev));
      out.push({ column: id, summary: name, value: toJson(v) });
    });
    return out;
  };

  const result: BaseResult = {
    view: view.name,
    type: view.type,
    columns,
    total,
    shown: shownRows.length,
  } as BaseResult;

  if (view.groupBy) {
    const buckets: Array<{ key: Value; rows: BaseRow[] }> = [];
    let current: { key: Value; rows: BaseRow[] } | null = null;
    for (const r of kept) {
      const key = keyValues.get(r)![0]!;
      if (current && compareValues(current.key, key) === 0) current.rows.push(r);
      else {
        current = { key, rows: [r] };
        buckets.push(current);
      }
    }
    result.groups = buckets.map((b) => {
      // The listed rows are a prefix of the sorted matches, so each group lists its first members.
      const listed = b.rows.filter((r) => isShown.has(r));
      return {
        key: toJson(b.key),
        label: b.key === null ? "(empty)" : display(b.key),
        count: b.rows.length,
        ...(listed.length < b.rows.length ? { truncated: true as const } : {}),
        rows: listed.map(resultRow),
        summaries: summarize(b.rows),
      };
    });
  } else {
    result.rows = shownRows.map(resultRow);
  }
  result.summaries = summarize(kept);
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

// ---- markdown ---------------------------------------------------------------------

function cellText(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = "";
  else if (typeof v === "number") s = numStr(v);
  else if (typeof v === "string") s = v;
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else if (Array.isArray(v)) s = v.map(cellText).join(", ");
  else s = JSON.stringify(v);
  return s.replace(/\|/g, "\\|").replace(/\r?\n|\r/g, " ");
}

/** A compact rendering for agents: one table per group, summaries beneath. */
export function renderBaseMarkdown(result: BaseResult): string {
  const names = new Map(result.columns.map((c) => [c.id, c.name]));
  const table = (rows: BaseResultRow[]): string[] => [
    `| ${result.columns.map((c) => cellText(c.name)).join(" | ")} |`,
    `| ${result.columns.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.cells.map(cellText).join(" | ")} |`),
  ];
  const summaryLine = (list: BaseSummary[]): string[] =>
    list.length === 0
      ? []
      : [
          "",
          `Summary: ${list.map((s) => `${names.get(s.column) ?? s.column} ${s.summary} = ${cellText(s.value)}`).join("; ")}`,
        ];

  const out: string[] = [`**${result.view}** (${result.type}) - ${result.shown} of ${result.total} rows`, ""];
  if (result.shown === 0) out.push("(no rows)");
  else if (result.groups) {
    result.groups.forEach((g, i) => {
      if (i > 0) out.push("");
      const size = g.truncated ? `${g.rows.length} of ${g.count} rows shown` : String(g.count);
      out.push(`### ${g.label} (${size})`, "", ...(g.rows.length > 0 ? table(g.rows) : ["(no rows shown)"]), ...summaryLine(g.summaries));
    });
    out.push(...summaryLine(result.summaries));
  } else {
    out.push(...table(result.rows ?? []), ...summaryLine(result.summaries));
  }
  if (result.warnings?.length) out.push("", "Warnings:", ...result.warnings.map((w) => `- ${w}`));
  return out.join("\n");
}
