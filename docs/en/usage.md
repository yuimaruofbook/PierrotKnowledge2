# Usage

[← Documentation](../README.md) · [日本語](../ja/usage.md)

From install to daily use. **This page is enough to work with the app.**

> The interface itself is in Japanese. Menu labels are given here in Japanese
> with an English gloss, so you can follow along on screen.

---

## Contents

1. [Install](#1-install)
2. [Three ways to operate it](#2-three-ways-to-operate-it)
3. [How a bundle is laid out](#3-how-a-bundle-is-laid-out)
4. [The window](#4-the-window)
5. [Reading and writing](#5-reading-and-writing)
6. [Links and backlinks](#6-links-and-backlinks)
7. [PARA and priority](#7-para-and-priority)
8. [Search](#8-search)
9. [File operations](#9-file-operations)
10. [Shortcuts](#10-shortcuts)
11. [The connections panel](#11-the-connections-panel)
12. [Daily notes](#12-daily-notes)
13. [SkillSpace](#13-skillspace)
14. [MAP, human, Task](#14-map-human-task)
15. [Command line](#15-command-line)
16. [Keeping it healthy](#16-keeping-it-healthy)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. Install

Requires [Bun](https://bun.sh).

### Windows

```
SETUP.bat
```

Installs dependencies, builds, creates a desktop shortcut and scaffolds a
bundle. `SETUP.bat -Connect` also writes this app into your agent host's
configuration.

### macOS / Linux

```bash
bun install && bun run setup:unix
```

### Building pieces individually

```bash
bun run build:view      # the page the interface serves
bun run build:headless  # the MCP server an agent spawns (single executable)
bun run build:cli       # single-file `okf` executable
```

> **After changing source, rebuild whichever mode you use.** `build:view` for
> the interface, `build:headless` for agents. Neither reaches the other.

---

## 2. Three ways to operate it

**You use the interface, agents use headless, automation uses the CLI.**

| Mode | Who runs it | What it speaks | Resident |
|---|---|---|---|
| **Interface** | you | RPC to a browser | **135 MB** |
| **Headless** | an agent | MCP over stdio | **85 MB** |
| **CLI** | either | one command, one answer | — |

They are separate processes with nothing coordinating them. **They meet in the
files** — one write path, so a human edit and an agent edit cannot disagree.

### In your browser (what you use)

```bash
okf ui
```

Starts on `127.0.0.1`, prints a URL carrying a token for this run, and opens
it. **135 MB resident** (86 MB server + 49 MB browser tab) against the desktop
build's 633 MB — about a fifth, for exactly the same interface.

- Never exposed to the network (loopback only)
- No other page in the browser can drive it (per-run token)
- `Ctrl+C` to stop

> **開く** (Open, `Ctrl+O`) shows your operating system's own folder dialog —
> the page asks the server, and the server asks the OS. On a host with no
> desktop session to ask (a container, an SSH shell) it falls back to asking
> you to type the path.

### Headless (what agents use)

**Agents run headless, always.** Claude Code, Codex, opencode and Hermes each
spawn this binary themselves and talk to it over stdio:

```bash
bun run build:headless   # builds build/headless/okf-mcp.exe
```

- **One process with no page attached** — that is the 85 MB against 135 MB.
- **Self-contained**: no Bun install, nothing on `PATH`. It runs from whatever
  environment the agent host happens to start it in.
- Register it from the connections panel — **すべてのエージェントに登録** —
  which writes this binary's path into each host's own config.

> **Never point an agent at `ui` mode.** That interface speaks RPC to a
> browser, not MCP; there is not a single tool there for an agent to call.
> Headless, in turn, serves no page. **The two meet in the files.**

> **Without the binary it falls back.** Registering before building writes
> `bun run …/standalone.ts` instead. That works only where the agent host's own
> environment has Bun on `PATH`, which a GUI-launched host often does not.
> `SETUP.bat -Connect` builds it for you.

> **The build fails while an agent is connected.** Windows will not replace a
> running executable. It says so and stops; end that agent's session and run it
> again. The binary already installed keeps working in the meantime.

### The CLI

```bash
./PierrotKnowledge2 retrieve "what you are looking for"
./PierrotKnowledge2 info
```

One command, one answer, exit. For scripting, or for working beside the open
page. See [okf CLI](../ja/cli.md).

That is the whole loop. Read the rest as you need it.

---

## 3. How a bundle is laid out

```
bundle/
├── MAP.md     outside the layers — where everything is
├── human.md   outside the layers — about you
├── Task.md    outside the layers — open and recent work
├── raw/       Layer 1 — originals, as they arrived
├── wiki/      Layer 2 — the canonical knowledge
└── .rag/      Layer 3 — search index (generated, never hand-edited)
```

**There are exactly three layers.** The three files above sit beside them, not
in them: the layers are three stages of the same material, and these are not
that material — they describe where things live, who you are, and what is in
flight.

| | `raw/` | `wiki/` | `.rag/` |
|---|---|---|---|
| You | yes | yes | through the app |
| An agent | **no** | yes | through the app |

`raw/` is your inbox, and imports from Notion or Google Drive land there.
**Agents cannot write to it** — the record of what actually arrived must not be
rewritable by the thing summarising it.

Inside `wiki/` both you and an agent may create, edit and move files. Promoting
something out of `raw/` is yours to do.

### Inside `wiki/`

```
wiki/
├── AGENTS.md      The full contract for agents
├── 1-projects/    PARA — active, has an end
├── 2-areas/       PARA — ongoing interest, no deadline
├── 3-resources/   PARA — useful knowledge (default)
├── 4-archive/     PARA — not in use
├── skills/        <category>/<name>/SKILL.md
├── loops/         One repeatable-task design per file
├── index.md       OKF §8 reserved
└── log.md         OKF §9 reserved
```

`AGENTS.md`, `skills/` and `loops/` are wiki content rather than layers —
all three are content *about* the wiki. None is indexed as knowledge, so a
procedure never appears in a search for facts.

---

## 4. The window

```
┌──────────────────────────────────────────────┐
│ PierrotKnowledge2  [Open][New][Save][Rebuild][接続][Skill] │ toolbar
├──────────────────────────────────────────────┤
│ [View|Edit]  H1 H2 H3 B I S <> " ~ ≡  [width ─●] │ format bar
├────────────┬─────────────────────────────────┤
│ file tree  │        document                  │
│            │        (view / edit)             │
│ tags       │        backlinks                 │
├────────────┴─────────────────────────────────┤
│ status                                        │
└──────────────────────────────────────────────┘
```

**The centre is one surface.** The editor and the preview are the same pane,
switched between, not two columns.

---

## 5. Reading and writing

### Documents open in reading view

Opening a `.md` file shows it **rendered**. Frontmatter and link syntax are not
what you should see first on a page you came to read.

Toggle with **[表示 | 編集]** (View | Edit) at the left of the format bar.
Binary files and non-Markdown text open in the editor instead, because there is
nothing to render.

### Format bar

Headings (H1–H3) and paragraph, bold, italic, strikethrough, inline code,
bulleted / numbered / task lists, blockquote, link, alignment (left, centre,
right), horizontal rule, table.

**Everything toggles.** Pressing H2 on an existing H2 turns it back into a
paragraph.

### Width slider

Sets the width of the text column. Full width by default; it follows the slider
live and saves when you let go.

### Saving

`Ctrl+S`, plus autosave — normally you do not have to think about it.

### Pasting

Content copied from other tools **keeps its formatting**. HTML is converted to
Markdown before insertion, so headings and lists do not collapse into plain
text.

---

## 6. Links and backlinks

```markdown
[[Concept name]]                wikilink
[[Concept name|shown text]]     different display text
[normal link](path.md)          standard Markdown
```

Typing `[[` offers completions.

Links to pages that do not exist are styled differently; clicking one **creates
the page**. The full list is in the command palette (`Ctrl+Shift+P` → 未解決
リンク) or `okf gaps`.

Pages that link to the open document are listed beneath it automatically.

---

## 7. PARA and priority

`wiki/` is divided four ways:

| Folder | Meaning |
|---|---|
| `1-projects/` | Active, has an end |
| `2-areas/` | Ongoing interest, no deadline |
| `3-resources/` | Useful knowledge (default) |
| `4-archive/` | Not currently in use |

**The order affects search rank.** The same content ranks higher in
`1-projects/` than in `4-archive/`, and archived pages are excluded from skill
selection entirely.

Move by dragging in the tree, or:

```bash
okf archive wiki/1-projects/finished.md archive
```

---

## 8. Search

Full-text search from the toolbar (`Ctrl+K`), ranked with BM25 and highlighted.

**Japanese is indexed with bigrams**, so it matches without word boundaries —
searching 設計原則 finds it inside a longer run of text.

`Ctrl+P` is the quick switcher (fuzzy match on filename). Tags from frontmatter
are listed bottom-left; click to filter.

---

## 9. File operations

Right-click in the tree: new, rename, move, delete.

**Renaming rewrites every link that pointed at the page.** So does moving. You
never fix links by hand.

---

## 10. Shortcuts

| Key | Action |
|---|---|
| `Ctrl+S` | Save |
| `Ctrl+P` | Quick switcher |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+K` / `Ctrl+F` | Search |
| `Ctrl+O` | Open a bundle |

While editing, `Enter` inside a list or blockquote **continues it**. `Enter` on
an empty item ends the list.

---

## 11. The connections panel

The **接続** (Connect) button. **Three sections on one scrolling page.**

### External services (MCP)

Notion, GitHub, Google Drive, **Obsidian**, or anything else that speaks MCP.
Click a row and its detail opens in place: connect, pick a tool, fill in
arguments, import.

1. Add a definition with **＋ Notion** and friends
2. **設定ファイルの場所** shows the config file path — put your token in that
   file
3. **接続** (Connect)

> **You never type a token into this app.** It shows you where the file is; the
> value never passes through the application.

Imported content goes to **`raw/` only**. It never lands in `wiki/`
automatically.

#### Migrating from Obsidian

Add it with **＋ Obsidian**, then replace `<VAULT_PATH>` in the config file with
the **absolute path** to your vault:

```json
"args": ["-y", "mcp-obsidian", "C:/Users/you/Documents/MyVault"]
```

Connecting without editing it fails with a missing directory, so the panel
warns about the placeholder before you try.

> **Your vault is not modified.** This uses `mcp-obsidian`, which only reads
> and searches. A second implementation, `obsidian-mcp`, can also write — its
> README opens by asking you to back the vault up first. Moving notes *out*
> needs no writes, so the server that cannot touch the vault is the default.

After connecting it behaves like any other service: pick a tool, import, and
the result lands in **`raw/`**. Obsidian notes are already Markdown, so
promoting them into `wiki/` is a move rather than a conversion — `[[wikilinks]]`
work in both.

### Agent connections

| Tool | Config file |
|---|---|
| Claude Code | `<bundle>/.mcp.json` (project scope) |
| Codex | `~/.codex/config.toml` |
| opencode | `~/.config/opencode/opencode.json` |
| Hermes Agent | `~/.hermes/config.yaml` |

**変更内容を見る** (Preview) shows the exact text to be written. **ワンタッチ
接続** (Connect) applies it, after copying the original to
`<file>.okf-backup-<time>`. **Existing settings are never removed** — one entry
is added or replaced.

### Local execution

Ollama and llama.cpp are **not MCP clients**. They can emit tool calls but
nothing executes them, so **this app runs the agent loop itself**. Pick a
server, a model and a task; each step and its token spend streams as it
happens.

---

## 12. Daily notes

Somewhere to write today — a meeting, a decision, something to do later —
without first deciding where any of it belongs.

### Opening today

| Route | How |
|-------|-----|
| UI | `Ctrl+Shift+P` → 今日のノート |
| CLI | `okf today` |

**Opens it if it exists, creates it if not.** One action either way; you never
have to check whether today already exists.

The file is `wiki/daily/2026-08-03.md`. The date is your local date, not UTC.

### The template

```markdown
## タスク

- [ ]

## メモ

## 今日わかったこと
```

Headings rather than a blank page: an empty note takes whatever shape the day
happens to have, and next week none of them line up.

### They are ordinary pages

Unlike `skills/` and `loops/`, daily notes **are indexed and searchable**.
"What did I decide last Tuesday" is a real question and it can only be answered
if the days are in the index. Links and backlinks work normally.

### Tasks move to Task.md (the agent rule)

Write an **unchecked** item under `## タスク` and an agent moves it into
`Task.md` with `collect_daily_tasks`.

```markdown
## タスク

- [ ] Ingest the meeting notes     ← will be moved
- [x] Collect the sources → T-0011 ← done, never moved again
```

The line is then ticked and stamped with the id it became.

**Why move it:** a requirement written into a day's notes is invisible
tomorrow. `Task.md` is the list that actually gets read. Written in one place,
read in another — without the transfer the requirement is simply lost.

**What it will not touch:**

- Only items under `## タスク`. A packing list in the notes section stays put
- **Never added twice** — ticked lines are skipped, so calling it repeatedly
  changes nothing
- Each task records where it came from: "from the YYYY-MM-DD note"

`okf collect-daily-tasks` does the same thing by hand.

---

## 13. SkillSpace

The **Skill** button. Procedures live here.

Agents read only the name and description of each skill, and open a body only
after choosing it — measured at **58% fewer tokens** than loading every
procedure up front.

Type a request into the box to see **which skill would be chosen and what
opening it would cost**. Trying it spends nothing.

Layout is `skills/<category>/<name>/SKILL.md`. See
[SkillSpace](./skillspace.md).

---

## 14. MAP, human, Task

Three orientation files at the bundle root, **outside** the three layers.

| File | Contents | CLI |
|---|---|---|
| `MAP.md` | Routing table: where everything is | `okf map` |
| `human.md` | About you | `okf who` |
| `Task.md` | Open and recently completed work | `okf tasks` |

**`MAP.md` is read first.** Measured: MAP is 522 tokens, while all four
orientation files together are 2342. Reading MAP and then the one file you need
costs about 30% of reading everything.

The top half of `MAP.md` is generated from the code that implements the layout,
so it cannot drift. Anything you write below the divider survives regeneration.

`human.md` ships as a template — **fill it in yourself.** It is read every
session, so keep it short.

`Task.md` can be edited by hand. **Status comes from the heading**
(`## 進行中` in progress / `## 未着手` not started / `## 完了` done), not from
the checkbox. Completed tasks are kept for the most recent 25; older ones
survive as a count.

---

## 15. Command line

```bash
okf ask "what is the LLM wiki pattern"
okf search "design" --limit 5
okf map / okf who / okf tasks
okf todo "write the summary" --para project
okf lint          # OKF conformance
okf gaps          # unresolved links
okf serve         # run as an MCP server
```

The target bundle is `--bundle`, then `OKF_BUNDLE`, then whatever the app had
open last — so the CLI works alongside the window without repeating a path.

Long work can be handed to an RMUX session (`okf rmux setup` → `run` →
`capture`). See [okf CLI](../ja/cli.md) (Japanese).

---

## 16. Keeping it healthy

| Task | How |
|---|---|
| OKF conformance | `Ctrl+Shift+P` → 準拠チェック, or `okf lint` |
| Unresolved links | `Ctrl+Shift+P` → 未解決リンク, or `okf gaps` |
| Rebuild the index | **再構築** (Rebuild) in the toolbar |

`.rag/` is derived. If it breaks, delete it and rebuild.

---

## 17. Troubleshooting

| Symptom | Fix |
|---|---|
| **Changed the source but the UI is the same** | Run `bun run build:view`, then reload the page. `ui` serves what is in `src/mainview/dist` |
| **Changed the source but an agent sees the old behaviour** | Run `bun run build:headless` and restart the agent's session — it spawned the old binary |
| The `ui` server will not start | Another run may hold the port. `Ctrl+C` the old console, or pass `--port` |
| Mojibake | Save the file again; reads and writes are pinned to UTF-8 |
| Search results are stale | **再構築** (Rebuild) |
| Japanese does not match | Same — the bigram index needs rebuilding |
| An agent cannot write to `raw/` | **By design.** Promote into `wiki/` yourself |
| Red error box when connecting | Usually a missing token. The text is the server's own output |
| `rmux` does not work | The prebuilt is broken; `cargo install rmux --locked` |
| Setup fails partway | Since v0.4.1 the failing step, its exit code and a command to reproduce it are all printed. Send that text |
| `Could not find a part of the path '...\.okf-write-test'` | Documents exists as far as `Test-Path` is concerned but cannot actually be used. See below |

### What the Desktop icon opens

Double-clicking the icon starts a server on 127.0.0.1 and opens the interface
in your usual browser. A small console window stays behind, minimised — it *is*
the server, so closing it is how you quit.

There is no separate window build any more; it was removed at 0.5.0. It ran the
same interface at 633 MB resident against 135 MB in a tab, and its one
exclusive capability — the folder dialog — is now opened straight from the OS.

The icon carries the bundle path chosen at setup time. To point it somewhere
else, run setup again with `-BundlePath "C:\another\place"`.

### When Documents cannot be used

Setup creates the starter bundle in Documents. That folder is the one location
Windows lets anything redirect, and a redirection left half-finished lies to
every cheap check: `Test-Path` reports the folder as present, and
`New-Item -Force` reports success while creating nothing. The first honest
error arrives at the first write, naming `.okf-write-test` — a file you never
asked for, in a folder you were just told exists.

Four unrelated conditions produce that one message. None of them requires a
cloud sync tool to be installed:

| State | How it usually happens |
|---|---|
| Documents is a link and its target is gone | The folder was moved to a second drive and that location was later renamed or deleted; an external drive was unplugged; a cloud tool's folder redirection (OneDrive, Dropbox, Google Drive) was turned off |
| Documents is a link and its target is now a file | As above, plus a file created where the target folder used to be |
| Documents is a file rather than a folder | A same-named file, or a bad extraction |
| `Documents\PierrotKnowledge2` is already a file | A same-named file occupies the spot |

Since v0.4.2 setup identifies which of the four it is, prints advice for that
cause, and **falls back to your user profile folder so the install completes
anyway**. To inspect the state yourself:

```powershell
$p=[Environment]::GetFolderPath('MyDocuments'); $c=Join-Path $p 'PierrotKnowledge2'
foreach($x in @($p,$c)){
  $i=Get-Item -LiteralPath $x -Force -EA SilentlyContinue
  if(-not $i){ "$x : MISSING"; continue }
  $o='OK'; try{ Get-ChildItem -LiteralPath $x -Force -EA Stop | Select-Object -First 1 | Out-Null }
  catch{ $o="FAIL($($_.Exception.GetType().Name))" }
  "$x`n  attrs=$($i.Attributes) link=$($i.LinkType) target=$($i.Target) open=$o"
}
```

`ReparsePoint` in `attrs` means it is a link; no `Directory` means it is a
file. The line reporting `open=FAIL` is where the problem is.

---

## See also

- [Workflows](./workflows.md) — practical recipes
- [SkillSpace](./skillspace.md) — skills, loops, connecting agents
- [OKF v0.2](./okf.md) — the file format
- [LLM Wiki](./llm-wiki.md) — why it is built this way
- [Benchmark](../BENCHMARK.md) — measured numbers
