import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { EvaluationBatch, EvaluationBatchResult } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  evaluationAttemptsQueryOptions,
  evaluationBatchIsLive,
  evaluationBatchQueryOptions,
  evaluationResultsQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { subtractDecimalStrings, usd } from "../screens/usage/usage-money.ts";
import {
  attemptCostKind,
  costDetail,
  countLines,
  gateCard,
  groupByCase,
  hasModelScorer,
  pinTitle,
  repeatSummaries,
  type ResultFilter,
  resultWords,
  runBadge,
  sampledScorers,
  stateChips,
  statesOfFilter,
  type Words,
} from "./library/evaluations-state.ts";

/** Money in the page's words: an amount under a cent reads "Less than $0.01", never "$0.00". */
function useMoney(): (amount: string) => string {
  const { translate } = useI18n();
  return (amount) =>
    usd(
      amount,
      (smallest) =>
        translate("library.evaluation.cost.lessThanCent", { amount: smallest }),
    );
}

/** The attempts behind one result, read only once the person opens them. */
function Attempts(
  { resultId, scorer }: { readonly resultId: string; readonly scorer: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  const money = useMoney();
  const attempts = useQuery(
    evaluationAttemptsQueryOptions(api, scope, resultId),
  );
  if (attempts.isError) {
    return (
      <UI.Text variant="caption">
        {translate("library.evaluation.attempts.error")}
      </UI.Text>
    );
  }
  if (attempts.isPending) {
    return (
      <UI.Text variant="caption" role="status">
        {translate("library.evaluation.attempts.loading")}
      </UI.Text>
    );
  }
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));
  // Newest first, as the design asks.
  const rows = [...attempts.data].sort((a, b) => b.attemptNo - a.attemptNo);
  return (
    <UI.Stack
      aria-label={translate("library.evaluation.attempts.label", { scorer })}
      gap="tight"
      inset="indent"
      role="list"
    >
      {rows.map((attempt) => {
        const words = resultWords(attempt, false);
        const reason = attempt.reason?.trim() ?? "";
        // An attempt cut short says so in its own words; the rest read as a result does.
        const state = attempt.state === "interrupted"
          ? reason === ""
            ? translate("library.evaluation.attempts.interruptedBare")
            : translate("library.evaluation.attempts.interrupted", { reason })
          : translate(words.key, words.values);
        const kind = attemptCostKind(attempt.usage);
        const when = time(attempt.startedAt ?? attempt.createdAt);
        return (
          <div key={attempt.id} role="listitem">
            <UI.Text variant="caption">
              {kind === null
                ? translate("library.evaluation.attempts.line", {
                  number: attempt.attemptNo,
                  time: when,
                  state,
                })
                : translate("library.evaluation.attempts.lineCost", {
                  number: attempt.attemptNo,
                  time: when,
                  state,
                  cost: kind === "unknown" || attempt.usage?.costUsd == null
                    ? translate("library.evaluation.attempts.cost.unknown")
                    : translate(
                      `library.evaluation.attempts.cost.${kind}` as const,
                      { amount: money(attempt.usage.costUsd) },
                    ),
                })}
            </UI.Text>
          </div>
        );
      })}
    </UI.Stack>
  );
}

/**
 * What the run's model scorers cost (design-ux #75, revision 6): spent, the
 * limit it stops at, and the calls whose cost is not known, with a meter and a
 * notice when the limit is reached or the cost cannot be settled. A run of
 * checks has no cost and says so in one line.
 */
function CostSection({ batch }: { readonly batch: EvaluationBatch }) {
  const { translate } = useI18n();
  const money = useMoney();
  if (!hasModelScorer(batch)) {
    return (
      <UI.Text data-testid="evaluation-cost" variant="muted">
        {translate("library.evaluation.cost.checksOnly")}
      </UI.Text>
    );
  }
  const budget = batch.budget;
  const detail = costDetail(budget);
  const spent = money(budget.settledUsd);
  const limit = budget.limitUsd === null ? null : money(budget.limitUsd);
  const unknown = budget.unknownCount;
  // An unknown cost needs no line here: "At least" says it and the third tile counts the calls.
  const spentDetail = detail === "unknown"
    ? undefined
    : detail === "partly"
    ? translate("library.evaluation.cost.spent.partly", {
      amount: money(budget.estimatedUsd),
    })
    : translate(`library.evaluation.cost.spent.${detail}` as const);
  const meterText = limit === null
    ? ""
    : budget.status === "unsettled"
    ? translate("library.evaluation.cost.meter.unsettled")
    : budget.status === "exhausted"
    ? translate("library.evaluation.cost.meter.exhausted")
    : translate("library.evaluation.cost.meter.within", {
      left: money(
        subtractDecimalStrings(budget.limitUsd ?? "0", budget.settledUsd),
      ),
    });
  return (
    <UI.SettingsSection
      data-testid="evaluation-cost"
      title={
        <>
          {translate("library.evaluation.cost.title")}
          <UI.HelpTip label={translate("library.evaluation.cost.helpLabel")}>
            {translate("library.evaluation.cost.help")}
          </UI.HelpTip>
        </>
      }
      variant="stack"
    >
      <UI.Inline gap="standard" variant="thirds">
        <UI.StatTile
          detail={spentDetail}
          label={translate("library.evaluation.cost.spent.label")}
          value={unknown > 0
            ? translate("library.evaluation.cost.spent.atLeast", {
              amount: spent,
            })
            : spent}
        />
        <UI.StatTile
          detail={limit === null
            ? translate("library.evaluation.cost.limit.noneDetail")
            : translate("library.evaluation.cost.limit.detail")}
          label={translate("library.evaluation.cost.limit.label")}
          value={limit ?? translate("library.evaluation.cost.limit.none")}
        />
        <UI.StatTile
          detail={unknown > 0
            ? translate("library.evaluation.cost.unknown.detail")
            : translate("library.evaluation.cost.unknown.noneDetail")}
          label={translate("library.evaluation.cost.unknown.label")}
          value={unknown > 0
            ? translate("library.evaluation.cost.unknown.value", {
              count: unknown,
            })
            : translate("library.evaluation.cost.unknown.none")}
        />
      </UI.Inline>
      {limit !== null && Number(budget.limitUsd) > 0
        ? (
          <UI.Stack gap="compact">
            <UI.UsageMeter
              label={translate("library.evaluation.cost.meter.label")}
              limit={Number(budget.limitUsd)}
              state={budget.status === "exhausted"
                ? "paused"
                : budget.status === "unsettled"
                ? "warning"
                : "ok"}
              value={Number(budget.settledUsd)}
              valueText={meterText}
            />
            <UI.Text variant="caption">{meterText}</UI.Text>
          </UI.Stack>
        )
        : null}
      {limit !== null && budget.status === "unsettled"
        ? (
          <UI.InlineNotice data-testid="evaluation-cost-notice" tone="warning">
            <UI.Stack gap="none">
              <UI.Text>
                {translate("library.evaluation.cost.unsettled.title")}
              </UI.Text>
              <UI.Text variant="caption">
                {translate("library.evaluation.cost.unsettled.body")}
              </UI.Text>
            </UI.Stack>
          </UI.InlineNotice>
        )
        : null}
      {limit !== null && budget.status === "exhausted"
        ? (
          <UI.InlineNotice data-testid="evaluation-cost-notice" tone="warning">
            <UI.Stack gap="none">
              <UI.Text>
                {translate("library.evaluation.cost.exhausted.title")}
              </UI.Text>
              <UI.Text variant="caption">
                {translate("library.evaluation.cost.exhausted.body")}
              </UI.Text>
            </UI.Stack>
          </UI.InlineNotice>
        )
        : null}
    </UI.SettingsSection>
  );
}

/**
 * A model's opinion on a sample of the test cases, reported apart: it never
 * counts toward the quality gate. Its results are not in the Results list; they
 * open here, and are read only once the person opens them.
 */
function SampledSection(
  { batch, live, scorerLine }: {
    readonly batch: EvaluationBatch;
    readonly live: boolean;
    readonly scorerLine: (result: EvaluationBatchResult) => string;
  },
) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const [opened, setOpened] = useState(false);
  const report = batch.optionalReport;
  const read = useInfiniteQuery({
    ...evaluationResultsQueryOptions(
      api,
      scope,
      batch.id,
      undefined,
      live,
      50,
      false,
    ),
    enabled: Boolean(scope.organizationId) && opened && report !== null &&
      report.total > 0,
  });
  if (report === null) return null;
  const groups = groupByCase(
    read.data?.pages.flatMap((page) => page.items) ?? [],
  );
  return (
    <UI.SettingsSection
      data-testid="evaluation-sampled"
      title={
        <>
          {translate("library.evaluation.sampled.title")}
          <UI.HelpTip label={translate("library.evaluation.sampled.helpLabel")}>
            {translate("library.evaluation.sampled.help")}
          </UI.HelpTip>
        </>
      }
      variant="stack"
    >
      <UI.Inline gap="standard">
        {(["passed", "failed", "unknown", "unrun"] as const).map((id) => (
          <UI.Text key={id}>
            {translate(`library.evaluation.sampled.${id}` as const, {
              count: report[id],
            })}
          </UI.Text>
        ))}
      </UI.Inline>
      <UI.Text variant="muted">
        {translate("library.evaluation.sampled.note")}
      </UI.Text>
      {report.total > 0
        ? (
          <UI.Disclosure
            data-testid="evaluation-sampled-results"
            onOpenChange={setOpened}
            summary={translate("library.evaluation.sampled.show", {
              count: report.total,
            })}
          >
            {read.isError
              ? (
                <UI.InlineNotice tone="error">
                  {translate("library.evaluation.results.error")}
                </UI.InlineNotice>
              )
              : read.isPending
              ? <UI.Skeleton shape="row" />
              : (
                <UI.Stack
                  aria-label={translate("library.evaluation.sampled.listLabel")}
                  gap="none"
                  role="list"
                >
                  {groups.map((group) => (
                    <div
                      data-case={group.caseId}
                      key={group.caseId}
                      role="listitem"
                    >
                      <UI.StackedRow title={group.caseName}>
                        <UI.Stack gap="compact">
                          {group.results.map((result) => (
                            <UI.Text key={result.id} variant="caption">
                              {scorerLine(result)}
                            </UI.Text>
                          ))}
                        </UI.Stack>
                      </UI.StackedRow>
                    </div>
                  ))}
                </UI.Stack>
              )}
            {read.hasNextPage
              ? (
                <UI.Button
                  loading={read.isFetchingNextPage}
                  onClick={() => void read.fetchNextPage()}
                  variant="secondary"
                >
                  {translate("library.evaluation.results.more")}
                </UI.Button>
              )
              : null}
          </UI.Disclosure>
        )
        : null}
    </UI.SettingsSection>
  );
}

/**
 * One run of the Evaluations tab (design-ux #75, revision 4): its quality
 * gate, its results by test case and scorer with their attempts, what it used,
 * and a Stop button while it is waiting or running. Comparing with another run
 * is a later slice. The page reads again every ten seconds while the run is live.
 */
export function EvaluationRunPage({ batchId }: { readonly batchId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const run = useQuery(evaluationBatchQueryOptions(api, scope, batchId));
  const batch = run.data;
  const live = batch !== undefined && evaluationBatchIsLive(batch.state);
  const [filter, setFilter] = useState<ResultFilter | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopFailure, setStopFailure] = useState<"changed" | "failed" | null>(
    null,
  );
  const [openAttempts, setOpenAttempts] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // One chip can hold two server states (a result that could not be scored
  // is an error or was never scored): both are read, errors first, and shown
  // as one list.
  const wanted = filter === null ? [undefined] : statesOfFilter(filter);
  const ready = Boolean(scope.organizationId) && batch !== undefined;
  const firstRead = useInfiniteQuery({
    ...evaluationResultsQueryOptions(
      api,
      scope,
      batchId,
      wanted[0],
      live,
      50,
      true,
    ),
    enabled: ready,
  });
  // The second state is read only once the first has no more pages, so errors
  // come first and "Show more" never lands rows between ones already on screen.
  // A read that has not answered yet has no next page either, hence isSuccess.
  const firstDone = firstRead.isSuccess && !firstRead.hasNextPage;
  const secondRead = useInfiniteQuery({
    ...evaluationResultsQueryOptions(
      api,
      scope,
      batchId,
      wanted[1] ?? "unscored",
      live,
      50,
      true,
    ),
    enabled: ready && wanted.length > 1 && firstDone,
  });
  const reads = wanted.length > 1 ? [firstRead, secondRead] : [firstRead];
  const items = reads.flatMap((read) =>
    read.data?.pages.flatMap((page) => page.items) ?? []
  );
  const results = {
    items,
    isError: reads.some((read) => read.isError),
    // The second read waits on the first. While it loads and nothing is on
    // screen yet, the page is still loading: it must not say "no results".
    // Once rows are showing, they stay and the rest joins them.
    isPending: firstRead.isPending ||
      (wanted.length > 1 && firstDone && secondRead.isPending &&
        items.length === 0),
    hasNextPage: reads.some((read) => read.hasNextPage),
    isFetchingNextPage: reads.some((read) => read.isFetchingNextPage),
    fetchNextPage: () => {
      const next = reads.find((read) => read.hasNextPage);
      return next?.fetchNextPage();
    },
  };
  const organizationId = scope.organizationId as string;

  const stop = useMutation({
    mutationKey: ["evaluationBatches.cancel"],
    mutationFn: async (current: EvaluationBatch) => {
      const result = await api.cancelEvaluationBatch({
        organizationId,
        id: current.id,
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });

  // The server lets a developer or an administrator stop a run (evaluationRun:write).
  const canStop = access.data?.role === "admin" ||
    access.data?.capabilities.includes("evaluationRun:write") === true;

  const when = (iso: string, withTime = false) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      ...(withTime ? { timeStyle: "short" as const } : {}),
      timeZone,
    }).format(new Date(iso));
  const words = (entry: Words) => translate(entry.key, entry.values);

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          {
            href: "/library?tab=evaluations",
            label: translate("library.title"),
          },
          {
            label: batch === undefined
              ? translate("library.evaluation.back")
              : words(pinTitle(batch.candidate, batch.candidateDefinition)),
          },
        ]}
      />
    </ShellSlot>
  );
  const heading = (
    <UI.PageHeader
      variant="list"
      flush
      title={translate("library.evaluation.back")}
    />
  );
  const back = () =>
    void navigate({ to: "/library", search: { tab: "evaluations" } });

  if (run.isPending) {
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="evaluation-page" variant="wide">
          {heading}
          <UI.Stack gap="standard" aria-busy="true">
            <UI.Text variant="muted" role="status">
              {translate("library.evaluation.loading")}
            </UI.Text>
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        </UI.SettingsContent>
      </>
    );
  }
  if (run.isError || batch === undefined) {
    const status = failureStatus(run.error);
    const missing = status === 404 || isForbiddenFailure(run.error);
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="evaluation-page" variant="wide">
          {heading}
          {missing
            ? (
              <UI.EmptyState
                title={translate("library.evaluation.notFound.title")}
                description={translate(
                  "library.evaluation.notFound.description",
                )}
                action={
                  <UI.Button variant="secondary" onClick={back}>
                    {translate("library.evaluation.back")}
                  </UI.Button>
                }
                variant="filtered"
              />
            )
            : (
              <UI.ErrorState
                title={translate(
                  asyncKindForError(run.error) === "offline"
                    ? "library.offlineTitle"
                    : "library.evaluation.error.title",
                )}
                description={translate(
                  asyncKindForError(run.error) === "offline"
                    ? "library.offlineDescription"
                    : "library.error.description",
                )}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => void run.refetch()}
                  >
                    {translate("library.evaluation.error.retry")}
                  </UI.Button>
                }
              />
            )}
        </UI.SettingsContent>
      </>
    );
  }

  const badge = runBadge(batch);
  const gate = gateCard(batch);
  const setName = batch.datasetName;
  const lines = countLines(batch.counts);
  const chips = stateChips(batch.counts);
  const groups = groupByCase(results.items);
  const repeatsByCase = new Map(
    groups.map((group) => [group.caseId, repeatSummaries(group.results)]),
  );
  const scorerName = (id: string) =>
    batch.scorers.find((scorer) => scorer.scorerId === id)?.slug ??
      id.slice(0, 8);
  const baseline = batch.baseline === null
    ? null
    : words(pinTitle(batch.baseline, batch.baselineDefinition));

  const scorerLine = (result: EvaluationBatchResult) => {
    const base = scorerName(result.scorerId);
    const scorer = result.repetition > 1
      ? translate("library.evaluation.result.scorerRepetition", {
        scorer: base,
        n: result.repetition,
      })
      : base;
    const text = words(resultWords(result, live));
    return result.score === null
      ? translate("library.evaluation.result.line", { scorer, words: text })
      : translate("library.evaluation.result.lineScore", {
        scorer,
        words: text,
        score: result.score.toLocaleString(locale, {
          maximumFractionDigits: 2,
        }),
      });
  };

  // Unmeasured results in several states: one sentence says where they are.
  const gateBody = translate(gate.body.key, {
    ...gate.body.values,
    ...(gate.spread === null ? {} : {
      states: new Intl.ListFormat(locale, {
        style: "long",
        type: "conjunction",
      })
        .format(
          gate.spread.map((entry) =>
            translate("library.evaluation.gate.spreadItem", {
              state: translate(
                `library.evaluation.state.${entry.state}` as const,
              ),
              count: entry.count,
            })
          ),
        ),
    }),
  });
  const showButton = gate.show === null ? null : (
    <UI.Button
      variant="secondary"
      onClick={() => setFilter(gate.show?.state ?? null)}
    >
      {translate("library.evaluations.gate.show", { count: gate.show.count })}
    </UI.Button>
  );

  const stopDialog = stopping
    ? (
      <UI.AlertDialog
        open
        onOpenChange={(next) => {
          if (!next && !stop.isPending) setStopping(false);
        }}
        state={stop.isPending ? "confirming" : "open"}
        title={translate("library.evaluation.stop.title")}
        variant="destructive"
        cancelAction={
          <UI.Button
            variant="secondary"
            disabled={stop.isPending}
            onClick={() => setStopping(false)}
          >
            {translate("library.evaluation.stop.keep")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            variant="primary"
            disabled={stop.isPending}
            loading={stop.isPending}
            onClick={() => {
              setStopFailure(null);
              stop.mutateAsync(batch).then(
                () => {
                  setStopping(false);
                  focusAfterPaint(() => document.querySelector("main"));
                },
                (error) => {
                  const status = failureStatus(error);
                  setStopFailure(
                    status === 409 || status === 412 ? "changed" : "failed",
                  );
                  if (status === 409 || status === 412) setStopping(false);
                },
              );
            }}
          >
            {translate("library.evaluation.stop.confirm")}
          </UI.Button>
        }
      >
        <UI.Stack gap="compact">
          <UI.Text>{translate("library.evaluation.stop.body")}</UI.Text>
          {stopFailure === "failed"
            ? (
              <UI.InlineNotice tone="error">
                {translate("library.evaluation.stop.error")}
              </UI.InlineNotice>
            )
            : null}
        </UI.Stack>
      </UI.AlertDialog>
    )
    : null;

  const stopButton = live && canStop
    ? (
      <UI.Button variant="secondary" onClick={() => setStopping(true)}>
        {translate("library.evaluation.stop.button")}
      </UI.Button>
    )
    : null;

  return (
    <>
      {breadcrumbs}
      {!phone && stopButton !== null
        ? <ShellSlot name="actions">{stopButton}</ShellSlot>
        : null}
      <UI.SettingsContent data-testid="evaluation-page" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={words(pinTitle(batch.candidate, batch.candidateDefinition))}
          subtitle={
            <UI.Stack gap="compact">
              <UI.Text variant="muted">
                {translate("library.evaluation.measuredOn", { set: setName })}
              </UI.Text>
              <UI.Inline gap="compact">
                <UI.Badge tone={badge.tone}>{words(badge.words)}</UI.Badge>
              </UI.Inline>
            </UI.Stack>
          }
          actions={phone ? stopButton : null}
        />
        {stopFailure === "changed"
          ? (
            <UI.InlineNotice tone="information" role="status">
              {translate("library.evaluation.changed")}
            </UI.InlineNotice>
          )
          : null}
        <UI.Stack gap="spacious">
          <UI.InlineNotice
            data-testid="evaluation-gate"
            icon={gate.icon}
            tone={gate.tone}
            action={phone || gate.show === null ? undefined : showButton}
          >
            <UI.Stack gap="compact">
              <UI.Stack gap="none">
                <UI.Text>{words(gate.title)}</UI.Text>
                <UI.Text variant="caption">{gateBody}</UI.Text>
              </UI.Stack>
              {phone && gate.show !== null ? showButton : null}
            </UI.Stack>
          </UI.InlineNotice>

          <UI.SettingsSection
            data-testid="evaluation-results"
            title={translate("library.evaluation.results.title")}
            variant="stack"
          >
            <UI.Inline gap="standard">
              {lines.map((line) => (
                <UI.Text key={line.id}>
                  {translate(`library.evaluation.count.${line.id}` as const, {
                    count: line.count,
                  })}
                </UI.Text>
              ))}
            </UI.Inline>
            <UI.Text variant="muted">
              {translate("library.evaluation.results.summary", {
                measured: batch.measuredCount,
                required: batch.requiredCount,
              })}
            </UI.Text>
            {batch.report.passedOfAttempted === null ||
                batch.report.attempted >= batch.requiredCount
              ? null
              : (
                <UI.Text
                  data-testid="evaluation-attempted-rate"
                  variant="muted"
                >
                  {translate("library.evaluation.results.attemptedRate", {
                    rate: Math.round(batch.report.passedOfAttempted * 100),
                    attempted: batch.report.attempted,
                  })}
                </UI.Text>
              )}
            {batch.report.interrupted > 0
              ? (
                <UI.Text data-testid="evaluation-interrupted" variant="muted">
                  {translate("library.evaluation.results.interruptedLine", {
                    interrupted: batch.report.interrupted,
                    recovered: batch.report.recovered,
                  })}
                </UI.Text>
              )
              : null}
            {chips.length > 0
              ? (
                <UI.SegmentedControl
                  aria-label={translate("library.evaluation.filter.label")}
                  name="evaluation-filter"
                  onChange={(value) =>
                    setFilter(
                      chips.find((chip) => chip.state === value)?.state ?? null,
                    )}
                  options={[
                    {
                      label: translate("library.evaluation.filter.all"),
                      value: "",
                    },
                    ...chips.map((chip) => ({
                      label: translate("library.evaluation.filter.chip", {
                        state: translate(
                          `library.evaluation.state.${chip.state}` as const,
                        ),
                        count: chip.count,
                      }),
                      value: chip.state,
                    })),
                  ]}
                  value={filter ?? ""}
                  variant="inline"
                />
              )
              : null}
            {results.isError
              ? (
                <UI.InlineNotice tone="error">
                  {translate("library.evaluation.results.error")}
                </UI.InlineNotice>
              )
              : results.isPending
              ? <UI.Skeleton shape="row" />
              : groups.length === 0
              ? (
                <UI.Text variant="muted">
                  {translate("library.evaluation.results.empty")}
                </UI.Text>
              )
              : (
                <UI.Stack
                  aria-label={translate("library.evaluation.results.title")}
                  gap="none"
                  role="list"
                >
                  {groups.map((group) => (
                    <div
                      data-case={group.caseId}
                      key={group.caseId}
                      role="listitem"
                    >
                      <UI.StackedRow
                        title={group.caseName}
                      >
                        <UI.Stack gap="compact">
                          {group.results.map((result, index) => (
                            <UI.Stack gap="none" key={result.id}>
                              {repeatsByCase.get(group.caseId)!.has(
                                  result.scorerId,
                                ) &&
                                  group.results.findIndex((other) =>
                                      other.scorerId === result.scorerId
                                    ) === index
                                ? (
                                  <UI.Text variant="caption">
                                    {translate(
                                      "library.evaluation.repeats.summary",
                                      {
                                        scorer: scorerName(result.scorerId),
                                        passed:
                                          repeatsByCase.get(group.caseId)!.get(
                                            result.scorerId,
                                          )!
                                            .passed,
                                        n: repeatsByCase.get(group.caseId)!.get(
                                          result.scorerId,
                                        )!.total,
                                      },
                                    )}
                                  </UI.Text>
                                )
                                : null}
                              <UI.Text variant="caption">
                                {scorerLine(result)}
                              </UI.Text>
                              {result.attemptCount > 1
                                ? (
                                  <UI.Stack gap="compact">
                                    <UI.Inline gap="compact">
                                      <UI.Button
                                        aria-expanded={openAttempts.has(
                                          result.id,
                                        )}
                                        onClick={() =>
                                          setOpenAttempts((current) => {
                                            const next = new Set(current);
                                            if (!next.delete(result.id)) {
                                              next.add(result.id);
                                            }
                                            return next;
                                          })}
                                        variant="text"
                                      >
                                        {translate(
                                          openAttempts.has(result.id)
                                            ? "library.evaluation.attempts.hide"
                                            : "library.evaluation.attempts.toggle",
                                          { count: result.attemptCount },
                                        )}
                                      </UI.Button>
                                    </UI.Inline>
                                    {openAttempts.has(result.id)
                                      ? (
                                        <Attempts
                                          resultId={result.id}
                                          scorer={scorerName(result.scorerId)}
                                        />
                                      )
                                      : null}
                                  </UI.Stack>
                                )
                                : null}
                            </UI.Stack>
                          ))}
                        </UI.Stack>
                      </UI.StackedRow>
                    </div>
                  ))}
                </UI.Stack>
              )}
            {results.hasNextPage
              ? (
                <UI.Button
                  loading={results.isFetchingNextPage}
                  onClick={() => void results.fetchNextPage()}
                  variant="secondary"
                >
                  {translate("library.evaluation.results.more")}
                </UI.Button>
              )
              : null}
          </UI.SettingsSection>

          <CostSection batch={batch} />

          <SampledSection batch={batch} live={live} scorerLine={scorerLine} />

          <UI.SettingsSection
            data-testid="evaluation-used"
            title={translate("library.evaluation.used.title")}
            variant="stack"
          >
            <UI.DescriptionList>
              <UI.DescriptionItem
                title={translate("library.evaluation.used.measured")}
                description={words(
                  pinTitle(batch.candidate, batch.candidateDefinition),
                )}
              />
              {baseline === null ? null : (
                <UI.DescriptionItem
                  title={translate("library.evaluation.used.comparedWith")}
                  description={baseline}
                />
              )}
              <UI.DescriptionItem
                title={translate("library.evaluation.used.testCases")}
                description={translate(
                  "library.evaluation.used.testCasesValue",
                  {
                    set: setName,
                    date: when(batch.createdAt),
                  },
                )}
              />
              <UI.DescriptionItem
                title={translate("library.evaluation.used.scorers")}
                description={batch.scorers.filter((scorer) => scorer.required)
                  .map((scorer) =>
                    translate("library.evaluation.used.scorerValue", {
                      slug: scorer.slug,
                      revision: scorer.scorerRevision,
                    })
                  ).join("; ")}
              />
              {sampledScorers(batch).length === 0 ? null : (
                <UI.DescriptionItem
                  title={translate("library.evaluation.used.sampled")}
                  description={sampledScorers(batch).map((scorer) =>
                    translate("library.evaluation.used.sampledValue", {
                      slug: scorer.slug,
                      revision: scorer.scorerRevision,
                    })
                  ).join("; ")}
                />
              )}
              <UI.DescriptionItem
                title={translate("library.evaluation.used.rule")}
                description={batch.gate.rule}
              />
            </UI.DescriptionList>
          </UI.SettingsSection>
        </UI.Stack>
      </UI.SettingsContent>
      {stopDialog}
    </>
  );
}
