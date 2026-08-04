/**
 * Session state that survives a restart.
 *
 * Without this the app opens blank every launch and the first thing a user has
 * to do — every single time — is find their folder again. The knowledge base is
 * still entirely in the Markdown files; this only remembers *which* folder was
 * open, so losing or deleting it costs one click, never any data.
 */

import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname } from "path";
import { appDataPath, appDataReadPaths } from "./app-paths";

const FILE = "session.json";

export interface SessionState {
  /** Absolute path of the last opened bundle. */
  bundlePath?: string;
  /** Bundle-relative path of the last opened document. */
  lastFile?: string;
  /**
   * Width of the writing column, as a percentage of the pane.
   *
   * A view preference rather than knowledge, so it lives here beside the other
   * things that would otherwise have to be redone on every launch.
   */
  editorWidth?: number;
}

/**
 * Where the OS expects an application to keep small state.
 *
 * Deliberately outside the bundle: the bundle holds knowledge, and scattering
 * app preferences through it would break "the folder is just Markdown".
 */
export function stateFilePath(): string {
  return appDataPath(FILE);
}

/**
 * Read the saved session.
 *
 * Any failure — missing file, unreadable, corrupt JSON — yields an empty
 * session rather than an error. State this cheap to rebuild is never worth
 * failing a launch over.
 */
export async function loadSession(): Promise<SessionState> {
  // Current location first, then the pre-rename one: an existing install must
  // still open on the folder it had open rather than coming up blank. A miss
  // moves on to the next candidate; only running out of them yields {}.
  for (const path of appDataReadPaths(FILE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    const state: SessionState = {};
    if (typeof record.bundlePath === "string") state.bundlePath = record.bundlePath;
    if (typeof record.lastFile === "string") state.lastFile = record.lastFile;
    // Clamped on read: a hand-edited or older file must not be able to set a
    // width that leaves the text unreadable or off-screen.
    if (typeof record.editorWidth === "number" && Number.isFinite(record.editorWidth)) {
      state.editorWidth = Math.min(100, Math.max(40, Math.round(record.editorWidth)));
    }
    return state;
  }

  return {};
}

export async function saveSession(state: SessionState): Promise<void> {
  try {
    const path = stateFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Losing the pointer costs one click next launch; never surface it.
  }
}

/** Merge a partial update into the saved session. */
export async function updateSession(patch: SessionState): Promise<void> {
  await saveSession({ ...(await loadSession()), ...patch });
}

export async function clearSession(): Promise<void> {
  try {
    await rm(stateFilePath(), { force: true });
  } catch {
    // Nothing to do; the next save overwrites it anyway.
  }
}
