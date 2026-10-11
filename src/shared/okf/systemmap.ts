/**
 * SYSTEMMAP.md: the map of the system itself.
 *
 * MAP.md answers "where is the thing I need", in a few lines read every
 * session. SYSTEMMAP.md answers "what is this system made of and how do I
 * extend it": layers, folders, tool groups, where bases, canvases, skills,
 * loops, know-how and the graph live, and the extension points. It is read
 * rarely, so it can say more.
 *
 * Two halves. The prose is written once (here, then yours: edit it freely).
 * The section between the markers is generated from the open bundle by
 * `system_map { refresh: true }`, and only that section is ever rewritten, so
 * what you wrote around it survives byte for byte.
 *
 * The Rust port is `rust/src/shared/okf/systemmap.rs`.
 *
 * Pure and DOM-free.
 */

import { PARA_DIRS, PARA_LABELS, PARA_ORDER, type ParaClass } from "./para";
import { clip } from "./canvas";
import headTemplate from "../../../templates/systemmap-head.md" with { type: "text" };
import tailTemplate from "../../../templates/systemmap-tail.md" with { type: "text" };

export const SYSTEMMAP_START = "<!-- okf:systemmap:start -->";
export const SYSTEMMAP_END = "<!-- okf:systemmap:end -->";

export interface SystemMapFacts {
  concepts: number;
  dead: number;
  knowhow: number;
  toolCount: number;
  para: Record<ParaClass, number>;
  /** Concept types with their counts, most used first. */
  types: Array<[string, number]>;
  bases: Array<{ path: string; views: string[]; error?: string }>;
  canvases: Array<{ path: string; nodes?: number; edges?: number; error?: string }>;
  skills: Array<{ name: string; description: string }>;
  loops: Array<{ name: string; goal: string }>;
  schema: { types: string[] | null; kinds: Array<{ name: string; from?: string[]; to?: string[] }> | null } | null;
}

const oneLine = (text: string, max = 120) => clip(text.replace(/\s+/g, " ").trim(), max);
const cell = (text: string) => text.replace(/\|/g, "\\|");
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

/** The generated section, markers included, without a trailing newline. */
export function renderGeneratedSection(facts: SystemMapFacts | null): string {
  const lines: string[] = ["## 現在の状態（自動生成）", ""];
  lines.push(
    "この範囲は `system_map { refresh: true }` が書き換えます。手で編集しないでください",
    "（範囲の外に書いたことは、更新しても消えません）。",
    ""
  );

  if (facts === null) {
    lines.push("まだ生成されていません。`system_map { refresh: true }` を呼ぶと、ここに現在の件数と一覧が入ります。");
    return wrapSection(lines);
  }

  lines.push("| 項目 | 数 |", "|---|---|");
  lines.push(`| 概念 | ${facts.concepts}${facts.dead > 0 ? `（DEAD ${facts.dead} 件を含む）` : ""} |`);
  lines.push(`| ノウハウ | ${facts.knowhow} |`);
  lines.push(`| ベース | ${facts.bases.length} |`);
  lines.push(`| キャンバス | ${facts.canvases.length} |`);
  lines.push(`| スキル | ${facts.skills.length} |`);
  lines.push(`| ループ | ${facts.loops.length} |`);
  lines.push(`| MCP ツール | ${facts.toolCount} |`, "");

  lines.push("### 概念（PARA 別）", "", "| PARA | 件数 |", "|---|---|");
  for (const cls of PARA_ORDER) lines.push(`| ${PARA_DIRS[cls]}（${PARA_LABELS[cls]}） | ${facts.para[cls]} |`);
  lines.push("");

  lines.push("### 概念（型別）", "");
  if (facts.types.length === 0) lines.push("なし。");
  else {
    lines.push("| 型 | 件数 |", "|---|---|");
    for (const [type, count] of facts.types) lines.push(`| ${cell(type)} | ${count} |`);
  }
  lines.push("");

  lines.push("### ベース", "");
  if (facts.bases.length === 0) lines.push("なし。");
  for (const base of facts.bases) {
    lines.push(
      base.error !== undefined
        ? `- ${code(base.path)} — 読めません: ${oneLine(base.error)}`
        : `- ${code(base.path)} — ビュー: ${base.views.length > 0 ? base.views.join(", ") : "なし"}`
    );
  }
  lines.push("");

  lines.push("### キャンバス", "");
  if (facts.canvases.length === 0) lines.push("なし。");
  for (const canvas of facts.canvases) {
    lines.push(
      canvas.error !== undefined
        ? `- ${code(canvas.path)} — 読めません: ${oneLine(canvas.error)}`
        : `- ${code(canvas.path)} — ${canvas.nodes} ノード / ${canvas.edges} エッジ`
    );
  }
  lines.push("");

  lines.push("### スキル", "");
  if (facts.skills.length === 0) lines.push("なし。");
  for (const skill of facts.skills) lines.push(`- ${code(skill.name)} — ${oneLine(skill.description)}`);
  lines.push("");

  lines.push("### ループ", "");
  if (facts.loops.length === 0) lines.push("なし。");
  for (const loop of facts.loops) lines.push(`- ${code(loop.name)} — ${oneLine(loop.goal)}`);
  lines.push("");

  lines.push("### グラフスキーマ", "");
  if (facts.schema === null) {
    lines.push("`wiki/graph/schema.md` がありません。作ると、型と関係の種類を宣言できます（下の「拡張のしかた」）。");
  } else {
    lines.push(`- 型: ${facts.schema.types === null ? "（宣言なし）" : facts.schema.types.length > 0 ? facts.schema.types.join(", ") : "なし"}`);
    const kinds = facts.schema.kinds;
    if (kinds === null) lines.push("- 関係: （宣言なし）");
    else if (kinds.length === 0) lines.push("- 関係: なし");
    else {
      for (const kind of kinds) {
        const ends = kind.from || kind.to ? `（${(kind.from ?? ["*"]).join("|")} → ${(kind.to ?? ["*"]).join("|")}）` : "";
        lines.push(`- 関係: ${code(kind.name)}${ends}`);
      }
    }
  }

  return wrapSection(lines);
}

/**
 * The markers around the body. Anything user-derived (skill descriptions, loop
 * goals, type and kind names) could spell a marker; `<!--` is neutralised so a
 * refresh can never grow a second section or end the first one early.
 */
function wrapSection(lines: string[]): string {
  return [SYSTEMMAP_START, ...lines.map((line) => line.replaceAll("<!--", "&lt;!--")), SYSTEMMAP_END].join("\n");
}

/** The prose above and below the generated section: shared with the Rust build as files. */
const HEAD: string = headTemplate;
const TAIL: string = tailTemplate;

/**
 * The file's new text. With a previous version, only the marked section is
 * replaced; a previous file without markers keeps its text and gains the
 * section at the end. Without one, the whole template.
 *
 * Exactly one start marker followed by exactly one end marker is a section.
 * Any other mix (an orphan, reversed, duplicated) throws: guessing which half
 * to trust could delete the human's text, so the file is left for them to fix.
 */
export function renderSystemMap(previous: string | undefined, facts: SystemMapFacts | null): string {
  const section = renderGeneratedSection(facts);
  if (previous === undefined) return `${HEAD}\n${section}\n${TAIL}`;

  const starts = previous.split(SYSTEMMAP_START).length - 1;
  const ends = previous.split(SYSTEMMAP_END).length - 1;
  if (starts === 0 && ends === 0) return `${previous}${previous.endsWith("\n") ? "" : "\n"}\n${section}\n`;

  const start = previous.indexOf(SYSTEMMAP_START);
  const end = previous.indexOf(SYSTEMMAP_END);
  if (starts === 1 && ends === 1 && start < end) {
    return previous.slice(0, start) + section + previous.slice(end + SYSTEMMAP_END.length);
  }
  const fix =
    starts > 1 || ends > 1
      ? `keep exactly one ${SYSTEMMAP_START} followed by one ${SYSTEMMAP_END}`
      : starts === 1 && ends === 0
        ? `restore ${SYSTEMMAP_END} after the generated section`
        : starts === 0
          ? `restore ${SYSTEMMAP_START} before the generated section`
          : `put ${SYSTEMMAP_START} before ${SYSTEMMAP_END}`;
  throw new Error(
    `SYSTEMMAP.md has ${starts} start and ${ends} end markers, so the generated section cannot be found: ${fix}, then refresh again. Nothing was written.`
  );
}
