/**
 * Search panel over the BM25 index.
 */

import type { SearchHit } from "../../shared/types";
import { clear, debounce, el } from "../dom";
import { renderSnippet } from "../markdown";

export interface SearchOptions {
  input: HTMLInputElement;
  panel: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  search: (query: string) => Promise<SearchHit[]>;
  onOpenHit: (path: string) => void;
}

export class SearchPanel {
  /** Guards against a slow earlier query overwriting a newer one. */
  private generation = 0;

  constructor(private readonly options: SearchOptions) {
    const run = debounce(() => void this.run(), 180);
    options.input.addEventListener("input", run);
    options.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
  }

  focus(): void {
    this.options.input.focus();
    this.options.input.select();
  }

  /** Re-run the current query, e.g. after a filter changed. */
  rerun(): void {
    void this.run();
  }

  close(): void {
    this.options.input.value = "";
    this.options.panel.hidden = true;
  }

  private async run(): Promise<void> {
    const query = this.options.input.value.trim();
    if (!query) {
      this.options.panel.hidden = true;
      return;
    }

    const generation = ++this.generation;
    const hits = await this.options.search(query);
    if (generation !== this.generation) return;

    this.render(hits);
  }

  private render(hits: SearchHit[]): void {
    const { panel, list, empty } = this.options;
    panel.hidden = false;
    clear(list);
    empty.hidden = hits.length > 0;

    for (const hit of hits) {
      const item = el("li", { className: "hit", dataset: { path: hit.path } });
      item.appendChild(el("div", { className: "hit-title", text: hit.title }));

      const meta = el("div", { className: "hit-meta" });
      meta.appendChild(el("span", { className: "badge", text: hit.type }));
      // The heading trail says *where in the page* the match is, which is the
      // difference between "this file mentions it" and "this section is about it".
      const location = hit.headingPath.length
        ? `${hit.id} › ${hit.headingPath.join(" › ")}`
        : hit.id;
      meta.appendChild(el("span", { className: "hit-id", text: location, title: location }));
      item.appendChild(meta);

      // Snippet markers come from SQLite; the text around them is escaped.
      const snippet = el("div", { className: "hit-snippet" });
      snippet.innerHTML = renderSnippet(hit.snippet);
      item.appendChild(snippet);

      item.addEventListener("click", () => this.options.onOpenHit(hit.path));
      list.appendChild(item);
    }
  }
}
