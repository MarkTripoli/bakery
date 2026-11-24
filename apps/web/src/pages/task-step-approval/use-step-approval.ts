import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import {
  approvalsQueryOptions,
  artifactsListQueryOptions,
  artifactVersionsQueryOptions,
  runStepsListQueryOptions,
} from "../../api/query.ts";
import type { ArtifactVersionResponse } from "../../api/client.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { documentVersion, openStepApproval, waitingStep } from "./model.ts";

const DOCUMENT_CANDIDATES = 5;

export function useStepApproval(
  taskId: string,
  runId: string | null,
  options: Readonly<{ withDocument?: boolean }> = {},
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const scoped = scope.organizationId !== null && runId !== null;
  const approvals = useQuery({
    ...approvalsQueryOptions(api, scope, taskId),
    enabled: scoped,
  });
  const approval = runId === null
    ? null
    : openStepApproval(approvals.data?.items ?? [], runId);
  const steps = useQuery({
    ...runStepsListQueryOptions(api, scope, runId ?? "", {
      cursor: undefined,
      limit: 25,
    }),
    enabled: scoped && approval !== null,
  });
  const step = waitingStep(steps.data?.items ?? []);
  const withDocument = options.withDocument === true && approval !== null &&
    steps.data !== undefined;
  const artifacts = useQuery({
    ...artifactsListQueryOptions(api, scope, { taskId, limit: 25 }),
    enabled: scoped && withDocument,
  });
  const candidates = (artifacts.data?.items ?? [])
    .filter((item) => item.taskId === taskId && item.artifactType !== "log")
    .slice(0, DOCUMENT_CANDIDATES);
  const versionReads = useQueries({
    queries: candidates.map((item) => ({
      ...artifactVersionsQueryOptions(api, scope, item.id, { limit: 100 }),
      enabled: scoped && withDocument,
    })),
  });
  const stepIds = useMemo(
    () => new Set((steps.data?.items ?? []).map((item) => item.id)),
    [steps.data],
  );
  const versions: ArtifactVersionResponse[] = versionReads.flatMap((read) =>
    read.data?.items ?? []
  );
  const document = withDocument
    ? documentVersion(versions, stepIds, step?.id ?? null)
    : null;
  const documentPending = withDocument &&
    (artifacts.isPending || versionReads.some((read) => read.isPending));
  return {
    approval,
    step,
    document,
    documentPending,
    refresh: async () => {
      await approvals.refetch();
      await steps.refetch();
    },
    failed: approvals.isError,
  };
}
