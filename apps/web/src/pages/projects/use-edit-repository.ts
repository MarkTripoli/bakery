import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type RepositoryResponse, versionEtag } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { outcomeUnknown } from "../library/use-create-draft.ts";
import { type ProjectFailure, projectFailure } from "./useProjectMutations.ts";

/** What the dialog changes: the default branch. */
export type RepositoryEdit = {
  readonly defaultBranch: string;
};

/**
 * Change one repository's default branch (#65, slice 3). One
 * idempotency key per distinct change, so a retry after a lost answer changes
 * nothing twice; only the fields that differ are sent. A conflict (the version
 * moved) is reported as such and the page refreshes to show what is there now.
 */
export function useEditRepository(repository: RepositoryResponse) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<ProjectFailure | null>(null);
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const organizationId = scope.organizationId as string;
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });

  const mutation = useMutation({
    mutationKey: ["repositories.edit"],
    mutationFn: async (edit: RepositoryEdit) => {
      setFailure(null);
      const input: { defaultBranch?: string } = {};
      if (edit.defaultBranch !== repository.defaultBranch) {
        input.defaultBranch = edit.defaultBranch;
      }
      const signature = `${repository.version}:${JSON.stringify(input)}`;
      if (intent.current?.signature !== signature) {
        intent.current = { signature, key: crypto.randomUUID() };
      }
      const result = await api.updateRepository({
        organizationId,
        id: repository.id,
        input,
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
    onSettled: refresh,
  });
  return {
    failure,
    pending: mutation.isPending,
    reload: refresh,
    run: (edit: RepositoryEdit) =>
      mutation.mutateAsync(edit).then(() => true, () => false),
  };
}
