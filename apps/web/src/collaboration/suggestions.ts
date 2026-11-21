import { Cursor, type LoroDoc } from "loro-crdt/base64";
import type { DraftSuggestionResponse } from "../api/client.ts";

/** What a suggestion does to the text it points at. */
export type SuggestionChange = "replace" | "add" | "remove";

/** The states a person still has something to do about: the rest have left the list. */
const LISTED: ReadonlySet<DraftSuggestionResponse["state"]> = new Set([
  "waiting",
  "no_longer_fits",
  "unknown",
]);

/** The suggestions to show: waiting, no longer fitting, or of unknown outcome. */
export function listedSuggestions(
  items: readonly DraftSuggestionResponse[],
): DraftSuggestionResponse[] {
  return items.filter((item) => LISTED.has(item.state));
}

/** Replace, add or remove: from which of the two texts is empty. */
export function suggestionChange(
  suggestion: Pick<DraftSuggestionResponse, "expectedText" | "replacement">,
): SuggestionChange {
  if (suggestion.expectedText === "") return "add";
  if (suggestion.replacement === "") return "remove";
  return "replace";
}

/** The card's look: what can be done with it. */
export type SuggestionCardKind = "default" | "outdated" | "unknown";

export function cardKind(
  suggestion: Pick<DraftSuggestionResponse, "state">,
): SuggestionCardKind {
  if (suggestion.state === "no_longer_fits") return "outdated";
  if (suggestion.state === "unknown") return "unknown";
  return "default";
}

/** A suggestion's range in the document, or null when it cannot be found any more. */
export function suggestionRange(
  document: LoroDoc,
  suggestion: Pick<DraftSuggestionResponse, "startCursor" | "endCursor">,
): { readonly from: number; readonly to: number } | null {
  try {
    const from = document.getCursorPos(decodeCursor(suggestion.startCursor))
      ?.offset;
    const to = document.getCursorPos(decodeCursor(suggestion.endCursor))
      ?.offset;
    if (from === undefined || to === undefined || to < from) return null;
    return { from, to };
  } catch {
    // An opaque cursor this document cannot read is not a range.
    return null;
  }
}

function decodeCursor(encoded: string): Cursor {
  const binary = atob(encoded);
  return Cursor.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/**
 * The suggestions in the order of the text they point at; those whose range
 * cannot be found come last, oldest first.
 */
export function inDocumentOrder<
  T extends Pick<
    DraftSuggestionResponse,
    "startCursor" | "endCursor" | "createdAt"
  >,
>(document: LoroDoc, items: readonly T[]): T[] {
  const placed = items.map((item) => ({
    item,
    from: suggestionRange(document, item)?.from ?? Number.POSITIVE_INFINITY,
  }));
  placed.sort((a, b) =>
    a.from - b.from ||
    (a.item.createdAt < b.item.createdAt
      ? -1
      : a.item.createdAt > b.item.createdAt
      ? 1
      : 0)
  );
  return placed.map((entry) => entry.item);
}

/** How many suggestions a person has not seen counted before. */
export function newSuggestionCount(
  previous: ReadonlySet<string>,
  current: readonly Pick<DraftSuggestionResponse, "id">[],
): number {
  return current.filter((item) => !previous.has(item.id)).length;
}
