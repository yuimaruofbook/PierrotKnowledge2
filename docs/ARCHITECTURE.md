# Architecture

## Process model

```
┌──────────────────────────────────────────────────────┐
│ Bun process (okf ui, or the headless server)         │
│                                                      │
│   Workspace ──┬── Bundle    (okf/)  concepts + graph │
│               ├── FtsIndex  (rag/)  SQLite FTS5      │
│               └── Watcher   (watch) external edits   │
│         ▲                                            │
│         │ same object, two front ends                │
│    ┌────┴─────┬──────────────┐                       │
│  RPC handlers │  MCP stdio server                    │
└────┬──────────┴──────────────┬───────────────────────┘
     │ typed RPC over a         │ JSON-RPC 2.0 (NDJSON)
     │ loopback WebSocket       │
     ▼                          ▼
 Your own browser           External agents
 (vanilla TS UI)            (Claude Code, …)
```

`Workspace` is the single place that opens a bundle, enforces the layer
contract, writes files, appends to `log.md` and updates the index. The GUI and
the MCP server are both thin adapters over it — which is what makes a human
edit and an agent edit genuinely symmetric rather than merely similar.

The webview owns no filesystem capability. Every path it knows came from the
Bun side over RPC.

## Layer contract

| Layer | Path | Mutability | Enforced by |
|-------|------|------------|-------------|
| 1 Raw | `raw/` | Immutable | `BundlePaths.assertWritable` |
| 2 Wiki | `wiki/` (or the bundle root) | Read/write by human + agent | — |
| 3 RAG | `.rag/` | Rebuild only | `BundlePaths.assertWritable` |

Layer checks run on the *resolved* absolute path, not on a string prefix, so
`./raw/x`, `raw\x` and `wiki/../raw/x` are all rejected. The same resolver
rejects traversal out of the bundle, which matters because MCP hands
agent-authored paths straight to the read and write calls.

### Flat bundles

`wiki/` is detected, not required. When it is absent the bundle root *is* the
wiki layer, so an existing folder of Markdown opens as a bundle with no
restructuring. `BundleInfo.wikiDir` tells the UI which layout it got.

## Data flow

1. **Open** — walk the wiki layer → parse concepts → resolve links in a second
   pass (every id must be known first) → invert the graph into backlinks →
   `FtsIndex.sync` reindexes only what changed by mtime.
2. **Edit** — resolve and layer-check the path → write → reparse → update the
   FTS row → append one row to `log.md`.
3. **Search** — text is bigram-normalised, quoted per term into an FTS5 `MATCH`
   expression, then ranked by BM25 over chunks with the title weighted 12× and
   the heading 4× the body.
4. **External change** — the watcher debounces, skips the app's own writes,
   refreshes just those paths, and pushes `fileChanged` to the UI. A clean
   buffer reloads silently; a dirty one is flagged, never overwritten.

## Why these choices

**The browser you already run, over shipping one** — until 0.5.0 this was a
packaged desktop app built on the system WebView instead of a bundled Chromium.
The premise did not survive measurement. Windows starts six renderer processes
for one window (360 MB), and the packaged build carried a second Bun runtime,
for 633 MB resident against 135 MB serving the identical interface to an open
browser.

The window was removed once its last exclusive capability — the native folder
dialog — was replaced by asking the OS directly (`src/bun/platform.ts`). What
it cost to keep was 5× the memory and a patched pin of a young framework; what
it bought was a page unreachable by browser extensions, which is real but
addressable with an extension-free browser profile.

**Vanilla TS over a framework** — the UI is a tree, a textarea and a result
list. The whole view bundle is ~80 kB, most of it the Markdown parser; a
framework would cost more than the feature set it would serve.

**No UI framework and now no UI runtime** — with the desktop shell gone the
dependency list is `marked`, `turndown` (+ its GFM plugin), `yaml` and Vite.
`node_modules` went from 504 MB to 145 MB, and the patched-dependency
maintenance — a fork-pin re-checked on every upgrade — went with it. It also
unblocked `exactOptionalPropertyTypes`, which had been held off only because
that package shipped raw `.ts` that `skipLibCheck` could not hide.

**FTS5 over embeddings** — keyword search over a curated OKF corpus is enough
for agent retrieval, and it costs one file: no model, no API key, no vector
store. `.rag/` is disposable by design. The honest limit is paraphrase: a
question sharing no vocabulary with the answer will not be found, which is why
retrieval returns the best lexical matches with citations for the agent to
judge rather than claiming semantic understanding.

**Bigrams over a stock tokenizer** — `unicode61` cannot segment Japanese, so
`軽量` mid-sentence is unfindable; `trigram` cannot match anything under three
characters, which excludes most Japanese words. Expanding CJK runs to
overlapping bigrams at both index and query time makes both ends agree, and
`unicode61` preserves a space-separated bigram even across a script boundary.

**Chunks over documents** — retrieving a whole page returns mostly irrelevant
text and crowds the context window. Headings are the author's own structure, so
sections make honest chunks, each carrying a heading path that is both context
for a model and a citable anchor for a person.

**Sanitised DOM over `innerHTML`** — note content is untrusted: it comes from
disk, from imports, and from agents. The webview holds an RPC bridge to a
process with full filesystem authority, so the preview renders through an
element/attribute allowlist and a URL-scheme check, behind a restrictive CSP.

## Module map

| Path | Responsibility |
|------|----------------|
| `src/shared/okf/text.ts` | Bigram normalisation, query building, snippets. The reason Japanese search works. |
| `src/shared/okf/chunk.ts` | Heading-based chunking and citation anchors. |
| `src/shared/okf/links.ts` | Link extraction, resolution, and code masking. |
| `src/shared/okf/rename.ts` | Link rewriting, so a move cannot break the graph. |
| `src/shared/okf/` (rest) | Frontmatter framing, ids, conformance, reserved-file rendering. No I/O. |
| `src/shared/fuzzy.ts` | Subsequence ranking for the switcher and autocomplete. |
| `src/shared/types.ts` | Data types only. |
| `src/shared/rpc-schema.ts` | The typed RPC contract: what each side handles and receives. |
| `src/bun/okf/paths.ts` | Path containment and the layer contract. The only way to build an absolute path. |
| `src/bun/okf/bundle.ts` | Filesystem read model: walk, read, write, move, delete, index/log, graph. |
| `src/bun/okf/parser.ts` | The only YAML dependency; concept (de)serialisation. |
| `src/bun/okf/scaffold.ts` | Idempotent creation of a new three-layer bundle. |
| `src/bun/rag/fts.ts` | Chunk-level FTS5 index with incremental sync and filters. |
| `src/bun/rag/retrieve.ts` | Budgeted, cited context assembly for agents. |
| `src/bun/watch.ts` | Debounced recursive watching. |
| `src/bun/workspace.ts` | Lifecycle and orchestration — the app core. |
| `src/bun/mcp/` | Tool definitions, dispatch, and the stdio JSON-RPC loop. |
| `src/mainview/ui/keymap.ts` | Editor text transforms as pure functions. |
| `src/mainview/` (rest) | Webview: RPC client, sanitising renderer, UI panels. |

## Retrieval index

```
docs(id, path, title, type, tags, mtime)
chunks(chunk_id, doc_id, ord, heading_path, text, char_start)   ← original text
chunks_fts(chunk_id, title_n, heading_n, text_n)                ← normalised only
```

`chunks` holds readable text; `chunks_fts` holds the bigram-expanded projection
that only SQLite reads. Keeping them apart is what allows snippets to be built
from prose rather than from a stream of bigrams — SQLite's own `snippet()` can
only see the indexed form.

Two query modes share one index. `search` uses **phrase** matching, where a
multi-bigram term must appear contiguously, so `知識ベース` cannot match a page
that merely contains `知識` and `識ベ` in unrelated places. `retrieve` uses
**loose** matching — every token ORed, BM25 ranking — because a question is a
paraphrase, not a term.

Loose matching alone would let a passage qualify on one incidental bigram, so
retrieval additionally requires a passage to share at least two *content*
tokens with the query. Content excludes pure-hiragana bigrams, which are
grammar (はど, どう, てい): counting them would make a long question look mostly
unmatched against the very page that answers it.

## MCP transport

Newline-delimited JSON-RPC 2.0 over stdio — one object per line, never
LSP-style `Content-Length` framing, which no MCP client parses. Notifications
(no `id`) draw no response at all, not even an error. The protocol version is
negotiated against `2025-06-18`, `2025-03-26` and `2024-11-05`.

Diagnostics from the standalone server go to stderr only: stdout carries the
protocol, and one stray log line there corrupts the stream.

## Build

One bundler, one target. Vite builds the page to `src/mainview/dist`, which
`okf ui` serves over loopback. The Bun side is not bundled for normal use — it
runs from source — and `bun run build:headless` compiles it to a single
executable for agent hosts that must spawn it without Bun on PATH.

The scaffold templates in `templates/` are inlined into the Bun bundle at build
time via text imports, so they stay browsable Markdown on disk while needing no
runtime asset-path resolution.

`tsconfig.json` covers the Bun side and the tests with no DOM lib;
`tsconfig.view.json` covers the webview with DOM and no Bun types. Neither side
can accidentally type-check against capabilities it does not have.
