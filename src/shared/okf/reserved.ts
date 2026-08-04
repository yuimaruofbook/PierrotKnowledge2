/**
 * The two reserved files, `index.md` (OKF §8) and `log.md` (OKF §9).
 *
 * Both are plain Markdown with no frontmatter — the one exception the spec
 * allows is an `okf_version` key on the bundle-root `index.md`. Neither uses a
 * table: §8 specifies sectioned bullet lists and §9 specifies date-grouped
 * prose entries, newest first, so that a person can read and hand-edit them
 * without any tooling.
 */

import type { LogEntry } from "../types";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter";

export const OKF_VERSION = "0.2";

export interface IndexEntry {
  /** Link target, normally the bundle-absolute form (§6). */
  href: string;
  title: string;
  description?: string;
}

export interface IndexSection {
  heading: string;
  entries: IndexEntry[];
}

/** Escape text used inside a Markdown link label. */
function escapeLabel(value: string): string {
  return value.replace(/[\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ").trim();
}

/** Collapse a description to a single line; the entry format is one bullet. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Render an `index.md` (§8).
 *
 * `okfVersion` is emitted only for the bundle root, which is the sole place the
 * spec permits frontmatter on a reserved file.
 */
export function renderIndexMd(
  title: string,
  sections: readonly IndexSection[],
  options: { okfVersion?: string } = {}
): string {
  const lines: string[] = [`# ${oneLine(title) || "Knowledge Bundle"}`, ""];

  for (const section of sections) {
    if (section.entries.length === 0) continue;
    lines.push(`## ${oneLine(section.heading)}`, "");
    for (const entry of section.entries) {
      const description = entry.description ? ` - ${oneLine(entry.description)}` : "";
      lines.push(`* [${escapeLabel(entry.title)}](${encodeURI(entry.href)})${description}`);
    }
    lines.push("");
  }

  const body = lines.join("\n");
  return options.okfVersion ? joinFrontmatter(`okf_version: ${options.okfVersion}`, body) : body;
}

export function emptyIndexMd(title: string, options: { okfVersion?: string } = {}): string {
  return renderIndexMd(title, [], options);
}

/** Read `okf_version` from a bundle-root `index.md`, if declared. */
export function readOkfVersion(indexMd: string): string | null {
  const { yaml } = splitFrontmatter(indexMd);
  if (!yaml) return null;
  const match = yaml.match(/^okf_version[ \t]*:[ \t]*(.+)$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
}

// ---- log.md (§9) ----

/** Conventional leading word for a log entry. Not required by the spec. */
export type LogKind = "Creation" | "Update" | "Deprecation" | "Initialization" | "Move" | "Deletion";

const DATE_HEADING_RE = /^## (\d{4}-\d{2}-\d{2})[ \t]*$/;

export function emptyLogMd(heading = "Log"): string {
  return `# ${heading}\n`;
}

/** ISO 8601 `YYYY-MM-DD` for a timestamp (§9 requires this heading form). */
export function isoDate(at: string | Date): string {
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

/** Map an action onto the conventional bold leading word. */
export function logKindOf(action: string): LogKind {
  switch (action) {
    case "create":
      return "Creation";
    case "move":
      return "Move";
    case "delete":
      return "Deletion";
    case "deprecate":
      return "Deprecation";
    case "init":
      return "Initialization";
    default:
      return "Update";
  }
}

/**
 * Render one log entry as a prose bullet (§9).
 *
 * The actor is carried in the prose rather than a column, because the format is
 * a list of sentences, not a table.
 */
export function formatLogEntry(entry: LogEntry): string {
  const kind = logKindOf(entry.action);
  const note = entry.note ? ` ${oneLine(entry.note)}` : "";
  return `* **${kind}**: \`${oneLine(entry.path)}\` by ${oneLine(entry.actor)}.${note}`;
}

/**
 * Insert an entry into `log.md`, newest first (§9).
 *
 * Entries are grouped under `## YYYY-MM-DD` headings in descending date order,
 * so a new entry is *prepended* to today's section — creating it just below the
 * title if today has no entries yet. This is a read-modify-write rather than an
 * append; the format requires it, and the cost is bounded by the file, which
 * stays small in practice.
 */
export function insertLogEntry(existing: string, entry: LogEntry): string {
  const date = isoDate(entry.at);
  const bullet = formatLogEntry(entry);

  const source = existing.trim() ? existing : emptyLogMd();
  const lines = source.replace(/\s+$/, "").split("\n");

  // Find today's heading, or the first date heading that today should precede.
  let todayAt = -1;
  let insertSectionAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i]!.match(DATE_HEADING_RE);
    if (!heading) continue;
    const found = heading[1]!;
    if (found === date) {
      todayAt = i;
      break;
    }
    if (found < date) {
      insertSectionAt = i;
      break;
    }
  }

  if (todayAt !== -1) {
    // Newest first within the day: the bullet goes directly under the heading.
    let at = todayAt + 1;
    while (at < lines.length && !lines[at]!.trim()) at++;
    lines.splice(at, 0, bullet);
    return `${lines.join("\n")}\n`;
  }

  const section = [`## ${date}`, "", bullet, ""];

  if (insertSectionAt !== -1) {
    lines.splice(insertSectionAt, 0, ...section);
    return `${lines.join("\n")}\n`;
  }

  // No later section to sit above: append after the title (and any preamble).
  const titleAt = lines.findIndex((line) => line.startsWith("# "));
  const at = titleAt === -1 ? 0 : titleAt + 1;
  const spacer = lines[at]?.trim() ? [""] : [];
  lines.splice(at, 0, ...spacer, ...section);
  return `${lines.join("\n")}\n`;
}

/** Parse the date headings present in a log, newest first. */
export function logDates(log: string): string[] {
  return log
    .split("\n")
    .map((line) => line.match(DATE_HEADING_RE)?.[1])
    .filter((date): date is string => Boolean(date));
}
