/**
 * Create (or top up) a knowledge bundle.
 *
 * Called by the setup scripts, and usable on its own:
 *
 *   bun run scripts/init-bundle.ts "C:/Users/me/Documents/PierrotKnowledge2"
 *
 * Idempotent — existing files are never overwritten, so pointing it at a
 * folder that already holds notes just adds the missing scaffolding.
 */

import { resolve } from "node:path";
import { scaffoldBundle } from "../src/bun/okf/scaffold";
import { Workspace } from "../src/bun/workspace";

const target = process.argv[2];
if (!target) {
  console.error("Usage: bun run scripts/init-bundle.ts <bundle-path>");
  process.exit(1);
}

const root = resolve(target);

const { created } = await scaffoldBundle(root);

if (created.length) {
  console.log(`    Created: ${created.join(", ")}`);
} else {
  console.log("    Bundle already set up — nothing to add");
}

// Opening it once builds the search index, so the first launch is instant
// rather than pausing to index a folder the user just pointed us at.
const workspace = new Workspace({ watch: false });
try {
  const info = await workspace.open(root);

  // Scaffolding writes index.md before the concepts exist, and `open` will not
  // overwrite a file that is already there — so without this the starter bundle
  // ships with an index that lists nothing.
  const { rows } = await workspace.rebuildIndex();

  const stats = workspace.indexStats();
  console.log(
    `    Indexed ${rows} concept(s), ${stats.chunks} chunk(s) at ${info.root}`
  );
  if (info.nonConformantCount > 0) {
    console.log(`    ${info.nonConformantCount} document(s) do not meet OKF v0.2 — see the app`);
  }
} finally {
  await workspace.close();
}
