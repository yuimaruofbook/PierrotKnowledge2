/**
 * Markdown formatting commands for a toolbar.
 *
 * Every command is a pure transform of `(text, selection)` into a new text and
 * selection. That keeps the whole formatting surface testable without a DOM,
 * and it keeps the Markdown *source* the thing being edited — the toolbar is a
 * faster way to type the same characters, not a second representation that
 * could drift from the file on disk.
 *
 * Commands toggle. Pressing 見出し1 on a line that is already `# ` removes it,
 * which is what every editor has trained people to expect and what makes a
 * toolbar usable without an undo reflex.
 */

export interface EditState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface EditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export type FormatAction =
  | "h1"
  | "h2"
  | "h3"
  | "paragraph"
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "quote"
  | "ul"
  | "ol"
  | "task"
  | "link"
  | "align-left"
  | "align-center"
  | "align-right"
  | "hr"
  | "table";

/** Alignment is not Markdown; see `applyAlign`. */
const ALIGN_OPEN_RE = /^<div align="(left|center|right)">$/;
const ALIGN_CLOSE = "</div>";

const HEADING_RE = /^(#{1,6})\s+/;
const QUOTE_RE = /^>\s?/;
const BULLET_RE = /^[-*+]\s+(?:\[[ xX]\]\s+)?/;
const ORDERED_RE = /^\d+[.)]\s+/;
const TASK_RE = /^[-*+]\s+\[[ xX]\]\s+/;

/** Start and end offsets of every line the selection touches. */
function selectedLineRange(state: EditState): { start: number; end: number } {
  const start = state.value.lastIndexOf("\n", state.selectionStart - 1) + 1;
  const nextBreak = state.value.indexOf("\n", state.selectionEnd);
  return { start, end: nextBreak === -1 ? state.value.length : nextBreak };
}

/**
 * Rewrite every selected line, keeping the selection over the same lines.
 *
 * The caret is placed across the whole rewritten block rather than restored to
 * a character offset: after a prefix changes length, the old offset points
 * somewhere arbitrary, and re-selecting the block is what lets a second click
 * toggle it back off.
 */
function mapLines(state: EditState, transform: (line: string) => string): EditResult {
  const { start, end } = selectedLineRange(state);
  const block = state.value.slice(start, end);
  const next = block.split("\n").map(transform).join("\n");

  return {
    value: state.value.slice(0, start) + next + state.value.slice(end),
    selectionStart: start,
    selectionEnd: start + next.length,
  };
}

/** Strip whichever block marker a line currently carries. */
function stripBlockMarkers(line: string): string {
  return line.replace(HEADING_RE, "").replace(TASK_RE, "").replace(BULLET_RE, "").replace(ORDERED_RE, "");
}

function applyHeading(state: EditState, level: 0 | 1 | 2 | 3): EditResult {
  const { start, end } = selectedLineRange(state);
  const lines = state.value.slice(start, end).split("\n");
  const marker = "#".repeat(level);

  // Toggle off only when every selected line already has exactly this level.
  const allMatch =
    level > 0 && lines.every((line) => HEADING_RE.exec(line)?.[1]?.length === level);

  return mapLines(state, (line) => {
    const body = stripBlockMarkers(line);
    if (level === 0 || allMatch) return body;
    return body.trim() ? `${marker} ${body}` : `${marker} `;
  });
}

function applyQuote(state: EditState): EditResult {
  const { start, end } = selectedLineRange(state);
  const lines = state.value.slice(start, end).split("\n");
  const allQuoted = lines.every((line) => QUOTE_RE.test(line));

  return mapLines(state, (line) => (allQuoted ? line.replace(QUOTE_RE, "") : `> ${line}`));
}

function applyList(state: EditState, kind: "ul" | "ol" | "task"): EditResult {
  const { start, end } = selectedLineRange(state);
  const lines = state.value.slice(start, end).split("\n");

  const matches =
    kind === "ul"
      ? (line: string) => BULLET_RE.test(line) && !TASK_RE.test(line)
      : kind === "ol"
        ? (line: string) => ORDERED_RE.test(line)
        : (line: string) => TASK_RE.test(line);

  const allMatch = lines.every((line) => matches(line));
  let counter = 0;

  return mapLines(state, (line) => {
    const body = stripBlockMarkers(line);
    if (allMatch) return body;
    counter++;
    if (kind === "ul") return `- ${body}`;
    if (kind === "task") return `- [ ] ${body}`;
    return `${counter}. ${body}`;
  });
}

/**
 * Wrap or unwrap the selection with an inline marker.
 *
 * Also unwraps when the markers sit just *outside* the selection, which is
 * what happens when a user double-clicks a bolded word and clicks 太字 again.
 */
function applyInline(state: EditState, marker: string): EditResult {
  const { value, selectionStart, selectionEnd } = state;
  const selected = value.slice(selectionStart, selectionEnd);
  const width = marker.length;

  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= width * 2) {
    const inner = selected.slice(width, -width);
    return {
      value: value.slice(0, selectionStart) + inner + value.slice(selectionEnd),
      selectionStart,
      selectionEnd: selectionStart + inner.length,
    };
  }

  const before = value.slice(Math.max(0, selectionStart - width), selectionStart);
  const after = value.slice(selectionEnd, selectionEnd + width);
  if (before === marker && after === marker) {
    return {
      value:
        value.slice(0, selectionStart - width) + selected + value.slice(selectionEnd + width),
      selectionStart: selectionStart - width,
      selectionEnd: selectionEnd - width + selected.length,
    };
  }

  const wrapped = `${marker}${selected}${marker}`;
  return {
    value: value.slice(0, selectionStart) + wrapped + value.slice(selectionEnd),
    // Empty selection: put the caret between the markers so typing continues
    // inside them. A selection stays selected so a second click toggles off.
    selectionStart: selectionStart + width,
    selectionEnd: selectionStart + width + selected.length,
  };
}

function applyLink(state: EditState): EditResult {
  const { value, selectionStart, selectionEnd } = state;
  const selected = value.slice(selectionStart, selectionEnd) || "リンクテキスト";
  const snippet = `[${selected}](url)`;

  return {
    value: value.slice(0, selectionStart) + snippet + value.slice(selectionEnd),
    // Select `url`, so the next keystroke replaces the placeholder.
    selectionStart: selectionStart + selected.length + 3,
    selectionEnd: selectionStart + selected.length + 6,
  };
}

/**
 * Alignment, which Markdown has no syntax for.
 *
 * Emitted as an HTML wrapper because that is the only portable option: GitHub,
 * Obsidian, VS Code and pandoc all honour `<div align>`, and a renderer that
 * does not simply shows the content unaligned rather than breaking. Blank lines
 * inside the wrapper keep the Markdown within it parsing as Markdown.
 */
function applyAlign(state: EditState, align: "left" | "center" | "right"): EditResult {
  const { start, end } = selectedLineRange(state);
  const block = state.value.slice(start, end);
  const lines = block.split("\n");

  const openMatch = ALIGN_OPEN_RE.exec(lines[0]?.trim() ?? "");
  const isWrapped = !!openMatch && lines[lines.length - 1]?.trim() === ALIGN_CLOSE;

  if (isWrapped) {
    const inner = lines.slice(1, -1).join("\n").replace(/^\n+|\n+$/g, "");
    // Same alignment again means "remove it"; a different one means "change it".
    const next =
      openMatch[1] === align
        ? inner
        : [`<div align="${align}">`, "", inner, "", ALIGN_CLOSE].join("\n");
    return {
      value: state.value.slice(0, start) + next + state.value.slice(end),
      selectionStart: start,
      selectionEnd: start + next.length,
    };
  }

  const next = [`<div align="${align}">`, "", block, "", ALIGN_CLOSE].join("\n");
  return {
    value: state.value.slice(0, start) + next + state.value.slice(end),
    selectionStart: start,
    selectionEnd: start + next.length,
  };
}

/**
 * Insert a block after the lines the selection touches.
 *
 * Inserted *after* rather than at the selection, because these are the two
 * commands with nothing to toggle: replacing the selection would mean that
 * clicking 区切り線 with a paragraph selected silently deletes the paragraph.
 */
function insertBlock(state: EditState, block: string): EditResult {
  const { end } = selectedLineRange(state);
  const snippet = `${end > 0 ? "\n" : ""}${block}\n`;
  const caret = end + snippet.length;

  return {
    value: state.value.slice(0, end) + snippet + state.value.slice(end),
    selectionStart: caret,
    selectionEnd: caret,
  };
}

const TABLE_SKELETON = ["| 見出し | 見出し |", "| --- | --- |", "|  |  |"].join("\n");

export function applyFormat(state: EditState, action: FormatAction): EditResult {
  switch (action) {
    case "h1":
      return applyHeading(state, 1);
    case "h2":
      return applyHeading(state, 2);
    case "h3":
      return applyHeading(state, 3);
    case "paragraph":
      return applyHeading(state, 0);

    case "bold":
      return applyInline(state, "**");
    case "italic":
      return applyInline(state, "*");
    case "strike":
      return applyInline(state, "~~");
    case "code":
      return applyInline(state, "`");

    case "quote":
      return applyQuote(state);
    case "ul":
      return applyList(state, "ul");
    case "ol":
      return applyList(state, "ol");
    case "task":
      return applyList(state, "task");

    case "link":
      return applyLink(state);

    case "align-left":
      return applyAlign(state, "left");
    case "align-center":
      return applyAlign(state, "center");
    case "align-right":
      return applyAlign(state, "right");

    case "hr":
      return insertBlock(state, "---");
    case "table":
      return insertBlock(state, TABLE_SKELETON);
  }
}

/**
 * Which commands are active for the current selection.
 *
 * Used to light up the toolbar. Only block-level state is reported: whether an
 * inline marker is "on" depends on where the caret sits inside it, and a button
 * that flickers as the caret moves is worse than one that never lights up.
 */
export function activeFormats(state: EditState): Set<FormatAction> {
  const active = new Set<FormatAction>();
  const { start, end } = selectedLineRange(state);
  const lines = state.value.slice(start, end).split("\n");
  if (lines.length === 0) return active;

  const level = HEADING_RE.exec(lines[0] ?? "")?.[1]?.length;
  if (level === 1) active.add("h1");
  if (level === 2) active.add("h2");
  if (level === 3) active.add("h3");

  if (lines.every((line) => QUOTE_RE.test(line))) active.add("quote");
  if (lines.every((line) => TASK_RE.test(line))) active.add("task");
  else if (lines.every((line) => BULLET_RE.test(line))) active.add("ul");
  if (lines.every((line) => ORDERED_RE.test(line))) active.add("ol");

  const align = ALIGN_OPEN_RE.exec(lines[0]?.trim() ?? "")?.[1];
  if (align === "left") active.add("align-left");
  if (align === "center") active.add("align-center");
  if (align === "right") active.add("align-right");

  return active;
}
