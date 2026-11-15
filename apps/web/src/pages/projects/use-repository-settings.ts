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
import { saveWorkingSettings } from "./repository-save.ts";
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
  | "branchesLocked"
  | "rejected"
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
    // The repository's policy fixes its branches for the policy's revision.
    case 422:
      return issueCodesOf(error).includes("repository_branches_locked")
        ? "branchesLocked"
        : "rejected";
    // The server did not accept the values.
    case 400:
      return "rejected";
    default:
      return "failed";
  }
}

/** The codes of the issues a refusal names, when it names any. */
function issueCodesOf(error: unknown): readonly string[] {
  if (typeof error !== "object" || error === null) return [];
  const problem = (error as { problem?: { issueCodes?: readonly string[] } })
    .problem;
  return problem?.issueCodes ?? [];
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

  const putInUse = async (
    profile: RepositoryProfileResponse,
    version: number,
  ) => {
    const result = await api.updateRepository({
      organizationId,
      id: repository.id,
      input: { activeProfileId: profile.id },
      ifMatch: versionEtag(version),
      idempotencyKey: keyFor(useIntent, `${profile.id}:${version}`),
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
      const signature = `${input.revision}:${await configDigest(
        settingsConfig(input.previous?.config ?? null, {
          base: repository.defaultBranch,
          branches: input.branches,
          folder: input.folder,
        }),
      )}`;
      const result = await saveWorkingSettings(api, {
        organizationId,
        repository,
        previous: input.previous,
        revision: input.revision,
        branches: input.branches,
        folder: input.folder,
        createKey: keyFor(saveIntent, signature),
        useKey: (profileId, version) =>
          keyFor(useIntent, `${profileId}:${version}`),
      });
      if (result.ok) {
        saveIntent.current = null;
        useIntent.current = null;
        refresh();
        return;
      }
      if (result.step === "create") {
        if (!outcomeUnknown(result.error)) saveIntent.current = null;
        setFailure({ kind: failureOf(result.error) });
        throw result.error;
      }
      // A version was saved, whatever went wrong after it: never "nothing was applied".
      saveIntent.current = null;
      if (!outcomeUnknown(result.error)) useIntent.current = null;
      setFailure({ kind: "savedNotUsed", version: result.profile.revision });
      refresh();
      throw result.error;
    },
  });

  const use = useMutation({
    mutationKey: ["repositories.useProfile"],
    mutationFn: async (profile: RepositoryProfileResponse) => {
      setFailure(null);
      try {
        await putInUse(profile, repository.version);
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
