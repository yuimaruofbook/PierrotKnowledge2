/**
 * Where this app keeps small per-user files, and where it used to.
 *
 * The application data folder carries the app's display name, so renaming the
 * app moves it. An existing install has a session and a registry of MCP
 * servers in the old folder; moving without looking there would present as
 * data loss — the app would come up blank with every connection gone.
 *
 * So writes go to the current location and reads fall back to the previous
 * one. Nothing is copied or deleted behind the user's back: the old file stays
 * where it is until they overwrite it by saving.
 */

import { homedir } from "os";
import { join } from "path";
import { APP_DIR, APP_ID, LEGACY_APP_DIR } from "../shared/app";

function baseFor(dirName: string): string {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, dirName);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", dirName);
  }
  // Linux uses the stable machine id rather than the display name, so it is
  // unaffected by the rename and needs no fallback.
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, APP_ID);
}

/** The path to write to. */
export function appDataPath(file: string): string {
  return join(baseFor(APP_DIR), file);
}

/**
 * Paths to try when reading, current first.
 *
 * One entry on Linux, where the directory never changed.
 */
export function appDataReadPaths(file: string): string[] {
  const current = appDataPath(file);
  const legacy = join(baseFor(LEGACY_APP_DIR), file);
  return current === legacy ? [current] : [current, legacy];
}
