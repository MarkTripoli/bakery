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
import { boundedReason, formatMachineDate } from "./MachinesPage.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { machineLine } from "./MachineList.tsx";
import { SetupInstructions } from "./SetupInstructions.tsx";
import {
  type BannerFix,
  bannerFix,
  checkInfo,
  controlMode,
  groupChecks,
  MACHINE_MODES,
  type MachineMode,
  modeStatus,
} from "./machine-page-state.ts";
import {
  codingAgents,
  machineBadge,
  machineBadgeTone,
  machineReason,
  requestedMode,
} from "./machine-state.ts";
import {
  type EnrollmentInput,
  hasInstaller,
  installState,
  type MachineSystem,
} from "./machine-wizard.ts";

function message(
  translate: Translator,
  key: string,
  arguments_?: MessageArguments,
): string {
  return translate(key as MessageKey, arguments_);
}

/** The banner kinds whose body says something the title does not. */
const BANNER_BODY: ReadonlySet<string> = new Set([
  "offline",
  "stale",
  "paused",
  "retired",
  "needsAttention",
]);

/** What a machine's own record says it is, for the settings a re-pair needs. */
function repairInput(
  worker: {
    name: string;
    os: string;
    architecture: string;
    slots: number;
    capabilities?: unknown;
  },
): EnrollmentInput {
  return {
    name: worker.name,
    os: worker.os as MachineSystem,
    architecture: worker.architecture,
    capabilities: Array.isArray(worker.capabilities)
      ? worker.capabilities.filter((value): value is string =>
        typeof value === "string"
      )
      : [],
    slots: worker.slots,
  };
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
  const [repairToken, setRepairToken] = useState<
    | Readonly<{
      enrollmentId: string;
      enrollmentToken: string;
      expiresAt: string;
    }>
    | null
  >(null);
  const [repairNow, setRepairNow] = useState(() => Date.now());
  useEffect(() => {
    if (repairToken === null) return;
    const timer = setInterval(() => setRepairNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [repairToken]);
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
  const repairState = repairToken
    ? installState(
      repairEnrollment.data ??
        { state: "pending", expiresAt: repairToken.expiresAt },
      repairNow,
    )
    : null;
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
  const [modeNote, setModeNote] = useState<
    | { kind: "saved"; mode: MachineMode }
    | { kind: "conflict" }
    | { kind: "failed" }
    | null
  >(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [retireFailed, setRetireFailed] = useState(false);
  const refreshMachine = async () => {
    for (
      const family of [
        "workers.get",
        "workers.list",
        "machines.dispatchBlockers",
      ]
    ) {
      await queryClient.invalidateQueries({
        queryKey: [
          "protected",
          scope.sessionGeneration,
          scope.organizationId ?? "none",
          family,
        ],
      });
    }
  };
  const changeMode = async (mode: MachineMode) => {
    if (!organizationId || !workerData) return;
    setModeBusy(true);
    setModeNote(null);
    const result = await api.workers.update({
      organizationId,
      id: machineId,
      input: { status: modeStatus(mode) },
      version: workerData.version,
      idempotencyKey: crypto.randomUUID(),
    });
    setModeBusy(false);
    if (result.ok) {
      setModeNote({ kind: "saved", mode });
    } else {
      const conflict = result.error.kind === "problem" &&
        (result.error.problem.status === 409 ||
          result.error.problem.status === 412);
      setModeNote({ kind: conflict ? "conflict" : "failed" });
    }
    await refreshMachine();
  };
  const retire = async () => {
    if (!organizationId || !workerData) return;
    setRetireFailed(false);
    const result = await api.workers.revoke({
      organizationId,
      id: machineId,
      version: workerData.version,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setRetireFailed(true);
      return;
    }
    setRetireOpen(false);
    setModeNote(null);
    await refreshMachine();
  };
  const reason = workerData ? machineReason(workerData) : null;
  const wantedFix: BannerFix | null = reason ? bannerFix(reason) : null;
  // Taking work again and setting it up again change the machine: administrators only.
  const fix: BannerFix | null = wantedFix === "seeChecks" || isAdmin
    ? wantedFix
    : null;
  const runFix = (kind: BannerFix) => {
    if (kind === "takeWork") void changeMode("accepting");
    else if (kind === "setUpAgain") void repair();
    else {
      document.querySelector('[data-testid="machine-checks"]')?.scrollIntoView({
        block: "start",
      });
    }
  };
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
          subtitle={workerData
            ? message(
              translate,
              workerData.lastHeartbeatAt
                ? "machines.page.subtitle"
                : "machines.page.subtitleNever",
              {
                os: message(translate, `machines.os.${workerData.os}`),
                architecture: workerData.architecture,
                time: formatDate(workerData.lastHeartbeatAt ?? ""),
              },
            )
            : machineId}
          summary={workerData
            ? (
              <UI.Badge tone={machineBadgeTone(machineBadge(workerData))}>
                {message(
                  translate,
                  `machines.badge.${machineBadge(workerData)}`,
                )}
              </UI.Badge>
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
              {reason
                ? (
                  <UI.AlertBanner
                    tone={reason.kind === "checkFailed" ||
                        reason.kind === "needsAttention"
                      ? "error"
                      : reason.kind === "offline" || reason.kind === "stale"
                      ? "warning"
                      : "information"}
                    data-testid="machine-problem-banner"
                    action={fix
                      ? (
                        <UI.Button
                          variant="secondary"
                          loading={modeBusy}
                          onClick={() => runFix(fix)}
                        >
                          {message(translate, `machines.banner.fix.${fix}`)}
                        </UI.Button>
                      )
                      : undefined}
                  >
                    <UI.Stack gap="compact">
                      <UI.Text variant="strong">
                        {machineLine(workerData, translate)}
                      </UI.Text>
                      {BANNER_BODY.has(reason.kind)
                        ? (
                          <UI.Text>
                            {message(
                              translate,
                              `machines.banner.body.${reason.kind}`,
                              {
                                time: formatDate(
                                  workerData.lastHeartbeatAt ?? "",
                                ),
                              },
                            )}
                          </UI.Text>
                        )
                        : null}
                      {reason.kind === "checkFailed" && blockers.data
                        ? (
                          <UI.Text>
                            {blockers.data.allBlocked
                              ? message(
                                translate,
                                "machines.banner.wholeMachine",
                              )
                              : message(
                                translate,
                                "machines.banner.capabilityOnly",
                                {
                                  what: blockers.data.blockedCapabilities.join(
                                    ", ",
                                  ),
                                },
                              )}
                          </UI.Text>
                        )
                        : null}
                    </UI.Stack>
                  </UI.AlertBanner>
                )
                : null}
              {repairFailed
                ? (
                  <UI.AlertBanner tone="error">
                    {message(translate, "machines.repair.failed")}
                  </UI.AlertBanner>
                )
                : null}
              {repairToken
                ? (
                  <UI.SettingsSection
                    title={message(translate, "machines.repair.title", {
                      name: workerData.name,
                    })}
                    variant="stack"
                    data-testid="machine-repair"
                  >
                    {repairState === "connected"
                      ? (
                        <UI.AlertBanner tone="success" role="status">
                          {message(
                            translate,
                            "machines.wizard.install.connected",
                            { name: workerData.name },
                          )}
                        </UI.AlertBanner>
                      )
                      : repairState === "expired" || repairState === "canceled"
                      ? (
                        <UI.Stack gap="standard">
                          <UI.AlertBanner tone="warning" role="status">
                            {message(
                              translate,
                              "machines.wizard.install.expired",
                            )}
                          </UI.AlertBanner>
                          <UI.Inline gap="compact">
                            <UI.Button
                              variant="primary"
                              onClick={() => void repair()}
                            >
                              {message(
                                translate,
                                "machines.wizard.install.newSettings",
                              )}
                            </UI.Button>
                          </UI.Inline>
                        </UI.Stack>
                      )
                      : !hasInstaller(workerData.os as MachineSystem)
                      ? (
                        <UI.AlertBanner tone="information" role="status">
                          {message(translate, "machines.wizard.macos")}
                        </UI.AlertBanner>
                      )
                      : (
                        <UI.Stack gap="standard">
                          <SetupInstructions
                            input={repairInput(workerData)}
                            agent={codingAgents(workerData.capabilities)[0] ??
                              null}
                            code={repairToken.enrollmentToken}
                            expiresAt={repairToken.expiresAt}
                            now={repairNow}
                            serverUrl={globalThis.location?.origin ?? ""}
                            translate={translate}
                          />
                          <UI.Text variant="muted">
                            {message(translate, "machines.repair.leave")}
                          </UI.Text>
                        </UI.Stack>
                      )}
                  </UI.SettingsSection>
                )
                : null}
              {isAdmin && controlMode(requestedMode(workerData)) !== null
                ? (
                  <UI.Stack gap="compact" data-testid="machine-mode">
                    <UI.Inline gap="compact">
                      <UI.Text variant="strong">
                        {message(translate, "machines.mode.label")}
                      </UI.Text>
                      <UI.HelpTip
                        label={message(translate, "machines.mode.helpLabel")}
                      >
                        {message(translate, "machines.mode.help")}
                      </UI.HelpTip>
                    </UI.Inline>
                    <UI.SegmentedControl
                      aria-label={message(translate, "machines.mode.label")}
                      name="machine-mode"
                      variant="inline"
                      state={modeBusy ? "disabled" : undefined}
                      value={controlMode(requestedMode(workerData)) ??
                        "accepting"}
                      onChange={(value) =>
                        void changeMode(value as MachineMode)}
                      options={MACHINE_MODES.map((mode) => ({
                        value: mode,
                        label: message(translate, `machines.mode.${mode}`),
                      }))}
                    />
                    {modeNote
                      ? (
                        <UI.InlineNotice
                          tone={modeNote.kind === "saved"
                            ? "success"
                            : modeNote.kind === "conflict"
                            ? "warning"
                            : "error"}
                          role="status"
                        >
                          {modeNote.kind === "saved"
                            ? message(
                              translate,
                              `machines.mode.saved.${modeNote.mode}`,
                            )
                            : message(
                              translate,
                              `machines.mode.${modeNote.kind}`,
                            )}
                        </UI.InlineNotice>
                      )
                      : null}
                  </UI.Stack>
                )
                : null}
              <UI.SettingsSection
                title={message(translate, "machines.checks.title")}
                variant="stack"
                data-testid="machine-checks"
              >
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
                    <UI.Stack gap="standard">
                      {groupChecks(
                        blockers.data.failedChecks.map((check) =>
                          check.checkId
                        ),
                      ).map(({ group, ids }) => (
                        <UI.Stack key={group} gap="compact">
                          <UI.Heading level="subsection-compact" rank={3}>
                            {message(
                              translate,
                              `machines.checks.group.${group}`,
                            )}
                          </UI.Heading>
                          <UI.DescriptionList>
                            {ids.map((id) => {
                              const info = checkInfo(id);
                              const failed = blockers.data!.failedChecks.find((
                                check,
                              ) =>
                                check.checkId === id
                              )!;
                              const agentName = info.agent
                                ? message(
                                  translate,
                                  `machines.agent.${info.agent}`,
                                )
                                : null;
                              return (
                                <UI.DescriptionItem
                                  key={id}
                                  action={
                                    <UI.Badge tone="danger">
                                      {message(
                                        translate,
                                        "machines.checks.failed",
                                      )}
                                    </UI.Badge>
                                  }
                                  title={info.nameKey
                                    ? message(
                                      translate,
                                      info.agent
                                        ? "machines.check.name.capability.modelAgent"
                                        : info.nameKey,
                                      { agent: agentName ?? "" },
                                    )
                                    : id}
                                  description={
                                    <UI.Stack gap="compact">
                                      {info.fixKey
                                        ? (
                                          <UI.Text>
                                            {message(translate, info.fixKey)}
                                          </UI.Text>
                                        )
                                        : null}
                                      <UI.DataText
                                        variant="code"
                                        state="wrapped"
                                      >
                                        {boundedReason(failed.reason) ||
                                          message(
                                            translate,
                                            "machines.checks.noReason",
                                          )}
                                      </UI.DataText>
                                    </UI.Stack>
                                  }
                                />
                              );
                            })}
                          </UI.DescriptionList>
                        </UI.Stack>
                      ))}
                    </UI.Stack>
                  )
                  : (
                    <UI.Text>
                      {message(translate, "machines.checks.none")}
                    </UI.Text>
                  )}
              </UI.SettingsSection>
              <UI.SettingsSection
                title={message(translate, "machines.about.title")}
                variant="stack"
                data-testid="machine-about"
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
                <UI.DescriptionList>
                  <UI.DescriptionItem
                    title={message(translate, "machines.about.system")}
                    description={message(
                      translate,
                      `machines.os.${workerData.os}`,
                    )}
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.about.processor")}
                    description={workerData.architecture}
                  />
                  <UI.DescriptionItem
                    title={message(translate, "machines.about.slots")}
                    description={String(workerData.slots)}
                  />
                  {components.isError
                    ? (
                      <UI.DescriptionItem
                        title={message(translate, "machines.software.title")}
                        description={message(
                          translate,
                          "machines.error.description",
                        )}
                      />
                    )
                    : componentItems.length
                    ? componentItems.map((component) => (
                      <UI.DescriptionItem
                        key={component.id}
                        title={`${component.kind} · ${component.componentKey}`}
                        description={`${component.actualVersion} · ${component.installOwner}`}
                      />
                    ))
                    : (
                      <UI.DescriptionItem
                        title={message(translate, "machines.software.title")}
                        description={message(
                          translate,
                          "machines.software.empty",
                        )}
                      />
                    )}
                </UI.DescriptionList>
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
              {isAdmin && workerData.status !== "revoked"
                ? (
                  <UI.SettingsSection
                    title={message(translate, "machines.retire.title")}
                    variant="stack"
                    data-testid="machine-retire"
                  >
                    <UI.Text variant="muted">
                      {message(translate, "machines.retire.description")}
                    </UI.Text>
                    <UI.Inline gap="compact">
                      <UI.Button
                        variant="destructive-outline"
                        onClick={() => {
                          setRetireFailed(false);
                          setRetireOpen(true);
                        }}
                      >
                        {message(translate, "machines.retire.button")}
                      </UI.Button>
                    </UI.Inline>
                    <UI.AlertDialog
                      open={retireOpen}
                      onOpenChange={setRetireOpen}
                      title={message(translate, "machines.retire.dialogTitle", {
                        name: workerData.name,
                      })}
                      cancelAction={
                        <UI.Button
                          variant="secondary"
                          onClick={() => setRetireOpen(false)}
                        >
                          {message(translate, "machines.retire.cancel")}
                        </UI.Button>
                      }
                      confirmAction={
                        <UI.Button
                          variant="destructive"
                          onClick={() => void retire()}
                        >
                          {message(translate, "machines.retire.confirm")}
                        </UI.Button>
                      }
                    >
                      <UI.Stack gap="compact">
                        <UI.Text>
                          {message(translate, "machines.retire.dialogBody")}
                        </UI.Text>
                        <UI.Text>
                          {message(translate, "machines.retire.dialogWork")}
                        </UI.Text>
                        {retireFailed
                          ? (
                            <UI.AlertBanner tone="error">
                              {message(translate, "machines.retire.failed")}
                            </UI.AlertBanner>
                          )
                          : null}
                      </UI.Stack>
                    </UI.AlertDialog>
                  </UI.SettingsSection>
                )
                : null}
            </>
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}
