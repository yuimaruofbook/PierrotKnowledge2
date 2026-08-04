# Workflows

English · [日本語](../ja/workflows.md)

Practical recipes. Skim [Usage](usage.md) and [the LLM Wiki pattern](llm-wiki.md) first and these will make more sense.

---

## Contents

1. [The core loop](#1-the-core-loop)
2. [Ingesting sources](#2-ingesting-sources)
3. [Asking questions](#3-asking-questions)
4. [Keeping it healthy](#4-keeping-it-healthy)
5. [Growing AGENTS.md](#5-growing-agentsmd)
6. [Designing `type`](#6-designing-type)
7. [Designing tags](#7-designing-tags)
8. [Recipes by use case](#8-recipes-by-use-case)
9. [Working as a team](#9-working-as-a-team)
10. [When it grows](#10-when-it-grows)
11. [Anti-patterns](#11-anti-patterns)
12. [Prompt templates](#12-prompt-templates)

---

## 1. The core loop

```
   ┌─────────────────────────────────────────┐
   │                                         │
   ▼                                         │
 Put sources in raw/                         │
   │                                         │
   ▼                                         │
 Ingest ── agent reads them, writes wiki/    │
   │                                         │
   ▼                                         │
 Query ─── retrieve answers questions        │
   │                                         │
   ▼                                         │
 Lint ──── fix gaps and violations ──────────┘
           (the gaps drive the next ingest)
```

**Compounding happens when this loop turns.** File answers back, fill unresolved links, and every pass makes the next question faster and better grounded.

---

## 2. Ingesting sources

### Steps

1. Put the original in `raw/` (PDFs, meeting notes, exports, transcripts).
2. Tell the agent to ingest it.
3. Run `rebuild_index` to refresh `index.md`.

Besides dropping in a file, step 1 has two other routes:

- **Paste from another tool** — content from Notion or Google Docs arrives as Markdown with its formatting intact.
- **Connect over MCP** — the toolbar's Connect panel calls Notion, GitHub, Google Drive and the like, and captures the result into `raw/` with its origin and arguments already recorded, so you never write the provenance by hand.

Both are covered in the [usage guide](./usage.md#10-importing-from-external-services). **Either way, ingest ends at `raw/`** — everything after that is the same curation work.

### A prompt that works

```
Read raw/2026-q3-review.md and ingest it into the wiki.

Steps:
1. read_agents_md to learn this bundle's conventions
2. search for existing related pages (do not create duplicates)
3. create_concept for genuinely new concepts
4. write_file to extend existing pages
5. cross-reference related pages with [[wikilinks]]
6. finish with rebuild_index

Rules:
- never modify anything in raw/
- one source may touch many pages; ten is fine
- record provenance in frontmatter `sources`
- link to concepts you haven't written yet with [[...]] — leave them unresolved
```

That last rule matters. **Unresolved links make missing knowledge visible** and become the plan for the next ingest.

### Record provenance

```yaml
---
type: Summary
title: Q3 2026 review — key points
sources:
  - id: q3-review
    resource: /raw/2026-q3-review.md
    title: Q3 review meeting notes
    last_modified: 2026-07-15
generated:
  by: process:claude-code
  at: 2026-08-01T10:00:00Z
---
```

Later you can trace where a claim came from.

### Don't make one page per source

As the gist puts it, «a single source might touch 10-15 wiki pages». One page per document is **filing, not knowledge work**. Cut along entities, concepts and decisions instead.

---

## 3. Asking questions

### `retrieve` vs `search`

| Goal | Tool | Returns |
|------|------|---------|
| Answer "what is X" | **`retrieve`** | Section-level passages + citation anchors + character budget |
| Find "which page is X" | **`search`** | One hit per document with the matching section |

A prompt:

```
Answer using only this knowledge base.
Call read_agents_md first, then retrieve.
Cite the anchor (e.g. topics/foo.md#heading) for every claim.
```

### Narrowing

```
retrieve("how is auth implemented?", type="Playbook", tags=["security"])
retrieve("why did we choose this", path_prefix="wiki/decisions/")
```

### Budgets

```
retrieve("give me the whole picture", limit=15, budget_chars=12000)
retrieve("one line answer", limit=2, budget_chars=800)
```

Defaults are 8 passages and 6000 characters. The budget is in characters, not tokens, because tokenisation is model-dependent — **an approximate cap that admits it is approximate**.

### File good answers back

This is where compounding actually lives.

```
Save that answer as wiki/topics/auth-overview.md.
Use type: Summary and [[link]] to each page you drew on.
```

Next time the question comes up, one synthesised page answers it.

---

## 4. Keeping it healthy

A weekly or monthly pass.

### Delegate it

```
Health-check the wiki.

1. check_conformance — fix OKF violations (missing frontmatter or type)
2. unresolved_links — list missing pages and propose which are worth writing
3. list_concepts — find orphans (no backlinks)
4. flag contradictions between pages

If you find a contradiction, do not delete either side.
Keep both, use status: deprecated where appropriate, and explain in the body.
```

### In the UI

| Check | Where |
|-------|-------|
| Non-conformance count | Right of the status bar |
| The list | `Ctrl+Shift+P` → check OKF conformance |
| Unresolved links | Toolbar badge, or `Ctrl+Shift+P` |

### Managing staleness

```yaml
stale_after: 2026-12-31
```

Past that date the concept counts as stale. Because it's an absolute date rather than a relative TTL, the verdict doesn't depend on when you read it.

---

## 5. Growing AGENTS.md

> **"The schema is the real product."**

`AGENTS.md` is not documentation — it is **the operating rules of the knowledge base**. Grow it as you use it.

Put in it:

- What domain this bundle covers
- Which `type` values exist and what each means
- Directory conventions (`decisions/`, `entities/`, `topics/`)
- How granular ingestion should be
- What to do when sources contradict
- Quality bar: are sources mandatory? is `verified` expected?

A template lives at `templates/AGENTS.md` and is copied into every new bundle.

Agents read it first, so **editing it changes how every agent behaves**.

---

## 6. Designing `type`

OKF does not define values. Start small.

### Starting set

| type | Use |
|------|-----|
| `Note` | Anything unsorted |
| `Concept` | A definition or idea |

### Once it grows

| type | Use |
|------|-----|
| `Entity` | A person, org, product, system |
| `Summary` | Synthesis across several sources |
| `Playbook` | Procedures and operations |
| `Decision` | A recorded decision (ADR-like) |
| `Question` | An open question |

`Question` is worth adopting. **Making unanswered questions first-class** keeps gaps visible.

`list_tags` shows which types are in use.

---

## 7. Designing tags

If `type` is *what this is*, tags are *what context it belongs to*.

- **Keep them few.** Fifty tags means none of them mean anything
- **Keep them orthogonal** to `type` — `type: Playbook` + `tags: [security]`, not both saying the same thing
- Sidebar tag chips filter search

---

## 8. Recipes by use case

### Technical documentation

```
raw/          specs, RFCs, API docs
wiki/
  concepts/   domain vocabulary
  systems/    components (type: Entity)
  decisions/  design decisions (type: Decision)
  playbooks/  operations (type: Playbook)
```

**The payoff**: recording *why* in `Decision` pages saves both your future self and any agent reading the codebase.

### Research notes

```
raw/          papers, transcripts, experiment logs
wiki/
  papers/     per-paper summaries (type: Summary, sources required)
  concepts/   methods and ideas (type: Concept)
  questions/  open questions (type: Question)
```

**The payoff**: always fill `sources`, and record human checks in `verified` so the trust tier reaches `human-reviewed`.

### Meetings and decisions

```
raw/          raw minutes
wiki/
  decisions/  decisions (type: Decision, with stale_after)
  people/     participants (type: Entity)
  topics/     running threads
```

**The payoff**: `stale_after` on decisions forces periodic review.

### Codebase knowledge

```
raw/          design notes, incident reports
wiki/
  modules/    module responsibilities (type: Entity)
  patterns/   conventions (type: Playbook)
  incidents/  what broke and why (type: Summary)
```

**The payoff**: point a coding agent's MCP at this bundle and it can consult design intent before reading code.

### Personal Zettelkasten

```
wiki/          (raw/ optional)
  *.md         flat, connected by [[links]]
```

**The payoff**: you can skip `wiki/` entirely and open a flat folder. Creating unresolved links freely and filling them later suits this style.

---

## 9. Working as a team

**Share it with git.** Notes are Markdown, so diffs, review and history all work.

Recommended `.gitignore`:

```gitignore
.rag/        # derived; each machine rebuilds it
```

Whether to commit `raw/` depends on the material. For large binaries use Git LFS, or keep them outside and point at them with `resource`.

### Merge behaviour

- `wiki/**/*.md` — ordinary Markdown diffs, easy to merge
- `wiki/index.md` — generated. On conflict take either side and press Rebuild
- `wiki/log.md` — **newest-first**, so conflicts cluster at the top. Keep both sides when merging

### Use actors meaningfully

```
human edits   → human:<name>
CI/automation → process:<name>
agents        → process:claude-code, etc.
```

It lands in `log.md` and `generated.by`, and drives the trust tier.

---

## 10. When it grows

The gist puts the `index.md` limit at «~100 sources, ~hundreds of pages». This app extends past that with a BM25 index, but operational care still helps.

| Symptom | Fix |
|---------|-----|
| `index.md` too long to read | Add subdirectories. OKF allows nested `index.md` (this app doesn't generate them, but you can write them) |
| Too many search results | Filter by `type`, `tags`, `path_prefix` |
| `retrieve` returns the wrong thing | Make the question more specific, or raise `min_content_matches` |
| Near-duplicate pages | Merge into one; mark the old one `status: deprecated` and keep the link |
| Index feels slow | Delete `.rag/` and rebuild |

---

## 11. Anti-patterns

| Tempting | Why it hurts | Instead |
|----------|--------------|---------|
| Editing `raw/` directly | The source of truth is gone; the app refuses anyway | Write in `wiki/` |
| One page per source | Filing, not knowledge work | Cut by concept and entity |
| Deleting unresolved links | You lose the record of what's missing | Keep them as the backlog |
| Renaming via `write_file` + `delete_file` | **Inbound links break silently** | Use `move_file` |
| Deleting one side of a contradiction | The history of the disagreement is lost | Keep both, mark `deprecated`, explain |
| Inventing 20 `type` values on day one | Nobody can apply them consistently | Start with `Note` and `Concept` |
| Committing `.rag/` | It's derived — pure merge noise | Add it to `.gitignore` |
| Letting agents skip AGENTS.md | Conventions erode and the bundle rots | Make `read_agents_md` the first call |

---

## 12. Prompt templates

### Ingest

```
Ingest raw/<file> into the wiki.
Order: read_agents_md → search (check for duplicates) → create_concept / write_file → rebuild_index.
Never modify raw/. Leave [[links]] to concepts not yet written.
```

### Research

```
Answer "<question>" using only this knowledge base.
Use retrieve and cite the anchor for each claim.
If the evidence is thin, say so and name what is missing rather than guessing.
```

### Periodic health check

```
Health-check the wiki: check_conformance, unresolved_links, and orphan pages.
Propose fixes before applying them. Never delete a page — propose deletions only.
```

### Growing the wiki

```
Review unresolved_links, pick the three most valuable missing pages,
and write them from sources in raw/.
If a page has no supporting source, skip it and report that instead of inventing content.
```

---

## See also

- [Usage guide](usage.md) — the operations in detail
- [OKF v0.2 guide](okf.md) — the file format
- [LLM Wiki pattern](llm-wiki.md) — the reasoning behind the design
