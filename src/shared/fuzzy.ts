/**
 * Subsequence fuzzy matching, for the quick switcher and link autocomplete.
 *
 * Kept out of the view layer because it is pure string work: no DOM, so it can
 * be reasoned about and tested on its own.
 */

/**
 * Score `text` against `query`, or null when the query is not a subsequence.
 *
 * Returning null rather than a low score means non-matches are filtered out
 * instead of being ranked to the bottom of a long list.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let at = 0;
  let run = 0;

  for (const char of needle) {
    if (char === " ") continue;
    const found = haystack.indexOf(char, at);
    if (found === -1) return null;

    // Reward adjacency: a contiguous run is far more likely to be what was meant.
    if (found === at && at > 0) run += 1;
    else run = 0;
    score += 1 + run * 2;

    // Reward landing on a word or path boundary.
    const previous = found > 0 ? haystack[found - 1] : undefined;
    if (previous === undefined || previous === "/" || previous === "-" || previous === " ") {
      score += 3;
    }

    at = found + 1;
  }

  // Break ties towards shorter targets: a match in a short title is more
  // likely to be the intended one.
  return score - text.length * 0.01;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Rank items by the best score across several projections of each. */
export function rankByFuzzy<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => readonly string[],
  limit = 50
): T[] {
  const ranked: Array<Ranked<T>> = [];

  for (const item of items) {
    let best = Number.NEGATIVE_INFINITY;
    for (const field of fields(item)) {
      const score = fuzzyScore(field, query);
      if (score !== null && score > best) best = score;
    }
    if (best > Number.NEGATIVE_INFINITY) ranked.push({ item, score: best });
  }

  return ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}
