import { useCallback, useEffect, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiFailure } from "../../api/client.ts";
import { type Identified, mergeCursorItems } from "./identity.ts";
import { runCursorPageRequest } from "./cursor-page-request.ts";

export type CursorPage<Item> = Readonly<{
  items: readonly Item[];
  nextCursor: string | null;
}>;
export type CursorCollection<Item> = Readonly<{
  items: readonly Item[];
  state: "loading" | "error" | "ready";
  hasNext: boolean;
  loadingMore: boolean;
  moreError: boolean;
}>;

export function useCursorPages<Item extends Identified>(
  query: UseQueryResult<CursorPage<Item>, ApiFailure>,
  resetKey: string,
  fetchPage: (cursor: string) => Promise<CursorPage<Item>>,
): CursorCollection<Item> & {
  readonly loadMore: () => void;
  readonly retryMore: () => void;
} {
  const key = `${resetKey}:${query.dataUpdatedAt}`;
  const guard = useRef({ key, generation: 0, inFlight: false });
  const [continuation, setContinuation] = useState<{
    key: string;
    pages: readonly CursorPage<Item>[];
    loading: boolean;
    error: boolean;
  }>({ key, pages: [], loading: false, error: false });
  // Invalidate synchronously: an old promise can settle before passive effects run.
  if (guard.current.key !== key) {
    guard.current.key = key;
    guard.current.generation += 1;
    guard.current.inFlight = false;
  }
  useEffect(() => () => {
    guard.current.generation += 1;
    guard.current.inFlight = false;
  }, []);
  const current = continuation.key === key
    ? continuation
    : { key, pages: [], loading: false, error: false };
  const items = query.isError ? [] : mergeCursorItems([
    ...(query.data === undefined ? [] : [query.data.items]),
    ...current.pages.map((page) => page.items),
  ]);
  const cursor = current.pages.length > 0
    ? current.pages[current.pages.length - 1].nextCursor
    : query.data?.nextCursor ?? null;
  const loadMore = useCallback(() => {
    if (
      cursor === null || guard.current.inFlight || guard.current.key !== key ||
      query.isError || query.isPending
    ) return;
    setContinuation({ ...current, loading: true, error: false });
    void runCursorPageRequest(
      guard.current,
      () => fetchPage(cursor),
      (page) =>
        setContinuation((state) =>
          state.key === key
            ? { ...state, pages: [...state.pages, page] }
            : state
        ),
      () =>
        setContinuation((state) =>
          state.key === key ? { ...state, error: true } : state
        ),
      () =>
        setContinuation((state) =>
          state.key === key ? { ...state, loading: false } : state
        ),
    );
  }, [cursor, current, fetchPage, key, query.isError, query.isPending]);
  return {
    hasNext: !query.isError && cursor !== null,
    items,
    loadMore,
    loadingMore: current.loading,
    moreError: current.error,
    retryMore: loadMore,
    state: query.isPending ? "loading" : query.isError ? "error" : "ready",
  };
}
