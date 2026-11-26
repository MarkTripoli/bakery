import type { QueryClient } from "@tanstack/react-query";
import type { RunRequestsResponse } from "../../api/client.ts";

export function rereadRequests(
  cache: QueryClient,
  organizationId: string | null,
  currentRunId: string | null,
) {
  return cache.invalidateQueries({
    predicate: ({ queryKey, state }) => {
      const [root, , organization, name, input] = queryKey;
      if (
        root !== "protected" || organization !== organizationId ||
        name !== "runRequests.mine"
      ) {
        return false;
      }
      const held = state.data as RunRequestsResponse | undefined;
      return held === undefined ||
        (input as { id: string }).id === currentRunId ||
        held.requests.some((request) => request.status === "open");
    },
  });
}
