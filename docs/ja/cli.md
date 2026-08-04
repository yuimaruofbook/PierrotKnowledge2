# okf CLI — エージェント向けコマンドライン

[← ドキュメント一覧](../README.md)

エージェントがこのツールを端末から操作するための CLI です。
[RMUX](https://rmux.io/) と組み合わせると、長時間の作業を
セッションに預けて後から見に行けます。

---

## 目次

1. [なぜ CLI があるのか](#1-なぜ-cli-があるのか)
2. [使い方](#2-使い方)
3. [エージェント向けの約束](#3-エージェント向けの約束)
4. [RMUX 連携](#4-rmux-連携)
5. [インストール](#5-インストール)

---

## 1. なぜ CLI があるのか

MCP があるのに CLI を足すのは、**MCP が苦手なことが 1 つある**からです。

MCP のツール呼び出しは 1 往復で完結する前提です。`retrieve` は数ミリ秒で返りますが、
大規模バンドルの再索引や、ローカルモデルによるエージェント実行は返りません。
**分単位でブロックする MCP 呼び出しは、タイムアウトする呼び出し**です。

そういう作業は「開始して、離れて、後で見に行く」形が要ります。
それが端末セッションであり、RMUX が担う部分です。

CLI は **MCP のツール表そのものから生成**しています。ツールを 1 つ足せば、
その日のうちに CLI コマンドになります。**両者が食い違うことはありません。**

```
   ウィンドウ ─┐
   MCP  ───────┼──→  同じ Workspace  ──→  同じ .md ファイル
   CLI  ───────┘
```

---

## 2. 使い方

```bash
okf <コマンド> [引数] [--flag 値]
okf --help              コマンド一覧
okf <コマンド> --help   そのコマンドの引数
```

### バンドルの指定

優先順に、`--bundle <path>` → 環境変数 `OKF_BUNDLE` → 前回アプリで開いたバンドル。
最後のフォールバックがあるので、ウィンドウを開いたまま横で CLI を叩けます。

### よく使うもの

```bash
okf info                          バンドルの概要
okf ask "LLM wiki とは何か"        retrieve（出典付きで答える）
okf search "設計原則" --limit 5    search（ページを探す）
okf find "議事録を取り込みたい"     skill_find（手順を探す）
okf lint                          OKF 準拠チェック
okf gaps                          未解決リンク
okf para                          PARA 別の一覧
okf archive wiki/1-projects/x.md archive   PARA を変更（実ファイル移動）
```

必須引数は**位置引数としても渡せます**。`okf search "設計"` は
`okf search --query "設計"` と同じです。

### エイリアス

| 短縮 | 実体 |
|------|------|
| `ask` | `retrieve` |
| `find` | `skill-find` |
| `ls` | `list-files` |
| `lint` | `check-conformance` |
| `gaps` | `unresolved-links` |
| `para` | `list-para` |
| `archive` | `set-para` |
| `agents` | `read-agents-md` |

### 全コマンド

MCP の 37 ツールがすべて使えます。アンダースコアはハイフンになります
（`skill_find` → `okf skill-find`）。加えて:

| コマンド | 用途 |
|----------|------|
| `okf info` | バンドルの概要 |
| `okf watch` | `log.md` を追尾。人間と AI の書き込みが 1 本の流れで見える |
| `okf serve` | MCP サーバーとして起動（ヘッドレスと同じ） |
| `okf rmux …` | RMUX セッション（次節） |

---

## 3. エージェント向けの約束

| 約束 | 内容 |
|------|------|
| **対話しない** | プロンプト・ページャ・確認ダイアログは一切ありません |
| **`--json`** | 機械可読な出力。`{ ok, tool, output }` の一定の封筒 |
| **stderr 分離** | エラーは stderr。失敗しても **stdout は壊れません** |
| **終了コード** | `0` 成功 / `1` ツールのエラー / `2` 使い方の誤り |

終了コードを 2 種類に分けているのは、エージェントが
**「引数を直せば通る」のか「対象が悪い」のか**を区別できるようにするためです。

```bash
okf search --json | jq -r '.output'      # 成功時のみ中身を取る
okf read-file wiki/nope.md; echo $?      # → 1
okf search; echo $?                      # → 2（--query が無い）
```

層の規約は CLI からでも同じです。`raw/` への書き込みは
**エージェントとして実行しても拒否されます**（→ [層ごとの権限](../../README.md)）。

---

## 4. RMUX 連携

RMUX は AI エージェント向けに作られた Rust 製ターミナルマルチプレクサです。
tmux 互換のコマンド面もありますが、**本アプリが使うのは RMUX 独自の拡張のほう**です
（`pane-snapshot` / `collect-pane-output` / `wait-pane`）。
これらは画面の写しではなく、`schema_version` 付きの JSON を返します。

### セッションを作る

```bash
okf rmux plan     # 何をするか表示するだけ（実行しない）
okf rmux setup    # 実際に作る（何度実行しても安全）
```

**ペイン分割ではなくウィンドウ**を使います。実測で `split-window -h` は
200 桁のペインを 99 桁にするため、出力が折り返されて読めなくなるからです。
ウィンドウは常に全幅です。

| ウィンドウ | 中身 |
|-----------|------|
| `main` | `okf` を叩くシェル（`OKF_BUNDLE` 設定済み） |
| `watch` | `okf watch` — 人間と AI の書き込みが 1 本の流れで見える |
| `job` | `okf rmux run` が作る使い捨てウィンドウ（終了時に消える） |

セッションは 200×50 で作ります。デタッチセッションの既定は 80×24 ですが、
JSON も検索結果も 80 桁を日常的に超えるためです。

> `okf rmux setup` は**あなたのマシンでプロセスを起動します**。
> 先に `okf rmux plan` で内容を確認できます。

### 使う

```bash
okf rmux run rebuild-rag      専用ウィンドウで実行し、終了まで待って出力を返す
okf rmux run search LLM --json    機械可読な封筒で返す
okf rmux send lint            main に投げるだけ（待たない）
okf rmux capture              main の内容を読む
okf rmux capture --window watch   別ウィンドウを読む
okf rmux status               セッション一覧
okf rmux windows              ウィンドウ一覧
okf rmux doctor               rmux の対応機能
okf rmux kill                 セッションを終了
```

### `run` と `send` の違い

**`run` が既定の選択肢です。** 専用ウィンドウでコマンドを起動し、
`collect-pane-output --until-pane-exit` でその終了をもって返ります。

- ポーリングしない。「出力が止まったから終わったのだろう」と推測しない
- コマンド行にマーカーを混ぜない
- **画面ではなくバイトストリーム**を返すので、折り返しもスクロール落ちも無い
  （実測: 757 文字の 1 行が 200 桁セッションで無傷）
- 端末制御シーケンスは除去済み

`send` は返りを待たずに `main` へ投げるだけです。人間が後から
アタッチして眺めるような、対話的な使い方のために残しています。

```bash
okf rmux run rebuild-rag --json | jq -r '.output'
```

封筒は `{ ok, command, output, bytes, truncated, exit_status }` です。

> `exit_status` は **Windows では常に `null`** です。rmux がペインの終了
> ステータスを観測できない（`pane_exit.stale`）ためで、`null` を成功と
> 読んではいけません。判定にはコマンド自身の出力を使ってください。

### 検証状況

**rmux 0.9.1（ソースビルド）で実機の往復を確認済み**です（Windows 11、2026-08-03）。

```
okf rmux setup     → main / watch を作成（2 度目は「既にあります」）
okf rmux windows   → 0: main* [200x50] / 1: watch- [200x50]
okf rmux run info  → 0.39 秒でブロックし、
                     「bundle: C:\Users\knsr1\Documents\OKF Wiki / 概念: 5 件 / 非準拠: 0 件」を返す
okf rmux run search LLM --json → ok:true, 35 行, 最長 192 桁, ANSI 無し
okf rmux run retrieve "…"      → 757 文字の 1 行が無傷（200 桁セッション）
okf rmux send lint             → 投げるだけ。capture で結果を確認
okf rmux capture --window watch → watch の追尾状況
okf rmux doctor    → capabilities の JSON
okf rmux kill      → セッション終了（残留なし）
```

ソースからの実行と `build:cli` のバイナリ、**両方**で確認しています。

実機でしか分からなかった落とし穴が 5 つあり、いずれも修正済みです。

1. **`send-keys` の中身をクォートしてはいけない。**
   rmux は直接 spawn しており間にシェルが無いため、付けたクォートが
   そのままペインのプロンプトに文字として届きます。
   （症状: `'bun' は…認識されていません`）
2. **ペインのシェルはプラットフォーム既定** — Windows では `cmd.exe` です。
   コマンドに埋め込むパスは `cmd` なら `"…"`、POSIX なら `'…'`。
   環境変数も `set "N=v"` と `export N='v'` で異なります。
3. **コンパイル後は `process.argv[1]` が実在しない仮想パス**
   （`B:/~BUN/root/okf`）になります。これを `bun run` に渡すと
   `Module not found` で失敗するため、バイナリ自身を呼びます。
   判定は `process.execPath`（ソース実行なら `bun`）で行います
   — `existsSync` は Bun の仮想 FS が `true` を返すため**使えません**。
4. **`split-window` はペイン幅を半分にする。** 実測 200 → 99 桁。
   これが「出力が読めない」の正体でした。ウィンドウなら全幅のままです。
5. **`wait-pane --text` は完了判定に使えない。**
   シェルがエコーしたコマンド行そのものにマッチし、約 1 ミリ秒で
   「成功」を返します。基準点を取る `--next-text` を使ってください。
   （本アプリは `run` で `collect-pane-output --until-pane-exit` を使うため、
   そもそもマーカーが不要です）

コマンド列自体は [rmux.io の公式ドキュメント](https://rmux.io/docs/get-started/)から
取ったもので、記憶で書いていません。引数の並びとクォートは
`test/cli.test.ts` で**両シェル分**データとしてテストしています。

---

## 5. インストール

### okf CLI

```bash
bun run build:cli        # 単一実行ファイル build/cli/okf（Bun 不要）
bun run okf -- --help    # ソースから直接
```

### RMUX

Windows では **`cargo install rmux --locked` を使ってください。**

```powershell
cargo install rmux --locked      # 推奨（ビルドに約 7 分）
```

> **事前ビルド版（0.9.1）は Windows で壊れています。**
> `irm https://rmux.io/install.ps1 | iex` と `winget install Helvesec.RMUX` が配布する
> zip には `rmux.exe` しか入っておらず、必要な `rmux-daemon.exe` が欠けています。
> `rmux -V` はバージョンを返すのに、サーバーを起動するコマンドは全て
> `private rmux helper not found under libexec/rmux` で失敗します。
> ソースからビルドすると `rmux.exe` と `rmux-daemon.exe` の**両方**が入り、動きます。
>
> `okf` はこの 2 つを区別して報告します
> — 「入っていない」と「入っているが壊れている」では直し方が違うためです。

TypeScript SDK（`@rmux/sdk`）と Python SDK（`librmux`）も提供されています。
本アプリは**バイナリの CLI 面のみ**を使っており、SDK には依存していません
— 依存を 1 つ増やすより、プロセスを 1 つ呼ぶほうが軽いためです。

---

## 関連ドキュメント

- [使い方ガイド](./usage.md) — GUI 側
- [SkillSpace](./skillspace.md) — スキルとループ、エージェント接続
- [ベンチマーク](../BENCHMARK.md) — ヘッドレスの資源消費
