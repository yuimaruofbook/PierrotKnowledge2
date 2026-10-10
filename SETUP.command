#!/usr/bin/env bash
# ============================================================================
#  OKF Wiki - ワンタッチ セットアップ (macOS / Linux)
#
#  ダウンロードした直後は、ターミナルで次を実行してください:
#
#      bash SETUP.command
#
#  zip は Windows で作られており Unix の実行権限を持たないため、初回は
#  ダブルクリックできません。上のコマンドは権限を必要とせず、実行後は
#  ダブルクリックでも起動できるようになります（macOS の隔離属性も解除します）。
#
#  実行される内容:
#    1. 実行権限の復元と、macOS の隔離属性の解除
#    2. Bun の確認とインストール
#    3. 依存関係のインストール
#    4. アプリアイコンの生成
#    5. アプリのビルド
#    6. 知識バンドルの作成 (既定: ~/Documents/PierrotKnowledge2)
#    7. デスクトップアイコンの作成
#
#  オプション:
#    bash SETUP.command --connect            エージェント各ツールに登録する
#    bash SETUP.command --bundle PATH        バンドルの作成先を指定する
#    bash SETUP.command --no-shortcut        デスクトップアイコンを作らない
#
#  何度実行しても安全です。既存のファイルは上書きしません。
#  削除するときは UNINSTALL.command を使ってください。
# ============================================================================

set -euo pipefail

# Run from this file's own directory, so double-clicking works from anywhere.
cd "$(dirname "${BASH_SOURCE[0]}")"

echo
echo "  PierrotKnowledge2 - セットアップを開始します"
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
