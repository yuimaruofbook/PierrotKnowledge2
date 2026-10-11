---
type: GraphSchema
title: グラフスキーマ
description: この知識ベースで使う概念の型と関係の種類
tags: [graph]
types:
  - name: Concept
    description: 既定の型。分類前の概念
  - name: Note
    description: 書き留めたメモ
  - name: Entity
    description: 人・組織・製品など、名前のあるもの
  - name: Summary
    description: 資料や会話の要約
  - name: Playbook
    description: 繰り返し使う手順や方針
  - name: Project
    description: 終わりのある取り組み
  - name: Knowhow
    description: エージェントが残した短い学び
  - name: ActivitySummary
    description: 保存した活動サマリ
  - name: Daily
    description: デイリーノート
  - name: GraphSchema
    description: このファイル
kinds:
  - name: related_to
    description: 関連している（向きを問わない緩い関係）
  - name: depends_on
    description: 先に必要とする
  - name: part_of
    description: 全体の一部である
  - name: derived_from
    description: 元になった資料や概念がある
  - name: supersedes
    description: 古い概念を置き換える
---

# グラフスキーマ

この概念は、知識グラフの**設計図**です。frontmatter の `types` と `kinds` に、
使ってよい概念の型と関係の種類を宣言します。

- **宣言にない型・関係は警告になります**（`graph_schema` の `warnings`。エラーではありません）。
  新しい型や関係を使い始めたら、ここに足してください。
- 関係は概念の frontmatter に `relations` で書きます。

```yaml
relations:
  depends_on: [topics/a, "[[b]]"]
  part_of: wiki/1-projects/p.md
```

- `kinds` の各項目は `name`・`description`、任意で `from` / `to`（許す概念の型）を持てます。
- `graph_schema` ツールで機械可読な形を読めます。関係図は `canvas_from_links` で作れます。
