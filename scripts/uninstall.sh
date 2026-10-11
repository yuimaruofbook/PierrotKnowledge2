#!/usr/bin/env bash
#
# Remove PierrotKnowledge2 from macOS or Linux.
#
# Shows a plan and stops. Nothing is deleted without --apply (or a yes to the
# question --confirm asks, which is what UNINSTALL.command passes),
# because the question anyone uninstalling this has is "will it take my notes
# with it" and the answer has to be visible before agreeing to anything.
#
# Your knowledge bundle is never touched. It is ordinary Markdown in an
# ordinary folder outside this directory, and the plan names it as a survivor.
#
#   bash scripts/uninstall.sh              show the plan
#   bash scripts/uninstall.sh --confirm    show the plan, ask, carry it out
#   bash scripts/uninstall.sh --apply      carry it out
#   bash scripts/uninstall.sh --apply --purge-settings   also drop settings

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v bun >/dev/null 2>&1; then
  # A fresh Bun install is not on PATH until the shell restarts, and someone
  # uninstalling may be in exactly that shell.
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "Bun が見つかりません。" >&2
    echo "アプリのフォルダを削除するだけでもアンインストールはほぼ完了しますが、" >&2
    echo "エージェント各ツールの設定に残ったエントリは手で消す必要があります。" >&2
    exit 1
  fi
fi

exec bun run src/bun/cli/main.ts uninstall "$@"
