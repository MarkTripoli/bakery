import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { InstallationSettings } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  installationSettingsQueryOptions,
  installationStatusQueryOptions,
  installationUncertainActionsQueryOptions,
  installationUpdatesQueryOptions,
  installationUpdateStatusQueryOptions,
} from "../api/query.ts";
import { isConflictFailure, isForbiddenFailure } from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  InstallationUpdatesScreen,
  type UpdatePolicyValue,
  type UpdatesScreenState,
} from "../screens/InstallationUpdatesScreen.tsx";
import { policyLock, updateRows } from "../screens/updates/update-history.ts";

/**
 * Updates (#59 slice 4): reads the running release, the history and the
 * update policy. The policy is saved as the whole installation settings read,
 * with its version, so a change made on Installation, Settings in between is a
 * 412 and the page shows the latest instead of overwriting it.
 */
export function InstallationUpdatesPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statusOptions = installationUpdateStatusQueryOptions(api, scope);
  const status = useQuery(statusOptions);
  const history = useInfiniteQuery(installationUpdatesQueryOptions(api, scope));
  const uncertain = useQuery(
    installationUncertainActionsQueryOptions(api, scope),
  );
  const settingsOptions = installationSettingsQueryOptions(api, scope);
  const settings = useQuery(settingsOptions);
  const installation = useQuery(installationStatusQueryOptions(api));

  const [draft, setDraft] = useState<UpdatePolicyValue | null>(null);
  const [problem, setProblem] = useState<"conflict" | "failed" | null>(null);
  const [saved, setSaved] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const intent = useRef<{ key: string; version: number; body: string } | null>(
    null,
  );
  const dismissKeys = useRef(new Map<string, string>());
  useEffect(() => {
    setDraft(null);
    setProblem(null);
    setSaved(false);
    intent.current = null;
  }, [scope.sessionGeneration]);

  const base = settings.data;
  const value = draft ?? base?.updateFailurePolicy ?? null;
  const dirty = base !== undefined && draft !== null &&
    draft !== base.updateFailurePolicy;

  const [saving, save] = useSingleFlightSubmit(async () => {
    if (!base || draft === null || !dirty) return;
    const input = {
      registrationMode: base.registrationMode,
      organizationCreationPolicy: base.organizationCreationPolicy,
      updateFailurePolicy: draft,
    };
    const body = JSON.stringify(input);
    if (
      !intent.current || intent.current.version !== base.version ||
      intent.current.body !== body
    ) {
      intent.current = {
        key: crypto.randomUUID(),
        version: base.version,
        body,
      };
    }
    setProblem(null);
    const result = await api.installationSettings.update({
      input,
      version: base.version,
      idempotencyKey: intent.current.key,
    });
    if (result.ok) {
      queryClient.setQueryData<InstallationSettings>(
        settingsOptions.queryKey,
        result.data,
      );
      setDraft(null);
      setSaved(true);
      intent.current = null;
      return;
    }
    if (isConflictFailure(result.error)) {
      // Someone else changed the settings: show the latest, not this choice.
      setProblem("conflict");
      setDraft(null);
      intent.current = null;
      void settings.refetch();
      return;
    }
    setProblem("failed");
  });

  const dismiss = async (id: string) => {
    if (dismissing) return;
    const key = dismissKeys.current.get(id) ?? crypto.randomUUID();
    dismissKeys.current.set(id, key);
    setDismissing(true);
    const result = await api.installationUpdates.dismiss({
      id,
      idempotencyKey: key,
    });
    setDismissing(false);
    if (result.ok) {
      dismissKeys.current.delete(id);
      const current = status.data;
      if (current) {
        queryClient.setQueryData(statusOptions.queryKey, {
          ...current,
          lastFailure: null,
        });
      }
      void history.refetch();
    }
  };

  const events = useMemo(
    () => history.data?.pages.flatMap((page) => page.items) ?? [],
    [history.data],
  );
  const rows = useMemo(() => updateRows(events), [events]);

  const forbidden = status.isError && isForbiddenFailure(status.error as never);
  const state: UpdatesScreenState = forbidden
    ? "notFound"
    : status.isPending
    ? "loading"
    : status.isError
    ? "error"
    : "ready";

  return (
    <InstallationUpdatesScreen
      dismissing={dismissing}
      history={{
        state: history.isPending
          ? "loading"
          : history.isError
          ? "error"
          : "ready",
        rows,
        hasMore: Boolean(history.hasNextPage),
        loadingMore: history.isFetchingNextPage,
      }}
      onDismiss={(id) => void dismiss(id)}
      onLoadMore={() => void history.fetchNextPage()}
      onOpenRestore={() => void navigate({ to: "/installation/restore" })}
      onPolicyChange={(next) => {
        setDraft(next);
        setSaved(false);
        setProblem(null);
      }}
      onRetry={() => {
        void status.refetch();
        void history.refetch();
      }}
      onRetryHistory={() => void history.refetch()}
      onSave={() => void save()}
      onSavedShown={() => setSaved(false)}
      policy={{
        value,
        dirty,
        saving,
        lock: policyLock(installation.data ?? {}),
        problem,
        saved,
      }}
      state={state}
      status={status.data ?? null}
      uncertain={uncertain.data ?? null}
    />
  );
}
