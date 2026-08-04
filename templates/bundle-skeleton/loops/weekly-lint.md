---
loop: weekly-lint
goal: 知識ベースの健全性を点検して直す
skill: wiki-lint
created: 2026-01-01T00:00:00Z
runs: 0
status: idle
---

# 知識ベースの健全性を点検して直す

## 設計

- ループ名: `weekly-lint`
- 使うスキル: `wiki-lint`
- 完了条件:
  - check_conformance の違反を 0 にした（または直せない理由を記録した）
  - 2 回以上参照されている未解決リンクを一覧にした
  - 重複ページを統合した（削除ではなくリンクを残した）
  - rebuild_index と rebuild_rag を実行した

## 実行履歴

（まだ実行されていません）
