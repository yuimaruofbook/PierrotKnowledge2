/**
 * What registering with every agent at once reports back.
 *
 * The writing is Bun-only — it edits other tools' config files and spawns
 * their CLIs — but the panel renders the report, so the shape lives here
 * rather than being imported across the process boundary.
 */

export type BulkConnectStatus =
  /** Our entry was written into the tool's config. */
  | "connected"
  /** The config already said exactly this; nothing was written. */
  | "unchanged"
  /** Its config is not ours to rewrite — the user runs a command instead. */
  | "manual"
  /** The tool was not found on this machine. */
  | "skipped"
  /** It was attempted and did not work. */
  | "failed";

export interface BulkConnectOutcome {
  target: string;
  label: string;
  status: BulkConnectStatus;
  /** The config file involved, so the report says what was touched. */
  path: string;
  /** Where the previous version was moved, when one was replaced. */
  backup?: string;
  /** For `manual`: the command to run. */
  command?: string;
  /** For `skipped` and `failed`: why. */
  reason?: string;
}
