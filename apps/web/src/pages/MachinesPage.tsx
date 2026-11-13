import { useEffect, useState } from "react";
import type { Translator } from "@bakery/i18n";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  WorkerEnrollmentListResponse,
  WorkerResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  workersListQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { FinishingSetup } from "./FinishingSetup.tsx";
import { MachineList } from "./MachineList.tsx";
import { type MachineFilter, machineMatchesFilter } from "./machine-state.ts";

// Above this many machines the list offers a filter; below it, it is just a list.
const FILTER_MIN_MACHINES = 10;

export type EnrollmentToken = Readonly<{
  enrollmentId: string;
  enrollmentToken: string;
  expiresAt: string;
}>;

type MachineRow = WorkerResponse;
type EnrollmentRow = WorkerEnrollmentListResponse["items"][number];

type Readiness = NonNullable<WorkerResponse["readiness"]>;
type Connectivity = NonNullable<WorkerResponse["connectivity"]>;
type WorkerStatus = WorkerResponse["status"];
type EnrollmentState = EnrollmentRow["state"];

export function formatMachineDate(
  value: string | null | undefined,
  locale: string,
  timeZone: string,
  fallback: string,
): string {
  if (!value) return fallback;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

export function boundedReason(reason: string | null | undefined): string {
  const text = reason?.trim() || "";
  if (text.length <= 240) return text;
  return `${text.slice(0, 237)}…`;
}

export function statusForWorker(status: WorkerStatus): UI.Status {
  if (status === "revoked") return "disabled";
  if (status === "offline") return "disconnected";
  if (status === "draining") return "degraded";
  return "active";
}

export function statusForReadiness(
  readiness: Readiness | null | undefined,
): UI.Status {
  if (readiness === "ready") return "healthy";
  if (readiness === "checking") return "active";
  if (readiness === "needs_attention") return "degraded";
  return "disabled";
}

export function toneForConnectivity(
  connectivity: Connectivity | null | undefined,
): UI.StatusDotTone {
  if (connectivity === "online") return "success";
  if (connectivity === "stale") return "warning";
  if (connectivity === "offline") return "destructive";
  return "neutral";
}

function labelForEnrollmentState(
  state: EnrollmentState,
  translate: Translator,
): string {
  return translate(`machines.enrollment.state.${state}` as never);
}

function StateError({
  kind,
  onRetry,
  translate,
}: {
  readonly kind: "offline" | "error";
  readonly onRetry: () => void;
  readonly translate: Translator;
}) {
  return (
    <UI.ErrorState
      title={translate(`machines.${kind}.title` as never)}
      description={translate(`machines.${kind}.description` as never)}
      action={
        <UI.Button variant="secondary" onClick={onRetry}>
          {translate("machines.retry" as never)}
        </UI.Button>
      }
    />
  );
}

export function EnrollmentTokenPanel({
  enrollment,
  onDismiss,
  translate,
  formatDate,
  state,
  workerHostId,
}: {
  readonly enrollment: EnrollmentToken;
  readonly onDismiss: () => void;
  readonly translate: Translator;
  readonly formatDate: (value: string) => string;
  readonly state?: EnrollmentState;
  readonly workerHostId?: string | null;
}) {
  const serverUrl = globalThis.location?.origin ?? "";
  const instructions = [
    `BAKERY_SERVER_URL=${serverUrl}`,
    "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE=/var/lib/bakery/worker/enrollment-token",
    "BAKERY_CLAUDE_HARNESS=1",
    "BAKERY_CLAUDE_HARNESS_REPOSITORY=/workspace/repository",
    "BAKERY_CLAUDE_HARNESS_TIME_LIMIT_MS=120000",
    "BAKERY_CLAUDE_HARNESS_EXECUTABLE=claude",
  ].join("\n");
  const enrollmentState = state ?? "pending";
  return (
    <UI.SettingsSection
      title={translate("machines.enrollment.token.title" as never)}
      variant="stack"
      data-testid="machine-enrollment-token"
    >
      <UI.Stack gap="standard">
        <UI.Heading level="subsection" rank={2}>
          {translate("machines.enrollment.steps.prepare" as never)}
        </UI.Heading>
        <UI.CodeBlock
          code={instructions}
          language="dotenv"
          variant="command"
        />
        <UI.Text variant="muted">
          {translate("machines.enrollment.steps.prepareHint" as never)}
        </UI.Text>

        <UI.Heading level="subsection" rank={2}>
          {translate("machines.enrollment.steps.open" as never)}
        </UI.Heading>
        <UI.Text variant="muted">
          {translate("machines.enrollment.steps.openHint" as never)}
        </UI.Text>

        <UI.Heading level="subsection" rank={2}>
          {translate("machines.enrollment.steps.token" as never)}
        </UI.Heading>
        <UI.AlertBanner tone="warning">
          {translate("machines.enrollment.token.warning" as never)}
        </UI.AlertBanner>
        <UI.Text>
          {translate("machines.enrollment.token.expires" as never, {
            date: formatDate(enrollment.expiresAt),
          })}
        </UI.Text>
        <UI.SetupKey>{enrollment.enrollmentToken}</UI.SetupKey>

        <UI.Heading level="subsection" rank={2}>
          {translate("machines.enrollment.steps.listen" as never)}
        </UI.Heading>
        <UI.Text variant="muted">
          {translate("machines.enrollment.steps.listenHint" as never)}
        </UI.Text>
        <UI.Text variant="muted" role="status" aria-live="polite">
          {translate("machines.enrollment.steps.status" as never, {
            state: labelForEnrollmentState(enrollmentState, translate),
            worker: workerHostId ??
              translate("machines.enrollment.workerPending" as never),
          })}
        </UI.Text>
        <UI.Text variant="caption">
          {translate("machines.enrollment.token.instructions" as never)}
        </UI.Text>
        <UI.Button variant="secondary" onClick={onDismiss}>
          {translate("machines.enrollment.token.dismiss" as never)}
        </UI.Button>
      </UI.Stack>
    </UI.SettingsSection>
  );
}

export function MachinesPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const [workerCursor, setWorkerCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<MachineFilter>("all");
  const workers = useQuery(
    workersListQueryOptions(api, scope, { limit: 100 }),
  );
  const workerContinuationOptions = workersListQueryOptions(api, scope, {
    cursor: workerCursor ?? undefined,
    limit: 100,
  });
  const workerContinuation = useQuery({
    ...workerContinuationOptions,
    queryKey: [...workerContinuationOptions.queryKey, "continuation"] as const,
    enabled: Boolean(scope.organizationId && workerCursor),
  });
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";
  const connectivity = useConnectivity({
    refetch: workers.refetch,
    refetching: workers.isFetching || workerContinuation.isFetching,
    dataUpdatedAt: workers.dataUpdatedAt,
  });
  useEffect(() => {
    setWorkerCursor(null);
  }, [scope.organizationId]);
  const organizationId = scope.organizationId;
  const rows = [
    ...(workers.data?.items ?? []),
    ...(workerContinuation.data?.items ?? []),
  ];
  const visible = rows.filter((row) => machineMatchesFilter(row, filter));
  const nextWorkerCursor = workerContinuation.data?.nextCursor ??
    workers.data?.nextCursor;
  const forbidden = workers.isError && isForbiddenFailure(workers.error);
  // The add action is for an administrator who can read the list at all.
  const canAdd = isAdmin && !forbidden;
  // The empty card carries its own Add machine; everywhere else the page's
  // action is in the top bar (wide) or under the title (phone), on a failed
  // read too, and nowhere when the read is refused.
  const emptyCardShown = !forbidden && !workers.isError &&
    rows.length === 0 && !workers.isPending;
  const connectivityKind = asyncKindForConnectivity(connectivity);
  const phone = useShellViewport() === "phone";
  const openMachine = (row: MachineRow) =>
    void navigate({
      to: "/machines/$machineId",
      params: { machineId: row.id },
    });
  // The page's one primary action: in the top bar on a wide screen, under the
  // title on a phone (the page header hides its actions on a wide one).
  const addMachine = (
    <UI.Button
      variant="primary"
      onClick={() =>
        void navigate({ to: "/machines/new", search: { finish: undefined } })}
    >
      {translate("machines.add" as never)}
    </UI.Button>
  );
  return (
    <>
      <ShellActiveNavigation id="machines" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            { label: translate("shell.states.settingsTitle") },
            { label: translate("shell.navigation.machines") },
          ]}
        />
      </ShellSlot>
      {canAdd && !phone
        ? <ShellSlot name="actions">{addMachine}</ShellSlot>
        : null}
      <UI.SettingsContent data-testid="machines-page">
        <UI.PageHeader
          variant="list"
          title={translate("machines.title")}
          subtitle={translate("machines.description")}
          actions={canAdd && phone && !emptyCardShown ? addMachine : null}
        />
        {connectivityKind
          ? (
            <UI.AlertBanner
              tone={connectivityKind === "offline" ? "warning" : "information"}
            >
              {translate(`machines.${connectivityKind}.description` as never)}
            </UI.AlertBanner>
          )
          : null}
        {organizationId && canAdd
          ? (
            <FinishingSetup
              organizationId={organizationId}
              scope={scope}
              api={api}
              translate={translate}
            />
          )
          : null}
        {forbidden
          ? (
            <UI.EmptyState
              title={translate("machines.forbidden.title")}
              description={translate("machines.forbidden.description")}
              variant="firstUse"
            />
          )
          : workers.isError
          ? (
            <StateError
              kind={asyncKindForError(workers.error) === "offline"
                ? "offline"
                : "error"}
              onRetry={() => void workers.refetch()}
              translate={translate}
            />
          )
          : rows.length === 0 && !workers.isPending
          ? (
            <UI.EmptyState
              title={translate("machines.empty.title")}
              description={translate(
                (isAdmin
                  ? "machines.empty.description"
                  : "machines.empty.adminOnly") as never,
              )}
              action={isAdmin ? addMachine : undefined}
              variant="firstUse"
            />
          )
          : (
            <UI.Stack gap="standard">
              {nextWorkerCursor
                ? (
                  <UI.AlertBanner tone="information">
                    {translate("machines.pagination.truncated" as never, {
                      count: rows.length,
                    })}
                  </UI.AlertBanner>
                )
                : null}
              {rows.length > FILTER_MIN_MACHINES
                ? (
                  <UI.SegmentedControl
                    aria-label={translate("machines.filter.label" as never)}
                    name="machine-filter"
                    variant="inline"
                    value={filter}
                    onChange={(value) => setFilter(value as MachineFilter)}
                    options={(["all", "needsAttention", "offline"] as const)
                      .map((value) => ({
                        value,
                        label: translate(`machines.filter.${value}` as never),
                      }))}
                  />
                )
                : null}
              <MachineList
                rows={visible}
                loading={workers.isPending}
                stale={connectivity !== "online"}
                phone={phone}
                onOpen={openMachine}
                translate={translate}
              />
              {workerContinuation.isError
                ? (
                  <UI.AlertBanner tone="error">
                    {translate("machines.pagination.error" as never)}
                  </UI.AlertBanner>
                )
                : null}
              {nextWorkerCursor
                ? (
                  <UI.Button
                    variant="secondary"
                    disabled={workerContinuation.isFetching}
                    onClick={() =>
                      workerContinuation.isError
                        ? void workerContinuation.refetch()
                        : setWorkerCursor(nextWorkerCursor)}
                  >
                    {workerContinuation.isFetching
                      ? translate("machines.pagination.loadingMore" as never)
                      : translate("machines.pagination.loadMore" as never)}
                  </UI.Button>
                )
                : null}
            </UI.Stack>
          )}
      </UI.SettingsContent>
    </>
  );
}
