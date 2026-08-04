/**
 * Skills: reusable procedure documents an agent loads only when it needs them.
 *
 * A Skill is a folder under `skills/` holding a `SKILL.md` plus whatever
 * supporting files it wants. The frontmatter carries `name` and `description`;
 * everything else is prose.
 *
 * The split matters more than it looks. `description` is the *only* part that
 * is always in context — it is what an agent reads to decide whether the body
 * is worth loading at all. So the description is a routing key, not a summary,
 * and the body is free to be long because it is paid for only when chosen.
 *
 * Pure and DOM-free: both processes and the tests parse Skills through here.
 */

import { splitFrontmatter } from "./frontmatter";
import { DEFAULT_PARA, parseParaClass, type ParaClass } from "./para";

/** Filename inside a skill folder. Fixed, so discovery needs no config. */
export const SKILL_FILE = "SKILL.md";

export interface SkillFrontmatter {
  name: string;
  description: string;
  /**
   * Extra trigger terms for selection.
   *
   * A description is written for a human deciding relevance; `when` is where
   * you put the vocabulary a *request* would actually use — synonyms, product
   * names, the Japanese for an English term.
   */
  when?: string[];
  tags?: string[];
  /**
   * Tools this skill expects to use. Advisory: it tells the reader what the
   * procedure touches. Nothing is enforced from here — the layer contract in
   * `paths.ts` is the only thing that decides what a write may do.
   */
  allowedTools?: string[];
  [key: string]: unknown;
}

export interface SkillDocument {
  /** Folder name, and the id used everywhere. */
  name: string;
  /** Grouping folder, e.g. `ingest`. Empty when the skill is uncategorised. */
  category: string;
  /** PARA class. Archived skills are kept but never suggested. */
  para: ParaClass;
  description: string;
  when: string[];
  tags: string[];
  allowedTools: string[];
  /** SKILL.md body, without frontmatter. Loaded on demand. */
  body: string;
  /** Problems that do not stop the skill from loading. */
  warnings: string[];
}

/** A skill reduced to what selection needs. This is the cheap surface. */
export interface SkillSummary {
  name: string;
  /** Grouping folder, e.g. `ingest`. Empty when uncategorised. */
  category: string;
  para: ParaClass;
  description: string;
  tags: string[];
  /** Rough cost of `skill_open` on this skill, so a budget can be planned. */
  bodyTokens: number;
  /** Extra files in the folder, relative to it. Not loaded until asked for. */
  resources: string[];
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest a description may be before it stops being cheap to keep in context. */
export const MAX_DESCRIPTION_LENGTH = 400;

/**
 * Estimate tokens without a tokenizer.
 *
 * Deliberately crude, and crude in the safe direction: CJK counts as roughly a
 * token per character and Latin as a token per four, which overshoots slightly
 * for both. A budget built on an overshoot degrades by loading one skill fewer;
 * one built on an undershoot blows the context window.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK ideographs, kana, and the Hangul/compatibility ranges around them.
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other / 4);
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((s) => s.trim());
}

/**
 * Parse a `SKILL.md`.
 *
 * Never throws. A malformed skill still loads with warnings attached, for the
 * same reason OKF §11 forbids rejecting a concept over optional fields: a
 * half-written skill in a folder the user is actively editing must not take
 * down discovery for every other skill beside it.
 */
export function parseSkill(raw: string, folderName: string, category = ""): SkillDocument {
  const { yaml, body } = splitFrontmatter(raw);
  const warnings: string[] = [];

  let record: Record<string, unknown> = {};
  if (yaml === null) {
    warnings.push("frontmatter がありません");
  } else {
    try {
      // Skills use a flat key/value frontmatter, so a line parser is enough and
      // keeps this module free of the YAML dependency that the Bun side owns.
      record = parseSimpleYaml(yaml);
    } catch {
      warnings.push("frontmatter を解析できません");
    }
  }

  const declaredName = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";

  if (!declaredName) {
    warnings.push("name がありません（フォルダ名を使います）");
  } else if (declaredName !== folderName) {
    warnings.push(`name (${declaredName}) がフォルダ名 (${folderName}) と一致しません`);
  }

  const name = declaredName || folderName;
  if (!NAME_RE.test(name)) {
    warnings.push("name は英小文字・数字・ハイフンのみ使えます");
  }

  if (!description) {
    warnings.push("description がありません — このスキルは選択されません");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    warnings.push(
      `description が長すぎます (${description.length} 文字 > ${MAX_DESCRIPTION_LENGTH})`
    );
  }

  return {
    name,
    category,
    // Skills carry PARA in frontmatter rather than in their path: their folders
    // already encode a category, and stacking a second axis on the tree would
    // make every skill four folders deep.
    para: parseParaClass(typeof record.para === "string" ? record.para : "") ?? DEFAULT_PARA,
    description,
    when: stringList(record.when),
    tags: stringList(record.tags),
    // Hyphenated in the file to match the Agent Skills convention people
    // already have in their editors; camelCase inside the code.
    allowedTools: stringList(record["allowed-tools"] ?? record.allowedTools),
    body: body.trim(),
    warnings,
  };
}

/**
 * A minimal YAML reader for flat frontmatter.
 *
 * Handles `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines —
 * which is the whole of what a skill header is allowed to be. Anything deeper
 * belongs in the body, and pulling in a YAML parser here would put a dependency
 * into the shared layer that the view would then have to bundle.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    // Only top-level keys; indented lines are handled as list items below.
    if (/^\s/.test(line)) continue;

    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1] as string;
    const rest = (match[2] ?? "").trim();

    if (rest) {
      out[key] = parseScalarOrFlowList(rest);
      continue;
    }

    // `key:` with the values on following `- item` lines.
    const items: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? "";
      const item = /^\s*-\s+(.*)$/.exec(next);
      if (!item) break;
      items.push(unquote((item[1] ?? "").trim()));
      i++;
    }
    out[key] = items;
  }

  return out;
}

function parseScalarOrFlowList(text: string): string | string[] {
  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((part) => unquote(part.trim()))
      .filter(Boolean);
  }
  return unquote(text);
}

function unquote(text: string): string {
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** Render a skill back to `SKILL.md` source. */
export function serializeSkill(skill: {
  name: string;
  description: string;
  para?: ParaClass;
  when?: string[];
  tags?: string[];
  allowedTools?: string[];
  body: string;
}): string {
  const lines = [`name: ${skill.name}`, `description: ${skill.description}`];
  // Only written when it is not the default, so a plain skill stays plain.
  if (skill.para && skill.para !== DEFAULT_PARA) lines.push(`para: ${skill.para}`);
  if (skill.when?.length) lines.push(`when: [${skill.when.join(", ")}]`);
  if (skill.tags?.length) lines.push(`tags: [${skill.tags.join(", ")}]`);
  if (skill.allowedTools?.length) {
    lines.push(`allowed-tools: [${skill.allowedTools.join(", ")}]`);
  }
  return ["---", ...lines, "---", "", skill.body.trim(), ""].join("\n");
}
