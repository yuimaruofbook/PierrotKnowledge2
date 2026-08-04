/**
 * Text-editing behaviours for a plain `<textarea>`.
 *
 * Pure string transforms, kept apart from the DOM so they can be reasoned
 * about and tested directly. Each returns the new value and where the caret
 * should land, or null when the key should keep its default behaviour.
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

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;
const QUOTE_RE = /^(\s*>+\s?)(.*)$/;

function lineBoundsAt(value: string, index: number): { start: number; end: number } {
  const start = value.lastIndexOf("\n", index - 1) + 1;
  const nextBreak = value.indexOf("\n", index);
  return { start, end: nextBreak === -1 ? value.length : nextBreak };
}

/**
 * Continue a list or blockquote on Enter.
 *
 * Pressing Enter on an *empty* item ends the list instead of adding another
 * bullet — the behaviour every editor has trained people to expect.
 */
export function continueList(state: EditState): EditResult | null {
  if (state.selectionStart !== state.selectionEnd) return null;

  const { start } = lineBoundsAt(state.value, state.selectionStart);
  const line = state.value.slice(start, state.selectionStart);

  const list = line.match(LIST_ITEM_RE);
  if (list) {
    const [, indent = "", marker = "-", space = " ", checkbox, content = ""] = list;

    if (!content.trim()) {
      // Empty item: clear the line and break out of the list.
      const value = state.value.slice(0, start) + state.value.slice(state.selectionStart);
      return { value, selectionStart: start, selectionEnd: start };
    }

    const nextMarker = /^\d+[.)]$/.test(marker)
      ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}`
      : marker;
    // A checked box never carries its state to the new item.
    const prefix = `\n${indent}${nextMarker}${space}${checkbox ? "[ ] " : ""}`;
    return insert(state, prefix);
  }

  const quote = line.match(QUOTE_RE);
  if (quote && quote[2]?.trim()) return insert(state, `\n${quote[1]}`);

  return null;
}

function insert(state: EditState, text: string): EditResult {
  const value =
    state.value.slice(0, state.selectionStart) + text + state.value.slice(state.selectionEnd);
  const caret = state.selectionStart + text.length;
  return { value, selectionStart: caret, selectionEnd: caret };
}

const INDENT = "  ";

/**
 * Tab and Shift+Tab.
 *
 * With a selection this indents or outdents whole lines; without one, Tab
 * inserts spaces. A raw tab character in Markdown is ambiguous across
 * renderers, so spaces are used throughout.
 */
export function indent(state: EditState, outdent: boolean): EditResult | null {
  const hasSelection = state.selectionStart !== state.selectionEnd;

  if (!hasSelection && !outdent) return insert(state, INDENT);

  const { start } = lineBoundsAt(state.value, state.selectionStart);
  const { end } = lineBoundsAt(state.value, state.selectionEnd);

  const block = state.value.slice(start, end);
  const lines = block.split("\n");

  let firstDelta = 0;
  let totalDelta = 0;

  const next = lines.map((line, index) => {
    if (outdent) {
      const match = line.match(/^([ \t]{1,2})/);
      const removed = match?.[1]?.length ?? 0;
      if (index === 0) firstDelta = -removed;
      totalDelta -= removed;
      return line.slice(removed);
    }
    if (index === 0) firstDelta = INDENT.length;
    totalDelta += INDENT.length;
    return line ? INDENT + line : line;
  });

  const value = state.value.slice(0, start) + next.join("\n") + state.value.slice(end);
  return {
    value,
    selectionStart: Math.max(start, state.selectionStart + firstDelta),
    selectionEnd: Math.max(start, state.selectionEnd + totalDelta),
  };
}

/**
 * Detect an in-progress `[[` wikilink immediately before the caret.
 * Returns the partial target typed so far, or null.
 */
export function wikilinkContext(value: string, caret: number): { query: string; start: number } | null {
  const open = value.lastIndexOf("[[", caret);
  if (open === -1) return null;

  const close = value.indexOf("]]", open);
  if (close !== -1 && close < caret) return null;

  const query = value.slice(open + 2, caret);
  // A newline or a nested bracket means the `[[` was never a link.
  if (/[\n\[\]]/.test(query)) return null;

  return { query, start: open + 2 };
}

/** Replace an in-progress wikilink with a completed one. */
export function completeWikilink(
  state: EditState,
  context: { query: string; start: number },
  id: string
): EditResult {
  const after = state.value.slice(state.selectionStart);
  const closing = after.startsWith("]]") ? 2 : 0;

  const value =
    state.value.slice(0, context.start) +
    id +
    "]]" +
    state.value.slice(state.selectionStart + closing);

  const caret = context.start + id.length + 2;
  return { value, selectionStart: caret, selectionEnd: caret };
}
