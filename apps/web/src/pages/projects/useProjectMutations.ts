import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ApplicationCreate,
  type ApplicationResponse,
  type ApplicationUpdate,
  type RepositoryCreate,
  versionEtag,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";

/** What went wrong with a change, in the words the page has for it. */
export type ProjectFailure =
  | "conflict"
  | "forbidden"
  | "invalid"
  | "offline"
  | "failed";

/** Maps a failed call to one of the page's few failure words. */
export function projectFailure(error: unknown): ProjectFailure {
  if (asyncKindForError(error) === "offline") return "offline";
  const status = failureStatus(error);
  if (status === 409 || status === 412) return "conflict";
  if (status === 403) return "forbidden";
  if (status === 422) return "invalid";
  return "failed";
}

/**
 * The changes the Projects page makes: a new application, a rename or an
 * archive of one, and a new repository. Each refreshes what the page shows.
 */
export function useProjectMutations() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  const organizationId = scope.organizationId as string;

  const createApplication = useMutation({
    mutationKey: ["applications.create"],
    mutationFn: async (input: ApplicationCreate) => {
      const result = await api.createApplication({
        organizationId,
        input,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: refresh,
  });
  const updateApplication = useMutation({
    mutationKey: ["applications.update"],
    mutationFn: async (
      { application, input }: {
        application: ApplicationResponse;
        input: ApplicationUpdate;
      },
    ) => {
      const result = await api.updateApplication({
        organizationId,
        id: application.id,
        input,
        ifMatch: versionEtag(application.version),
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    // A conflict means someone changed it: show what is there now.
    onSettled: refresh,
  });
  const createRepository = useMutation({
    mutationKey: ["repositories.create"],
    mutationFn: async (input: RepositoryCreate) => {
      const result = await api.createRepository({
        organizationId,
        input,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });
  return { createApplication, createRepository, updateApplication };
}
