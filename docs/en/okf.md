# Open Knowledge Format (OKF) v0.2

English · [日本語](../ja/okf.md)

Specification: [OKF SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (retrieved and checked against on 2026-08-01)

---

## 1. What OKF is

**A minimal agreement that lets a directory tree of Markdown files serve as a knowledge base.**

No proprietary database, no dedicated viewer, no lock-in. All it asks is:

- Files are Markdown
- Concept files carry YAML frontmatter
- That frontmatter has a `type`

**That is full conformance.** The spec says so repeatedly — «a concept carrying just `type` is fully conformant».

### The problem it solves

Knowledge-base formats usually fail in one of two directions:

| Direction | Failure |
|-----------|---------|
| Schema too strict | Writing becomes a chore; nobody keeps it up |
| A pile of Markdown with no rules | Machines can't read the structure; no tooling is possible |

OKF picks a position: **exactly one required field, everything else optional**. Light enough to hand-write, structured enough that tools can rely on a floor of type, links and provenance.

---

## 2. Bundle structure

A **bundle** is a directory tree of Markdown files.

```
bundle-root/
  index.md            (optional, reserved)
  log.md              (optional, reserved)
  <concept>.md
  <subdirectory>/
    index.md
    <concept>.md
```

`index.md` and `log.md` are **reserved**. Every other `.md` is a **concept document**.

A bundle may be distributed as a git repository (recommended — history, attribution and diffs come free), a tarball or zip, or a subdirectory of a larger repository.

### Where the bundle root is in this app

> **Important**: in this app the **`wiki/` directory is the OKF bundle root.**
>
> ```
> my-knowledge/          ← the folder the app opens
> ├── AGENTS.md          ← agent contract (outside OKF)
> ├── raw/               ← immutable sources (outside OKF)
> ├── wiki/              ← ★ the OKF bundle root ★
> │   ├── index.md
> │   ├── log.md
> │   └── **/*.md
> └── .rag/              ← derived index (outside OKF)
> ```
>
> `raw/` and `.rag/` are siblings *outside* the bundle and are not governed by OKF. The reasoning is in [the LLM Wiki guide](llm-wiki.md).
>
> If you open a folder with no `wiki/`, that folder becomes the bundle root.

---

## 3. Concept documents

### Concept id

> «The path of the concept's file within the bundle, with the `.md` suffix removed.»

`tables/customers.md` → concept id `tables/customers`.

In this app `wiki/topics/foo.md` → `topics/foo`, because the bundle root is `wiki/`.

### Frontmatter

**Only `type` is required.**

```yaml
---
type: Concept
---
```

`type` is a free string. The spec never enumerates values, and consumers **must not reject an unknown `type`**. Design your own vocabulary: `Concept`, `Entity`, `Summary`, `Playbook`, `Note`, `Decision`, whatever fits.

### Recommended fields

| Field | Meaning |
|-------|---------|
| `title` | Display name |
| `description` | One-line summary |
| `resource` | Canonical URI |
| `tags` | Categorisation list |

---

## 4. Reserved files

### `index.md` (§8)

Enumerates a directory's contents to support **progressive disclosure** — a reader sees the shape of the bundle before opening any single page.

- **No frontmatter.** The single exception: the **bundle-root `index.md` may carry `okf_version`**
- The body uses one or more sections, each grouping concepts under a heading
- Entries take the form `* [Title](url) - short description`
- Descriptions should come from the linked concept's `description`
- Producers may generate it; consumers may synthesise one when it's absent

What this app generates:

```markdown
---
okf_version: 0.2
---

# My Knowledge

## Concepts

* [Design principles](/design.md) - Why this project is built the way it is

## topics

* [Retrieval design](/topics/rag.md) - How search and retrieval work
```

Links use the **bundle-absolute form** (`/design.md`) the spec recommends, because it survives a document moving within its subdirectory.

### `log.md` (§9)

Records the history of changes. Entries are **grouped by date, newest first**.

- Date headings **must** use ISO 8601 `YYYY-MM-DD`
- Entries are prose; the leading bold word (`**Update**`, `**Creation**`, `**Deprecation**`) is a convention, not a requirement

What this app generates:

```markdown
# Log

## 2026-08-01

* **Creation**: `wiki/topics/rag.md` by process:claude-code.
* **Update**: `wiki/design.md` by human:kn.

## 2026-07-31

* **Move**: `wiki/old.md → wiki/new.md` by human:kn. 3 link(s) updated
```

> **A deliberate trade-off**: newest-first means a read-modify-write on every entry rather than an O(1) append. That is the price of a format a person can actually read.

---

## 5. Cross-linking (§6)

Two forms exist.

| Form | Example | Interpretation |
|------|---------|----------------|
| **Absolute** (recommended) | `[customers](/tables/customers.md)` | From the bundle root |
| **Relative** | `[neighbour](./other.md)` | Standard Markdown relative path |

The spec prefers absolute: «it is stable when documents are moved within their subdirectory».

### Broken links are normal

> «Consumers MUST tolerate broken links: a link whose target does not exist in the bundle is not malformed; it may simply represent not-yet-written knowledge.»

This app leans into that. Unresolved links are surfaced as **visible knowledge gaps** and are the main path to creating new pages.

### This app's extension: wikilinks

`[[id]]` and `[[id|label]]` are supported. They are outside OKF, but they **resolve into the same id space**, so the link graph stays uniform. What lands in the file is either standard Markdown or `[[...]]` — both within what the spec permits.

---

## 6. Provenance, trust and lifecycle (§5)

All optional. A concept with none of it is fully consumable.

### `sources` (§5.1)

```yaml
sources:
  - id: q3-report
    resource: /raw/q3-2026.pdf
    title: Q3 2026 results deck
    author: human:finance-team
    usage_count: 14
    last_modified: 2026-07-15
usage_window: { from: 2026-04-01, to: 2026-06-30 }
```

| Key | Required | Meaning |
|-----|----------|---------|
| `resource` | **yes** | A concrete artifact a consumer can follow (URL, bundle-relative path) or a scope descriptor |
| `id` | no | A stable key for attributing individual claims |
| `title` | no | Human-readable label |
| `author` | no | Who produced it, in the actor convention |
| `usage_count` | no | How often it was exercised over `usage_window` |
| `last_modified` | no | When the source itself last changed |

Per-claim attribution uses Markdown footnotes keyed on `sources[].id`.

> This app **preserves `sources` but does not interpret it** — footnote reconciliation is not implemented.

### `generated` and `verified` (§5.2)

```yaml
generated:
  by: process:claude-code    # required within generated
  at: 2026-08-01T10:00:00Z   # optional
verified:
  - by: process:ci
    at: 2026-08-01T11:00:00Z
  - by: human:kn
    at: 2026-08-02T09:00:00Z
```

- `generated` — how the current content **was produced**
- `verified` — whether it has been **confirmed against sources**

They are independent: content can change without re-confirmation, and facts can be re-confirmed without regeneration.

> A single verifier may be written as a bare mapping without the list dash. **Consumers MUST treat a bare mapping as a one-element list.** This app does.

### Trust tiers (§5.3)

Derived from `verified`:

| Condition | Tier |
|-----------|------|
| No `verified` key | **unverified** |
| Verified only by non-`human:` actors | **machine-confirmed** |
| Verified by a `human:<id>` actor | **human-reviewed** |

> «Trust tiers are advisory signals, not access control.»
> A concept with no trust frontmatter is still consumable and must not be rejected.

> This app implements the derivation but **has not wired it to a UI badge**.

### `status` (§5.4)

| Value | Meaning |
|-------|---------|
| `draft` | Not yet reviewed; possibly incomplete |
| `stable` | **Default.** Ready for consumption |
| `deprecated` | Kept for links and history; no longer current |

Absent `status` ⇒ `stable`.

### `stale_after` (§5.5)

An **absolute date** (`YYYY-MM-DD`). A concept is stale when `today >= stale_after`.

An absolute date rather than a relative TTL keeps staleness a **plain date comparison with no reference to when the concept was read**.

---

## 7. Actor convention (§7)

| Kind | Form | Example |
|------|------|---------|
| Agents and tools | `<producer>/<version>` | `reference_agent/gemini-2.5-pro` |
| People | `human:<id>` | `human:kn` |
| Automated processes | `process:<id>` | `process:finance-nightly` |

> Consumers classifying trust key off the `human:` prefix, so producers **must** use it for hand-authored or human-confirmed content.

This app records UI edits as `human:local` and MCP writes as `process:mcp` (overridable via each tool's `actor` argument).

---

## 8. Conformance (§11)

A bundle **conforms** to OKF v0.2 if:

1. Every non-reserved `.md` in the tree contains a parseable YAML frontmatter block
2. Every frontmatter block contains a **non-empty `type`**
3. Every reserved file present follows §8 / §9

### What a consumer must not do

The spec constrains **rejection** far more than authoring. Consumers must not reject a bundle because of:

- Missing optional frontmatter fields
- Unknown `type` values
- Unknown additional frontmatter keys
- Broken cross-links
- Missing `index.md` files

**OKF is deliberately permissive.** The strictness lives in the reader's tolerance, not the writer's burden.

---

## 9. Implementation status in this app

| § | Topic | Status |
|---|-------|--------|
| 3 | Bundle structure | ✅ |
| 4 | Concept documents / ids | ✅ |
| 5.1 | `sources` | ⚠️ Preserved, not interpreted |
| 5.2 | `generated` / `verified` | ✅ Bare mapping handled |
| 5.3 | Trust tiers | ⚠️ Derived, not surfaced in the UI |
| 5.4 | `status` | ✅ |
| 5.5 | `stale_after` | ✅ |
| 6 | Cross-linking | ✅ Both forms; broken links tolerated |
| 7 | Actor convention | ✅ |
| 8 | `index.md` | ✅ With `okf_version: 0.2` at the root |
| 9 | `log.md` | ✅ |
| 10 | Attested computations | ❌ Not implemented |
| 11 | Conformance | ✅ |
| 12 | Versioning | ✅ |

The clause-by-clause audit — including the five real violations found and fixed — is in the [conformance report](../CONFORMANCE.md).

---

## 10. Common questions

**What should I put in `type`?**
Anything. The spec does not define values. Start small (`Note`, `Concept`) and add more when a distinction earns its keep. `list_tags` shows what's already in use.

**What if I forget the frontmatter?**
The app **does not refuse the save**. It warns in the status bar and counts the file as non-conformant, because §11 forbids rejection.

**Can I hand-write `index.md`?**
Yes — but "Rebuild" regenerates and overwrites it. Don't use Rebuild if you maintain it by hand.

**Is OKF compatible with Obsidian Markdown?**
Frontmatter and standard links are. `[[wikilinks]]` resolve here too. Obsidian-specific syntax (embeds `![[...]]`, Dataview queries) is not interpreted.

**Can I delete `.rag/`?**
Yes. It's derived. "Rebuild" restores it.

---

## See also

- [Usage guide](usage.md)
- [LLM Wiki pattern](llm-wiki.md) — why the three-layer split
- [Workflows](workflows.md)
- [Conformance report](../CONFORMANCE.md)
