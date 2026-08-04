/**
 * Register this bundle's MCP server with one agent runtime.
 *
 * Called by `setup.ps1 -Connect`, once per detected runtime. It exists so the
 * merge logic has exactly one implementation: PowerShell could rewrite a JSON
 * or TOML file, but then "do not destroy the user's config" would be written
 * twice and tested once.
 *
 *   bun run scripts/connect-agent.ts <target-id> <bundle-path>
 */

import { resolve } from "path";
import { connectTarget, findTarget } from "../src/bun/connect/targets";

const [targetId, bundlePath] = process.argv.slice(2);

if (!targetId || !bundlePath) {
  console.error("usage: connect-agent.ts <target-id> <bundle-path>");
  process.exit(2);
}

try {
  const target = findTarget(targetId);
  if (target.kind !== "mcp-host") {
    // Model servers have nothing to configure; treated as a no-op success so a
    // caller looping over every runtime does not have to special-case them.
    console.log(`${target.label} is a model server — nothing to configure`);
    process.exit(0);
  }

  const result = await connectTarget({
    targetId,
    projectRoot: resolve(import.meta.dir, ".."),
    bundleRoot: resolve(bundlePath),
  });

  const suffix = result.unchanged
    ? " (既に設定済み)"
    : result.backup
      ? ` (backup: ${result.backup})`
      : "";
  console.log(`${result.path}${suffix}`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
