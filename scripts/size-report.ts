/**
 * Report what the app actually weighs.
 *
 * Size is a stated design goal, so it gets a command rather than a one-off
 * measurement in a commit message — a regression should be visible before it
 * ships, not discovered later.
 *
 *   bun run size
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await dirSize(child) : (await stat(child)).size;
  }
  return total;
}

async function bundleSize(entrypoint: string): Promise<number> {
  const built = await Bun.build({
    entrypoints: [join(ROOT, entrypoint)],
    target: "bun",
    minify: true,
  });
  if (!built.success) throw new AggregateError(built.logs, `Failed to bundle ${entrypoint}`);
  let total = 0;
  for (const output of built.outputs) total += output.size;
  return total;
}

interface Row {
  label: string;
  bytes: number;
  note?: string;
}

const rows: Row[] = [];

// The Bun side, as it ships. There is no packaged main process any more —
// `okf ui` runs from source, and this is what an agent host spawns.
rows.push({
  label: "MCP server (standalone)",
  bytes: await bundleSize("src/bun/mcp/standalone.ts"),
  note: "our own code, nothing bundled around it",
});

const view = await dirSize(join(ROOT, "src/mainview/dist"));
rows.push({
  label: "Webview bundle",
  bytes: view,
  note: view === 0 ? "not built — run `bun run build:view`" : "HTML + CSS + JS",
});

const icons = await dirSize(join(ROOT, "assets"));
rows.push({
  label: "Icons",
  bytes: icons,
  note: icons === 0 ? "not generated — run `bun run icon`" : "png + ico + iconset",
});

// The compiled headless server: the only artefact that carries a Bun runtime.
const build = await dirSize(join(ROOT, "build", "headless"));
if (build > 0) {
  rows.push({
    label: "Headless binary",
    bytes: build,
    note: "build/headless — includes the Bun runtime",
  });
}

const width = Math.max(...rows.map((row) => row.label.length));
console.log("");
for (const row of rows) {
  const size = human(row.bytes).padStart(9);
  console.log(`  ${row.label.padEnd(width)}  ${size}   ${row.note ?? ""}`);
}
console.log("");

if (build === 0) {
  console.log("  Headless size needs a build: `bun run build:headless`\n");
}
