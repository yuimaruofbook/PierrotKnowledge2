/**
 * Editor pane: source, preview, metadata and backlinks for one document.
 *
 * Holds the dirty flag and the mtime the buffer was loaded from, which is what
 * lets an external write be detected rather than silently overwritten.
 */

import type { ConceptSummary } from "../../shared/rpc-schema";
import type { ReadFileResult } from "../../shared/types";
import { messages } from "../../shared/messages";
import { activeFormats, applyFormat, type FormatAction } from "../../shared/markdown-format";
import { splitFrontmatter } from "../../shared/okf/frontmatter";
import { clear, debounce, el } from "../dom";
import { renderMarkdown } from "../markdown";
import { decidePasteContent, readClipboard } from "../paste";
import {
  completeWikilink,
  continueList,
  indent,
  wikilinkContext,
  type EditResult,
} from "./keymap";
import { rankByFuzzy } from "../../shared/fuzzy";

/**
 * The editing surface has one pane, not two.
 *
 * A permanent split shows the same document twice and halves the width
 * available to each — on a laptop that is two narrow columns instead of one
 * comfortable one. The formatting bar does what the live preview was mostly
 * being used for, so the preview becomes something you switch to.
 */
export type PreviewMode = "edit" | "preview";

/** Idle delay before an automatic save. */
const AUTOSAVE_MS = 900;

export interface EditorOptions {
  textarea: HTMLTextAreaElement;
  preview: HTMLElement;
  pane: HTMLElement;
  pathLabel: HTMLElement;
  metaBar: HTMLElement;
  backlinks: HTMLElement;
  autocomplete: HTMLElement;
  /** Panel shown in place of the editor for non-text files. */
  binaryNotice: HTMLElement;
  onDirtyChange: (dirty: boolean) => void;
  onAutosave: () => void;
  onFollowLink: (target: string, kind: "wikilink" | "internal") => void;
  onOpenExternal: (url: string) => void;
  onOpenConcept: (id: string) => void;
  /** Called when the caret enters an unresolved `[[link]]` the user may want to create. */
  onCreateMissing: (target: string) => void;
  /** Told how a paste was interpreted, so the status bar can say so. */
  onPaste?: (from: "html" | "text") => void;
  /** Told which block formats apply at the caret, so the toolbar can light up. */
  onSelectionChange?: (active: Set<FormatAction>) => void;
}

export class Editor {
  private current: { path: string; mtimeMs: number } | null = null;
  private dirty = false;
  private mode: PreviewMode = "edit";
  private autosaveEnabled = true;
  private concepts: ConceptSummary[] = [];
  private completionItems: string[] = [];
  private completionActive = 0;
  private completionContext: { query: string; start: number } | null = null;
  private readonly scheduleAutosave: () => void;
  /** Set while Ctrl+Shift+V is being handled. */
  private forcePlainPaste = false;

  constructor(private readonly options: EditorOptions) {
    this.scheduleAutosave = debounce(() => {
      if (this.dirty && this.autosaveEnabled) this.options.onAutosave();
    }, AUTOSAVE_MS);

    const textarea = options.textarea;

    textarea.addEventListener("input", () => {
      this.setDirty(true);
      if (this.mode === "preview") this.renderPreviewSoon();
      this.updateCompletion();
      this.scheduleAutosave();
    });

    textarea.addEventListener("paste", (event) => this.onPaste(event));
    textarea.addEventListener("keydown", (event) => this.onKeyDown(event));
    textarea.addEventListener("click", () => this.updateCompletion());
    textarea.addEventListener("blur", () => this.hideCompletion());

    options.preview.addEventListener("click", (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      event.preventDefault();

      const kind = anchor.getAttribute("data-link");
      const target = anchor.getAttribute("data-target") ?? "";

      if (kind === "external") this.options.onOpenExternal(anchor.getAttribute("href") ?? "");
      else if (kind === "wikilink" || kind === "internal") this.options.onFollowLink(target, kind);
    });

    this.applyMode();
  }

  private renderPreviewSoon = debounce(() => this.renderPreview(), 120);

  get path(): string | null {
    return this.current?.path ?? null;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get value(): string {
    return this.options.textarea.value;
  }

  setConcepts(concepts: ConceptSummary[]): void {
    this.concepts = concepts;
  }

  setAutosave(enabled: boolean): void {
    this.autosaveEnabled = enabled;
  }

  // ---- editing keys ----

  private onKeyDown(event: KeyboardEvent): void {
    if (this.completionItems.length && this.handleCompletionKey(event)) return;

    const textarea = this.options.textarea;
    const state = {
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };

    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.shiftKey && (event.key === "v" || event.key === "V")) {
      // The browser fires `paste` right after this; the flag tells the handler
      // to take the plain flavour and is cleared once it has.
      this.forcePlainPaste = true;
      setTimeout(() => (this.forcePlainPaste = false), 0);
      return;
    }

    if (mod && (event.key === "b" || event.key === "i")) {
      event.preventDefault();
      // Routed through the same command the toolbar uses, so the shortcut and
      // the button can never end up behaving differently.
      this.apply(applyFormat(state, event.key === "b" ? "bold" : "italic"));
      this.reportSelection();
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const result = indent(state, event.shiftKey);
      if (result) this.apply(result);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !mod) {
      const result = continueList(state);
      if (result) {
        event.preventDefault();
        this.apply(result);
      }
    }
  }

  /**
   * Paste, keeping the structure the source had.
   *
   * Without this the browser inserts `text/plain`, which is the formatting
   * already thrown away — headings, lists, links and tables arrive as flat
   * prose. Ctrl+Shift+V still pastes plain text, as everywhere else.
   */
  private onPaste(event: ClipboardEvent): void {
    const source = readClipboard(event.clipboardData);
    if (!source.text && !source.html) return;

    const decision = decidePasteContent(source, this.forcePlainPaste);
    if (!decision.markdown) return;

    event.preventDefault();

    const textarea = this.options.textarea;
    this.apply({
      value:
        textarea.value.slice(0, textarea.selectionStart) +
        decision.markdown +
        textarea.value.slice(textarea.selectionEnd),
      selectionStart: textarea.selectionStart + decision.markdown.length,
      selectionEnd: textarea.selectionStart + decision.markdown.length,
    });

    this.options.onPaste?.(decision.from);
  }

  /** Apply a transform and keep the DOM, dirty flag and preview in step. */
  private apply(result: EditResult): void {
    const textarea = this.options.textarea;
    textarea.value = result.value;
    textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
    this.setDirty(true);
    if (this.mode === "preview") this.renderPreviewSoon();
    this.scheduleAutosave();
  }

  // ---- wikilink autocomplete ----

  private updateCompletion(): void {
    const textarea = this.options.textarea;
    const context = wikilinkContext(textarea.value, textarea.selectionStart);

    if (!context) {
      this.hideCompletion();
      return;
    }

    this.completionContext = context;
    this.completionItems = rankByFuzzy(
      this.concepts,
      context.query,
      (concept) => [concept.id, concept.title],
      8
    ).map((concept) => concept.id);

    this.completionActive = 0;
    this.renderCompletion();
  }

  private handleCompletionKey(event: KeyboardEvent): boolean {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.completionActive = (this.completionActive + 1) % this.completionItems.length;
        this.renderCompletion();
        return true;
      case "ArrowUp":
        event.preventDefault();
        this.completionActive =
          (this.completionActive - 1 + this.completionItems.length) % this.completionItems.length;
        this.renderCompletion();
        return true;
      case "Enter":
      case "Tab": {
        const id = this.completionItems[this.completionActive];
        if (!id || !this.completionContext) return false;
        event.preventDefault();
        const textarea = this.options.textarea;
        this.apply(
          completeWikilink(
            {
              value: textarea.value,
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd,
            },
            this.completionContext,
            id
          )
        );
        this.hideCompletion();
        return true;
      }
      case "Escape":
        event.preventDefault();
        this.hideCompletion();
        return true;
      default:
        return false;
    }
  }

  private renderCompletion(): void {
    const panel = this.options.autocomplete;
    clear(panel);

    if (this.completionItems.length === 0) {
      panel.hidden = true;
      return;
    }

    // A "create this page" affordance turns a typo into a deliberate choice,
    // and is the main way new pages get made in a wiki.
    const query = this.completionContext?.query.trim();
    if (query && !this.completionItems.includes(query)) {
      const create = el("li", { className: "completion create", text: `＋ 新規作成: ${query}` });
      create.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.options.onCreateMissing(query);
        this.hideCompletion();
      });
      panel.appendChild(create);
    }

    this.completionItems.forEach((id, index) => {
      const row = el("li", {
        className: `completion${index === this.completionActive ? " active" : ""}`,
        text: id,
      });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const textarea = this.options.textarea;
        if (!this.completionContext) return;
        this.apply(
          completeWikilink(
            {
              value: textarea.value,
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd,
            },
            this.completionContext,
            id
          )
        );
        this.hideCompletion();
      });
      panel.appendChild(row);
    });

    panel.hidden = false;
  }

  private hideCompletion(): void {
    this.completionItems = [];
    this.completionContext = null;
    this.options.autocomplete.hidden = true;
  }

  // ---- modes ----

  setMode(mode: PreviewMode): void {
    this.mode = mode;
    this.applyMode();
    if (mode === "preview") this.renderPreview();
  }

  cycleMode(): PreviewMode {
    this.setMode(this.mode === "edit" ? "preview" : "edit");
    return this.mode;
  }

  get currentMode(): PreviewMode {
    return this.mode;
  }

  private applyMode(): void {
    const { pane, textarea, preview } = this.options;
    pane.dataset.mode = this.mode;
    textarea.hidden = this.mode === "preview";
    preview.hidden = this.mode === "edit";
  }

  /**
   * Run a toolbar command against the current selection.
   *
   * Focus is restored first: the click that triggered this moved focus to the
   * button, and a textarea that is not focused reports a stale selection.
   */
  format(action: FormatAction): void {
    const textarea = this.options.textarea;
    if (textarea.hidden) return;

    textarea.focus();
    this.apply(
      applyFormat(
        {
          value: textarea.value,
          selectionStart: textarea.selectionStart,
          selectionEnd: textarea.selectionEnd,
        },
        action
      )
    );
    this.reportSelection();
  }

  /** Tell the toolbar which block formats are in effect at the caret. */
  reportSelection(): void {
    const textarea = this.options.textarea;
    this.options.onSelectionChange?.(
      activeFormats({
        value: textarea.value,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      })
    );
  }

  // ---- document lifecycle ----

  load(path: string, result: ReadFileResult): void {
    // A binary file has no text to edit. Decoding its bytes as UTF-8 is what
    // produced screens of replacement characters that looked like a
    // character-encoding fault but were simply the wrong kind of file.
    if (result.binary) {
      this.showBinary(path, result);
      return;
    }

    this.options.binaryNotice.hidden = true;
    this.options.textarea.readOnly = false;
    this.options.textarea.value = result.content;
    this.current = { path, mtimeMs: result.mtimeMs };
    this.options.pathLabel.textContent = path;
    this.setDirty(false);
    this.hideCompletion();
    this.renderMeta(result);
    this.renderBacklinks(result);
    if (this.mode === "preview") this.renderPreview();
    this.options.textarea.scrollTop = 0;
  }

  /** Adopt new content for the open file, e.g. after an agent write. */
  adopt(result: ReadFileResult): void {
    if (!this.current) return;
    const caret = this.options.textarea.selectionStart;
    this.options.textarea.value = result.content;
    this.options.textarea.setSelectionRange(
      Math.min(caret, result.content.length),
      Math.min(caret, result.content.length)
    );
    this.current = { ...this.current, mtimeMs: result.mtimeMs };
    this.setDirty(false);
    this.renderMeta(result);
    this.renderBacklinks(result);
    if (this.mode === "preview") this.renderPreview();
  }

  markSaved(mtimeMs: number): void {
    if (this.current) this.current = { ...this.current, mtimeMs };
    this.setDirty(false);
  }

  clearDocument(): void {
    this.options.binaryNotice.hidden = true;
    this.options.textarea.readOnly = false;
    this.current = null;
    this.options.textarea.value = "";
    this.options.pathLabel.textContent = "";
    clear(this.options.metaBar);
    clear(this.options.backlinks);
    clear(this.options.preview);
    this.hideCompletion();
    this.setDirty(false);
  }

  /**
   * Present a non-text file as a description instead of decoded bytes.
   *
   * Saying what the file *is* — a SQLite database, an image — is more useful
   * than a screen of replacement characters, and makes clear that nothing is
   * broken.
   */
  private showBinary(path: string, result: ReadFileResult): void {
    const notice = this.options.binaryNotice;
    clear(notice);

    notice.appendChild(el("div", { className: "notice-title", text: messages.binaryNotice }));

    const facts = [messages.binaryFile(result.fileType ?? null)];
    if (result.byteLength !== undefined) facts.push(messages.fileSize(result.byteLength));
    notice.appendChild(el("div", { className: "notice-detail", text: facts.join(" · ") }));

    notice.appendChild(el("div", { className: "notice-hint", text: messages.binaryHint }));
    notice.hidden = false;

    this.current = { path, mtimeMs: result.mtimeMs };
    this.options.pathLabel.textContent = path;
    this.options.textarea.value = "";
    this.options.textarea.readOnly = true;
    this.setDirty(false);
    this.hideCompletion();
    clear(this.options.preview);
    clear(this.options.metaBar);
    clear(this.options.backlinks);
  }

  /** Insert text at the caret — used by toolbar actions. */
  insertAtCaret(text: string): void {
    const textarea = this.options.textarea;
    this.apply({
      value:
        textarea.value.slice(0, textarea.selectionStart) +
        text +
        textarea.value.slice(textarea.selectionEnd),
      selectionStart: textarea.selectionStart + text.length,
      selectionEnd: textarea.selectionStart + text.length,
    });
  }

  private setDirty(dirty: boolean): void {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.options.onDirtyChange(dirty);
  }

  /**
   * Render the body only.
   *
   * YAML frontmatter is metadata, not prose — Marked has no idea what it is and
   * renders it as a run-on paragraph ("type: Note title: … tags: …"), which is
   * both ugly and misleading. It is already shown properly as badges in the
   * toolbar.
   */
  private renderPreview(): void {
    clear(this.options.preview);
    const { body } = splitFrontmatter(this.options.textarea.value);
    this.options.preview.appendChild(renderMarkdown(body));
  }

  private renderMeta(result: ReadFileResult): void {
    const bar = this.options.metaBar;
    clear(bar);

    const concept = result.concept;
    if (!concept) {
      bar.appendChild(el("span", { className: "badge reserved", text: messages.nonConceptFile }));
      return;
    }

    bar.appendChild(el("span", { className: "badge type", text: concept.frontmatter.type }));

    const status = concept.frontmatter.status;
    if (typeof status === "string") {
      bar.appendChild(el("span", { className: `badge status-${status}`, text: status }));
    }

    const tags = concept.frontmatter.tags;
    if (Array.isArray(tags)) {
      for (const tag of tags.filter((t): t is string => typeof t === "string")) {
        bar.appendChild(el("span", { className: "badge tag", text: `#${tag}` }));
      }
    }

    const unresolved = concept.links.filter((link) => !link.resolved && link.kind === "wikilink");
    if (unresolved.length) {
      const badge = el("span", {
        className: "badge warn clickable",
        text: messages.unresolvedLinks(unresolved.length),
        title: unresolved.map((link) => link.target).join(", "),
      });
      badge.addEventListener("click", () => {
        const first = unresolved[0];
        if (first) this.options.onCreateMissing(first.target);
      });
      bar.appendChild(badge);
    }
  }

  private renderBacklinks(result: ReadFileResult): void {
    const panel = this.options.backlinks;
    clear(panel);

    panel.appendChild(
      el("div", {
        className: "panel-head",
        text: `バックリンク (${result.backlinks.length})`,
      })
    );

    if (result.backlinks.length === 0) {
      panel.appendChild(el("div", { className: "empty", text: "なし" }));
      return;
    }

    const list = el("ul", { className: "backlink-list" });
    for (const id of result.backlinks) {
      const item = el("li", { className: "backlink", text: id });
      item.addEventListener("click", () => this.options.onOpenConcept(id));
      list.appendChild(item);
    }
    panel.appendChild(list);
  }
}
