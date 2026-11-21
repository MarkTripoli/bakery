import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { LeaveGuard } from "./repository-rules/leave-guard.tsx";
import {
  type ContinueMode,
  isDirty,
  planValues,
  START_DEFAULTS,
  startBody,
  type StartForm,
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

const BATCHES_PATH = "/issues/batches";
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
  // Until the person picks one, the repository the address named is the choice.
  const [repositoryTouched, setRepositoryTouched] = useState(false);
  const form: StartForm = {
    ...typed,
    repositoryId: repositoryTouched ? typed.repositoryId : preselected,
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

  const errors = validateStart(form);
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
    onError: (error) => setRefusal(createRefusal(error)),
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
    if (Object.keys(errors).length > 0) return;
    start.mutate();
  };

  const dirty = isDirty(form, preselected) && !left;
  const refusalText = refusal === null ? null : translate(
    CREATE_REFUSAL_KEY[refusal] as never,
    { repository: repositoryName ?? "" },
  );
  const refusalAtRepository = refusal !== null &&
    createRefusalPlace(refusal) === "repository";
  const repositoryProblem = shown.repositoryId !== undefined
    ? translate(shown.repositoryId as never)
    : refusalAtRepository
    ? refusalText
    : null;

  const plan = planValues(form, repositoryName, locale);
  const issuesPart = plan.issues === "…" ? "…" : translate(
    "batches.start.summary.issuesPart" as never,
    { count: Number(plan.issues) },
  );
  const hoursPart = plan.hours === "…" ? "…" : translate(
    "batches.start.summary.hoursPart" as never,
    { count: Number(plan.hours) },
  );
  const modeLabel = plan.mode === "carry_on"
    ? translate("batches.start.mode.carryOn" as never)
    : plan.mode === "ask_first"
    ? translate("batches.start.mode.askFirst" as never)
    : "…";

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
                  {translate("batches.start.summary.work" as never, {
                    repository: plan.repository,
                  })}
                </UI.Text>
                <UI.Text>
                  {translate("batches.start.summary.stop" as never, {
                    issues: issuesPart,
                    hours: hoursPart,
                    spend: plan.spend,
                  })}
                </UI.Text>
                <UI.Text>
                  {translate("batches.start.summary.mode" as never, {
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
                </UI.Stack>
              )}
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
                hint={translate("batches.start.limits.spendHelp" as never)}
                error={shown.maxSpend === undefined
                  ? undefined
                  : translate(shown.maxSpend as never)}
              >
                <UI.Inline gap="compact">
                  <UI.Text variant="muted">$</UI.Text>
                  <UI.TextInput
                    autoComplete="off"
                    id="batch-maxSpend"
                    name="maxSpend"
                    type="text"
                    inputMode="decimal"
                    invalid={shown.maxSpend !== undefined}
                    value={form.maxSpend}
                    onChange={(value) => change({ maxSpend: value })}
                  />
                </UI.Inline>
              </UI.Field>
            </UI.Inline>
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
          {refusal !== null && !refusalAtRepository
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
