import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import type { PluginApproval } from "../../api/client.ts";
import type { PluginScope } from "../../app/plugins.ts";

/** What went wrong with a change, in the words the page has for it. */
export type ChangeFailure =
  | "conflict"
  | "offline"
  | "failed"
  | "changed"
  | "noCopy";

/** Errors this page raises itself for a refusal the server recorded on the install. */
export const APPROVAL_CHANGED = "plugin_approval_changed";
export const NO_STATE_COPY = "plugin_state_snapshot_not_for_version";

export function changeFailureOf(error: unknown): ChangeFailure {
  if (error instanceof Error && error.message === APPROVAL_CHANGED) {
    return "changed";
  }
  if (error instanceof Error && error.message === NO_STATE_COPY) {
    return "noCopy";
  }
  if (asyncKindForError(error) === "offline") return "offline";
  const status = failureStatus(error);
  return status === 409 || status === 412 ? "conflict" : "failed";
}

type Change = {
  readonly versionId?: string;
  readonly status?: "enabled" | "disabled" | "uninstalled";
  readonly dismissUpdateFailure?: boolean;
  readonly approveCapabilities?: PluginApproval;
  readonly restoreState?: boolean;
};

/**
 * The two changes the Plugins pages make: installing a published version, and
 * changing an install (on, off, another version, removed). Both refresh every
 * protected read when they settle, so a page never shows a stale install.
 */
export function usePluginChanges() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const organizationId = scope.organizationId as string;
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });

  const install = useMutation({
    mutationKey: ["pluginInstalls.create"],
    mutationFn: async (
      { packageId, versionId, scope: installScope }: {
        packageId: string;
        versionId: string;
        scope: PluginScope;
      },
    ) => {
      const result = await api.plugins.install({
        organizationId,
        packageId,
        versionId,
        scope: installScope,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });

  const update = useMutation({
    mutationKey: ["pluginInstalls.update"],
    mutationFn: async (
      { id, version, change }: {
        id: string;
        version: number;
        change: Change;
      },
    ) => {
      const result = await api.plugins.update({
        organizationId,
        id,
        version,
        change,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });

  return { install, update, pending: install.isPending || update.isPending };
}
