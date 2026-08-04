# The LLM Wiki Pattern

English · [日本語](../ja/llm-wiki.md)

Source: Andrej Karpathy's [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (published April 2026)

---

## 1. The central claim

> **"RAG retrieves and forgets. A wiki accumulates and compounds."**

In conventional RAG, every question sends the model back to raw fragments and it **rebuilds its understanding from scratch**. Nothing accumulates. In the gist's words: «the LLM is rediscovering knowledge from scratch on every question. There's no accumulation.»

The LLM Wiki inverts the order. **Once, at ingestion time**, the model reads the sources, extracts structure, resolves contradictions, and writes the result into a cross-referenced set of Markdown pages. At query time it reads that **compiled understanding**.

- The cross-references are **already there**
- The synthesis **already reflects everything you've read**

Knowledge gets "built" the way software does.

---

## 2. The three layers

### Layer 1 — `raw/` (immutable, LLM read-only)

A curated collection of source documents. **Never modified by the LLM.** The single source of truth.

### Layer 2 — the wiki (mutable, LLM-owned)

LLM-generated Markdown: summaries, entity pages, concept pages, comparisons. The LLM maintains the cross-references. Directory structure is chosen per domain.

### Layer 3 — the schema (a configuration document)

**A document such as `CLAUDE.md`.** It defines the wiki's structure and conventions and specifies the workflows for ingesting, querying and maintaining. It **co-evolves** with the wiki.

[LLM Wiki v2](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2), which extends the gist with production lessons, puts it bluntly: **"The schema is the real product."** It encodes entity types, relationship rules, ingestion workflows, quality standards and contradiction handling.

> ### Correction
>
> Earlier documentation in this project called `.rag/` "Layer 3". **That was wrong.** The canonical third layer is the **schema document**, not a derived index. This page corrects it.
>
> The canonical third layer in this app is **`AGENTS.md`**. `.rag/` is an **addition** that does not exist in the canonical pattern — see [§5](#5-what-this-app-does-differently).

---

## 3. Special files

### `index.md`

A **content-oriented catalog** listing every page with a summary and metadata, organised by category. **Updated on every ingest.**

### `log.md`

An **append-only** chronological record, using consistent prefixes so ordinary tools can parse it.

> **A difference in this app**: OKF v0.2 §9 requires `log.md` to be grouped under `## YYYY-MM-DD` headings, **newest first**, which is incompatible with "append-only". This app **follows OKF** (new entries go at the top). Both specifications cannot be satisfied at once, so OKF was given precedence explicitly.

---

## 4. The three operations

| Operation | What it does |
|-----------|--------------|
| **Ingest** | Process a new source, extract key information, integrate it into the existing wiki. Per the gist, "a single source might touch 10-15 wiki pages" |
| **Query** | Search wiki pages and synthesise an answer **with citations**. Good answers can be filed back as new pages — this is where the compounding comes from |
| **Lint** | Health-check for contradictions, stale claims, orphan pages and missing cross-references |

---

## 5. What this app does differently

| Canonical | This app | Why |
|-----------|----------|-----|
| `raw/` immutable, LLM read-only | Same, but **writes are technically refused** | Enforcement, not convention. Checked on the resolved absolute path, so `./raw/x`, `raw\x` and `wiki/../raw/x` are all blocked |
| Wiki is LLM-owned | `wiki/` is **read/write for humans and agents equally** | "Symmetry between human and agent" is a stated design principle here; the UI and MCP share one write path |
| Schema = `CLAUDE.md` | Schema = **`AGENTS.md`** | Not tied to one agent product. The MCP tool `read_agents_md` makes agents read it first |
| (none) | **`.rag/`** — a BM25 index | **An addition.** See below |
| `log.md` append-only | OKF §9 (newest-first, date-grouped) | The two specs conflict; OKF wins |
| `index.md` free-form catalog | OKF §8 (headings + bullets) | Same reason |

### Why `.rag/` was added

The gist states its own scale limit:

> the `index.md` approach «works surprisingly well at moderate scale (~100 sources, ~hundreds of pages)» before requiring dedicated search infrastructure.

`.rag/` **is** that dedicated search infrastructure. It is not a departure from the pattern so much as an implementation of what the pattern anticipates.

This app chose **BM25 (SQLite FTS5)** rather than embeddings because:

- No model, no API key, no vector store — it is one file
- Keyword search over an already-curated wiki is accurate enough
- `.rag/` can be deleted and rebuilt, which keeps **File over App** intact

**The honest limit**: a paraphrase that shares no vocabulary with the answer will not be found. That is a property of BM25, not semantic understanding. This is why `retrieve` either says nothing was found or returns the best lexical matches **with citations** for the agent to judge.

### The three operations here

| Canonical | In this app |
|-----------|-------------|
| **Ingest** | Drop sources in `raw/` → agent reads with `read_file`, writes with `create_concept` → `rebuild_index` |
| **Query** | `retrieve` (citation anchors, character budget) / `search` (locate a page) / `Ctrl+K` in the UI |
| **Lint** | `check_conformance` (OKF violations) / `unresolved_links` (knowledge gaps) / non-conformance count in the status bar |

---

## 6. Japanese search

This belongs to neither the canonical pattern nor OKF; it is specific to this app.

### The problem

SQLite's `unicode61` tokenizer **cannot segment Japanese**. Measured:

| Tokenizer | `軽量` (mid-sentence) | `知識` | `ノート` |
|---|---|---|---|
| `unicode61` (stock) | **0 hits** | 0 | **0** |
| `trigram` | **0** (needs ≥3 chars) | **0** | 1 |

`unicode61` turns a whole sentence into one token; `trigram` cannot match anything under three characters. That rules out the two-character words Japanese is full of (知識, 軽量, 設計).

### The fix

**Expand CJK runs into overlapping bigrams at both index time and query time.**

```
知識ベース → 知識 / 識ベ / ベー / ース
```

`unicode61` preserves a space-separated bigram **even across a script boundary** (`識ベ`, `トア`) — verified empirically before this was built on. Because both ends go through the same transformation, they line up exactly.

### Two matching modes

| Mode | Used by | Behaviour |
|------|---------|-----------|
| **phrase** | `search` (locate a page) | Bigrams must be adjacent, so `知識ベース` cannot match a page that merely contains `知識` and `識ベ` in unrelated places |
| **loose** | `retrieve` (answer a question) | Every token ORed, ranked by BM25 — a question is a paraphrase, not an exact term |

Loose matching alone would return plausible-looking passages for a nonsense question, so retrieval additionally requires **at least two matching content tokens**. "Content" excludes pure-hiragana bigrams (はど, どう, てい), which are grammar: no document contains that particular glue, so counting it would make a long question look unmatched against the very page that answers it.

Snippets are generated in application code rather than by SQLite's `snippet()`, because the indexed text is a stream of bigrams and would be unreadable.

---

## 7. When this pattern fits

### Good fit

- Personal or small-team knowledge bases (the gist suggests ~100 sources, hundreds of pages)
- Sources that are **stable**, so the cost of compiling is repaid many times
- Design decisions and research notes where "why we chose this" matters
- Setups where humans and agents consult the same knowledge

### Poor fit

- Sources that **churn constantly** — you never recover the compilation cost
- Exhaustive search across large unstructured corpora — plain RAG is more honest
- Cases needing verbatim quotation of the source, since a wiki is synthesised

### In between

This app deliberately does **both**: a compiled wiki (the pattern's claim) with BM25 retrieval on top (RAG-style lookup). The difference from plain RAG is *what* gets retrieved — curated sections, not raw fragments.

---

## 8. Further reading

- [Karpathy, LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — primary source
- [LLM Wiki v2](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2) — extensions from production use ("the schema is the real product")
- [Karpathy's LLM Wiki Pattern: When Compiled Knowledge Beats RAG](https://particula.tech/blog/karpathy-llm-wiki-compiled-knowledge-vs-rag)
- [LLM Wiki vs RAG: A Decision Framework](https://www.mindstudio.ai/blog/llm-wiki-vs-rag-knowledge-base)
- [LLM Wikis: A Better Knowledge Base for AI Agents](https://anovate.ai/blog/LLM-Wikis-A-Better-Knowledge-Base-for-AI-Agents)
- [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) — another implementation of the pattern

---

## See also

- [Usage guide](usage.md)
- [OKF v0.2 guide](okf.md) — the file format
- [Workflows](workflows.md) — ingest / query / lint in practice
- [Architecture](../ARCHITECTURE.md) — how the code is structured
