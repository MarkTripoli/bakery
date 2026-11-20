import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import type {
  ApiFailure,
  TelemetryDestination,
  TelemetryDestinationTestResult,
} from "../api/client.ts";
import { telemetryDestinationsQueryOptions } from "../api/query.ts";
import { asyncKindForError, failureStatus } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  InstallationMonitoringScreen,
  type MonitoringDialog,
  type SaveNotice,
} from "../screens/InstallationMonitoringScreen.tsx";
import {
  blankDraft,
  type DestinationDraft,
  destinationsOf,
  draftOfDestination,
  type FieldIssues,
  formProblem,
  issuesByField,
  kindsOf,
  measurementsOf,
  valuesToSend,
  valuesToTest,
} from "../screens/monitoring/monitoring-display.ts";

/** What a refused change says, from the server's answer. */
function noticeOf(error: ApiFailure): SaveNotice {
  const status = failureStatus(error);
  if (status === 412) return "conflict";
  if (error.kind === "problem" && status === 409) {
    const reason = error.problem.reason;
    if (reason === "name_taken") return "nameTaken";
    if (reason === "destination_limit") return "limit";
    if (reason === "secrets_key_unavailable") return "noKey";
  }
  if (error.kind === "network") return "offline";
  return "failed";
}

/** The field messages of a 422, or none. */
function issuesOf(error: ApiFailure): FieldIssues | null {
  return error.kind === "problem" && error.problem.status === 422 &&
      error.problem.issues !== undefined
    ? issuesByField(error.problem.issues)
    : null;
}

/**
 * `/installation/monitoring`: where Bakery sends its measurements. The page
 * and its form are built from one read (kinds, measurements, destinations), so
 * a new kind on the server needs no change here. Every save, switch, removal
 * and test reads the list again; the list also refreshes every 15 seconds.
 */
export function InstallationMonitoringPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const options = telemetryDestinationsQueryOptions(api, scope);
  const list = useQuery(options);
  const [dialog, setDialog] = useState<MonitoringDialog | null>(null);
  const [draft, setDraft] = useState<DestinationDraft | null>(null);
  const [issues, setIssues] = useState<FieldIssues | null>(null);
  const [notice, setNotice] = useState<SaveNotice | null>(null);
  const [test, setTest] = useState<
    | { readonly state: "sending" }
    | {
      readonly state: "done";
      readonly result: TelemetryDestinationTestResult;
    }
    | { readonly state: "failed"; readonly notice: SaveNotice }
    | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<TelemetryDestination | null>(null);
  const [rowNotice, setRowNotice] = useState<SaveNotice | null>(null);
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);
  const lastSaveFailed = useRef(false);

  const data = list.data;
  const kinds = data === undefined ? [] : kindsOf(data);
  const measurements = data === undefined ? [] : measurementsOf(data);
  const destinations = data === undefined ? [] : destinationsOf(data);
  const editing = dialog?.mode === "edit"
    ? destinations.find((item) => item.id === dialog.id) ?? null
    : null;
  const kind = dialog === null
    ? null
    : kinds.find((entry) =>
      entry.kind === (dialog.mode === "add" ? dialog.kind : editing?.kind)
    ) ?? null;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: options.queryKey });
  const resetDialog = () => {
    setDialog(null);
    setDraft(null);
    setIssues(null);
    setNotice(null);
    setTest(null);
    lastSaveFailed.current = false;
  };

  const openAdd = (kindId: string) => {
    const chosen = kinds.find((entry) => entry.kind === kindId);
    if (chosen === undefined) return;
    resetDialog();
    setDraft(blankDraft(chosen, measurements));
    setDialog({ mode: "add", kind: kindId });
  };
  const openEdit = (destination: TelemetryDestination) => {
    const chosen = kinds.find((entry) => entry.kind === destination.kind);
    if (chosen === undefined) return;
    resetDialog();
    setDraft(draftOfDestination(destination, chosen));
    setDialog({ mode: "edit", id: destination.id });
  };
  const change = (next: DestinationDraft) => {
    setDraft(next);
    setTest(null);
    setIssues(null);
    if (notice !== "conflict") setNotice(null);
  };

  const save = async () => {
    if (draft === null || kind === null || saving) return;
    if (formProblem(editing, kind, draft) !== null) return;
    setSaving(true);
    setNotice(null);
    setIssues(null);
    const key = crypto.randomUUID();
    const sent = valuesToSend(editing, kind, draft);
    const result = editing === null
      ? await api.telemetryDestinations.create({
        input: {
          kind: kind.kind,
          name: draft.name.trim(),
          measurements: [...draft.measurements],
          values: sent,
          enabled: true,
        },
        idempotencyKey: key,
      })
      : await api.telemetryDestinations.update({
        id: editing.id,
        input: {
          ...(draft.name.trim() !== editing.name
            ? { name: draft.name.trim() }
            : {}),
          measurements: [...draft.measurements],
          ...(Object.keys(sent).length > 0 ? { values: sent } : {}),
        },
        version: editing.version,
        idempotencyKey: key,
      });
    setSaving(false);
    if (result.ok) {
      await refresh();
      resetDialog();
      return;
    }
    lastSaveFailed.current = true;
    const found = issuesOf(result.error);
    if (found !== null) setIssues(found);
    else setNotice(noticeOf(result.error));
  };

  const sendTest = async () => {
    if (draft === null || kind === null) return;
    setTest({ state: "sending" });
    const values = valuesToTest(editing, kind, draft);
    const result = await api.telemetryDestinations.test({
      input: editing === null ? { kind: kind.kind, values } : {
        id: editing.id,
        ...(Object.keys(values).length > 0 ? { values } : {}),
      },
      idempotencyKey: crypto.randomUUID(),
    });
    if (result.ok) {
      setTest({ state: "done", result: result.data });
      void refresh();
      return;
    }
    const found = issuesOf(result.error);
    if (found !== null) {
      setIssues(found);
      setTest(null);
    } else setTest({ state: "failed", notice: noticeOf(result.error) });
  };

  const withPending = async (id: string, work: () => Promise<void>) => {
    setPendingIds((ids) => [...ids, id]);
    try {
      await work();
    } finally {
      setPendingIds((ids) => ids.filter((item) => item !== id));
    }
  };
  const toggle = (destination: TelemetryDestination, enabled: boolean) =>
    withPending(destination.id, async () => {
      setRowNotice(null);
      const result = await api.telemetryDestinations.update({
        id: destination.id,
        input: { enabled },
        version: destination.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) setRowNotice(noticeOf(result.error));
      await refresh();
    });
  const remove = async () => {
    const target = removing;
    if (target === null) return;
    await withPending(target.id, async () => {
      setRowNotice(null);
      const result = await api.telemetryDestinations.remove({
        id: target.id,
        version: target.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) setRowNotice(noticeOf(result.error));
      setRemoving(null);
      if (result.ok && dialog?.mode === "edit" && dialog.id === target.id) {
        resetDialog();
      }
      await refresh();
    });
  };

  const state = list.isPending
    ? "loading"
    : list.isError
    ? asyncKindForError(list.error) === "forbidden" ? "notFound" : "error"
    : "ready";

  return (
    <InstallationMonitoringScreen
      dialog={dialog}
      draft={draft}
      editing={editing}
      kind={kind}
      kinds={kinds}
      measurements={measurements}
      destinations={destinations}
      issues={issues}
      lastUpdatedAt={list.dataUpdatedAt}
      notice={notice}
      onAdd={openAdd}
      onChange={change}
      onClose={resetDialog}
      onEdit={openEdit}
      onReload={() => {
        resetDialog();
        void refresh();
      }}
      onRemove={() => void remove()}
      onRemoveAsk={setRemoving}
      onRetry={() => void list.refetch()}
      onSave={() => void save()}
      onTest={() => void sendTest()}
      onToggle={(destination, enabled) => void toggle(destination, enabled)}
      pendingIds={pendingIds}
      removing={removing}
      rowNotice={rowNotice}
      saving={saving}
      state={state}
      test={test}
    />
  );
}
