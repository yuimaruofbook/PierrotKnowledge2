# SkillSpace

English · [日本語](../ja/skillspace.md)

How an agent picks the right procedure for a task and loads it **only when it needs it**.

---

## Contents

1. [Why this exists](#1-why-this-exists)
2. [Three tiers of disclosure](#2-three-tiers-of-disclosure)
3. [Writing a skill](#3-writing-a-skill)
4. [How selection works](#4-how-selection-works)
5. [The bundled skills](#5-the-bundled-skills)
6. [Connecting an agent](#6-connecting-an-agent)
7. [Running on a local model](#7-running-on-a-local-model)
8. [Measured token cost](#8-measured-token-cost)
9. [Troubleshooting](#9-troubleshooting)
10. [Loops (units of work)](#10-loops-units-of-work)

---

## 1. Why this exists

The obvious way to teach an agent your procedures is to put them all in the system prompt. That **degrades as you add skills**.

| Approach | 3 skills | 20 skills | Problem |
|----------|----------|-----------|---------|
| Everything in the prompt | ~1,900 tok | ~13,000 tok | No room left for the actual request |
| **SkillSpace** | **~230 tok** | ~1,500 tok | Only the chosen one is expanded |

The idea is one sentence:

> **Descriptions are always read. Procedures are read only when chosen.**

`description` is a **routing key** — what this skill is for — not a summary. The body is free to be long, because it is only paid for when opened.

---

## 2. Three tiers of disclosure

```
skills/
├── okf-ingest/
│   ├── SKILL.md      ← tier 2: read only when chosen
│   └── reference.md  ← tier 3: read only when the body points at it
├── wiki-answer/
│   └── SKILL.md
└── wiki-lint/
    └── SKILL.md
```

| Tier | MCP tool | Cost | Returns |
|------|----------|------|---------|
| **1** | `skill_find` / `skill_list` | ~free | Name, description, tags, and the **estimated token cost of opening it** |
| **2** | `skill_open` | one body | The chosen procedure, plus the names of supporting files |
| **3** | `skill_read` | one file | Only the supporting file the body pointed at |

Tier 1 contains **no procedure text at all**. That is the centre of the design, so it is asserted explicitly in `test/skillspace.test.ts` rather than left as an intention.

### What the agent does

1. Pass the user's request **verbatim** to `skill_find`
2. If `confidence` is `high`, `skill_open` the winner
3. If `low`, compare the descriptions first
4. If nothing fits, just work — **do not force it open**

---

## 3. Writing a skill

Create `skills/<name>/SKILL.md`, or use **Skill → ＋ 新しいスキル** in the app.

```markdown
---
name: okf-ingest
description: Turn material in raw/ into concept pages in wiki/. Use when ingesting meeting notes, exports or transcripts.
when: [ingest, 取り込み, 整理, meeting notes, export]
tags: [ingest, workflow]
allowed-tools: [read_agents_md, search, create_concept]
---

# Turning material into knowledge

(the procedure)
```

| Field | Required | Role |
|-------|----------|------|
| `name` | ✔ | Identifier. Lowercase, digits, hyphens. Must match the folder |
| `description` | ✔ | **The only part always in context.** Max 400 characters |
| `when` | | Extra vocabulary for selection. **Weighted higher than description** |
| `tags` | | Classification |
| `allowed-tools` | | Advisory only. Nothing is enforced from here — the layer contract is the only enforcement |

### Writing a good `description`

**Say when to use it, not what it does.**

| ✗ Weak | ✓ Strong |
|--------|----------|
| Ingestion procedure | Turn raw/ material into wiki/ pages. Use for meeting notes, exports, transcripts |
| About search | How to diagnose and fix Japanese search returning no hits |

The agent decides from this one sentence. If it does not describe a situation, it will not be selected.

### What `when` is for

`description` is prose to be **read**; `when` is vocabulary to be **found**.

```yaml
description: How to diagnose Japanese search returning no hits.
when: [検索, ヒットしない, no hits, bigram, search broken]
```

Put in the words someone would actually type — synonyms, the other language, product names. A `when` hit scores higher than a `description` hit.

### Supporting files

Put long reference tables and worked examples in separate files.

```
skills/okf-ingest/
├── SKILL.md       ← the procedure
└── reference.md   ← type design guidance (only when the body points at it)
```

End `SKILL.md` with "see `reference.md` for detail" and the agent will `skill_read` it only when it actually needs it.

---

## 4. How selection works

BM25-shaped scoring, computed locally. **No API call is made.**

### Weights

| Field | Weight | Why |
|-------|--------|-----|
| `name` | 6 | An identifier is the most direct match there is |
| `when` | 4 | The words a request actually uses |
| `tags` | 3 | Classification |
| `description` | 1 | Explanatory prose, not search vocabulary |

Matching **more distinct terms** also scores higher — two terms hitting once each is better evidence than one term hitting twice.

### Japanese

CJK expands into **overlapping bigrams**, the same technique the full-text index uses:

```
知識ベース → 知識, 識ベ, ベー, ース
```

So `知識ベース` matches inside `知識ベースの設計` with no word segmentation and no morphological analyser.

### Nothing matched means nothing returned

Returning an irrelevant candidate invites the agent to open it, and **a wrong `skill_open` costs more than not opening one**. Zero-score candidates are dropped and the tool says plainly that nothing matched.

### Try it in the app

Type a request into the box on the **Skill** tab to see which skill would win and what opening it would cost. It spends no tokens.

---

## 5. The bundled skills

A new bundle ships with three, covering one full ingest → answer → lint cycle.

| Skill | Selected by |
|-------|-------------|
| `okf-ingest` | "ingest this", "organise this", "these meeting notes…" |
| `wiki-answer` | "tell me about…", "what's the basis for…", "how does… work" |
| `wiki-lint` | "check this", "is it conformant", "find duplicates" |

Rewrite them for your own workflow. **They are a starting point, not a specification.**

---

## 6. Connecting an agent

The **接続 → エージェント接続** tab writes exactly one entry into the tool's own config.

### MCP hosts (configured by file)

| Tool | Config file | Shape |
|------|-------------|-------|
| **Claude Code** | `<bundle>/.mcp.json` | `mcpServers` |
| **Codex** | `~/.codex/config.toml` | `[mcp_servers.okf-wiki]` |
| **opencode** | `~/.config/opencode/opencode.json` | `mcp` (requires `type: "local"`) |
| **Hermes Agent** | `~/.hermes/config.yaml` | `mcp_servers` |

Claude Code alone is configured inside the bundle. Project scope means **your global agent settings are never touched** — run `claude` from the bundle folder and it is picked up automatically.

#### Safeguards

- **変更内容を見る** shows the exact bytes before anything is written
- The previous file is always moved to `<file>.okf-backup-<timestamp>` first
- **Existing settings survive.** One entry is added or replaced, nothing else
- Codex's TOML is edited **as text**, not parsed and re-emitted, so comments and key order are preserved

### Local model servers (they do not speak MCP)

**Ollama and llama.cpp are not MCP clients.** They are model servers: they can emit a tool call, but nothing on their side executes it.

So the app runs the loop itself — see the next section.

---

## 7. Running on a local model

The **接続 → ローカル実行** tab.

```
built-in agent
  ├ POST /v1/chat/completions  (Ollama | llama.cpp)
  ├ tools = [skill_find, skill_open, skill_read, retrieve,
  │          search, read_file, list_files, create_concept, write_file]
  └ loop: response → tool_call → execute → feed back → resend
```

### Requirements

| | Default URL | Note |
|---|-------------|------|
| **Ollama** | `http://localhost:11434/v1` | Needs a **tools-capable model** (`tools` in `ollama show <model>` capabilities) |
| **llama.cpp** | `http://localhost:8080/v1` | Start `llama-server` **with `--jinja`** |

> Without `--jinja`, llama.cpp **silently ignores** every tool. There is no error.

### How tokens are kept down

Local models have small context windows, so the built-in loop is stricter than the MCP path:

- **Skills are never preloaded.** The model is told to call `skill_find`
- **Nine tools, not nineteen.** A small model loses the request among a long tool list
- **Tool descriptions are cut to their first sentence**, since they are re-read every turn
- **Tool results are truncated at 4,000 characters**, keeping both ends and dropping the middle — retrieval puts its citations last, so trimming the tail would lose the sources
- **A round limit and a token budget** guarantee it stops

### Verified

qwen3.5:4b (4.7B, Q4_K_M) calls `skill_find` unprompted and routes correctly — asserted in the live test in `test/agent.test.ts`, which skips when no Ollama is running.

---

## 8. Measured token cost

Measured on the three bundled skills:

```
Catalogue (always)   ~230 tok    names + descriptions for all 3
okf-ingest  body     ~674 tok    only when opened
wiki-answer body     ~599 tok
wiki-lint   body     ~642 tok
─────────────────────────────
Load everything    ~2,145 tok
SkillSpace (one)     ~904 tok    catalogue + one body
Saving                   58%
```

The gap widens with scale. At twenty skills, the everything-in-the-prompt approach costs ~13,000 tokens; SkillSpace costs ~1,500 plus whichever one was chosen.

The `本文 ~NNN tok` badge on each row is what opening that skill costs.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| The agent never uses skills | Is it reading `AGENTS.md`? Tell it to call `read_agents_md` first |
| The wrong skill is chosen | Add the words users actually type to `when`. More effective than rewriting `description` |
| Nothing is ever chosen | The request's vocabulary appears in neither `description` nor `when`. Use the in-app tester while adjusting `when` |
| A skill is missing from the list | A skill with no `description` is **deliberately excluded** — it could never be selected. Check its SKILL.md |
| `skill_open` fails | Check that the folder name matches `name` |
| llama.cpp ignores tools | Start `llama-server` with `--jinja` |
| Ollama ignores tools | That model has no tool support. Check `ollama show <model>` |
| Undo a connection | Rename `<file>.okf-backup-<timestamp>` back |

---

## 10. Loops (units of work)

If a skill is *how* to do something, a loop is *when to start and when you are allowed to say you finished*.

### One design, one file

A loop is a **repeatable unit of work**. Running it does not create files.

```
loops/
├── ingest-notes.md    ← the ingest loop: design + run history
└── weekly-lint.md     ← the lint loop: design + run history
```

Run the same design a hundred times and there is still one file, with the history inside it. A file per *run* would mean hundreds of near-identical records for the same recurring task — unreadable, and large.

The rule is enforced, not merely recommended:

- Two designs never share a file
- Only one run may be in progress at a time
- Editing a design never rewrites its history

### Using it

| Stage | Tool | What you get |
|-------|------|--------------|
| List | `loop_list` | Designs, which is running, how each went last |
| Define | `loop_define` | Register goal, skill and completion checks |
| Start | `loop_start` | **Preflight state, skill, checks, and the last run** |
| Note | `loop_note` | Decisions (file changes are journalled automatically) |
| End | `loop_end` | **The diff, the checks, and a regression warning** |

### What you can check before working

`loop_start` returns the checklist:

```json
{
  "skill": "okf-ingest",
  "checks": ["checked for duplicates with search", "recorded sources"],
  "before": { "concepts": 42, "nonConformant": 0, "unresolvedLinks": 7 },
  "lastRun": { "status": "done", "outcome": "3 pages; 2 gaps left for next time" },
  "next": "skill_open(\"okf-ingest\") …"
}
```

Because the previous run's outcome is right there, work resumes where it stopped.

### What you can check after

```
- 概念: 42 → 45 (+3)
- OKF 非準拠: 0 → 0 (±0)
- 未解決リンク: 7 → 9 (+2)
```

- **A rise in non-conformance is returned as an error.** Fix it, then close again
- **A rise in unresolved links is normal** — gaps were identified

### Bounded history

| Range | Kept |
|-------|------|
| Last 5 runs | Full record including the journal |
| Up to 25 | One line each |
| Older | Count only, in frontmatter `runs` |

Thirty-one runs fit in roughly 3 KB.

### Bundled loops

| Design | Purpose |
|--------|---------|
| `ingest-notes` | Turn raw/ material into wiki/ pages |
| `weekly-lint` | Check and repair the bundle's health |

Add your own with `loop_define`.

---

## See also

- [Usage guide](./usage.md) — the whole interface
- [The LLM Wiki pattern](./llm-wiki.md) — the three layers, and why SkillSpace sits outside them
- [Workflows](./workflows.md) — ingesting, asking, linting in practice
- [OKF](./okf.md) — the file format `wiki/` uses
