import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { MessageArguments, MessageKey, Translator } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import {
  dispatchBlockersQueryOptions,
  effectiveAccessQueryOptions,
  workerComponentsListQueryOptions,
  workerEnrollmentQueryOptions,
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
  CodingAgentBanner,
  CodingAgentRow,
  useAgentSignIn,
} from "./CodingAgents.tsx";
import {
  agentNeedingSignIn,
  agentRows,
  pageBadge,
  softwareEntries,
} from "./machine-agents.ts";
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
  type CodingAgent,
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

export function MachineDetailPage(
  { machineId, signInAgent }: {
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
  const providers = useQuery({
    ...providersOptions,
    enabled: isAdmin && providersOptions.enabled,
  });
  useEffect(() => {
    setComponentCursor(null);
  }, [scope.organizationId, machineId]);
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
  const providerItems = providers.data?.items ?? [];
  const forbidden = worker.isError && isForbiddenFailure(worker.error);
  const workerErrorKind = worker.isError
    ? asyncKindForError(worker.error)
    : null;
  const machineTitle = workerData?.name ??
    message(translate, "machines.detail.title");
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
  const signIn = useAgentSignIn({
    api,
    organizationId: organizationId ?? "",
    machineId,
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
    if (row.state === "notSignedIn" || row.state === "signedOut") {
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
            { label: message(translate, "shell.navigation.workspace") },
            { label: message(translate, "shell.navigation.machines") },
            { label: machineTitle },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="machine-detail-page" variant="wide">
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
                architecture: workerData.architecture,
                time: formatDate(workerData.lastHeartbeatAt ?? ""),
              },
            )
            : machineId}
          summary={workerData
            ? (
              <UI.Badge tone={machineBadgeTone(headerBadge)}>
                {message(translate, `machines.badge.${headerBadge}`)}
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
              {!reason && bannerAgent
                ? (
                  <CodingAgentBanner
                    row={bannerAgent}
                    translate={translate}
                    signIn={signIn}
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
                      {message(
                        translate,
                        "machines.pagination.truncated.components",
                        {
                          count: componentItems.length,
                        },
                      )}
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
                    ? (
                      <UI.DescriptionItem
                        data-testid="machine-software"
                        title={message(translate, "machines.software.title")}
                        description={
                          <UI.Stack gap="compact">
                            {softwareEntries(componentItems).map((entry) => (
                              <span key={entry.key}>
                                {message(translate, "machines.software.entry", {
                                  name: entry.agent
                                    ? message(
                                      translate,
                                      `machines.agent.${entry.agent}`,
                                    )
                                    : entry.name,
                                  version: entry.version,
                                })}
                              </span>
                            ))}
                          </UI.Stack>
                        }
                      />
                    )
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
                      {message(
                        translate,
                        "machines.pagination.error.components",
                      )}
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
                data-testid="machine-agents"
              >
                {providers.isError && isAdmin
                  ? isForbiddenFailure(providers.error)
                    ? (
                      <UI.EmptyState
                        title={message(translate, "machines.forbidden.title")}
                        description={message(
                          translate,
                          "machines.agents.adminOnly",
                        )}
                      />
                    )
                    : (
                      <UI.ErrorState
                        title={message(translate, "machines.error.title")}
                        description={message(
                          translate,
                          "machines.error.description",
                        )}
                        action={
                          <UI.Button
                            variant="secondary"
                            onClick={() => void providers.refetch()}
                          >
                            {message(translate, "core.pagination.retry")}
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
                        />
                      ))}
                    </UI.DescriptionList>
                  )
                  : (
                    <UI.Text>
                      {message(translate, "machines.provider.empty")}
                    </UI.Text>
                  )}
                {agents.length
                  ? (
                    <UI.Text variant="muted">
                      {message(translate, "machines.agents.apiKeyLater")}
                    </UI.Text>
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
                        <UI.Text>
                          {message(translate, "machines.retire.dialogAgain")}
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
        {signIn.dialog}
      </UI.SettingsContent>
    </>
  );
}
