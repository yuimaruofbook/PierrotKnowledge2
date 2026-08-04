# Open Knowledge Format (OKF) v0.2 解説

[English](../en/okf.md) · 日本語

仕様原文: [OKF SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)（2026-08-01 に取得して照合）

---

## 1. OKF とは何か

**ディレクトリツリーに置かれた Markdown ファイルの集まりを、知識ベースとして扱うための最小限の取り決め**です。

独自のデータベースも、専用ビューアも、ロックインもありません。必要なのは以下だけです。

- ファイルは Markdown
- 概念ファイルは YAML frontmatter を持つ
- frontmatter には `type` がある

**これだけで完全準拠します。** 仕様は繰り返しこう述べています——«a concept carrying just `type` is fully conformant»。

### 何を解決するのか

知識ベースの形式は普通、次のどちらかに寄ります。

| 寄り方 | 問題 |
|--------|------|
| 厳格すぎるスキーマ | 書くのが億劫になり、結局使われない |
| 何も決めない Markdown 置き場 | 機械が構造を読めず、道具が作れない |

OKF は「**必須は1つだけ、それ以外は任意**」という位置に立ちます。人間が手で書ける軽さを保ったまま、機械が最低限の足場（型・リンク・出典）を得られます。

---

## 2. バンドル構造

**バンドル**とは、Markdown ファイルを含むディレクトリツリーです。

```
バンドルルート/
  index.md            (任意・予約)
  log.md              (任意・予約)
  <概念>.md
  <サブディレクトリ>/
    index.md
    <概念>.md
```

`index.md` と `log.md` は**予約ファイル**です。それ以外の `.md` はすべて**概念ドキュメント**です。

配布形式は git リポジトリ（推奨。履歴・帰属・差分が得られるため）、tar/zip、あるいは大きなリポジトリの一部分でも構いません。

### 本アプリでのバンドルルート

> **重要**: 本アプリでは **`wiki/` ディレクトリが OKF バンドルルート**です。
>
> ```
> my-knowledge/          ← アプリが開くフォルダ
> ├── AGENTS.md          ← エージェント契約（OKF 対象外）
> ├── raw/               ← 不変ソース（OKF 対象外）
> ├── wiki/              ← ★ここが OKF バンドルルート★
> │   ├── index.md
> │   ├── log.md
> │   └── **/*.md
> └── .rag/              ← 派生インデックス（OKF 対象外）
> ```
>
> `raw/` と `.rag/` はバンドルの外側にある兄弟ディレクトリであり、OKF の規定対象ではありません。この配置の理由は [LLM Wiki パターン](llm-wiki.md) を参照してください。
>
> `wiki/` が存在しないフォルダを開いた場合は、そのフォルダ自体がバンドルルートになります。

---

## 3. 概念ドキュメント

### 概念 ID

> «The path of the concept's file within the bundle, with the `.md` suffix removed.»

`tables/customers.md` → 概念 ID は `tables/customers`。

本アプリでは `wiki/topics/foo.md` → `topics/foo` となります（バンドルルートが `wiki/` のため）。

### frontmatter

**必須は `type` のみ**です。

```yaml
---
type: Concept
---
```

`type` は自由文字列です。仕様は値を列挙しません。消費者は**未知の `type` を理由に拒否してはなりません**。用途に応じて `Concept` / `Entity` / `Summary` / `Playbook` / `Note` / `Decision` など自由に設計してください。

### 推奨フィールド

| フィールド | 内容 |
|-----------|------|
| `title` | 表示名 |
| `description` | 一行要約 |
| `resource` | 正典 URI |
| `tags` | 分類のリスト |

---

## 4. 予約ファイル

### `index.md`（§8）

ディレクトリの内容を列挙し、**progressive disclosure**（段階的な開示）を支えます。読み手は個々のページを開く前に全体の形を把握できます。

- **frontmatter を持たない。** 唯一の例外は、**バンドルルートの `index.md` が `okf_version` を持てる**こと
- 本文は 1 つ以上のセクションからなり、各セクションが見出しで概念をグループ化する
- 項目の形式は `* [Title](url) - short description`
- 説明はリンク先 frontmatter の `description` を使うことが推奨される
- 生成は任意。無ければ消費者がその場で合成してもよい

本アプリの生成例:

```markdown
---
okf_version: 0.2
---

# My Knowledge

## Concepts

* [設計原則](/design.md) - このプロジェクトの設計判断の根拠

## topics

* [RAG構成](/topics/rag.md) - 検索と取得の仕組み
```

リンクは**バンドル絶対形式**（`/design.md`）を使います。仕様が推奨する形式で、文書がディレクトリ内で移動しても壊れません。

### `log.md`（§9）

変更履歴を記録します。**日付でグループ化し、新しい順**に並べます。

- 日付見出しは **ISO 8601 の `YYYY-MM-DD`** 形式が必須
- 項目は散文。先頭の太字（`**Update**`, `**Creation**`, `**Deprecation**`）は慣習であって要件ではない

本アプリの生成例:

```markdown
# Log

## 2026-08-01

* **Creation**: `wiki/topics/rag.md` by process:claude-code.
* **Update**: `wiki/design.md` by human:kn.

## 2026-07-31

* **Move**: `wiki/old.md → wiki/new.md` by human:kn. 3 link(s) updated
```

> **設計上のトレードオフ**: 新しい順という要件のため、追記（O(1)）ではなく読み書き（ファイルサイズに比例）になります。人間が読める形式であることの対価として受け入れています。

---

## 5. 相互リンク（§6）

2 つの形式があります。

| 形式 | 例 | 解釈 |
|------|-----|------|
| **絶対**（推奨） | `[customers](/tables/customers.md)` | バンドルルートから |
| **相対** | `[neighbour](./other.md)` | 標準の Markdown 相対パス |

仕様は絶対形式を推奨します。«it is stable when documents are moved within their subdirectory»（サブディレクトリ内で文書が移動しても安定するため）。

### リンク切れは正常です

> «Consumers MUST tolerate broken links: a link whose target does not exist in the bundle is not malformed; it may simply represent not-yet-written knowledge.»

本アプリはこれを積極的に活用します。未解決リンクは**知識の欠落の可視化**であり、そこからページを作る導線になっています。

### 本アプリの拡張: ウィキリンク

`[[id]]` / `[[id|表示名]]` に対応します。OKF の規定外ですが、**同じ ID 空間に解決**されるため、リンクグラフは統一されます。ファイルに書かれるのは標準 Markdown か `[[...]]` のどちらかで、どちらも仕様の許す範囲です。

---

## 6. 出典・信頼・ライフサイクル（§5）

すべて**任意**です。無くても完全に消費可能です。

### `sources`（§5.1）

```yaml
sources:
  - id: q3-report
    resource: /raw/q3-2026.pdf
    title: 2026 Q3 決算資料
    author: human:finance-team
    usage_count: 14
    last_modified: 2026-07-15
usage_window: { from: 2026-04-01, to: 2026-06-30 }
```

| キー | 必須 | 内容 |
|------|------|------|
| `resource` | **必須** | 辿れる成果物（URL・バンドル相対パス）または対象範囲の記述 |
| `id` | 任意 | 個々の主張を帰属させる安定キー |
| `title` | 任意 | 人間向けラベル |
| `author` | 任意 | 誰が作ったか（Actor 規約） |
| `usage_count` | 任意 | `usage_window` 内で何回使われたか |
| `last_modified` | 任意 | 出典自体の最終更新日 |

主張単位の帰属は Markdown の脚注を使い、`sources[].id` をラベルにします。

> 本アプリは `sources` を**保持しますが解釈しません**（脚注との突合は未実装）。

### `generated` / `verified`（§5.2）

```yaml
generated:
  by: process:claude-code    # 必須
  at: 2026-08-01T10:00:00Z   # 任意
verified:
  - by: process:ci
    at: 2026-08-01T11:00:00Z
  - by: human:kn
    at: 2026-08-02T09:00:00Z
```

- `generated` — 内容が**どう作られたか**
- `verified` — 出典に照らして**確認されたか**

両者は独立です。内容は再確認なしに変わりうるし、事実は再生成なしに再確認されうるためです。

> 単一の検証者はリストのダッシュ無しで書けます。**消費者は素のマッピングを 1 要素のリストとして扱わなければなりません**（MUST）。本アプリは対応済みです。

### 信頼ティア（§5.3）

`verified` から導出されます。

| 条件 | ティア |
|------|--------|
| `verified` が無い | **unverified** |
| `human:` 以外の actor のみ | **machine-confirmed** |
| `human:<id>` が含まれる | **human-reviewed** |

> «Trust tiers are advisory signals, not access control.»
> 信頼情報が無い概念も消費可能です。拒否してはなりません。

> 本アプリは導出ロジックを実装済みですが、**UI へのバッジ表示は未接続**です。

### `status`（§5.4）

| 値 | 意味 |
|----|------|
| `draft` | 未レビュー。不完全かもしれない |
| `stable` | **既定。** 消費してよい |
| `deprecated` | リンクと履歴のために残す。最新ではない |

`status` が無ければ `stable` です。

### `stale_after`（§5.5）

**絶対日付**（`YYYY-MM-DD`）です。`today >= stale_after` のとき陳腐化とみなします。

相対 TTL ではなく絶対日付なのは、**いつ読んだかに依存しない単純な日付比較**にするためです。

---

## 7. Actor 規約（§7）

| 種別 | 形式 | 例 |
|------|------|-----|
| エージェント・ツール | `<producer>/<version>` | `reference_agent/gemini-2.5-pro` |
| 人間 | `human:<id>` | `human:kn` |
| 自動処理 | `process:<id>` | `process:finance-nightly` |

> 信頼を分類する消費者は `human:` 接頭辞を手がかりにします。したがって**手書き・人間確認済みの内容には `human:` を使わなければなりません**（MUST）。

本アプリは UI 操作を `human:local`、MCP 経由を `process:mcp`（ツール引数 `actor` で上書き可）として記録します。

---

## 8. 適合条件（§11）

バンドルが OKF v0.2 に**適合する**のは、次のすべてを満たすときです。

1. ツリー内のすべての非予約 `.md` が、解析可能な YAML frontmatter ブロックを持つ
2. すべての frontmatter が**非空の `type`** を持つ
3. 予約ファイル（`index.md` / `log.md`）が存在する場合、§8 / §9 の構造に従う

### 消費者がしてはならないこと

仕様は消費者の**拒否**を強く制限します。以下を理由にバンドルを拒否してはなりません（MUST NOT）。

- 任意の frontmatter フィールドの欠落
- 未知の `type` 値
- 未知の追加キー
- リンク切れ
- `index.md` の欠落

つまり **OKF は寛容側に倒した設計**です。厳しさは書き手ではなく、読み手の耐性に置かれています。

---

## 9. 本アプリでの実装状況

| § | 内容 | 状態 |
|---|------|------|
| 3 | バンドル構造 | ✅ |
| 4 | 概念ドキュメント / ID | ✅ |
| 5.1 | `sources` | ⚠️ 保持のみ（脚注帰属は未実装） |
| 5.2 | `generated` / `verified` | ✅ bare mapping 対応済み |
| 5.3 | 信頼ティア | ⚠️ 導出は実装、UI 表示は未接続 |
| 5.4 | `status` | ✅ |
| 5.5 | `stale_after` | ✅ |
| 6 | 相互リンク | ✅ 絶対・相対の両形式、リンク切れ許容 |
| 7 | Actor 規約 | ✅ |
| 8 | `index.md` | ✅ ルートに `okf_version: 0.2` |
| 9 | `log.md` | ✅ |
| 10 | Attested computations | ❌ 未実装 |
| 11 | 適合条件 | ✅ |
| 12 | バージョニング | ✅ |

条文別の詳細と、監査で発見・修正した 5 件の非準拠は [準拠状況](../CONFORMANCE.md) を参照してください。

---

## 10. よくある疑問

**Q. `type` には何を書けばいいですか？**
自由です。仕様は値を定めません。小さく始めて（`Note` / `Concept`）、必要になったら増やすのが実際的です。既存の値は `list_tags` で確認できます。

**Q. frontmatter を書き忘れたら？**
アプリは**保存を拒否しません**。ステータスバーに警告を出し、「N 非準拠」として集計します。§11 が拒否を禁じているためです。

**Q. `index.md` は手で書いてもいい？**
構いません。ただし「再構築」を実行すると再生成され上書きされます。手で維持したい場合は再構築を使わないでください。

**Q. OKF と Obsidian の Markdown は互換ですか？**
frontmatter と標準リンクは互換です。`[[wikilink]]` も本アプリは解決します。Obsidian 固有の記法（埋め込み `![[...]]`、Dataview クエリなど）は解釈しません。

**Q. `.rag/` を消しても大丈夫？**
はい。派生物です。「再構築」で復元します。

---

## 関連ドキュメント

- [使い方ガイド](usage.md)
- [LLM Wiki パターン](llm-wiki.md) — 3 層構造の理由
- [活用方法](workflows.md)
- [準拠状況](../CONFORMANCE.md) — 条文別の監査
