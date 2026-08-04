# 準拠状況 — OKF v0.2 と LLM Wiki パターン

対象仕様: [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)（2026-08-01 に取得して照合）

このドキュメントは自己申告ではなく、**仕様原文と実装・テストの対応表**です。
各行の「検証」列はテストファイル名を指します。

---

## 1. バンドルの範囲 — 重要な前提

OKF の「バンドルルート」は本アプリでは **`wiki/` ディレクトリ**です。

```
my-knowledge/          ← アプリが開くフォルダ（LLM Wiki のワークスペース）
├── AGENTS.md          ← エージェント契約（OKF 対象外）
├── raw/               ← Layer 1（OKF 対象外）
├── wiki/              ← ★ここが OKF バンドルルート★
│   ├── index.md       ← §8 予約ファイル
│   ├── log.md         ← §9 予約ファイル
│   └── **/*.md        ← §4 概念ドキュメント
└── .rag/              ← 派生インデックス（OKF 対象外・正典パターンにも無い追加物）
```

したがって概念 ID は **`wiki/` からの相対パス**です（`wiki/topics/foo.md` → `topics/foo`）。
これは §2 の «The path of the concept's file within the bundle, with the `.md`
suffix removed» に一致します。`raw/` と `.rag/` はバンドルの外側にある兄弟
ディレクトリであり、OKF の規定対象ではありません。

`wiki/` が存在しないフォルダを開いた場合は、そのフォルダ自体をバンドルルートと
みなします（既存の Markdown フォルダをそのまま開けるようにするため）。

---

## 2. §11 適合条件（規範）

| # | 仕様の要求 | 実装 | 検証 |
|---|-----------|------|------|
| 1 | 非予約 `.md` はすべて解析可能な YAML frontmatter を持つ | `checkConformance` が検出し、UI とMCPに報告 | `okf-shared.test.ts` |
| 2 | frontmatter に非空の `type` が必須 | 同上。`create_concept` は構造上違反不能 | `okf-shared.test.ts`, `mcp.test.ts` |
| 3 | 予約ファイルは §8 / §9 の構造に従う | `renderIndexMd` / `insertLogEntry` が仕様形式で生成 | `reserved.test.ts` |

### 消費者側の禁止事項（MUST NOT）

| 仕様 | 実装 | 検証 |
|------|------|------|
| 任意フィールド欠落を理由に**拒否してはならない** | `type` のみの概念は完全準拠として扱う | `okf-shared.test.ts` |
| 未知の `type` 値で拒否してはならない | `type` は自由文字列。列挙で検証しない | `okf-shared.test.ts` |
| 未知の追加キーで拒否してはならない | round-trip で保持。検証もしない | `okf-shared.test.ts` |
| リンク切れで拒否してはならない | 未解決は `resolved: null`。エラーではない | `okf-shared.test.ts` |
| `index.md` 欠落で拒否してはならない | 任意。無ければ生成を提案するのみ | `workspace.test.ts` |
| bare `verified` マッピングは1要素リストとして扱う | `deriveTrustTier` が配列化 | `okf-shared.test.ts` |

---

## 3. 各セクションの対応

| § | 内容 | 状態 | 備考 |
|---|------|------|------|
| 3 | バンドル構造 | ✅ | 予約ファイル2種を認識・生成 |
| 4 | 概念ドキュメント / ID | ✅ | ID = バンドル相対パス − `.md` |
| 5.1 | `sources` | ⚠️ 保持のみ | round-trip 保持。脚注による claim 単位帰属は未実装 |
| 5.2 | `generated` / `verified` | ✅ | `create_concept` が `generated` を付与。bare mapping 対応 |
| 5.3 | 信頼ティア | ✅ | `deriveTrustTier`（`human:` 接頭辞で判定）※UI 表示は未実装 |
| 5.4 | `status` | ✅ | 既定 `stable`。UI にバッジ表示 |
| 5.5 | `stale_after` | ✅ | `today >= stale_after` の日付比較 |
| 6 | 相互リンク | ✅ | 絶対形式 `/path.md` と相対形式の両方。リンク切れ許容 |
| 7 | Actor 規約 | ✅ | `human:` / `process:` / `producer/version` |
| 8 | `index.md` | ✅ | 見出し＋箇条書き。ルートのみ `okf_version` |
| 9 | `log.md` | ✅ | `## YYYY-MM-DD` 日付グループ、新しい順、散文 |
| 10 | Attested computations | ❌ 未実装 | 任意機能。将来対応 |
| 12 | バージョニング | ✅ | ルート `index.md` に `okf_version: 0.2` |

---

## 4. 監査で発見し修正した非準拠（2026-08-01）

仕様原文と照合した結果、**5 件の実際の違反**が見つかりました。いずれも修正済みです。

| # | 内容 | 修正前 | 修正後 |
|---|------|--------|--------|
| 1 | `index.md` 形式 | Markdown **テーブル** | §8 の見出し＋`* [Title](url) - desc` |
| 2 | `log.md` 形式 | フラットなテーブル、古い順の追記 | §9 の `## YYYY-MM-DD` グループ、**新しい順** |
| 3 | リンク解決の優先順 | 相対リンクをバンドル絶対として先に解決 | §6 に従い、`/` 始まりのみ絶対 |
| 4 | 準拠判定 | ルート `index.md` の `okf_version` を**違反と誤判定** | §8 の例外として許可（ルート・当該キーのみ） |
| 5 | `stale_after` | インスタント比較、TTL も想定 | §5.5 の `today >= stale_after` 日付比較 |

> 2 の副作用: 新しい順は追記ではなく read-modify-write になります。O(1) 追記より
> 高コストですが、仕様が定める「人が読める形式」の対価です。

---

## 5. LLM Wiki パターン

| 原則 | 実装 | 強制点 |
|------|------|--------|
| Layer 1 `raw/` は不変、AI は読み取り専用 | `assertWritable` が拒否 | 解決済み絶対パスで判定。`./raw/x`・`raw\x`・`wiki/../raw/x` すべて遮断 |
| Layer 2 `wiki/` が正本、人間と AI が読み書き | UI も MCP も同一の `Workspace` を経由 | 書き込み経路・層検査・ログ・索引更新は1箇所のみ |
| `.rag/` は派生、再構築可能（**本アプリ独自の追加層**） | 書き込み拒否。削除しても `rebuild_rag` で復元 | スキーマ版が変われば自動再構築 |
| 人間と AI の対称性 | ファイル監視で外部変更を即時反映 | エージェントの書き込みが開いているエディタに反映される |
| `AGENTS.md` を最初に読ませる | `read_agents_md` を第一ツールとして提示 | `initialize` の `instructions` でも明示 |

検証: `fileops.test.ts`, `workspace.test.ts`, `mcp.test.ts`, `paths.test.ts`

---

## 6. RAG としての設計

OKF は検索方式を規定しません。以下は本アプリの設計判断です。

| 要素 | 方針 | 理由 |
|------|------|------|
| 検索単位 | **見出し単位のチャンク** | 文書全体では無関係な本文が大半を占め、文脈枠を圧迫する |
| 引用 | `topics/foo.md#見出し` | 人間が同じファイルを開いて検証・修正できる（File over App） |
| 日本語 | CJK バイグラム索引 | `unicode61` は分かち書き不可、`trigram` は2文字語不可 |
| ランキング | BM25（タイトル12倍 / 見出し4倍 / 本文1倍） | 人がウィキを走査する順序に対応 |
| 照合モード | `search`=フレーズ / `retrieve`=緩いOR | 質問は言い換えであり、用語の完全一致ではない |
| 誤検出抑制 | 内容語2語以上の一致を要求 | 助詞のみのバイグラムを根拠から除外 |
| 埋め込み | **使わない** | モデル・APIキー・ベクトルストアの重量に見合わない |

**正直な限界**: 語彙が重ならない言い換えは検索できません。これは BM25 の性質で
あり、意味理解ではありません。だからこそ `retrieve` は「見つからない」と言うか、
最良の語彙一致を**引用付きで**返してエージェントに判断させます。

検証: `rag.test.ts`, `text.test.ts`

---

## 7. 未実装・既知の差異

| 項目 | 状態 | 影響 |
|------|------|------|
| §10 Attested computations | 未実装 | 任意機能。計算の再現性検証が必要になったら対応 |
| §5.1 脚注による claim 単位の出典帰属 | 未実装 | `sources` は保持するが、脚注ラベルとの突合は行わない |
| 信頼ティアの UI 表示 | 未実装 | `deriveTrustTier` は実装済み。バッジ表示が未接続 |
| ネストした `index.md` / `log.md` | 未生成 | 仕様上は任意（MAY）。ルートのみ自動生成 |
