import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  batchStartableQueryOptions,
  workflowPresetsQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { LeaveGuard } from "./repository-rules/leave-guard.tsx";
import {
  type ContinueMode,
  isDirty,
  planValues,
  smallestSpend,
  START_DEFAULTS,
  startableView,
  startBody,
  type StartForm,
  timeAgo,
  validateStart,
} from "./batches/batch-display.ts";
import {
  CREATE_REFUSAL_KEY,
  type CreateRefusal,
  createRefusal,
  createRefusalPlace,
} from "./batches/batch-refusal.ts";
import { BatchBreadcrumbs } from "./batches/BatchBreadcrumbs.tsx";
import { useBatchLookups } from "./batches/use-batch-lookups.ts";
import { TICKET_PRESETS } from "./issue-sources.ts";
import {
  composerLabels,
  composerSetupReasons,
  presetCopy,
} from "./task-composer-labels.ts";
import { WorkflowChoice } from "./WorkflowChoice.tsx";

const BATCHES_PATH = "/issues/batches";

const STOP_KEYS: Readonly<Record<string, string>> = {
  IHS: "batches.start.summary.stop",
  IH: "batches.start.summary.stopIssuesHours",
  IS: "batches.start.summary.stopIssuesSpend",
  HS: "batches.start.summary.stopHoursSpend",
  I: "batches.start.summary.stopIssues",
  H: "batches.start.summary.stopHours",
  S: "batches.start.summary.stopSpend",
  "": "batches.start.summary.stopNone",
};
const NEW_BATCH_PATH = "/issues/batches/new";

/** The words the leave question uses; the guard is the repository rules' own. */
const LEAVE_COPY = {
  title: "batches.start.leave.title",
  body: "batches.start.leave.body",
  stay: "batches.start.leave.keep",
  confirm: "batches.start.leave.confirm",
} as const;

/** `/issues/batches/new`: set three limits and a choice for one repository, then start the batch. */
export function BatchStartPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const lookups = useBatchLookups();

  // Only repositories that are taking issues can run a batch, however many there are.
  const choices = lookups.takingIssues;
  const asked = typeof search.repository === "string" ? search.repository : "";
  const preselected = choices.some((repository) => repository.id === asked)
    ? asked
    : "";

  const [typed, setTyped] = useState<StartForm>(START_DEFAULTS);
  const [presetTouched, setPresetTouched] = useState(false);
  const [workflowAsks, setWorkflowAsks] = useState(0);
  const [setupAsks, setSetupAsks] = useState(0);
  useEffect(() => {
    if (setupAsks === 0) return;
    document.getElementById("batch-workflow-setup")?.focus();
  }, [setupAsks]);
  useEffect(() => {
    if (workflowAsks === 0) return;
    document.getElementById("batch-workflow")?.focus();
  }, [workflowAsks]);
  // Until the person picks one, the repository the address named is the choice.
  const [repositoryTouched, setRepositoryTouched] = useState(false);
  const repositoryChosen = repositoryTouched ? typed.repositoryId : preselected;
  const presetDefault = lookups.presetOf(repositoryChosen) ?? "";
  const form: StartForm = {
    ...typed,
    repositoryId: repositoryChosen,
    presetId: presetTouched ? typed.presetId : presetDefault,
  };
  const [attempted, setAttempted] = useState(false);
  const [refusal, setRefusal] = useState<CreateRefusal | null>(null);
  const [left, setLeft] = useState(false);
  // Where to go once the guard has been told the form is done: moving on is not leaving a draft.
  const [moveOn, setMoveOn] = useState<
    { batchId: string } | { repository: string } | null
  >(null);
  useEffect(() => {
    if (moveOn === null || !left) return;
    void ("batchId" in moveOn
      ? navigate({
        to: "/issues/batches/$batchId",
        params: { batchId: moveOn.batchId },
      })
      : navigate({
        to: BATCHES_PATH,
        search: { repository: moveOn.repository },
      }));
  }, [moveOn, left, navigate]);

  // The issues a batch would take and the least it can spend, read for the chosen repository.
  const startable = useQuery(
    batchStartableQueryOptions(api, scope, form.repositoryId),
  );
  const presets = useQuery({
    ...workflowPresetsQueryOptions(api, scope, form.repositoryId || null),
    enabled: form.repositoryId !== "",
  });
  const chosenAvailability = presets.data?.items.find((item) =>
    item.id === form.presetId
  )?.availability;
  const setupReasons = chosenAvailability?.status === "setup_required"
    ? composerSetupReasons(
      chosenAvailability.reasons,
      "",
      chosenAvailability.minimumBudgetLimitUsd ?? null,
    )
    : [];
  const setupLabels = composerLabels(translate as never);
  const smallest = smallestSpend(startable.data);
  const view = startable.data === undefined
    ? null
    : startableView(startable.data);

  const errors = validateStart(form, smallest);
  const shown = attempted ? errors : {};
  const change = (patch: Partial<StartForm>) => {
    setTyped((current) => ({ ...current, ...patch }));
    setRefusal(null);
  };

  const repositoryName =
    choices.find((repository) => repository.id === form.repositoryId)?.name ??
      null;

  const start = useMutation({
    mutationKey: ["batches.create"],
    mutationFn: async () => {
      const input = startBody(form);
      if (input === null) throw new Error("form is not valid");
      const result = await api.batches.create({
        organizationId: scope.organizationId as string,
        input,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (batch) => {
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
      // The guard is told first; the effect below moves on once it has the news.
      setLeft(true);
      setMoveOn({ batchId: batch.id });
    },
    onError: (error) => {
      const refused = createRefusal(error);
      setRefusal(refused);
      // The server judged the amount against its own smallest: read that again.
      if (refused === "spendLow") void startable.refetch();
    },
  });

  /** The batch already running in the chosen repository is the newest one there. */
  const openRunning = async () => {
    const result = await api.batches.list({
      organizationId: scope.organizationId as string,
      repositoryId: form.repositoryId,
      limit: 1,
    });
    const id = result.ok ? result.data.items[0]?.id : undefined;
    setLeft(true);
    setMoveOn(
      id === undefined ? { repository: form.repositoryId } : { batchId: id },
    );
  };

  const submit = () => {
    setAttempted(true);
    if (Object.keys(errors).length > 0) {
      if (errors.presetId !== undefined && errors.repositoryId === undefined) {
        setWorkflowAsks((count) => count + 1);
      }
      return;
    }
    if (setupReasons.length > 0) {
      setSetupAsks((count) => count + 1);
      return;
    }
    start.mutate();
  };

  const chosenPreset = TICKET_PRESETS.find((id) => id === form.presetId) ??
    null;
  const workflowHint = repositoryChosen === ""
    ? translate("batches.start.workflow.helpNone" as never)
    : presetDefault === ""
    ? translate("batches.start.workflow.helpUnset" as never, {
      repository: repositoryName ?? "",
    })
    : translate("batches.start.workflow.helpSet" as never, {
      repository: repositoryName ?? "",
    });
  const dirty = isDirty(form, preselected, presetDefault) && !left;
  const refusalText = refusal === null ? null : translate(
    CREATE_REFUSAL_KEY[refusal] as never,
    { repository: repositoryName ?? "" },
  );
  const refusalAtRepository = refusal !== null &&
    createRefusalPlace(refusal) === "repository";
  const refusalAtSpend = refusal !== null &&
    createRefusalPlace(refusal) === "spend";
  /** The smallest spend when it is known, in the person's currency format. */
  const smallestText = smallest === null ? null : lookups.money(smallest);
  const spendProblem = shown.maxSpend !== undefined
    ? translate(
      shown.maxSpend as never,
      { amount: smallestText ?? "" },
    )
    : refusalAtSpend
    ? translate(
      (smallestText === null
        ? "batches.start.error.maxSpendLowNoAmount"
        : "batches.start.error.maxSpendLow") as never,
      { amount: smallestText ?? "" },
    )
    : undefined;
  const repositoryProblem = shown.repositoryId !== undefined
    ? translate(shown.repositoryId as never)
    : refusalAtRepository
    ? refusalText
    : null;

  const plan = planValues(form, repositoryName, locale);
  const issuesPart = plan.issues === "…" ? null : translate(
    "batches.start.summary.issuesPart" as never,
    { count: Number(plan.issues) },
  );
  const hoursPart = plan.hours === "…" ? null : translate(
    "batches.start.summary.hoursPart" as never,
    { count: Number(plan.hours) },
  );
  const spendPart = plan.spend === "…" ? null : plan.spend;
  const stopKey = STOP_KEYS[
    `${issuesPart === null ? "" : "I"}${hoursPart === null ? "" : "H"}${
      spendPart === null ? "" : "S"
    }`
  ];
  const modeLabel = plan.mode === "carry_on"
    ? translate("batches.start.mode.carryOn" as never)
    : plan.mode === "ask_first"
    ? translate("batches.start.mode.askFirst" as never)
    : null;

  const numberField = (
    name: "maxIssues" | "maxHours",
    label: string,
    unit: string,
    hint: string,
    min: number,
    max: number,
  ) => (
    <UI.Field
      htmlFor={`batch-${name}`}
      label={label}
      hint={hint}
      error={shown[name] === undefined
        ? undefined
        : translate(shown[name] as never)}
    >
      <UI.Inline gap="compact">
        <UI.TextInput
          autoComplete="off"
          id={`batch-${name}`}
          name={name}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          invalid={shown[name] !== undefined}
          value={form[name]}
          onChange={(value) => change({ [name]: value })}
        />
        <UI.Text variant="muted">{unit}</UI.Text>
      </UI.Inline>
    </UI.Field>
  );

  /** "It would start with": the issues a batch would take now, or why none can (UX revision 3). */
  const startableSection = (() => {
    if (form.repositoryId === "") return null;
    if (startable.isPending) {
      return (
        <UI.Stack
          gap="tight"
          aria-busy="true"
          aria-label={translate("batches.start.startable.loading" as never)}
          data-testid="batch-startable-loading"
        >
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="row" />
        </UI.Stack>
      );
    }
    if (startable.isError) {
      return (
        <UI.Stack gap="tight" data-testid="batch-startable-failed">
          <UI.Text variant="error" role="alert">
            {translate("batches.start.startable.failed" as never)}
          </UI.Text>
          <UI.Inline gap="compact">
            <UI.Button
              variant="secondary"
              onClick={() => void startable.refetch()}
            >
              {translate("batches.start.startable.retry" as never)}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      );
    }
    if (view === null) return null;
    if (view.issues.length === 0) {
      return (
        <UI.InlineNotice
          tone="warning"
          data-testid="batch-startable-nothing"
        >
          <UI.Stack gap="tight">
            <UI.Text variant="strong">
              {translate("batches.start.startable.nothing.title" as never, {
                repository: repositoryName ?? "",
              })}
            </UI.Text>
            <UI.Text>
              {translate("batches.start.startable.nothing.body" as never)}
            </UI.Text>
            <UI.Link
              href="/issues"
              onClick={(event) => {
                event.preventDefault();
                void navigate({ to: "/issues", search: { choose: undefined } });
              }}
            >
              {translate("batches.start.startable.nothing.link" as never, {
                repository: repositoryName ?? "",
              })}
            </UI.Link>
          </UI.Stack>
        </UI.InlineNotice>
      );
    }
    const checked = view.checkedAt === null
      ? ""
      : timeAgo(view.checkedAt, Date.now(), locale);
    return (
      <UI.Stack gap="tight" data-testid="batch-startable">
        <UI.Text variant="strong" id="batch-startable-label">
          {translate("batches.start.startable.label" as never)}
        </UI.Text>
        <UI.Stack
          gap="tight"
          role="list"
          aria-labelledby="batch-startable-label"
        >
          {view.issues.map((issue, index) => (
            <UI.Inline
              key={issue.externalTicketId}
              gap="compact"
              role="listitem"
            >
              <UI.Text variant="muted">{index + 1}.</UI.Text>
              <UI.Text truncate>
                <UI.Link
                  href={`/issues/${issue.externalTicketId}`}
                  onClick={(event) => {
                    event.preventDefault();
                    void navigate({
                      to: "/issues/$issueId",
                      params: { issueId: issue.externalTicketId },
                    });
                  }}
                >
                  {`#${issue.number} ${
                    issue.title ??
                      translate("batches.start.startable.untitled" as never)
                  }`}
                </UI.Link>
              </UI.Text>
            </UI.Inline>
          ))}
        </UI.Stack>
        <UI.Text variant="hint">
          {translate(
            (view.more
              ? "batches.start.startable.more"
              : "batches.start.startable.checked") as never,
            { time: checked },
          )}
        </UI.Text>
      </UI.Stack>
    );
  })();

  const modeOption = (
    value: ContinueMode,
    title: string,
    description: string,
  ) => (
    <UI.PresetOption
      name="batch-continue-mode"
      value={value}
      checked={form.continueMode === value}
      onChange={() => change({ continueMode: value })}
      title={title}
      description={description}
    />
  );

  return (
    <>
      <ShellActiveNavigation id="issues" />
      <BatchBreadcrumbs current={translate("batches.start.title" as never)} />
      <LeaveGuard
        count={dirty ? 1 : 0}
        discard={() => setLeft(true)}
        path={NEW_BATCH_PATH}
        copy={LEAVE_COPY}
      />
      <UI.Stack gap="spacious" data-testid="batch-start-page">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("batches.start.title" as never)}
          subtitle={translate("batches.start.description" as never)}
        />
        <UI.FormWithSummary
          aside={
            <>
              <UI.Stack gap="compact" data-testid="batch-plan">
                <UI.Heading level="section">
                  {translate("batches.start.summary.title" as never)}
                </UI.Heading>
                <UI.Text>
                  {plan.repository === null
                    ? translate(
                      "batches.start.summary.workNoRepository" as never,
                    )
                    : view !== null && view.issues[0] !== undefined
                    ? translate("batches.start.summary.workFrom" as never, {
                      repository: plan.repository,
                      number: `#${view.issues[0].number}`,
                    })
                    : translate("batches.start.summary.work" as never, {
                      repository: plan.repository,
                    })}
                </UI.Text>
                <UI.Text>
                  {chosenPreset === null
                    ? translate("batches.start.summary.workflowUnset" as never)
                    : translate("batches.start.summary.workflow" as never, {
                      workflow: presetCopy(translate, chosenPreset).title,
                    })}
                </UI.Text>
                <UI.Text>
                  {translate(stopKey as never, {
                    issues: issuesPart,
                    hours: hoursPart,
                    spend: spendPart,
                  })}
                </UI.Text>
                <UI.Text>
                  {modeLabel === null
                    ? translate("batches.start.summary.modeNone" as never)
                    : translate("batches.start.summary.mode" as never, {
                      mode: modeLabel,
                    })}
                </UI.Text>
                <UI.Text>
                  {translate("batches.start.summary.approvals" as never)}
                </UI.Text>
              </UI.Stack>
              <UI.Stack gap="compact">
                <UI.Heading level="section">
                  {translate("batches.start.takes.title" as never)}
                </UI.Heading>
                <UI.Text>
                  {translate("batches.start.takes.body" as never)}
                </UI.Text>
              </UI.Stack>
            </>
          }
          actions={
            <>
              <UI.Button
                variant="secondary"
                disabled={start.isPending}
                onClick={() =>
                  void navigate({
                    to: BATCHES_PATH,
                    search: { repository: undefined },
                  })}
              >
                {translate("batches.start.cancel" as never)}
              </UI.Button>
              <UI.Button
                variant="primary"
                disabled={start.isPending}
                aria-busy={start.isPending || undefined}
                onClick={submit}
              >
                {translate(
                  (start.isPending
                    ? "batches.start.submitting"
                    : "batches.start.submit") as never,
                )}
              </UI.Button>
            </>
          }
        >
          <UI.Stack gap="compact">
            <UI.Heading level="section">
              {translate("batches.start.repository.heading" as never)}
            </UI.Heading>
            {lookups.sourcesReady && choices.length === 0
              ? (
                <UI.InlineNotice tone="information">
                  {translate("batches.start.repository.none" as never)}
                </UI.InlineNotice>
              )
              : (
                <UI.Stack gap="tight">
                  <UI.Combobox
                    id="batch-repository"
                    label={translate(
                      "batches.start.repository.label" as never,
                    )}
                    aria-describedby="batch-repository-note"
                    aria-invalid={repositoryProblem !== null || undefined}
                    value={form.repositoryId}
                    onChange={(event) => {
                      setRepositoryTouched(true);
                      change({ repositoryId: event.target.value });
                    }}
                    options={[
                      {
                        value: "",
                        label: translate(
                          "batches.start.repository.placeholder" as never,
                        ),
                      },
                      ...choices.map((repository) => ({
                        value: repository.id,
                        label: repository.name,
                      })),
                    ]}
                  />
                  <UI.Text
                    id="batch-repository-note"
                    variant={repositoryProblem === null ? "hint" : "error"}
                    role={repositoryProblem === null ? undefined : "alert"}
                  >
                    {repositoryProblem ??
                      translate("batches.start.repository.help" as never)}
                  </UI.Text>
                  {form.repositoryId !== "" && startable.isSuccess &&
                      smallest === null && setupReasons.length === 0
                    ? (
                      <UI.InlineNotice tone="warning">
                        <UI.Stack gap="tight">
                          <UI.Text variant="strong">
                            {translate(
                              "batches.start.spend.blocked.title" as never,
                              { repository: repositoryName ?? "" },
                            )}
                          </UI.Text>
                          <UI.Text>
                            {translate(
                              "batches.start.spend.blocked.body" as never,
                            )}
                          </UI.Text>
                          <UI.Link
                            href="/issues/settings"
                            onClick={(event) => {
                              event.preventDefault();
                              void navigate({ to: "/issues/settings" });
                            }}
                          >
                            {translate(
                              "batches.start.spend.blocked.link" as never,
                            )}
                          </UI.Link>
                        </UI.Stack>
                      </UI.InlineNotice>
                    )
                    : null}
                  {startableSection}
                </UI.Stack>
              )}
          </UI.Stack>
          <UI.Divider />
          <UI.Stack gap="compact" data-testid="batch-workflow-choice">
            <UI.Heading level="section">
              {translate("batches.start.workflow.heading" as never)}
            </UI.Heading>
            <WorkflowChoice
              id="batch-workflow"
              label={translate("batches.start.workflow.label" as never)}
              labelHidden
              items={TICKET_PRESETS.map((id) => ({
                id,
                title: presetCopy(translate, id).title,
                description: presetCopy(translate, id).description,
              }))}
              value={form.presetId}
              onChange={(id) => {
                setPresetTouched(true);
                change({ presetId: id });
              }}
              placeholder={translate(
                "batches.start.workflow.placeholder" as never,
              )}
              error={shown.presetId === undefined
                ? undefined
                : translate(shown.presetId as never)}
            />
            {setupReasons.length === 0 ? null : (
              <div
                id="batch-workflow-setup"
                tabIndex={-1}
                data-testid="batch-workflow-setup"
              >
                <UI.InlineNotice tone="warning">
                  <UI.Stack gap="tight">
                    <UI.Text variant="strong">
                      {setupLabels.setupHeading}
                    </UI.Text>
                    <ul>
                      {setupReasons.map((reason) => (
                        <li data-reason={reason} key={reason}>
                          {setupLabels.setupRequired[reason] ??
                            setupLabels.setupUnknown}
                        </li>
                      ))}
                    </ul>
                  </UI.Stack>
                </UI.InlineNotice>
              </div>
            )}
            <UI.Text variant="hint">{workflowHint}</UI.Text>
          </UI.Stack>
          <UI.Divider />
          <UI.Stack gap="compact">
            <UI.Heading level="section">
              {translate("batches.start.limits.heading" as never)}
            </UI.Heading>
            <UI.Inline gap="standard">
              {numberField(
                "maxIssues",
                translate("batches.start.limits.issues" as never),
                translate("batches.start.limits.issuesUnit" as never),
                translate("batches.start.limits.issuesHelp" as never),
                1,
                20,
              )}
              {numberField(
                "maxHours",
                translate("batches.start.limits.hours" as never),
                translate("batches.start.limits.hoursUnit" as never),
                translate("batches.start.limits.hoursHelp" as never),
                1,
                24,
              )}
              <UI.Field
                htmlFor="batch-maxSpend"
                label={translate("batches.start.limits.spend" as never)}
                hint={smallestText === null
                  ? translate("batches.start.limits.spendHelp" as never)
                  : translate(
                    "batches.start.limits.spendHelpFrom" as never,
                    { amount: smallestText },
                  )}
                error={spendProblem}
              >
                <UI.Inline gap="compact">
                  <UI.Text variant="muted">$</UI.Text>
                  <UI.TextInput
                    autoComplete="off"
                    id="batch-maxSpend"
                    name="maxSpend"
                    type="text"
                    inputMode="decimal"
                    invalid={spendProblem !== undefined}
                    value={form.maxSpend}
                    onChange={(value) => change({ maxSpend: value })}
                  />
                </UI.Inline>
              </UI.Field>
            </UI.Inline>
            {smallestText === null || spendProblem !== undefined
              ? null
              : (
                <UI.Text variant="hint">
                  {translate("batches.start.limits.smallestNote" as never, {
                    amount: smallestText,
                  })}
                </UI.Text>
              )}
            <UI.Text variant="muted">
              {translate("batches.start.limits.note" as never)}
            </UI.Text>
          </UI.Stack>
          <UI.Divider />
          <UI.Stack gap="compact">
            <UI.Heading level="section" id="batch-mode-heading">
              {translate("batches.start.mode.heading" as never)}
            </UI.Heading>
            <UI.Stack
              gap="compact"
              role="radiogroup"
              aria-labelledby="batch-mode-heading"
            >
              {modeOption(
                "carry_on",
                translate("batches.start.mode.carryOn" as never),
                translate("batches.start.mode.carryOnHelp" as never),
              )}
              {modeOption(
                "ask_first",
                translate("batches.start.mode.askFirst" as never),
                translate("batches.start.mode.askFirstHelp" as never),
              )}
            </UI.Stack>
            {shown.continueMode === undefined
              ? null
              : (
                <UI.Text variant="error" role="alert">
                  {translate(shown.continueMode as never)}
                </UI.Text>
              )}
          </UI.Stack>
          {refusal !== null && !refusalAtRepository && !refusalAtSpend
            ? (
              <UI.InlineNotice
                tone="error"
                action={refusal === "alreadyRunning"
                  ? (
                    <UI.Button
                      variant="secondary"
                      onClick={() => void openRunning()}
                    >
                      {translate("batches.start.error.openIt" as never)}
                    </UI.Button>
                  )
                  : undefined}
              >
                {refusalText}
              </UI.InlineNotice>
            )
            : null}
        </UI.FormWithSummary>
      </UI.Stack>
    </>
  );
}
