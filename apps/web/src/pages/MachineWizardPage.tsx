import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Translator } from "@bakery/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { WorkerEnrollmentListResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  workerEnrollmentQueryOptions,
  workerEnrollmentsListQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { MACHINES_HOME, WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { SetupInstructions } from "./SetupInstructions.tsx";
import {
  isUnprovenWithSteps,
  UnprovenSystemNotice,
} from "./UnprovenSystemNotice.tsx";
import type { CodingAgent } from "./machine-state.ts";
import {
  hasSetupSteps,
  SYSTEM_ROWS,
  type SystemRow,
  systemRow,
} from "./machine-systems.ts";
import {
  agentOfCapabilities,
  type EnrollmentInput,
  enrollmentInput,
  initialAnswers,
  installState,
  NAME_MAX,
  systemProblems,
  WIZARD_STEPS,
  type WizardAnswers,
  type WizardStep,
} from "./machine-wizard.ts";

type EnrollmentRow = WorkerEnrollmentListResponse["items"][number];

/** A setup code, held in this page's memory only: Bakery shows it once and never stores it in the address, the browser or a log. */
type IssuedCode = Readonly<{
  enrollmentId: string;
  code: string;
  expiresAt: string;
}>;

/** The words of a row's processor: `arm64`, or `arm64 (Apple silicon)`. */
function processorText(row: SystemRow, translate: Translator): string {
  return row.processorNote === null
    ? row.processor
    : `${row.processor} (${
      translate(`machines.wizard.processor.${row.processorNote}` as never)
    })`;
}

/** The coding agents of a row as one line, or a dash when it has none. */
function agentsText(row: SystemRow, translate: Translator): string {
  return row.agents.length === 0
    ? "—"
    : row.agents.map((agent) => translate(`machines.agent.${agent}` as never))
      .join(", ");
}

function installedAsText(row: SystemRow, translate: Translator): string {
  return row.installedAs === null
    ? "—"
    : translate(`machines.wizard.installedAs.${row.installedAs}` as never);
}

/** A system as a person reads it: `Linux arm64`, `macOS arm64 (Apple silicon)`. */
function systemName(row: SystemRow, translate: Translator): string {
  return `${translate(`machines.os.${row.os}` as never)} ${
    processorText(row, translate)
  }`;
}

/** The one line naming the systems that cannot be chosen; not drawn when every system can. */
function UnsupportedSystems({ translate }: { translate: Translator }) {
  const unsupported = SYSTEM_ROWS.filter((row) => !row.supported);
  if (unsupported.length === 0) return null;
  return (
    <UI.Text variant="muted" id="machine-wizard-unsupported-systems">
      {translate("machines.wizard.systemFootnote" as never, {
        systems: unsupported.map((row) => systemName(row, translate)).join(
          ", ",
        ),
      })}
    </UI.Text>
  );
}

/** The systems Bakery lists: one table to choose from, cards on a phone. */
function SystemChoice(
  { answers, onChange, translate }: {
    answers: WizardAnswers;
    onChange: (next: WizardAnswers) => void;
    translate: Translator;
  },
) {
  const phone = useShellViewport() === "phone";
  const chosen = systemRow(answers.os, answers.architecture)?.id ?? null;
  // Only supported systems are drawn, so every row can be chosen; the agent follows only if the row has it.
  const rows = SYSTEM_ROWS.filter((row) => row.supported);
  const choose = (row: SystemRow) => {
    onChange({
      ...answers,
      os: row.os,
      architecture: row.architecture,
      agent: answers.agent !== null && row.agents.includes(answers.agent)
        ? answers.agent
        : null,
    });
  };
  const osName = (row: SystemRow) =>
    translate(`machines.os.${row.os}` as never);
  const label = translate("machines.wizard.system" as never);
  if (phone) {
    return (
      <UI.Stack gap="compact" role="radiogroup" aria-label={label}>
        {rows.map((row) => (
          <UI.PresetOption
            key={row.id}
            name="machine-wizard-system"
            value={row.id}
            checked={chosen === row.id}
            onChange={() => choose(row)}
            title={`${osName(row)} · ${processorText(row, translate)}`}
            description={`${installedAsText(row, translate)} · ${
              agentsText(row, translate)
            }`}
          />
        ))}
      </UI.Stack>
    );
  }
  return (
    <UI.DataTable<SystemRow>
      caption={label}
      captionHidden
      variant="ruled"
      inset="none"
      rows={rows}
      getRowKey={(row) => row.id}
      getRowAttributes={(row) => ({
        "data-system-id": row.id,
        ...(chosen === row.id ? { "data-selected": "true" } : {}),
      })}
      columns={[
        {
          id: "choose",
          width: "6%",
          header: <UI.VisuallyHidden>{label}</UI.VisuallyHidden>,
          cell: (row) => (
            <UI.Radio
              name="machine-wizard-system"
              value={row.id}
              checked={chosen === row.id}
              aria-label={`${osName(row)} ${processorText(row, translate)}`}
              onChange={() => choose(row)}
            >
              {null}
            </UI.Radio>
          ),
        },
        {
          id: "system",
          width: "14%",
          header: translate("machines.wizard.column.system" as never),
          cell: (row) => osName(row),
        },
        {
          id: "processor",
          width: "22%",
          header: translate("machines.wizard.column.processor" as never),
          cell: (row) => processorText(row, translate),
        },
        {
          id: "installedAs",
          width: "30%",
          header: translate("machines.wizard.column.installedAs" as never),
          cell: (row) => installedAsText(row, translate),
        },
        {
          id: "agents",
          header: translate("machines.wizard.column.agents" as never),
          cell: (row) => agentsText(row, translate),
        },
      ]}
    />
  );
}

function SystemStep(
  { answers, onChange, showProblems, translate }: {
    answers: WizardAnswers;
    onChange: (next: WizardAnswers) => void;
    showProblems: boolean;
    translate: Translator;
  },
) {
  const problems = showProblems ? systemProblems(answers) : [];
  const nameProblem = problems.find((problem) => problem !== "slotsInvalid");
  return (
    <UI.Stack gap="standard">
      <UI.Field
        label={translate("machines.wizard.name" as never)}
        htmlFor="machine-wizard-name"
        hint={translate("machines.wizard.nameHint" as never)}
        error={nameProblem
          ? translate(`machines.wizard.${nameProblem}` as never, {
            max: NAME_MAX,
          })
          : undefined}
        required
      >
        <UI.TextInput
          id="machine-wizard-name"
          name="name"
          type="text"
          autoComplete="off"
          invalid={nameProblem !== undefined}
          value={answers.name}
          onChange={(name) => onChange({ ...answers, name })}
        />
      </UI.Field>
      <UI.Stack gap="compact">
        <UI.Text variant="strong">
          {translate("machines.wizard.system" as never)}
        </UI.Text>
        <UI.Text variant="muted">
          {translate("machines.wizard.systemHint" as never)}
        </UI.Text>
        <SystemChoice
          answers={answers}
          onChange={onChange}
          translate={translate}
        />
        <UnsupportedSystems translate={translate} />
      </UI.Stack>
      <UI.Field
        label={translate("machines.wizard.slots" as never)}
        htmlFor="machine-wizard-slots"
        hint={translate("machines.wizard.slotsHint" as never)}
        error={problems.includes("slotsInvalid")
          ? translate("machines.wizard.slotsInvalid" as never)
          : undefined}
        required
      >
        <UI.TextInput
          id="machine-wizard-slots"
          name="slots"
          type="number"
          autoComplete="off"
          inputMode="numeric"
          min={1}
          max={100}
          invalid={problems.includes("slotsInvalid")}
          value={answers.slots}
          onChange={(slots) => onChange({ ...answers, slots })}
        />
      </UI.Field>
    </UI.Stack>
  );
}

function AgentStep(
  { answers, onChange, showProblem, translate }: {
    answers: WizardAnswers;
    onChange: (next: WizardAnswers) => void;
    showProblem: boolean;
    translate: Translator;
  },
) {
  const question = translate("machines.wizard.agent.question" as never);
  const agents = systemRow(answers.os, answers.architecture)?.agents ?? [];
  return (
    <UI.Stack gap="standard">
      <UI.Heading level="section" rank={2}>
        {question}
      </UI.Heading>
      <UI.Stack gap="compact" role="radiogroup" aria-label={question}>
        {agents.map((agent) => (
          <UI.PresetOption
            key={agent}
            name="machine-wizard-agent"
            value={agent}
            checked={answers.agent === agent}
            onChange={() => onChange({ ...answers, agent })}
            title={translate(`machines.agent.${agent}` as never)}
          />
        ))}
      </UI.Stack>
      <UI.Text variant="muted">
        {translate("machines.wizard.agent.help" as never)}
      </UI.Text>
      {showProblem && answers.agent === null
        ? (
          <UI.AlertBanner tone="error">
            {translate("machines.wizard.agent.required" as never)}
          </UI.AlertBanner>
        )
        : null}
    </UI.Stack>
  );
}

/** The install step: what to do on the machine, then waiting for it to connect. */
function InstallStep(
  {
    input,
    agent,
    issued,
    enrollmentId,
    translate,
    onNewSettings,
    onDone,
    onToList,
  }: {
    input: EnrollmentInput;
    agent: CodingAgent;
    issued: IssuedCode | null;
    enrollmentId: string | null;
    translate: Translator;
    onNewSettings: (version: number) => void;
    onDone: (workerHostId: string, agent: CodingAgent) => void;
    onToList: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const status = useQuery({
    ...workerEnrollmentQueryOptions(api, scope, enrollmentId ?? ""),
    enabled: enrollmentId !== null && Boolean(scope.organizationId),
  });
  const connected = status.data?.state === "consumed";
  const hostId = status.data?.workerHostId ?? null;
  const refetchStatus = status.refetch;
  // The enrollment can read consumed a moment before it names the machine
  // (and polling stops at consumed): keep asking until it does, so Done never
  // leads anywhere but the machine.
  useEffect(() => {
    if (!connected || hostId !== null) return;
    const timer = setInterval(() => void refetchStatus(), 2_000);
    return () => clearInterval(timer);
  }, [connected, hostId, refetchStatus]);
  useEffect(() => {
    if (!connected) return;
    for (const family of ["workers.list", "workerEnrollments.list"]) {
      void queryClient.invalidateQueries({
        queryKey: [
          "protected",
          scope.sessionGeneration,
          scope.organizationId ?? "none",
          family,
        ],
      });
    }
  }, [connected, queryClient, scope.organizationId, scope.sessionGeneration]);
  const serverUrl = globalThis.location?.origin ?? "";
  const state = status.data
    ? installState(status.data, now)
    : issued
    ? installState({ state: "pending", expiresAt: issued.expiresAt }, now)
    : "waiting";

  // A setup for a system without an installer can only have come from before
  // the wizard stopped offering it: say so, and offer nothing it cannot do.
  if (!hasSetupSteps(input.os)) {
    return (
      <UI.AlertBanner tone="information" role="status">
        {translate("machines.wizard.unsupported" as never)}
      </UI.AlertBanner>
    );
  }
  if (state === "connected") {
    return (
      <UI.Stack gap="standard">
        <UI.AlertBanner tone="success" role="status">
          {translate("machines.wizard.install.connectedSignIn" as never, {
            name: input.name,
            agent: translate(`machines.agent.${agent}` as never),
          })}
        </UI.AlertBanner>
        <UI.Inline gap="compact">
          <UI.Button
            variant="primary"
            disabled={hostId === null}
            aria-describedby={hostId === null
              ? "machine-wizard-opening"
              : undefined}
            onClick={() => {
              if (hostId !== null) onDone(hostId, agent);
            }}
          >
            {translate("machines.wizard.install.signInButton" as never, {
              agent: translate(`machines.agent.${agent}` as never),
            })}
          </UI.Button>
        </UI.Inline>
        {/* A disabled button says why: the machine is not named yet. */}
        {hostId === null
          ? (
            <UI.Text variant="muted" role="status" id="machine-wizard-opening">
              {translate("machines.wizard.install.opening" as never)}
            </UI.Text>
          )
          : null}
      </UI.Stack>
    );
  }
  if (state === "canceled") {
    return (
      <UI.AlertBanner tone="warning">
        {translate("machines.wizard.install.canceled" as never)}
      </UI.AlertBanner>
    );
  }
  // No code in this page's memory (it was shown once and the page was left or
  // reloaded) or the code ran out: new settings are the only way on.
  if (issued === null || state === "expired") {
    return (
      <UI.Stack gap="standard">
        <UI.AlertBanner tone="warning" role="status">
          {translate(
            (issued === null
              ? "machines.wizard.install.lost"
              : "machines.wizard.install.expired") as never,
            { name: input.name },
          )}
        </UI.AlertBanner>
        <UI.Inline gap="compact">
          <UI.Button
            variant="primary"
            disabled={status.data === undefined}
            onClick={() => {
              if (status.data) onNewSettings(status.data.version);
            }}
          >
            {translate("machines.wizard.install.newSettings" as never)}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    );
  }
  return (
    <UI.Stack gap="standard">
      {isUnprovenWithSteps(input.os, input.architecture)
        ? (
          <UnprovenSystemNotice
            os={input.os}
            architecture={input.architecture}
            translate={translate}
          />
        )
        : null}
      <SetupInstructions
        input={input}
        agent={agent}
        code={issued.code}
        expiresAt={issued.expiresAt}
        now={now}
        serverUrl={serverUrl}
        translate={translate}
      />
      <UI.Text variant="muted">
        {translate("machines.wizard.install.leave" as never)}
      </UI.Text>
      <UI.Inline gap="compact">
        <UI.Button variant="secondary" onClick={onToList}>
          {translate("machines.wizard.toList" as never)}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
}

export function MachineWizardPage(
  { finishId }: { finishId?: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const organizationId = scope.organizationId;
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";
  const [step, setStep] = useState<WizardStep>(
    finishId ? "install" : "system",
  );
  const [answers, setAnswers] = useState<WizardAnswers>(initialAnswers);
  const [showProblems, setShowProblems] = useState(false);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(
    finishId ?? null,
  );
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // One idempotency key per attempt: pressing Continue twice cannot make two setups.
  const createKey = useRef<string | null>(null);

  // Continuing a setup that was left: its answers come from the enrollment.
  const listOptions = workerEnrollmentsListQueryOptions(api, scope, {
    limit: 100,
  });
  const finishing = useQuery({
    ...listOptions,
    enabled: Boolean(finishId) && isAdmin && listOptions.enabled,
  });
  const finishRow: EnrollmentRow | undefined = finishId
    ? finishing.data?.items.find((row) => row.enrollmentId === finishId)
    : undefined;

  // A one-paste enrollment (#70) may leave the name and system to the
  // machine; the by-hand steps cannot continue one of those.
  const finishInput: EnrollmentInput | null = finishRow &&
      finishRow.name !== null && finishRow.os !== null &&
      finishRow.architecture !== null
    ? {
      name: finishRow.name,
      os: finishRow.os,
      architecture: finishRow.architecture,
      capabilities: Array.isArray(finishRow.capabilities)
        ? finishRow.capabilities.filter((value): value is string =>
          typeof value === "string"
        )
        : [],
      slots: finishRow.slots,
    }
    : null;
  const finishAgent = finishRow
    ? agentOfCapabilities(finishRow.capabilities)
    : null;
  const input = finishId ? finishInput : enrollmentInput(answers);
  const agent = finishId ? finishAgent : answers.agent;

  const issue = (code: string, id: string, expiresAt: string) => {
    setIssued({ enrollmentId: id, code, expiresAt });
    setEnrollmentId(id);
  };
  const invalidateEnrollments = () =>
    queryClient.invalidateQueries({ queryKey: listOptions.queryKey });

  const createSettings = async () => {
    if (!organizationId || input === null) return;
    setBusy(true);
    setFailed(false);
    createKey.current ??= crypto.randomUUID();
    const result = await api.workers.enroll({
      organizationId,
      input,
      idempotencyKey: createKey.current,
    });
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    issue(
      result.data.enrollmentToken,
      result.data.enrollmentId,
      result.data.expiresAt,
    );
    await invalidateEnrollments();
  };
  const newSettings = async (version: number) => {
    if (!organizationId || enrollmentId === null) return;
    setBusy(true);
    setFailed(false);
    const result = await api.workerEnrollments.replace({
      organizationId,
      id: enrollmentId,
      version,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    issue(
      result.data.enrollmentToken,
      result.data.enrollmentId,
      result.data.expiresAt,
    );
    await invalidateEnrollments();
  };

  const stepIndex = WIZARD_STEPS.indexOf(step);
  const toList = () => void navigate({ to: "/machines" });
  const next = () => {
    if (step === "system") {
      if (systemProblems(answers).length > 0) {
        setShowProblems(true);
        return;
      }
      setShowProblems(false);
      setStep("agent");
      return;
    }
    if (step === "agent") {
      if (answers.agent === null) {
        setShowProblems(true);
        return;
      }
      setShowProblems(false);
      setStep("install");
      void createSettings();
    }
  };
  const back = () => {
    if (step === "agent") setStep("system");
    else if (step === "install" && issued === null && !finishId) {
      setStep("agent");
    }
  };

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          {
            href: WORK_HOME,
            label: translate("shell.navigation.workspace"),
          },
          {
            href: MACHINES_HOME,
            label: translate("shell.navigation.machines"),
          },
          { label: translate("machines.wizard.title" as never) },
        ]}
      />
    </ShellSlot>
  );

  const frame = (content: ReactNode) => (
    <>
      <ShellActiveNavigation id="machines" />
      {breadcrumbs}
      <UI.SettingsContent data-testid="machine-wizard">
        <UI.PageHeader
          flush
          variant="list"
          title={translate("machines.wizard.title" as never)}
        />
        {content}
      </UI.SettingsContent>
    </>
  );
  // Nothing of the form until it is known who is asking.
  if (access.isPending) {
    return frame(
      <UI.Text variant="muted" role="status">
        {translate("machines.loading" as never)}
      </UI.Text>,
    );
  }
  if (access.isError) {
    return frame(
      <UI.ErrorState
        title={translate("machines.error.title" as never)}
        description={translate("machines.error.description" as never)}
        action={
          <UI.Button
            variant="secondary"
            onClick={() => void access.refetch()}
          >
            {translate("machines.retry" as never)}
          </UI.Button>
        }
      />,
    );
  }
  if (!isAdmin) {
    return frame(
      <UI.EmptyState
        title={translate("machines.wizard.adminOnly.title" as never)}
        description={translate("machines.empty.adminOnly" as never)}
        action={
          <UI.Button variant="secondary" onClick={toList}>
            {translate("machines.wizard.toList" as never)}
          </UI.Button>
        }
        variant="firstUse"
      />,
    );
  }

  const stepName = translate(`machines.wizard.step.${step}` as never);
  const installReady = step === "install" && input !== null && agent !== null;
  return (
    <>
      <ShellActiveNavigation id="machines" />
      {breadcrumbs}
      <UI.SettingsContent data-testid="machine-wizard">
        <UI.PageHeader
          flush
          variant="list"
          title={translate("machines.wizard.title" as never)}
          subtitle={translate("machines.wizard.progress" as never, {
            n: stepIndex + 1,
            count: WIZARD_STEPS.length,
            name: stepName,
          })}
        />
        {step === "system"
          ? (
            <SystemStep
              answers={answers}
              onChange={setAnswers}
              showProblems={showProblems}
              translate={translate}
            />
          )
          : null}
        {step === "agent"
          ? (
            <AgentStep
              answers={answers}
              onChange={setAnswers}
              showProblem={showProblems}
              translate={translate}
            />
          )
          : null}
        {installReady && (issued !== null || finishId)
          ? (
            <InstallStep
              input={input}
              agent={agent}
              issued={issued}
              enrollmentId={enrollmentId}
              translate={translate}
              onNewSettings={(version) => void newSettings(version)}
              onDone={(workerHostId, signInAgent) =>
                void navigate({
                  to: "/machines/$machineId",
                  params: { machineId: workerHostId },
                  search: { signIn: signInAgent },
                })}
              onToList={toList}
            />
          )
          : null}
        {step === "install" && !finishId && !failed && issued === null
          ? (
            <UI.Text variant="muted" role="status">
              {translate("machines.wizard.install.creating" as never)}
            </UI.Text>
          )
          : null}
        {failed
          ? (
            <UI.AlertBanner tone="error">
              {translate("machines.wizard.install.failed" as never)}
            </UI.AlertBanner>
          )
          : null}
        <UI.Inline variant="end" gap="compact">
          {step === "system"
            ? (
              <UI.Button variant="secondary" onClick={toList}>
                {translate("machines.wizard.cancel" as never)}
              </UI.Button>
            )
            : null}
          {step === "agent" || (step === "install" && issued === null &&
              !finishId && failed)
            ? (
              <UI.Button variant="secondary" onClick={back}>
                {translate("machines.wizard.back" as never)}
              </UI.Button>
            )
            : null}
          {step === "install" && issued === null && !finishId && failed
            ? (
              <UI.Button
                variant="primary"
                disabled={busy}
                onClick={() => void createSettings()}
              >
                {translate("machines.wizard.install.tryAgain" as never)}
              </UI.Button>
            )
            : null}
          {step === "system" || step === "agent"
            ? (
              <UI.Button
                variant="primary"
                onClick={next}
              >
                {translate("machines.wizard.continue" as never)}
              </UI.Button>
            )
            : null}
          {step === "install" && finishId && issued === null
            ? (
              <UI.Button variant="secondary" onClick={toList}>
                {translate("machines.wizard.toList" as never)}
              </UI.Button>
            )
            : null}
        </UI.Inline>
      </UI.SettingsContent>
    </>
  );
}
