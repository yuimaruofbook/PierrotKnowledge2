# SYSTEMMAP — システムの全体像と拡張のしかた

MAP.md が「いま必要なものはどこか」を答える経路表なのに対し、これは
**「この仕組みは何でできていて、どう広げられるか」**の地図です。毎回読むものではなく、
構造を変える前・新しい種類の知識を足す前に読みます。

## 層とフォルダ

```
bundle-root/
├── MAP.md · SYSTEMMAP.md · human.md · Task.md   ← 層の外。方向づけ
├── raw/        Layer 1: 人間の受信箱。原本。エージェントは書けない
├── wiki/       Layer 2: 正典。人間もエージェントも読み書きする
│   ├── 1-projects/ 2-areas/ 3-resources/ 4-archive/   PARA（優先順位）
│   ├── skills/     手順（概念ではない）  skills/<カテゴリ>/<名前>/SKILL.md
│   ├── loops/      繰り返す作業の設計と履歴（概念ではない）
│   ├── knowhow/    エージェントが残す短い学び（概念）
│   ├── activity/   保存した活動サマリ（概念）
│   ├── daily/      デイリーノート（概念）
│   ├── bases/      一覧・集計ビュー .base（概念ではない。Obsidian Bases と同形式）
│   ├── graph/      知識グラフの設計
│   │   ├── schema.md      概念の型と関係の種類の宣言（型 GraphSchema）
│   │   └── canvases/      関係図 .canvas（概念ではない。JSON Canvas 1.0）
│   ├── AGENTS.md   規約  index.md / log.md  OKF の予約ファイル
└── .rag/       Layer 3: 派生の検索索引。消しても再構築できる
```

## ツールの群

| 群 | ツール | 使いどころ |
|---|---|---|
| 知識を読む | `retrieve` `context_pack` `search` `read_file` `list_concepts` `backlinks` | 質問に答える・探す |
| 知識を書く | `create_concept` `write_file` `move_file` `delete_file` | 概念を足す・直す |
| 方向づけ | `read_map` `system_map` `read_human` `list_tasks` `add_task` | 作業の入口 |
| PARA・ライフサイクル | `list_para` `set_para` `set_lifecycle` | 優先度と DEAD |
| スキル・ノウハウ | `skill_find` `skill_open` `knowhow_find` `knowhow_add` | 手順と学び |
| ベース | `base_list` `base_query` `base_write` | 一覧・件数・集計 |
| 関係図 | `canvas_list` `canvas_read` `canvas_write` `canvas_from_links` `graph_schema` | 関係を図にする・型を知る |
| ループ | `loop_start` `loop_note` `loop_end` `loop_define` | 作業の前後の記録 |
| 点検 | `check_conformance` `unresolved_links` `audit_changes` | 非準拠・警告・未解決 |

## どこに何を置くか

- **ベース** — 同じ一覧・集計を何度も聞くなら `wiki/bases/*.base`。
- **キャンバス** — 関係を目で見たいなら `wiki/graph/canvases/*.canvas`。`canvas_from_links` が
  概念のまわりを自動で配置します。Obsidian でそのまま開けます。
- **スキル** — 手順が決まっている作業は `wiki/skills/`。
- **ループ** — 繰り返す作業の型は `wiki/loops/`。
- **ノウハウ** — 非自明な発見は `knowhow_add`（`wiki/knowhow/`）。
- **型付き関係** — 概念の frontmatter の `relations`。バックリンクや未解決リンクにも数えられます。

## 拡張のしかた

構造を足すときは、まず**宣言**（スキーマ）、次に**使う**、最後に**この地図を更新**の順です。

1. **概念の型を足す** — `wiki/graph/schema.md` の `types` に `name`（と `description`）を足し、
   概念の `type:` に使う。宣言にない型は `graph_schema` の `warnings` に出ます（エラーではない）。
2. **関係の種類を足す** — `schema.md` の `kinds` に `name`・`description`、任意で `from` / `to`
   （許す型）を足し、概念の frontmatter に `relations: { <種類>: [パスまたは [[リンク]]] }` と書く。
3. **ベースを足す** — `base_write` で `wiki/bases/<名前>.base`。書き方は `base_write` の説明。
4. **キャンバスを足す** — `canvas_from_links`（自動）か `canvas_write`（手書き JSON Canvas）。
   置き場所は `wiki/` の下ならどこでもよく、既定は `wiki/graph/canvases/`。
5. **スキル・ループを足す** — `wiki/skills/<カテゴリ>/<名前>/SKILL.md`、`loop_define`。
6. **MCP ツールを足す** — ソースの `src/bun/mcp/tools.ts`（定義と処理）と、Rust 版
   `rust/src/mcp/tools.rs`（定義は `tools.json` を TS から再生成）。両方を同じ出力に保つ。
7. **この地図を更新する** — 上の 1〜6 のあと、`system_map { refresh: true }`。

## 現在の状態

下の枠は自動生成です。
