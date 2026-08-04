# ドキュメント / Documentation

[← リポジトリ README](../README.md)

---

## 動かし方 / How to run it

**3 つのモードで運用します。**

| モード | 誰が動かすか | コマンド | 常駐 |
|---|---|---|---|
| **Web UI** | **人間** | `.\PierrotKnowledge2 ui` | **135 MB** |
| **ヘッドレス** | **エージェント** | エージェントホストが自分で起動 | **85 MB** |
| **CLI** | どちらでも | `.\PierrotKnowledge2 <コマンド>` | — |

**エージェントは必ずヘッドレスで動かします。** Claude Code / Codex / opencode /
Hermes が `build\headless\okf-mcp.exe` を自分で spawn し、stdio 越しに MCP で
話します。画面を持たない 1 プロセスなので、これが 85 MB と 135 MB の差です。

**Web UI をエージェントに向けてはいけません。** あの画面が話すのはブラウザ相手の
RPC であって MCP ではないため、エージェントから呼べるものは何もありません。
両者は**ファイルで出会います** — 同じ `Workspace`、同じ書き込み経路です。

バイナリは `bun run build:headless` で作ります（`SETUP.bat -Connect` なら自動）。
未ビルドだとエージェント設定は `bun run …/standalone.ts` にフォールバックし、
エージェントホスト側の環境に Bun が無いと起動できません。

コマンドの先頭の `.\` は PowerShell では必須です（macOS / Linux では `./`）。
デスクトップ版（独立ウィンドウ・常駐 633 MB）は 0.5.0 で廃止しました。

---

## まず読むもの / Start here

| | 日本語 | English |
|---|---|---|
| **使い方** — 画面・操作・トラブル対応 | [usage](ja/usage.md) | [usage](en/usage.md) |
| **活用方法** — 実践レシピ | [workflows](ja/workflows.md) | [workflows](en/workflows.md) |

---

## エージェントと使う / Working with agents

| ドキュメント | 内容 |
|---|---|
| [SkillSpace 日本語](ja/skillspace.md) · [EN](en/skillspace.md) | スキルの自動選択、ループ設計、Claude Code / Codex / opencode / Hermes / Ollama / llama.cpp への接続 |
| [okf CLI](ja/cli.md) | コマンドライン。終了コード・JSON 出力・RMUX 連携 |
| [アップグレード](ja/upgrade.md) | **旧版からの手動移行手順**と、以降の `.\PierrotKnowledge2 Update` |
| [macOS / Linux](ja/platforms.md) | 各環境の注意点と、**検証できていないこと** |

`wiki/` にある `MAP.md` がエージェント向けの入口です。アプリが自動生成し、
どこに何があるかを 1 枚で示します（使い方 §13 を参照）。

---

## 設計の背景 / Background

| ドキュメント | 内容 |
|---|---|
| [OKF v0.2 日本語](ja/okf.md) · [EN](en/okf.md) | 形式の解説、全フィールド、本アプリでの実装状況 |
| [LLM Wiki パターン 日本語](ja/llm-wiki.md) · [EN](en/llm-wiki.md) | Karpathy の 3 層パターンと、本アプリが従う点・離れる点 |
| [アーキテクチャ](ARCHITECTURE.md) | コードの構成と設計判断（英語） |

---

## 計測と監査 / Measurement and audit

| ドキュメント | 内容 |
|---|---|
| [ベンチマーク](BENCHMARK.md) | Obsidian との実測比較。手順・生データ・ヘッドレスの実運用計測 |
| [軽量化の提案](ja/lightweight-proposal.md) | メモリの内訳と、削減策の費用対効果 |
| [OKF 準拠状況](CONFORMANCE.md) | 条文ごとの監査結果 |

**デスクトップ版は Obsidian より重い**という測定結果は隠していません。
根拠は [ベンチマーク](BENCHMARK.md) を参照してください。

---

## どれを読むべきか / Which document do I need?

| やりたいこと / I want to… | 読むもの / Read |
|---|---|
| とにかく動かす / Get it running | [使い方 §1–2](ja/usage.md#1-インストール) · [EN](en/usage.md#1-install) |
| 画面の使い方を知る / Learn the interface | [使い方 §4–10](ja/usage.md#4-画面の構成) · [EN](en/usage.md#4-the-window) |
| エージェントを接続する / Connect an agent | [使い方 §11](ja/usage.md#11-接続パネル) · [EN](en/usage.md#11-the-connections-panel) |
| ローカル LLM で動かす / Use a local LLM | [使い方 §11](ja/usage.md#11-接続パネル) · [SkillSpace](ja/skillspace.md) |
| Notion や GitHub から取り込む / Import from Notion or GitHub | [使い方 §11](ja/usage.md#11-接続パネル) · [EN](en/usage.md#11-the-connections-panel) |
| トークンを減らす / Cut agent token cost | [SkillSpace](ja/skillspace.md) · [使い方 §13](ja/usage.md#13-maphumantask) |
| 端末から使う / Drive it from a terminal | [okf CLI](ja/cli.md) |
| 貼り付けの書式を保つ / Keep formatting when pasting | [使い方 §5](ja/usage.md#5-ノートを読む書く) · [EN](en/usage.md#5-reading-and-writing) |
| ファイル形式を理解する / Understand the file format | [OKF](ja/okf.md) · [OKF](en/okf.md) |
| なぜこの設計なのか / Understand why it is built this way | [LLM Wiki](ja/llm-wiki.md) · [EN](en/llm-wiki.md) |
| 資源消費を確かめる / Check the resource numbers | [ベンチマーク](BENCHMARK.md) |
| 準拠の主張を検証する / Verify a standards claim | [準拠状況](CONFORMANCE.md) |
