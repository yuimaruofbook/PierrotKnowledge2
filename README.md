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

## Three ways to run it

They are separate processes that share a folder, not a client and a server.
Nothing coordinates them except the files on disk — which is the whole design:
there is one write path, so a human edit and an agent edit cannot disagree.

| | What it is | Resident memory | Use it when |
|---|---|---|---|
| **`PierrotKnowledge2 ui`** | The full interface, served to a browser you already have open | **135 MB** | Normal use |
| **Headless** | MCP server, no interface at all | **85 MB** | An agent host (Claude Code, Codex…) starts it for you |
| **CLI** | One command, one answer, exits | — (0.28 s per run) | Scripting, or working next to the page |

There was a fourth: a packaged desktop window, removed at 0.5.0. See
[Honest numbers](#honest-numbers) for why.

Measured on this machine, Windows 11. Method and raw data:
[docs/BENCHMARK.md](docs/BENCHMARK.md).

### What each one exposes

The two halves of the application are deliberately separate surfaces:

- **44 RPC methods** — what the interface calls. `ui` mode exposes this and
  nothing else.
- **39 MCP tools** — what an agent calls. Headless exposes this and nothing
  else, over stdio.
- **The CLI** reaches every one of the 39 tools plus `info`, `watch`, `ui`,
  `serve`, `update` and `rmux`.

**The interface does not serve MCP.** An agent working alongside you is a
second process — the headless server, started by the agent's own host — and the
two meet in the files. That is why an agent's edit shows up in your page a
moment later rather than through any connection between them.

---

## Honest numbers

| | `ui` mode | Desktop (removed at 0.5.0) | Obsidian |
|---|---|---|---|
| Resident memory | **135 MB** | 633 MB | 424 MB |
| ├ the app itself | 95 MB | 241 MB | — |
| └ the page's renderer | 49 MB (browser tab) | 360 MB (6 renderer processes) | — |
| On disk after setup | **147 MB** | — | 373 MB |

Of the 147 MB, 145 MB is `node_modules` and **1.4 MB is this project**. The
three runtime dependencies are `marked`, `turndown` and `yaml`. The desktop
column is left blank rather than estimated: that build no longer exists to
measure, and the figure in earlier revisions of this table was the headless
executable's size mislabelled.

Headless is a separate shape again: `bun run build:headless` produces one
self-contained **94 MB** executable — no `node_modules`, no Bun on `PATH` —
and that is all an agent host needs.

**The desktop build was not light and never became light.** At 633 MB it was
heavier than Obsidian. The premise this project began with — that the system
WebView would beat a bundled Chromium — did not hold: Windows starts six of
those renderer processes for one window, measured at 360 MB, and the packaging
layer added a second copy of the Bun runtime. Neither was something this
codebase could fix.

So it is gone. By the end it was the same Vite bundle, the same RPC surface
and the same `Workspace` as `ui` mode, and its *only* exclusive capability was
the native folder dialog — which the OS opens for any process that asks, and
now does (`src/bun/platform.ts`). What that left was 5× the memory and a
patched pin of a young desktop framework, for a dialog.

One thing was genuinely lost, and it is worth naming rather than burying: a
page in your browser is reachable by your browser extensions, and a window was
not. `ui` binds to loopback and mints a per-run token, but an extension with
host access to `127.0.0.1` can read the page. If that matters for your threat
model, open it in a browser profile with no extensions.

Everything written for this project is 0.8 MB under `src/` — 1.4 MB with the
tests, docs and scripts — with a live heap around 10 MB. There is nothing left
to trim on our side.

---

## Install

Requires [Bun](https://bun.sh). On Windows:

```
SETUP.bat
```

Installs dependencies, builds the interface, creates a desktop shortcut and
scaffolds a bundle. `SETUP.bat -Connect` also writes this app into your agent
host's configuration.

macOS / Linux:

```bash
bun install && bun run setup:unix
```

Then, **from the folder you installed into**:

```powershell
.\PierrotKnowledge2 ui        the interface, in your browser
.\PierrotKnowledge2 Update    check for a new release
```

```bash
./PierrotKnowledge2 ui        # macOS / Linux
```

> **The `.\` is not optional.** Setup does not put this folder on your `PATH`,
> and PowerShell never runs a program from the current directory without being
> told to — a bare `PierrotKnowledge2 Update` answers
> `CommandNotFoundException`. Add the folder to `PATH` yourself if you would
> rather type it without the prefix.

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
- **開く shows the OS's own folder dialog**, even though the page is in a
  browser: the page asks the server and the server asks the OS. Where there is
  no desktop session to ask — a container, an SSH shell — it falls back to
  asking for the path as text.

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
- **Agent hosts** (9) — Claude Code, Codex, opencode, Hermes Agent, Cursor and
  Antigravity, most offered in both a **bundle-scoped** and a **user-scoped**
  form. One entry is added to their own config, after a backup and after
  showing you the diff. Claude Code's user scope is the exception: it lives in
  `~/.claude.json` alongside project state and server toggles, so the app shows
  you the `claude mcp add` command rather than rewriting a file that big to add
  one line.
  **すべてのエージェントに登録** does the whole sweep in one press: every host
  found on the machine, sequentially, with a per-host report of what was
  written, what was already there, and what needs a command you run yourself.
  Hosts whose CLI is not on `PATH` are skipped rather than littered with a
  config for a tool that is not there — a checkbox includes them, for a real
  install the probe cannot see (Cursor on Windows, usually).
- **Orchestrators** — [Orca](https://github.com/stablyai/orca) has no MCP
  config of its own; it runs Codex, Claude Code, opencode or Pi each in its own
  git worktree. Connect the underlying agent, and use a **user-scoped** entry:
  a worktree is never the bundle directory, so project-scoped config is never
  found there. For Claude Code that scope lives in `~/.claude.json`, which also
  holds project state — so this app shows you the `claude mcp add` command
  rather than editing that file.
- **Local model servers** (4) — Ollama, llama.cpp, LM Studio and vLLM are
  *not* MCP clients; they emit tool calls with nothing to execute them, so this
  app runs the agent loop itself with the token spend shown as it happens.
  Ports and required flags come from each vendor own docs — vLLM in particular
  ignores every tool unless started with both `--enable-auto-tool-choice` and
  `--tool-call-parser`.

Credentials are never typed into this app.

### Updating

```powershell
.\PierrotKnowledge2 Update           check, verify, show the release notes
.\PierrotKnowledge2 Update --apply   install
```

When a newer release exists and you are online, the interface shows a pulsing
indicator; opening it renders the release notes.

### Uninstalling

```powershell
.\PierrotKnowledge2 Uninstall           show the plan
.\PierrotKnowledge2 Uninstall --apply   carry it out
```

The plan lists what **survives** before it lists what goes, because that is the
only question anyone uninstalling has. Bundles are never touched, and a bundle
found inside the install directory aborts the whole thing. What it does do is
the tedious part: take our entry back out of every agent host config, so none
of them reports a broken MCP server for a program that no longer exists. Those
files are backed up before being edited. The install folder itself is left for
you to delete once the app has stopped — a running process cannot remove its
own executable.

---

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

Bun · Vite · TypeScript strict (`exactOptionalPropertyTypes` included) ·
SQLite FTS5 with BM25 · MCP over NDJSON stdio. No UI framework, no bundled
browser engine — the interface is served to the one you already run.

**Developed and measured on Windows.** macOS and Linux are handled in the code
and adjusted for — see [docs/ja/platforms.md](docs/ja/platforms.md) for what is
and is not known. The one place the OS is touched directly is the folder dialog
(`powershell` / `osascript` / `zenity` or `kdialog`), and it degrades to typing
a path when there is no desktop session.

726 tests, all passing. Typecheck clean on both configurations.

---

## License

MIT. See [LICENSE](LICENSE).

---

## Documentation

| Document | What it covers |
|---|---|
| [Usage 日本語](docs/ja/usage.md) · [EN](docs/en/usage.md) | Every screen, every operation, troubleshooting |
| [Upgrading 日本語](docs/ja/upgrade.md) | Manual migration from pre-0.3.0, then `PierrotKnowledge2 Update` |
| [Platforms 日本語](docs/ja/platforms.md) | macOS / Linux notes, and what is **not** verified |
| [Workflows 日本語](docs/ja/workflows.md) · [EN](docs/en/workflows.md) | Practical recipes end to end |
| [SkillSpace 日本語](docs/ja/skillspace.md) · [EN](docs/en/skillspace.md) | Skills, loops, connecting agents |
| [okf CLI](docs/ja/cli.md) | Command line, exit codes, RMUX |
| [OKF v0.2 日本語](docs/ja/okf.md) · [EN](docs/en/okf.md) | The format, field by field |
| [LLM Wiki 日本語](docs/ja/llm-wiki.md) · [EN](docs/en/llm-wiki.md) | The pattern, and where this departs from it |
| [Benchmark](docs/BENCHMARK.md) | Method and raw data |
| [Conformance](docs/CONFORMANCE.md) | OKF audit, clause by clause |
| [Architecture](docs/ARCHITECTURE.md) | How the code fits together |
