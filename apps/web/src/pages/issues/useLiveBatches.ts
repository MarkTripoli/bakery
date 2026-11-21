import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { BatchListResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { batchesListQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { liveBatches } from "./batch-notice-model.ts";

/** Batches are read 25 at a time, newest first. */
const PAGE_SIZE = 25;
/**
 * The server cannot yet list only the batches that are at work, so with no
 * repository chosen the page reads this many pages (100 batches) looking for
 * them. A chosen repository is read exactly: one batch runs there at a time.
 */
const MAX_PAGES = 4;
/** A live batch moves on its own; the notice follows it. */
const REFRESH_MS = 15_000;

/**
 * The batches the Issues page can speak of, for the repository chosen (or all).
 * Only read for a person who may read batches. A failed read says nothing:
 * the notice is an aid, not the page's content.
 */
export function useLiveBatches(
  options: { readonly repositoryId: string | null; readonly enabled: boolean },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const query = useInfiniteQuery({
    ...batchesListQueryOptions(api, scope, {
      repositoryId: options.repositoryId,
      limit: PAGE_SIZE,
    }),
    enabled: options.enabled && Boolean(scope.organizationId),
    refetchInterval: (state) =>
      liveBatches(state.state.data?.pages.flatMap(itemsOf) ?? []).length > 0
        ? REFRESH_MS
        : false,
    refetchIntervalInBackground: false,
  });
  const pages = query.data?.pages.length ?? 0;
  const more = options.repositoryId === null && query.hasNextPage &&
    !query.isFetchingNextPage && !query.isFetchNextPageError &&
    pages < MAX_PAGES;
  const fetchMore = query.fetchNextPage;
  useEffect(() => {
    if (more) void fetchMore();
  }, [more, pages, fetchMore]);
  return query.isError ? [] : query.data?.pages.flatMap(itemsOf) ?? [];
}

function itemsOf(page: BatchListResponse) {
  return page.items;
}
