# PierrotKnowledge2
A highly lightweight local knowledge base compliant with OKF v0.2 and LLMwiki.

Designed to prioritize functionality over security—unlike its predecessor—its core concept is "as light as air, allowing data storage from anywhere."

This suite of features is branded as "PierrotKnowledge2" and comprises three main components: OKFwiki (for RAG functionality), plugin management, and compression management.

To get started, please download the software from the release notes.

# OKF Wiki

**A knowledge base where local Markdown files serve as the source of truth. Humans and AI agents read from and write to the same files via the same paths.**

---

## これは何か

Obsidian のようなノートアプリですが、**AI エージェントとの共同作業を前提に設計**されています。

```
   あなた ──┐                     ┌── Claude Code
             ├──→  同じ .md  ←──┤    Codex / opencode
   エディタ ─┘      ファイル       └── Ollama / llama.cpp
```

UI から書いても MCP から書いても、通るのは同じ `Workspace` です。層の検査・ログ・
索引更新は 1 箇所にしかありません。だから両者の結果が食い違いません。

| 原則 | 意味 |
|------|------|
| **File over App** | 正本は常にローカルの Markdown。アプリを消してもノートは残る |
| **OKF v0.2 準拠** | YAML frontmatter（`type` 必須）+ 標準リンク。他ツールでも読める |
| **LLM Wiki パターン** | `raw/`（不変の原本）→ `wiki/`（正典）→ `AGENTS.md`（規約） |
| **人間と AI の対称性** | UI も MCP も同一の書き込み経路。特権も抜け道もない |

技術構成: Electrobun + Bun + TypeScript / SQLite FTS5 / MCP (stdio)。

---

## 5 分で始める

リポジトリ直下のファイルをダブルクリックするだけです。

| OS | ファイル |
|----|---------|
| Windows | **`SETUP.bat`** |
| macOS | **`SETUP.command`** |
| Linux | `./SETUP.command` |

Bun の導入・依存関係・ビルド・バンドル作成・デスクトップアイコン・MCP 設定まで
自動で行います。**何度実行しても安全**です（既存ファイルは上書きしません）。

```bat
SETUP.bat                             通常（デスクトップアプリ）
SETUP.bat -Connect                    ＋検出したエージェントに自動接続
SETUP.bat -Headless -Connect          ヘッドレスのみ（AI 専用・軽量）
SETUP.bat -BundlePath "D:\Knowledge"  バンドルの作成先を指定
SETUP.bat -NoBuild                    ソースから起動（試用向け・高速）
```

> **動作確認**: Windows 11 で実機検証済み。macOS / Linux 用スクリプトは同じ手順を
> 実装していますが、実機検証は行っていません。

---

## 2 つのモード

用途に応じて選べます。**同じバンドルを共有**するので併用もできます。

|  | デスクトップ | **ヘッドレス** |
|---|---:|---:|
| 用途 | 自分で読み書きする | **エージェントに任せる** |
| 常駐メモリ | 607 MB | **129 MB** |
| プロセス数 | 7 | **1** |
| 実行ファイル | 117 MB | **94 MB** |
| 起動 | 710 ms | **372 ms** |
| ウィンドウ | あり | なし |

メモリの大半はウィンドウと WebView が占めます。エージェントに作業させている間は
ウィンドウが不要なので、**ヘッドレスにすると 4.7 倍軽くなります。**

```bat
SETUP.bat -Headless -Connect   ヘッドレスを構築してエージェントに接続
bun run build:headless         単一実行ファイルを生成（Bun のインストール不要）
bun run headless               ソースから直接起動
```

`SETUP.bat -Connect` は、ヘッドレスがビルド済みならそちらを指す設定を書きます。

---

## 実測値

同一の 300 ノートを開いた状態での比較です。プロセスツリー全体を 3 回測った中央値。
手順・生データ・分析は [BENCHMARK.md](docs/BENCHMARK.md)。

| 指標 | ヘッドレス | デスクトップ | Obsidian 1.13.4 |
|------|----------:|------------:|----------------:|
| 常駐メモリ | **129 MB** | 607 MB | 424 MB |
| プロセス数 | **1** | 7 | 4 |
| ディスク | **94 MB** | 117 MB | 373 MB |
| 起動 | **0.37 s** | 0.71 s | 0.48 s |

エージェントが実際に働いているとき（1,921 ツール呼び出し／190 呼び出し毎秒）でも、
ヘッドレスのピークは **160 MB** で、アイドルで 129 MB に戻ります。

### 正直に書いておくこと

**デスクトップ版は Obsidian よりメモリを食います**（1.4 倍）。当初「システム WebView を
使えば Electron より軽い」と考えていましたが、実測ではこれは**ディスクについてのみ
正しく、メモリでは誤り**でした。

内訳を切り分けたところ、**メモリの 90% はこのプロジェクト自体のコードではありません**
（WebView2 が 57%、Electrobun が 26%、Bun の下限が 7%、自コードは 10%）。

---

## 機能

### ノートアプリとして

- **単一の執筆面** — 分割表示ではなく 1 カラム。`編集 / プレビュー` を切替
- **書式ツールバー** — 見出し・太字・斜体・取り消し線・コード・リンク・引用・
  リスト 3 種・文字揃え・区切り線・表。すべてトグル式
- **表示幅スライダー** — 本文カラムを 40〜100% で調整（設定は保存）
- **書式を保った貼り付け** — Notion / Google ドキュメントからのコピーを Markdown に変換
- **`[[` 補完** — 未作成なら「新規作成」を提示
- **リネーム時にリンクを自動追従** — 被リンクを全て書き換え（コード内は除外）
- **バックリンク**、**未解決リンク一覧**（＝まだ書いていない知識の可視化）
- 自動保存（0.9 秒）、外部変更の即時反映、セッション復元
- クイックスイッチャー `Ctrl+P` / コマンドパレット `Ctrl+Shift+P`

### 検索・RAG

- **日本語検索** — CJK を重なり合うバイグラムに展開して索引するため、
  `軽量` のような 2 文字語が文中でもヒットします
  （素の SQLite FTS5 では 1 件も返りません → [詳細](docs/ja/llm-wiki.md)）
- **`retrieve`** — 見出し単位のパッセージを引用アンカー付き・文字数予算内で返す
- **`search`** — ページを特定する BM25 検索（タイトル 12倍 / 見出し 4倍 / 本文 1倍）
- SQLite FTS5、外部依存ゼロ、完全ローカル

### エージェント連携

- **MCP サーバー** — 29 ツール
- **MCP クライアント** — Notion・GitHub・Google Drive から `raw/` に取り込み
- **SkillSpace** — 手順書を段階開示。常時読むのは名前と説明だけで、選ばれた 1 件の
  本文だけを展開（同梱 3 スキルで実測 **58% のトークン削減**）→ [解説](docs/ja/skillspace.md)
- **ループ** — 作業の型を **1 設計 1 ファイル**で管理。開始時と終了時の状態を
  突き合わせ、**OKF 非準拠が増えたらエラー**にします
- **ワンタッチ接続** — Claude Code / Codex / opencode / Hermes Agent
- **内蔵エージェント** — Ollama / llama.cpp は MCP を話さないため、本アプリが
  ツール呼び出しループを実行します

### UI

スイス・デザイン（International Typographic Style）— 厳密なグリッド、角丸なし、
細罫、Helvetica 系。緑を基調とした配色。ライト / ダーク自動切替。

### キーボード

| キー | 動作 |
|------|------|
| `Ctrl/Cmd+P` | ノートをあいまい検索して開く |
| `Ctrl/Cmd+Shift+P` | コマンドパレット |
| `Ctrl/Cmd+K` | 全文検索 |
| `Ctrl/Cmd+S` | 保存（自動保存もあり） |
| `Ctrl/Cmd+B` / `+I` | 太字 / 斜体 |
| `Ctrl/Cmd+Shift+V` | 書式なしで貼り付け |
| `Tab` / `Shift+Tab` | インデント / アンインデント |

---

## バンドルの構成

```
your-bundle/
├── AGENTS.md          エージェントが最初に読む規約
├── skills/            SkillSpace: 手順書（段階開示）
├── loops/             ループ設計と実行履歴（1 設計 1 ファイル）
├── raw/               Layer 1: 不変の原本。書き込み禁止
├── wiki/              Layer 2: 正典
│   ├── index.md         予約ファイル
│   ├── log.md           予約ファイル
│   └── **/*.md          概念ドキュメント（frontmatter に type 必須）
└── .rag/              Layer 3: 派生インデックス（削除しても再構築可能）
```

層の規約は `paths.ts` の 1 箇所で強制されます。`raw/` と `.rag/` への書き込みは、
UI からでも MCP からでも同じ理由で拒否されます。

---

## エージェントを接続する

`SETUP.bat -Connect` が自動で書き込みます。**必ずバックアップを取り**、既存の設定は
1 項目の追加・置換以外変更しません。手動なら:

| ツール | 設定ファイル |
|--------|-------------|
| Claude Code | `<バンドル>/.mcp.json` |
| Codex | `~/.codex/config.toml` |
| opencode | `~/.config/opencode/opencode.json` |
| Hermes Agent | `~/.hermes/config.yaml` |

```json
{
  "mcpServers": {
    "okf-wiki": {
      "command": "/絶対パス/build/headless/okf-mcp.exe",
      "env": { "OKF_BUNDLE": "/絶対パス/your-bundle" }
    }
  }
}
```

エージェントは `read_agents_md` → `loop_start` → `skill_find` の順に呼ぶよう
`AGENTS.md` で指示されています。

---

## アーキテクチャ

```
src/
├── shared/          両プロセス共有・I/O なし・DOM なし
│   ├── okf/           frontmatter / concept / links / skill / loop
│   ├── markdown-format.ts   書式コマンド（純関数）
│   └── rpc-schema.ts        型付き RPC 契約
├── bun/             メインプロセス（唯一の書き込み経路）
│   ├── okf/           bundle / paths / skills / loops
│   ├── rag/           FTS5 索引・取得
│   ├── mcp/           サーバー（29 ツール）+ クライアント
│   ├── agent/         ローカル LLM 用ツールループ
│   └── connect/       他ランタイムへの設定書き込み
└── mainview/        WebView（ファイルシステム権限を持たない）
```

詳細は [アーキテクチャ](docs/ARCHITECTURE.md)、
OKF 準拠状況は [CONFORMANCE.md](docs/CONFORMANCE.md)。

---

## 開発

```bash
bun install
bun run dev              # 起動（ソースから）
bun run check            # typecheck + テスト
bun test                 # 486 テスト / 22 ファイル
bun run build            # デスクトップ版のパッケージング
bun run build:headless   # ヘッドレス実行ファイル（94 MB・単一ファイル）
bun run size             # サイズレポート
bun run bench:workload <bundle> 100   # 実運用ワークロードで計測
```

| 対象 | サイズ |
|------|-------:|
| Bun メインプロセス | 419 KB |
| MCP サーバー（単体） | 233 KB |
| WebView バンドル（HTML+CSS+JS） | 148 KB |

---

## 既知の限界

- **デスクトップ版のメモリは Obsidian に劣ります**（607 対 424 MB）。
  WebView2 の 6 プロセスと Bun の常駐が支配的で、アプリコードの最適化では
  埋まりません。エージェント用途ではヘッドレス（129 MB）を使ってください
- **大規模での挙動は未測定** — 300 ノートまでしか計測していません
- **macOS / Linux は未検証** — スクリプトは実装済みですが実機確認していません
- グラフビュー、Canvas、プラグイン機構、モバイル、同期はありません

---

## ライセンス

MIT

