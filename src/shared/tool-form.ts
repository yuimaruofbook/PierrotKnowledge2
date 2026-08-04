/**
 * Turning an MCP tool's JSON Schema into a form, and the form back into
 * arguments.
 *
 * This is what makes the connections panel generic: no service is named
 * anywhere, so a server that appears next year works the same day it ships.
 * Kept out of the view module so it can be tested without a DOM.
 */

import type { McpToolDefinition } from "./mcp-types";

export interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
}

export interface ToolField {
  name: string;
  required: boolean;
  schema: SchemaProperty;
}

/**
 * Read the fields a tool takes.
 *
 * Required fields come first: a server may declare twenty optional parameters,
 * and the two that actually have to be filled in should not be buried among
 * them. Order is otherwise the schema's own.
 */
export function fieldsOf(tool: McpToolDefinition): ToolField[] {
  const schema = tool.inputSchema as
    | { properties?: Record<string, SchemaProperty>; required?: string[] }
    | undefined;

  const properties = schema?.properties ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);

  const fields = Object.entries(properties).map(([name, property]) => ({
    name,
    required: required.has(name),
    schema: property && typeof property === "object" ? property : {},
  }));

  return [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)];
}

/**
 * Turn a form value into what the schema asks for.
 *
 * Deliberately forgiving. A blank field returns `undefined` so it is omitted
 * rather than sent as an empty string — servers routinely reject `""` for an
 * optional parameter — and a value that cannot be converted is passed through
 * as text, letting the server give its own error rather than inventing one
 * here.
 */
export function coerceArgument(raw: string, schema: SchemaProperty): unknown | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  switch (schema.type) {
    case "number":
    case "integer": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "boolean":
      return /^(true|1|yes|on)$/i.test(value);
    case "array":
      // Comma-separated is what a single-line field can reasonably offer.
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

/** Collect a whole form, dropping the fields left blank. */
export function collectArguments(
  fields: ToolField[],
  valueOf: (name: string) => string
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const value = coerceArgument(valueOf(field.name), field.schema);
    if (value !== undefined) args[field.name] = value;
  }
  return args;
}
