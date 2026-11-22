import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type {
  BakeryApiClient,
  TelemetryDestination,
  TelemetryDestinationTestResult,
} from "../api/client.ts";
import { asyncKindForError } from "../app/async-state.ts";
import type { SaveNotice } from "../screens/InstallationMonitoringScreen.tsx";
import {
  MonitoringDestinationScreen,
  type MonitoringDestinationScreenProps,
} from "../screens/MonitoringDestinationScreen.tsx";
import { InstallationBreadcrumbs } from "../shell/SettingsShellSlots.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { MonitoringProviderChooserScreen } from "../screens/MonitoringProviderChooserScreen.tsx";
import {
  blankDraft,
  type DestinationDraft,
  type DestinationKind,
  draftOfDestination,
  type FieldIssues,
  formProblem,
  type MeasurementInfo,
  type ProviderInfo,
  valuesToSend,
  valuesToTest,
} from "../screens/monitoring/monitoring-display.ts";
import { LeaveGuard } from "./repository-rules/leave-guard.tsx";
import {
  issuesOf,
  noticeOf,
  useMonitoringChoices,
  useMonitoringDestination,
} from "./monitoring-shared.ts";

const LIST = "/installation/monitoring";

type Test = MonitoringDestinationScreenProps["test"];

type EditorProps = {
  /** The destination being edited, or null when adding one. */
  readonly editing: TelemetryDestination | null;
  readonly kind: DestinationKind | null;
  readonly provider: ProviderInfo | null;
  readonly measurements: readonly MeasurementInfo[];
  readonly state: "loading" | "error" | "notFound" | "ready";
  readonly api: BakeryApiClient;
  readonly refresh: () => Promise<unknown>;
  readonly onRetry: () => void;
};

/**
 * One destination: the form, its status and its test. Leaving with edits asks
 * first; a save or removal that works returns to the list.
 */
function DestinationEditor(
  { editing, kind, provider, measurements, state, api, refresh, onRetry }:
    EditorProps,
) {
  const navigate = useNavigate();
  const destinationId = editing?.id;
  const kindId = kind?.kind;
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
    if (kind === null) return;
    const next = editing === null
      ? blankDraft(kind, measurements, provider?.prefill)
      : draftOfDestination(editing, kind);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setIssues(null);
    setNotice(null);
    setTest(null);
  };
  const key = destinationId ?? `new:${provider?.key ?? kindId ?? ""}`;
  useEffect(() => {
    if (loadedFor.current === key || kind === null) return;
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
          ...(provider === null ? {} : { provider: provider.key }),
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

  return (
    <>
      <MonitoringDestinationScreen
        draft={draft}
        editing={editing}
        issues={issues}
        kind={kind}
        measurements={measurements}
        provider={provider}
        notice={notice}
        onCancel={() => void navigate({ to: LIST })}
        onChange={change}
        onReload={() => {
          // The draft is rebuilt only once the newer read is in, so Reload
          // never shows the old values under the new version.
          void refresh().then(() => {
            loadedFor.current = null;
            setDraft(null);
          });
        }}
        onRemove={() => void remove()}
        onRemoveAsk={setRemoving}
        onRetry={onRetry}
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

function ExistingDestination({ id }: { readonly id: string }) {
  const { api, read, destination, kind, provider, measurements, refresh } =
    useMonitoringDestination(id);
  const state = read.isPending
    ? "loading"
    : read.isError
    ? ["forbidden", "notFound"].includes(asyncKindForError(read.error))
      ? "notFound"
      : "error"
    : destination === null
    ? "notFound"
    : kind === null
    ? "error"
    : "ready";
  return (
    <InstallationBreadcrumbs
      leaf={destination?.name}
      section="shell.navigation.monitoring"
      sectionHref={LIST}
    >
      <DestinationEditor
        api={api}
        editing={destination}
        kind={kind}
        measurements={measurements}
        onRetry={() => void read.refetch()}
        provider={provider}
        refresh={refresh}
        state={state}
      />
    </InstallationBreadcrumbs>
  );
}

function NewDestination(
  { providerKey }: { readonly providerKey: string | null },
) {
  const navigate = useNavigate();
  const { translate } = useI18n();
  const { api, list, kinds, providers, measurements, refresh } =
    useMonitoringChoices();
  const crumbs = (children: ReactNode) => (
    <InstallationBreadcrumbs
      leaf={translate("installation.monitoring.add")}
      section="shell.navigation.monitoring"
      sectionHref={LIST}
    >
      {children}
    </InstallationBreadcrumbs>
  );
  // With one provider there is nothing to choose, so the chooser is skipped.
  const chosen = providers.find((entry) => entry.key === providerKey) ??
    (providers.length === 1 ? providers[0] : null);
  const kind = chosen === null
    ? null
    : kinds.find((entry) => entry.kind === chosen.kind) ?? null;
  if (chosen === null) {
    return crumbs(
      <MonitoringProviderChooserScreen
        onCancel={() => void navigate({ to: LIST })}
        onChoose={(key) =>
          void navigate({
            to: "/installation/monitoring/new",
            search: { provider: key },
          })}
        onRetry={() => void list.refetch()}
        providers={providers}
        state={list.isPending ? "loading" : list.isError ? "error" : "ready"}
      />,
    );
  }
  const state = kind === null ? "error" : "ready";
  return crumbs(
    <DestinationEditor
      api={api}
      editing={null}
      kind={kind}
      measurements={measurements}
      onRetry={() => void list.refetch()}
      provider={chosen}
      refresh={refresh}
      state={state}
    />,
  );
}

/**
 * `/installation/monitoring/new` and `/installation/monitoring/{id}`: a new
 * destination starts at the chooser of providers, then its form; a saved one
 * opens its own page.
 */
export function MonitoringDestinationPage() {
  const { destinationId } = useParams({ strict: false }) as {
    destinationId?: string;
  };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  return destinationId === undefined
    ? (
      <NewDestination
        providerKey={typeof search.provider === "string"
          ? search.provider
          : null}
      />
    )
    : <ExistingDestination id={destinationId} />;
}
