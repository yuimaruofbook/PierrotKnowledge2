/**
 * OKF v0.2 concept rules: identity, reserved files, conformance, trust.
 */

import type { ConceptFrontmatter, Status, TrustTier, VerifiedEntry } from "../types";
import { messages } from "../messages";
import { readScalar, splitFrontmatter } from "./frontmatter";
import { isWorkspaceFilename } from "./workspace-files";

/** Reserved filenames carry no frontmatter and are not concepts (OKF §3). */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

/**
 * The agent contract. Lives in the wiki layer but is not knowledge.
 *
 * Kept apart from `RESERVED_FILENAMES` on purpose: OKF §3 reserves exactly
 * `index.md` and `log.md`, and `AGENTS.md` is the LLM Wiki pattern's schema
 * file, not part of the format. Folding it in would make this implementation
 * claim something about OKF that OKF does not say.
 */
export const CONTRACT_FILENAME = "agents.md";

export const DEFAULT_CONCEPT_TYPE = "Concept";

export function isReservedFilename(name: string): boolean {
  return (RESERVED_FILENAMES as readonly string[]).includes(name.toLowerCase());
}

export function basenameOf(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * True when a path denotes a concept document.
 *
 * Excludes the OKF reserved files, the agent contract and the orientation
 * files (`MAP.md`, `human.md`, `Task.md`): all of them live in the wiki layer,
 * none of them is knowledge, and indexing them would put instructions, a
 * changelog and someone's task list into the same results as facts.
 */
export function isConceptPath(path: string): boolean {
  const name = basenameOf(path).toLowerCase();
  return (
    /\.md$/i.test(path) &&
    !isReservedFilename(name) &&
    name !== CONTRACT_FILENAME &&
    !isWorkspaceFilename(name)
  );
}

/** Concept id = path without the `.md` suffix, normalised to `/` (OKF §2). */
export function conceptIdFromRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/\.md$/i, "");
}

export function relPathFromConceptId(id: string): string {
  return `${id.replace(/\\/g, "/")}.md`;
}

export interface ConformanceResult {
  ok: boolean;
  errors: string[];
}

/**
 * Check a document against OKF §11.
 *
 * §11 requires exactly three things: parseable frontmatter on every
 * non-reserved `.md`, a non-empty `type` in it, and reserved files following
 * §8/§9. Nothing else is grounds for rejection, so nothing else is reported as
 * an error here.
 *
 * `bundleRelPath` must be relative to the *bundle root* (the wiki layer), since
 * the root `index.md` is the one reserved file permitted to carry frontmatter —
 * an `okf_version` key, and only that (§8).
 */
export function checkConformance(bundleRelPath: string, raw: string): ConformanceResult {
  const errors: string[] = [];
  const { yaml } = splitFrontmatter(raw);
  const path = bundleRelPath.replace(/\\/g, "/").replace(/^\/+/, "");

  // The contract file and the orientation files are prose and tables for
  // agents, not concepts: they have no frontmatter requirement and nothing to
  // check. They are not folded into §3's reserved set, which is exactly
  // `index.md` and `log.md` and says nothing about these.
  const basename = basenameOf(path).toLowerCase();
  if (basename === CONTRACT_FILENAME || isWorkspaceFilename(basename)) {
    return { ok: true, errors: [] };
  }

  if (isReservedFilename(basenameOf(path))) {
    if (yaml === null) return { ok: true, errors: [] };

    // §8: the bundle-root index.md MAY carry okf_version. Anywhere else, and
    // for any other key, frontmatter on a reserved file is non-conformant.
    if (path === "index.md") {
      const keys = topLevelKeys(yaml);
      const extra = keys.filter((key) => key !== "okf_version");
      if (extra.length) {
        errors.push(messages.rootIndexExtraKeys(extra));
      }
    } else {
      errors.push(messages.reservedHasFrontmatter);
    }

    return { ok: errors.length === 0, errors };
  }

  if (yaml === null) {
    return { ok: false, errors: [messages.missingFrontmatter] };
  }

  if (!readScalar(yaml, "type")) {
    errors.push(messages.missingType);
  }

  return { ok: errors.length === 0, errors };
}

/** Top-level keys of a frontmatter block, without a full YAML parse. */
function topLevelKeys(yaml: string): string[] {
  const keys: string[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:/);
    if (match) keys.push(match[1]!);
  }
  return keys;
}

export function deriveTrustTier(verified?: VerifiedEntry | VerifiedEntry[]): TrustTier {
  if (!verified) return "unverified";
  const list = Array.isArray(verified) ? verified : [verified];
  if (list.length === 0) return "unverified";
  if (list.some((v) => String(v?.by ?? "").startsWith("human:"))) return "human-reviewed";
  return "machine-confirmed";
}

export function effectiveStatus(frontmatter: ConceptFrontmatter): Status {
  const status = frontmatter.status;
  return status === "draft" || status === "deprecated" ? status : "stable";
}

/**
 * Staleness per OKF §5.5: a concept is stale when `today >= stale_after`.
 *
 * `stale_after` is an absolute `YYYY-MM-DD` date, not a TTL, which keeps this a
 * plain date comparison independent of when the concept was read. Compared as
 * dates rather than instants so a concept goes stale at the start of the named
 * day in the reader's terms, not at whatever hour the string parsed to.
 */
export function isStale(frontmatter: ConceptFrontmatter, now = new Date()): boolean {
  const staleAfter = frontmatter.stale_after;
  if (typeof staleAfter !== "string" || !staleAfter.trim()) return false;

  const day = staleAfter.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;

  return toIsoDay(now) >= day;
}

function toIsoDay(date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function conceptTitle(id: string, frontmatter: ConceptFrontmatter): string {
  const title = frontmatter.title;
  return typeof title === "string" && title.trim() ? title : basenameOf(id);
}
