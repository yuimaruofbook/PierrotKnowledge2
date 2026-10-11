/**
 * Context packs: the minimal set of files an agent should read for a task.
 *
 * Retrieval answers one question; a context pack starts one piece of work. It
 * reuses the same budgeted retrieval but regroups the passages by document —
 * because an agent plans in files, not fragments — and sizes the budget to the
 * model that will consume it. A local 8k-context worker and a frontier
 * supervisor read from the same bundle; what differs is only how much of it
 * each should be handed.
 */

import type { LinkedFile, RetrievalResult, RetrievedPassage } from "../../shared/types";
import { formatLinked } from "./retrieve";

/**
 * Which class of model the pack is for.
 *
 * "worker" is a cheap model doing delegated reading or drafting; "supervisor"
 * is an expensive model planning or verifying. The names describe the role in
 * a tiered setup, not any particular vendor.
 */
export type ContextTier = "worker" | "supervisor";

/**
 * Budgets per tier, in characters (see DEFAULT_BUDGET_CHARS for why not
 * tokens). A worker pack must fit comfortably inside a small local context
 * alongside its instructions; a supervisor pack can afford breadth because it
 * is requested rarely and read by a model with room to judge.
 */
export const TIER_DEFAULTS: Record<ContextTier, { budgetChars: number; limit: number }> = {
  worker: { budgetChars: 4000, limit: 6 },
  supervisor: { budgetChars: 12000, limit: 12 },
};

export interface ContextPackFile {
  path: string;
  id: string;
  title: string;
  type: string;
  /** One-line summary from the document's own frontmatter, when it has one. */
  description?: string;
  passages: RetrievedPassage[];
}

export interface ContextPackSkill {
  name: string;
  description: string;
  score: number;
}

/** A lesson a previous agent recorded, offered by title and description only. */
export interface ContextPackKnowhow {
  title: string;
  description: string;
  path: string;
  /** Who recorded it. */
  by: string;
  score: number;
}

export interface ContextPack {
  task: string;
  tier?: ContextTier;
  budgetChars: number;
  files: ContextPackFile[];
  /** Skills that match the task, so procedure travels with context. */
  skills: ContextPackSkill[];
  /** The best-matching know-how (at most 3), so past lessons travel with it too. */
  knowhow: ContextPackKnowhow[];
  /** Files reached by `link_depth`; empty unless links were followed. */
  linked: LinkedFile[];
  usedChars: number;
  truncated: boolean;
}

/**
 * Regroup ranked passages by document, keeping each document's first-hit rank.
 *
 * The passages arrive ordered by relevance; the file order preserves that by
 * first appearance, so the top of the pack is still the most relevant place to
 * start reading.
 */
export function groupPassages(
  retrieval: RetrievalResult,
  describe: (id: string) => string | undefined
): ContextPackFile[] {
  const byId = new Map<string, ContextPackFile>();

  for (const passage of retrieval.passages) {
    let file = byId.get(passage.id);
    if (!file) {
      const description = describe(passage.id);
      file = {
        path: passage.path,
        id: passage.id,
        title: passage.title,
        type: passage.type,
        ...(description ? { description } : {}),
        passages: [],
      };
      byId.set(passage.id, file);
    }
    file.passages.push(passage);
  }

  return [...byId.values()];
}

/**
 * Render a pack as Markdown for an agent.
 *
 * The shape mirrors formatRetrieval — paths are real files, anchors are
 * citable — but grouped so the agent can decide per file whether the excerpts
 * suffice or the whole file is worth a read_file.
 */
export function formatContextPack(pack: ContextPack): string {
  if (
    pack.files.length === 0 &&
    pack.skills.length === 0 &&
    pack.knowhow.length === 0 &&
    pack.linked.length === 0
  ) {
    return `No context found for: ${pack.task}\nThe bundle may not cover this yet — check unresolved_links for known gaps.`;
  }

  const lines: string[] = [
    `Context pack for: ${pack.task}`,
    [
      pack.tier ? `tier: ${pack.tier}` : "",
      `budget ${pack.budgetChars} chars`,
      `used ${pack.usedChars}`,
      `${pack.files.length} file(s)`,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
  ];

  for (const file of pack.files) {
    lines.push(`## \`${file.path}\` — ${file.title} (${file.type})`);
    if (file.description) lines.push(`_${file.description}_`);
    lines.push("");
    for (const passage of file.passages) {
      const heading = passage.headingPath.join(" › ");
      if (heading) lines.push(`### ${heading}`, "");
      lines.push(`anchor: \`${passage.anchor}\``, "", passage.text, "");
    }
  }

  if (pack.skills.length > 0) {
    lines.push("## Matching skills", "");
    for (const skill of pack.skills) {
      lines.push(`- **${skill.name}** (${skill.score.toFixed(2)}): ${skill.description}`);
    }
    lines.push("", "Open the one you follow with skill_open — do not open them all.", "");
  }

  if (pack.knowhow.length > 0) {
    lines.push("## Relevant know-how", "");
    for (const item of pack.knowhow) {
      const description = item.description ? `: ${item.description}` : "";
      const by = item.by ? ` (by ${item.by})` : "";
      lines.push(`- **${item.title}** (${item.score.toFixed(2)})${description} — \`${item.path}\`${by}`);
    }
    lines.push("", "Lessons from earlier work — read_file the ones that apply.", "");
  }

  if (pack.linked.length > 0) {
    lines.push(formatLinked(pack.linked), "");
  }

  if (pack.truncated) {
    lines.push(
      "_(truncated to fit the budget — raise budget_chars, or read_file the most relevant path)_"
    );
  }

  return lines.join("\n").trimEnd();
}
