# PierrotKnowledge2
This is an ultra-lightweight local knowledge base compliant with OKF v0.2 and LLMwiki. Unlike its predecessor, this version prioritizes functionality over excessive security.
Embodying the concept of being "as light as air," it is designed to allow data to be saved from anywhere.

"Let them laugh. The fool sees what the crowd ignores."

"PierrotKnowledge was forged under a single conviction: Let them laugh.
Real breakthroughs often look absurd to the status quo. We built this willing to play the fool, so we could build something that truly matters."

This suite of features is branded as "PierrotKnowledge2" and comprises three main components: OKFwiki (for RAG functionality), plugin management, and compression management.

To get started, please download the software from the release notes.

# OKF Wiki

A local knowledge base that a person and an AI agent can both work in, using
the same plain Markdown files as the source of truth.

No database to sync, no proprietary format, no account. A bundle is a folder of
`.md` files you can read in any editor, keep in Git, and open again in ten
years.

日本語のドキュメントは [docs/ja/usage.md](docs/ja/usage.md)。

---

## What it is

Three front ends share one folder and one set of files:

- **A desktop app** — Markdown editor with reading view, wikilinks, backlinks,
  full-text search and a file tree.
- **An MCP server** — 37 tools, so Claude Code, Codex, opencode or any other
  MCP host reads and writes the same wiki you do.
- **A CLI** (`okf`) — generated from the MCP tool table, so anything an agent
  can do over MCP it can also do from a terminal.

All three drive the same `Workspace`. Layer checks, logging and index updates
exist in exactly one place, so the three cannot disagree about what a document
says or who was allowed to write it.

---

## Honest numbers first

Windows 11, 300 notes (1.3 MB), the identical corpus in both applications.
Method and raw data: [docs/BENCHMARK.md](docs/BENCHMARK.md).

| | OKF headless | OKF desktop | Obsidian |
|---|---|---|---|
| Resident memory | **129 MB** | 607 MB | 424 MB |
| Install size | **94 MB** | 117 MB | 373 MB |

**The desktop app uses more memory than Obsidian.** That contradicts the
premise this project started from — that a system WebView would beat a bundled
Chromium — and it stays at the top of the README rather than buried, because
the measurement is the measurement. The saving is real on disk (117 MB vs
373 MB) and real in headless mode, which is what an agent actually runs.

Where the memory goes, measured: WebView2 ≈ 57%, Electrobun ≈ 26%, the Bun
runtime ≈ 7%, this project's own code ≈ 10%. Of the 117 MB on disk, 111.5 MB is
`bun.exe`; everything written for this project is 0.6 MB. There is very little
here left to make smaller.

---

## Install

Requires [Bun](https://bun.sh). On Windows:

```
SETUP.bat
```

Installs dependencies, builds, creates a desktop shortcut and scaffolds a
bundle. `SETUP.bat -Connect` additionally writes this app into your agent
host's configuration.

macOS / Linux:

```bash
bun install && bun run setup:unix
```

Individual builds:

```bash
bun run build          # desktop app
bun run build:cli      # single-file `okf` executable
bun run build:headless # MCP server, no window
```

---

## The three layers

```
bundle/
├── raw/       Layer 1 — source material, as it arrived
├── wiki/      Layer 2 — the canonical, curated knowledge
└── .rag/      Layer 3 — derived search index (rebuildable, never hand-edited)
```

Karpathy's LLM Wiki pattern. **There are exactly three layers.**

Who may write where:

| | `raw/` | `wiki/` | `.rag/` |
|---|---|---|---|
| Human | yes | yes | through the app |
| Agent | **no** | yes | through the app |

`raw/` is the human's inbox: you put originals there, and imports from Notion,
GitHub or Google Drive land there. An agent cannot write to it, so the record
of what actually arrived can never be rewritten by the thing summarising it.
Within `wiki/` both may create, edit and move files; only a human promotes
something out of `raw/`.

### Inside `wiki/`

```
wiki/
├── MAP.md         Where everything is. Read this first.
├── human.md       Who the user is
├── Task.md        Open work, and recently finished work
├── AGENTS.md      The full contract for agents
├── 1-projects/    PARA — active, has an end
├── 2-areas/       PARA — ongoing interest, no deadline
├── 3-resources/   PARA — useful knowledge (default)
├── 4-archive/     PARA — not currently in use
├── skills/        <category>/<name>/SKILL.md
├── loops/         One repeatable-task design per file
├── index.md       OKF §8 reserved
└── log.md         OKF §9 reserved
```

Those first four files, plus `skills/` and `loops/`, are not layers — they are
wiki content. None of them is indexed as knowledge, so a task list or someone's
personal details never turn up in a search for facts.

**PARA sets search rank.** The same hit scores higher in `1-projects/` than in
`4-archive/`, and archived pages are excluded from skill selection entirely.

---

## How an agent orients itself

The problem: an agent that knows nothing has to read widely just to discover
where things are, and pays that cost on every session.

`MAP.md` is a small routing table naming the one file or tool that answers each
kind of question. Measured on a real bundle: **MAP is 522 tokens, while reading
all four orientation files is 2342.** Routing through MAP and then opening the
one file you need costs roughly 30% of reading everything. Its generated half
is rendered from the code that implements the layout, so it cannot drift.

The same idea runs through the rest:

- **SkillSpace** — agents see only each skill's name and description, and open
  a body only once they have chosen it. Measured 58% fewer tokens than loading
  every procedure up front.
- **`list_tasks`** — returns open work by default. Completed tasks are the bulk
  of the file and almost never what was wanted.
- **Loops** — one repeatable task is one file. The last 5 runs keep their full
  journal, the next 20 collapse to a line each, older ones to a count.

---

## Connecting an agent

One panel, one page, three sections.

**Agent hosts** — they speak MCP, so one entry is added to their own config
file, after a backup and after showing you the exact diff: Claude Code, Codex,
opencode, Hermes Agent.

**Local model servers** — Ollama and llama.cpp are *not* MCP clients. They emit
tool calls with nothing to execute them, so this app runs the agent loop
itself, with the token spend shown as it happens.

**External services** — Notion, GitHub, Google Drive, or anything else that
speaks MCP. The tool list and its argument form are built from whatever the
server declares in its JSON Schema, so there is no per-service code. Everything
imported lands in `raw/`.

Credentials are never typed into this app. It shows you where the config file
lives and you edit it there.

---

## The CLI

```bash
okf ask "what is the LLM wiki pattern"   # retrieve, with sources
okf search "design" --limit 5
okf map                                  # the routing table
okf tasks                                # open work
okf todo "finish the docs" --para project
okf lint                                 # OKF conformance
okf serve                                # run as an MCP server
```

Exit codes carry meaning: `0` fine, `1` the tool failed, `2` you called it
wrong — so an agent can tell "fix the arguments" from "the target is bad".
`--json` gives a machine-readable envelope on stdout while errors stay on
stderr.

### RMUX

For work that outlives a single tool call — reindexing a large bundle, a local
model run — an MCP call that blocks for minutes is a call that times out. That
work belongs in a terminal session you can leave and come back to.

```bash
okf rmux setup            # a session with a shell and a live log tail
okf rmux run rebuild-rag  # runs to completion, returns the full output
okf rmux capture          # read a window
```

`run` is built on `collect-pane-output --until-pane-exit`: it returns exactly
when the command does — no polling, no marker injected into your command line —
and it returns the byte stream rather than the visible screen, so a
757-character line arrives intact.

Verified end to end against rmux 0.9.1 built from source. **The Windows
prebuilt of 0.9.1 is broken**: it ships `rmux.exe` without the helper binary it
needs, so `rmux -V` reports a version while every command that starts a server
fails. Use `cargo install rmux --locked`. Details in
[docs/ja/cli.md](docs/ja/cli.md).

---

## The desktop app

- **Reading view first.** Opening a document shows it rendered, not as raw
  markup — frontmatter and link syntax are not the first thing you should see
  on a page you came to read. Toggle in the toolbar.
- **One writing surface.** The editor and the preview are the same pane rather
  than two columns.
- **Format bar** — headings, bold, italic, strikethrough, code, lists, task
  lists, quote, link, table, horizontal rule, alignment.
- **Width slider.** The text column is full width by default; set it where you
  want and it persists.
- **Pasting keeps Markdown.** HTML from another tool is converted rather than
  flattened.
- Wikilinks with autocomplete, backlinks, and an unresolved-link report.
- Full-text search with **CJK bigram indexing**, so Japanese matches properly
  rather than only on whitespace-delimited words.

Shortcuts: `Ctrl+S` save · `Ctrl+P` quick switcher · `Ctrl+Shift+P` command
palette · `Ctrl+K` search · `Ctrl+O` open a bundle.

The interface is Japanese. UTF-8 is pinned explicitly throughout rather than
inferred — earlier builds mojibaked on Windows, and encoding is now handled at
every boundary instead of being left to a default.

---

## Standards

**Open Knowledge Format v0.2.** Every concept is Markdown with YAML
frontmatter carrying a non-empty `type`; `index.md` and `log.md` are reserved
and carry no frontmatter. Conformance is checked on write and on demand
(`okf lint`). A clause-by-clause audit is in
[docs/CONFORMANCE.md](docs/CONFORMANCE.md).

The format *is* the storage. There is no separate database that could drift
from it: `.rag/` is derived and can be deleted and rebuilt at any time.

---

## Built with

Electrobun (system WebView, no bundled Chromium) · Bun · Vite · TypeScript
strict · SQLite FTS5 with BM25 · MCP over NDJSON stdio.

602 tests, all passing. Typecheck clean on both configurations.

---

## Documentation

| Document | What it covers |
|---|---|
| [Usage 日本語](docs/ja/usage.md) · [EN](docs/en/usage.md) | Every screen, every operation, troubleshooting |
| [Workflows 日本語](docs/ja/workflows.md) · [EN](docs/en/workflows.md) | Practical recipes end to end |
| [SkillSpace 日本語](docs/ja/skillspace.md) · [EN](docs/en/skillspace.md) | Skills, loops, connecting agents |
| [okf CLI](docs/ja/cli.md) | Command line, exit codes, RMUX |
| [OKF v0.2 日本語](docs/ja/okf.md) · [EN](docs/en/okf.md) | The format, field by field |
| [LLM Wiki 日本語](docs/ja/llm-wiki.md) · [EN](docs/en/llm-wiki.md) | The pattern, and where this departs from it |
| [Benchmark](docs/BENCHMARK.md) | Method and raw data |
| [Conformance](docs/CONFORMANCE.md) | OKF audit, clause by clause |
| [Architecture](docs/ARCHITECTURE.md) | How the code fits together |


