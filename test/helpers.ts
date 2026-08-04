/**
 * Test-only filesystem helpers.
 */

import { rm } from "fs/promises";

/**
 * Remove a temporary directory, retrying briefly.
 *
 * On Windows a file can stay locked for a moment after the owning handle is
 * released — by the OS itself, an indexer, or antivirus. Retrying keeps that
 * from being reported as a test failure, while still surfacing a directory
 * that is genuinely still held open.
 */
export async function removeTempDir(path: string, attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await Bun.sleep(20 * (attempt + 1));
    }
  }
}
