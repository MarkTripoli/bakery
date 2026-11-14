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
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { SetupInstructions } from "./SetupInstructions.tsx";
import type { CodingAgent } from "./machine-state.ts";
import {
  agentOfCapabilities,
  type EnrollmentInput,
  enrollmentInput,
  hasInstaller,
  initialAnswers,
  installState,
  type MachineSystem,
  NAME_MAX,
  PROCESSORS,
  suggestedProcessor,
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

const AGENTS: readonly CodingAgent[] = ["claude", "codex", "pi"];
const SYSTEMS: readonly MachineSystem[] = ["linux", "macos"];

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
          {translate("machines.wizard.os" as never)}
        </UI.Text>
        <UI.SegmentedControl
          aria-label={translate("machines.wizard.os" as never)}
          name="machine-wizard-os"
          variant="inline"
          value={answers.os}
          onChange={(value) => {
            const os = value as MachineSystem;
            // The processor follows the system until the person changes it.
            const followed = answers.architecture ===
              suggestedProcessor(answers.os);
            onChange({
              ...answers,
              os,
              architecture: followed
                ? suggestedProcessor(os)
                : answers.architecture,
            });
          }}
          options={SYSTEMS.map((value) => ({
            value,
            label: translate(`machines.os.${value}` as never),
          }))}
        />
        <UI.Text variant="muted">
          {translate("machines.wizard.osHint" as never)}
        </UI.Text>
        {!hasInstaller(answers.os)
          ? (
            <UI.AlertBanner
              tone="information"
              role="status"
              id="machine-wizard-os-notice"
            >
              {translate("machines.wizard.macos" as never)}
            </UI.AlertBanner>
          )
          : null}
      </UI.Stack>
      <UI.Stack gap="compact">
        <UI.Text variant="strong">
          {translate("machines.wizard.processor" as never)}
        </UI.Text>
        <UI.SegmentedControl
          aria-label={translate("machines.wizard.processor" as never)}
          name="machine-wizard-processor"
          variant="inline"
          value={answers.architecture}
          onChange={(architecture) => onChange({ ...answers, architecture })}
          options={PROCESSORS.map((value) => ({
            value,
            label: translate(`machines.wizard.processor.${value}` as never),
          }))}
        />
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
  return (
    <UI.Stack gap="standard">
      <UI.Heading level="section" rank={2}>
        {question}
      </UI.Heading>
      <UI.Stack gap="compact" role="radiogroup" aria-label={question}>
        {AGENTS.map((agent) => (
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
  if (!hasInstaller(input.os)) {
    return (
      <UI.AlertBanner tone="information" role="status">
        {translate("machines.wizard.macos" as never)}
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

  const finishInput: EnrollmentInput | null = finishRow
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
          { label: translate("shell.states.settingsTitle") },
          { label: translate("shell.navigation.machines") },
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
                disabled={step === "system" && !hasInstaller(answers.os)}
                aria-describedby={step === "system" && !hasInstaller(answers.os)
                  ? "machine-wizard-os-notice"
                  : undefined}
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
