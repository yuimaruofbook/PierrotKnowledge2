/**
 * Argument parsing for the `okf` CLI.
 *
 * Deliberately small and dependency-free. The CLI's whole job is to hand a
 * `Record<string, unknown>` to the same `callTool` the MCP server uses, so the
 * only real work here is turning `--flag value` into that shape with the types
 * the tool's JSON Schema declares.
 *
 * Pure, so the mapping can be tested without spawning a process.
 */

export interface ParsedArgs {
  /** Positional arguments, in order. */
  positional: string[];
  /** `--key value`, `--key=value`, and `--flag` (true). */
  flags: Record<string, string | boolean>;
}

export function parseArgv(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (token === "--") {
      // Everything after `--` is positional, so a query can start with a dash.
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");

    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    // A bare flag is `true`; anything else consumes the following token.
    if (next === undefined || next.startsWith("--")) {
      flags[body] = true;
    } else {
      flags[body] = next;
      i++;
    }
  }

  return { positional, flags };
}

interface SchemaProperty {
  type?: string;
  items?: { type?: string };
  description?: string;
}

/**
 * Coerce a flag value to the type the tool's schema asks for.
 *
 * The same forgiving rules as the connections panel: a schema is a contract
 * with the tool, not with the person typing, and a server that declares
 * `number` should still accept something it can parse.
 */
export function coerce(value: string | boolean, schema: SchemaProperty): unknown {
  if (typeof value === "boolean") return value;

  switch (schema.type) {
    case "number":
    case "integer": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "boolean":
      return !/^(false|0|no|off)$/i.test(value);
    case "array":
      return value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    case "object":
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return value;
  }
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * Build a tool's argument object from the command line.
 *
 * Positional arguments fill the schema's `required` fields in order, so
 * `okf search "設計"` works without naming `--query`. Flags always win, so the
 * explicit form stays available when a value would look like a flag.
 */
export function buildToolArgs(
  schema: ToolSchema,
  parsed: ParsedArgs
): { args: Record<string, unknown>; missing: string[] } {
  const properties = schema.properties as Record<string, SchemaProperty>;
  const required = schema.required ?? [];
  const args: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parsed.flags)) {
    // Flags the CLI itself owns are not tool arguments.
    if (RESERVED_FLAGS.has(key)) continue;
    const property = properties[key];
    if (!property) continue;
    args[key] = coerce(value, property);
  }

  let next = 0;
  for (const key of required) {
    if (key in args) continue;
    const positional = parsed.positional[next];
    if (positional === undefined) continue;
    next++;
    args[key] = coerce(positional, properties[key] ?? {});
  }

  const missing = required.filter((key) => !(key in args));
  return { args, missing };
}

/** Flags handled by the CLI itself rather than passed to a tool. */
export const RESERVED_FLAGS = new Set(["bundle", "json", "quiet", "help", "version"]);
