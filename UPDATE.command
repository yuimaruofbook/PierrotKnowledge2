#!/usr/bin/env bash
# ============================================================================
#  PierrotKnowledge2 - ワンタッチ アップデート (macOS / Linux)
#
#  macOS: このファイルをダブルクリックしてください。
#  Linux: bash UPDATE.command を実行してください。
#
#  新しいリリースを確認し、検証とリリースノートの表示のあとで一度だけ確認します。
#  y と答えると更新と再ビルドまで行います。それ以外の答えでは何も変更しません。
#  知識バンドル（ノート）には触れません。
# ============================================================================

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

echo
echo "  PierrotKnowledge2 - アップデート"
echo "  ============================================"
echo

# A fresh Bun install is not on PATH until the shell restarts.
if ! command -v bun >/dev/null 2>&1 && [ -x "$HOME/.bun/bin/bun" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "  Bun が見つかりません。先に SETUP.command を実行してください。" >&2
  status=1
else
  # The source, not build/cli/okf: rebuilding that binary is part of the update.
  bun run src/bun/cli/main.ts update --confirm --rebuild "$@" || status=$?
fi

if [ "${status:-0}" != "0" ]; then
  echo
  echo "  失敗しました (コード ${status})。上のメッセージを確認してください。"
fi

# Double-clicking on macOS opens a Terminal window that would close instantly.
if [ "$(uname -s)" = "Darwin" ] && [ -t 0 ]; then
  echo
  read -r -p "  Enter キーで閉じます… " _
fi

exit "${status:-0}"
