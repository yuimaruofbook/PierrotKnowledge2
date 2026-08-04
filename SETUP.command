#!/usr/bin/env bash
# ============================================================================
#  OKF Wiki - ワンタッチ セットアップ (macOS / Linux)
#
#  macOS: このファイルをダブルクリックしてください。
#  Linux: ./SETUP.command を実行してください。
#
#  実行される内容:
#    1. Bun の確認とインストール
#    2. 依存関係のインストール
#    3. アプリアイコンの生成
#    4. アプリのビルド
#    5. 知識バンドルの作成 (既定: ~/Documents/OKF Wiki)
#    6. デスクトップアイコンの作成
#
#  何度実行しても安全です。既存のファイルは上書きしません。
# ============================================================================

set -euo pipefail

# Run from this file's own directory, so double-clicking works from anywhere.
cd "$(dirname "${BASH_SOURCE[0]}")"

echo
echo "  OKF Wiki - セットアップを開始します"
echo "  ============================================"
echo

if bash scripts/setup.sh "$@"; then
  echo
  echo "  完了しました。デスクトップのアイコンから起動できます。"
else
  status=$?
  echo
  echo "  セットアップが失敗しました (コード ${status})。"
  echo "  上のメッセージを確認してください。"
  exit "$status"
fi

# Double-clicking on macOS opens a Terminal window that would close instantly.
if [ "$(uname -s)" = "Darwin" ] && [ -t 0 ]; then
  echo
  read -r -p "  Enter キーで閉じます… " _
fi
