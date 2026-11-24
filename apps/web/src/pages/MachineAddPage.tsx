import { useEffect, useRef, useState } from "react";
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
  workerQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { MACHINES_HOME, WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import {
  ADD_NAME_MAX,
  type AddAnswers,
  addProblems,
  addProgress,
  clockText,
  commandInput,
  initialAddAnswers,
} from "./machine-add.ts";
import { machineLine } from "./MachineList.tsx";
import {
  type CodingAgent,
  codingAgents,
  machineReason,
} from "./machine-state.ts";
import { CODING_AGENTS, supportedRows } from "./machine-systems.ts";

type EnrollmentRow = WorkerEnrollmentListResponse["items"][number];

type Issued = Readonly<{
  enrollmentId: string;
  command: string;
  expiresAt: string;
}>;

function systemsText(translate: Translator): string {
  return supportedRows().map((row) =>
    `${translate(`machines.os.${row.os}` as never)} ${row.processor}`
  ).join(` ${translate("machines.add.or" as never)} `);
}

function Fields(
  { answers, onChange, showProblems, translate }: {
    answers: AddAnswers;
    onChange: (next: AddAnswers) => void;
    showProblems: boolean;
    translate: Translator;
  },
) {
  const problems = showProblems ? addProblems(answers) : [];
  return (
    <UI.Stack gap="standard">
      <UI.Field
        label={translate("machines.wizard.name" as never)}
        htmlFor="machine-add-name"
        hint={translate("machines.add.nameHint" as never)}
        error={problems.includes("nameTooLong")
          ? translate("machines.wizard.nameTooLong" as never, {
            max: ADD_NAME_MAX,
          })
          : undefined}
      >
        <UI.TextInput
          id="machine-add-name"
          name="name"
          type="text"
          autoComplete="off"
          invalid={problems.includes("nameTooLong")}
          value={answers.name}
          onChange={(name) => onChange({ ...answers, name })}
        />
      </UI.Field>
      <UI.Field
        label={translate("machines.wizard.slots" as never)}
        htmlFor="machine-add-slots"
        hint={translate("machines.wizard.slotsHint" as never)}
        error={problems.includes("slotsInvalid")
          ? translate("machines.wizard.slotsInvalid" as never)
          : undefined}
        required
      >
        <UI.TextInput
          id="machine-add-slots"
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
      <UI.Stack gap="compact">
        <UI.Text variant="strong">
          {translate("machines.wizard.agent.question" as never)}
        </UI.Text>
        <UI.Stack
          gap="compact"
          role="radiogroup"
          aria-label={translate("machines.wizard.agent.question" as never)}
        >
          {CODING_AGENTS.map((agent) => (
            <UI.PresetOption
              key={agent}
              name="machine-add-agent"
              value={agent}
              checked={answers.agent === agent}
              onChange={() => onChange({ ...answers, agent })}
              title={translate(`machines.agent.${agent}` as never)}
            />
          ))}
        </UI.Stack>
        {problems.includes("agentRequired")
          ? (
            <UI.Text variant="error" role="alert">
              {translate("machines.wizard.agent.required" as never)}
            </UI.Text>
          )
          : null}
      </UI.Stack>
    </UI.Stack>
  );
}

function settingsLine(
  answers: { name: string; slots: number; agent: CodingAgent | null },
  translate: Translator,
): string {
  return [
    answers.name.length > 0 ? answers.name : null,
    translate("machines.add.tasksAtOnce" as never, { count: answers.slots }),
    answers.agent === null
      ? null
      : translate(`machines.agent.${answers.agent}` as never),
  ].filter((part): part is string => part !== null).join(" · ");
}

function CommandBox(
  { command, translate }: { command: string; translate: Translator },
) {
  const [copied, setCopied] = useState(false);
  return (
    <UI.Stack gap="compact">
      <UI.CodeBlock
        code={command}
        language="bash"
        variant="command"
        state="overflowing"
        role="region"
        aria-label={translate("machines.add.commandLabel" as never)}
      />
      <UI.Inline gap="compact">
        <UI.Button
          variant="primary"
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(command);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            })();
          }}
        >
          {translate(
            (copied
              ? "machines.wizard.copied"
              : "machines.wizard.copy") as never,
          )}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
}

export function MachineAddPage({ finishId }: { finishId?: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const organizationId = scope.organizationId;
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const isAdmin = access.data?.role === "admin";
  const [answers, setAnswers] = useState<AddAnswers>(initialAddAnswers);
  const [showProblems, setShowProblems] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(
    finishId ?? null,
  );
  const [failed, setFailed] = useState(false);
  const [failTick, setFailTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const waitingSince = useRef(Date.now());
  const createKey = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

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

  const status = useQuery({
    ...workerEnrollmentQueryOptions(api, scope, enrollmentId ?? ""),
    enabled: enrollmentId !== null && Boolean(organizationId),
  });
  const hostId = status.data?.workerHostId ?? null;
  const worker = useQuery({
    ...workerQueryOptions(api, scope, hostId ?? ""),
    enabled: hostId !== null && Boolean(organizationId),
    refetchInterval: 3_000,
  });
  const progress = status.data
    ? addProgress({
      enrollment: status.data,
      worker: worker.data ?? null,
      now,
      waitingSince: waitingSince.current,
    })
    : null;

  useEffect(() => {
    if (progress?.kind !== "checking" && progress?.kind !== "ready") return;
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
  }, [
    progress?.kind,
    queryClient,
    scope.organizationId,
    scope.sessionGeneration,
  ]);

  const input = commandInput(answers);
  const issue = (next: Issued) => {
    setIssued(next);
    setEnrollmentId(next.enrollmentId);
    waitingSince.current = Date.now();
    setNow(Date.now());
  };
  const afterCommand = async () => {
    await queryClient.invalidateQueries({ queryKey: listOptions.queryKey });
  };
  const getCommand = async () => {
    if (!organizationId) return;
    if (input === null) {
      setShowProblems(true);
      return;
    }
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
      setFailTick((tick) => tick + 1);
      return;
    }
    createKey.current = null;
    issue({
      enrollmentId: result.data.enrollmentId,
      command: result.data.command,
      expiresAt: result.data.expiresAt,
    });
    await afterCommand();
  };
  const getNewCommand = async () => {
    if (!organizationId || enrollmentId === null || !status.data) return;
    setBusy(true);
    setFailed(false);
    const result = await api.workerEnrollments.replace({
      organizationId,
      id: enrollmentId,
      version: status.data.version,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    setChanging(false);
    if (!result.ok) {
      setFailed(true);
      setFailTick((tick) => tick + 1);
      return;
    }
    issue({
      enrollmentId: result.data.enrollmentId,
      command: result.data.command,
      expiresAt: result.data.expiresAt,
    });
    await afterCommand();
  };

  const changeSettings = async () => {
    if (!organizationId || enrollmentId === null || !status.data) return;
    setBusy(true);
    setFailed(false);
    const result = await api.workerEnrollments.cancel({
      organizationId,
      id: enrollmentId,
      version: status.data.version,
      idempotencyKey: crypto.randomUUID(),
    });
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      setFailTick((tick) => tick + 1);
      return;
    }
    setEnrollmentId(null);
    setIssued(null);
    setChanging(false);
    createKey.current = null;
    await afterCommand();
  };
  const toList = () => void navigate({ to: "/machines" });
  const frame = (content: React.ReactNode) => (
    <>
      <ShellActiveNavigation id="machines" />
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
      <UI.SettingsContent data-testid="machine-add">
        <UI.PageHeader
          flush
          variant="list"
          title={translate("machines.wizard.title" as never)}
          subtitle={translate("machines.add.lead" as never)}
        />
        {content}
      </UI.SettingsContent>
    </>
  );
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

  const settingsFacts = input
    ? {
      name: input.name ?? "",
      slots: input.slots,
      agent: answers.agent,
    }
    : finishRow
    ? {
      name: finishRow.name ?? "",
      slots: finishRow.slots,
      agent: codingAgents(finishRow.capabilities)[0] ?? null,
    }
    : null;
  const machineName = worker.data?.name ?? settingsFacts?.name ?? "";
  const agentName = settingsFacts?.agent
    ? translate(`machines.agent.${settingsFacts.agent}` as never)
    : "";
  const hasCommand = issued !== null && progress !== null &&
    (progress.kind === "waiting");
  const showForm = enrollmentId === null && !finishId;
  const connected = progress?.kind === "checking" ||
    progress?.kind === "ready" || progress?.kind === "attention";

  if (progress?.kind === "ready") {
    return frame(
      <UI.Stack gap="standard">
        <UI.AlertBanner tone="success" role="status">
          {translate("machines.add.ready" as never, {
            name: machineName,
            agent: agentName,
          })}
        </UI.AlertBanner>
        <UI.Inline gap="compact">
          <UI.Button
            variant="primary"
            onClick={() => {
              if (hostId === null) return;
              void navigate({
                to: "/machines/$machineId",
                params: { machineId: hostId },
                search: settingsFacts?.agent
                  ? { signIn: settingsFacts.agent }
                  : {},
              });
            }}
          >
            {translate("machines.wizard.install.signInButton" as never, {
              agent: agentName,
            })}
          </UI.Button>
          <UI.Button
            variant="secondary"
            onClick={() => {
              setAnswers(initialAddAnswers);
              setIssued(null);
              setEnrollmentId(null);
              setShowProblems(false);
              void navigate({
                to: "/machines/new",
                search: { finish: undefined },
              });
            }}
          >
            {translate("machines.add.another" as never)}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>,
    );
  }
  if (progress?.kind === "attention") {
    return frame(
      <UI.Stack gap="standard">
        <UI.AlertBanner tone="warning" role="status">
          {worker.data && machineReason(worker.data) !== null
            ? machineLine(worker.data, translate)
            : translate("machines.add.attention" as never, {
              name: machineName,
            })}
        </UI.AlertBanner>
        <UI.Inline gap="compact">
          <UI.Button
            variant="primary"
            onClick={() => {
              if (hostId === null) return;
              void navigate({
                to: "/machines/$machineId",
                params: { machineId: hostId },
                search: {},
              });
            }}
          >
            {translate("machines.add.open" as never, { name: machineName })}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>,
    );
  }

  const step2Body = (
    <UI.Stack gap="standard">
      {status.isError && status.data === undefined && !failed
        ? (
          <UI.Stack gap="compact">
            <UI.AlertBanner tone="error" role="alert">
              {translate("machines.add.readFailed" as never)}
            </UI.AlertBanner>
            <UI.Inline gap="compact">
              <UI.Button
                key={`read-${status.errorUpdateCount}`}
                variant="primary"
                autoFocus
                disabled={status.isFetching}
                onClick={() => void status.refetch()}
              >
                {translate("machines.retry" as never)}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        )
        : null}
      {hasCommand
        ? (
          <>
            <CommandBox
              command={issued.command}
              translate={translate}
            />
            <UI.Text variant="muted">
              {translate("machines.add.terminal" as never)}
            </UI.Text>
            <UI.Text variant="muted">
              {translate("machines.add.once" as never, {
                clock: clockText(issued.expiresAt, now),
                systems: systemsText(translate),
              })}
            </UI.Text>
          </>
        )
        : null}
      {issued === null && progress?.kind === "waiting"
        ? (
          <UI.Text variant="muted">
            {translate("machines.add.shownOnce" as never)}
          </UI.Text>
        )
        : null}
      {progress?.kind === "expired" || progress?.kind === "canceled" ||
          (issued === null && progress?.kind === "waiting")
        ? (
          <UI.Stack gap="compact">
            {progress?.kind === "expired"
              ? (
                <UI.AlertBanner tone="warning" role="status">
                  {translate("machines.add.expired" as never)}
                </UI.AlertBanner>
              )
              : null}
            <UI.Inline gap="compact">
              <UI.Button
                variant="primary"
                disabled={busy || !status.data}
                onClick={() => void getNewCommand()}
              >
                {translate("machines.add.new" as never)}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        )
        : null}
      {failed
        ? (
          <UI.Stack gap="compact">
            <UI.AlertBanner tone="error" role="alert">
              {translate("machines.add.failed" as never)}
            </UI.AlertBanner>
            <UI.Inline gap="compact">
              <UI.Button
                key={`make-${failTick}`}
                variant="primary"
                autoFocus
                disabled={busy}
                onClick={() => void (showForm ? getCommand() : getNewCommand())}
              >
                {translate("machines.retry" as never)}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        )
        : null}
      {progress !== null && progress.kind !== "expired"
        ? (
          <UI.Inline gap="compact" data-line="status">
            {progress.kind === "waiting" || progress.kind === "checking"
              ? <UI.Spinner />
              : null}
            <UI.Text
              variant="muted"
              role="status"
              aria-live="polite"
              data-testid="machine-add-status"
            >
              {translate(
                `machines.add.line.${
                  progress.kind === "waiting" && progress.stillWaiting
                    ? "stillWaiting"
                    : progress.kind
                }` as never,
              )}
            </UI.Text>
          </UI.Inline>
        )
        : null}
    </UI.Stack>
  );

  return frame(
    <UI.Stack gap="standard">
      <UI.StepList label={translate("machines.add.stepsLabel" as never)}>
        <UI.StepItem
          status={showForm ? "running" : "done"}
          statusLabel={translate(
            (showForm
              ? "machines.add.status.now"
              : "machines.add.status.done") as never,
          )}
          title={translate("machines.add.step1" as never)}
          summary={showForm || settingsFacts === null
            ? undefined
            : settingsLine(settingsFacts, translate)}
          action={!showForm && hasCommand && !changing
            ? (
              <UI.Button
                variant="text"
                onClick={() => setChanging(true)}
              >
                {translate("machines.add.change" as never)}
              </UI.Button>
            )
            : undefined}
        >
          {showForm
            ? (
              <UI.Stack gap="standard">
                <Fields
                  answers={answers}
                  onChange={setAnswers}
                  showProblems={showProblems}
                  translate={translate}
                />
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => void getCommand()}
                  >
                    {translate("machines.add.get" as never)}
                  </UI.Button>
                  <UI.Button variant="secondary" onClick={toList}>
                    {translate("machines.wizard.cancel" as never)}
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            )
            : changing
            ? (
              <UI.InlineNotice tone="warning" data-testid="machine-add-change">
                <UI.Stack gap="compact">
                  <UI.Text>
                    {translate("machines.add.changeWarning" as never)}
                  </UI.Text>
                  <UI.Inline gap="compact">
                    <UI.Button
                      variant="secondary"
                      onClick={() => setChanging(false)}
                    >
                      {translate("machines.add.keep" as never)}
                    </UI.Button>
                    <UI.Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => void changeSettings()}
                    >
                      {translate("machines.add.change" as never)}
                    </UI.Button>
                  </UI.Inline>
                </UI.Stack>
              </UI.InlineNotice>
            )
            : null}
        </UI.StepItem>
        <UI.StepItem
          status={connected ? "done" : showForm ? "upcoming" : "running"}
          statusLabel={translate(
            (connected
              ? "machines.add.status.done"
              : showForm
              ? "machines.add.status.next"
              : "machines.add.status.now") as never,
          )}
          title={translate("machines.add.step2" as never)}
          summary={(showForm && !failed) || changing || hasCommand
            ? undefined
            : step2Body}
        >
          {showForm || changing || !hasCommand ? null : step2Body}
        </UI.StepItem>
      </UI.StepList>
      {connected
        ? null
        : (
          <UI.Text variant="muted" data-testid="machine-add-other">
            {translate("machines.add.byHandPrefix" as never)}{" "}
            <UI.Link
              variant="sentence"
              href="/machines/new/by-hand"
            >
              {translate("machines.add.byHand" as never)}
            </UI.Link>.
          </UI.Text>
        )}
    </UI.Stack>,
  );
}
