# PierrotKnowledge2
最高に軽量な、OKF v0.2 とLLMwiki準拠のローカル知識ベース。1に比べてセキュリティよりも機能性を重視した設計でコンセプトは「空気のように軽く、どこからでもデータ保存」です。
複数機能の集合体をPierrotKnowledge2とし、RAG機能のOKFwiki、プラグイン管理、圧縮管理の3つで構成しようと思っています。
導入はリリースノートからダウンロードをお願いします。

# OKF Wiki

**最高に軽量な、OKF v0.2 準拠のローカル知識ベース。**

📖 **[ドキュメント一覧 / Documentation](docs/README.md)** —
[使い方](docs/ja/usage.md) ·
[OKF 解説](docs/ja/okf.md) ·
[LLM Wiki パターン](docs/ja/llm-wiki.md) ·
[活用方法](docs/ja/workflows.md)
（[English](docs/en/usage.md)）

Electrobun + Vite + TypeScript で構築。Electron の重さを捨て、Markdown ファイルを
正本にした File-over-App 設計です。

人間のエディタ操作と AI エージェントの MCP 操作は、同じファイル・同じ書き込み経路を
通ります。

---

## 設計原則

| 原則 | 内容 |
|------|------|
| **File over App** | ノートの正本は常にローカル Markdown。アプリはビューア・編集・検索・RAG のフロントエンドに過ぎない |
| **OKF v0.2 準拠** | 階層 Markdown + YAML frontmatter（`type` 必須）、`index.md` / `log.md` 予約、標準リンク |
| **LLM Wiki パターン** | `raw/`（不変）→ `wiki/`（正本）→ `AGENTS.md`（スキーマ）。`.rag/` は本アプリ独自の派生インデックス |
| **人間と AI の対称性** | UI も MCP も同一の `Workspace` を経由する。層チェック・ログ・索引更新は一箇所だけ |
| **最高軽量** | システム WebView + Bun。メインプロセス 322 KB / UI 80 KB（[サイズ](#サイズ)参照） |

---

## アーキテクチャ

```
src/
├── shared/              # 両プロセス共有（I/O なし）
│   ├── okf/             # frontmatter / concept / links / reserved
│   ├── types.ts         # データ型のみ
│   └── rpc-schema.ts    # 型付き RPC 契約
├── bun/                 # メインプロセス
│   ├── okf/             # paths(層と封じ込め) / bundle / parser / scaffold
│   ├── rag/fts.ts       # SQLite FTS5 (BM25)
│   ├── watch.ts         # 外部変更の監視
│   ├── workspace.ts     # アプリ中核
│   ├── rpc.ts           # RPC ハンドラ
│   └── mcp/             # tools / stdio / standalone
└── mainview/            # WebView UI (Vanilla TS + Vite)
    ├── markdown.ts      # サニタイズ付きレンダラ
    └── ui/              # tree / editor / search
```

詳細は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

### 知識バンドルの形

```
my-knowledge/
├── AGENTS.md          # スキーマ層。エージェントは最初にこれを読む
├── raw/               # Layer 1 — 不変ソース（書き込み拒否）
├── wiki/              # Layer 2 — OKF バンドルルート（人間・AI が読み書き）
│   ├── index.md       # 予約ファイル（ルートのみ okf_version）
│   ├── log.md         # 予約ファイル（日付グループ・新しい順）
│   └── **/*.md        # 概念ドキュメント
└── .rag/              # 派生インデックス（書き込み拒否・再構築可）
    └── fts.sqlite
```

**`wiki/` は必須ではありません。** 存在しなければ、開いたフォルダ自体をバンドル
ルートとみなすので、既存の Markdown フォルダをそのまま開けます。

> `AGENTS.md` が LLM Wiki パターンでいう「スキーマ層」です。`.rag/` は正典の
> パターンには無い、本アプリ独自の検索インデックスです。詳細は
> [LLM Wiki パターン](docs/ja/llm-wiki.md) を参照。

---

## 機能

### ノートアプリとして

- [x] 任意フォルダを OKF バンドルとして開く（`wiki/` の有無を自動判定）
- [x] Markdown 編集・プレビュー（ソース / 分割 / プレビューの3モード）
- [x] **自動保存**（入力停止 0.9 秒後）
- [x] **クイックスイッチャー** `Ctrl+P` / **コマンドパレット** `Ctrl+Shift+P`（あいまい検索）
- [x] **`[[` でウィキリンク補完**、未作成なら「新規作成」を提示
- [x] エディタ操作: Tab インデント、リスト自動継続、`Ctrl+B` / `Ctrl+I`
- [x] **ファイル操作**: 作成・フォルダ作成・リネーム・移動（D&D）・削除
- [x] **リネーム時に被リンクを自動書き換え**（コードブロック内は対象外）
- [x] バックリンク表示、タグでの絞り込み
- [x] 未解決リンクの一覧（＝知識の欠落。選ぶとページ作成）
- [x] 外部変更の自動反映（エージェントの書き込みが即座に UI に反映）
- [x] ネイティブフォルダ選択ダイアログ
- [x] **セッション復元** — 前回のバンドルと開いていたファイルを自動で再オープン

### RAG として

- [x] **日本語検索**（CJK バイグラム索引。`軽量` のような 2 文字語も文中でヒット）
- [x] **見出し単位のチャンク分割** — 検索結果もRAGも「どのセクションか」まで特定
- [x] `retrieve` ツール: 引用アンカー付き・文字数予算付きのコンテキスト組み立て
- [x] BM25 ランキング（タイトル 12倍 / 見出し 4倍 / 本文 1倍）
- [x] `type` / `tags` / `path_prefix` による絞り込み
- [x] mtime 差分による増分インデックス
- [x] 標準 MCP サーバー（検索・取得・読取・書込・移動・準拠チェック）
- [x] `AGENTS.md` を最初に読ませる設計
- [x] OKF 準拠チェックと非準拠の可視化

### キーボード

| キー | 動作 |
|------|------|
| `Ctrl/Cmd+P` | ノートをあいまい検索して開く |
| `Ctrl/Cmd+Shift+P` | コマンドパレット |
| `Ctrl/Cmd+K` / `+F` | 全文検索 |
| `Ctrl/Cmd+S` | 保存（自動保存もあり） |
| `Ctrl/Cmd+O` | フォルダを開く |
| `Ctrl/Cmd+B` / `+I` | 太字 / 斜体 |
| `Tab` / `Shift+Tab` | インデント / アンインデント |

---

## セットアップ（ワンタッチ）

リポジトリ直下の **`SETUP` をダブルクリックするだけ**です。

| OS | ファイル |
|----|---------|
| **Windows** | **`SETUP.bat`** をダブルクリック |
| **macOS** | **`SETUP.command`** をダブルクリック |
| **Linux** | `./SETUP.command` を実行 |

コマンドラインからでも同じです:

```bash
bun run setup        # Windows
bun run setup:unix   # macOS / Linux
```

これだけで以下が実行されます:

1. **Bun の確認とインストール**（未導入なら bun.sh から自動取得）
2. 依存関係のインストール
3. **アプリアイコンの生成**（外部ツール不要。PNG / ICO / iconset を自前生成）
4. 本番ビルド
5. **知識バンドルの初期化**（既定: `~/Documents/OKF Wiki`）
6. **デスクトップアイコンの作成**（Windows: `.lnk` / macOS: `.app` / Linux: `.desktop`）
7. `mcp-config.json` の書き出し（エージェント接続用）

**再実行しても安全です。** 各手順は実行前に状態を確認し、既存ファイルは上書きしません。

#### オプション

| オプション | 効果 |
|-----------|------|
| `-BundlePath <path>` / `--bundle <path>` | バンドルの作成先を指定 |
| `-NoBuild` / `--no-build` | ビルドを省略し、ソースから起動する（高速。試用向け） |
| `-NoShortcut` / `--no-shortcut` | デスクトップアイコンを作らない |

#### うまく起動しないとき

| 症状 | 原因と対処 |
|------|-----------|
| アイコンをクリックすると**一瞬だけ反応して消える** | 古いセットアップが作ったショートカットが `bin\bun.exe`（Bun ランタイム本体）を指しています。引数なしで起動すると使い方を表示して即終了するため、ウィンドウが一瞬光って消えます。**`SETUP.bat` を再実行**すれば、正しい `bin\launcher.exe` を指すショートカットに置き換わります |
| ビルドが `EACCES: permission denied` で失敗する | アプリが起動中だとビルドフォルダを削除できません。現在は setup が自動で終了させます。手動なら アプリを閉じてから再実行してください |
| ショートカットのターゲットを確認したい | プロパティの「リンク先」が `...\bin\launcher.exe` になっていれば正しい状態です |

### 手動セットアップ

前提: [Bun](https://bun.sh) 1.1+ / macOS 14+ / Windows 11+ / Ubuntu 22.04+

```bash
bun install
bun run icon                    # アイコン生成
bun run init-bundle ~/my-notes  # バンドル作成（任意）
bun run dev                     # 起動
bun run dev:hmr                 # Vite dev server と併走
bun run size                    # バンドルサイズの計測
```

---

## サイズ

「最高軽量」は計測して守る方針です。`bun run size` でいつでも確認できます。

| 対象 | サイズ |
|------|--------|
| Bun メインプロセス | **322 KB** |
| MCP サーバー（単体） | **170 KB** |
| WebView バンドル | **80 KB** |
| アイコン一式 | 80 KB |
| **パッケージ済みアプリ（Windows 実測）** | **約 117 MB** |

> パッケージの内訳のうち **約 111 MB は `bin/bun.exe`**（Electrobun が同梱する
> Bun ランタイム本体）です。自前コードは 322 KB に過ぎず、ここは削減の余地が
> ありません。Electron のように Chromium を同梱しない代わりに、JS ランタイムは
> 同梱される、というのが Electrobun の実際のトレードオフです。
> （以前このドキュメントに書いていた「~12–14MB」は上流の宣伝値で、
> 本ビルドの実測とは一致しません。訂正しました。）

### 削減した内容

| 項目 | 前 | 後 | 手段 |
|------|----|----|------|
| Bun メインプロセス | 6.90 MB | **322 KB** | Electrobun から three.js / Babylon.js を除去（下記） |
| WebView 出力 | 332 KB | **80 KB** | 本番ビルドで sourcemap を無効化 |

#### three.js / Babylon.js の除去（-5.4 MB）

Electrobun の `dist/api/bun/index.ts` は 3D ライブラリ2つを**再エクスポートする
ためだけに** eager import しており、内部では一切使っていません。トップレベルの
静的 import なので tree-shaking では落ちず、`external` 指定は実行時に解決不能に
なるため使えません。

そこで `bun patch` で該当 import と再エクスポートを削除しています
（[`patches/electrobun@1.18.1.patch`](patches/)）。`bun install` で自動適用され、
再現性があります。`Electrobun.three` / `Electrobun.babylon` は使えなくなりますが、
本アプリは 3D 機能を使いません。必要なら `three` を直接 import してください。

その他: 本番ビルドで sourcemap 無効、`useAsar` でリソースを単一アーカイブ化、
ICU ロケールを `en` / `ja` に限定（CEF を同梱する場合のみ効果あり）。

---

## 開発

```bash
bun run check         # typecheck (bun側 + view側) + テスト
bun test              # テストのみ
bun run size          # サイズ計測
bun run build:prod    # 本番ビルド
```

---

## MCP を外部エージェントから使う

Claude Code 等の設定例:

```json
{
  "mcpServers": {
    "okf-wiki": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/okf-wiki/src/bun/mcp/standalone.ts"],
      "env": {
        "OKF_BUNDLE": "/absolute/path/to/your-bundle"
      }
    }
  }
}
```

`OKF_BUNDLE` を省略した場合は `open_bundle` ツールを先に呼びます。

#### 提供ツール

| ツール | 用途 |
|--------|------|
| `read_agents_md` | **最初に呼ぶ。** バンドルの契約を読む |
| `retrieve` | **質問に答える。** 見出し単位の本文＋引用アンカー＋文字数予算 |
| `search` | **ページを探す。** 1 ドキュメント 1 件、該当セクション名付き |
| `read_file` | 本文 + frontmatter + リンク + バックリンク |
| `create_concept` | 準拠 frontmatter を自動生成して新規作成 |
| `write_file` | 既存更新。非準拠は警告として返る |
| `move_file` | リネーム・移動。**被リンクを自動書き換え** |
| `delete_file` | 削除。リンク切れになる参照元を報告 |
| `create_directory` | フォルダ作成 |
| `backlinks` / `unresolved_links` | 被リンク一覧 / 未作成ページの候補 |
| `list_concepts` / `list_tags` | 全 ID 一覧 / タグ・型の集計 |
| `check_conformance` | OKF §11 違反の一括検出 |
| `bundle_info` / `list_files` | 概況・層ラベル付き一覧 |
| `rebuild_index` / `rebuild_rag` | `index.md` / 検索索引の再構築 |

`raw/` と `.rag/` への書き込みは、UI からも MCP からも拒否されます。
バンドル外へのパス（`../` 等）も同様に拒否されます。

#### `retrieve` の出力例

```
Retrieved 1 passage(s) for: 日本語の検索はどう実装している？

### 検索の仕組み › 日本語対応
source: `wiki/search.md` · anchor: `search.md#日本語対応` · type: Playbook

unicode61 は日本語を分かち書きできないため、CJK を二文字ずつの
バイグラムに展開して索引する。
```

アンカーは実在のファイル位置なので、人間が開いて検証・修正できます。

---

## OKF v0.2 準拠

**バンドルルートは `wiki/` です。** 概念 ID はそこからの相対パスから `.md` を
除いたもの（`wiki/topics/foo.md` → `topics/foo`）。`raw/` と `.rag/` は
バンドルの外側にある兄弟ディレクトリで、OKF の規定対象ではありません。

- §4 概念ファイルはすべて YAML frontmatter + 非空の `type`（唯一の必須項目）
- §8 `index.md` は見出し＋箇条書き `* [Title](/path.md) - description`。
  ルートのみ `okf_version: 0.2` を持つ
- §9 `log.md` は `## YYYY-MM-DD` 日付グループ、**新しい順**、散文の箇条書き
- §6 リンクは絶対形式 `/topics/foo.md`（推奨）と相対形式の両方。
  `[[wikilink]]` も同じ ID 空間に解決。**リンク切れは許容**（未執筆の知識）
- §5 `sources` / `generated` / `verified` / `status` / `stale_after`。
  bare `verified` は1要素リストとして扱う。`stale_after` は `today >=` で判定
- §11 未知の `type`・追加キー・リンク切れ・`index.md` 欠落を理由に**拒否しない**

**仕様原文と照合した準拠状況の一覧は [docs/CONFORMANCE.md](docs/CONFORMANCE.md)。**
監査で見つかった 5 件の非準拠（index/log の形式、リンク解決順、`okf_version` の
誤判定、`stale_after` の比較）とその修正内容も記載しています。

未実装: §10 Attested computations、§5.1 の脚注による claim 単位帰属。

仕様: [OKF SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

---

## 技術スタック

| 層 | 選択 | 理由 |
|----|------|------|
| Desktop | Electrobun | システム WebView（Chromium 非同梱）、TS ネイティブ |
| Runtime | Bun | 高速 FS / 組み込み SQLite / 単一 TS 実行 |
| UI ビルド | Vite | HTML/CSS 込みの最小バンドル、dev server |
| UI | Vanilla TS | フレームワーク肥大を避ける（~57 kB） |
| Search | SQLite FTS5 | 依存ゼロ、BM25、ローカルのみ |
| Agent | MCP (stdio) | 標準プロトコル、Claude Code 等と直結 |
| Format | OKF v0.2 | 人間・エージェント双方が同じファイルを読める |

---

## 日本語検索について

SQLite の `unicode61` トークナイザは日本語を分かち書きできません。素の構成では
文中の「軽量」は**一件もヒットしません**（トークンが文全体になるため）。
`trigram` トークナイザは 3 文字以上しか扱えず、「知識」「軽量」「設計」のような
2 文字語が検索できません。

そこで本アプリは、索引時とクエリ時の両方で **CJK を重なり合うバイグラムに展開**
します。`unicode61` は空白区切りのバイグラムを字種をまたいでも 1 トークンとして
保持する（`識ベ`、`トア`）ため、両端が正確に一致します。

| 入力 | 挙動 |
|------|------|
| `軽量` | 文中でもヒット |
| `軽` | 前方一致（`軽*`）にフォールバック |
| `知識ベース` | 隣接必須のフレーズ検索 |
| 自然文の質問 | `retrieve` では緩いOR + BM25。助詞のみのバイグラムは無視 |

スニペットは SQLite の `snippet()` ではなくアプリ側で生成します
（索引側の文字列はバイグラム列なので、そのまま出すと読めないため）。

---

---

## ロードマップ

- MCP Streamable HTTP トランスポート
- グラフビュー（軽量 SVG）
- OKF trust tier のバッジ表示（`deriveTrustTier` は実装済み）
- 差分パッチ更新（Electrobun 標準）

---

## ライセンス

MIT

