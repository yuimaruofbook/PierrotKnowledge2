#!/usr/bin/env bash
#
# One-line install for PierrotKnowledge2 on macOS and Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/yuimaruofbook/PierrotKnowledge2/main/install.sh | bash
#
# The whole application is one binary. This downloads the one for this
# machine from the latest release, checks it against the digest GitHub
# recorded, puts it in ~/.local/share/PierrotKnowledge2 (OKF_INSTALL_DIR
# overrides) and runs `okf setup`. No Rust, no Bun, no build, nothing to unzip.
# Run it again later and it updates instead.
#
# Setup's options pass through:  curl ... | bash -s -- --connect --bundle PATH

set -euo pipefail

REPO="yuimaruofbook/PierrotKnowledge2"
DIR="${OKF_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/PierrotKnowledge2}"
OKF="$DIR/okf"

die() { echo "  $1" >&2; exit 1; }

# Already installed: this is an update. It asks once, and under `curl | bash`
# stdin is this script, so the answer has to come from the terminal.
if [ -x "$OKF" ]; then
  if [ -t 0 ]; then exec "$OKF" update --confirm; fi
  # Opened, not tested with -r: without a controlling terminal it exists and still fails.
  (exec </dev/tty) 2>/dev/null || die "更新には端末が必要です: \"$OKF\" update --apply"
  exec "$OKF" update --confirm </dev/tty
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)              plat=macos-arm64 ;;
  Darwin-x86_64)             plat=macos-x64 ;;
  Linux-x86_64)              plat=linux-x64 ;;
  Linux-aarch64|Linux-arm64) plat=linux-arm64 ;;
  *) die "$(uname -s)-$(uname -m) 向けのビルド済みバイナリはありません。リリースの zip を展開して bash SETUP.command を実行してください。" ;;
esac
name="okf-$plat"
command -v curl >/dev/null 2>&1 || die "curl が必要です。"

# No jq on a stock machine. In GitHub's JSON an asset's name comes before its
# digest, and its download URL after both. awk reads to the end: exiting early
# can SIGPIPE grep, and pipefail would then discard the answer.
found="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oE '"(name|digest|browser_download_url)": *"[^"]*"' \
  | awk -F'"' -v want="$name" '
      $2 == "name" { hit = ($4 == want) }
      $2 == "digest" && hit { digest = $4 }
      $2 == "browser_download_url" && hit && digest != "" && out == "" { out = digest " " $4 }
      END { print out }')" || found=""
[ -n "$found" ] || die "最新リリースに $name が見つかりません。"
digest="${found%% *}"
url="${found#* }"

mkdir -p "$DIR"
staged="$OKF.download"
trap 'rm -f "$staged"' EXIT

echo "  ダウンロード中: $url"
curl -fsSL -o "$staged" "$url" || die "ダウンロードできませんでした。"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$staged" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$staged" | cut -d ' ' -f 1)"
fi
[ "sha256:$actual" = "$digest" ] || die "ハッシュが一致しません（破損または改ざんの可能性）。"

chmod +x "$staged"
# The digest proves it is the published file, not that it runs here.
OKF_BUNDLE='' "$staged" help >/dev/null 2>&1 || die "$name がこのマシンで起動しません。"
mv -f "$staged" "$OKF"

echo "  インストール先: $OKF"
"$OKF" setup "$@"
