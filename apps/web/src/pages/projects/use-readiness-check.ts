import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { RepositoryResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";

/** Why a readiness check could not be started, in the words the step has for it. */
export type StartFailure = "forbidden" | "conflict" | "offline" | "failed";

export function startFailureOf(error: unknown): StartFailure {
  if (asyncKindForError(error) === "offline") return "offline";
  switch (failureStatus(error)) {
    case 403:
      return "forbidden";
    case 409:
    case 412:
      return "conflict";
    default:
      return "failed";
  }
}

/**
 * Starts a readiness check. One idempotency key is kept while the outcome is
 * unknown (no answer, or a server fault), so a retry after a lost answer
 * cannot start a second check; a definite refusal takes a new key.
 */
export function useStartCheck(
  repository: RepositoryResponse,
  onStarted: (checkId: string) => void,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const key = useRef<string | null>(null);
  const start = useMutation({
    mutationKey: ["repositoryOnboardings.start", repository.id],
    mutationFn: async () => {
      setFailure(null);
      key.current ??= crypto.randomUUID();
      const result = await api.startRepositoryOnboarding({
        organizationId: scope.organizationId as string,
        repositoryId: repository.id,
        idempotencyKey: key.current,
      });
      if (!result.ok) {
        const status = failureStatus(result.error);
        if (status !== null && status < 500) key.current = null;
        setFailure(startFailureOf(result.error));
        throw result.error;
      }
      key.current = null;
      if (result.data.repositoryId !== repository.id) {
        setFailure("failed");
        throw new Error("The check belongs to another repository.");
      }
      onStarted(result.data.id);
    },
  });
  return {
    failure,
    pending: start.isPending,
    start: () => start.mutateAsync().then(() => true, () => false),
  };
}
