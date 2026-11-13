import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import type { Translator } from "@bakery/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  BakeryApiClient,
  WorkerEnrollmentListResponse,
  WorkerEnrollmentResponse,
  WorkerResponse,
} from "../api/client.ts";
import type { ProtectedScope } from "../app/query-scope.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  workerEnrollmentQueryOptions,
  workerEnrollmentsListQueryOptions,
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
import { usePagedFocus } from "../app/focus.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";

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

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

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

function labelForReadiness(
  readiness: Readiness | null | undefined,
  translate: Translator,
): string {
  if (!readiness) return translate("machines.unknown" as never);
  return translate(`machines.readiness.${readiness}` as never);
}

function labelForConnectivity(
  connectivity: Connectivity | null | undefined,
  translate: Translator,
): string {
  if (!connectivity) return translate("machines.unknown" as never);
  return translate(`machines.connectivity.${connectivity}` as never);
}

function labelForWorkerStatus(
  status: WorkerStatus,
  translate: Translator,
): string {
  return translate(`machines.status.${status}` as never);
}

function labelForEnrollmentState(
  state: EnrollmentState,
  translate: Translator,
): string {
  return translate(`machines.enrollment.state.${state}` as never);
}

function statusForEnrollment(state: EnrollmentState): UI.Status {
  if (state === "pending") return "queued";
  if (state === "consumed") return "healthy";
  if (state === "expired") return "degraded";
  return "disabled";
}

function machineCapabilities(worker: MachineRow, unknown: string): string {
  const values = textList(worker.capabilities);
  return values.length ? values.join(", ") : unknown;
}

function StateError({
  busy = false,
  kind,
  onRetry,
  translate,
}: {
  /** A retry is in flight: the button stays where it is, busy, so focus never leaves it. */
  readonly busy?: boolean;
  readonly kind: "offline" | "error";
  readonly onRetry: () => void;
  readonly translate: Translator;
}) {
  return (
    <UI.ErrorState
      state={busy ? "retrying" : "default"}
      title={translate(`machines.${kind}.title` as never)}
      description={translate(`machines.${kind}.description` as never)}
      action={
        <UI.Button
          aria-busy={busy || undefined}
          variant="secondary"
          onClick={busy ? undefined : onRetry}
          // The paged-focus rule's retry target: a retried first read that
          // fails again puts focus back on this button.
          data-paged-retry="machines"
        >
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

function EnrollmentPanel({
  organizationId,
  isAdmin,
  scope,
  api,
}: {
  readonly organizationId: string;
  readonly isAdmin: boolean;
  readonly scope: ProtectedScope;
  readonly api: BakeryApiClient;
}) {
  const { translate, locale, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const phone = useShellViewport() === "phone";
  const [name, setName] = useState("");
  const [os, setOs] = useState<"linux" | "macos">("linux");
  const [architecture, setArchitecture] = useState("x86_64");
  const [slots, setSlots] = useState("1");
  const [capabilities, setCapabilities] = useState("codex");
  const [token, setToken] = useState<EnrollmentToken | null>(null);
  const [activeEnrollmentId, setActiveEnrollmentId] = useState<string | null>(
    null,
  );
  const [enrollmentCursor, setEnrollmentCursor] = useState<string | null>(null);
  const [validationError, setValidationError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const enrollmentsOptions = workerEnrollmentsListQueryOptions(api, scope, {
    limit: 100,
  });
  const enrollments = useQuery({
    ...enrollmentsOptions,
    enabled: isAdmin && enrollmentsOptions.enabled,
  });
  const enrollmentContinuationOptions = workerEnrollmentsListQueryOptions(
    api,
    scope,
    {
      cursor: enrollmentCursor ?? undefined,
      limit: 100,
    },
  );
  const enrollmentContinuation = useQuery({
    ...enrollmentContinuationOptions,
    queryKey: [
      ...enrollmentContinuationOptions.queryKey,
      "continuation",
    ] as const,
    enabled: isAdmin && Boolean(enrollmentCursor),
  });
  useEffect(() => {
    setEnrollmentCursor(null);
  }, [scope.organizationId]);
  const activeOptions = workerEnrollmentQueryOptions(
    api,
    scope,
    activeEnrollmentId ?? "",
  );
  const active = useQuery({
    ...activeOptions,
    enabled: isAdmin && activeEnrollmentId !== null,
  });
  useEffect(() => () => setToken(null), []);
  useEffect(() => {
    if (active.data?.state !== "consumed") return;
    void queryClient.invalidateQueries({
      queryKey: [
        "protected",
        scope.sessionGeneration,
        scope.organizationId ?? "none",
        "workers.list",
      ],
    });
    void queryClient.invalidateQueries({
      queryKey: [
        "protected",
        scope.sessionGeneration,
        scope.organizationId ?? "none",
        "workerEnrollments.list",
      ],
    });
  }, [
    active.data?.state,
    queryClient,
    scope.organizationId,
    scope.sessionGeneration,
  ]);
  const formatDate = (value: string) =>
    formatMachineDate(
      value,
      locale,
      timeZone,
      translate("machines.never" as never),
    );
  const saveToken = (data: WorkerEnrollmentResponse) => {
    setToken({
      enrollmentId: data.enrollmentId,
      enrollmentToken: data.enrollmentToken,
      expiresAt: data.expiresAt,
    });
    setActiveEnrollmentId(data.enrollmentId);
  };
  const submitEnrollment = async () => {
    const parsedSlots = Number(slots);
    const parsedCapabilities = capabilities.split(",").map((value: string) =>
      value.trim()
    ).filter(Boolean);
    if (!name.trim() || !architecture.trim() || !parsedCapabilities.length) {
      setValidationError(true);
      return;
    }
    setValidationError(false);
    setActionError(false);
    const result = await api.workers.enroll({
      organizationId,
      input: {
        name: name.trim(),
        os,
        architecture: architecture.trim(),
        capabilities: parsedCapabilities,
        slots: Number.isInteger(parsedSlots) && parsedSlots > 0
          ? parsedSlots
          : 1,
      },
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setActionError(true);
      return;
    }
    saveToken(result.data);
    await queryClient.invalidateQueries({
      queryKey: enrollmentsOptions.queryKey,
    });
  };
  const cancelEnrollment = async (row: EnrollmentRow) => {
    setActionError(false);
    const result = await api.workerEnrollments.cancel({
      organizationId,
      id: row.enrollmentId,
      version: row.version,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setActionError(true);
    } else {
      await queryClient.invalidateQueries({
        queryKey: enrollmentsOptions.queryKey,
      });
    }
  };
  const replaceEnrollment = async (row: EnrollmentRow) => {
    setActionError(false);
    const result = await api.workerEnrollments.replace({
      organizationId,
      id: row.enrollmentId,
      version: row.version,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setActionError(true);
      return;
    }
    saveToken(result.data);
    await queryClient.invalidateQueries({
      queryKey: enrollmentsOptions.queryKey,
    });
  };
  // The last page of the continuation ends the list: its null cursor must not
  // fall back to the first page's cursor, which would offer Load more forever.
  const nextEnrollmentCursor = enrollmentContinuation.data
    ? enrollmentContinuation.data.nextCursor
    : enrollments.data?.nextCursor;
  const enrollmentPaging = usePagedFocus("enrollments", {
    pending: enrollmentContinuation.isFetching,
    failed: enrollmentContinuation.isError,
    rowCount: (enrollments.data?.items.length ?? 0) +
      (enrollmentContinuation.data?.items.length ?? 0),
    hasMore: Boolean(nextEnrollmentCursor),
  });
  if (!isAdmin) return null;
  const rows = [
    ...(enrollments.data?.items ?? []),
    ...(enrollmentContinuation.data?.items ?? []),
  ];
  const tableState = enrollments.isPending && rows.length === 0
    ? "loading"
    : enrollments.isError
    ? "error"
    : "ready";
  const actions = (row: EnrollmentRow) => (
    <UI.Inline gap="compact">
      {row.state === "pending"
        ? (
          <UI.Button
            variant="destructive-outline"
            onClick={() => void cancelEnrollment(row)}
          >
            {translate("machines.enrollment.cancel" as never)}
          </UI.Button>
        )
        : null}
      {row.state === "pending"
        ? (
          <UI.Button
            variant="outline"
            onClick={() => void replaceEnrollment(row)}
          >
            {translate("machines.enrollment.replace" as never)}
          </UI.Button>
        )
        : null}
    </UI.Inline>
  );
  return (
    <UI.SettingsSection
      title={translate("machines.enrollment.title" as never)}
      variant="stack"
      data-testid="machine-enrollment"
    >
      <UI.Text variant="muted">
        {translate("machines.enrollment.description" as never)}
      </UI.Text>
      {actionError
        ? (
          <UI.AlertBanner tone="error">
            {translate("machines.enrollment.actionError" as never)}
          </UI.AlertBanner>
        )
        : null}
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void submitEnrollment();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={translate("machines.enrollment.name" as never)}
            htmlFor="machine-enrollment-name"
            required
          >
            <UI.TextInput
              id="machine-enrollment-name"
              name="name"
              type="text"
              autoComplete="off"
              required
              value={name}
              onChange={setName}
            />
          </UI.Field>
          <UI.Inline variant="split">
            <UI.Combobox
              id="machine-enrollment-os"
              name="os"
              label={translate("machines.enrollment.os" as never)}
              value={os}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setOs(event.target.value as "linux" | "macos")}
              options={[
                { value: "linux", label: "Linux" },
                { value: "macos", label: "macOS" },
              ]}
            />
            <UI.Field
              label={translate("machines.enrollment.architecture" as never)}
              htmlFor="machine-enrollment-architecture"
              required
            >
              <UI.TextInput
                id="machine-enrollment-architecture"
                name="architecture"
                type="text"
                autoComplete="off"
                required
                value={architecture}
                onChange={setArchitecture}
              />
            </UI.Field>
          </UI.Inline>
          <UI.Inline variant="split">
            <UI.Field
              label={translate("machines.enrollment.slots" as never)}
              htmlFor="machine-enrollment-slots"
              required
            >
              <UI.TextInput
                id="machine-enrollment-slots"
                name="slots"
                type="number"
                autoComplete="off"
                inputMode="numeric"
                min={1}
                max={100}
                required
                value={slots}
                onChange={setSlots}
              />
            </UI.Field>
            <UI.Field
              label={translate("machines.enrollment.capabilities" as never)}
              htmlFor="machine-enrollment-capabilities"
              hint={translate("machines.enrollment.capabilitiesHint" as never)}
              required
            >
              <UI.TextInput
                id="machine-enrollment-capabilities"
                name="capabilities"
                type="text"
                autoComplete="off"
                required
                value={capabilities}
                onChange={setCapabilities}
              />
            </UI.Field>
          </UI.Inline>
          {validationError
            ? (
              <UI.Text variant="muted">
                {translate("machines.enrollment.validation" as never)}
              </UI.Text>
            )
            : null}
          <UI.Button type="submit" variant="primary">
            {translate("machines.enrollment.submit" as never)}
          </UI.Button>
        </UI.Stack>
      </form>
      {token
        ? (
          <EnrollmentTokenPanel
            enrollment={token}
            onDismiss={() => setToken(null)}
            translate={translate}
            formatDate={formatDate}
            state={active.data?.state}
            workerHostId={active.data?.workerHostId}
          />
        )
        : null}
      {activeEnrollmentId
        ? (
          <UI.DescriptionList data-testid="machine-enrollment-status">
            <UI.DescriptionItem
              title={translate("machines.enrollment.status" as never)}
              description={active.isPending
                ? translate("machines.loading" as never)
                : active.isError
                ? translate("machines.error.title" as never)
                : active.data
                ? labelForEnrollmentState(active.data.state, translate)
                : translate("machines.unknown" as never)}
            />
            {active.data?.workerHostId
              ? (
                <UI.DescriptionItem
                  title={translate("machines.enrollment.worker" as never)}
                  description={active.data.workerHostId}
                />
              )
              : null}
          </UI.DescriptionList>
        )
        : null}
      {nextEnrollmentCursor
        ? (
          <UI.AlertBanner tone="information">
            {translate("machines.pagination.truncated" as never, {
              count: rows.length,
            })}
          </UI.AlertBanner>
        )
        : null}
      {phone && tableState === "loading"
        ? (
          <UI.Text variant="muted" role="status">
            {translate("machines.loading" as never)}
          </UI.Text>
        )
        : phone && tableState === "error"
        ? (
          <UI.Text variant="muted" role="alert">
            {translate("machines.error.description" as never)}
          </UI.Text>
        )
        : phone && rows.length === 0
        ? (
          <UI.Text variant="muted">
            {translate("machines.enrollment.empty" as never)}
          </UI.Text>
        )
        : null}
      {phone
        ? (rows.length > 0 || tableState === "loading") && (
          <UI.Stack
            gap="none"
            role="list"
            data-paged-list="enrollments"
            aria-label={translate("machines.enrollment.table" as never)}
            aria-busy={tableState === "loading" || undefined}
          >
            {rows.map((row) => (
              <div
                key={row.enrollmentId}
                role="listitem"
                data-enrollment-name={row.name}
              >
                <UI.StackedRow
                  title={row.name}
                  status={
                    <UI.StatusBadge status={statusForEnrollment(row.state)}>
                      {labelForEnrollmentState(row.state, translate)}
                    </UI.StatusBadge>
                  }
                >
                  <UI.Text variant="caption">
                    {`${translate("machines.enrollment.expires" as never)}: ${
                      formatDate(row.expiresAt)
                    }`}
                  </UI.Text>
                  {row.state === "pending" ? actions(row) : null}
                </UI.StackedRow>
              </div>
            ))}
          </UI.Stack>
        )
        : (
          <div data-paged-list="enrollments">
            <UI.DataTable<EnrollmentRow>
              caption={translate("machines.enrollment.table" as never)}
              rows={rows}
              state={tableState}
              error={translate("machines.error.description" as never)}
              emptyMessage={translate("machines.enrollment.empty" as never)}
              getRowKey={(row) => row.enrollmentId}
              getRowAttributes={(row) => ({ "data-enrollment-name": row.name })}
              columns={[
                {
                  id: "name",
                  header: translate("machines.enrollment.name" as never),
                  cell: (row) => row.name,
                },
                {
                  id: "status",
                  header: translate("machines.status.label" as never),
                  cell: (row) => (
                    <UI.StatusBadge status={statusForEnrollment(row.state)}>
                      {labelForEnrollmentState(row.state, translate)}
                    </UI.StatusBadge>
                  ),
                },
                {
                  id: "expires",
                  header: translate("machines.enrollment.expires" as never),
                  cell: (row) => formatDate(row.expiresAt),
                },
                {
                  id: "actions",
                  header: translate("machines.enrollment.actions" as never),
                  cell: (row) => (
                    actions(row)
                  ),
                },
              ]}
            />
          </div>
        )}
      {enrollmentContinuation.isError
        ? (
          <UI.AlertBanner tone="error">
            {translate("machines.pagination.error" as never)}
          </UI.AlertBanner>
        )
        : null}
      {nextEnrollmentCursor
        ? (
          <UI.Button
            variant="secondary"
            data-paged-more="enrollments"
            data-paged-retry={enrollmentContinuation.isError
              ? "enrollments"
              : undefined}
            disabled={enrollmentContinuation.isFetching}
            onClick={() => {
              enrollmentPaging.ask("more", enrollments.data?.items.length);
              if (enrollmentContinuation.isError) {
                void enrollmentContinuation.refetch();
              } else setEnrollmentCursor(nextEnrollmentCursor);
            }}
          >
            {enrollmentContinuation.isFetching
              ? translate("machines.pagination.loadingMore" as never)
              : translate("machines.pagination.loadMore" as never)}
          </UI.Button>
        )
        : null}
    </UI.SettingsSection>
  );
}

function MachineCards(
  { pagedList, rows, loading, stale, date, onOpen, translate }: {
    /** Marks the list for the paged-list focus rule. */
    pagedList: string;
    rows: readonly MachineRow[];
    loading: boolean;
    stale: boolean;
    date: (value: string | null | undefined) => string;
    onOpen: (row: MachineRow) => void;
    translate: Translator;
  },
) {
  return (
    <>
      {loading && rows.length === 0
        ? (
          <UI.Text variant="muted" role="status">
            {translate("machines.loading" as never)}
          </UI.Text>
        )
        : null}
      <UI.Stack
        gap="none"
        role="list"
        data-paged-list={pagedList}
        aria-label={translate("machines.table" as never)}
        aria-busy={loading || undefined}
        data-list-state={loading ? "loading" : stale ? "stale" : "ready"}
      >
        {rows.map((row) => (
          <div key={row.id} role="listitem" data-machine-id={row.id}>
            <UI.StackedRow
              title={
                <UI.Button
                  variant="text"
                  onClick={() => onOpen(row)}
                >
                  {row.name}
                </UI.Button>
              }
              status={
                <UI.StatusBadge status={statusForReadiness(row.readiness)}>
                  {labelForReadiness(row.readiness, translate)}
                </UI.StatusBadge>
              }
            >
              <UI.DataText variant="timestamp">
                {`${row.os} · ${row.architecture}`}
              </UI.DataText>
              <UI.Text variant="caption">
                {`${translate("machines.connectivity.label" as never)}: `}
                <UI.StatusDot
                  tone={toneForConnectivity(row.connectivity)}
                  size="small"
                >
                  {labelForConnectivity(row.connectivity, translate)}
                </UI.StatusDot>
              </UI.Text>
              <UI.Text variant="caption">
                {`${translate("machines.status.label" as never)}: ${
                  labelForWorkerStatus(row.status, translate)
                }`}
              </UI.Text>
              <UI.Text variant="caption">
                {`${translate("machines.capabilities" as never)}: ${
                  machineCapabilities(
                    row,
                    translate("machines.unknown" as never),
                  )
                }`}
              </UI.Text>
              <UI.Text variant="caption">
                {`${translate("machines.lastHeartbeat" as never)}: ${
                  date(row.lastHeartbeatAt)
                }`}
              </UI.Text>
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    </>
  );
}

export function MachinesPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const [workerCursor, setWorkerCursor] = useState<string | null>(null);
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
  const date = (value: string | null | undefined) =>
    formatMachineDate(
      value,
      locale,
      timeZone,
      translate("machines.never" as never),
    );
  // As above: the continuation's null cursor ends the list.
  const nextWorkerCursor = workerContinuation.data
    ? workerContinuation.data.nextCursor
    : workers.data?.nextCursor;
  const workerPaging = usePagedFocus("machines", {
    pending: workerContinuation.isFetching || workers.isFetching,
    failed: workerContinuation.isError || workers.isError,
    rowCount: (workers.data?.items.length ?? 0) +
      (workerContinuation.data?.items.length ?? 0),
    hasMore: Boolean(nextWorkerCursor),
  });
  const rows = [
    ...(workers.data?.items ?? []),
    ...(workerContinuation.data?.items ?? []),
  ];
  // A retried first read: the failure stays on screen, with its Retry button
  // busy, until the answer arrives. Without it the button would be replaced by
  // the loading state and focus would fall to the page body for the wait.
  const [retryingFirst, setRetryingFirst] = useState<
    "offline" | "error" | null
  >(
    null,
  );
  const forbidden = workers.isError && isForbiddenFailure(workers.error);
  const connectivityKind = asyncKindForConnectivity(connectivity);
  const phone = useShellViewport() === "phone";
  const openMachine = (row: MachineRow) =>
    void navigate({
      to: "/machines/$machineId",
      params: { machineId: row.id },
    });
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
      <UI.SettingsContent data-testid="machines-page">
        {/* The wrapper is what the first-read retry looks for; the focus goes to its heading. */}
        <div data-paged-heading="machines">
          <UI.PageHeader
            variant="list"
            title={translate("machines.title")}
            subtitle={translate("machines.description")}
            actions={isAdmin
              ? (
                <UI.Button
                  variant="primary"
                  onClick={() =>
                    document.getElementById("machine-enrollment-name")?.focus()}
                >
                  {translate("machines.enrollment.create")}
                </UI.Button>
              )
              : null}
          />
        </div>
        {connectivityKind
          ? (
            <UI.AlertBanner
              tone={connectivityKind === "offline" ? "warning" : "information"}
            >
              {translate(`machines.${connectivityKind}.description` as never)}
            </UI.AlertBanner>
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
          : workers.isError || retryingFirst !== null
          ? (
            <StateError
              busy={retryingFirst !== null}
              kind={retryingFirst ?? (asyncKindForError(workers.error) ===
                  "offline"
                ? "offline"
                : "error")}
              onRetry={() => {
                // A failed first read, retried: focus lands on the page heading
                // when it works, back on Retry when it fails again.
                workerPaging.ask("first");
                setRetryingFirst(
                  asyncKindForError(workers.error) === "offline"
                    ? "offline"
                    : "error",
                );
                void workers.refetch().finally(() => setRetryingFirst(null));
              }}
              translate={translate}
            />
          )
          : rows.length === 0 && !workers.isPending
          ? (
            <UI.EmptyState
              title={translate("machines.empty.title")}
              description={translate("machines.empty.description")}
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
              {phone
                ? (
                  <MachineCards
                    pagedList="machines"
                    rows={rows}
                    loading={workers.isPending}
                    stale={connectivity !== "online"}
                    date={date}
                    onOpen={openMachine}
                    translate={translate}
                  />
                )
                : (
                  <div data-paged-list="machines">
                    <UI.DataTable<MachineRow>
                      caption={translate("machines.table" as never)}
                      rows={rows}
                      state={workers.isPending
                        ? "loading"
                        : connectivity !== "online"
                        ? "stale"
                        : "ready"}
                      emptyMessage={translate(
                        "machines.empty.description" as never,
                      )}
                      getRowKey={(row) => row.id}
                      columns={[
                        {
                          id: "name",
                          header: translate("machines.name" as never),
                          cell: (row) => (
                            <UI.ObjectRow
                              variant="compact"
                              identity={
                                <UI.Button
                                  variant="text"
                                  onClick={() => openMachine(row)}
                                >
                                  {row.name}
                                </UI.Button>
                              }
                              metadata={`${row.os} · ${row.architecture}`}
                              status={
                                <UI.StatusBadge
                                  status={statusForReadiness(row.readiness)}
                                >
                                  {labelForReadiness(row.readiness, translate)}
                                </UI.StatusBadge>
                              }
                            />
                          ),
                        },
                        {
                          id: "readiness",
                          header: translate(
                            "machines.readiness.label" as never,
                          ),
                          cell: (row) => (
                            <UI.StatusBadge
                              status={statusForReadiness(row.readiness)}
                            >
                              {labelForReadiness(row.readiness, translate)}
                            </UI.StatusBadge>
                          ),
                        },
                        {
                          id: "connectivity",
                          header: translate(
                            "machines.connectivity.label" as never,
                          ),
                          cell: (row) => (
                            <UI.StatusDot
                              tone={toneForConnectivity(row.connectivity)}
                              size="small"
                            >
                              {labelForConnectivity(
                                row.connectivity,
                                translate,
                              )}
                            </UI.StatusDot>
                          ),
                        },
                        {
                          id: "status",
                          header: translate("machines.status.label" as never),
                          cell: (row) => (
                            <UI.StatusBadge
                              status={statusForWorker(row.status)}
                            >
                              {labelForWorkerStatus(row.status, translate)}
                            </UI.StatusBadge>
                          ),
                        },
                        {
                          id: "capabilities",
                          header: translate("machines.capabilities" as never),
                          cell: (row) =>
                            machineCapabilities(
                              row,
                              translate("machines.unknown" as never),
                            ),
                        },
                        {
                          id: "heartbeat",
                          header: translate("machines.lastHeartbeat" as never),
                          cell: (row) => date(row.lastHeartbeatAt),
                        },
                      ]}
                    />
                  </div>
                )}
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
                    data-paged-more="machines"
                    data-paged-retry={workerContinuation.isError
                      ? "machines"
                      : undefined}
                    disabled={workerContinuation.isFetching}
                    onClick={() => {
                      workerPaging.ask("more", workers.data?.items.length);
                      if (workerContinuation.isError) {
                        void workerContinuation.refetch();
                      } else setWorkerCursor(nextWorkerCursor);
                    }}
                  >
                    {workerContinuation.isFetching
                      ? translate("machines.pagination.loadingMore" as never)
                      : translate("machines.pagination.loadMore" as never)}
                  </UI.Button>
                )
                : null}
            </UI.Stack>
          )}
        {organizationId && isAdmin
          ? (
            <EnrollmentPanel
              organizationId={organizationId}
              isAdmin={isAdmin}
              scope={scope}
              api={api}
            />
          )
          : null}
        {access.isError && !isAdmin
          ? (
            <UI.Text variant="muted">
              {translate("machines.enrollment.adminOnly")}
            </UI.Text>
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}
