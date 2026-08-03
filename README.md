# PierrotKnowledge2
An ultra-lightweight local knowledge base compliant with OKF v0.2 and LLMwiki.
Designed around the philosophy of being "as light as air," this version sheds restrictive constraints to prioritize seamless utility—enabling effortless data capture from anywhere.

"Let them laugh. The Pierrot sees what the crowd ignores."

To get started, please download the software from the release notes.

# PierrotKnowledge2

A local knowledge base that a person and an AI agent can both work in, using
the same plain Markdown files as the source of truth.

No database to sync, no proprietary format, no account. A bundle is a folder of
`.md` files you can read in any editor, keep in Git, and open again in ten
years.

日本語のドキュメントは [docs/ja/usage.md](docs/ja/usage.md)。

---

## Four ways to run it

They are separate processes that share a folder, not a client and a server.
Nothing coordinates them except the files on disk — which is the whole design:
there is one write path, so a human edit and an agent edit cannot disagree.

| | What it is | Resident memory | Use it when |
|---|---|---|---|
| **`PierrotKnowledge2 ui`** | The full interface, served to a browser you already have open | **135 MB** | Normal use. The recommended way. |
| **Desktop app** | The same interface in its own window | 633 MB | You want a standalone application and will pay 5× the memory |
| **Headless** | MCP server, no interface at all | **85 MB** | An agent host (Claude Code, Codex…) starts it for you |
| **CLI** | One command, one answer, exits | — (0.28 s per run) | Scripting, or working next to the window |

Measured on this machine, Windows 11. Method and raw data:
[docs/BENCHMARK.md](docs/BENCHMARK.md).

### What each one exposes

The two halves of the application are deliberately separate surfaces:

- **43 RPC methods** — what the interface calls. Desktop and `ui` mode expose
  this and nothing else.
- **39 MCP tools** — what an agent calls. Headless exposes this and nothing
  else, over stdio.
- **The CLI** reaches every one of the 39 tools plus `info`, `watch`, `ui`,
  `serve`, `update` and `rmux`.

**The desktop app does not serve MCP.** An agent working alongside you is a
second process — the headless server, started by the agent's own host — and the
two meet in the files. That is why an agent's edit shows up in your window a
moment later rather than through any connection between them.

---

## Honest numbers

| | `ui` mode | Desktop | Obsidian |
|---|---|---|---|
| Resident memory | **135 MB** | 633 MB | 424 MB |
| ├ the app itself | 95 MB | 241 MB | — |
| └ the page's renderer | 49 MB (browser tab) | 360 MB (WebView2 ×6) | — |
| Install size | 94 MB | 118 MB | 373 MB |

**The desktop build is not light and never became light.** At 633 MB it is
heavier than Obsidian. The premise this project began with — that a system
WebView would beat a bundled Chromium — did not hold: Windows starts six
WebView2 processes for one window, measured at 360 MB, and Electrobun adds a
second copy of the Bun runtime. Neither is something this codebase can fix,
which is why the answer was to stop shipping a window rather than to optimise
one.

Of the 118 MB on disk, 111.5 MB is `bun.exe`. Everything written for this
project is 0.6 MB of source with a live heap around 10 MB. There is nothing
left to trim on our side.

---

## Install

Requires [Bun](https://bun.sh). On Windows:

```
SETUP.bat
```

Installs dependencies, builds, creates a desktop shortcut and scaffolds a
bundle. `SETUP.bat -Connect` also writes this app into your agent host's
configuration.

macOS / Linux:

```bash
bun install && bun run setup:unix
```

Then:

```
PierrotKnowledge2 ui        the interface, in your browser
PierrotKnowledge2 Update    check for a new release
```

`ui` binds to `127.0.0.1`, mints a token for the run and opens the URL. Nothing
reaches the network, and no other page in the browser can drive it.

> The command is named after the application rather than `okf` — a short,
> generic word likely to collide with something else on the same PATH. `okf`
> still works.

---

## The three layers

```
bundle/
├── MAP.md     Where everything is. Read this first.
├── human.md   Who the user is
├── Task.md    Open work, and recently finished work
├── raw/       Layer 1 — source material, as it arrived
├── wiki/      Layer 2 — the canonical, curated knowledge
└── .rag/      Layer 3 — derived search index (rebuildable, never hand-edited)
```

The three files at the top are **not** layers and sit deliberately outside
them. The layers are three stages of one material — sources, curated
knowledge, derived index — and these are not that material.

Who may write where:

| | `raw/` | `wiki/` | `.rag/` |
|---|---|---|---|
| Human | yes | yes | through the app |
| Agent | **no** | yes | through the app |

`raw/` is the human's inbox: originals go there, and imports from Notion,
GitHub, Google Drive or Obsidian land there. An agent cannot write to it, so
the record of what actually arrived can never be rewritten by the thing
summarising it.

### Inside `wiki/`

```
wiki/
├── AGENTS.md      The full contract for agents
├── daily/         One dated note per day
├── 1-projects/    PARA — active, has an end
├── 2-areas/       PARA — ongoing interest, no deadline
├── 3-resources/   PARA — useful knowledge (default)
├── 4-archive/     PARA — not currently in use
├── skills/        <category>/<name>/SKILL.md
├── loops/         One repeatable-task design per file
├── index.md       OKF §8 reserved
└── log.md         OKF §9 reserved
```

**PARA sets search rank.** The same hit scores higher in `1-projects/` than in
`4-archive/`, and archived pages are excluded from skill selection entirely.

---

## Features

### Writing

- **Reading view first.** Opening a document shows it rendered — frontmatter
  and link syntax are not what you should see on a page you came to read.
- One writing surface: the editor and the preview are the same pane.
- Format bar — headings, bold, italic, strikethrough, code, three kinds of
  list, quote, link, table, rule, alignment. Everything toggles.
- Width slider, full width by default, persisted.
- **Pasting keeps Markdown.** HTML from another tool is converted, not
  flattened.
- Wikilinks with completion, backlinks, unresolved-link report. Renaming a page
  rewrites every link to it.
- Full-text search with **CJK bigram indexing**, so Japanese matches without
  word boundaries.

### Daily notes

`wiki/daily/YYYY-MM-DD.md`, one action to open or create. Indexed like any
other page, so "what did I decide last Tuesday" is answerable.

Unchecked items under `## タスク` are moved into `Task.md` by
`collect_daily_tasks`, then ticked and stamped with the id they became — so
the transfer is idempotent and a requirement written in a day's notes does not
vanish tomorrow.

### For agents

- **`MAP.md`** is a routing table naming the one file that answers each kind of
  question. Measured: MAP is 522 tokens against 2342 for reading all four
  orientation files.
- **SkillSpace** — agents see only each skill's name and description and open a
  body once chosen. Measured 58% fewer tokens than loading every procedure.
- **`list_tasks`** returns open work by default.
- **Loops** — one repeatable task is one file; the last 5 runs keep their full
  journal, the next 20 collapse to a line, older ones to a count.
- **RMUX** — work that outlives a single tool call goes in a terminal session.
  `PierrotKnowledge2 rmux run` returns exactly when the command does, with the
  byte stream rather than the visible screen.

### Connections

One panel, one page, three sections.

- **External services (MCP)** — Notion, GitHub, Google Drive, **Obsidian**, or
  anything else that speaks the protocol. The tool list and its form are built
  from whatever the server declares, so there is no per-service code. Imports
  land in `raw/`.
- **Agent hosts** — Claude Code, Codex, opencode, Hermes Agent. One entry is
  added to their own config, after a backup and after showing you the diff.
- **Local model servers** — Ollama and llama.cpp are *not* MCP clients; they
  emit tool calls with nothing to execute them, so this app runs the agent loop
  itself with the token spend shown as it happens.

Credentials are never typed into this app.

### Updating

```
PierrotKnowledge2 Update           check, verify, show the release notes
PierrotKnowledge2 Update --apply   install
```

When a newer release exists and you are online, the interface shows a pulsing
indicator; opening it renders the release notes.

Downloads are verified against the SHA-256 GitHub computes server-side.
Versions come from a manifest inside the archive rather than the tag, and
**an update that would go backwards is refused**. Replaced files are moved to a
timestamped backup, never deleted, and `--rollback` puts them back.

**An update never touches a bundle**: it writes only to an allowlist of paths
inside the install directory, and refuses outright if a bundle is found inside
it. Upgrading from before 0.3.0 →
[docs/ja/upgrade.md](docs/ja/upgrade.md).

---

## Standards

**Open Knowledge Format v0.2.** Every concept is Markdown with YAML
frontmatter carrying a non-empty `type`; `index.md` and `log.md` are reserved
and carry no frontmatter. Conformance is checked on write and on demand.
Clause-by-clause audit: [docs/CONFORMANCE.md](docs/CONFORMANCE.md).

The format *is* the storage. There is no separate database that could drift
from it — `.rag/` is derived and can be deleted and rebuilt at any time.

---

## Built with

Electrobun (system WebView, no bundled Chromium) · Bun · Vite · TypeScript
strict · SQLite FTS5 with BM25 · MCP over NDJSON stdio.

651 tests, all passing. Typecheck clean on both configurations.

---

## Documentation

| Document | What it covers |
|---|---|
| [Usage 日本語](docs/ja/usage.md) · [EN](docs/en/usage.md) | Every screen, every operation, troubleshooting |
| [Upgrading 日本語](docs/ja/upgrade.md) | Manual migration from pre-0.3.0, then `PierrotKnowledge2 Update` |
| [Workflows 日本語](docs/ja/workflows.md) · [EN](docs/en/workflows.md) | Practical recipes end to end |
| [SkillSpace 日本語](docs/ja/skillspace.md) · [EN](docs/en/skillspace.md) | Skills, loops, connecting agents |
| [okf CLI](docs/ja/cli.md) | Command line, exit codes, RMUX |
| [OKF v0.2 日本語](docs/ja/okf.md) · [EN](docs/en/okf.md) | The format, field by field |
| [LLM Wiki 日本語](docs/ja/llm-wiki.md) · [EN](docs/en/llm-wiki.md) | The pattern, and where this departs from it |
| [Benchmark](docs/BENCHMARK.md) | Method and raw data |
| [Conformance](docs/CONFORMANCE.md) | OKF audit, clause by clause |
| [Architecture](docs/ARCHITECTURE.md) | How the code fits together |

