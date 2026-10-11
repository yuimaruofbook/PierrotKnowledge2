/**
 * Filesystem questions asked all over the backend, answered one way.
 *
 * Both follow symlinks and treat any error as "no": a path that cannot be
 * stat'ed is not one the caller can use. `uninstall.ts` keeps its own lstat
 * version, because a symlink must count without being followed; `update.ts`
 * keeps its Bun.file-based one, whose edge cases an update depends on.
 */

import { stat } from "fs/promises";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
