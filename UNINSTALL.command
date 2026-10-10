#!/usr/bin/env bash
# ============================================================================
#  PierrotKnowledge2 - アンインストール (macOS / Linux)
#
#  macOS: このファイルをダブルクリックしてください。
#  Linux: bash UNINSTALL.command を実行してください。
#
#  まず「何が消えて、何が残るか」を表示します。この時点では何も消しません。
#  知識バンドル（ノート）は削除対象に入りません。
# ============================================================================

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

echo
echo "  PierrotKnowledge2 - アンインストール"
echo "  ============================================"
echo

bash scripts/uninstall.sh "$@" || status=$?

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
