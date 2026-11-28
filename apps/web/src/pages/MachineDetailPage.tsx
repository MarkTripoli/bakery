import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { MessageArguments, MessageKey, Translator } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import {
  dispatchBlockersQueryOptions,
  effectiveAccessQueryOptions,
  modelProviderAccountsQueryOptions,
  workerAttemptsQueryOptions,
  workerComponentsListQueryOptions,
  workerEnrollmentQueryOptions,
  workerProviderBindingsListQueryOptions,
  workerQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { MACHINES_HOME, WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { formatMachineDate } from "./MachinesPage.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { MachineLoading } from "./MachineLoading.tsx";
import {
  bannerBodyKey,
  bannerTitle,
  RetireWarning,
} from "./machine-wording.tsx";
import { MachineRepair, type RepairIssued } from "./MachineRepair.tsx";
import { issueRepair } from "./machine-repair.ts";
import {
  CodingAgentBanner,
  CodingAgentRow,
  useAgentSignIn,
} from "./CodingAgents.tsx";
import { MachineModels } from "./MachineModels.tsx";
import { MachineChecks } from "./MachineChecks.tsx";
import { MachineWork } from "./MachineWork.tsx";
import {
  agentNeedingSignIn,
  agentOfFailedChecks,
  agentRows,
  pageBadge,
  paidPerUse,
} from "./machine-agents.ts";
import {
  type BannerFix,
  bannerFix,
  controlMode,
  MACHINE_MODES,
  type MachineMode,
  modeStatus,
} from "./machine-page-state.ts";
import {
  checkCounts,
  type CodingAgent,
  codingAgents,
  machineBadge,
  machineBadgeTone,
  machineReason,
  requestedMode,
} from "./machine-state.ts";
import { installState } from "./machine-wizard.ts";
import { hasSetupSteps, processorLabel } from "./machine-systems.ts";

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

export function MachineDetailPage(
  {
    machineId,
    signInAgent,
    tab = "overview",
    justAdded = false,
    focusChecks = false,
  }: {
    readonly tab?: "overview" | "models" | "checks" | "work";
    readonly focusChecks?: boolean;
    /** True when the Models tab was reached by saving a new model, which it says once. */
    readonly justAdded?: boolean;
    readonly machineId: string;
    /** An agent whose sign-in dialog should open on arrival (the wizard's last button). */
    readonly signInAgent?: CodingAgent;
  },
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
  const providersOptions = workerProviderBindingsListQueryOptions(
    api,
    scope,
    machineId,
  );
  // Only an administrator reads the sign-ins, and only for a machine that is still in use.
  const providers = useQuery({
    ...providersOptions,
    enabled: isAdmin && worker.data !== undefined &&
      worker.data.status !== "revoked" && providersOptions.enabled,
  });
  useEffect(() => {
    setComponentCursor(null);
  }, [scope.organizationId, machineId]);
  const [repairToken, setRepairToken] = useState<RepairIssued | null>(null);
  const [repairNow, setRepairNow] = useState(() => Date.now());
  useEffect(() => {
    if (repairToken === null) return;
    const timer = setInterval(() => setRepairNow(Date.now()), 1_000);
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
    setRepairToken(null);
    setRepairEnrollmentId(null);
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
  const connectivity = useConnectivity({
    refetch: worker.refetch,
    refetching: worker.isFetching,
    dataUpdatedAt: worker.dataUpdatedAt,
  });
  const offline = connectivity === "offline";
  const organizationId = scope.organizationId;
  const formatDate = (value: string) =>
    dateLabel(value, locale, timeZone, translate);
  const repair = async () => {
    if (!organizationId) return;
    setRepairFailed(false);
    const result = await issueRepair(api, organizationId, machineId);
    if (!result.ok) {
      setRepairFailed(true);
      return;
    }
    setRepairEnrollmentId(result.data.enrollmentId);
    setRepairNow(Date.now());
    setRepairToken({
      enrollmentId: result.data.enrollmentId,
      enrollmentToken: result.data.enrollmentToken,
      command: result.data.command,
      expiresAt: result.data.expiresAt,
      issuedAt: Date.now(),
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
  const providerItems = providers.data?.items ?? [];
  const forbidden = worker.isError && isForbiddenFailure(worker.error);
  const workerErrorKind = worker.isError
    ? asyncKindForError(worker.error)
    : null;
  const machineTitle = workerData?.name ??
    message(translate, "machines.detail.title");
  const attention = useInfiniteQuery(
    workerAttemptsQueryOptions(api, scope, machineId, "needs_attention"),
  );
  const needsLook =
    attention.data?.pages.flatMap((page) => page.items).length ??
      0;
  const needsLookHasMore = attention.hasNextPage;
  const missing = worker.isError && failureStatus(worker.error) === 404;
  const blocking = worker.data && worker.data.status !== "revoked"
    ? checkCounts(worker.data)
    : { failed: 0, unchecked: 0 };
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
        "workerProviderBindings.list",
        "workerComponents.list",
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
  const accounts = useQuery({
    ...modelProviderAccountsQueryOptions(api, scope),
    enabled: isAdmin && Boolean(organizationId) &&
      providerItems.some((binding) => binding.modelProviderAccountId),
  });
  const accountOf = (
    binding: { modelProviderAccountId?: string | null } | null,
  ) =>
    accounts.data?.items.find((account) =>
      account.id === binding?.modelProviderAccountId
    )?.displayIdentity;
  const agents = agentRows(
    workerData ? codingAgents(workerData.capabilities) : [],
    providerItems,
    componentItems,
  );
  const agentAccess = workerData?.status === "revoked"
    ? "readOnly"
    : isAdmin
    ? "full"
    : "adminOnly";
  const navigate = useNavigate();
  const signIn = useAgentSignIn({
    api,
    organizationId: organizationId ?? "",
    machineId,
    offline,
    machineName: machineTitle,
    translate,
    onChanged: refreshMachine,
  });
  // The wizard's last button lands here with the agent whose sign-in to open.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!signInAgent || agentAccess !== "full" || providers.isLoading) return;
    if (openedFor.current === `${machineId}:${signInAgent}`) return;
    const row = agents.find((entry) => entry.agent === signInAgent);
    if (!row) return;
    openedFor.current = `${machineId}:${signInAgent}`;
    // The address has done its job: a reload must not start another sign-in.
    void navigate({
      to: "/machines/$machineId",
      params: { machineId },
      search: {},
      replace: true,
    });
    if (
      (row.state === "notSignedIn" || row.state === "signedOut") &&
      (row.binding !== null || row.componentKey !== null)
    ) {
      signIn.signIn(row);
    }
  });
  const bannerAgent = agentAccess === "full"
    ? agentNeedingSignIn(agents)
    : null;
  // Only an administrator reads the sign-ins, so only then (and once they and
  // the machine's software have loaded) can an agent be called not signed in.
  const agentsKnown = agentAccess === "full" && !providers.isLoading &&
    !providers.isError && !components.isLoading && !components.isError;
  const headerBadge = workerData
    ? pageBadge(machineBadge(workerData), agents, agentsKnown)
    : "checking";
  const changeMode = async (mode: MachineMode): Promise<boolean> => {
    if (!organizationId || !workerData) return false;
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
    return result.ok;
  };
  const [focusBanner, setFocusBanner] = useState(false);
  const finishInstead = async () => {
    if (!(await changeMode("draining"))) return;
    setRetireOpen(false);
    setFocusBanner(true);
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
  // A retired machine shows its header, the one banner and what Bakery knows about it: no empty Checks or Coding agents.
  const isRetired = reason?.kind === "retired";
  // One problem, one banner: failed checks that are only an agent's sign-in are that agent's banner.
  const signInBanner = agentsKnown && reason?.kind === "checkFailed" &&
      workerData && Array.isArray(workerData.failedCheckIds)
    ? agentOfFailedChecks(workerData.failedCheckIds, agents)
    : null;
  const bannerSaysMode = reason !== null && signInBanner === null &&
    (reason.kind === "paused" || reason.kind === "finishing");
  useEffect(() => {
    if (!focusBanner || !bannerSaysMode) return;
    const problem = document.querySelector<HTMLElement>(
      '[data-testid="machine-problem-banner"]',
    );
    if (problem === null) return;
    problem.setAttribute("tabindex", "-1");
    problem.scrollIntoView({ block: "start" });
    problem.focus({ preventScroll: true });
    setFocusBanner(false);
  }, [focusBanner, bannerSaysMode]);
  // The agent the coding-agent banner names, if that banner is drawn.
  const agentBannerRow = (!reason && bannerAgent) || signInBanner
    ? (signInBanner ?? bannerAgent!)
    : null;
  const wantedFix: BannerFix | null = reason ? bannerFix(reason) : null;
  // A system with no set-up steps cannot be set up again, so it is not offered, and no setup code is made.
  const canSetUpAgain = workerData ? hasSetupSteps(workerData.os) : true;
  // Taking work again and setting it up again change the machine: administrators only.
  const fix: BannerFix | null = wantedFix === "setUpAgain" &&
      (!canSetUpAgain || repairToken !== null)
    ? null
    : wantedFix === "seeChecks" || isAdmin
    ? wantedFix
    : null;
  const runFix = (kind: BannerFix) => {
    if (kind === "takeWork") void changeMode("accepting");
    else if (kind === "setUpAgain") void repair();
    else {
      void navigate({
        to: "/machines/$machineId/checks",
        params: { machineId },
        search: { focus: "checks" },
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
            {
              href: WORK_HOME,
              label: message(translate, "shell.navigation.workspace"),
            },
            {
              href: MACHINES_HOME,
              label: message(translate, "shell.navigation.machines"),
            },
            { label: machineTitle },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="machine-detail-page" variant="wide">
        {missing ? null : (
          <UI.PageHeader
            flush
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
                  architecture: processorLabel(
                    workerData.os,
                    workerData.architecture,
                  ),
                  time: formatDate(workerData.lastHeartbeatAt ?? ""),
                },
              )
              : undefined}
            summary={workerData
              ? (
                <UI.Badge tone={machineBadgeTone(headerBadge)}>
                  {message(translate, `machines.badge.${headerBadge}`)}
                </UI.Badge>
              )
              : null}
          />
        )}
        {asyncKindForConnectivity(connectivity)
          ? (
            <UI.AlertBanner
              tone={connectivity === "offline" ? "warning" : "information"}
            >
              {offline && worker.data
                ? message(translate, "machines.offline.lastUpdated", {
                  time: formatDate(
                    new Date(worker.dataUpdatedAt).toISOString(),
                  ),
                })
                : message(translate, `machines.${connectivity}.description`)}
            </UI.AlertBanner>
          )
          : null}
        {worker.isPending
          ? <MachineLoading label={message(translate, "machines.loading")} />
          : forbidden
          ? (
            <UI.EmptyState
              title={message(translate, "machines.forbidden.title")}
              description={message(translate, "machines.forbidden.description")}
            />
          )
          : missing
          ? (
            <UI.ErrorState
              title={message(translate, "machines.missing.title")}
              description={message(translate, "machines.missing.description")}
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => void navigate({ to: "/machines" })}
                >
                  {message(translate, "machines.missing.back")}
                </UI.Button>
              }
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
              {reason && !signInBanner
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
                          disabled={offline && fix !== "seeChecks"}
                          onClick={() => runFix(fix)}
                        >
                          {message(translate, `machines.banner.fix.${fix}`)}
                        </UI.Button>
                      )
                      : undefined}
                  >
                    <UI.Stack gap="compact">
                      <UI.Text variant="strong">
                        {bannerTitle(reason, workerData, translate)}
                      </UI.Text>
                      {BANNER_BODY.has(reason.kind)
                        ? (
                          <UI.Text>
                            {message(
                              translate,
                              bannerBodyKey(
                                reason,
                                workerData.unsettledAttemptCount,
                                canSetUpAgain,
                              ),
                              {
                                count: workerData.unsettledAttemptCount ?? 0,
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
              {isRetired && workerData.retirement
                ? (
                  <UI.Text variant="muted">
                    {message(
                      translate,
                      workerData.retirement.name
                        ? "machines.retired.by"
                        : "machines.retired.on",
                      {
                        name: workerData.retirement.name ?? "",
                        date: formatDate(workerData.retirement.at),
                      },
                    )}
                  </UI.Text>
                )
                : null}
              {(!reason && bannerAgent) || signInBanner
                ? (
                  <CodingAgentBanner
                    row={signInBanner ?? bannerAgent!}
                    translate={translate}
                    signIn={signIn}
                    offline={offline}
                    otherAgentReady={agents.some((entry) =>
                      entry.agent !== (signInBanner ?? bannerAgent!).agent &&
                      entry.state === "ready"
                    )}
                  />
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
                  <MachineRepair
                    key={repairToken.enrollmentId}
                    machine={workerData}
                    issued={repairToken}
                    expired={repairState === "expired" ||
                      repairState === "canceled"}
                    now={repairNow}
                    offline={offline}
                    onNewCommand={() => void repair()}
                    translate={translate}
                  />
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
                        disabled: offline,
                      }))}
                    />
                    {modeNote &&
                        !(modeNote.kind === "saved" && bannerSaysMode)
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
              <UI.Tabs
                aria-label={message(translate, "machines.tabs.label")}
                variant="route"
                selectedId={tab}
                onSelect={(id) =>
                  void navigate(
                    id === "work"
                      ? {
                        to: "/machines/$machineId/work",
                        params: { machineId },
                        search: {},
                      }
                      : id === "models"
                      ? {
                        to: "/machines/$machineId/models",
                        params: { machineId },
                        search: {},
                      }
                      : id === "checks"
                      ? {
                        to: "/machines/$machineId/checks",
                        params: { machineId },
                        search: {},
                      }
                      : {
                        to: "/machines/$machineId",
                        params: { machineId },
                        search: {},
                      },
                  )}
                tabs={[
                  {
                    id: "overview",
                    label: message(translate, "machines.tabs.overview"),
                    content: tab === "overview"
                      ? (
                        <>
                          <UI.SettingsSection
                            title={message(translate, "machines.about.title")}
                            variant="stack"
                            data-testid="machine-about"
                          >
                            <UI.DescriptionList>
                              <UI.DescriptionItem
                                title={message(
                                  translate,
                                  "machines.about.system",
                                )}
                                description={message(
                                  translate,
                                  `machines.os.${workerData.os}`,
                                )}
                              />
                              <UI.DescriptionItem
                                title={message(
                                  translate,
                                  "machines.about.processor",
                                )}
                                description={processorLabel(
                                  workerData.os,
                                  workerData.architecture,
                                )}
                              />
                              <UI.DescriptionItem
                                title={message(
                                  translate,
                                  "machines.about.slots",
                                )}
                                description={String(workerData.slots)}
                              />
                            </UI.DescriptionList>
                          </UI.SettingsSection>
                          {!isRetired
                            ? (
                              <UI.SettingsSection
                                title={message(
                                  translate,
                                  "machines.detail.providers",
                                )}
                                variant="stack"
                                data-testid="machine-agents"
                              >
                                {providers.isError && isAdmin
                                  ? isForbiddenFailure(providers.error)
                                    ? (
                                      <UI.EmptyState
                                        title={message(
                                          translate,
                                          "machines.forbidden.title",
                                        )}
                                        description={message(
                                          translate,
                                          "machines.agents.adminOnly",
                                        )}
                                      />
                                    )
                                    : (
                                      <UI.ErrorState
                                        title={message(
                                          translate,
                                          "machines.error.title",
                                        )}
                                        description={message(
                                          translate,
                                          "machines.error.description",
                                        )}
                                        action={
                                          <UI.Button
                                            variant="secondary"
                                            onClick={() =>
                                              void providers.refetch()}
                                          >
                                            {message(
                                              translate,
                                              "core.pagination.retry",
                                            )}
                                          </UI.Button>
                                        }
                                      />
                                    )
                                  : agents.length
                                  ? (
                                    <UI.DescriptionList>
                                      {agents.map((row) => (
                                        <CodingAgentRow
                                          key={row.agent}
                                          row={row}
                                          translate={translate}
                                          access={agentAccess}
                                          signIn={signIn}
                                          inBanner={agentBannerRow?.agent ===
                                            row.agent}
                                          offline={offline}
                                          account={accountOf(row.binding)}
                                        />
                                      ))}
                                    </UI.DescriptionList>
                                  )
                                  : (
                                    <UI.Text>
                                      {message(
                                        translate,
                                        "machines.provider.empty",
                                      )}
                                    </UI.Text>
                                  )}
                                {agents.length && !agents.some(paidPerUse)
                                  ? (
                                    <UI.Text variant="muted">
                                      {message(
                                        translate,
                                        "machines.agents.apiKeyLater",
                                      )}
                                    </UI.Text>
                                  )
                                  : null}
                              </UI.SettingsSection>
                            )
                            : null}
                          {isAdmin && workerData.status !== "revoked"
                            ? (
                              <UI.SettingsSection
                                title={message(
                                  translate,
                                  "machines.retire.title",
                                )}
                                variant="stack"
                                data-testid="machine-retire"
                              >
                                <UI.Text variant="muted">
                                  {message(
                                    translate,
                                    canSetUpAgain
                                      ? "machines.retire.description"
                                      : "machines.retire.descriptionNoAgain",
                                  )}
                                </UI.Text>
                                <UI.Inline gap="compact">
                                  <UI.Button
                                    variant="destructive-outline"
                                    disabled={offline}
                                    onClick={() => {
                                      setRetireFailed(false);
                                      setRetireOpen(true);
                                    }}
                                  >
                                    {message(
                                      translate,
                                      "machines.retire.button",
                                    )}
                                  </UI.Button>
                                </UI.Inline>
                                <UI.AlertDialog
                                  open={retireOpen}
                                  onOpenChange={setRetireOpen}
                                  title={message(
                                    translate,
                                    "machines.retire.dialogTitle",
                                    {
                                      name: workerData.name,
                                    },
                                  )}
                                  cancelAction={
                                    <UI.Inline gap="compact">
                                      <UI.Button
                                        variant="secondary"
                                        onClick={() => setRetireOpen(false)}
                                      >
                                        {message(
                                          translate,
                                          "machines.retire.cancel",
                                        )}
                                      </UI.Button>
                                      {requestedMode(workerData) === "draining"
                                        ? null
                                        : (
                                          <UI.Button
                                            variant="secondary"
                                            loading={modeBusy}
                                            disabled={offline}
                                            onClick={() => void finishInstead()}
                                          >
                                            {message(
                                              translate,
                                              "machines.retire.finishInstead",
                                            )}
                                          </UI.Button>
                                        )}
                                    </UI.Inline>
                                  }
                                  confirmAction={
                                    <UI.Button
                                      variant="destructive"
                                      disabled={offline}
                                      onClick={() => void retire()}
                                    >
                                      {message(
                                        translate,
                                        "machines.retire.confirm",
                                      )}
                                    </UI.Button>
                                  }
                                >
                                  <UI.Stack gap="compact">
                                    {offline
                                      ? (
                                        <UI.AlertBanner
                                          tone="warning"
                                          role="status"
                                        >
                                          {message(
                                            translate,
                                            "machines.offline.now",
                                          )}
                                        </UI.AlertBanner>
                                      )
                                      : null}
                                    <UI.Text>
                                      {message(
                                        translate,
                                        "machines.retire.dialogBody",
                                      )}
                                    </UI.Text>
                                    <RetireWarning
                                      unfinished={workerData
                                        .unsettledAttemptCount}
                                      finishing={requestedMode(workerData) ===
                                        "draining"}
                                      translate={translate}
                                    />
                                    <UI.Text>
                                      {message(
                                        translate,
                                        canSetUpAgain
                                          ? "machines.retire.dialogAgain"
                                          : "machines.retire.dialogNoAgain",
                                      )}
                                    </UI.Text>
                                    {retireFailed
                                      ? (
                                        <UI.AlertBanner tone="error">
                                          {message(
                                            translate,
                                            "machines.retire.failed",
                                          )}
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
                      : null,
                  },
                  {
                    id: "models",
                    label: message(translate, "machines.tabs.models"),
                    content: tab === "models"
                      ? (
                        <MachineModels
                          machineId={machineId}
                          isAdmin={isAdmin}
                          offline={offline}
                          agents={agents}
                          bindings={providers.data
                            ? {
                              state: "ready",
                              ids: new Set(
                                providers.data.items.map((item) => item.id),
                              ),
                            }
                            : providers.isError
                            ? { state: "failed" }
                            : providers.fetchStatus === "idle"
                            // Not asked for: a machine that is no longer in use has no sign-ins to read.
                            ? { state: "ready", ids: new Set<string>() }
                            : { state: "loading" }}
                          retryBindings={() => void providers.refetch()}
                          justAdded={justAdded}
                          signInHref={`${MACHINES_HOME}/${machineId}`}
                        />
                      )
                      : null,
                  },
                  {
                    id: "work",
                    label: message(translate, "machines.tabs.work"),
                    badge: needsLook === 0
                      ? undefined
                      : (
                        <UI.Badge tone="warning">
                          {message(
                            translate,
                            needsLookHasMore
                              ? "machines.tabs.workNeedsLookMore"
                              : "machines.tabs.workNeedsLook",
                            { count: needsLook },
                          )}
                        </UI.Badge>
                      ),
                    content: tab === "work"
                      ? (
                        <MachineWork
                          machineId={machineId}
                          slots={workerData.slots}
                          occupied={workerData.activeAttemptCount}
                          connectivity={workerData.connectivity ?? "stale"}
                          lastHeartbeatAt={workerData.lastHeartbeatAt}
                        />
                      )
                      : null,
                  },
                  {
                    id: "checks",
                    label: message(translate, "machines.tabs.checks"),
                    badge: blocking.failed + blocking.unchecked === 0
                      ? undefined
                      : (
                        <UI.Badge
                          tone={blocking.failed > 0 ? "danger" : "warning"}
                        >
                          {message(
                            translate,
                            blocking.failed > 0
                              ? "machines.tabs.checksFailed"
                              : "machines.tabs.checksUnchecked",
                            { count: blocking.failed || blocking.unchecked },
                          )}
                        </UI.Badge>
                      ),
                    content: tab === "checks"
                      ? (
                        <MachineChecks
                          blockers={blockers}
                          reported={workerData.checks ?? []}
                          reachable={workerData.connectivity === "online"}
                          formatDate={formatDate}
                          components={components}
                          componentItems={componentItems}
                          nextComponentCursor={nextComponentCursor}
                          componentContinuation={componentContinuation}
                          onLoadMore={setComponentCursor}
                          isRetired={isRetired}
                          focusChecks={focusChecks}
                        />
                      )
                      : null,
                  },
                ]}
              />
            </>
          )
          : null}
        {signIn.dialog}
      </UI.SettingsContent>
    </>
  );
}
