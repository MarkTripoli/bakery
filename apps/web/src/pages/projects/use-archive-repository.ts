import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type RepositoryResponse, versionEtag } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
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
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const organizationId = scope.organizationId as string;

  const mutation = useMutation({
    mutationKey: ["repositories.archive"],
    mutationFn: async (archive: boolean) => {
      if (repository === undefined) throw new Error("repository not loaded");
      setFailure(null);
      const signature = `${archive}:${repository.version}`;
      if (intent.current?.signature !== signature) {
        intent.current = { signature, key: crypto.randomUUID() };
      }
      const result = await api.updateRepository({
        organizationId,
        id: repository.id,
        input: { archivedAt: archive ? new Date().toISOString() : null },
        ifMatch: versionEtag(repository.version),
        idempotencyKey: intent.current.key,
      });
      if (!result.ok) {
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
