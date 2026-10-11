/**
 * The expression language of `.base` files: a small, safe subset of what
 * Obsidian Bases accepts in filters, formulas and custom summaries.
 *
 * It is parsed and evaluated here and nowhere else. There is no `eval`, no
 * property access on host objects (a name that is not a frontmatter key is
 * simply empty) and no way to call anything but the fixed functions below, so
 * a `.base` file written by an agent or pasted from the web cannot run code.
 * Dates are evaluated in UTC, so the same file gives the same rows on every
 * machine.
 *
 * Supported: number / string / boolean / null / list literals, `+ - * / %`,
 * comparison, `&& || !`, `a.b`, `a[i]`, function and method calls (see
 * `GLOBALS` and `METHODS`). Not supported: regular-expression literals, object
 * literals, `this`, and the functions in `UNSUPPORTED_GLOBALS` /
 * `UNSUPPORTED_METHODS`, which Obsidian has but this app cannot evaluate.
 *
 * The Rust port is `rust/src/shared/okf/base_expr.rs`; the two must agree on
 * every result and every error message.
 *
 * Pure and DOM-free.
 */

import { paraOf } from "./para";

// ---- values ------------------------------------------------------------------

export class DateV {
  constructor(readonly ms: number) {}
}
export class LinkV {
  constructor(
    readonly target: string,
    readonly display: string | null
  ) {}
}
export class DurV {
  constructor(
    readonly months: number,
    readonly ms: number
  ) {}
}

export type Value = null | boolean | number | string | Value[] | ObjV | DateV | LinkV | DurV;
export interface ObjV {
  [key: string]: Value;
}

/** A failure while evaluating: the cell, filter or summary becomes empty. */
export class EvalError extends Error {}

/** A failure while parsing: the whole base is rejected. */
export class ExprError extends Error {}

// ---- limits ------------------------------------------------------------------------
// A `.base` file may come from an agent or the web, so no expression in it may be
// able to exhaust the stack, memory or time. Both ports use the same numbers.

/** Deepest syntax tree, counting every level (operators and `.a.b` chains too). */
export const MAX_AST_DEPTH = 128;
/** Most syntax nodes in one expression. */
export const MAX_AST_NODES = 10_000;
/** Deepest evaluation, including formulas and lambdas that call into each other. */
export const MAX_EVAL_DEPTH = 256;
/** Longest chain of formulas that refer to one another. */
export const MAX_FORMULA_DEPTH = 32;
/** Evaluation steps one query may take; each node costs 1, big results cost more. */
export const EVAL_STEP_BUDGET = 3_000_000;
/** Largest value an expression may build: 1 per item, plus 1 per UTF-16 unit of text. */
export const MAX_VALUE_WEIGHT = 1_000_000;
/** A result is charged weight >> COST_SHIFT steps: bulk copying is far cheaper than a node. */
const COST_SHIFT = 8;
/** Dates beyond this are not representable (the JS Date range). */
const MAX_DATE_MS = 8.64e15;

/** Anything thrown while evaluating that is not already an `EvalError` (a RangeError, say). */
export function evalFailure(e: unknown): EvalError {
  return e instanceof EvalError ? e : new EvalError("evaluation failed");
}

/** Shared by every evaluator of one query. */
export interface Budget {
  left: number;
}

/** Weight of a value, counting no further once it passes `limit`. */
function weight(v: Value, limit: number): number {
  let total = 0;
  const walk = (x: Value): void => {
    if (total > limit) return;
    total += 1;
    if (typeof x === "string") {
      total += x.length;
    } else if (Array.isArray(x)) {
      for (const y of x) {
        walk(y);
        if (total > limit) return;
      }
    } else if (isPlainObject(x)) {
      for (const [k, y] of Object.entries(x)) {
        total += k.length;
        walk(y);
        if (total > limit) return;
      }
    }
  };
  walk(v);
  return total;
}

export function typeName(v: Value): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "list";
  if (v instanceof DateV) return "date";
  if (v instanceof LinkV) return "link";
  if (v instanceof DurV) return "duration";
  return "object";
}

export function isPlainObject(v: Value): v is ObjV {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof DateV) && !(v instanceof LinkV) && !(v instanceof DurV);
}

/** A frontmatter / YAML value as an evaluator value. */
export function fromJson(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.map(fromJson);
  if (typeof v === "object") {
    const out: ObjV = Object.create(null);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = fromJson(x);
    return out;
  }
  return null;
}

// ---- numbers and dates, shared by both ports ------------------------------------

/** `String(number)`. */
export function numStr(x: number): string {
  return String(x);
}

const DAY_MS = 86400000;

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Days since 1970-01-01 for a civil date (proleptic Gregorian). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = floorDiv(yy, 400);
  const yoe = yy - era * 400;
  const doy = floorDiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
  const mp = floorDiv(5 * doy + 2, 153);
  const d = doy - floorDiv(153 * mp + 2, 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [m <= 2 ? y + 1 : y, m, d];
}

function daysInMonth(y: number, m: number): number {
  return daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - daysFromCivil(y, m, 1);
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number;
}

function partsOf(ms: number): DateParts {
  const days = floorDiv(ms, DAY_MS);
  const rest = ms - days * DAY_MS;
  const [year, month, day] = civilFromDays(days);
  return {
    year,
    month,
    day,
    hour: floorDiv(rest, 3600000),
    minute: floorDiv(rest % 3600000, 60000),
    second: floorDiv(rest % 60000, 1000),
    millisecond: rest % 1000,
    weekday: (((days + 4) % 7) + 7) % 7,
  };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** `YYYY-MM-DD`, plus ` HH:mm:ss` (and `.SSS`) only when there is a time. */
export function dateStr(ms: number): string {
  const p = partsOf(ms);
  let s = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  if (p.hour || p.minute || p.second || p.millisecond) {
    s += ` ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
    if (p.millisecond) s += `.${pad(p.millisecond, 3)}`;
  }
  return s;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The Moment.js tokens Bases formats use most; anything else is copied. */
function formatDate(ms: number, format: string): string {
  const p = partsOf(ms);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const tokens: Array<[string, string]> = [
    ["YYYY", pad(p.year, 4)],
    ["MMMM", MONTHS[p.month - 1]!],
    ["MMM", MONTHS[p.month - 1]!.slice(0, 3)],
    ["dddd", WEEKDAYS[p.weekday]!],
    ["ddd", WEEKDAYS[p.weekday]!.slice(0, 3)],
    ["SSS", pad(p.millisecond, 3)],
    ["YY", pad(p.year % 100)],
    ["MM", pad(p.month)],
    ["DD", pad(p.day)],
    ["HH", pad(p.hour)],
    ["hh", pad(h12)],
    ["mm", pad(p.minute)],
    ["ss", pad(p.second)],
    ["M", String(p.month)],
    ["D", String(p.day)],
    ["H", String(p.hour)],
    ["h", String(h12)],
    ["m", String(p.minute)],
    ["s", String(p.second)],
    ["A", p.hour < 12 ? "AM" : "PM"],
    ["a", p.hour < 12 ? "am" : "pm"],
  ];
  const chars = Array.from(format);
  let out = "";
  for (let i = 0; i < chars.length; ) {
    if (chars[i] === "[") {
      const close = chars.indexOf("]", i + 1);
      if (close !== -1) {
        out += chars.slice(i + 1, close).join("");
        i = close + 1;
        continue;
      }
    }
    const rest = chars.slice(i, i + 4).join("");
    const hit = tokens.find(([t]) => rest.startsWith(t));
    if (hit) {
      out += hit[1];
      i += Array.from(hit[0]).length;
    } else {
      out += chars[i];
      i += 1;
    }
  }
  return out;
}

/** `YYYY-MM-DD`, optionally with `[T ]HH:mm[:ss[.SSS]]` and a trailing `Z`. */
export function parseDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?Z?$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const hh = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const ss = Number(m[6] ?? 0);
  const ms = Number((m[7] ?? "").padEnd(3, "0") || 0);
  if (hh > 23 || mi > 59 || ss > 59) return null;
  return daysFromCivil(y, mo, d) * DAY_MS + hh * 3600000 + mi * 60000 + ss * 1000 + ms;
}

const WORD_UNITS: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  year: "y", years: "y", month: "M", months: "M", week: "w", weeks: "w", day: "d", days: "d",
  hour: "h", hours: "h", minute: "m", minutes: "m", second: "s", seconds: "s",
});
const UNIT_MS: Record<string, number> = { w: 7 * DAY_MS, d: DAY_MS, h: 3600000, m: 60000, s: 1000 };

/** "1M", "2 weeks", "1y 2M": calendar units are kept apart from fixed ones. */
export function parseDuration(s: string): DurV | null {
  const chars = Array.from(s);
  let i = 0;
  let months = 0;
  let ms = 0;
  let any = false;
  const space = () => {
    while (i < chars.length && /\s/.test(chars[i]!)) i++;
  };
  for (space(); i < chars.length; space()) {
    let num = "";
    if (chars[i] === "-") num = chars[i++]!;
    const start = i;
    while (i < chars.length && /[0-9.]/.test(chars[i]!)) num += chars[i++]!;
    if (i === start || Number.isNaN(Number(num))) return null;
    space();
    let unit = "";
    while (i < chars.length && /[A-Za-z]/.test(chars[i]!)) unit += chars[i++]!;
    const n = Number(num);
    // The units Obsidian documents: one letter (`M` months and `m` minutes differ by
    // case), or the full word, singular or plural. `ms` and the rest are not units.
    const word = unit.length > 1 ? WORD_UNITS[unit.toLowerCase()] : unit;
    if (word === "y") months += Math.trunc(n * 12);
    else if (word === "M") months += Math.trunc(n);
    else if (word === "w") ms += n * UNIT_MS.w!;
    else if (word === "d") ms += n * UNIT_MS.d!;
    else if (word === "h") ms += n * UNIT_MS.h!;
    else if (word === "m") ms += n * UNIT_MS.m!;
    else if (word === "s") ms += n * UNIT_MS.s!;
    else return null;
    any = true;
  }
  return any ? new DurV(months, ms) : null;
}

function addDuration(ms: number, dur: DurV, sign: 1 | -1): number {
  let out = ms;
  if (dur.months !== 0) {
    const days = floorDiv(out, DAY_MS);
    const rest = out - days * DAY_MS;
    const [y, m, d] = civilFromDays(days);
    const index = y * 12 + (m - 1) + sign * dur.months;
    const ny = floorDiv(index, 12);
    const nm = index - ny * 12 + 1;
    out = daysFromCivil(ny, nm, Math.min(d, daysInMonth(ny, nm))) * DAY_MS + rest;
  }
  return out + sign * dur.ms;
}

/** `Number.prototype.toFixed` on the exact binary value, ties rounding up. */
export function toFixed(x: number, digits: number): string {
  return x.toFixed(digits);
}

// ---- syntax --------------------------------------------------------------------

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "list"; items: Expr[] }
  | { k: "id"; name: string }
  | { k: "member"; obj: Expr; name: string }
  | { k: "index"; obj: Expr; idx: Expr }
  | { k: "call"; obj: Expr | null; name: string; args: Expr[] }
  | { k: "unary"; op: "!" | "-"; e: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr };

type Tok = { t: "num" | "str" | "id" | "op" | "end"; v: string };

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}\p{M}_]/u;
const TWO_CHAR = ["==", "!=", ">=", "<=", "&&", "||"];
const ONE_CHAR = "+-*/%()[],.!<>";
const MAX_DEPTH = 64;

function tokenize(src: string): Tok[] {
  const chars = Array.from(src);
  const out: Tok[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let n = "";
      while (i < chars.length && /[0-9]/.test(chars[i]!)) n += chars[i++]!;
      if (chars[i] === "." && /[0-9]/.test(chars[i + 1] ?? "")) {
        n += chars[i++]!;
        while (i < chars.length && /[0-9]/.test(chars[i]!)) n += chars[i++]!;
      }
      out.push({ t: "num", v: n });
      continue;
    }
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= chars.length) throw new ExprError("unterminated string");
        const d = chars[i++]!;
        if (d === c) break;
        if (d === "\\" && i < chars.length) {
          const e = chars[i++]!;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "\\" || e === '"' || e === "'" ? e : `\\${e}`;
        } else {
          s += d;
        }
      }
      out.push({ t: "str", v: s });
      continue;
    }
    if (IDENT_START.test(c)) {
      let name = "";
      while (i < chars.length && IDENT_PART.test(chars[i]!)) name += chars[i++]!;
      out.push({ t: "id", v: name });
      continue;
    }
    const two = c + (chars[i + 1] ?? "");
    if (TWO_CHAR.includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR.includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character '${c}'`);
  }
  out.push({ t: "end", v: "" });
  return out;
}

/** Levels in a tree. Only called on a node whose children were already checked, so it is shallow. */
function exprDepth(e: Expr): number {
  switch (e.k) {
    case "list":
      return 1 + e.items.reduce((m, x) => Math.max(m, exprDepth(x)), 0);
    case "member":
      return 1 + exprDepth(e.obj);
    case "index":
      return 1 + Math.max(exprDepth(e.obj), exprDepth(e.idx));
    case "call":
      return 1 + Math.max(e.obj ? exprDepth(e.obj) : 0, ...e.args.map(exprDepth));
    case "unary":
      return 1 + exprDepth(e.e);
    case "bin":
      return 1 + Math.max(exprDepth(e.l), exprDepth(e.r));
    default:
      return 1;
  }
}

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => toks[pos]!;
  const isOp = (v: string) => peek().t === "op" && peek().v === v;
  const fail = (): never => {
    const tok = peek();
    throw new ExprError(tok.t === "end" ? "unexpected end of expression" : `unexpected '${tok.v}'`);
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) fail();
    pos++;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new ExprError("expression is nested too deeply");
  };
  // Every node passes through here, so a chain of operators or `.a.b.c` calls cannot
  // build a tree deeper than evaluation (or dropping it, in the Rust port) can follow.
  let nodes = 0;
  const built = (e: Expr): Expr => {
    if (++nodes > MAX_AST_NODES) throw new ExprError("expression is too large");
    if (exprDepth(e) > MAX_AST_DEPTH) throw new ExprError("expression is nested too deeply");
    return e;
  };

  const binary = (ops: string[], next: () => Expr): (() => Expr) => () => {
    let l = next();
    while (peek().t === "op" && ops.includes(peek().v)) {
      const op = toks[pos++]!.v;
      l = built({ k: "bin", op, l, r: next() });
    }
    return l;
  };

  const primary = (): Expr => {
    const tok = peek();
    if (tok.t === "num") {
      pos++;
      return built({ k: "num", v: Number(tok.v) });
    }
    if (tok.t === "str") {
      pos++;
      return built({ k: "str", v: tok.v });
    }
    if (tok.t === "id") {
      pos++;
      if (tok.v === "true" || tok.v === "false") return built({ k: "bool", v: tok.v === "true" });
      if (tok.v === "null") return built({ k: "null" });
      if (isOp("(")) return built({ k: "call", obj: null, name: tok.v, args: args() });
      return built({ k: "id", name: tok.v });
    }
    if (isOp("(")) {
      pos++;
      enter();
      const e = or();
      depth--;
      expectOp(")");
      return e;
    }
    if (isOp("[")) {
      pos++;
      const items: Expr[] = [];
      enter();
      if (!isOp("]")) {
        items.push(or());
        while (isOp(",")) {
          pos++;
          items.push(or());
        }
      }
      depth--;
      expectOp("]");
      return built({ k: "list", items });
    }
    return fail();
  };

  const args = (): Expr[] => {
    expectOp("(");
    const list: Expr[] = [];
    enter();
    if (!isOp(")")) {
      list.push(or());
      while (isOp(",")) {
        pos++;
        list.push(or());
      }
    }
    depth--;
    expectOp(")");
    return list;
  };

  const postfix = (): Expr => {
    let e = primary();
    for (;;) {
      if (isOp(".")) {
        pos++;
        const name = peek();
        if (name.t !== "id") fail();
        pos++;
        e = built(
          isOp("(")
            ? { k: "call", obj: e, name: name.v, args: args() }
            : { k: "member", obj: e, name: name.v }
        );
      } else if (isOp("[")) {
        pos++;
        enter();
        const idx = or();
        depth--;
        expectOp("]");
        e = built({ k: "index", obj: e, idx });
      } else {
        return e;
      }
    }
  };

  const unary = (): Expr => {
    if (isOp("!") || isOp("-")) {
      const op = toks[pos++]!.v as "!" | "-";
      enter();
      const e = unary();
      depth--;
      return built({ k: "unary", op, e });
    }
    return postfix();
  };

  const mul = binary(["*", "/", "%"], unary);
  const add = binary(["+", "-"], mul);
  const rel = binary(["<", ">", "<=", ">="], add);
  const eq = binary(["==", "!="], rel);
  const and = binary(["&&"], eq);
  const or = binary(["||"], and);

  const result = or();
  if (peek().t !== "end") fail();
  return result;
}

// ---- what is callable ----------------------------------------------------------

export const GLOBALS = new Set([
  "if", "number", "min", "max", "list", "date", "duration", "now", "today", "link", "escapeHTML",
]);
export const UNSUPPORTED_GLOBALS = new Set(["file", "html", "image", "icon", "random"]);

export const METHODS = new Set([
  // any
  "isTruthy", "isType", "toString", "isEmpty",
  // string
  "contains", "containsAll", "containsAny", "endsWith", "startsWith", "lower", "replace", "repeat",
  "reverse", "slice", "split", "title", "trim",
  // number
  "abs", "ceil", "floor", "round", "toFixed",
  // list
  "filter", "flat", "join", "map", "reduce", "sort", "unique", "sum", "mean", "min", "max", "median",
  // date
  "date", "format", "time",
  // object
  "keys", "values",
  // file
  "hasTag", "inFolder", "hasProperty", "hasLink", "asLink",
]);
export const UNSUPPORTED_METHODS = new Set(["relative", "asFile", "linksTo", "matches"]);

export const FILE_PROPS = new Set([
  "name", "basename", "path", "folder", "ext", "mtime", "tags", "links", "properties", "para",
]);
export const UNSUPPORTED_FILE_PROPS = new Set(["size", "ctime", "embeds", "backlinks"]);

export interface Findings {
  errors: string[];
  warnings: string[];
}

/** Names and references that cannot work, found without evaluating anything. */
export function checkExpr(e: Expr, formulas: ReadonlySet<string>, out: Findings): void {
  const walk = (x: Expr): void => {
    switch (x.k) {
      case "list":
        x.items.forEach(walk);
        return;
      case "id":
        if (x.name === "this") out.warnings.push("this is not supported");
        return;
      case "member":
        if (x.obj.k === "id" && x.obj.name === "file") {
          if (UNSUPPORTED_FILE_PROPS.has(x.name)) out.warnings.push(`file.${x.name} is not supported`);
          else if (!FILE_PROPS.has(x.name)) out.warnings.push(`file.${x.name} is not a known file property`);
        } else if (x.obj.k === "id" && x.obj.name === "formula" && !formulas.has(x.name)) {
          out.warnings.push(`formula.${x.name} is not defined`);
        } else {
          walk(x.obj);
        }
        return;
      case "index":
        walk(x.obj);
        walk(x.idx);
        return;
      case "call":
        if (x.obj) {
          walk(x.obj);
          if (UNSUPPORTED_METHODS.has(x.name)) out.warnings.push(`${x.name}() is not supported`);
          else if (!METHODS.has(x.name)) out.errors.push(`unknown function '${x.name}'`);
        } else if (UNSUPPORTED_GLOBALS.has(x.name)) {
          out.warnings.push(`${x.name}() is not supported`);
        } else if (!GLOBALS.has(x.name)) {
          out.errors.push(`unknown function '${x.name}'`);
        }
        x.args.forEach(walk);
        return;
      case "unary":
        walk(x.e);
        return;
      case "bin":
        walk(x.l);
        walk(x.r);
        return;
      default:
        return;
    }
  };
  walk(e);
}

/** The `formula.NAME` references inside an expression. */
export function formulaRefs(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.k) {
    case "list":
      e.items.forEach((x) => formulaRefs(x, out));
      break;
    case "member":
      if (e.obj.k === "id" && e.obj.name === "formula") out.add(e.name);
      else formulaRefs(e.obj, out);
      break;
    case "index":
      formulaRefs(e.obj, out);
      formulaRefs(e.idx, out);
      break;
    case "call":
      if (e.obj) formulaRefs(e.obj, out);
      e.args.forEach((x) => formulaRefs(x, out));
      break;
    case "unary":
      formulaRefs(e.e, out);
      break;
    case "bin":
      formulaRefs(e.l, out);
      formulaRefs(e.r, out);
      break;
    default:
      break;
  }
  return out;
}

// ---- evaluation ----------------------------------------------------------------

/** What an expression sees about one concept. */
export interface BaseRow {
  /** Bundle-relative path, `/`-separated. */
  path: string;
  /** Path relative to the wiki layer. */
  wikiPath: string;
  id: string;
  mtimeMs: number;
  frontmatter: Record<string, unknown>;
  links: Array<{ target: string; resolved: string | null }>;
}

export interface EvalEnv {
  now: number;
  /** Formula source by name, for `formula.NAME`. */
  formulas?: ReadonlyMap<string, Expr>;
  /** Where a formula that fails reports it. */
  warn?: (message: string) => void;
  /** Steps left for the whole query; one evaluator on its own gets a fresh budget. */
  budget?: Budget;
}

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const shadowed = (scope: Array<Record<string, Value>>, name: string): boolean => scope.some((s) => has(s, name));

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === "") return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  return true;
}

/** How a value reads in a table cell or inside a string. */
export function display(v: Value): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return numStr(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(display).join(", ");
  if (v instanceof DateV) return dateStr(v.ms);
  if (v instanceof LinkV) return v.display ?? v.target;
  if (v instanceof DurV) return numStr(v.ms + v.months * 30 * DAY_MS);
  return JSON.stringify(toJson(v));
}

/** The JSON form returned to callers: dates and links become strings. */
export function toJson(v: Value): unknown {
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(toJson);
  if (v instanceof DateV) return dateStr(v.ms);
  if (v instanceof LinkV) return v.display === null ? `[[${v.target}]]` : `[[${v.target}|${v.display}]]`;
  if (v instanceof DurV) return v.ms + v.months * 30 * DAY_MS;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = toJson(x);
  return out;
}

/** A string that reads as a date, where a date is expected. */
function asDate(v: Value): DateV | null {
  if (v instanceof DateV) return v;
  if (typeof v === "string") {
    const ms = parseDate(v);
    return ms === null ? null : new DateV(ms);
  }
  return null;
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (a instanceof DateV || b instanceof DateV) {
    const [x, y] = [asDate(a), asDate(b)];
    return x !== null && y !== null && x.ms === y.ms;
  }
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]!));
  }
  if (Array.isArray(b)) return false;
  if (a instanceof LinkV) return b instanceof LinkV && a.target === b.target;
  if (a instanceof DurV) return b instanceof DurV && a.ms === b.ms && a.months === b.months;
  if (typeof a === "object") {
    if (typeof b !== "object" || b instanceof LinkV || b instanceof DurV) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b as ObjV);
    return ka.length === kb.length && ka.every((k) => k in (b as ObjV) && valuesEqual((a as ObjV)[k]!, (b as ObjV)[k]!));
  }
  return a === b;
}

function rank(v: Value): number {
  if (v === null) return 7;
  if (typeof v === "boolean") return 0;
  if (typeof v === "number") return 1;
  if (v instanceof DateV) return 2;
  if (typeof v === "string") return 3;
  if (v instanceof LinkV) return 4;
  if (Array.isArray(v)) return 5;
  return 6;
}

/** A total order for sorting and grouping: empty last, then by type, then by value (NaN after numbers). */
export function compareValues(a: Value, b: Value): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") {
    // NaN sorts after every number (and equal to another NaN), so the order stays total.
    const [an, bn] = [Number.isNaN(a), Number.isNaN(b)];
    if (an || bn) return an && bn ? 0 : an ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof DateV && b instanceof DateV) return a.ms < b.ms ? -1 : a.ms > b.ms ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  if (a instanceof LinkV && b instanceof LinkV) return a.target.localeCompare(b.target);
  if (a === null || b === null) return 0;
  const sa = JSON.stringify(toJson(a));
  const sb = JSON.stringify(toJson(b));
  return sa.localeCompare(sb);
}

function orderOp(op: string, a: Value, b: Value): boolean {
  let c: number | null = null;
  if (typeof a === "number" && typeof b === "number") c = a < b ? -1 : a > b ? 1 : a === b ? 0 : null;
  else if (typeof a === "string" && typeof b === "string") c = a.localeCompare(b);
  else if (a instanceof DateV || b instanceof DateV) {
    const [x, y] = [asDate(a), asDate(b)];
    if (x && y) c = x.ms < y.ms ? -1 : x.ms > y.ms ? 1 : 0;
  } else if (typeof a === "boolean" && typeof b === "boolean") c = Number(a) - Number(b);
  if (c === null) return false;
  return op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
}

/** Tags as a list of strings, without a leading `#`. */
export function tagsOf(fm: Record<string, unknown>): string[] {
  const raw = fm.tags;
  const list = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string")
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  return list.map((t) => t.replace(/^#/, "")).filter((t) => t !== "");
}

function normFolder(f: string): string {
  return f.replace(/^\/+|\/+$/g, "");
}

function linkKey(s: string): string {
  return s.replace(/^\[\[|\]\]$/g, "").replace(/[|#].*$/s, "").replace(/\.md$/i, "");
}

class Evaluator {
  private cache = new Map<string, Value>();
  private active = new Set<string>();
  private depth = 0;
  private readonly budget: Budget;

  constructor(
    private readonly row: BaseRow,
    private readonly env: EvalEnv
  ) {
    this.budget = env.budget ?? { left: EVAL_STEP_BUDGET };
  }

  private charge(steps: number): void {
    this.budget.left -= steps;
    if (this.budget.left < 0) throw new EvalError("evaluation budget exceeded");
  }

  /** A value an expression built: it must stay small, and it costs in proportion to its size. */
  private made(v: Value): Value {
    const w = weight(v, MAX_VALUE_WEIGHT);
    if (w > MAX_VALUE_WEIGHT) throw new EvalError("value is too large");
    this.charge(1 + (w >> COST_SHIFT));
    return v;
  }

  private dateAt(ms: number): DateV {
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) throw new EvalError("date is out of range");
    return new DateV(ms);
  }

  /** A column or sort key: `file.x`, `formula.x`, `note.x` or a bare name. */
  property(id: string): Value {
    if (id.startsWith("file.")) return this.fileProp(id.slice(5));
    if (id.startsWith("formula.")) return this.formula(id.slice(8));
    return this.note(id.startsWith("note.") ? id.slice(5) : id);
  }

  note(name: string): Value {
    return Object.prototype.hasOwnProperty.call(this.row.frontmatter, name)
      ? fromJson(this.row.frontmatter[name])
      : null;
  }

  formula(name: string): Value {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const expr = this.env.formulas?.get(name);
    if (!expr) throw new EvalError(`formula.${name} is not defined`);
    if (this.active.has(name)) throw new EvalError(`formula.${name} refers to itself`);
    if (this.active.size >= MAX_FORMULA_DEPTH) throw new EvalError("formula references are nested too deeply");
    this.active.add(name);
    let value: Value = null;
    try {
      value = this.eval(expr, []);
    } catch (e) {
      this.env.warn?.(`formula.${name}: ${evalFailure(e).message}`);
    } finally {
      this.active.delete(name);
    }
    this.cache.set(name, value);
    return value;
  }

  fileProp(name: string): Value {
    const r = this.row;
    switch (name) {
      case "name":
        return baseName(r.path);
      case "basename":
        return baseName(r.path).replace(/\.[^.]*$/, "");
      case "path":
        return r.path;
      case "folder":
        return folderOf(r.path);
      case "ext":
        return "md";
      case "mtime":
        return new DateV(Math.floor(r.mtimeMs));
      case "tags":
        return tagsOf(r.frontmatter);
      case "links":
        return r.links.map((l) => new LinkV(l.resolved ?? l.target, null));
      case "properties":
        return fromJson(r.frontmatter);
      case "para":
        return paraOf(r.wikiPath);
      default:
        if (UNSUPPORTED_FILE_PROPS.has(name)) throw new EvalError(`file.${name} is not supported`);
        throw new EvalError(`file.${name} is not a known file property`);
    }
  }

  eval(e: Expr, scope: Array<Record<string, Value>>): Value {
    if (this.depth >= MAX_EVAL_DEPTH) throw new EvalError("expression is nested too deeply");
    this.charge(1);
    this.depth++;
    try {
      return this.evalNode(e, scope);
    } finally {
      this.depth--;
    }
  }

  private evalNode(e: Expr, scope: Array<Record<string, Value>>): Value {
    switch (e.k) {
      case "num":
      case "str":
      case "bool":
        return e.v;
      case "null":
        return null;
      case "list":
        return this.made(e.items.map((x) => this.eval(x, scope)));
      case "id": {
        for (let i = scope.length - 1; i >= 0; i--) {
          if (has(scope[i]!, e.name)) return scope[i]![e.name]!;
        }
        if (e.name === "file") return new LinkV(this.row.path, null);
        if (e.name === "note") return fromJson(this.row.frontmatter);
        if (e.name === "formula" || e.name === "this") throw new EvalError(`${e.name} cannot be used on its own`);
        return this.note(e.name);
      }
      case "member": {
        if (e.obj.k === "id" && !shadowed(scope, e.obj.name)) {
          if (e.obj.name === "file") return this.fileProp(e.name);
          if (e.obj.name === "note") return this.note(e.name);
          if (e.obj.name === "formula") return this.formula(e.name);
        }
        return this.member(this.eval(e.obj, scope), e.name);
      }
      case "index": {
        const obj = this.eval(e.obj, scope);
        const idx = this.eval(e.idx, scope);
        if (obj === null || idx === null) return null;
        if (Array.isArray(obj) && typeof idx === "number") return obj[idx] ?? null;
        if (typeof idx === "string" && typeof obj === "object" && !Array.isArray(obj) && !(obj instanceof DateV) && !(obj instanceof LinkV) && !(obj instanceof DurV)) {
          return Object.prototype.hasOwnProperty.call(obj, idx) ? obj[idx]! : null;
        }
        return null;
      }
      case "unary": {
        const v = this.eval(e.e, scope);
        if (e.op === "!") return !truthy(v);
        if (v === null) return null;
        if (typeof v === "number") return -v;
        throw new EvalError(`cannot apply '-' to ${typeName(v)}`);
      }
      case "bin":
        return this.binary(e, scope);
      case "call":
        return this.call(e, scope);
    }
  }

  private member(obj: Value, name: string): Value {
    if (obj === null) return null;
    if (typeof obj === "string") return name === "length" ? Array.from(obj).length : null;
    if (Array.isArray(obj)) return name === "length" ? obj.length : null;
    if (obj instanceof DateV) {
      const p = partsOf(obj.ms);
      return (["year", "month", "day", "hour", "minute", "second", "millisecond"] as const).includes(name as never)
        ? p[name as keyof DateParts]
        : null;
    }
    if (obj instanceof LinkV || obj instanceof DurV || typeof obj !== "object") return null;
    return Object.prototype.hasOwnProperty.call(obj, name) ? obj[name]! : null;
  }

  private binary(e: Extract<Expr, { k: "bin" }>, scope: Array<Record<string, Value>>): Value {
    const { op } = e;
    if (op === "&&") {
      const l = this.eval(e.l, scope);
      return truthy(l) ? this.eval(e.r, scope) : l;
    }
    if (op === "||") {
      const l = this.eval(e.l, scope);
      return truthy(l) ? l : this.eval(e.r, scope);
    }
    const l = this.eval(e.l, scope);
    const r = this.eval(e.r, scope);
    if (op === "==") return valuesEqual(l, r);
    if (op === "!=") return !valuesEqual(l, r);
    if (op === "<" || op === ">" || op === "<=" || op === ">=") return orderOp(op, l, r);
    return this.made(this.arithmetic(op, l, r));
  }

  private arithmetic(op: string, l: Value, r: Value): Value {
    if (l === null || r === null) return null;
    const bad = (): never => {
      throw new EvalError(`cannot apply '${op}' to ${typeName(l)} and ${typeName(r)}`);
    };
    if (typeof l === "number" && typeof r === "number") {
      switch (op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return l / r;
        default:
          return l % r;
      }
    }
    if (op === "+" && (typeof l === "string" || typeof r === "string") && !(l instanceof DateV)) {
      if (typeof l === "string" && r instanceof DateV) return bad();
      return display(l) + display(r);
    }
    if (l instanceof DateV) {
      if (op === "-" && r instanceof DateV) return l.ms - r.ms;
      if (op === "+" || op === "-") {
        const d = r instanceof DurV ? r : typeof r === "string" ? parseDuration(r) : null;
        if (!d) return bad();
        return this.dateAt(addDuration(l.ms, d, op === "+" ? 1 : -1));
      }
      return bad();
    }
    if (l instanceof DurV) {
      if (op === "*" && typeof r === "number") return new DurV(Math.trunc(l.months * r), l.ms * r);
      if (op === "+" && r instanceof DurV) return new DurV(l.months + r.months, l.ms + r.ms);
      if (op === "-" && r instanceof DurV) return new DurV(l.months - r.months, l.ms - r.ms);
      if (op === "+" && r instanceof DateV) return this.dateAt(addDuration(r.ms, l, 1));
    }
    return bad();
  }

  private call(e: Extract<Expr, { k: "call" }>, scope: Array<Record<string, Value>>): Value {
    const ev = (x: Expr) => this.eval(x, scope);
    if (e.obj === null) {
      const v = this.global(e, ev);
      return e.name === "if" ? v : this.made(v);
    }

    // `file.method(...)` reads the concept itself, not a value.
    if (e.obj.k === "id" && e.obj.name === "file" && !shadowed(scope, "file")) {
      const args = e.args.map(ev);
      return this.fileMethod(e.name, args);
    }

    const recv = ev(e.obj);
    const lazy = e.name === "filter" || e.name === "map" || e.name === "reduce";
    if (lazy && Array.isArray(recv)) return this.made(this.listLambda(e, recv, scope));
    const args = lazy ? [] : e.args.map(ev);
    return this.made(this.method(recv, e.name, args));
  }

  private listLambda(e: Extract<Expr, { k: "call" }>, list: Value[], scope: Array<Record<string, Value>>): Value {
    const body = e.args[0];
    if (!body) throw new EvalError(`${e.name}() needs an expression`);
    const run = (frame: Record<string, Value>) => this.eval(body, [...scope, frame]);
    if (e.name === "filter") return list.filter((value, index) => truthy(run({ value, index })));
    if (e.name === "map") return list.map((value, index) => run({ value, index }));
    let acc: Value = e.args[1] ? this.eval(e.args[1], scope) : null;
    list.forEach((value, index) => {
      acc = run({ value, index, acc });
    });
    return acc;
  }

  private global(e: Extract<Expr, { k: "call" }>, ev: (x: Expr) => Value): Value {
    if (e.name === "if") {
      if (e.args.length < 2 || e.args.length > 3) throw new EvalError("if() takes 2 or 3 arguments");
      return truthy(ev(e.args[0]!)) ? ev(e.args[1]!) : e.args[2] ? ev(e.args[2]) : null;
    }
    const args = e.args.map(ev);
    const need = (n: number) => {
      if (args.length < n) throw new EvalError(`${e.name}() needs ${n} argument${n === 1 ? "" : "s"}`);
    };
    switch (e.name) {
      case "now":
        return new DateV(this.env.now);
      case "today":
        return new DateV(Math.floor(this.env.now / DAY_MS) * DAY_MS);
      case "number": {
        need(1);
        const v = args[0]!;
        if (typeof v === "number") return v;
        if (typeof v === "boolean") return v ? 1 : 0;
        if (v instanceof DateV) return v.ms;
        if (v instanceof DurV) return v.ms + v.months * 30 * DAY_MS;
        if (typeof v === "string") return v.trim() === "" ? null : Number.isNaN(Number(v)) ? null : Number(v);
        return null;
      }
      case "min":
      case "max": {
        need(1);
        const nums = args.flat() as Value[];
        if (nums.some((n) => typeof n !== "number")) throw new EvalError(`${e.name}() takes numbers`);
        if (nums.length === 0) return null;
        return e.name === "min" ? Math.min(...(nums as number[])) : Math.max(...(nums as number[]));
      }
      case "list": {
        need(1);
        return Array.isArray(args[0]) ? args[0] : [args[0]!];
      }
      case "date": {
        need(1);
        const d = asDate(args[0]!);
        if (!d) throw new EvalError("date() cannot read that value");
        return d;
      }
      case "duration": {
        need(1);
        const d = typeof args[0] === "string" ? parseDuration(args[0]) : args[0] instanceof DurV ? args[0] : null;
        if (!d) throw new EvalError("duration() cannot read that value");
        return d;
      }
      case "link": {
        need(1);
        const target = args[0]!;
        if (typeof target !== "string" && !(target instanceof LinkV)) throw new EvalError("link() needs a path");
        const shown = args[1] === undefined || args[1] === null ? null : display(args[1]);
        return new LinkV(target instanceof LinkV ? target.target : target, shown);
      }
      case "escapeHTML": {
        need(1);
        return display(args[0]!)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }
      default:
        throw new EvalError(`${e.name}() is not supported`);
    }
  }

  private fileMethod(name: string, args: Value[]): Value {
    const r = this.row;
    const strs = (): string[] => {
      if (args.some((a) => typeof a !== "string")) throw new EvalError(`${name}() takes text`);
      return args as string[];
    };
    switch (name) {
      case "hasTag": {
        const tags = tagsOf(r.frontmatter).map(asciiLower);
        return strs().some((want) => {
          const w = asciiLower(want.replace(/^#/, ""));
          return tags.some((t) => t === w || t.startsWith(`${w}/`));
        });
      }
      case "inFolder": {
        const [folderArg] = strs();
        if (folderArg === undefined) throw new EvalError("inFolder() needs a folder");
        const f = normFolder(folderArg);
        if (f === "") return true;
        const within = (p: string) => p === f || p.startsWith(`${f}/`);
        return within(folderOf(r.path)) || within(folderOf(r.wikiPath));
      }
      case "hasProperty": {
        const [p] = strs();
        return p !== undefined && Object.prototype.hasOwnProperty.call(r.frontmatter, p);
      }
      case "hasLink": {
        const want = args[0] instanceof LinkV ? args[0].target : args[0];
        if (typeof want !== "string") throw new EvalError("hasLink() needs a file name or link");
        const key = linkKey(want);
        const tail = baseName(key);
        return r.links.some((l) =>
          [l.target, l.resolved ?? ""].some((c) => c !== "" && (linkKey(c) === key || baseName(linkKey(c)) === tail))
        );
      }
      case "asLink":
        return new LinkV(r.path, args[0] === undefined || args[0] === null ? null : display(args[0]));
      default:
        throw new EvalError(`file has no method '${name}'`);
    }
  }

  private method(recv: Value, name: string, args: Value[]): Value {
    // Valid on every type.
    if (name === "isTruthy") return truthy(recv);
    if (name === "toString") return display(recv);
    if (name === "isType") {
      if (typeof args[0] !== "string") throw new EvalError("isType() needs a type name");
      return typeName(recv) === args[0];
    }
    if (recv === null) {
      if (name === "isEmpty") return true;
      return name === "contains" || name === "containsAll" || name === "containsAny" ? false : null;
    }
    const num = (i: number): number => {
      const a = args[i];
      if (typeof a !== "number") throw new EvalError(`${name}() needs a number`);
      return a;
    };
    const text = (i: number): string => {
      const a = args[i];
      if (typeof a !== "string") throw new EvalError(`${name}() needs text`);
      return a;
    };
    const missing = (): never => {
      throw new EvalError(`${typeName(recv)} has no method '${name}'`);
    };

    if (typeof recv === "string") {
      switch (name) {
        case "isEmpty":
          return recv === "";
        case "contains":
          return recv.includes(text(0));
        case "containsAll":
          return args.every((_, i) => recv.includes(text(i)));
        case "containsAny":
          return args.some((_, i) => recv.includes(text(i)));
        case "startsWith":
          return recv.startsWith(text(0));
        case "endsWith":
          return recv.endsWith(text(0));
        case "lower":
          return recv.toLowerCase();
        case "trim":
          return recv.trim();
        case "title":
          return recv.replace(/(^|\s)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase());
        case "reverse":
          return Array.from(recv).reverse().join("");
        case "repeat": {
          const n = num(0);
          if (!(n >= 0 && n <= 10000)) throw new EvalError("repeat() count must be between 0 and 10000");
          // Checked before building, so a huge result is never allocated.
          if (recv.length * Math.trunc(n) > MAX_VALUE_WEIGHT) throw new EvalError("value is too large");
          return recv.repeat(Math.trunc(n));
        }
        case "replace":
          return recv.replace(text(0), () => text(1));
        case "slice":
          return recv.slice(num(0), args[1] === undefined ? undefined : num(1));
        case "split": {
          const parts = recv.split(text(0));
          return args[1] === undefined ? parts : parts.slice(0, num(1));
        }
        default:
          return missing();
      }
    }
    if (typeof recv === "number") {
      switch (name) {
        case "isEmpty":
          return false;
        case "abs":
          return Math.abs(recv);
        case "ceil":
          return Math.ceil(recv);
        case "floor":
          return Math.floor(recv);
        case "round": {
          if (args[0] === undefined) return Math.round(recv);
          const f = 10 ** Math.trunc(num(0));
          return Math.round(recv * f) / f;
        }
        case "toFixed": {
          const p = num(0);
          if (!(p >= 0 && p <= 100)) throw new EvalError("toFixed() precision must be between 0 and 100");
          return toFixed(recv, Math.trunc(p));
        }
        default:
          return missing();
      }
    }
    if (Array.isArray(recv)) {
      this.charge(recv.length * Math.max(1, args.length));
      switch (name) {
        case "isEmpty":
          return recv.length === 0;
        case "contains":
          return recv.some((x) => valuesEqual(x, args[0] ?? null));
        case "containsAll":
          return args.every((a) => recv.some((x) => valuesEqual(x, a)));
        case "containsAny":
          return args.some((a) => recv.some((x) => valuesEqual(x, a)));
        case "flat": {
          const out: Value[] = [];
          const push = (items: Value[]) => items.forEach((x) => (Array.isArray(x) ? push(x) : out.push(x)));
          push(recv);
          return out;
        }
        case "join":
          return recv.map(display).join(args[0] === undefined ? "," : text(0));
        case "reverse":
          return [...recv].reverse();
        case "slice":
          return recv.slice(num(0), args[1] === undefined ? undefined : num(1));
        case "sort":
          return [...recv].sort(compareValues);
        case "unique": {
          const out: Value[] = [];
          for (const x of recv) {
            this.charge(out.length >> 4);
            if (!out.some((y) => valuesEqual(x, y))) out.push(x);
          }
          return out;
        }
        case "sum":
        case "mean":
        case "min":
        case "max":
        case "median": {
          const nums = recv.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
          return aggregate(name, nums);
        }
        default:
          return missing();
      }
    }
    if (recv instanceof DateV) {
      switch (name) {
        case "isEmpty":
          return false;
        case "date":
          return new DateV(floorDiv(recv.ms, DAY_MS) * DAY_MS);
        case "format":
          return formatDate(recv.ms, text(0));
        case "time": {
          const p = partsOf(recv.ms);
          return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
        }
        default:
          return missing();
      }
    }
    if (typeof recv === "boolean" || recv instanceof LinkV || recv instanceof DurV) {
      return name === "isEmpty" ? false : missing();
    }
    switch (name) {
      case "isEmpty":
        return Object.keys(recv).length === 0;
      case "keys":
        return Object.keys(recv);
      case "values":
        return Object.values(recv);
      default:
        return missing();
    }
  }
}

/** The arithmetic summaries over a list of finite numbers; null when empty. */
export function aggregate(name: string, nums: number[]): number | null {
  if (nums.length === 0) return null;
  let sum = 0;
  for (const n of nums) sum += n;
  switch (name) {
    case "sum":
      return sum;
    case "mean":
      return sum / nums.length;
    case "min":
      return nums.reduce((a, b) => (b < a ? b : a));
    case "max":
      return nums.reduce((a, b) => (b > a ? b : a));
    case "median": {
      const s = [...nums].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    }
    default: {
      // stddev: the population standard deviation.
      const mean = sum / nums.length;
      let sq = 0;
      for (const n of nums) sq += (n - mean) * (n - mean);
      return Math.sqrt(sq / nums.length);
    }
  }
}

export { Evaluator };

/** Evaluate one expression against one concept. Throws `ExprError` / `EvalError`. */
export function evalExpression(src: string, row: BaseRow, env: EvalEnv): Value {
  const expr = parseExpr(src);
  const found: Findings = { errors: [], warnings: [] };
  checkExpr(expr, new Set(env.formulas?.keys() ?? []), found);
  if (found.errors.length > 0) throw new ExprError(found.errors[0]!);
  try {
    return new Evaluator(row, env).eval(expr, []);
  } catch (e) {
    throw evalFailure(e);
  }
}

/** Evaluate a parsed expression with extra names in scope (custom summaries). */
export function evalWith(e: Expr, row: BaseRow, env: EvalEnv, names: Record<string, Value>): Value {
  try {
    return new Evaluator(row, env).eval(e, [names]);
  } catch (err) {
    throw evalFailure(err);
  }
}
