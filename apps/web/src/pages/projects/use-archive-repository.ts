import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type RepositoryResponse, versionEtag } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { outcomeUnknown } from "../library/use-create-draft.ts";
import { type ProjectFailure, projectFailure } from "./useProjectMutations.ts";

/**
 * Archive or restore one repository (#65, slice 3). One idempotency key per
 * intent, so a retry after a lost answer changes nothing twice; a conflict
 * refreshes the page, which then shows what is there now.
 */
export function useArchiveRepository(
  repository: RepositoryResponse | undefined,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<ProjectFailure | null>(null);
  // The key and the time travel together: a replay after a lost answer must
  // send the same body under the same key.
  const intent = useRef<
    { signature: string; key: string; archivedAt: string | null } | null
  >(null);
  const organizationId = scope.organizationId as string;

  const mutation = useMutation({
    mutationKey: ["repositories.archive"],
    mutationFn: async (archive: boolean) => {
      if (repository === undefined) throw new Error("repository not loaded");
      setFailure(null);
      const signature = `${archive}:${repository.version}`;
      if (intent.current?.signature !== signature) {
        intent.current = {
          signature,
          key: crypto.randomUUID(),
          archivedAt: archive ? new Date().toISOString() : null,
        };
      }
      const result = await api.updateRepository({
        organizationId,
        id: repository.id,
        input: { archivedAt: intent.current.archivedAt },
        ifMatch: versionEtag(repository.version),
        idempotencyKey: intent.current.key,
      });
      if (!result.ok) {
        // A definite refusal did not happen: the next try is a new intent.
        if (!outcomeUnknown(result.error)) intent.current = null;
        setFailure(projectFailure(result.error));
        throw result.error;
      }
      intent.current = null;
      return result.data;
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });
  return {
    failure,
    pending: mutation.isPending,
    clearFailure: () => setFailure(null),
    run: (archive: boolean) =>
      mutation.mutateAsync(archive).then(() => true, () => false),
  };
}
