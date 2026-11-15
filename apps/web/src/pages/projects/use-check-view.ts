import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RepositoryResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  repositoriesListQueryOptions,
  repositoryCheckQueryOptions,
  repositoryProfileObservationQueryOptions,
  repositoryProfilesListQueryOptions,
  repositoryQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { type CheckView, checkView } from "./check-state.ts";

/**
 * What is known about the readiness check the address names, from its record
 * and its result. The step and the page header read the same one, so what the
 * header says and what the step says never differ. The reads are shared by
 * key: one request each.
 */
export function useCheckView(
  repository: Pick<RepositoryResponse, "id" | "applicationId">,
  checkId: string | null,
  /** False until the repository itself is read: nothing is asked before then. */
  ready: boolean,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const check = useQuery({
    ...repositoryCheckQueryOptions(api, scope, repository.id, checkId ?? ""),
    enabled: ready && scope.organizationId !== null && checkId !== null,
  });
  const finished = check.data?.status === "completed" && !check.isError
    ? check.data
    : null;
  const observation = useQuery({
    ...repositoryProfileObservationQueryOptions(
      api,
      scope,
      repository.applicationId,
      finished,
    ),
    enabled: ready && scope.organizationId !== null &&
      finished?.observationId != null && finished.profileId !== null,
  });
  // A finished check can publish the next version of the settings and put it in
  // use (the server does both when a check completes): read the repository and
  // its versions again, so the page never judges the result against the old one.
  const status = check.data?.status ?? null;
  const checkRecordId = check.data?.id ?? null;
  useEffect(() => {
    if (
      !ready || checkRecordId === null ||
      (status !== "completed" && status !== "failed" && status !== "canceled")
    ) return;
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: repositoryQueryOptions(api, scope, repository.id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: repositoryProfilesListQueryOptions(api, scope, repository.id)
          .queryKey.slice(0, -1),
      }),
      queryClient.invalidateQueries({
        queryKey: repositoriesListQueryOptions(api, scope).queryKey.slice(
          0,
          -1,
        ),
      }),
    ]);
  }, [api, queryClient, ready, repository.id, scope, status, checkRecordId]);
  const view: CheckView = checkView({
    known: checkId !== null,
    onboarding: check.data ?? null,
    readFailed: check.isError,
    observation: observation.data ?? null,
    observationFailed: observation.isError,
  });
  return {
    view,
    /** The version of the settings the result is for, when there is a result. */
    observedProfileId: observation.data?.profileId ?? null,
    observedRevision: observation.data?.profileRevision ?? null,
    /** When the check was started: a version created after it was saved by it. */
    checkCreatedAt: check.data?.createdAt ?? null,
    refetch: () => {
      void check.refetch();
      void observation.refetch();
    },
  };
}

export type CheckInfo = ReturnType<typeof useCheckView>;
