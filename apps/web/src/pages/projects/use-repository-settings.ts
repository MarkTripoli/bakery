import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type RepositoryProfileResponse,
  type RepositoryResponse,
  versionEtag,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { configDigest, settingsConfig } from "./repository-state.ts";

/**
 * Why working settings could not be saved or put in use, so the sheet can say
 * what to do: not allowed, someone else changed the repository, no answer, the
 * server failed, or the version was saved but not put in use.
 */
export type SettingsFailure =
  | "forbidden"
  | "conflict"
  | "offline"
  | "failed"
  | "savedNotUsed"
  | "useFailed";

export function failureOf(error: unknown): SettingsFailure {
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

/** Whether the server may have done a write although the answer was lost (no answer, or a server fault). */
function outcomeUnknown(error: unknown): boolean {
  const status = failureStatus(error);
  return status === null || status >= 500;
}

type Intent = { readonly signature: string; readonly key: string };

/**
 * The two writes behind working settings: a new version of the settings (its
 * number and digest worked out here, never typed), then putting it in use.
 * Each write keeps one idempotency key for as long as its outcome is unknown,
 * so a retry after a lost answer cannot save a second version.
 */
export function useRepositorySettings(repository: RepositoryResponse) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<
    { kind: SettingsFailure; version?: number } | null
  >(null);
  const saveIntent = useRef<Intent | null>(null);
  const useIntent = useRef<Intent | null>(null);
  const organizationId = scope.organizationId as string;

  const keyFor = (slot: { current: Intent | null }, signature: string) => {
    if (slot.current?.signature !== signature) {
      slot.current = { signature, key: crypto.randomUUID() };
    }
    return slot.current.key;
  };
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });

  const putInUse = async (profile: RepositoryProfileResponse) => {
    const result = await api.updateRepository({
      organizationId,
      id: repository.id,
      input: { activeProfileId: profile.id },
      ifMatch: versionEtag(repository.version),
      idempotencyKey: keyFor(
        useIntent,
        `${profile.id}:${repository.version}`,
      ),
    });
    if (!result.ok) {
      if (!outcomeUnknown(result.error)) useIntent.current = null;
      throw result.error;
    }
    useIntent.current = null;
  };

  const save = useMutation({
    mutationKey: ["repositoryProfiles.save"],
    mutationFn: async (
      input: {
        readonly previous: RepositoryProfileResponse | null;
        readonly revision: number;
        readonly branches: readonly string[];
        readonly folder: string;
      },
    ) => {
      setFailure(null);
      const config = settingsConfig(input.previous?.config ?? null, {
        base: repository.defaultBranch,
        branches: input.branches,
        folder: input.folder,
      });
      const digest = await configDigest(config);
      const created = await api.createRepositoryProfile({
        organizationId,
        repositoryId: repository.id,
        input: { revision: input.revision, config, digest },
        idempotencyKey: keyFor(
          saveIntent,
          `${input.revision}:${digest}`,
        ),
      });
      if (!created.ok) {
        if (!outcomeUnknown(created.error)) saveIntent.current = null;
        setFailure({ kind: failureOf(created.error) });
        throw created.error;
      }
      saveIntent.current = null;
      try {
        await putInUse(created.data);
      } catch (error) {
        setFailure({
          kind: failureOf(error) === "conflict" ? "conflict" : "savedNotUsed",
          version: created.data.revision,
        });
        refresh();
        throw error;
      }
      refresh();
    },
  });

  const use = useMutation({
    mutationKey: ["repositories.useProfile"],
    mutationFn: async (profile: RepositoryProfileResponse) => {
      setFailure(null);
      try {
        await putInUse(profile);
      } catch (error) {
        const kind = failureOf(error);
        setFailure({ kind: kind === "failed" ? "useFailed" : kind });
        throw error;
      }
      refresh();
    },
  });

  return {
    failure,
    clearFailure: () => setFailure(null),
    pending: save.isPending || use.isPending,
    save: (input: Parameters<typeof save.mutateAsync>[0]) =>
      save.mutateAsync(input).then(() => true, () => false),
    use: (profile: RepositoryProfileResponse) =>
      use.mutateAsync(profile).then(() => true, () => false),
  };
}
