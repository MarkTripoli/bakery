import { useEffect } from "react";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import type { MessageListResponse } from "../api/client.ts";

export function useLandingMessageSearch(
  messages: Pick<
    UseInfiniteQueryResult<
      { pages: MessageListResponse[] },
      unknown
    >,
    | "data"
    | "isPending"
    | "isError"
    | "isFetchingNextPage"
    | "hasNextPage"
    | "fetchNextPage"
  >,
  messageId: string | null,
): { loaded: boolean; searching: boolean } {
  const loaded =
    messages.data?.pages.some((page) =>
      page.items.some((message) => message.id === messageId)
    ) ?? false;
  const searching = messageId !== null && !loaded && !messages.isError &&
    (messages.isPending || messages.isFetchingNextPage ||
      messages.hasNextPage === true);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = messages;
  useEffect(() => {
    if (messageId === null || loaded || !hasNextPage || isFetchingNextPage) {
      return;
    }
    void fetchNextPage();
  }, [messageId, loaded, hasNextPage, isFetchingNextPage, fetchNextPage]);
  return { loaded, searching };
}
