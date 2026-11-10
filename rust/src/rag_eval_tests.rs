//! Retrieval evaluation: a small wiki, questions with a known right page, and
//! two numbers (recall@3 and MRR) that a ranking change has to move the right
//! way.
//!
//! The corpus is built to hold the cases lexical search finds hard: a page
//! whose own words for a thing differ from its description's, meeting notes
//! that mention every topic once, a glossary everything links to. It is a
//! regression harness, not a benchmark: the floors at the bottom say "no worse
//! than when this was last tuned", not "good".
//!
//!   cargo test rag_eval -- --nocapture     prints every case

use super::*;
use crate::okf::scaffold::scaffold_bundle;
use std::fs;
use std::path::Path;

/// (path under wiki/, frontmatter, body)
const PAGES: &[(&str, &str, &str)] = &[
    (
        "backup.md",
        "type: Playbook\ntitle: バックアップ運用\ndescription: NAS への夜間バックアップと復元手順\ntags: [運用, 障害対応]",
        "# バックアップ運用\n\n[[glossary]] も参照。\n\n## 手順\n\n毎晩 2 時に rsync を実行し、世代を 7 つ残す。\n\n## 復元\n\n直近のスナップショットから戻す。所要時間は約 20 分。\n",
    ),
    (
        "deploy.md",
        "type: Playbook\ntitle: デプロイ手順\ndescription: 本番リリースの流れとロールバック\ntags: [リリース]",
        "# デプロイ手順\n\n用語は [[glossary]] を参照。\n\n## 流れ\n\nタグを打つと CI がビルドし、承認後に反映される。\n\n## 戻し方\n\nひとつ前のタグを指定して、同じ流れをもう一度実行する。\n",
    ),
    (
        "oncall.md",
        "type: Playbook\ntitle: 当番表\ndescription: 障害発生時の連絡順と一次対応\ntags: [障害対応]",
        "# 当番表\n\n## 連絡順\n\nまず当番、次に責任者へ電話する。15 分応答が無ければ次の人へ。\n\n## 最初にやること\n\n影響範囲を確かめ、状況をチャットに書く。\n",
    ),
    (
        "glossary.md",
        "type: Concept\ntitle: 用語集\ndescription: この Wiki で使う言葉の定義\ntags: [基礎]",
        "# 用語集\n\n## チャンク\n\n見出しで区切った文書の一片。検索はこの単位で行う。\n\n## 索引\n\n検索のために作る派生データ。消しても作り直せる。\n\n## バンドル\n\n知識をまとめたフォルダ全体。\n",
    ),
    (
        "rag.md",
        "type: Concept\ntitle: RAG 構成\ndescription: 検索して文脈を組み立てる仕組み\ntags: [検索]",
        "# RAG 構成\n\n言葉の定義は [[glossary]]。\n\n## 分割\n\nチャンクは見出しごとに切る。チャンクが長すぎるときは段落で分け、チャンクごとに見出しの道筋を持たせる。\n\n## 順位付け\n\nチャンクを BM25 で並べ、文書ごとの件数を抑える。\n",
    ),
    (
        "indexing.md",
        "type: Concept\ntitle: 索引の更新\ndescription: 変更されたファイルだけを取り込み直す\ntags: [検索]",
        "# 索引の更新\n\n[[glossary]] と [[rag]] を前提にする。\n\n## 差分\n\n更新時刻が変わったファイルのチャンクだけを作り直す。チャンクの数は統計に出る。\n",
    ),
    (
        "pricing.md",
        "type: Reference\ntitle: 料金プラン\ndescription: 月額と年額、学割の条件\ntags: [営業]",
        "# 料金プラン\n\n## 個人\n\n月 980 円。年払いは 2 か月分お得。\n\n## 学生\n\n在学証明があれば半額になる。\n",
    ),
    (
        "onboarding.md",
        "type: Playbook\ntitle: 新メンバー受け入れ\ndescription: 入社初日のアカウント発行と機材の準備\ntags: [総務]",
        "# 新メンバー受け入れ\n\n[[security]] を先に読んでもらう。\n\n## 初日\n\nPC を渡し、メールとチャットの権限を付ける。\n\n## 一週目\n\n[[glossary]] を読み、担当者と面談する。\n",
    ),
    (
        "security.md",
        "type: Reference\ntitle: セキュリティ方針\ndescription: パスワード規則と二要素認証\ntags: [総務]",
        "# セキュリティ方針\n\n## 規則\n\n12 文字以上。使い回しは禁止。\n\n## 追加の確認\n\nログイン時に、手元の端末に届くコードを入力する。\n",
    ),
    (
        "setup.md",
        "type: Playbook\ntitle: Local setup\ndescription: Installing dependencies and running the dev server\ntags: [dev]",
        "# Local setup\n\nTerms are in [[glossary]].\n\n## Steps\n\nRun the bootstrap script, then start the watcher. The page reloads on save.\n",
    ),
    (
        "meeting-10.md",
        "type: Note\ntitle: 10月定例\ntags: [議事録]",
        "# 10月定例\n\n## 決定\n\nロールバックの件は次回に回す。学割の案内は営業が作る。二要素認証の導入は来月。アカウント発行の遅れは総務が確認。\n\n## 宿題\n\nバックアップの復元を一度試す。チャンクの長さは据え置き。\n",
    ),
    (
        "meeting-11.md",
        "type: Note\ntitle: 11月定例\ntags: [議事録]",
        "# 11月定例\n\n## 決定\n\n当番の連絡順を見直す。install dependencies の手順書は英語のままにする。\n",
    ),
];

struct Case {
    /// The first is the question; the rest are other phrasings an agent would try.
    queries: &'static [&'static str],
    expect: &'static str,
}

const CASES: &[Case] = &[
    // The page says it in its own words.
    Case { queries: &["rsync は何時に動く"], expect: "backup" },
    Case { queries: &["CI がビルドして承認後に反映"], expect: "deploy" },
    Case { queries: &["責任者へ電話する順番"], expect: "oncall" },
    Case { queries: &["年払いはいくら得か"], expect: "pricing" },
    Case { queries: &["bootstrap script and watcher"], expect: "setup" },
    // Only the description (or a tag) uses the asker's word; the meeting
    // notes use it too, in passing.
    Case { queries: &["ロールバックのやり方"], expect: "deploy" },
    Case { queries: &["学割の条件"], expect: "pricing" },
    Case { queries: &["二要素認証の方法"], expect: "security" },
    Case { queries: &["アカウント発行の手順"], expect: "onboarding" },
    Case { queries: &["how to install dependencies"], expect: "setup" },
    Case { queries: &["障害対応の一次対応"], expect: "oncall" },
    // Defined once in the page everything links to, mentioned often elsewhere.
    Case { queries: &["チャンクとは何か"], expect: "glossary" },
    Case { queries: &["索引とは"], expect: "glossary" },
    // The first phrasing shares too little with the page; a second one lands.
    Case { queries: &["データを元の状態にする方法", "バックアップ 復元"], expect: "backup" },
    Case { queries: &["誰に知らせるべきか", "連絡順 当番"], expect: "oncall" },
    Case { queries: &["値段を知りたい", "料金 月額"], expect: "pricing" },
];

struct Scores {
    recall_at_3: f64,
    mrr: f64,
}

fn corpus() -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::Builder::new().prefix("okf-eval-").tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    scaffold_bundle(&root).unwrap();
    for (rel, frontmatter, body) in PAGES {
        let abs = Path::new(&root).join("wiki").join(rel);
        fs::write(abs, format!("---\n{frontmatter}\n---\n\n{body}")).unwrap();
    }
    let mut ws = Workspace::new(WorkspaceOptions { watch: Some(false), ..Default::default() });
    ws.open(&root).unwrap();
    (dir, ws)
}

/// Rank of the expected page among the distinct pages returned, 1-based.
fn rank_of(result: &RetrievalResult, expect: &str) -> Option<usize> {
    let mut pages: Vec<&str> = Vec::new();
    for passage in &result.passages {
        if !pages.contains(&passage.id.as_str()) {
            pages.push(&passage.id);
        }
    }
    pages.iter().position(|id| *id == expect).map(|at| at + 1)
}

fn evaluate(ws: &Workspace, all_phrasings: bool) -> Scores {
    let (mut hits, mut reciprocal) = (0.0, 0.0);
    for case in CASES {
        let extra: Vec<String> =
            if all_phrasings { case.queries[1..].iter().map(|q| q.to_string()).collect() } else { Vec::new() };
        let result = ws.retrieve(case.queries[0], &RetrieveOptions { queries: extra, ..Default::default() }).unwrap();
        let rank = rank_of(&result, case.expect);
        println!("{:>4}  {:<10} {}", rank.map_or("-".to_string(), |r| r.to_string()), case.expect, case.queries.join(" | "));
        if let Some(rank) = rank {
            reciprocal += 1.0 / rank as f64;
            if rank <= 3 {
                hits += 1.0;
            }
        }
    }
    let n = CASES.len() as f64;
    let scores = Scores { recall_at_3: hits / n, mrr: reciprocal / n };
    println!("recall@3 {:.3}   MRR {:.3}   (all phrasings: {all_phrasings})\n", scores.recall_at_3, scores.mrr);
    scores
}

#[test]
fn rag_eval_holds_its_floor() {
    let (_dir, ws) = corpus();
    let single = evaluate(&ws, false);
    let multi = evaluate(&ws, true);

    // Measured when the ranking was last tuned (before page context, link
    // boost and the looser coverage rule: 0.375 / 0.375 on both). A change
    // that drops below either has made retrieval worse on these cases.
    assert!(single.recall_at_3 >= SINGLE_RECALL_FLOOR, "recall@3 {}", single.recall_at_3);
    assert!(single.mrr >= SINGLE_MRR_FLOOR, "MRR {}", single.mrr);
    assert!(multi.recall_at_3 >= MULTI_RECALL_FLOOR, "recall@3 with phrasings {}", multi.recall_at_3);
    assert!(multi.mrr >= MULTI_MRR_FLOOR, "MRR with phrasings {}", multi.mrr);
}

const SINGLE_RECALL_FLOOR: f64 = 0.75;
const SINGLE_MRR_FLOOR: f64 = 0.74;
const MULTI_RECALL_FLOOR: f64 = 0.93;
const MULTI_MRR_FLOOR: f64 = 0.87;
