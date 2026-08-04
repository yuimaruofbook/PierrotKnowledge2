---
name: okf-ingest
description: raw/ に置いた資料を wiki/ の概念ページに整理する手順。議事録・エクスポート・書き起こし・PDF を取り込むとき、または「取り込んで」「整理して」と頼まれたときに使う。
when: [取り込み, 整理, ingest, 議事録, エクスポート, 書き起こし, 資料]
tags: [ingest, workflow]
allowed-tools: [read_agents_md, search, read_file, create_concept, write_file, rebuild_index]
---

# 資料を知識にする

`raw/` にあるのは**原本**であって知識ではありません。この手順は、原本を読んで
`wiki/` の概念ページに変換します。

## 原則

**1 資料 = 1 ページにしない。** 1 つの議事録が 10 ページに触れて構いません。
資料ごとにページを作るのは、ファイルを置き換えただけで知識化ではありません。
**エンティティ・概念・決定事項**の単位で切り出してください。

**raw/ は絶対に書き換えない。** 書き込みは拒否されますが、そもそも試みないでください。

## 手順

1. `read_agents_md` でこのバンドルの規約を確認する。
2. 対象を `read_file` で読む。
3. **書く前に `search` で既存ページを探す。** 重複を作らないこと。
   既にあるなら新規作成ではなく追記です。
4. 資料から切り出す単位を決める。次を目安にする:
   - 登場する**人・組織・製品** → Entity
   - 繰り返し出てくる**考え方** → Concept
   - **決まったこと**とその理由 → Decision
   - **手順** → Playbook
5. 新規ページは `create_concept` で作る（frontmatter が必ず正しくなる）。
   既存ページへの追記は `write_file`。
6. ページ同士を `[[wikilink]]` で相互参照する。
7. **まだ書いていない概念にもリンクを張る。** 未解決リンクは欠落知識の可視化であり、
   次の取り込みの計画になります。
8. 出典を frontmatter の `sources` に残す（下記）。
9. 最後に `rebuild_index`。

## 出典の書き方

```yaml
---
type: Summary
title: 2026年Q3 レビュー要点
sources:
  - id: q3-review
    resource: /raw/2026-q3-review.md
    title: Q3 レビュー議事録
    last_modified: 2026-07-15
---
```

後から「この主張はどこから来たのか」を辿れるようにするためです。

## 終わったら

- `check_conformance` で非準拠が増えていないか確認する。
- `unresolved_links` を見て、次に書くべきページを把握する。

より詳しい型の設計指針は `reference.md` にあります（必要なときだけ読んでください）。
