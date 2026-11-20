import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { TelemetryDestinationTestResult } from "../api/client.ts";
import { asyncKindForError } from "../app/async-state.ts";
import type { SaveNotice } from "../screens/InstallationMonitoringScreen.tsx";
import {
  MonitoringDestinationScreen,
  type MonitoringDestinationScreenProps,
} from "../screens/MonitoringDestinationScreen.tsx";
import {
  blankDraft,
  type DestinationDraft,
  draftOfDestination,
  type FieldIssues,
  formProblem,
  valuesToSend,
  valuesToTest,
} from "../screens/monitoring/monitoring-display.ts";
import { LeaveGuard } from "./repository-rules/leave-guard.tsx";
import { issuesOf, noticeOf, useMonitoringRead } from "./monitoring-shared.ts";

const LIST = "/installation/monitoring";

type Test = MonitoringDestinationScreenProps["test"];

/**
 * `/installation/monitoring/new` and `/installation/monitoring/{id}`: one
 * destination. Leaving with edits asks first; a save or removal that works
 * returns to the list.
 */
export function MonitoringDestinationPage() {
  const { api, list, kinds, measurements, destinations, refresh } =
    useMonitoringRead();
  const navigate = useNavigate();
  const { destinationId } = useParams({ strict: false }) as {
    destinationId?: string;
  };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const editing = destinationId === undefined
    ? null
    : destinations.find((item) => item.id === destinationId) ?? null;
  const kindId = editing !== null
    ? editing.kind
    : typeof search.kind === "string"
    ? search.kind
    : kinds[0]?.kind;
  const kind = kinds.find((entry) => entry.kind === kindId) ?? null;

  const [draft, setDraft] = useState<DestinationDraft | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [issues, setIssues] = useState<FieldIssues | null>(null);
  const [notice, setNotice] = useState<SaveNotice | null>(null);
  const [test, setTest] = useState<Test>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [done, setDone] = useState(false);
  const loadedFor = useRef<string | null>(null);

  // The draft is read from the server once per destination, and again on Reload.
  const loadDraft = () => {
    if (kind === null || (destinationId !== undefined && editing === null)) {
      return;
    }
    const next = editing === null
      ? blankDraft(kind, measurements)
      : draftOfDestination(editing, kind);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setIssues(null);
    setNotice(null);
    setTest(null);
  };
  const key = destinationId ?? `new:${kindId ?? ""}`;
  useEffect(() => {
    if (loadedFor.current === key || kind === null) return;
    if (destinationId !== undefined && editing === null) return;
    loadedFor.current = key;
    loadDraft();
  });
  useEffect(() => {
    if (done) void navigate({ to: LIST });
  }, [done, navigate]);

  const dirty = draft !== null && baseline !== null &&
    JSON.stringify(draft) !== baseline;

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
    const idempotencyKey = crypto.randomUUID();
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
        idempotencyKey,
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
        idempotencyKey,
      });
    setSaving(false);
    if (result.ok) {
      await refresh();
      setDone(true);
      return;
    }
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
      setTest({
        state: "done",
        result: result.data as TelemetryDestinationTestResult,
      });
      void refresh();
      return;
    }
    const found = issuesOf(result.error);
    if (found !== null) {
      setIssues(found);
      setTest(null);
    } else setTest({ state: "failed", notice: noticeOf(result.error) });
  };
  const toggle = async (enabled: boolean) => {
    if (editing === null) return;
    setTogglePending(true);
    try {
      const result = await api.telemetryDestinations.update({
        id: editing.id,
        input: { enabled },
        version: editing.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) setNotice(noticeOf(result.error));
      await refresh();
    } finally {
      setTogglePending(false);
    }
  };
  const remove = async () => {
    if (editing === null) return;
    setTogglePending(true);
    const result = await api.telemetryDestinations.remove({
      id: editing.id,
      version: editing.version,
      idempotencyKey: crypto.randomUUID(),
    });
    setTogglePending(false);
    setRemoving(false);
    if (result.ok) {
      await refresh();
      setDone(true);
    } else setNotice(noticeOf(result.error));
  };

  const state = list.isPending
    ? "loading"
    : list.isError
    ? asyncKindForError(list.error) === "forbidden" ? "notFound" : "error"
    : destinationId !== undefined && editing === null
    ? "notFound"
    : kind === null
    ? "error"
    : "ready";

  return (
    <>
      <MonitoringDestinationScreen
        draft={draft}
        editing={editing}
        issues={issues}
        kind={kind}
        measurements={measurements}
        notice={notice}
        onCancel={() => void navigate({ to: LIST })}
        onChange={change}
        onReload={() => {
          void refresh();
          loadedFor.current = null;
          setDraft(null);
        }}
        onRemove={() => void remove()}
        onRemoveAsk={setRemoving}
        onRetry={() => void list.refetch()}
        onSave={() => void save()}
        onTest={() => void sendTest()}
        onToggle={(enabled) => void toggle(enabled)}
        removing={removing}
        saving={saving}
        state={state}
        test={test}
        togglePending={togglePending}
      />
      <LeaveGuard
        copy={{
          title: "installation.monitoring.leave.title",
          body: "installation.monitoring.leave.body",
          stay: "installation.monitoring.leave.stay",
          confirm: "installation.monitoring.leave.confirm",
        }}
        count={dirty && !done ? 1 : 0}
        discard={() => undefined}
        path="/installation/monitoring/@never"
      />
    </>
  );
}
