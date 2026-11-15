import { useQuery } from "@tanstack/react-query";
import type { RepositoryResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  repositoryCheckQueryOptions,
  repositoryProfileObservationQueryOptions,
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
    refetch: () => {
      void check.refetch();
      void observation.refetch();
    },
  };
}

export type CheckInfo = ReturnType<typeof useCheckView>;
