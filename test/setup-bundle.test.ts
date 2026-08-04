/**
 * Where the starter bundle goes.
 *
 * SETUP.bat died on a machine whose Documents folder was a junction into
 * OneDrive with the target gone. That state lies to every cheap check:
 * Test-Path reports the folder as present, `New-Item -Force` reports success
 * and creates nothing, and the first honest error is a write failing on
 * `.okf-write-test` — a file the user never asked for, in a folder they were
 * told already existed.
 *
 * The assertions live in test/setup-bundle.ps1, because the code under test is
 * PowerShell and rewriting it here would only test the rewrite. This file runs
 * that harness under every PowerShell host present: SETUP.bat invokes Windows
 * PowerShell 5.1, so passing under pwsh 7 alone proves nothing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

const harness = join(import.meta.dir, "setup-bundle.ps1");

/** PowerShell hosts to run under, newest first. */
const hosts = ["pwsh", "powershell"].filter((host) => Bun.which(host) !== null);

type Case = { name: string; ok: boolean; detail: string };

async function runHarness(host: string): Promise<{ cases: Case[]; output: string }> {
  const proc = Bun.spawn([host, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harness], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  const output = `${stdout}\n${stderr}`;
  // The harness also prints human-facing diagnostics; results are prefixed.
  const cases = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("RESULT\t"))
    .map((line) => {
      const [, verdict, name = "(unnamed)", detail = ""] = line.split("\t");
      return { name, ok: verdict === "PASS", detail };
    });

  return { cases, output };
}

const describeWindows = process.platform === "win32" && existsSync(harness) ? describe : describe.skip;

describeWindows("setup.ps1 bundle location", () => {
  for (const host of hosts) {
    test(`${host}: every case passes`, async () => {
      const { cases, output } = await runHarness(host);

      // A harness that produced nothing is a broken harness, not a pass.
      expect(cases.length, `no results from ${host}:\n${output}`).toBeGreaterThan(0);

      const failed = cases.filter((c) => !c.ok);
      expect(failed.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
    }, 60_000);
  }

  if (hosts.length === 0) {
    test.skip("no PowerShell host on PATH", () => {});
  }
});
