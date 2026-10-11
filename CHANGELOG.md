# Changelog

## 0.7.1

### The prebuilt Rust binary is actually used on Windows

0.7.0 attached the Rust builds to its release, but on Windows setup without
`cargo` still fell back to the 94 MB Bun build, for two reasons that only show
on a real download:

- The download was saved as `okf.exe.download`, and Windows will not start a
  file that does not end in `.exe` — so the start-up check failed every time.
  It is now `okf.download.exe`.
- Windows Defender holds a freshly written executable for about half a second
  while it scans it, and starting it in that window fails with `EBUSY`. The
  check now waits that out (up to five seconds) instead of reading it as
  "cannot run here".

Verified end to end against the V0.7.0 assets with `cargo` removed from `PATH`:
both binaries download, match GitHub's SHA-256, start, and are installed.

## 0.7.0

### Lifecycle, context range, activity summaries and know-how

Four additions to the MCP tools (45 now), in both the Bun and the Rust build,
byte for byte the same.

- **`Product` and `DEAD` tags.** `set_lifecycle { path, lifecycle: product | dead | none }`
  edits the frontmatter tags through the normal write path. DEAD concepts are
  left out of `search`, `retrieve` and `context_pack` unless
  `include_dead` is true; `list_concepts` still lists them, with a
  `lifecycle` key on marked entries. Product multiplies the ranking score by
  1.1, a nudge smaller than one PARA step (resource to area is 1.2), so it
  settles ties without letting a Product page outrank a better match.
- **Context range.** `retrieve` and `context_pack` take `para_depth` (1-4:
  projects only, up to everything) and `link_depth` (0-2: follow links from the
  returned files and list their one-line descriptions, never bodies, inside the
  same character budget). Out-of-range values are rejected, not clamped.
- **`summarize_activity`.** log.md rows grouped by actor, then file, each line
  citing its date and path, with totals per action. `save: true` writes it as
  an `ActivitySummary` concept under `wiki/activity/`.
- **Know-how.** `knowhow_add` records a short lesson with who recorded it in
  `wiki/knowhow/`; `knowhow_find` ranks them like `skill_find`;
  `context_pack` adds the top three. New bundles get both folders with an
  `index.md`; older ones get them on the first write. AGENTS.md tells agents
  to check know-how first and record a lesson after a non-obvious discovery.

### Bases: list and aggregate views over the concepts

`.base` files (the Obsidian Bases format) define saved lists and aggregates over
the concepts, shown as a table or cards. Three more MCP tools (48 now), in the
Bun and the Rust build, byte for byte the same.

- **`base_list`, `base_query { path, view?, limit? }`, `base_write { path, content, actor? }`.**
  `base_query` returns columns, rows or groups, summaries and warnings as JSON plus
  a Markdown table; rows are ordered deterministically and capped at 500.
  `base_write` checks the YAML and the supported subset first and writes the text
  exactly as given, so keys this app does not use survive a round trip.
- **Supported subset.** `filters` (and / or / not; `not` means none of), `formulas`,
  `properties` (`displayName`), custom `summaries`, and `views` of type `table` and
  `cards` with `name`, `filters`, `order`, `sort`, `limit`, `groupBy`, `summaries`.
  Expressions are parsed and evaluated by a small evaluator, never `eval`; dates
  are UTC. Not supported: other view types (kept, listed, not run), `file.size`,
  `ctime`, `embeds`, `backlinks`, `this`, regular-expression literals, `html()`,
  `image()`, `icon()`, `random()`, `relative()`. `file.para` is an extension.
- **Interface.** Opening a `.base` shows tabs per view, the table or cards, group
  headers (click to fold), a summary row and click-through to the concept;
  "YAML を編集" switches to the raw source, saved through the normal write path.
- New bundles get `wiki/bases/` with an example. `.base` files are not concepts.

### The headless server and the CLI, in Rust

`rust/` is a port of everything an agent or a terminal talks to — the 41 MCP
tools, the stdio server, the CLI, the bundle, YAML, FTS5 search, retrieval,
context packs, connecting, updating and uninstalling. The browser interface is
still TypeScript.

| | Rust | Bun |
|---|---|---|
| `okf-mcp` executable | 7.2 MB | 94 MB |
| First reply after start | 33 ms | 145 ms |
| Resident while idle | 7.7 MB | 89.6 MB |
| CLI `info` / `search` | 33–84 ms | 180–198 ms |

It is a port, not a rewrite: the same calls get the same bytes back.
`test/rust-parity.test.ts` sends 186 MCP calls — every tool, every error path,
malformed JSON-RPC, external edits picked up by the watcher — to both servers
on two copies of one bundle, and `test/rust-cli-parity.test.ts` runs about 210
command lines through both CLIs, comparing stdout, stderr and exit code. Only
the bundle path and clocks are masked. Getting there meant reproducing JS where
it shows: UTF-16 lengths for snippets and chunk offsets, JS number printing,
key order in JSON, ICU collation in the host's locale (Japanese names sort as
Bun sorts them), npm `yaml`'s output, Node's path resolution and error text,
and even SQLite's bm25 computed with fused multiply-add, as Bun's SQLite is.

What it cannot reproduce: a snippet cut through an emoji or 𠮷 ends in U+FFFD
where JS leaves a lone surrogate, and a few YAML forms this app never writes
(tab indentation, complex keys, anchors) read differently.

`bun run build:headless` and `bun run build:cli` build the Rust binaries when
`cargo` is on `PATH`, into the same paths as before, and fall back to Bun
otherwise — so setup needs nothing new. A failed Rust build leaves the working
binary in place.

### The Rust build reaches machines without Rust

Each release now carries `okf-mcp` and `okf` for Windows x64, macOS arm64 and
x64, and Linux x64, built by `.github/workflows/native.yml`, which also runs the
crate's tests on all three systems on every change to `rust/`. Without `cargo`,
setup downloads the binary for its platform and version and installs it only
if it matches the SHA-256 GitHub recorded for it; anything else — another
platform, no network, a mismatch — falls back to the Bun build, as before.

Updating now carries the Rust sources too (`rust/Cargo.toml`, `rust/Cargo.lock`,
`rust/src`), entry by entry, so a developer's `rust/target` is never moved.

## 0.6.0

### Strata and Unsloth Desktop

Two more local runtimes, each connected both ways it can be:

- **As model servers** for the built-in agent: [Strata](https://github.com/Niko1221/Strata)
  on `127.0.0.1:8080/v1` and [Unsloth Desktop](https://github.com/unslothai/unsloth)
  on `127.0.0.1:8888/v1`. Unsloth's API is authenticated, so a target can now
  name the environment variable its key comes from (`UNSLOTH_API_KEY`,
  `STRATA_API_KEY`). The key is read per request and written nowhere.
- **As MCP hosts**, so their own chat can use this bundle. Strata reads a
  `mcpServers` file through `--mcp-config`; ours is `strata-mcp.json` beside
  this app's other settings, because Strata's `strata-<model>.json` is setup's
  to rewrite. Unsloth keeps its servers in SQLite, which is not ours to write,
  so it gets the snippet for its MCP import — the panel says "paste this JSON"
  rather than "run this command".

Ports, config shapes and the import format were read from each project's own
docs and source, not recalled.

### The connections panel no longer opens on an error

Opening it probed Ollama for its models — the first server in the list — on a
machine without Ollama, and put "Ollama に接続できません" in the status bar
before anything was pressed. The local run now starts on a server that is
actually installed, and a server that is not running is explained beside the
model picker, with its setup note, the raw reason and a retry button. Run stays
disabled until there is a model and a task, and Enter starts it.

Eighteen rows, most of them "未検出", buried the three that could be used.
Tools found here, or already configured, come first; the rest fold under
"未検出のツール（n）".

### Rebuilding the headless server while an agent is using it

`bun run build:headless` refused whenever an agent host had the server open,
which is nearly always, so the build that agents ran fell behind the source:
39 tools while the source had 41. Windows will rename a running executable, so
the build now moves it to `okf-mcp.exe.old` and puts the new one in place.
Sessions already running keep their copy; the next one gets the new build.

### `mcp-config.json` is no longer in the repository

It is written by setup for the local machine and was already in `.gitignore`,
but a copy with one machine's paths had been committed.

### Installing and removing it, on every platform

The macOS and Linux install instructions could not be followed. They said to
run `bun install && bun run setup:unix` — but installing Bun is the first thing
setup does, so the documented first step required the thing it was there to
provide. And nothing in a fresh download was executable, so `SETUP.command`
could not be run at all.

There is now one command per platform, and neither needs anything installed
first:

```
SETUP.bat            # Windows
bash SETUP.command   # macOS / Linux
```

`bash` rather than `./` because it works no matter how the copy on disk got
there. Setup also clears macOS's `com.apple.quarantine`, so double-clicking
works from then on instead of being refused as coming from an unidentified
developer.

### The release archive was malformed

Two problems, both invisible on the Windows machine that built it, and both
landing on whoever downloaded it:

- **Paths used backslashes as separators**, which the ZIP spec forbids
  (4.4.17.1). Info-ZIP's `unzip` prints a warning and recovers; other
  extractors are entitled to treat the separator as a literal character and
  drop the whole tree into one flatly-named file. `Compress-Archive` writes
  them that way, so the archive is now built with `bsdtar`
  (`%SystemRoot%\System32\tar.exe`, shipped since Windows 10 1803), with
  `Compress-Archive` kept as the fallback. It has to be named by absolute path:
  a machine with Git for Windows on `PATH` resolves a bare `tar` to GNU tar,
  which cannot write a zip and silently produced a tar file with a `.zip` name.
- **Every entry recorded 0666, and directories 0777.** NTFS has no Unix mode to
  report, so nothing arrived executable and everything arrived world-writable —
  the latter only unnoticed because `unzip` applies the umask. The archive's
  recorded permissions are now normalised outright: 0644 for files, 0755 for
  directories and for the five scripts that must run. Verified by reading the
  archive back, because this is the difference between a download that runs and
  one that does not.

**Uninstalling has an entry point too.** `UNINSTALL.bat` and
`UNINSTALL.command` sit beside their setup counterparts; previously macOS and
Linux users had to already know `./PierrotKnowledge2 Uninstall` existed. Both
still show a plan and delete nothing until re-run with `--apply`, and your
notes are never in that plan.

`--connect` reached macOS and Linux as well: registering the bundle with every
agent host found on the machine was a Windows-only switch.

### Three ways this was broken on macOS and Linux specifically

- **Agent hosts launched from the GUI could not start the MCP server.**
  `setup.sh` hand-wrote `"command": "bun"` into `mcp-config.json`. A GUI-launched
  app on macOS inherits launchd's `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` —
  which never contains `~/.bun/bin`, so the host reported a failed server and
  said nothing about why. The config now comes from the same `serverSpecFor` the
  app uses: the compiled headless binary when one exists, an absolute Bun path
  otherwise. The hand-written copy had drifted from the shared one exactly as an
  earlier one in `setup.ps1` did.
- **Every update broke the launcher.** An update extracts the archive over the
  install, so `./PierrotKnowledge2` came back as 0644 and the next run was
  "Permission denied" — an update that looked like it had broken the app. The
  bits are restored as part of applying one, which also covers updating *from*
  a release built before the archive was fixed.
- **Uninstall looked for launchers in `~/Desktop` only.** A Japanese GNOME puts
  the desktop at `~/デスクトップ`, a Spanish one at `~/Escritorio`. Setup asked
  `xdg-user-dir` and wrote there, so the menu entry it left behind pointed at an
  application that was gone. Both halves now read the same setting.
- **The Linux launcher broke on a path containing an apostrophe.** It embedded
  a compound shell command inside the `.desktop` `Exec` field, so the paths were
  quoted for the shell and then quoted again for freedesktop's own escaping
  rules. Setup now writes a real launcher script and every shortcut just runs
  it; a file has no quoting problem.

### Connecting could delete every other MCP server you had

`--connect` merged into each host's config by parsing it, adding one entry and
writing it back — and a config that failed to parse was treated as absent, so
what got written back was a file containing *only* our entry. Every other
server the user had registered was gone, and the connection reported success.

"Unparseable" is mostly not "corrupt". Several of these hosts accept JSONC, so
a config with `//` comments or a trailing comma is a **working** config that
`JSON.parse` rejects — the case where discarding it costs the most. A backup was
taken, but a user told the connection succeeded has no reason to look for one.

A config that is present and cannot be read now stops that host's connection
and says so, naming the file. Absent or empty still starts a fresh one, and
removal was never affected — it writes nothing when it cannot find our entry.

### Uninstall left registrations behind

Three hosts keep their config *inside* the knowledge bundle
(`<bundle>/.mcp.json`, `<bundle>/.cursor/mcp.json`,
`<bundle>/.agents/mcp_config.json`), and uninstall asked about only the first
bundle it knew of. With no saved session it asked about `""`, which made those
paths *relative* — probed against the install directory, where they do not
exist — so the real bundle's entries survived an uninstall that reported
success. That is precisely the "every tool reports a broken MCP server on every
launch" outcome the uninstaller exists to prevent. Every known bundle is now
swept, and which hosts are bundle-scoped is derived from the target rather than
flagged on it, so one added later cannot be missed.

Two smaller ones in the same path: a launcher that is a directory (the
pre-0.5.0 macOS `.app`, when copied rather than symlinked) threw `EISDIR` and
turned a clean uninstall into a reported failure; and existence was checked
with `stat`, which follows symlinks — so the dangling `.app` symlink those
installs actually have was reported as absent and left on the Desktop.

### `--purge-settings` did nothing

The uninstall help printed it and the handler read `flags.purge_settings`, but
the parser stored what it was given — `flags["purge-settings"]` — so the flag
was silently ignored. Flag names now fold hyphens to underscores, the way
command names already did (`skill-find` → `skill_find`), so both spellings
work and the two halves of the command line follow one rule.

### Smaller fixes in the same pass

- **`okf write-file --content` no longer discards Markdown.** A value opening
  with `---` — which is every file with frontmatter — was read as the next
  flag, leaving `--content` valueless and writing an empty file over what was
  passed. A flag name has to start with a letter; dashes alone are a value. The
  `--` terminator counts as a flag for this purpose, or a preceding bare flag
  eats it and the positional after it is reparsed as a flag.
- **A failed update no longer strands the files it added.** The undo restored
  every path it had renamed aside, but a top-level path the archive *introduces*
  has no backup to restore over it, so it stayed behind in an otherwise
  rolled-back tree.
- **`setup.sh` writes `mcp-config.json` via a temp file.** Redirecting onto it
  truncated the previous good config before the generator had produced a byte,
  so a failed re-run left an empty file where the config the user was told to
  copy from used to be.
- **`--bundle` with no path says so** instead of ending the script silently on
  a `shift` that ran off the end of the arguments.

### Context packs, sized to the model that reads them

A new `context_pack` MCP tool assembles the minimal set of files for a task:
relevant passages grouped by file (an agent plans in files, not fragments),
each file's one-line description, and the skills that match the task — all
within one character budget. It replaces the read-around at the start of
substantial work.

The budget follows the consumer. `tier: "worker"` returns a small pack that
fits a local model's context alongside its instructions; `tier: "supervisor"`
returns a broader one for a frontier model planning or verifying. Same bundle,
same rules — only the hand-out differs.

### Provenance that survives several models writing at once

When frontier and local models share one bundle, "who wrote this" stops being
recoverable by memory. Two additions keep it recoverable by machine:

- **`audit_changes`** parses `log.md` back into entries and groups them by
  actor — the human, or whichever `process:` wrote — optionally since a date.
  Hand-written prose rows (which OKF §9 allows) are skipped, not errors.
- **`write_file` now warns when an agent writes a concept without
  `generated`** in its frontmatter. The check is a nudge at write time, not a
  rejection, and does not apply to humans in the editor or to `skills/` and
  `loops/`, which hold procedures rather than knowledge claims.
  `create_concept` already stamps `generated.by` and remains the recommended
  path for new pages.

### AGENTS.md teaches long-running work and model tiers

The scaffold's contract gained a protocol for work that spans sessions —
orient with `read_map` → `list_tasks` → `read_human`, shape big work as
loops, journal decisions with `loop_note`, close with `update_task` +
`loop_end` — and a Supervisor/Worker role split for mixed-model setups:
workers write drafts (`status: draft`) inside the pack they were handed;
promotion to `stable` and verification belong to the supervisor or the human.

### Fixes found while building the above

Auditing provenance only works if the record underneath it is right, and
reviewing that record turned up several places where it was not:

- **`log.md` headings now use the local day, not UTC.** A morning write in JST
  was filed under yesterday's heading — a different date than the daily note
  describing the same moment, and one an `audit_changes` date filter would
  silently skip. Completed-task dates were computed the same wrong way.
- **Automated changes are tagged `process:`, consistently.** A PARA refile by
  an agent logged as `agent:local` and a daily-task transfer as bare `agent`,
  so neither appeared when filtering the audit for agent activity — which is
  the filter the tool's own description recommends.
- **A layer root can no longer be deleted.** `delete_file` refused reserved
  filenames by basename, so deleting `wiki` recursively took `index.md`,
  `log.md` and every concept with it in one call. The guard compares paths the
  way containment already did — case-insensitively on Windows and macOS, where
  `WIKI` and `wiki` are one directory and a `===` check is one an agent steps
  around by changing the case.
- **`daily_note` rejects a rolled-over date.** `2026-02-30` passed the format
  check and `Date` quietly normalised it to March 2nd, writing into the wrong
  day's note — the exact failure the date validation exists to prevent.
- **Promotion from outside `raw/` says so**, rather than reporting a file that
  plainly exists as missing.
- **Collecting daily tasks writes `Task.md` once**, not once per line, and the
  writes it and its neighbours make no longer reach the watcher as if they
  came from another editor.
- **`context-pack`, `audit-changes` and `list-tags` appear in `okf --help`.**
  The command list is hand-grouped, so a new tool was dispatchable but
  invisible; a test now asserts every tool is grouped or explicitly unlisted.

### HTML comes in as HTML

Material arrives as HTML more often than as Markdown — a page fetched over MCP,
a browser's clipboard, a page saved to disk — and all of it was being flattened
to Markdown or stored as `.md` full of tags. Both outcomes lose the document:
one throws away everything Markdown has no syntax for, the other shows the
markup instead of the page.

`.html` and `.htm` now open in the reading view like Markdown does, and three
ways in produce them:

- **Dropping files on the window** captures them into `raw/` and opens the
  first one. Text only — a PDF is reported rather than decoded into
  replacement characters — and bounded at 8 MB, because the content crosses
  the RPC socket as one message.
- **MCP imports** are written as `.html` when the tool returned a page, with a
  provenance header in HTML rather than Markdown syntax the file would never
  render. The capture itself is still stored byte-for-byte.
- **Ctrl+Alt+V** pastes the clipboard's HTML instead of converting it, and is
  the default when the open file is already HTML.

Captured pages render through the same allowlist as note content, not a
sandboxed frame: `script`, `style`, `iframe`, `svg` and every unlisted
attribute are dropped, and links are restricted to `http(s)`, `mailto` and
internal targets. A page copied into the bundle is third-party code, and this
webview holds an RPC bridge to a process with full filesystem authority. The
cost is that a captured page loses its own CSS.

## 0.5.1

0.5.0 shipped, and then people tried to install it. Everything here comes from
that: a documented command that cannot be typed, an update that can appear to
do nothing, and a licence that was never actually stated.

### The command in every manual could not work

```
PS> PierrotKnowledge2 Update
用語 'PierrotKnowledge2' は、コマンドレット、関数、スクリプト ファイル、または
操作可能なプログラムの名前として認識されません。
```

Reported from a real 0.4.7 install trying to upgrade. Setup does not put the
folder on `PATH`, and no shell runs a program from the current directory
without being asked to — PowerShell answers `CommandNotFoundException`, a POSIX
shell "command not found". Every code block we published was missing its
prefix.

The docs now show `.\PierrotKnowledge2` and `./PierrotKnowledge2` with the
reason, and the CLI prints the form for the platform it is running on.

### An update could land and change nothing

`build/` is deliberately not replaced by an update — it is regenerated locally
and the archive carries no 94 MB binaries. The consequence was easy to miss:
both compiled artefacts are *preferred* over the source that was just replaced.
`PierrotKnowledge2.bat` runs `build/cli/okf.exe` when it exists, and every
agent host spawns `build/headless/okf-mcp.exe` by the path written into its own
config. The new release sat on disk with nothing running it.

Found the hard way while checking the report above: this machine's launcher was
still serving a CLI compiled hours earlier, and the change under test was
invisible.

`Update --apply` now names each stale binary and the command that rebuilds it.
Reported rather than deleted — removing the headless binary would point every
agent config at a file that is not there, which is worse than one release
behind.

Two smaller ones on the same path: the post-update instruction was `bun install
&& bun run build`, a script 0.5.0 had just removed; and neither `LICENSE` nor
`CHANGELOG.md` was in the replaced set, so neither would ever have reached an
existing install.

### MIT

There was no `LICENSE` file. The release script had been skipping it with a
one-line notice nobody read, so what anyone was allowed to do with the
published archives was never stated. It is stated now, and it travels with
updates.

### Headless was documented back in

`docs/ja/usage.md` did not contain the word "headless" anywhere, and the
English manual had it once, inside a code block. The mode agents are supposed
to run had fallen out of the manuals while the desktop build was being removed.

Both now open with the three modes — **you use the interface, agents use
headless, automation uses the CLI** — and carry a section on the headless
binary: what it is, why it is one process instead of a page plus a server, and
that pointing an agent at `ui` mode gives it nothing to call, because that
interface speaks RPC to a browser rather than MCP.

`SETUP.bat -Connect` now builds the headless binary, since registering agents
is exactly when it is needed. Without it the entry written into an agent's
config falls back to `bun run …/standalone.ts`, which works only where that
host's own environment has Bun on `PATH` — a GUI-launched host often does not.

### Connecting a tool with no one-press target

```powershell
.\PierrotKnowledge2 mcp-config                    # mcpServers JSON
.\PierrotKnowledge2 mcp-config --format toml      # Codex
.\PierrotKnowledge2 mcp-config --format opencode
.\PierrotKnowledge2 mcp-config --format yaml
.\PierrotKnowledge2 mcp-config --format command
```

A machine runs more MCP-capable tools than the nine with one-press targets.
This prints the entry to paste, built from the same `serverSpecFor` the
one-press path writes — so a pasted config and a written one cannot describe
different servers.

They already did. `setup.ps1` hand-built `mcp-config.json` with the command
hard-coded to `bun run …/standalone.ts`, and went on recommending that long
after the compiled binary became the right answer. That duplicate is gone; the
file is now generated by the command above.

Printed rather than written: editing a config whose shape has not been verified
is how the Hermes connection was silently wrong for a release.

### Also

- `bun run build:headless` failed with a bare `EPERM` — or a bare "Bundle
  failed" on the next run — when an agent had the server open, which is the
  normal state while Claude Code is running. It now checks whether the binary
  is in use *before* building, says what is holding it, and notes that the
  installed binary keeps working meanwhile.
- That failure also left a 94 MB `*.bun-build` temp file in the project root
  each time. Now prevented by the check above, and ignored by git if one ever
  appears.

---

## 0.5.0

The desktop window is gone. The interface is the one served to your own
browser, and that is the only interface there is.

### Why

The project began on the premise that a system WebView would beat a bundled
Chromium. It did not hold, and [the benchmark](docs/BENCHMARK.md) said so:

| | `ui` mode | Desktop |
|---|---|---|
| Resident memory | **135 MB** | 633 MB |
| └ renderer | 49 MB (a browser tab) | 360 MB (6 renderer processes) |

Windows starts six renderer processes for one window, and the packaged build
carried a second copy of the Bun runtime. Neither is fixable from this side.

By the end the two modes were the same Vite bundle, the same RPC surface and
the same `Workspace`. The desktop build's **only** exclusive capability was the
native folder dialog — and the OS opens that for any process that asks.

### The folder dialog, without a runtime

`src/bun/platform.ts` now asks the OS directly:

| | |
|---|---|
| Windows | `powershell.exe -NoProfile -STA` + WinForms `FolderBrowserDialog` |
| macOS | `osascript` → `choose folder` → POSIX path |
| Linux | `zenity --file-selection --directory`, falling back to `kdialog` |

`-STA` is required — WinForms throws without it — and `powershell.exe` rather
than `pwsh` because 5.1 is on every Windows 10/11. A dummy `TopMost` owner form
keeps the dialog in front of the browser instead of behind it. A missing
`zenity` moves on to `kdialog`; a user who pressed **Cancel** is not shown a
second dialog for having declined the first. No desktop session at all returns
null, and the interface asks for the path as text, as it always did.

Verified on a real dialog, not just in tests: the spawned process owns a
visible window of class `#32770` titled "Browse For Folder", and closing it
answers the RPC with null.

`UseDescriptionForTitle` was tried and removed — it exists only on .NET Core
3.0+ WinForms, and `powershell.exe` is always .NET Framework (checked on
4.8.9337, where the property is absent from the type). The wording goes on the
dialog's label instead.

### Fixed on the way

External links in the preview did nothing in `ui` mode. The click is
`preventDefault`ed and handed to `openExternal`, which the browser-served host
answered with `false` unconditionally. It now hands the URL to the OS.

### Removed

The desktop entry point (`src/bun/index.ts`), the packaging config, the
dependency patch that kept 5.4 MB of unused 3D libraries out of the bundle, its
type shims, the `dev` / `build` / `build:prod` / `start` scripts, and the
`-DesktopApp` / `-NoBuild` setup switches. The view's dual transport is a
single WebSocket, 5 kB smaller.

`node_modules` went from **504 MB to 145 MB**, and the patched fork-pin that had
to be re-checked on every upgrade went with it.

### Gained

`exactOptionalPropertyTypes` is on. It had been held off for exactly one
reason — that dependency shipped raw `.ts` which `skipLibCheck` could not hide,
flooding the build with errors we could not fix. Switching it on found two real
gaps in `cli/main.ts`, both now fixed.

### What was actually lost

A page in your browser is reachable by your browser extensions; a window was
not. `ui` binds to loopback and mints a per-run token, but an extension with
host access to `127.0.0.1` can read the page. Open it in an extension-free
browser profile if that matters for your threat model.

---

## 0.4.8

**すべてのエージェントに登録** — one button in the connections panel writes this
bundle into every MCP host on the machine, instead of one at a time.

Per-host outcomes are reported rather than summarised away: written, already
correct, needs a command you run yourself (Claude Code user scope, whose
`~/.claude.json` this app deliberately does not rewrite), or skipped because
the tool is not installed. Hosts whose CLI is not on `PATH` are skipped rather
than littered with a config for something that is not there — a checkbox
includes them, for a real install the probe cannot see (Cursor on Windows,
usually).

One failure never stops the sweep: eight unrelated config files, and a Codex
config that cannot be read is no reason to leave Cursor unconnected.

## 0.4.7

Hermes Agent connects in one touch, and this time it actually connects.

### The bug

`SETUP.bat -Connect` reported Hermes as connected and wrote
`~/.hermes/config.yaml`. Hermes never read that file. `hermes mcp list` showed
nothing, because the entry was wrong in three independent ways at once:

| | assumed | actual (v0.20.0 on Windows) |
|---|---|---|
| config file | `~/.hermes/config.yaml` | `%LOCALAPPDATA%\hermes\config.yaml` |
| `mcp_servers` | top-level | nested under the config root |
| per-server state | none | an enable list, one entry per tool |

A file written to the wrong place in the wrong shape is not a connection, and
it looks exactly like one from the outside.

### What changed

Hermes is now registered by **its own CLI** — `hermes mcp add` — rather than by
hand-merging YAML. The vendor's command writes its own file wherever it
actually keeps it, in whatever shape it currently wants, and enables the tools.
It also connects to the server before saving, so a registration that succeeds
has been proven to work rather than merely written down.

Connect targets gained a general way to do this, so any host shipping a CLI can
use it instead of a bespoke merger.

`hermes mcp remove` is used to undo it during uninstall, which also clears the
OAuth tokens Hermes stores beside the entry — deleting the YAML entry by hand
left those behind.

### Verified on a real install

```
$ hermes mcp list
  Name             Transport                      Tools        Status
  okf-wiki         C:/Users/knsr1/Desktop/Pi...   all          ✓ enabled

$ hermes mcp test okf-wiki
  ✓ Connected! Found 39 tool(s)
```

Connecting twice in a row is part of the test, because it is what setup does:
a first run answers one prompt ("Enable all 39 tools?"), and every run after
answers two, since "Overwrite?" comes first. Answering only the first let the
overwrite through and then hit EOF on the second, and Hermes cancelled having
changed nothing — reported as a connection failure, correctly, only after this
release.

## 0.4.6

External servers with an unset credential now say so, instead of connecting
and then failing every call.

### The bug

Adding the Notion preset writes this into the registry:

```json
"notion": { "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"],
            "env": { "NOTION_TOKEN": "" } }
```

The empty string means "required — paste yours here". Left empty, connecting
**succeeded**: npx downloaded the server, the handshake completed, the panel
reported it connected and listed all 24 tools. Every call then came back as
Notion's own `{"status":401,"code":"unauthorized"}`, and the server reports
that as a normal result rather than an error — so nothing anywhere said the
word "token". From the outside that is "cannot connect to Notion".

The preset's note — *create a Notion integration and give it access to the
pages you want* — was stripped on the way into the registry, so the one moment
it was useful, nobody ever saw it.

### What changed

**A declared-but-empty credential is refused before anything is spawned**, with
a message naming the key and the file to put it in. It costs nothing and takes
no npx download to find out.

**The panel says so before you click.** The status carries the same message, so
adding the Notion preset immediately shows what it still needs.

**The preset note is shown when the preset is added**, which is when it can be
acted on.

### Not changed

The client speaks stdio only. Notion's hosted server at `https://mcp.notion.com`
is Streamable HTTP with OAuth, and connecting to it needs a transport this app
does not have yet — the preset uses the npm server instead, which does the same
job with a token you paste. This is a limitation, not a bug, and it is written
down here so it is not rediscovered.

### Verified

Against a real `npx -y @notionhq/notion-mcp-server`: it connects and exposes 24
tools, and `NOTION_TOKEN` reaches it — a dummy value comes back "API token is
invalid" from Notion's API rather than "no token", which is what proves the
preset names the right variable. A real token is all that is missing.

## 0.4.5

Agent connections were being written with a path that does not exist.

### The bug

Configs written by the app's connection panel pointed at

```
B:/src/bun/mcp/standalone.ts
C:/Users/<you>/AppData/src/bun/mcp/standalone.ts
```

Neither has ever existed. The config file looked correct, `claude mcp list` and
`codex mcp list` listed the server, and no agent host could start it.

The cause is one line: the install directory was computed as
`resolve(import.meta.dir, "..", "..")`. That is a project root only when
running from a source checkout. Inside a compiled binary or a packaged app
`import.meta.dir` is a *virtual* path — Bun uses `B:\~BUN\root\` on Windows —
so the arithmetic produced `B:/`.

`SETUP.bat -Connect` was unaffected: it runs from source, where the arithmetic
happened to be right. Connections made from inside the app were broken.

### What changed

The install directory is now found rather than calculated: the first directory
that genuinely contains `src/bun/mcp/standalone.ts` or a built
`build/headless/okf-mcp`, searched upward from both the module and
`process.execPath` — the latter being a real path in every packaging. When no
such directory exists, it reports nothing instead of inventing a path.

**If you connected before this release, reconnect.** `SETUP.bat -Connect`, or
the app's Skill → agent connection panel, rewrites the entry with a working
path. The old one is backed up first, as always.

### Also fixed

- **Connecting twice no longer edits the file twice.** The Codex merge matched
  its table with `^\s*`, and `\s` matches newlines — so each run swallowed the
  blank line before the table, changed the file, and left another
  `.okf-backup-<timestamp>`. Setup runs connect every time with `-Connect`, so
  this accumulated.
- **No backup is taken when nothing changes.** Claude Code's config lives
  *inside* the bundle, so the old behaviour dropped a
  `.mcp.json.okf-backup-<timestamp>` among the user's notes on every run.
- Claude Code's note now mentions the approval prompt: a project-scope server
  shows as "Pending approval" in `claude mcp list` until the first `claude` in
  that folder asks, which otherwise reads as a failed connection.

### Verified

All four MCP hosts, end to end: the config each one gets is parseable by a real
parser for its format, our entry is present and correct, the user's existing
settings survive, a second run changes nothing, and the server named in the
config answers a real MCP handshake — `initialize`, `tools/list`, and a
`tools/call` search that returns a document from the configured bundle. Checked
for both spawn forms: the compiled headless binary and the `bun run` fallback a
default install gets. `claude mcp list` was then asked directly, and it sees
the server.

## 0.4.4

The Desktop icon now opens the web interface.

### What changed

Double-clicking the icon starts a server on 127.0.0.1 and opens the interface
in the browser you already have running. It is the same UI — the desktop app
was always a WebView around this page — without a second browser engine
resident beside it.

A small console window stays behind, minimised. It *is* the server, so closing
it is how you quit.

Setup is much faster as a result: web mode needs the view built and nothing
else, which takes seconds. Packaging a Bun runtime and a WebView into a
standalone application took several minutes and produced roughly 300 MB of
build output that the icon no longer points at.

### Keeping the desktop application

```
SETUP.bat -DesktopApp
```

Builds the packaged application and points the icon at it, exactly as before.
`-NoBuild` still applies to that path, and `-Headless` is unchanged.

An existing `build/` directory is left alone by web mode, so a desktop build
you already have is still there to run directly.

### Notes

- The icon carries the bundle path chosen during setup. To point it elsewhere,
  run setup again with `-BundlePath`.
- Running setup twice does not start two servers; launching the icon twice
  does. Each takes its own port, so nothing collides, but the second is
  redundant — close its window.
- `scripts/setup.sh` gained the same default and a matching `--desktop-app`.
  On Linux the `.desktop` entry runs in a terminal in web mode, so the server
  can be stopped with Ctrl+C.

### Also

- Fixed a test that asserted "no settings item in the uninstall plan" by
  searching every label for the word 設定. `<host> の設定から MCP エントリを削除`
  contains it too, so the test failed on any machine with an agent host
  configured — a false alarm about the machine, not the code.

## 0.4.3

Opening a folder no longer fails because a file inside it could not be created.

### The bug

Binding a folder failed with:

```
ENOENT: no such file or directory, open 'C:\Users\<you>\Documents\PierrotKnowledge2\index.md'
```

Every note in the folder was readable. The folder opened, was scanned, and its
concepts were loaded — and then the open was thrown away, because the last step
could not write one file.

### Why it happened

Opening a folder creates two reserved files if they are absent: `index.md`, an
entry point, and `log.md`, a history. That write was unguarded, so anything
that stopped it stopped the open — reported as a raw `ENOENT` naming a path
that, to the user, plainly exists.

The reproduction is a name occupied by something that is not a writable file: a
broken shortcut or link, for instance. The write follows it, finds nothing at
the other end, and fails with "no such file or directory" while pointing at a
path the folder listing shows.

### What changed

**The folder opens.** Failing to create `index.md` or `log.md` is now a
warning, not a failure. Both are conveniences, and the notes in the folder are
readable without either.

**The warning says which file and why**, in the status bar, with the path
stated once instead of buried in errno text.

**`BundleInfo` carries `warnings`**, so the MCP server and the CLI see the same
thing the window does.

### Note on where your bundle is

The failing path in the report was `<folder>\index.md`, at the folder root. A
bundle created by setup keeps that file at `<folder>\wiki\index.md` — the root
form only appears when a folder has no `wiki/` subdirectory, which means the
folder being opened was not the bundle setup created.

Setup prints the location it used on its last line (`Bundle : ...`). Since
0.4.2 that is not always Documents: if Documents cannot be written to, setup
falls back to your user profile folder and says so.

## 0.4.2

Setup no longer fails when the Documents folder cannot be used.

### The bug

Setup stopped at the last step with:

```
==> Preparing knowledge bundle at C:\Users\<you>\Documents\PierrotKnowledge2

  Could not find a part of the path 'C:\Users\<you>\Documents\PierrotKnowledge2\.okf-write-test'.

Setup failed with code 1.
```

Everything before it — Bun, dependencies, the icon, the build — had already
succeeded. The message named a file nobody asked for, in a folder setup had
just been told existed.

### Why it happened

Documents is the one location on Windows that anything is allowed to redirect,
and a redirection left half-finished lies to every cheap check:

| Call | What it does on a broken Documents |
|---|---|
| `Test-Path <folder>` | returns **True** — the directory entry is real |
| `New-Item -Force <folder>\x` | reports **success** and creates **nothing** |
| `Set-Content <folder>\x\file` | finally fails, with "Could not find a part of the path" |

Only the third call tells the truth, and by then the error points at the wrong
thing. Four unrelated conditions reach that same message, and **none of them
requires a cloud sync tool to be installed**:

- Documents is a link (junction or symlink) whose target was moved, renamed or
  deleted — a folder relocated to a second drive, an external drive unplugged,
  or a cloud tool's folder redirection turned off
- Documents is a link whose target has since been replaced by a file
- Documents is itself a file rather than a folder
- `Documents\PierrotKnowledge2` is already a file

### What changed

**Setup completes anyway.** If the default location cannot be written to,
setup moves on to the next candidate — Documents, then `OneDrive\Documents`,
then your user profile, then LocalAppData — and reports where it ended up. A
starter bundle is not worth failing an otherwise successful install over.

**A path you asked for is still a path you get.** `-BundlePath` is used exactly
as given. If it cannot be used, setup stops and says so rather than quietly
putting your bundle somewhere else.

**Only folders that already exist are considered.** A missing
`OneDrive\Documents` is skipped rather than created, so the bundle never lands
in a folder the sync client knows nothing about.

**The error names the actual cause.** Setup now reports which component of the
path is wrong and what is wrong with it — a link that cannot be followed
(naming its target), a file where a folder belongs, or a folder that cannot be
opened at all — and prints the remedy for that cause instead of a generic list.

**The check is one you cannot fool.** Locations are verified by creating the
folder, confirming it exists afterwards, and writing and deleting a real file.
Checking whether a link's target exists is not enough: a link pointing at what
is now a file passes that test and still cannot be written to.

### Also

- Fixed argument-repair warnings being emitted before the function that prints
  them was defined, which turned a helpful warning about a mistyped
  `-BundlePath` into a second error on top of the first.
- `docs/en/usage.md` and `docs/ja/usage.md` gained a section on diagnosing an
  unusable Documents folder, with a snippet that identifies which of the four
  conditions applies.
- Added `test/setup-bundle.ps1` and `test/setup-bundle.test.ts`: 31 assertions
  covering all four failure conditions, healthy links, populated folders and
  the fallback order. They run under every PowerShell host on the machine,
  because `SETUP.bat` uses Windows PowerShell 5.1 and passing under PowerShell
  7 alone proves nothing.

### Upgrading

Extract over a fresh folder and run `SETUP.bat` as usual. Bundles created by
earlier versions are untouched; setup never overwrites an existing bundle.

If 0.4.1 already failed for you, nothing needs cleaning up first — the failure
happened before anything was written.
