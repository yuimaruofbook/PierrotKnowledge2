# macOS / Linux での動作について

[← ドキュメント一覧](../README.md)

**このアプリは Windows で開発・実測されています。** macOS と Linux 向けの調整は
入れていますが、**実機での検証はできていません。** 何が確認済みで何がそうでないかを
分けて書きます。

---

## 先に: 直した実際の問題

### 1. macOS でレイヤー保護が回避できた（重要）

パスの大小文字比較を Windows でのみ無視していました。**macOS の APFS / HFS+ も
既定では大小文字を区別しません。**

これは見た目の問題ではありません。`raw/` へのエージェント書き込みを止めているのは
パスの包含判定で、大小文字を区別する比較を大小文字を区別しないファイルシステムで
行うと、**`RAW/x.md` が検査を通り抜けて `raw/` に着地します。**

macOS でも大小文字を無視するよう修正しました。判定が厳しくなる方向なので、
仮に大小文字を区別するボリュームでも安全側に倒れます。

### 2. zip から取り出したスクリプトが実行できなかった

リリースの zip は Windows の `Compress-Archive` で作っており、**Unix の
パーミッションを記録しません。** 展開すると `PierrotKnowledge2` も
`SETUP.command` も実行権限のない 0644 で出てきます。

`scripts/setup.sh` が最初に実行権限を復元するようにしました。setup 自体は
`bash scripts/setup.sh` で起動できるので、権限が無くても問題ありません。

```bash
bun install && bun run setup:unix
```

手で直す場合:

```bash
chmod +x PierrotKnowledge2 SETUP.command
```

### 3. アンインストールが Windows のショートカットしか消さなかった

macOS の `.app` シンボリックリンクと `.command`、Linux の `.desktop`
（デスクトップとアプリメニューの両方）を消すようにしました。

> Linux の `.desktop` ファイルは改名前の `okf-wiki.desktop` という名前で
> 作られています。アンインストールは新旧どちらの名前も探します。

### 4. 更新の展開が `unzip` に依存していた

`unzip` は最小構成の Linux には入っていないことがあります。`unzip` →
`bsdtar`（`tar`）の順に試し、どちらも無ければ**何が足りないかを名指しで**
報告するようにしました。

---

## 環境ごとの状況

| | Windows | macOS | Linux |
|---|---|---|---|
| **CLI** (`PierrotKnowledge2`) | 実測済み | 未検証 | 未検証 |
| **Web UI** (`ui`) | 実測済み | 未検証 | 未検証 |
| **ヘッドレス** (MCP) | 実測済み | 未検証 | 未検証 |
| **デスクトップ版** | 実測済み | **要注意**（下記） | **要注意**（下記） |

### 共通で動くはずのもの

`ui`・ヘッドレス・CLI は Bun と標準ライブラリだけで動き、パス処理・
アプリデータの場所・ブラウザ起動はいずれも 3 環境で分岐済みです。
**Web UI 方式（`./PierrotKnowledge2 ui`）を勧めます** — 依存が最も少ないためです。

### デスクトップ版で注意が要る点

**macOS**

- **未署名です。** 初回起動で Gatekeeper に止められます。右クリック →「開く」、
  または `xattr -dr com.apple.quarantine <アプリ>` が必要です
- ビルドは `.app` を作り、setup がデスクトップにシンボリックリンクを張ります

**Linux**

- WebView に `webkit2gtk` が必要です。入っていなければウィンドウが開きません
  （`ui` 方式ならブラウザを使うので不要です）
- 新しめの GNOME は信頼していない `.desktop` を実行しません。setup は
  信頼フラグを立てようとしますが、環境によっては手で「起動を許可」が要ります

---

## 環境ごとの設定ファイルの場所

アプリ自身の設定:

| | 場所 |
|---|---|
| Windows | `%APPDATA%\PierrotKnowledge2\` |
| macOS | `~/Library/Application Support/PierrotKnowledge2/` |
| Linux | `$XDG_CONFIG_HOME/okf-wiki/`（既定 `~/.config/okf-wiki/`） |

> Linux だけ表示名ではなく機械 ID を使っているので、**改名の影響を受けません。**

エージェント側の設定は 3 環境とも同じ場所です（`~/.codex/config.toml`、
`~/.cursor/mcp.json` など）。

---

## 検証できていないこと

正直に列挙します。**実機がないため、以下は「コード上そうなっているはず」以上の
ことは言えません。**

- フォルダ選択ダイアログが macOS / Linux で実際に開くか。Windows は実機確認済み
  （`powershell.exe -STA` + WinForms、可視ウィンドウを列挙して確認）。macOS は
  `osascript`、Linux は `zenity` → `kdialog` の順に試します。**どれも無い環境では
  パスの手入力にフォールバックします**（失敗ではなく既定の挙動です）
- `.desktop` ファイルの信頼フラグが実際に効くか
- macOS の Gatekeeper 回避手順が現行 OS で足りるか
- rmux のペインシェル判定。**POSIX 側は未検証です**（Windows の `cmd.exe`
  側は実測で 5 件の不具合を見つけて直しました）

**うまく動かない場合は、その環境での出力を送ってください。** 直せます。

---

## 関連ドキュメント

- [使い方ガイド](./usage.md)
- [アップグレード](./upgrade.md)
