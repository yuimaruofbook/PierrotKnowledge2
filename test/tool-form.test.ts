/**
 * The generic tool form.
 *
 * The panel names no service, so these cases are taken from the shapes real
 * servers actually publish — Notion's search, GitHub's issue tools — because
 * that is what the form has to survive without per-service code.
 */

import { describe, expect, test } from "bun:test";
import { collectArguments, coerceArgument, fieldsOf } from "../src/shared/tool-form";

describe("reading a tool's schema", () => {
  test("required fields come first", () => {
    const fields = fieldsOf({
      name: "search",
      inputSchema: {
        properties: {
          page_size: { type: "integer" },
          query: { type: "string" },
          filter: { type: "object" },
        },
        required: ["query"],
      },
    });

    expect(fields.map((f) => f.name)).toEqual(["query", "page_size", "filter"]);
    expect(fields[0]?.required).toBe(true);
    expect(fields[1]?.required).toBe(false);
  });

  test("a tool that takes no arguments yields no fields", () => {
    expect(fieldsOf({ name: "list", inputSchema: { type: "object", properties: {} } })).toEqual([]);
    expect(fieldsOf({ name: "list" })).toEqual([]);
  });

  test("a malformed schema does not throw", () => {
    // Servers are third-party code; a bad schema must degrade, not crash.
    expect(fieldsOf({ name: "x", inputSchema: "nonsense" })).toEqual([]);
    expect(fieldsOf({ name: "x", inputSchema: { properties: null, required: "no" } })).toEqual([]);
  });

  test("a property that is not an object still produces a usable field", () => {
    const fields = fieldsOf({ name: "x", inputSchema: { properties: { a: null } } });
    expect(fields).toEqual([{ name: "a", required: false, schema: {} }]);
  });
});

describe("coercing a typed value", () => {
  test("blank means absent, not empty", () => {
    // An optional parameter sent as "" is rejected by many servers.
    expect(coerceArgument("", { type: "string" })).toBeUndefined();
    expect(coerceArgument("   ", { type: "string" })).toBeUndefined();
  });

  test("numbers", () => {
    expect(coerceArgument("25", { type: "integer" })).toBe(25);
    expect(coerceArgument(" 1.5 ", { type: "number" })).toBe(1.5);
  });

  test("a number that will not parse is passed through for the server to reject", () => {
    expect(coerceArgument("many", { type: "number" })).toBe("many");
  });

  test("booleans accept what a person would actually type", () => {
    for (const yes of ["true", "TRUE", "1", "yes", "on"]) {
      expect(coerceArgument(yes, { type: "boolean" })).toBe(true);
    }
    for (const no of ["false", "0", "no", "off", "nope"]) {
      expect(coerceArgument(no, { type: "boolean" })).toBe(false);
    }
  });

  test("arrays split on commas and drop the gaps", () => {
    expect(coerceArgument("a, b ,, c", { type: "array" })).toEqual(["a", "b", "c"]);
  });

  test("objects parse as JSON, and fall back to text when they cannot", () => {
    expect(coerceArgument('{"property":"時刻"}', { type: "object" })).toEqual({
      property: "時刻",
    });
    expect(coerceArgument("not json", { type: "object" })).toBe("not json");
  });

  test("an unknown or missing type is left as text", () => {
    expect(coerceArgument("値", {})).toBe("値");
    expect(coerceArgument("値", { type: "sometype" })).toBe("値");
  });

  test("Japanese survives untouched", () => {
    expect(coerceArgument("  設計メモ  ", { type: "string" })).toBe("設計メモ");
  });
});

describe("collecting a whole form", () => {
  const fields = fieldsOf({
    name: "search",
    inputSchema: {
      properties: {
        query: { type: "string" },
        page_size: { type: "integer" },
        filter: { type: "object" },
      },
      required: ["query"],
    },
  });

  test("blank optional fields are omitted entirely", () => {
    const args = collectArguments(fields, (name) => (name === "query" ? "設計" : ""));

    expect(args).toEqual({ query: "設計" });
    expect("page_size" in args).toBe(false);
  });

  test("filled fields arrive with their schema's type", () => {
    const values: Record<string, string> = {
      query: "OKF",
      page_size: "10",
      filter: '{"value":"page"}',
    };

    expect(collectArguments(fields, (name) => values[name] ?? "")).toEqual({
      query: "OKF",
      page_size: 10,
      filter: { value: "page" },
    });
  });

  test("an empty form sends nothing", () => {
    expect(collectArguments(fields, () => "")).toEqual({});
  });
});
