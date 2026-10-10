#!/usr/bin/env bash
#
# One-touch setup for PierrotKnowledge2 on macOS and Linux.
#
# Installs Bun if missing, installs dependencies, generates the icon, builds the
# interface, creates a starter knowledge bundle, and puts a launcher on the
# Desktop.
#
# Safe to re-run: every step checks before it acts.
#
# The launcher opens the interface: served on 127.0.0.1 and shown in the
# browser you already use. There is no packaged window any more — it cost 633 MB
# resident against 135 MB for the identical interface in a tab.
#
#   bash scripts/setup.sh [--bundle PATH] [--no-shortcut] [--connect]
#
# `bash scripts/setup.sh` rather than `./scripts/setup.sh`: the release zip is
# built on Windows and carries no Unix permission bits, so nothing in a fresh
# download is executable yet. Running it through `bash` needs no bit of its own,
# and restoring the rest is this script's first job.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="PierrotKnowledge2"
BUNDLE_PATH=""
NO_SHORTCUT=0
CONNECT=0

while [ $# -gt 0 ]; do
  case "$1" in
    # `shift 2` on a lone `--bundle` returns non-zero and, under `set -e`,
    # ended the script with no message at all. Say what is missing instead.
    --bundle)
      if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
        echo "--bundle needs a path, e.g. --bundle \"\$HOME/Documents/Notes\"" >&2
        exit 1
      fi
      BUNDLE_PATH="$2"; shift; shift ;;
    --no-shortcut) NO_SHORTCUT=1; shift ;;
    --connect)     CONNECT=1; shift ;;
    -h|--help)     sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Wrap a value as a single-quoted shell word, so a path containing a space,
# an apostrophe or a dollar sign survives being written into a script.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$1"; }
note() { printf '    \033[90m%s\033[0m\n' "$1"; }
warn() { printf '    \033[33m%s\033[0m\n' "$1"; }

# --- executable bits and quarantine ------------------------------------------

# The release archive is built on Windows with Compress-Archive, which does not
# record Unix permissions. Everything arrives as 0644, so the scripts a macOS or
# Linux user is told to run are not runnable. Restoring the bit here is the
# cheapest fix: setup is the first thing they run, via `bash scripts/setup.sh`,
# which needs no bit of its own.
#
# Kept in step with EXECUTABLE_PATHS in src/bun/update.ts, which does the same
# after an update replaces these files.
for f in \
  "$PROJECT_ROOT/PierrotKnowledge2" \
  "$PROJECT_ROOT/SETUP.command" \
  "$PROJECT_ROOT/UNINSTALL.command" \
  "$PROJECT_ROOT/scripts/setup.sh" \
  "$PROJECT_ROOT/scripts/uninstall.sh"
do
  # An explicit if, not an && chain: this script runs under `set -e`, where a
  # trailing chain that evaluates false can take the whole script down with it.
  if [ -f "$f" ] && [ ! -x "$f" ]; then
    chmod +x "$f"
  fi
done

# macOS tags anything unzipped from a download with com.apple.quarantine, and
# Gatekeeper then refuses to run a double-clicked .command from it — "cannot be
# opened because it is from an unidentified developer", with no way forward that
# a first-time user would guess. Clearing it on our own folder is what the
# right-click-Open dance does, done once and without the dance.
if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$PROJECT_ROOT" 2>/dev/null || true
fi

# --- Bun ---------------------------------------------------------------------

step "Checking for Bun"

if ! command -v bun >/dev/null 2>&1; then
  # A fresh install is not on PATH until the shell restarts.
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    note "Bun not found — installing from bun.sh"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi

command -v bun >/dev/null 2>&1 || {
  echo "Bun installed but not on PATH. Open a new terminal and re-run." >&2
  exit 1
}

ok "Bun: $(command -v bun) ($(bun --version))"

cd "$PROJECT_ROOT"

# --- dependencies ------------------------------------------------------------

step "Installing dependencies"
bun install
ok "Dependencies installed"

# --- icon --------------------------------------------------------------------

step "Generating application icon"
bun run scripts/make-icon.ts

# iconutil turns the .iconset into a real .icns; it ships with Xcode's command
# line tools, so its absence is a missing nicety rather than a failure.
if [ "$(uname -s)" = "Darwin" ] && command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns assets/icon.iconset -o assets/icon.icns && ok "assets/icon.icns"
else
  ok "assets/icon.png"
fi

# --- build -------------------------------------------------------------------

LAUNCH_CMD=""

# The view and nothing else: no runtime to package, no WebView to embed, so
# this is seconds rather than the minutes packaging used to take.
#
# LAUNCH_MODE survives with one value because the launcher block and the
# summary both read it, and because "no interface at all" is still reachable by
# not running this script (see `bun run build:headless`).
LAUNCH_MODE="web"

step "Building the interface"
bun run build:view
ok "Interface ready (127.0.0.1, opens in your browser)"

# --- starter bundle ----------------------------------------------------------

if [ -z "$BUNDLE_PATH" ]; then
  BUNDLE_PATH="$HOME/Documents/$APP_NAME"
fi

step "Preparing knowledge bundle at $BUNDLE_PATH"
bun run scripts/init-bundle.ts "$BUNDLE_PATH"

# The launcher is a real script in the install directory, and every shortcut
# just runs it.
#
# It used to be a compound shell command embedded in the shortcut, which meant
# quoting the paths for the shell and then quoting the whole thing again for
# the .desktop file's own escaping rules. One apostrophe in a home directory
# and the launcher silently stopped working. A file has no quoting problem.
#
# The bundle is baked in deliberately: without it the CLI falls back to
# whatever the last session opened, which on a first run is nothing at all.
if [ "$LAUNCH_MODE" = "web" ]; then
  LAUNCH_SCRIPT="$PROJECT_ROOT/.launch-ui.sh"
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Written by scripts/setup.sh. Re-run setup to point it elsewhere.\n'
    printf 'set -euo pipefail\n'
    printf 'cd %s\n' "$(quote "$PROJECT_ROOT")"
    printf 'exec ./%s ui --bundle %s\n' "$APP_NAME" "$(quote "$BUNDLE_PATH")"
  } > "$LAUNCH_SCRIPT"
  chmod +x "$LAUNCH_SCRIPT"
fi

# --- desktop launcher --------------------------------------------------------

# Ask the desktop where its desktop is before assuming English: a Japanese
# GNOME uses ~/デスクトップ, a Spanish one ~/Escritorio. Uninstall reads the same
# setting (see desktopDirectories in src/bun/uninstall.ts), so a launcher put
# here is one it can find again.
DESKTOP=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
fi

# xdg-user-dir is absent from minimal installs, but the file it reads is plain
# text and always there when the setting exists.
if [ -z "$DESKTOP" ] || [ ! -d "$DESKTOP" ]; then
  USER_DIRS="${XDG_CONFIG_HOME:-$HOME/.config}/user-dirs.dirs"
  if [ -f "$USER_DIRS" ]; then
    DESKTOP="$(. "$USER_DIRS" >/dev/null 2>&1; printf '%s' "${XDG_DESKTOP_DIR:-}")"
  fi
fi

[ -n "$DESKTOP" ] && [ -d "$DESKTOP" ] || DESKTOP="$HOME/Desktop"

if [ "$NO_SHORTCUT" = "0" ] && [ -d "$DESKTOP" ]; then
  step "Creating Desktop launcher"

  if [ "$(uname -s)" = "Darwin" ]; then
    LAUNCHER="$DESKTOP/$APP_NAME.command"
    {
      printf '#!/usr/bin/env bash\n'
      printf 'exec %s\n' "$(quote "$LAUNCH_SCRIPT")"
    } > "$LAUNCHER"
    chmod +x "$LAUNCHER"
    ok "$LAUNCHER"
  else
    # Freedesktop .desktop entry, on the Desktop and in the app menu.
    #
    # Exec points straight at the launcher script. A .desktop value has its own
    # escaping rules on top of the shell's, so the fewer levels of quoting it
    # carries the better: only the backslash and double quote need escaping for
    # the field itself.
    LAUNCHER="$DESKTOP/okf-wiki.desktop"
    EXEC_FIELD="$(printf '%s' "$LAUNCH_SCRIPT" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    cat > "$LAUNCHER" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=OKF v0.2 local knowledge base for humans and agents
Exec="$EXEC_FIELD"
Icon=$PROJECT_ROOT/assets/icon.png
Terminal=true
Categories=Office;Utility;
EOF
    chmod +x "$LAUNCHER"

    APPS_DIR="$HOME/.local/share/applications"
    mkdir -p "$APPS_DIR"
    cp "$LAUNCHER" "$APPS_DIR/okf-wiki.desktop"

    # Newer GNOME refuses to run a .desktop file it does not trust.
    if command -v gio >/dev/null 2>&1; then
      gio set "$LAUNCHER" metadata::trusted true 2>/dev/null || true
    fi

    ok "$LAUNCHER"
    note "Also installed to $APPS_DIR"
  fi
fi

# --- MCP registration --------------------------------------------------------

# Written by the app rather than by this script. A hand-rolled copy here drifted
# once already — it hard-coded `"command": "bun"`, which a GUI-launched agent
# host on macOS cannot resolve, because launchd's PATH never contains
# ~/.bun/bin. `mcp-config` emits whatever serverSpecFor decides, which is the
# compiled binary when one exists and an absolute Bun path otherwise.
step "Writing MCP configuration"

MCP_PATH="$PROJECT_ROOT/mcp-config.json"

# Written aside and moved into place. A redirect straight onto the target
# truncates it before the CLI has produced a byte, so a run that fails — a bad
# --bundle, a broken build after an update — leaves an empty file where the
# working config the user was told to copy from used to be.
MCP_TMP="$MCP_PATH.tmp.$$"
if bun run src/bun/cli/main.ts mcp-config --bundle "$BUNDLE_PATH" > "$MCP_TMP"; then
  mv "$MCP_TMP" "$MCP_PATH"
  ok "$MCP_PATH"
else
  rm -f "$MCP_TMP"
  echo "MCP 設定を生成できませんでした。" >&2
  exit 1
fi

CONNECTED=""
if [ "$CONNECT" = "1" ]; then
  step "Connecting agent runtimes (--connect)"
  # Detection and merging both live in connect-agent.ts, so this script never
  # has to know which hosts exist or what shape each one's config is.
  if bun run scripts/connect-agent.ts --all "$BUNDLE_PATH"; then
    CONNECTED="done"
  else
    warn "Some runtimes could not be connected — see the messages above"
  fi
fi

step "Done"
echo
printf '  Bundle    : %s\n' "$BUNDLE_PATH"
printf '  Desktop   : %s\n' "$([ "$NO_SHORTCUT" = "1" ] && echo skipped || echo "$APP_NAME")"
printf '  MCP config: %s\n' "$MCP_PATH"
echo
printf '  Start it:   cd %s && ./%s ui\n' "$PROJECT_ROOT" "$APP_NAME"
printf '  Remove it:  bash scripts/uninstall.sh\n'
echo

if [ -z "$CONNECTED" ]; then
  note "To register this bundle with Claude Code, Codex, opencode and friends:"
  note "  bash scripts/setup.sh --connect"
  note "Or merge mcp-config.json into an agent's MCP settings by hand."
fi
note "Agents should call read_map first."
echo
