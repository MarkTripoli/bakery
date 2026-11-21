import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import {
  organizationQueryOptions,
  organizationsListQueryOptions,
  storageSettingsQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isConflictFailure,
} from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useConnectivity } from "../app/connectivity.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useUnsavedChanges } from "../app/unsaved-changes.tsx";
import { OrganizationSectionBreadcrumbs } from "../shell/SettingsShellSlots.tsx";
import {
  OrganizationStorageScreen,
  storageFieldId,
} from "../screens/OrganizationStorageScreen.tsx";
import type { SecurityAsyncKind } from "../screens/security-async.tsx";
import {
  belowStored,
  defaultDraft,
  draftChanged,
  draftOf,
  type FieldProblem,
  fieldProblem,
  firstProblem,
  putOf,
  STORAGE_FIELDS,
  type StorageDraft,
  type StorageField,
} from "../screens/storage/storage-display.ts";

/**
 * `/organization/storage`. One scoped read of the settings (limits, usage and
 * state); an Admin edits every limit and saves with the version the page last
 * read, so a concurrent edit surfaces as a `conflict` with the draft kept
 * rather than being overwritten. The first save of an organization still on
 * Bakery's defaults has version 0 and sends no `If-Match`. Non-Admins see the
 * values read-only; the server enforces the same rule.
 */
export function OrganizationStoragePage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();

  const organization = useQuery(organizationQueryOptions(api, scope));
  const memberships = useQuery(organizationsListQueryOptions(api, scope));
  const settings = useQuery(storageSettingsQueryOptions(api, scope));

  const connectivity = useConnectivity({
    refetch: settings.refetch,
    refetching: settings.isFetching,
    dataUpdatedAt: settings.dataUpdatedAt,
  });
  const [typed, setTyped] = useState<StorageDraft | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<StorageField>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "conflict" | "forbidden" | "offline" | "failed"
  >("idle");
  // A retry after a transport failure resends the same request; any edit or
  // newer version starts a new one.
  const intent = useRef<{ key: string; version: number; body: string } | null>(
    null,
  );

  const current = settings.data ?? null;
  const draft: StorageDraft = typed ??
    (current === null ? defaultDraft() : draftOf(current));
  const unchanged = current === null || !draftChanged(draft, current);
  useUnsavedChanges(current !== null && typed !== null && !unchanged);
  const role =
    memberships.data?.items.find((item) => item.id === scope.organizationId)
      ?.role ?? null;

  const problems: Partial<Record<StorageField, FieldProblem>> = {};
  if (current !== null) {
    for (const field of STORAGE_FIELDS) {
      if (!attempted && !touched.has(field)) continue;
      const problem = fieldProblem(field, draft[field], current);
      if (problem !== null) problems[field] = problem;
    }
  }

  const edit = (next: StorageDraft) => {
    setSaved(false);
    setSaveState((state) => state === "conflict" ? state : "idle");
    setTyped(next);
  };

  const submit = async () => {
    if (current === null || scope.organizationId === null) return;
    const found = firstProblem(draft, current);
    if (found !== null) {
      setAttempted(true);
      document.getElementById(storageFieldId(found.field))?.focus();
      return;
    }
    const input = putOf(draft, current);
    const body = JSON.stringify(input);
    if (
      intent.current === null || intent.current.version !== current.version ||
      intent.current.body !== body
    ) {
      intent.current = {
        key: crypto.randomUUID(),
        version: current.version,
        body,
      };
    }
    setSaved(false);
    setSaveState("idle");
    const result = await api.storageSettings.put({
      organizationId: scope.organizationId,
      input,
      version: current.version,
      idempotencyKey: intent.current.key,
    });
    if (result.ok) {
      intent.current = null;
      queryClient.setQueryData(
        storageSettingsQueryOptions(api, scope).queryKey,
        result.data,
      );
      setTyped(null);
      setTouched(new Set());
      setAttempted(false);
      setSaved(true);
      return;
    }
    const kind = asyncKindForError(result.error);
    if (isConflictFailure(result.error)) setSaveState("conflict");
    else if (kind === "forbidden") setSaveState("forbidden");
    else if (kind === "offline") setSaveState("offline");
    else setSaveState("failed");
    if (kind !== "offline") intent.current = null;
  };
  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  const reload = () => {
    setSaveState("idle");
    setSaved(false);
    setTyped(null);
    setTouched(new Set());
    setAttempted(false);
    intent.current = null;
    void settings.refetch();
  };

  // With no organization yet, the remembered one is still being restored.
  const async: SecurityAsyncKind | null = scope.organizationId === null
    ? restoring ? "loading" : "empty"
    : settings.isPending
    ? "loading"
    : settings.isError
    ? asyncKindForError(settings.error)
    : saveState === "forbidden"
    ? "forbidden"
    : saveState === "offline"
    ? "offline"
    : asyncKindForConnectivity(connectivity);

  return (
    <>
      <OrganizationSectionBreadcrumbs section="shell.navigation.organizationStorage" />
      <OrganizationStorageScreen
        async={async}
        belowStored={current !== null && belowStored(draft, current)}
        canEdit={role === "admin"}
        conflict={saveState === "conflict"}
        draft={draft}
        onDraftChange={(field, value) => edit({ ...draft, [field]: value })}
        onFieldBlur={(field) => setTouched((now) => new Set([...now, field]))}
        onRefresh={reload}
        onReload={reload}
        onReset={() => {
          edit(defaultDraft());
          setTouched(new Set());
          setAttempted(false);
        }}
        onRetry={reload}
        onSave={() => void runSubmit()}
        organizationName={organization.data?.name ?? ""}
        pending={pending}
        problems={problems}
        saveFailed={saveState === "failed"}
        saved={saved}
        settings={current}
        unchanged={unchanged}
      />
    </>
  );
}
