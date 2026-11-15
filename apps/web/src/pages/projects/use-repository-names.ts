import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RoleBindingResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import {
  archiveInput,
  createInput,
  type NameValues,
  updateInput,
} from "./names-state.ts";

/** Why a change to a repository's names did not go through, in the words the sheet has for it. */
export type NamesFailure = "forbidden" | "conflict" | "offline" | "failed";

function failureOf(error: unknown): NamesFailure {
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

type Intent = { readonly signature: string; readonly key: string };

/**
 * The writes behind a repository's names: add, edit, archive and restore.
 * Each keeps one idempotency key while its outcome is unknown (no answer, or a
 * server fault), so a retry after a lost answer cannot add a name twice; a
 * definite refusal takes a new key.
 */
export function useRepositoryNames(
  applicationId: string,
  repositoryId: string,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<NamesFailure | null>(null);
  const intent = useRef<Intent | null>(null);
  const organizationId = scope.organizationId as string;

  const run = async (
    signature: string,
    write: (key: string) => Promise<
      { ok: true } | { ok: false; error: unknown }
    >,
  ) => {
    setFailure(null);
    if (intent.current?.signature !== signature) {
      intent.current = { signature, key: crypto.randomUUID() };
    }
    const result = await write(intent.current.key);
    if (!result.ok) {
      const status = failureStatus(result.error);
      if (status !== null && status < 500) intent.current = null;
      setFailure(failureOf(result.error));
      throw result.error;
    }
    intent.current = null;
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  };

  const add = useMutation({
    mutationKey: ["repositoryNames.add", repositoryId],
    mutationFn: (values: NameValues) =>
      run(`add:${JSON.stringify(values)}`, async (key) => {
        const result = await api.createRepositoryRole({
          organizationId,
          input: createInput(applicationId, repositoryId, values),
          idempotencyKey: key,
        });
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }),
  });
  const edit = useMutation({
    mutationKey: ["repositoryNames.edit", repositoryId],
    mutationFn: (
      { binding, values }: {
        binding: RoleBindingResponse;
        values: NameValues;
      },
    ) =>
      run(
        `edit:${binding.id}:${binding.version}:${JSON.stringify(values)}`,
        async (key) => {
          const result = await api.updateRepositoryRole({
            organizationId,
            applicationId,
            roleId: binding.id,
            input: updateInput(binding, values),
            idempotencyKey: key,
          });
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        },
      ),
  });
  const archive = useMutation({
    mutationKey: ["repositoryNames.archive", repositoryId],
    mutationFn: (binding: RoleBindingResponse) =>
      run(`archive:${binding.id}:${binding.version}`, async (key) => {
        const result = await api.updateRepositoryRole({
          organizationId,
          applicationId,
          roleId: binding.id,
          input: archiveInput(binding, new Date()),
          idempotencyKey: key,
        });
        return result.ok ? { ok: true } : { ok: false, error: result.error };
      }),
  });

  const settle = (promise: Promise<unknown>) =>
    promise.then(() => true, () => false);
  return {
    failure,
    clearFailure: () => setFailure(null),
    pending: add.isPending || edit.isPending || archive.isPending,
    add: (values: NameValues) => settle(add.mutateAsync(values)),
    edit: (binding: RoleBindingResponse, values: NameValues) =>
      settle(edit.mutateAsync({ binding, values })),
    archive: (binding: RoleBindingResponse) =>
      settle(archive.mutateAsync(binding)),
  };
}
