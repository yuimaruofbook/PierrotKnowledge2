/**
 * Activity summaries: log.md rows, regrouped so every line can be traced back.
 *
 * `audit_changes` answers "who changed what" as data. A summary answers it as
 * a page a person can read and an agent can cite — and because it is built
 * only from log rows, every statement carries the date and path of the row it
 * came from. Nothing here is inferred; a line that is not in the log is not in
 * the summary.
 *
 * Pure and DOM-free.
 */

import type { ParsedLogEntry } from "./reserved";

/** Where saved summaries live, inside the wiki layer. */
export const ACTIVITY_DIR = "activity";

/** The concept type a saved summary carries. */
export const ACTIVITY_TYPE = "ActivitySummary";

export interface ActivityFilter {
  /** ISO date; rows before it are left out. */
  since?: string;
  /** ISO date; rows after it are left out. */
  until?: string;
  /** Substring filter on the actor, as `audit_changes` does. */
  actor?: string;
}

export interface ActivitySummary {
  title: string;
  /** One-line description for the saved concept's frontmatter. */
  description: string;
  /** The effective range, taken from the rows when a bound was not given. */
  from: string;
  to: string;
  total: number;
  /** Markdown body, without the H1 (a saved concept adds its own). */
  body: string;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/** Rows inside the filter, in the log's own (newest-first) order. */
export function filterActivity(
  entries: readonly ParsedLogEntry[],
  filter: ActivityFilter
): ParsedLogEntry[] {
  return entries.filter(
    (entry) =>
      (!filter.since || entry.date >= filter.since) &&
      (!filter.until || entry.date <= filter.until) &&
      (!filter.actor || entry.actor.includes(filter.actor))
  );
}

/**
 * Summarise rows already filtered by `filterActivity`; `null` when empty.
 *
 * Ordering is fixed so two runs over the same log print the same page:
 * actors by row count then name, files by path, a file's rows in log order,
 * action totals by count then name.
 */
export function summarizeActivity(
  entries: readonly ParsedLogEntry[],
  options: ActivityFilter & { source: string }
): ActivitySummary | null {
  if (entries.length === 0) return null;

  let first = entries[0]!.date;
  let last = first;
  for (const entry of entries) {
    if (entry.date < first) first = entry.date;
    if (entry.date > last) last = entry.date;
  }
  const from = options.since ?? first;
  const to = options.until ?? last;

  const byAction = new Map<string, number>();
  const byActor = new Map<string, Map<string, ParsedLogEntry[]>>();
  const files = new Set<string>();
  for (const entry of entries) {
    byAction.set(entry.kind, (byAction.get(entry.kind) ?? 0) + 1);
    files.add(entry.path);
    let actorFiles = byActor.get(entry.actor);
    if (!actorFiles) byActor.set(entry.actor, (actorFiles = new Map()));
    const rows = actorFiles.get(entry.path);
    if (rows) rows.push(entry);
    else actorFiles.set(entry.path, [entry]);
  }

  const count = (rows: Map<string, ParsedLogEntry[]>) =>
    [...rows.values()].reduce((n, list) => n + list.length, 0);

  const lines: string[] = [
    `Source: \`${options.source}\` · ${entries.length} entries · ${byActor.size} actor(s) · ${files.size} file(s)`,
    "",
    // The filter is kept in the body: it is the only record of what the page
    // was narrowed to once the file name has been shortened.
    ...(options.actor ? [`Actor filter: ${oneLine(options.actor)}`, ""] : []),
    "## Totals by action",
    "",
  ];
  for (const [action, n] of [...byAction.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )) {
    lines.push(`* ${action}: ${n}`);
  }
  lines.push("");

  const actors = [...byActor.entries()].sort(
    (a, b) => count(b[1]) - count(a[1]) || a[0].localeCompare(b[0])
  );
  for (const [actor, actorFiles] of actors) {
    lines.push(`## ${oneLine(actor)} (${count(actorFiles)})`, "");
    for (const [path, rows] of [...actorFiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`### \`${path}\``, "");
      for (const row of rows) {
        const note = row.note ? ` — ${oneLine(row.note)}` : "";
        lines.push(`* ${row.date} · ${row.kind} · \`${row.path}\`${note}`);
      }
      lines.push("");
    }
  }

  const title = `Activity ${from} → ${to}${options.actor ? ` (${oneLine(options.actor)})` : ""}`;
  return {
    title,
    description: `${entries.length} log entries from ${from} to ${to}`,
    from,
    to,
    total: entries.length,
    body: lines.join("\n").replace(/\s+$/, ""),
  };
}

/** FNV-1a over the UTF-8 bytes, as 8 hex digits: short, and the same in every port. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The filename part for an actor filter: ASCII, with no `:` (illegal on Windows).
 *
 * When that squeezes the filter (a colon, Japanese letters, a cut at 40), two
 * different filters could land on one file and overwrite each other, so a hash
 * of the exact filter is appended.
 */
function actorSlug(actor: string): string {
  const slug = actor
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (slug === actor) return slug;
  return slug ? `${slug}-${shortHash(actor)}` : shortHash(actor);
}

/** Wiki-relative path of a saved summary: `activity/<from>_<to>[_<actor>].md`. */
export function activityRelPath(from: string, to: string, actor?: string): string {
  const slug = actor ? actorSlug(actor) : "";
  return `${ACTIVITY_DIR}/${from}_${to}${slug ? `_${slug}` : ""}.md`;
}

/** Heading of the folder's `index.md`. */
export const ACTIVITY_TITLE = "Activity";
