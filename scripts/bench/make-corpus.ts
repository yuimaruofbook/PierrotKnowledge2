/**
 * Generate an identical note corpus for both applications.
 *
 * The same bytes go into both an Obsidian vault and an OKF bundle, so the
 * comparison measures the applications rather than their content. Notes carry
 * frontmatter, wikilinks and Japanese, because those are what each app's
 * indexer actually has to work on.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const [target, countArg] = process.argv.slice(2);
if (!target) {
  console.error("usage: make-corpus.ts <dir> [count]");
  process.exit(2);
}

const COUNT = Number(countArg ?? 300);

const TOPICS = [
  "設計原則", "検索の仕組み", "取り込み手順", "レイヤー分離", "出典管理",
  "日本語対応", "索引の再構築", "リンク解決", "準拠チェック", "エージェント連携",
];
const TYPES = ["Concept", "Entity", "Decision", "Playbook", "Summary", "Reference"];

const BODY = [
  "ローカルの Markdown が正本です。アプリはビューアに過ぎません。",
  "raw/ は不変の原本、wiki/ が正典、.rag/ は派生インデックスです。",
  "CJK は重なり合うバイグラムに展開して索引します。分かち書きは不要です。",
  "未解決リンクはエラーではなく、まだ書いていない知識の可視化です。",
  "検索はページを探すため、取得は質問に答えるためのものです。",
];

await mkdir(target, { recursive: true });

for (let i = 0; i < COUNT; i++) {
  const topic = TOPICS[i % TOPICS.length] as string;
  const type = TYPES[i % TYPES.length] as string;
  const dir = join(target, `section-${String(i % 12).padStart(2, "0")}`);
  await mkdir(dir, { recursive: true });

  // Each note links to three others, so both apps build a real link graph.
  const links = [1, 7, 23]
    .map((step) => `[[note-${String((i + step) % COUNT).padStart(4, "0")}]]`)
    .join(" / ");

  const paragraphs = Array.from(
    { length: 6 },
    (_, p) => `${BODY[(i + p) % BODY.length]} ${topic}に関する第 ${p + 1} 節の記述です。`
  ).join("\n\n");

  const content = [
    "---",
    `type: ${type}`,
    `title: ${topic} ${i}`,
    `description: ${topic} についての検証用ノート`,
    `tags: [bench, ${topic.slice(0, 2)}, group-${i % 8}]`,
    "---",
    "",
    `# ${topic} ${i}`,
    "",
    paragraphs,
    "",
    "## 関連",
    "",
    links,
    "",
    "## 手順",
    "",
    "1. read_agents_md で規約を確認する",
    "2. search で重複を確認する",
    "3. create_concept で作成する",
    "",
  ].join("\n");

  await writeFile(join(dir, `note-${String(i).padStart(4, "0")}.md`), content, "utf8");
}

console.log(`${COUNT} notes -> ${target}`);
