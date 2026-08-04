/**
 * Picking the right skill for a request, locally and for free.
 *
 * The agent could do this itself by reading every description — that is the
 * plain Agent Skills behaviour. But descriptions are the one thing that is
 * *always* in context, so their cost grows with every skill added, and the
 * selection gets vaguer as the list grows. Ranking here first means the agent
 * sees a handful of scored candidates instead of the whole catalogue, and the
 * ranking costs no tokens at all.
 *
 * Scoring is BM25-shaped but deliberately simplified: a skill catalogue is tens
 * of documents, not thousands, and the fields are short and hand-written. What
 * actually decides quality here is CJK handling and field weighting, not the
 * saturation curve — so those are what this spends its complexity on.
 */

import { bigrams, containsCjk, isCjk } from "./text";

export interface RankableSkill {
  name: string;
  description: string;
  when?: string[];
  tags?: string[];
}

export interface RankedSkill<T extends RankableSkill = RankableSkill> {
  skill: T;
  score: number;
  /** Query terms that actually matched, so a choice can be explained. */
  matched: string[];
}

/**
 * Field weights.
 *
 * `when` outranks `description` on purpose: `when` is written as the words a
 * *request* would use, whereas a description is written to be read. A hit on
 * the vocabulary someone actually typed is stronger evidence than a hit on
 * explanatory prose.
 */
const WEIGHT_NAME = 6;
const WEIGHT_WHEN = 4;
const WEIGHT_TAG = 3;
const WEIGHT_DESCRIPTION = 1;

/** Saturation: the fourth mention of a term says little the first did not. */
const K1 = 1.2;

/**
 * Split text into comparable terms.
 *
 * Latin words are lowercased whole; CJK runs become overlapping bigrams, which
 * is the same trick the full-text index uses — Japanese has no spaces, so
 * `知識ベース` has to match inside `知識ベースの設計` without a morphological
 * analyser.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  let cjkRun = "";
  let latinRun = "";

  const flushCjk = () => {
    if (!cjkRun) return;
    terms.push(...bigrams(cjkRun));
    cjkRun = "";
  };
  const flushLatin = () => {
    if (!latinRun) return;
    terms.push(latinRun);
    latinRun = "";
  };

  for (const word of text.toLowerCase().split(/[^\p{Letter}\p{Number}]+/u)) {
    if (!word) continue;
    if (!containsCjk(word)) {
      terms.push(word);
      continue;
    }
    // A word may mix scripts with no separator (`Notion取り込み`), so walk it
    // character by character and keep each script's run whole — emitting the
    // Latin part per-character would make `notion` unmatchable.
    for (const char of word) {
      if (isCjk(char)) {
        flushLatin();
        cjkRun += char;
      } else {
        flushCjk();
        latinRun += char;
      }
    }
    flushCjk();
    flushLatin();
  }

  return terms;
}

function fieldScore(queryTerms: readonly string[], fieldText: string, weight: number, matched: Set<string>): number {
  if (!fieldText) return 0;
  const fieldTerms = tokenize(fieldText);
  if (fieldTerms.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const term of fieldTerms) counts.set(term, (counts.get(term) ?? 0) + 1);

  let score = 0;
  for (const term of queryTerms) {
    const count = counts.get(term);
    if (!count) continue;
    matched.add(term);
    // Saturating term frequency, normalised by field length so a long
    // description cannot outrank a precise `when` entry by sheer volume.
    const tf = (count * (K1 + 1)) / (count + K1);
    score += (weight * tf) / Math.sqrt(fieldTerms.length);
  }
  return score;
}

/**
 * Rank skills against a request.
 *
 * Skills that match nothing are dropped rather than returned with score 0:
 * handing an agent an irrelevant candidate invites it to load one, and a wrong
 * `skill_open` costs more than an empty result does.
 */
export function rankSkills<T extends RankableSkill>(
  task: string,
  skills: readonly T[],
  options: { limit?: number } = {}
): RankedSkill<T>[] {
  const queryTerms = [...new Set(tokenize(task))];
  if (queryTerms.length === 0) return [];

  const ranked: RankedSkill<T>[] = [];

  for (const skill of skills) {
    const matched = new Set<string>();
    let score = 0;

    // The name is an identifier, so its hyphens are word boundaries.
    score += fieldScore(queryTerms, skill.name.replace(/-/g, " "), WEIGHT_NAME, matched);
    score += fieldScore(queryTerms, (skill.when ?? []).join(" "), WEIGHT_WHEN, matched);
    score += fieldScore(queryTerms, (skill.tags ?? []).join(" "), WEIGHT_TAG, matched);
    score += fieldScore(queryTerms, skill.description, WEIGHT_DESCRIPTION, matched);

    if (score <= 0) continue;

    // Reward breadth of match: two distinct query terms hitting is a much
    // better signal than one term hitting twice.
    const coverage = matched.size / queryTerms.length;
    ranked.push({
      skill,
      score: score * (0.5 + 0.5 * coverage),
      matched: [...matched],
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return options.limit ? ranked.slice(0, options.limit) : ranked;
}

/**
 * Decide how confident the top choice is.
 *
 * Used to tell an agent whether it can just take the first result or should
 * look at the alternatives. A clear winner means one `skill_open`; a tie means
 * the agent should read the two descriptions before spending on a body.
 */
export function selectionConfidence(ranked: readonly RankedSkill[]): "high" | "medium" | "low" {
  const top = ranked[0];
  if (!top) return "low";
  const second = ranked[1];
  if (!second) return top.score >= 1 ? "high" : "medium";
  const margin = (top.score - second.score) / top.score;
  if (margin >= 0.4) return "high";
  return margin >= 0.15 ? "medium" : "low";
}
