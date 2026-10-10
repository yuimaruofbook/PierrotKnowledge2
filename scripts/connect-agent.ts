/**
 * Register this bundle's MCP server with one agent runtime.
 *
 * Called by `setup.ps1 -Connect`, once per detected runtime. It exists so the
 * merge logic has exactly one implementation: PowerShell could rewrite a JSON
 * or TOML file, but then "do not destroy the user's config" would be written
 * twice and tested once.
 *
 *   bun run scripts/connect-agent.ts <target-id> <bundle-path>
 *   bun run scripts/connect-agent.ts --all <bundle-path>
 */

import { resolve } from "path";
import { connectAllTargets, connectTarget, findTarget } from "../src/bun/connect/targets";

const [targetId, bundlePath] = process.argv.slice(2);

if (!targetId || !bundlePath) {
  console.error("usage: connect-agent.ts <target-id>|--all <bundle-path>");
  process.exit(2);
}

const projectRoot = resolve(import.meta.dir, "..");

/**
 * Sweep every host in one call.
 *
 * Detection and merging stay in `connectAllTargets`, so a caller in another
 * language — `setup.sh` — never has to know which hosts exist or what shape
 * each config is. One host failing does not fail the rest, which is why the
 * exit code counts only genuine failures and not a tool that is not installed.
 */
if (targetId === "--all") {
  const outcomes = await connectAllTargets({
    projectRoot,
    bundleRoot: resolve(bundlePath),
  });

  for (const outcome of outcomes) {
    if (outcome.status === "skipped") continue;
    if (outcome.status === "manual") {
      console.log(
        `  ${outcome.label}: ${outcome.snippet ? "次の JSON を貼り付けてください" : "次のコマンドを実行してください"}`
      );
      // Every line indented, so a multi-line snippet stays one readable block.
      console.log((outcome.command ?? "").replace(/^/gm, "    "));
      continue;
    }
    if (outcome.status === "failed") {
      console.error(`  ${outcome.label}: ${outcome.reason}`);
      continue;
    }
    const note = outcome.status === "unchanged" ? " (既に設定済み)" : "";
    console.log(`  ${outcome.label}: ${outcome.path}${note}`);
  }

  const connected = outcomes.filter(
    (o) => o.status === "connected" || o.status === "unchanged"
  ).length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  console.log(`\n  ${connected} 件を設定しました（未インストール ${skipped} 件は対象外）`);

  process.exit(outcomes.some((o) => o.status === "failed") ? 1 : 0);
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
    projectRoot,
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
