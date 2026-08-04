/**
 * Skill parsing and selection.
 *
 * Selection is the part that decides whether SkillSpace saves tokens or wastes
 * them, so most of this is about ranking the *right* skill first — especially
 * in Japanese, where a wrong tokenizer silently ranks everything at zero.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_DESCRIPTION_LENGTH,
  estimateTokens,
  parseSkill,
  serializeSkill,
} from "../src/shared/okf/skill";
import { rankSkills, selectionConfidence, tokenize } from "../src/shared/okf/skill-rank";

const SKILL = `---
name: okf-ingest
description: raw/ の資料を wiki/ に取り込んで整理する手順。
when: [取り込み, ingest, 議事録]
tags: [ingest, workflow]
allowed-tools: [read_file, write_file]
---

# 取り込み手順

1. read_agents_md を呼ぶ
`;

describe("parsing SKILL.md", () => {
  test("reads the routing fields and the body", () => {
    const skill = parseSkill(SKILL, "okf-ingest");

    expect(skill.name).toBe("okf-ingest");
    expect(skill.description).toBe("raw/ の資料を wiki/ に取り込んで整理する手順。");
    expect(skill.when).toEqual(["取り込み", "ingest", "議事録"]);
    expect(skill.tags).toEqual(["ingest", "workflow"]);
    expect(skill.allowedTools).toEqual(["read_file", "write_file"]);
    expect(skill.body).toStartWith("# 取り込み手順");
    expect(skill.warnings).toEqual([]);
  });

  test("accepts block lists as well as flow lists", () => {
    const skill = parseSkill(
      `---
name: a-skill
description: テスト
when:
  - 取り込み
  - "引用符つき"
---

body`,
      "a-skill"
    );

    expect(skill.when).toEqual(["取り込み", "引用符つき"]);
  });

  test("a skill with no frontmatter still loads, with a warning", () => {
    // A half-written skill must not break discovery for the ones beside it.
    const skill = parseSkill("just a body", "draft");

    expect(skill.name).toBe("draft");
    expect(skill.body).toBe("just a body");
    expect(skill.warnings.join()).toContain("frontmatter");
  });

  test("warns when name disagrees with the folder", () => {
    const skill = parseSkill(`---\nname: other\ndescription: x\n---\n`, "actual");

    expect(skill.name).toBe("other");
    expect(skill.warnings.join()).toContain("actual");
  });

  test("warns about a description too long to keep in context", () => {
    const long = "あ".repeat(MAX_DESCRIPTION_LENGTH + 1);
    const skill = parseSkill(`---\nname: x\ndescription: ${long}\n---\n`, "x");

    expect(skill.warnings.join()).toContain("description が長すぎます");
  });

  test("warns about a name that cannot be used as an id", () => {
    expect(parseSkill(`---\nname: Bad Name\ndescription: x\n---\n`, "Bad Name").warnings.join()).toContain(
      "英小文字"
    );
  });

  test("round-trips through serialize", () => {
    const skill = parseSkill(SKILL, "okf-ingest");
    const again = parseSkill(serializeSkill(skill), "okf-ingest");

    expect(again.description).toBe(skill.description);
    expect(again.when).toEqual(skill.when);
    expect(again.allowedTools).toEqual(skill.allowedTools);
    expect(again.body).toBe(skill.body);
  });
});

describe("estimating cost", () => {
  test("Japanese costs far more per character than English", () => {
    // The whole budget story depends on not treating these as equal.
    const ja = estimateTokens("日本語のテキスト");
    const en = estimateTokens("english text here");

    expect(ja).toBeGreaterThan(en);
  });

  test("empty text is free", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("tokenizing for selection", () => {
  test("Japanese becomes overlapping bigrams so it matches inside a phrase", () => {
    expect(tokenize("知識ベース")).toContain("知識");
    expect(tokenize("知識ベースの設計")).toContain("知識");
  });

  test("mixed scripts split at the boundary", () => {
    const terms = tokenize("Notion取り込み");
    expect(terms).toContain("notion");
    expect(terms).toContain("取り");
  });

  test("latin words are lowercased whole", () => {
    expect(tokenize("Ingest SOURCES")).toEqual(["ingest", "sources"]);
  });
});

describe("ranking skills", () => {
  const skills = [
    {
      name: "okf-ingest",
      description: "raw/ の資料を wiki/ に取り込んで整理する手順。",
      when: ["取り込み", "ingest", "議事録"],
      tags: ["workflow"],
    },
    {
      name: "japanese-search",
      description: "日本語で検索が効かないときの調べ方。",
      when: ["検索", "search", "ヒットしない"],
      tags: ["search"],
    },
    {
      name: "conformance-audit",
      description: "OKF v0.2 準拠を条文ごとに監査する。",
      when: ["準拠", "conformance"],
      tags: ["quality"],
    },
  ];

  test("picks the ingest skill for a Japanese ingest request", () => {
    const ranked = rankSkills("Notion からエクスポートした議事録を取り込みたい", skills);

    expect(ranked[0]?.skill.name).toBe("okf-ingest");
  });

  test("picks the search skill for a Japanese search complaint", () => {
    const ranked = rankSkills("検索してもヒットしない", skills);

    expect(ranked[0]?.skill.name).toBe("japanese-search");
  });

  test("works in English too", () => {
    expect(rankSkills("ingest sources into the wiki", skills)[0]?.skill.name).toBe("okf-ingest");
    expect(rankSkills("audit conformance", skills)[0]?.skill.name).toBe("conformance-audit");
  });

  test("skills that match nothing are dropped, not returned with score zero", () => {
    // Returning an irrelevant candidate invites a wasted skill_open.
    expect(rankSkills("天気はどうですか", skills)).toEqual([]);
  });

  test("an empty task matches nothing", () => {
    expect(rankSkills("", skills)).toEqual([]);
    expect(rankSkills("   ", skills)).toEqual([]);
  });

  test("limit caps the candidate list", () => {
    const ranked = rankSkills("取り込み 検索 準拠", skills, { limit: 2 });
    expect(ranked.length).toBeLessThanOrEqual(2);
  });

  test("reports which terms matched, so the choice can be explained", () => {
    const ranked = rankSkills("ingest", skills);
    expect(ranked[0]?.matched).toContain("ingest");
  });

  test("a `when` hit outranks a description hit", () => {
    // `when` holds the words a request uses; descriptions are explanatory prose.
    const candidates = [
      { name: "by-description", description: "議事録を扱います", when: [] },
      { name: "by-when", description: "無関係な説明文", when: ["議事録"] },
    ];

    expect(rankSkills("議事録", candidates)[0]?.skill.name).toBe("by-when");
  });
});

describe("selection confidence", () => {
  const ranked = (scores: number[]) =>
    scores.map((score) => ({
      skill: { name: `s${score}`, description: "" },
      score,
      matched: ["x"],
    }));

  test("a clear winner is high confidence", () => {
    expect(selectionConfidence(ranked([10, 2]))).toBe("high");
  });

  test("a near tie is low confidence, so the agent should compare", () => {
    expect(selectionConfidence(ranked([10, 9.5]))).toBe("low");
  });

  test("nothing found is low confidence", () => {
    expect(selectionConfidence([])).toBe("low");
  });

  test("a single strong result is high confidence", () => {
    expect(selectionConfidence(ranked([5]))).toBe("high");
  });
});
