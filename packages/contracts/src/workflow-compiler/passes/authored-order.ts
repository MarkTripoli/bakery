const AUTHORED: WeakMap<readonly string[], ReadonlyMap<string, number>> =
  new WeakMap();

/** Remembers the authored index of each member of a sorted string set. */
export function rememberAuthoredOrder(
  sorted: readonly string[],
  authored: readonly string[],
): void {
  AUTHORED.set(sorted, new Map(authored.map((item, index) => [item, index])));
}

/**
 * Authored index of a member of a normalized (sorted) string set, so
 * diagnostics point at the entry the author wrote rather than its sorted
 * position. Falls back to the given position for lists built elsewhere.
 */
export function authoredIndexOf(
  sorted: readonly string[],
  value: string,
  fallback: number,
): number {
  return AUTHORED.get(sorted)?.get(value) ?? fallback;
}
