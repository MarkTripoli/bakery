import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import {
  approvalsQueryOptions,
  conversationParticipantsQueryOptions,
  runStepsListQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { runQueryOptions } from "../../api/query.ts";
import { rereadRequests } from "../task-requests/reread.ts";
import { approvalStep, latestStepApproval, openStepApproval } from "./model.ts";

export function useStepApproval(taskId: string, runId: string | null) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const cache = useQueryClient();
  const scoped = scope.organizationId !== null && runId !== null;
  const approvals = useQuery({
    ...approvalsQueryOptions(api, scope, taskId),
    enabled: scoped,
  });
  const items = approvals.data?.items ?? [];
  const approval = runId === null ? null : openStepApproval(items, runId);
  const latest = runId === null ? null : latestStepApproval(items, runId);
  const firstSteps = runStepsListQueryOptions(api, scope, runId ?? "", {
    cursor: undefined,
    limit: 25,
  });
  const steps = useQuery({
    ...firstSteps,
    queryFn: async (context) => {
      let page = await firstSteps.queryFn!(context);
      while (
        !page.items.some((item) => item.status === "waiting") &&
        page.nextCursor !== null
      ) {
        page = await runStepsListQueryOptions(api, scope, runId ?? "", {
          cursor: page.nextCursor,
          limit: 25,
        }).queryFn!(context);
      }
      return page;
    },
    enabled: scoped && latest !== null,
  });
  const step = approvalStep(steps.data?.items ?? []);
  const participants = useQuery({
    ...conversationParticipantsQueryOptions(
      api,
      scope,
      latest?.conversationId ?? "",
    ),
    enabled: scoped && latest !== null && latest.decidedBy !== null,
  });
  const nameOf = (principalId: string | null): string | null =>
    principalId === null
      ? null
      : participants.data?.items.find((item) =>
        item.principalId === principalId
      )?.displayName ?? null;
  return {
    approval,
    latest,
    step,
    nameOf,
    refresh: async () => {
      await approvals.refetch();
      await steps.refetch();
      await rereadRequests(cache, scope.organizationId, runId);
      if (runId !== null) {
        await cache.invalidateQueries({
          queryKey: runQueryOptions(api, scope, runId).queryKey,
        });
      }
    },
  };
}
