/**
 * Filesystem watching.
 *
 * The symmetry principle only holds if an edit made outside the app is
 * indistinguishable from one made inside it. Without a watcher, a file an
 * agent writes over MCP stays invisible to the open editor until reopened —
 * which is exactly the failure mode the design is meant to avoid.
 */

import { watch, type FSWatcher } from "fs";
import { relative, sep } from "path";

export interface WatcherOptions {
  /** Coalescing window; editors emit several events per save. */
  debounceMs?: number;
  /** Called with bundle-relative, `/`-separated paths. */
  onChange: (paths: string[]) => void;
  onError?: (error: unknown) => void;
}

const IGNORED_SEGMENTS = new Set([".rag", ".git", ".obsidian", "node_modules"]);
const IGNORED_SUFFIXES = ["~", ".tmp", ".swp", ".crswap"];

export function shouldIgnore(relPath: string): boolean {
  if (!relPath) return true;
  const segments = relPath.split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  // Editors write `.foo.md.swp`-style siblings during a save.
  const name = segments[segments.length - 1] ?? "";
  if (name.startsWith(".")) return true;
  return IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export class BundleWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly root: string,
    private readonly options: WatcherOptions
  ) {}

  start(): boolean {
    if (this.watcher) return true;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = relative("", filename.toString()).split(sep).join("/");
        if (shouldIgnore(rel)) return;
        this.pending.add(rel);
        this.schedule();
      });
      this.watcher.on("error", (error) => this.options.onError?.(error));
      return true;
    } catch (error) {
      // Recursive watching is unavailable on some platforms and filesystems.
      // Losing live refresh is a degraded experience, not a broken app.
      this.options.onError?.(error);
      this.watcher = null;
      return false;
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const paths = [...this.pending];
      this.pending.clear();
      if (paths.length) this.options.onChange(paths);
    }, this.options.debounceMs ?? 120);
  }

  /**
   * Suppress events for a path the app is about to write itself, so a save
   * does not bounce back as an "external change" and clobber the editor.
   */
  ignoreNext(relPath: string): void {
    this.pending.delete(relPath);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.watcher?.close();
    this.watcher = null;
  }
}
