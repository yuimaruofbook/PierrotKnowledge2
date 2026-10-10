//! User-facing messages, in Japanese (`src/shared/messages.ts`).
//!
//! These strings reach the status bar, the MCP tool results an agent reads and
//! `log.md`, and a parity test compares them byte for byte with the TypeScript
//! server, so the wording must not drift. Constants replace the TS string
//! properties; functions replace the TS template-literal properties.
//! Paths and identifiers are kept verbatim inside messages.

use super::js_compat::js_round;
use std::fmt::Display;

// ---- workspace lifecycle ----

pub const NO_BUNDLE_OPEN: &str = "バンドルが開かれていません。先にフォルダを開いてください。";
pub const SEARCH_INDEX_CLOSED: &str = "検索インデックスが開かれていません。";

pub fn not_a_directory(path: &str) -> String {
    format!("フォルダではありません: {path}")
}

/// The tool's own connect command ran and did not finish the job.
pub fn connect_cli_failed(label: &str, command: &str, output: &str) -> String {
    format!("{label} への登録に失敗しました。\n  実行したコマンド: {command}\n  出力: {output}")
}

/// A registered server declares a credential it has not been given. Names the
/// key and the file, because the fix is a two-minute edit.
pub fn mcp_credential_missing(label: &str, keys: &[&str], config_path: &str) -> String {
    format!(
        "{label}: {} が未設定です。{config_path} を開いて値を入れ、もう一度接続してください。",
        keys.join(", ")
    )
}

/// Opening succeeded; creating one of the two reserved files did not. A
/// warning, not a failure to open.
pub fn reserved_file_not_created(path: &str, reason: &str) -> String {
    format!("{path} を作成できませんでした（フォルダは開けています）: {reason}")
}

// ---- path containment and the layer contract ----

pub fn path_escapes_bundle(path: &str) -> String {
    format!("バンドルの外を指すパスです: {path}")
}

pub const RAG_DERIVED: &str = ".rag/ は派生インデックスです。再構築すると失われます";

pub fn layer_violation(reason: &str, path: &str) -> String {
    format!("{reason}: {path}")
}

// ---- file operations ----

pub fn not_found(path: &str) -> String {
    format!("見つかりません: {path}")
}

pub fn already_exists(path: &str) -> String {
    format!("既に存在します: {path}")
}

pub fn reserved_cannot_delete(path: &str) -> String {
    format!("{path} は予約ファイル（index.md / log.md）のため削除できません")
}

pub fn layer_root_cannot_delete(path: &str) -> String {
    format!("{path} は層のルートのため削除できません。中身を個別に選んでください")
}

pub fn promote_only_from_raw(path: &str) -> String {
    format!("raw/ の中のファイルだけが引き上げの対象です: {path}")
}

// ---- OKF conformance (§11) ----

pub const MISSING_FRONTMATTER: &str = "YAML frontmatter がありません";
pub const MISSING_TYPE: &str = "frontmatter に非空の 'type' が必要です";
pub const RESERVED_HAS_FRONTMATTER: &str =
    "予約ファイル（index.md / log.md）に frontmatter は置けません";

pub fn root_index_extra_keys(keys: &[String]) -> String {
    format!(
        "ルートの index.md に置けるのは 'okf_version' のみです。検出: {}",
        keys.join(", ")
    )
}

// ---- provenance ----

pub const MISSING_PROVENANCE: &str = "frontmatter に generated がありません。エージェントの書き込みには由来（generated.by / generated.at）を記録してください";
pub const AUDIT_NO_CHANGES: &str = "該当する変更はありません。";

// ---- non-text files ----

pub const BINARY_NOTICE: &str = "このファイルはテキストではないため表示できません。";
pub const BINARY_HINT: &str =
    ".rag/ の索引ファイルなどはアプリが管理します。編集の必要はありません。";

pub fn binary_file(file_type: Option<&str>) -> String {
    file_type.unwrap_or("テキストではないファイル").to_string()
}

/// `1.5 KB` / `2.25 MB` with JS `toFixed` rounding (ties round up).
///
/// Done in integer arithmetic: the divisors are powers of two, so the quotient
/// is exact and `toFixed` ties (e.g. 1280 bytes = 1.25 KB) are real cases where
/// Rust's `{:.1}` would round to even and disagree.
pub fn file_size(bytes: u64) -> String {
    let b = bytes as u128;
    if bytes < 1024 {
        return format!("{bytes} バイト");
    }
    if bytes < 1024 * 1024 {
        let tenths = (b * 20 + 1024) / 2048;
        return format!("{}.{} KB", tenths / 10, tenths % 10);
    }
    let hundredths = (b * 200 + (1 << 20)) / (1 << 21);
    format!("{}.{:02} MB", hundredths / 100, hundredths % 100)
}

// ---- external MCP servers ----

pub fn mcp_spawn_failed(command: &str, reason: &str) -> String {
    format!("MCP サーバーを起動できません（{command}）: {reason}")
}

pub const MCP_DISCONNECTED: &str = "MCP サーバーに接続していません";

pub fn mcp_timeout(method: &str, ms: f64) -> String {
    format!(
        "MCP サーバーが応答しません（{method}, {} 秒）",
        js_round(ms / 1000.0)
    )
}

pub fn mcp_server_error(reason: &str, code: i64) -> String {
    format!("MCP サーバーがエラーを返しました ({code}): {reason}")
}

pub fn mcp_exited(code: i64, diagnostics: &str) -> String {
    let tail = if diagnostics.is_empty() {
        String::new()
    } else {
        format!("\n{diagnostics}")
    };
    format!("MCP サーバーが終了しました (code {code}){tail}")
}

pub fn mcp_unknown_server(id: &str) -> String {
    format!("未登録の MCP サーバーです: {id}")
}

// ---- importing sources ----

pub fn imported_to(path: &str) -> String {
    format!("raw/ に取り込みました: {path}")
}

pub fn captured_files(paths: &[String]) -> String {
    if paths.len() == 1 {
        format!("raw/ に取り込みました: {}", paths[0])
    } else {
        format!("{} 件を raw/ に取り込みました", paths.len())
    }
}

pub fn capture_too_large(name: &str, limit: u64) -> String {
    format!(
        "{name} は大きすぎます（上限 {} MB）",
        js_round(limit as f64 / (1024.0 * 1024.0))
    )
}

pub fn capture_not_text(name: &str) -> String {
    format!("{name} はテキストではないため取り込めません（raw/ に直接置いてください）")
}

pub const CAPTURE_NOTHING: &str = "取り込めるテキストファイルがありませんでした";

pub fn import_outside_raw(path: &str) -> String {
    format!("取り込み先は raw/ の中でなければなりません: {path}")
}

pub const IMPORT_EMPTY: &str = "取り込める本文がありませんでした";

// ---- paste ----

pub const PASTED_AS_MARKDOWN: &str =
    "書式を Markdown に変換して貼り付けました（Ctrl+Shift+V で書式なし / Ctrl+Alt+V で HTML のまま）";
pub const PASTED_AS_HTML: &str = "HTML のまま貼り付けました（Ctrl+Shift+V で書式なし）";

// ---- layer movement ----

pub const RAW_IS_HUMAN_ONLY: &str = "raw/ は人間が原本を置く場所です。エージェントは書き込めません";
pub const RAW_PROMOTION_IS_HUMAN_ONLY: &str = "raw/ からの引き上げは人間の操作でのみ行えます。未査読の資料を正典に載せる判断は、エージェントには委ねられません";

pub fn promoted(from: &str, to: &str) -> String {
    format!("{from} を {to} に引き上げました")
}

pub fn promoted_copy(from: &str, to: &str) -> String {
    format!("{from} を {to} に複製しました（原本は raw/ に残しています）")
}

// ---- PARA ----

pub fn para_unknown_class(value: &str) -> String {
    format!("PARA の分類は project / area / resource / archive のいずれかです: {value}")
}

pub fn para_moved(from: &str, to: &str, label: &str) -> String {
    format!("{from} を{label}に移しました: {to}")
}

pub fn para_already(path: &str, label: &str) -> String {
    format!("{path} は既に{label}です")
}

pub fn para_archived(path: &str) -> String {
    format!("{path} をアーカイブしました")
}

// ---- SkillSpace ----

pub fn skill_unknown(name: &str) -> String {
    format!("そのスキルはありません: {name}")
}

pub fn skill_missing_file(name: &str) -> String {
    format!("スキル {name} に SKILL.md がありません")
}

pub fn skill_resource_missing(path: &str, name: &str) -> String {
    format!("スキル {name} に {path} がありません")
}

pub fn skill_resource_escapes(path: &str, name: &str) -> String {
    format!("スキル {name} のフォルダ外は読み取れません: {path}")
}

pub fn skill_none_matched(task: &str) -> String {
    format!("「{task}」に合うスキルが見つかりませんでした。skill_list で一覧を確認してください")
}

pub const SKILL_SPACE_EMPTY: &str = "スキルがまだありません";

// ---- loops ----

pub fn loop_unknown(name: &str) -> String {
    format!("ループ設計 {name} はありません。loop_list で一覧を確認するか、loop_define で作成してください")
}

pub fn loop_bad_name(name: &str) -> String {
    format!("ループ名は英小文字・数字・ハイフンのみ使えます: {name}")
}

pub const LOOP_NEEDS_GOAL: &str = "ループ設計には目的 (goal) が必要です";

pub fn loop_already_running(name: &str) -> String {
    format!(
        "ループ {name} が実行中です。1 度に 1 実行の原則により、新しい実行は始められません。先に loop_end で閉じてください"
    )
}

pub const LOOP_NONE_RUNNING: &str = "実行中のループがありません。先に loop_start を呼んでください";
pub const LOOP_REGRESSED: &str = "OKF 非準拠が増えています。閉じる前に直してください";

// ---- local agent runtimes ----

pub fn agent_unreachable(label: &str, url: &str, reason: &str) -> String {
    format!("{label} に接続できません（{url}）: {reason}")
}

pub fn agent_no_model(label: &str) -> String {
    format!("{label} で使うモデルを指定してください")
}

pub fn agent_model_missing(model: &str, label: &str) -> String {
    format!("モデル {model} が {label} にありません")
}

pub fn agent_no_tools(label: &str) -> String {
    format!("{label} のモデルはツール呼び出しに対応していません。tools 対応モデルを選んでください")
}

pub fn agent_round_limit(rounds: impl Display) -> String {
    format!("ツール呼び出しが上限 ({rounds} 回) に達したため打ち切りました")
}

pub fn agent_budget_exceeded(tokens: impl Display) -> String {
    format!("トークン上限 ({tokens}) に達したため打ち切りました")
}

// ---- one-touch connect ----

pub fn connect_wrote(label: &str, path: &str) -> String {
    format!("{label} の設定を書き込みました: {path}")
}

pub fn connect_backed_up(path: &str) -> String {
    format!("既存の設定を退避しました: {path}")
}

pub fn connect_unknown_target(id: &str) -> String {
    format!("未対応の接続先です: {id}")
}

pub fn connect_not_installed(label: &str) -> String {
    format!("{label} が見つかりません")
}

/// Refusing to rewrite a config we could not read. Named as a refusal, not a
/// failure: overwriting it would have cost the user every other MCP server.
pub fn config_unparseable(shape: &str) -> String {
    format!(
        "{shape} の既存設定を読み取れませんでした。上書きすると他のサーバー設定が失われるため中止しました。書式（コメントや末尾カンマなど）を直してから、もう一度接続してください"
    )
}

pub fn config_not_an_object(shape: &str) -> String {
    format!("{shape} の既存設定が想定の形式（キーと値の対応）ではありません")
}

// ---- editor metadata ----

pub const NON_CONCEPT_FILE: &str = "予約ファイル / 概念以外";

pub fn unresolved_links(count: impl Display) -> String {
    format!("未解決リンク {count}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_size_matches_js_to_fixed() {
        assert_eq!(file_size(0), "0 バイト");
        assert_eq!(file_size(1023), "1023 バイト");
        assert_eq!(file_size(1024), "1.0 KB");
        // 1.25 KB is an exact tie: JS toFixed(1) rounds up to 1.3.
        assert_eq!(file_size(1280), "1.3 KB");
        assert_eq!(file_size(1024 * 1024), "1.00 MB");
        // 1.125 MB is an exact tie: toFixed(2) gives 1.13.
        assert_eq!(file_size(1024 * 1024 + 131_072), "1.13 MB");
    }

    #[test]
    fn messages_keep_their_wording() {
        assert_eq!(not_found("a.md"), "見つかりません: a.md");
        assert_eq!(
            mcp_timeout("tools/list", 1500.0),
            "MCP サーバーが応答しません（tools/list, 2 秒）"
        );
        assert_eq!(mcp_exited(1, ""), "MCP サーバーが終了しました (code 1)");
        assert_eq!(
            mcp_exited(1, "boom"),
            "MCP サーバーが終了しました (code 1)\nboom"
        );
        assert_eq!(
            capture_too_large("x.html", 8 * 1024 * 1024),
            "x.html は大きすぎます（上限 8 MB）"
        );
        assert_eq!(
            captured_files(&["raw/a".to_string(), "raw/b".to_string()]),
            "2 件を raw/ に取り込みました"
        );
        assert_eq!(binary_file(None), "テキストではないファイル");
    }
}
