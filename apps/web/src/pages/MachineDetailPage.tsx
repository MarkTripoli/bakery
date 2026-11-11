import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { MessageArguments, MessageKey, Translator } from "@bakery/i18n";
import type {
  BakeryApiClient,
  WorkerProviderBindingListResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  dispatchBlockersQueryOptions,
  effectiveAccessQueryOptions,
  workerComponentsListQueryOptions,
  workerEnrollmentQueryOptions,
  workerProviderAuthQueryOptions,
  workerProviderBindingsListQueryOptions,
  workerQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  boundedReason,
  type EnrollmentToken,
  EnrollmentTokenPanel,
  formatMachineDate,
  statusForReadiness,
  statusForWorker,
  toneForConnectivity,
} from "./MachinesPage.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import {
  dispatchBlockedKey,
  readinessReasonKey,
} from "./machine-dispatch-reason.ts";

function message(
  translate: Translator,
  key: string,
  arguments_?: MessageArguments,
): string {
  return translate(key as MessageKey, arguments_);
}

function values(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function dateLabel(
  value: string | null | undefined,
  locale: string,
  timeZone: string,
  translate: Translator,
): string {
  return formatMachineDate(
    value,
    locale,
    timeZone,
    message(translate, "machines.never"),
  );
}

type ProviderBinding = WorkerProviderBindingListResponse["items"][number];
type AuthAttempt = Readonly<{
  workerId: string;
  bindingId: string;
  authAttemptId: string;
  state: string;
  instructions: string | null;
}>;

function providerAuthLabel(
  binding: ProviderBinding,
  translate: Translator,
): string {
  if (binding.safeProblem) {
    return message(translate, "machines.provider.needsAttention");
  }
  if (binding.lastCheckedAt) {
    return message(translate, "machines.provider.checked");
  }
  return message(translate, "machines.provider.notChecked");
}

function ProviderBindingRow({
  binding,
  workerId,
  organizationId,
  api,
  translate,
  onStarted,
}: {
  readonly binding: ProviderBinding;
  readonly workerId: string;
  readonly organizationId: string;
  readonly api: BakeryApiClient;
  readonly translate: Translator;
  readonly onStarted: (attempt: AuthAttempt) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const start = async () => {
    setBusy(true);
    setFailed(false);
    const result = await api.workerProviderAuth.create({
      organizationId,
      workerId,
      bindingId: binding.id,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    onStarted({
      workerId,
      bindingId: binding.id,
      authAttemptId: result.data.authAttemptId,
      state: result.data.state,
      instructions: result.data.instructions,
    });
  };
  return (
    <UI.DescriptionItem
      title={`${binding.provider} · ${binding.componentKey}`}
      description={[
        binding.enabled
          ? message(translate, "machines.provider.enabled")
          : message(translate, "machines.provider.disabled"),
        binding.billingRoute,
        binding.authMode,
        binding.credentialLocation,
        providerAuthLabel(binding, translate),
      ].join(" · ")}
      action={
        <UI.Inline gap="compact">
          <UI.Button
            variant="outline"
            loading={busy}
            onClick={() => void start()}
          >
            {message(translate, "machines.provider.checkAuth")}
          </UI.Button>
          {failed
            ? (
              <UI.StatusBadge status="failed">
                {message(translate, "machines.provider.authError")}
              </UI.StatusBadge>
            )
            : null}
        </UI.Inline>
      }
    />
  );
}

export function MachineDetailPage(
  { machineId }: { readonly machineId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const worker = useQuery(workerQueryOptions(api, scope, machineId));
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";
  const blockers = useQuery(
    dispatchBlockersQueryOptions(api, scope, machineId),
  );
  const blockedKey = dispatchBlockedKey(blockers.data?.reason);
  const [componentCursor, setComponentCursor] = useState<string | null>(null);
  const components = useQuery(
    workerComponentsListQueryOptions(api, scope, machineId),
  );
  const componentContinuation = useQuery({
    ...workerComponentsListQueryOptions(api, scope, machineId),
    queryKey: [
      ...workerComponentsListQueryOptions(api, scope, machineId).queryKey,
      componentCursor,
    ] as const,
    queryFn: ({ signal }) =>
      api.workerComponents.list({
        organizationId: scope.organizationId ?? "",
        id: machineId,
        cursor: componentCursor ?? undefined,
        limit: 100,
        signal,
      }).then((result) => {
        if (result.ok) return result.data;
        throw result.error;
      }),
    enabled: Boolean(scope.organizationId && componentCursor),
  });
  const [providerCursor, setProviderCursor] = useState<string | null>(null);
  const providersOptions = workerProviderBindingsListQueryOptions(
    api,
    scope,
    machineId,
  );
  const providers = useQuery({
    ...providersOptions,
    enabled: isAdmin && providersOptions.enabled,
  });
  const providerContinuation = useQuery({
    ...providersOptions,
    queryKey: [...providersOptions.queryKey, providerCursor] as const,
    queryFn: ({ signal }) =>
      api.workerProviderBindings.list({
        organizationId: scope.organizationId ?? "",
        id: machineId,
        cursor: providerCursor ?? undefined,
        limit: 100,
        signal,
      }).then((result) => {
        if (result.ok) return result.data;
        throw result.error;
      }),
    enabled: isAdmin && Boolean(scope.organizationId && providerCursor),
  });
  useEffect(() => {
    setComponentCursor(null);
  }, [scope.organizationId, machineId]);
  useEffect(() => {
    setProviderCursor(null);
  }, [scope.organizationId, machineId]);
  const [authAttempt, setAuthAttempt] = useState<AuthAttempt | null>(null);
  const authQuery = useQuery(
    workerProviderAuthQueryOptions(
      api,
      scope,
      authAttempt
        ? {
          workerId: authAttempt.workerId,
          bindingId: authAttempt.bindingId,
          authAttemptId: authAttempt.authAttemptId,
        }
        : {
          workerId: "",
          bindingId: "",
          authAttemptId: "",
        },
    ),
  );
  const [repairToken, setRepairToken] = useState<EnrollmentToken | null>(null);
  const [repairEnrollmentId, setRepairEnrollmentId] = useState<string | null>(
    null,
  );
  const repairEnrollment = useQuery({
    ...workerEnrollmentQueryOptions(
      api,
      scope,
      repairEnrollmentId ?? "",
    ),
    enabled: Boolean(repairEnrollmentId),
  });
  const [repairFailed, setRepairFailed] = useState(false);
  useEffect(() => {
    if (repairEnrollment.data?.state !== "consumed") return;
    void queryClient.invalidateQueries({
      queryKey: [
        "protected",
        scope.sessionGeneration,
        scope.organizationId ?? "none",
        "workers.get",
      ],
    });
  }, [
    queryClient,
    repairEnrollment.data?.state,
    scope.organizationId,
    scope.sessionGeneration,
  ]);
  useEffect(() => {
    const state = authQuery.data?.state;
    if (
      !state || state === "pending" || state === "challenge_issued"
    ) return;
    void queryClient.invalidateQueries({
      queryKey: [
        "protected",
        scope.sessionGeneration,
        scope.organizationId ?? "none",
        "workerProviderBindings.list",
      ],
    });
  }, [
    authQuery.data?.state,
    queryClient,
    scope.organizationId,
    scope.sessionGeneration,
  ]);
  const connectivity = useConnectivity({
    refetch: worker.refetch,
    refetching: worker.isFetching,
    dataUpdatedAt: worker.dataUpdatedAt,
  });
  const organizationId = scope.organizationId;
  const formatDate = (value: string) =>
    dateLabel(value, locale, timeZone, translate);
  const repair = async () => {
    if (!organizationId) return;
    setRepairFailed(false);
    const result = await api.workers.repairEnrollment({
      organizationId,
      id: machineId,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setRepairFailed(true);
      return;
    }
    setRepairEnrollmentId(result.data.enrollmentId);
    setRepairToken({
      enrollmentId: result.data.enrollmentId,
      enrollmentToken: result.data.enrollmentToken,
      expiresAt: result.data.expiresAt,
    });
    await queryClient.invalidateQueries({
      queryKey: workerQueryOptions(api, scope, machineId).queryKey,
    });
  };
  const workerData = worker.data;
  const componentItems = [
    ...(components.data?.items ?? []),
    ...(componentContinuation.data?.items ?? []),
  ];
  const nextComponentCursor = componentContinuation.data?.nextCursor ??
    components.data?.nextCursor;
  const providerItems = [
    ...(providers.data?.items ?? []),
    ...(providerContinuation.data?.items ?? []),
  ];
  const nextProviderCursor = providerContinuation.data?.nextCursor ??
    providers.data?.nextCursor;
  const forbidden = worker.isError && isForbiddenFailure(worker.error);
  const workerErrorKind = worker.isError
    ? asyncKindForError(worker.error)
    : null;
  const machineTitle = workerData?.name ??
    message(translate, "machines.detail.title");
  const providerAttemptState = authQuery.isError
    ? "failed"
    : authAttempt === null
    ? null
    : authQuery.data?.state ?? authAttempt.state;
  const canRepair = isAdmin && workerData?.status === "revoked";
  return (
    <>
      <ShellActiveNavigation id="machines" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={message(translate, "shell.navigation.breadcrumb")}
          items={[
            { label: message(translate, "shell.states.settingsTitle") },
            { label: message(translate, "shell.navigation.machines") },
            { label: machineTitle },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="machine-detail-page">
        <UI.PageHeader
          variant="list"
          title={machineTitle}
          subtitle={machineId}
          actions={canRepair
            ? (
              <UI.Button
                variant="outline"
                onClick={() => void repair()}
              >
                {message(translate, "machines.enrollment.repair")}
              </UI.Button>
            )
            : null}
          summary={workerData
            ? (
              <UI.Inline gap="compact">
                <UI.StatusBadge
                  status={statusForReadiness(workerData.readiness)}
                >
                  {message(
                    translate,
                    workerData.readiness
                      ? `machines.readiness.${workerData.readiness}`
                      : "machines.unknown",
                  )}
                </UI.StatusBadge>
                <UI.StatusDot
                  tone={toneForConnectivity(workerData.connectivity)}
                  size="strong"
                >
                  {message(
                    translate,
                    workerData.connectivity
                      ? `machines.connectivity.${workerData.connectivity}`
                      : "machines.unknown",
                  )}
                </UI.StatusDot>
              </UI.Inline>
            )
            : null}
        />
        {asyncKindForConnectivity(connectivity)
          ? (
            <UI.AlertBanner
              tone={connectivity === "offline" ? "warning" : "information"}
            >
              {message(translate, `machines.${connectivity}.description`)}
            </UI.AlertBanner>
          )
          : null}
        {worker.isPending
          ? (
            <UI.AlertBanner tone="information">
              {message(translate, "machines.loading")}
            </UI.AlertBanner>
          )
          : forbidden
          ? (
            <UI.EmptyState
              title={message(translate, "machines.forbidden.title")}
              description={message(translate, "machines.forbidden.description")}
            />
          )
          : worker.isError
          ? (
            <UI.ErrorState
              title={message(
                translate,
                workerErrorKind === "offline"
                  ? "machines.offline.title"
                  : "machines.error.title",
              )}
              description={message(
                translate,
                workerErrorKind === "offline"
                  ? "machines.offline.description"
                  : "machines.error.description",
              )}
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => void worker.refetch()}
                >
                  {message(translate, "machines.retry")}
                </UI.Button>
              }
            />
          )
          : workerData
          ? (
            <>
              {repairFailed
                ? (
                  <UI.AlertBanner tone="error">
                    {message(translate, "machines.enrollment.actionError")}
                  </UI.AlertBanner>
                )
                : null}
              {repairToken
                ? (
                  <EnrollmentTokenPanel
                    enrollment={repairToken}
                    onDismiss={() => setRepairToken(null)}
                    translate={translate}
                    formatDate={formatDate}
                    state={repairEnrollment.data?.state}
                    workerHostId={repairEnrollment.data?.workerHostId}
                  />
                )
                : null}
              {repairEnrollmentId
                ? (
                  <UI.DescriptionList data-testid="machine-repair-status">
                    <UI.DescriptionItem
                      title={message(
                        translate,
                        "machines.enrollment.status",
                      )}
                      description={repairEnrollment.isPending
                        ? message(translate, "machines.loading")
                        : repairEnrollment.isError
                        ? message(translate, "machines.error.title")
                        : repairEnrollment.data
                        ? message(
                          translate,
                          `machines.enrollment.state.${repairEnrollment.data.state}`,
                        )
                        : message(translate, "machines.unknown")}
                    />
                  </UI.DescriptionList>
                )
                : null}
              <UI.SettingsSection
                title={message(translate, "machines.detail.identity")}
                variant="stack"
              >
                <UI.DescriptionList>
                  <UI.DescriptionItem
                    title={message(translate, "machines.name")}
                    description={workerData.name}
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.platform")}
                    description={`${workerData.os} · ${workerData.architecture}`}
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.status.label")}
                    description={message(
                      translate,
                      `machines.status.${workerData.status}`,
                    )}
                    action={
                      <UI.StatusBadge
                        status={statusForWorker(workerData.status)}
                      >
                        {message(
                          translate,
                          `machines.status.${workerData.status}`,
                        )}
                      </UI.StatusBadge>
                    }
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.connectivity.label")}
                    description={message(
                      translate,
                      workerData.connectivity
                        ? `machines.connectivity.${workerData.connectivity}`
                        : "machines.unknown",
                    )}
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.readiness.label")}
                    description={message(
                      translate,
                      readinessReasonKey(workerData.readinessReason) ??
                        "machines.unknown",
                    )}
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.lastHeartbeat")}
                    description={formatDate(workerData.lastHeartbeatAt ?? "")}
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.capabilities")}
                    description={values(workerData.capabilities).join(", ") ||
                      message(translate, "machines.unknown")}
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.slots")}
                    description={String(workerData.slots)}
                  />
                </UI.DescriptionList>
              </UI.SettingsSection>
              <UI.SettingsSection
                title={message(translate, "machines.detail.checks")}
                variant="stack"
              >
                {blockedKey
                  ? (
                    <UI.AlertBanner tone="warning">
                      {message(translate, blockedKey)}
                    </UI.AlertBanner>
                  )
                  : null}
                {blockers.isPending
                  ? (
                    <UI.AlertBanner tone="information">
                      {message(translate, "machines.loading")}
                    </UI.AlertBanner>
                  )
                  : blockers.isError
                  ? (
                    <UI.ErrorState
                      title={message(translate, "machines.error.title")}
                      description={message(
                        translate,
                        "machines.error.description",
                      )}
                      action={
                        <UI.Button
                          variant="secondary"
                          onClick={() => void blockers.refetch()}
                        >
                          {message(translate, "machines.retry")}
                        </UI.Button>
                      }
                    />
                  )
                  : blockers.data?.failedChecks.length
                  ? (
                    <>
                      <UI.DescriptionList>
                        {blockers.data.failedChecks.slice(0, 8).map((check) => (
                          <UI.DescriptionItem
                            key={check.checkId}
                            title={check.checkId}
                            description={boundedReason(check.reason) ||
                              message(translate, "machines.checks.noReason")}
                          />
                        ))}
                      </UI.DescriptionList>
                      {blockers.data.failedChecks.length > 8
                        ? (
                          <UI.Text variant="muted">
                            {message(translate, "machines.checks.more", {
                              count: blockers.data.failedChecks.length - 8,
                            })}
                          </UI.Text>
                        )
                        : null}
                    </>
                  )
                  : (
                    <UI.Text>
                      {message(translate, "machines.checks.none")}
                    </UI.Text>
                  )}
              </UI.SettingsSection>
              <UI.SettingsSection
                title={message(translate, "machines.detail.components")}
                variant="stack"
              >
                {nextComponentCursor
                  ? (
                    <UI.AlertBanner tone="information">
                      {message(translate, "machines.pagination.truncated", {
                        count: componentItems.length,
                      })}
                    </UI.AlertBanner>
                  )
                  : null}
                {components.isError
                  ? (
                    <UI.ErrorState
                      title={message(translate, "machines.error.title")}
                      description={message(
                        translate,
                        "machines.error.description",
                      )}
                    />
                  )
                  : componentItems.length
                  ? (
                    <UI.DescriptionList>
                      {componentItems.map((component) => (
                        <UI.DescriptionItem
                          key={component.id}
                          title={`${component.kind} · ${component.componentKey}`}
                          description={`${component.actualVersion} · ${component.installOwner}`}
                        />
                      ))}
                    </UI.DescriptionList>
                  )
                  : (
                    <UI.Text>
                      {message(translate, "machines.components.empty")}
                    </UI.Text>
                  )}
                {componentContinuation.isError
                  ? (
                    <UI.AlertBanner tone="error">
                      {message(translate, "machines.pagination.error")}
                    </UI.AlertBanner>
                  )
                  : null}
                {nextComponentCursor
                  ? (
                    <UI.Button
                      variant="secondary"
                      disabled={componentContinuation.isFetching}
                      onClick={() =>
                        componentContinuation.isError
                          ? void componentContinuation.refetch()
                          : setComponentCursor(nextComponentCursor)}
                    >
                      {componentContinuation.isFetching
                        ? message(
                          translate,
                          "machines.pagination.loadingMore",
                        )
                        : message(translate, "machines.pagination.loadMore")}
                    </UI.Button>
                  )
                  : null}
              </UI.SettingsSection>
              <UI.SettingsSection
                title={message(translate, "machines.detail.providers")}
                variant="stack"
              >
                {nextProviderCursor
                  ? (
                    <UI.AlertBanner tone="information">
                      {message(translate, "machines.pagination.truncated", {
                        count: providerItems.length,
                      })}
                    </UI.AlertBanner>
                  )
                  : null}
                {!isAdmin
                  ? (
                    <UI.EmptyState
                      title={message(translate, "machines.forbidden.title")}
                      description={message(
                        translate,
                        "machines.provider.forbidden",
                      )}
                    />
                  )
                  : providers.isError && isForbiddenFailure(providers.error)
                  ? (
                    <UI.EmptyState
                      title={message(translate, "machines.forbidden.title")}
                      description={message(
                        translate,
                        "machines.provider.forbidden",
                      )}
                    />
                  )
                  : providers.isError
                  ? (
                    <UI.ErrorState
                      title={message(translate, "machines.error.title")}
                      description={message(
                        translate,
                        "machines.error.description",
                      )}
                    />
                  )
                  : providerItems.length
                  ? (
                    <UI.DescriptionList>
                      {providerItems.map((binding) => (
                        <ProviderBindingRow
                          key={binding.id}
                          binding={binding}
                          workerId={machineId}
                          organizationId={organizationId ?? ""}
                          api={api}
                          translate={translate}
                          onStarted={setAuthAttempt}
                        />
                      ))}
                    </UI.DescriptionList>
                  )
                  : (
                    <UI.Text>
                      {message(translate, "machines.provider.empty")}
                    </UI.Text>
                  )}
                {providerContinuation.isError
                  ? (
                    <UI.AlertBanner tone="error">
                      {message(translate, "machines.pagination.error")}
                    </UI.AlertBanner>
                  )
                  : null}
                {nextProviderCursor
                  ? (
                    <UI.Button
                      variant="secondary"
                      disabled={providerContinuation.isFetching}
                      onClick={() =>
                        providerContinuation.isError
                          ? void providerContinuation.refetch()
                          : setProviderCursor(nextProviderCursor)}
                    >
                      {providerContinuation.isFetching
                        ? message(
                          translate,
                          "machines.pagination.loadingMore",
                        )
                        : message(translate, "machines.pagination.loadMore")}
                    </UI.Button>
                  )
                  : null}
                {authAttempt?.instructions
                  ? (
                    <UI.CodeBlock
                      code={authAttempt.instructions}
                      language="text"
                      variant="command"
                      aria-label={message(
                        translate,
                        "machines.provider.instructions",
                      )}
                    />
                  )
                  : null}
                {providerAttemptState
                  ? (
                    <UI.StatusBadge
                      status={providerAttemptState === "completed"
                        ? "healthy"
                        : providerAttemptState === "failed"
                        ? "failed"
                        : providerAttemptState === "expired" ||
                            providerAttemptState === "canceled"
                        ? "disabled"
                        : "active"}
                    >
                      {message(
                        translate,
                        `machines.provider.authState.${providerAttemptState}`,
                      )}
                    </UI.StatusBadge>
                  )
                  : null}
              </UI.SettingsSection>
            </>
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}
