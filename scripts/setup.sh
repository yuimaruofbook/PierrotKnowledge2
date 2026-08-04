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
#   ./scripts/setup.sh [--bundle PATH] [--no-shortcut]

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="PierrotKnowledge2"
BUNDLE_PATH=""
NO_SHORTCUT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle)      BUNDLE_PATH="${2:-}"; shift 2 ;;
    --no-shortcut) NO_SHORTCUT=1; shift ;;
    -h|--help)     sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$1"; }
note() { printf '    \033[90m%s\033[0m\n' "$1"; }
warn() { printf '    \033[33m%s\033[0m\n' "$1"; }

# --- executable bits ---------------------------------------------------------

# The release archive is built on Windows with Compress-Archive, which does not
# record Unix permissions. Everything arrives as 0644, so the scripts a macOS or
# Linux user is told to run are not runnable. Restoring the bit here is the
# cheapest fix: setup is the first thing they run, via `bash scripts/setup.sh`,
# which needs no bit of its own.
for f in "$PROJECT_ROOT/PierrotKnowledge2" "$PROJECT_ROOT/SETUP.command" "$PROJECT_ROOT/scripts/setup.sh"; do
  # An explicit if, not an && chain: this script runs under `set -e`, where a
  # trailing chain that evaluates false can take the whole script down with it.
  if [ -f "$f" ] && [ ! -x "$f" ]; then
    chmod +x "$f"
  fi
done

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

# The bundle is baked into the command deliberately: without it the CLI falls
# back to whatever the last session opened, which on a first run is nothing at
# all, and the launcher would open the app onto an empty window.
if [ "$LAUNCH_MODE" = "web" ]; then
  LAUNCH_CMD="cd '$PROJECT_ROOT' && ./$APP_NAME ui --bundle '$BUNDLE_PATH'"
fi

# --- desktop launcher --------------------------------------------------------

DESKTOP="$HOME/Desktop"
[ -d "$DESKTOP" ] || DESKTOP="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"

if [ "$NO_SHORTCUT" = "0" ] && [ -d "$DESKTOP" ]; then
  step "Creating Desktop launcher"

  if [ "$(uname -s)" = "Darwin" ]; then
    LAUNCHER="$DESKTOP/$APP_NAME.command"
    printf '#!/usr/bin/env bash\n%s\n' "$LAUNCH_CMD" > "$LAUNCHER"
    chmod +x "$LAUNCHER"
    ok "$LAUNCHER"
  else
    # Freedesktop .desktop entry, on the Desktop and in the app menu.
    LAUNCHER="$DESKTOP/okf-wiki.desktop"
    cat > "$LAUNCHER" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=OKF v0.2 local knowledge base for humans and agents
Exec=bash -lc "$LAUNCH_CMD"
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

# --- MCP registration hint ---------------------------------------------------

MCP_PATH="$PROJECT_ROOT/mcp-config.json"
cat > "$MCP_PATH" <<EOF
{
  "mcpServers": {
    "okf-wiki": {
      "command": "bun",
      "args": ["run", "$PROJECT_ROOT/src/bun/mcp/standalone.ts"],
      "env": { "OKF_BUNDLE": "$BUNDLE_PATH" }
    }
  }
}
EOF

step "Done"
echo
printf '  Bundle    : %s\n' "$BUNDLE_PATH"
printf '  Desktop   : %s\n' "$([ "$NO_SHORTCUT" = "1" ] && echo skipped || echo "$APP_NAME")"
printf '  MCP config: %s\n' "$MCP_PATH"
echo
note "To connect an agent (Claude Code etc.), merge mcp-config.json into your"
note "MCP settings. Agents should call read_agents_md first."
echo
