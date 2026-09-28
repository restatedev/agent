// Local full-text search shared by tool search and memory search. Both build
// a small MiniSearch index in memory and need the same two things: identifiers
// split into words, and a ranking that is stable when scores tie.

import type MiniSearch from "minisearch";

/** Splits camelCase, snake_case, kebab-case and dotted identifiers into words. */
export function words(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_/.-]+/g, " ");
}

/**
 * IDs of every match for `query`, best first. Ties are broken by ID so the
 * order does not depend on insertion order.
 */
export function rankedIds(index: MiniSearch, query: string): string[] {
  const matches = index.search(words(query.trim()));
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return matches.map((match) => String(match.id));
}
