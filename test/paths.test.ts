import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { BundlePaths, LayerViolationError, PathEscapeError, isContained } from "../src/bun/okf/paths";

const ROOT = resolve("/tmp/okf-bundle-test");

describe("isContained", () => {
  test("accepts the directory itself and its children", () => {
    expect(isContained(ROOT, ROOT)).toBe(true);
    expect(isContained(ROOT, join(ROOT, "wiki", "a.md"))).toBe(true);
  });

  test("rejects a sibling with a shared prefix", () => {
    // The classic prefix bug: "/tmp/okf-bundle-test-evil" starts with the root.
    expect(isContained(ROOT, `${ROOT}-evil/secret`)).toBe(false);
  });
});

describe("BundlePaths.resolve", () => {
  const paths = new BundlePaths(ROOT, "wiki");

  test("resolves ordinary relative paths", () => {
    expect(paths.resolve("wiki/a.md")).toBe(join(ROOT, "wiki", "a.md"));
    expect(paths.resolve("wiki\\a.md")).toBe(join(ROOT, "wiki", "a.md"));
  });

  test("rejects traversal in every spelling", () => {
    for (const attempt of [
      "../secret.md",
      "../../etc/passwd",
      "wiki/../../secret.md",
      "./../../secret.md",
      "wiki/..\\..\\secret.md",
    ]) {
      expect(() => paths.resolve(attempt)).toThrow(PathEscapeError);
    }
  });

  test("rejects a NUL byte", () => {
    expect(() => paths.resolve("wiki/a.md\0.png")).toThrow(PathEscapeError);
  });

  test("rejects an absolute path outside the bundle", () => {
    expect(() => paths.resolve(resolve("/etc/passwd"))).toThrow(PathEscapeError);
  });

  test("accepts an absolute path already inside the bundle", () => {
    const inside = join(ROOT, "wiki", "a.md");
    expect(paths.resolve(inside)).toBe(inside);
  });

  test("collapses redundant segments instead of escaping", () => {
    expect(paths.resolve("wiki/./sub/../a.md")).toBe(join(ROOT, "wiki", "a.md"));
  });
});

describe("BundlePaths layers", () => {
  const paths = new BundlePaths(ROOT, "wiki");

  test("labels each layer", () => {
    expect(paths.layerOf("raw/source.txt")).toBe("raw");
    expect(paths.layerOf(".rag/fts.sqlite")).toBe("rag");
    expect(paths.layerOf("wiki/a.md")).toBe("wiki");
    expect(paths.layerOf("AGENTS.md")).toBeUndefined();
  });

  test("raw/ is writable by a human and closed to an agent", () => {
    // raw/ is the human's inbox, not an immutable vault: people drop originals
    // in. What it must never hold is material an agent invented.
    expect(() => paths.assertWritable("raw/a.md", "human")).not.toThrow();
    expect(() => paths.assertWritable("raw/a.md", "agent")).toThrow(LayerViolationError);
  });

  test("the derived layer is open to both", () => {
    // .rag/ is rebuildable, so nothing there is precious enough to lock.
    expect(() => paths.assertWritable(".rag/fts.sqlite", "human")).not.toThrow();
    expect(() => paths.assertWritable(".rag/fts.sqlite", "agent")).not.toThrow();
  });

  test("refuses agent writes that reach raw/ indirectly", () => {
    // A string-prefix check on "raw/" misses all of these.
    for (const attempt of ["./raw/a.md", "raw\\a.md", "wiki/../raw/a.md"]) {
      expect(() => paths.assertWritable(attempt, "agent")).toThrow(LayerViolationError);
    }
  });

  test("allows writes to the wiki layer and the bundle root", () => {
    expect(paths.assertWritable("wiki/a.md")).toBe(join(ROOT, "wiki", "a.md"));
    expect(paths.assertWritable("AGENTS.md")).toBe(join(ROOT, "AGENTS.md"));
  });

  test("does not confuse a rawer-looking sibling with the raw layer", () => {
    expect(paths.layerOf("rawdata/a.md")).toBeUndefined();
  });
});

describe("BundlePaths without a wiki directory", () => {
  const flat = new BundlePaths(ROOT, "");

  test("treats the root as the wiki layer", () => {
    expect(flat.wikiRoot).toBe(ROOT);
    expect(flat.relPathOfId("note")).toBe("note.md");
    expect(flat.indexMdPath).toBe(join(ROOT, "index.md"));
  });

  test("still keeps agents out of raw/", () => {
    expect(() => flat.assertWritable("raw/a.md", "agent")).toThrow(LayerViolationError);
    expect(() => flat.assertWritable("raw/a.md", "human")).not.toThrow();
  });
});

describe("path comparison across platforms", () => {
  test("containment ignores case where the filesystem does", () => {
    // Windows and macOS are both case-insensitive by default. This is not
    // cosmetic: `isContained` is what keeps agents out of `raw/`, and a
    // case-sensitive comparison on a case-insensitive volume lets `RAW/x.md`
    // pass the check and then land in `raw/` anyway.
    const insensitive = process.platform === "win32" || process.platform === "darwin";

    expect(isContained("/bundle/raw", "/bundle/RAW/note.md")).toBe(insensitive);
    // Same case always matches, everywhere.
    expect(isContained("/bundle/raw", "/bundle/raw/note.md")).toBe(true);
  });

  test("a sibling sharing a prefix is never inside", () => {
    // `raw-archive` starts with `raw` as a string but is a different folder;
    // treating it as inside would block writes that should be allowed.
    expect(isContained("/bundle/raw", "/bundle/raw-archive/note.md")).toBe(false);
  });
});
