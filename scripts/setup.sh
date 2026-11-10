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
  "$PROJECT_ROOT/UPDATE.command" \
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

# --- Rust build: what lets this install run without Bun ----------------------

# The release carries the built interface and icon; the two executables come
# from cargo when a Rust toolchain is here, or else from this version's GitHub
# release, used only if they match the digest GitHub computed and start on this
# machine. Any failure falls back to the Bun path below, so setup never needs
# more than it did before. OKF_BUILD=bun forces that path.
native_platform() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  echo macos-arm64 ;;
    Darwin-x86_64) echo macos-x64 ;;
    Linux-x86_64)  echo linux-x64 ;;
    Linux-aarch64|Linux-arm64) echo linux-arm64 ;;
    *) return 1 ;;
  esac
}

# install_native <bin> <build subdir>. Runs as an `if` condition, where `set -e`
# is off, so every step checks its own result.
install_native() {
  local bin="$1" target="$PROJECT_ROOT/build/$2/$1"
  local staged="$target.download" plat name version tag digest="" actual
  mkdir -p "$(dirname "$target")" || return 1
  if command -v cargo >/dev/null 2>&1 && [ -f "$PROJECT_ROOT/rust/Cargo.toml" ]; then
    cargo build --release --manifest-path "$PROJECT_ROOT/rust/Cargo.toml" --bin "$bin" \
      && cp "$PROJECT_ROOT/rust/target/release/$bin" "$staged" \
      || { note "Rust 版の $bin をビルドできませんでした"; return 1; }
  else
    plat="$(native_platform)" || { note "$(uname -s)-$(uname -m) 向けのビルド済みバイナリはありません"; return 1; }
    name="$bin-$plat"
    version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PROJECT_ROOT/package.json" | head -n 1)"
    # Releases have been tagged both V0.5.2 and v0.5.2. No jq on a stock
    # machine: the asset's digest is the first one after its name.
    for tag in "V$version" "v$version"; do
      digest="$(curl -fsSL --max-time 15 -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/yuimaruofbook/PierrotKnowledge2/releases/tags/$tag" 2>/dev/null \
        | grep -oE '"(name|digest)": *"[^"]*"' \
        | awk -F'"' -v want="$name" '$2 == "name" { hit = ($4 == want) } $2 == "digest" && hit && out == "" { out = $4 } END { print out }')" || digest=""
      [ -n "$digest" ] && break
    done
    [ -n "$digest" ] || { note "リリース $version に $name がありません"; return 1; }
    curl -fsSL -o "$staged" "https://github.com/yuimaruofbook/PierrotKnowledge2/releases/download/$tag/$name" \
      || { rm -f "$staged"; note "$name をダウンロードできませんでした"; return 1; }
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$staged" | cut -d ' ' -f 1)"
    else
      actual="$(shasum -a 256 "$staged" | cut -d ' ' -f 1)"
    fi
    if [ "sha256:$actual" != "$digest" ]; then
      rm -f "$staged"
      note "$name のハッシュが一致しません（破損または改ざんの可能性）"
      return 1
    fi
  fi
  chmod +x "$staged" || return 1
  # The digest proves it is the published file, not that it runs here (a Linux
  # build against a newer glibc fails only when spawned).
  if [ "$bin" = "okf" ]; then
    OKF_BUNDLE='' "$staged" help >/dev/null 2>&1
  else
    OKF_BUNDLE='' "$staged" </dev/null >/dev/null 2>&1
  fi || { rm -f "$staged"; note "$bin がこのマシンで起動しません"; return 1; }
  # Renaming over a running binary is safe here: it keeps its image.
  mv -f "$staged" "$target"
}

NATIVE=0
OKF="$PROJECT_ROOT/build/cli/okf"
if [ "${OKF_BUILD:-}" != "bun" ]; then
  step "Installing the Rust build (no Bun needed)"
  if [ ! -f "$PROJECT_ROOT/src/mainview/dist/index.html" ]; then
    note "画面のビルドが同梱されていないため、Bun で組み立てます"
  # Agents spawn the headless server by path; without it their configs would
  # name `bun run`, which a Bun-free machine cannot start.
  elif install_native okf cli && install_native okf-mcp headless; then
    NATIVE=1
    ok "Rust: $OKF"
  fi
fi

# --- Bun ---------------------------------------------------------------------

if [ "$NATIVE" != "1" ]; then
step "Checking for Bun"

if ! command -v bun >/dev/null 2>&1; then
  # A fresh install is not on PATH until the shell restarts.
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    # bun.sh/install downloads with curl and unpacks with unzip, and a stock
    # Ubuntu ships without unzip — the installer then stops halfway with a
    # message about a tool the user never asked for. Name both up front.
    missing=""
    for tool in curl unzip; do
      command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
    done
    if [ -n "$missing" ]; then
      echo "Bun のインストールに必要なコマンドがありません:$missing" >&2
      if command -v apt-get >/dev/null 2>&1; then
        echo "  sudo apt install$missing  を実行してから、もう一度セットアップしてください。" >&2
      elif command -v dnf >/dev/null 2>&1; then
        echo "  sudo dnf install$missing  を実行してから、もう一度セットアップしてください。" >&2
      else
        echo "  パッケージマネージャーで$missing を入れてから、もう一度セットアップしてください。" >&2
      fi
      exit 1
    fi
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
fi

cd "$PROJECT_ROOT"

# --- dependencies ------------------------------------------------------------

# The Rust build needs none of this: the release ships the page and the icon.
if [ "$NATIVE" != "1" ]; then
step "Installing dependencies"
bun install
ok "Dependencies installed"

# --- icon --------------------------------------------------------------------

step "Generating application icon"
bun run scripts/make-icon.ts
fi

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

if [ "$NATIVE" != "1" ]; then
step "Building the interface"
bun run build:view
ok "Interface ready (127.0.0.1, opens in your browser)"
fi

# --- starter bundle ----------------------------------------------------------

if [ -z "$BUNDLE_PATH" ]; then
  BUNDLE_PATH="$HOME/Documents/$APP_NAME"
fi

step "Preparing knowledge bundle at $BUNDLE_PATH"
if [ "$NATIVE" = "1" ]; then
  "$OKF" init-bundle "$BUNDLE_PATH"
else
  bun run scripts/init-bundle.ts "$BUNDLE_PATH"
fi

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

# What the summary reports, so it never claims an icon that was not made.
SHORTCUT="skipped"

if [ "$NO_SHORTCUT" = "0" ]; then
  step "Creating Desktop launcher"

  if [ "$(uname -s)" = "Darwin" ] && [ -d "$DESKTOP" ]; then
    LAUNCHER="$DESKTOP/$APP_NAME.command"
    {
      printf '#!/usr/bin/env bash\n'
      printf 'exec %s\n' "$(quote "$LAUNCH_SCRIPT")"
    } > "$LAUNCHER"
    chmod +x "$LAUNCHER"
    ok "$LAUNCHER"
    SHORTCUT="$LAUNCHER"
  elif [ "$(uname -s)" = "Darwin" ]; then
    warn "Desktop が見つからないため、アイコンは作りませんでした"
  else
    # Freedesktop .desktop entry, in the app menu always and on the Desktop
    # when there is one — servers, WSL and some tiling desktops have none, and
    # the menu entry is still how a launcher finds the app.
    #
    # Exec points straight at the launcher script. A .desktop value has its own
    # escaping rules on top of the shell's, so the fewer levels of quoting it
    # carries the better: only the backslash and double quote need escaping for
    # the field itself.
    APPS_DIR="$HOME/.local/share/applications"
    mkdir -p "$APPS_DIR"
    LAUNCHER="$APPS_DIR/okf-wiki.desktop"
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
    ok "$LAUNCHER"
    SHORTCUT="$LAUNCHER"

    if [ -d "$DESKTOP" ]; then
      cp "$LAUNCHER" "$DESKTOP/okf-wiki.desktop"
      chmod +x "$DESKTOP/okf-wiki.desktop"
      # Newer GNOME refuses to run a .desktop file it does not trust.
      if command -v gio >/dev/null 2>&1; then
        gio set "$DESKTOP/okf-wiki.desktop" metadata::trusted true 2>/dev/null || true
      fi
      ok "$DESKTOP/okf-wiki.desktop"
      SHORTCUT="$DESKTOP/okf-wiki.desktop"
    else
      note "Desktop が無いため、アプリメニューにだけ登録しました"
    fi
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
if if [ "$NATIVE" = "1" ]; then "$OKF" mcp-config --bundle "$BUNDLE_PATH"; else bun run src/bun/cli/main.ts mcp-config --bundle "$BUNDLE_PATH"; fi > "$MCP_TMP"; then
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
  if if [ "$NATIVE" = "1" ]; then "$OKF" connect-agent --all "$BUNDLE_PATH"; else bun run scripts/connect-agent.ts --all "$BUNDLE_PATH"; fi; then
    CONNECTED="done"
  else
    warn "Some runtimes could not be connected — see the messages above"
  fi
fi

step "Done"
echo
printf '  Bundle    : %s\n' "$BUNDLE_PATH"
printf '  Launcher  : %s\n' "$SHORTCUT"
printf '  MCP config: %s\n' "$MCP_PATH"
echo
printf '  Start it:   cd %s && ./%s ui\n' "$PROJECT_ROOT" "$APP_NAME"
printf '  Update it:  bash UPDATE.command\n'
printf '  Remove it:  bash UNINSTALL.command\n'
echo

if [ -z "$CONNECTED" ]; then
  note "To register this bundle with Claude Code, Codex, opencode and friends:"
  note "  bash scripts/setup.sh --connect"
  note "Or merge mcp-config.json into an agent's MCP settings by hand."
fi
note "Agents should call read_map first."
echo
