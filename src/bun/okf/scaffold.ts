/**
 * Create a new bundle with the full three-layer layout.
 *
 * Scaffolding is idempotent: it never overwrites an existing file, so it is
 * safe to run against a folder that already holds notes in order to add the
 * missing pieces (AGENTS.md, the reserved files, the layer directories).
 */

import { mkdir, stat, writeFile } from "fs/promises";
import { join, resolve } from "path";
import agentsMdTemplate from "../../../templates/AGENTS.md" with { type: "text" };
import helloTemplate from "../../../templates/bundle-skeleton/wiki/hello.md" with { type: "text" };
import ingestSkill from "../../../templates/bundle-skeleton/skills/okf-ingest/SKILL.md" with { type: "text" };
import ingestReference from "../../../templates/bundle-skeleton/skills/okf-ingest/reference.md" with { type: "text" };
import answerSkill from "../../../templates/bundle-skeleton/skills/wiki-answer/SKILL.md" with { type: "text" };
import lintSkill from "../../../templates/bundle-skeleton/skills/wiki-lint/SKILL.md" with { type: "text" };
import loopsReadme from "../../../templates/bundle-skeleton/loops/README.md" with { type: "text" };
import ingestLoop from "../../../templates/bundle-skeleton/loops/ingest-notes.md" with { type: "text" };
import lintLoop from "../../../templates/bundle-skeleton/loops/weekly-lint.md" with { type: "text" };
import { OKF_VERSION, emptyLogMd, renderIndexMd } from "../../shared/okf";
import { LOOPS_DIR, RAG_DIR, RAW_DIR, SKILLS_DIR, WIKI_DIR } from "./paths";
import { PARA_DIRS, PARA_ORDER } from "../../shared/okf/para";
import {
  HUMAN_FILE,
  MAP_FILE,
  renderHumanTemplate,
  renderMap,
  renderTasks,
  TASK_FILE,
} from "../../shared/okf/workspace-files";

const RAW_README = `# raw/ — 元資料を置く場所

エクスポート、議事録、書き起こし、PDF などの原本をここに置きます。

このディレクトリは**不変**です。AI エージェントは読み取り専用でアクセスし、
アプリからの書き込みも拒否されます。整理・要約は \`../${WIKI_DIR}/\` 側で行い、
元資料はそのまま残します。
`;

const RAG_GITIGNORE = `# wiki 層から生成される派生インデックス。削除しても再構築されます。
*
`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write a file only when it is absent. Returns true when it was created. */
async function writeIfMissing(path: string, content: string): Promise<boolean> {
  if (await exists(path)) return false;
  await writeFile(path, content, "utf8");
  return true;
}

export interface ScaffoldResult {
  root: string;
  created: string[];
}

export async function scaffoldBundle(root: string): Promise<ScaffoldResult> {
  const absRoot = resolve(root);
  const created: string[] = [];

  await mkdir(join(absRoot, RAW_DIR), { recursive: true });
  await mkdir(join(absRoot, WIKI_DIR), { recursive: true });
  await mkdir(join(absRoot, RAG_DIR), { recursive: true });
  // skills/ and loops/ live inside the wiki layer: they are curated content
  // about the wiki, not layers of their own.
  const wikiRoot = join(absRoot, WIKI_DIR);

  // PARA, as folders. Numbered so the tree sorts by priority on its own.
  for (const cls of PARA_ORDER) {
    await mkdir(join(wikiRoot, PARA_DIRS[cls]), { recursive: true });
  }

  // Skills are grouped by category: skills/<category>/<name>/SKILL.md
  await mkdir(join(wikiRoot, SKILLS_DIR, "ingest", "okf-ingest"), { recursive: true });
  await mkdir(join(wikiRoot, SKILLS_DIR, "query", "wiki-answer"), { recursive: true });
  await mkdir(join(wikiRoot, SKILLS_DIR, "quality", "wiki-lint"), { recursive: true });
  await mkdir(join(wikiRoot, LOOPS_DIR), { recursive: true });

  const files: Array<[string, string]> = [
    [join(WIKI_DIR, "AGENTS.md"), agentsMdTemplate],
    // The orientation files, at the root beside the layers rather than inside
    // one: they are not the material the layers stage. MAP is what an agent
    // reads first, so it exists from the moment the bundle does; the other two
    // start as templates because an empty prompt is answered and an empty file
    // is not.
    [MAP_FILE, renderMap()],
    [HUMAN_FILE, renderHumanTemplate()],
    [TASK_FILE, renderTasks({ tasks: [], doneEver: 0 })],
    [join(RAW_DIR, "README.md"), RAW_README],
    [join(RAG_DIR, ".gitignore"), RAG_GITIGNORE],
    [join(WIKI_DIR, "index.md"), renderIndexMd(basename(absRoot), [], { okfVersion: OKF_VERSION })],
    [join(WIKI_DIR, "log.md"), emptyLogMd()],
    [join(WIKI_DIR, "hello.md"), helloTemplate],
    // Three starter skills covering the whole cycle: ingest, answer, lint.
    // A SkillSpace with nothing in it teaches nobody what a skill is for.
    [join(WIKI_DIR, SKILLS_DIR, "ingest", "okf-ingest", "SKILL.md"), ingestSkill],
    [join(WIKI_DIR, SKILLS_DIR, "ingest", "okf-ingest", "reference.md"), ingestReference],
    [join(WIKI_DIR, SKILLS_DIR, "query", "wiki-answer", "SKILL.md"), answerSkill],
    [join(WIKI_DIR, SKILLS_DIR, "quality", "wiki-lint", "SKILL.md"), lintSkill],
    [join(WIKI_DIR, LOOPS_DIR, "README.md"), loopsReadme],
    // Two starter designs, so the unit is concrete rather than a concept the
    // user has to invent before they can use it.
    [join(WIKI_DIR, LOOPS_DIR, "ingest-notes.md"), ingestLoop],
    [join(WIKI_DIR, LOOPS_DIR, "weekly-lint.md"), lintLoop],
  ];

  for (const [rel, content] of files) {
    if (await writeIfMissing(join(absRoot, rel), content)) {
      created.push(rel.replace(/\\/g, "/"));
    }
  }

  return { root: absRoot, created };
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
