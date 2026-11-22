import { useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { BatchIssueResponse, BatchResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { batchQueryOptions, externalTicketQueryOptions } from "../api/query.ts";
import { failureStatus } from "../app/async-state.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { reasonSentence } from "./IssuesList.tsx";
import { issueNumber, type IssueRow, issueSnapshot } from "./issue-state.ts";
import {
  type BannerAction,
  type BannerFacts,
  bannerFor,
  currentIssue,
  dollars,
  headerButtons,
  issueBadgeFor,
  lastWorkedOn,
  meters,
  stateBadgeFor,
  stopChoices,
  tableIssues,
  timeAgo,
  type WaitingFacts,
  waitingNames,
  waitingView,
} from "./batches/batch-display.ts";
import {
  type ControlRefusal,
  controlRefusal,
} from "./batches/batch-refusal.ts";
import { say } from "./batches/say.ts";
import { BatchBreadcrumbs } from "./batches/BatchBreadcrumbs.tsx";
import { useBatchLookups } from "./batches/use-batch-lookups.ts";

const BATCHES_PATH = "/issues/batches";
const NEW_BATCH_PATH = "/issues/batches/new";

type Control = "pause" | "resume" | "startNext" | "finish";

/** `/issues/batches/{id}`: where a batch stands, what it is waiting for and the issues it has considered. */
export function BatchPage({ batchId }: { batchId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const phone = useShellViewport() === "phone";
  const lookups = useBatchLookups();
  const readerPrincipalId = useSession().identity?.principalId ?? null;

  const options = batchQueryOptions(api, scope, batchId);
  const query = useQuery(options);
  const batch = query.data;

  // The number, title and task of each issue: the batch carries only the issue's id (UX server item 4).
  const tickets = useQueries({
    queries: (batch?.issues ?? []).map((issue) =>
      externalTicketQueryOptions(api, scope, issue.externalTicketId)
    ),
  });
  const ticketOf = (issue: BatchIssueResponse): IssueRow | null => {
    const index = (batch?.issues ?? []).findIndex((item) =>
      item.id === issue.id
    );
    return (tickets[index]?.data as IssueRow | undefined) ?? null;
  };
  const numberOf = (issue: BatchIssueResponse): string | null => {
    const row = ticketOf(issue);
    const number = row === null ? null : issueNumber(row);
    return number === null ? null : String(number);
  };
  const taskOf = (issue: BatchIssueResponse): string | null => {
    const ids = ticketOf(issue)?.linkedTaskIds ?? [];
    return ids.length === 0 ? null : ids[ids.length - 1]!;
  };

  const [notice, setNotice] = useState<ControlRefusal | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopChoice, setStopChoice] = useState<"after" | "cancel">("after");
  const [cancelNowOpen, setCancelNowOpen] = useState(false);

  const settle = (next: BatchResponse) => {
    queryClient.setQueryData(options.queryKey, next);
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
    setNotice(null);
  };
  const refused = (error: unknown) => {
    setNotice(controlRefusal(error));
    // A conflict means the batch moved on: read it again so the page shows the truth.
    void query.refetch();
  };
  const control = useMutation({
    mutationKey: ["batches.control"],
    mutationFn: async (action: Control) => {
      const result = await api.batches.control({
        organizationId: scope.organizationId as string,
        id: batchId,
        action,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: settle,
    onError: refused,
  });
  const stop = useMutation({
    mutationKey: ["batches.stop"],
    mutationFn: async (cancelCurrent: boolean) => {
      const result = await api.batches.stop({
        organizationId: scope.organizationId as string,
        id: batchId,
        cancelCurrent,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (next) => {
      settle(next);
      setStopOpen(false);
      setCancelNowOpen(false);
    },
    onError: (error) => {
      refused(error);
      setStopOpen(false);
      setCancelNowOpen(false);
    },
  });
  const busy = control.isPending || stop.isPending;

  const back = (
    <UI.Button
      variant="secondary"
      onClick={() =>
        void navigate({ to: BATCHES_PATH, search: { repository: undefined } })}
    >
      {translate("batches.page.back" as never)}
    </UI.Button>
  );

  if (query.isPending) {
    return (
      <>
        <ShellActiveNavigation id="issues" />
        <UI.Stack
          gap="spacious"
          aria-busy="true"
          data-testid="batch-page-loading"
        >
          <UI.Skeleton shape="text" />
          <UI.Skeleton shape="surface" />
          <UI.Inline gap="standard" variant="thirds">
            <UI.Skeleton shape="surface" />
            <UI.Skeleton shape="surface" />
            <UI.Skeleton shape="surface" />
          </UI.Inline>
          {[0, 1, 2].map((index) => <UI.Skeleton key={index} shape="row" />)}
        </UI.Stack>
      </>
    );
  }
  if (query.isError || batch === undefined) {
    const notFound = failureStatus(query.error) === 404;
    return (
      <>
        <ShellActiveNavigation id="issues" />
        {notFound
          ? (
            <UI.AlertBanner tone="information" action={back}>
              {translate("batches.page.notFound" as never)}
            </UI.AlertBanner>
          )
          : (
            <UI.ErrorState
              title={translate("batches.page.error" as never)}
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => void query.refetch()}
                >
                  {translate("batches.retry" as never)}
                </UI.Button>
              }
            />
          )}
      </>
    );
  }

  const repository = lookups.repositoryName(batch.repositoryId) ?? "—";
  const someone = translate("batches.someone" as never);
  const current = currentIssue(batch);
  const last = lastWorkedOn(batch);
  const number = (found: typeof current) =>
    found === null ? null : numberOf(found.row);
  const stopped = batch.state === "stopped";
  const paused = batch.state === "paused";
  const who = stopped
    ? lookups.personName(batch.stoppedBy) ?? someone
    : paused
    ? lookups.personName(batch.pausedBy) ?? someone
    : lookups.personName(batch.startedBy) ?? someone;
  const whenIso = stopped || batch.state === "finished"
    ? batch.finishedAt
    : batch.pausedAt;
  // What the current issue waits for a person to do, worded for this reader.
  const waitingFor = waitingView(batch, readerPrincipalId);
  const waiting: WaitingFacts | null = waitingFor === null ? null : {
    view: waitingFor,
    ago: timeAgo(waitingFor.since, Date.now(), locale),
    names: waitingNames(
      waitingFor,
      translate("batches.waitingOn.you" as never),
      locale,
    ),
  };
  const stateBadge = stateBadgeFor(batch, waitingFor);
  const facts: BannerFacts = {
    currentNumber: number(current),
    lastNumber: number(last),
    who,
    when: whenIso === null ? "" : lookups.time(whenIso),
    spent: lookups.money(dollars(batch.spentUsd)),
    limit: lookups.money(dollars(batch.maxSpendUsd)),
    waiting,
  };
  const banner = bannerFor(batch, facts);
  const reading = meters(batch);
  const rows = tableIssues(batch);
  // The server names the task a waiting question is on; before that, the issue's latest task.
  const currentTask = waitingFor?.taskId ??
    (current === null ? null : taskOf(current.row));

  const openTask = (taskId: string | null) =>
    taskId === null
      ? undefined
      : () => void navigate({ to: "/tasks/$taskId", params: { taskId } });

  const actionButton = (action: BannerAction) => {
    switch (action) {
      case "openTask":
        return currentTask === null ? null : (
          <UI.Button
            key={action}
            // The one thing a person must do is the primary button while the batch waits for them.
            variant={waitingFor !== null && batch.state === "running"
              ? "primary"
              : "secondary"}
            onClick={openTask(currentTask)}
          >
            {translate("batches.action.openTask" as never)}
          </UI.Button>
        );
      case "finishHere":
        return lookups.canControl
          ? (
            <UI.Button
              key={action}
              variant="secondary"
              disabled={busy}
              onClick={() => control.mutate("finish")}
            >
              {translate("batches.action.finishHere" as never)}
            </UI.Button>
          )
          : null;
      case "startNext":
        return lookups.canControl
          ? (
            <UI.Button
              key={action}
              variant="primary"
              disabled={busy}
              onClick={() => control.mutate("startNext")}
            >
              {translate("batches.action.startNext" as never)}
            </UI.Button>
          )
          : null;
      case "resume":
        return lookups.canControl
          ? (
            <UI.Button
              key={action}
              variant="primary"
              disabled={busy}
              onClick={() => control.mutate("resume")}
            >
              {translate("batches.action.resume" as never)}
            </UI.Button>
          )
          : null;
      case "startAnother":
        return lookups.canControl
          ? (
            <UI.Button
              key={action}
              variant="primary"
              onClick={() =>
                void navigate({
                  to: NEW_BATCH_PATH,
                  search: { repository: batch.repositoryId },
                })}
            >
              {translate("batches.action.startAnother" as never)}
            </UI.Button>
          )
          : null;
    }
  };
  const bannerButtons = banner.actions.map(actionButton).filter(Boolean);

  const headerAction = (button: ReturnType<typeof headerButtons>[number]) => {
    if (!lookups.canControl) return null;
    switch (button) {
      case "pause":
        return (
          <UI.Button
            key={button}
            variant="secondary"
            disabled={busy}
            title={translate("batches.button.pauseTip" as never)}
            onClick={() => control.mutate("pause")}
          >
            {translate("batches.button.pause" as never)}
          </UI.Button>
        );
      case "stop":
        return (
          <UI.Button
            key={button}
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setStopChoice("after");
              setStopOpen(true);
            }}
          >
            {translate("batches.button.stop" as never)}
          </UI.Button>
        );
      case "cancelNow":
        return (
          <UI.Button
            key={button}
            variant="destructive"
            disabled={busy}
            onClick={() => setCancelNowOpen(true)}
          >
            {translate("batches.button.cancelNow" as never, {
              number: facts.currentNumber ?? "",
            })}
          </UI.Button>
        );
    }
  };
  const headerNodes = headerButtons(batch).map(headerAction).filter(Boolean);

  const headerRow = <UI.Inline gap="compact">{headerNodes}</UI.Inline>;
  const meterBlock = (
    kind: "issues" | "time" | "spend",
    label: string,
    help: string,
    valueText: string,
    value: number,
    limit: number,
    state: "ok" | "warning",
  ) => (
    <UI.Stack gap="compact" data-testid={`batch-meter-${kind}`}>
      <UI.Text variant="caption">{label}</UI.Text>
      <UI.Text variant="strong">{valueText}</UI.Text>
      <UI.UsageMeter
        label={label}
        value={value}
        limit={limit}
        valueText={valueText}
        state={state}
      />
      <UI.Text variant="caption">{help}</UI.Text>
    </UI.Stack>
  );
  const spendText = reading.spend.over === null
    ? translate("batches.meter.of" as never, {
      value: lookups.money(reading.spend.value),
      limit: lookups.money(reading.spend.limit),
    })
    : translate("batches.meter.over" as never, {
      value: lookups.money(reading.spend.value),
      limit: lookups.money(reading.spend.limit),
      over: lookups.money(reading.spend.over),
    });

  const issueLink = (issue: BatchIssueResponse) => {
    const row = ticketOf(issue);
    const n = numberOf(issue);
    const title = row === null ? "" : issueSnapshot(row).title;
    const link = (
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
        {[n === null ? null : `#${n}`, title].filter(Boolean).join(" ")}
      </UI.Link>
    );
    return link;
  };
  /** Why a passed-over issue was left out, in the Issues page's words. */
  const passedOverReason = (issue: BatchIssueResponse): string | null => {
    const row = ticketOf(issue);
    return issue.state === "passed_over" && row !== null &&
        issue.reason !== null
      ? reasonSentence(row, issue.reason, translate)
      : null;
  };
  /** The table's issue cell: the link, and under it why a passed-over issue was left out. */
  const issueCell = (issue: BatchIssueResponse) => {
    const reason = passedOverReason(issue);
    return reason === null ? issueLink(issue) : (
      <UI.Stack gap="none">
        {issueLink(issue)}
        <UI.Text variant="caption">{reason}</UI.Text>
      </UI.Stack>
    );
  };
  const costCell = (issue: BatchIssueResponse) =>
    issue.state === "passed_over"
      ? ""
      : issue.state === "started"
      ? translate("batches.issues.cost.soFar" as never, {
        amount: lookups.money(dollars(issue.costUsd)),
      })
      : lookups.money(dollars(issue.costUsd));
  const taskButton = (issue: BatchIssueResponse) => {
    const taskId = taskOf(issue);
    return taskId === null || issue.state === "passed_over"
      ? null
      : (
        <UI.Button variant="secondary" onClick={openTask(taskId)}>
          {translate("batches.action.openTask" as never)}
        </UI.Button>
      );
  };
  const issueBadge = (issue: BatchIssueResponse) => {
    // The row agrees with the banner in every state that says the issue waits.
    const badge = issueBadgeFor(issue.state, waitingFor !== null);
    return (
      <UI.Badge tone={badge.tone}>{translate(badge.key as never)}</UI.Badge>
    );
  };

  type TableRow = { issue: BatchIssueResponse; position: number | null };
  const tableRows: TableRow[] = [
    ...rows.numbered.map(({ row, position }) => ({ issue: row, position })),
    ...rows.passedOver.map((issue) => ({ issue, position: null })),
  ];
  const merged = rows.numbered.filter(({ row }) => row.state === "merged")
    .length;

  const mode = translate(
    (batch.continueMode === "carry_on"
      ? "batches.page.mode.carryOn"
      : "batches.page.mode.askFirst") as never,
  );

  return (
    <>
      <ShellActiveNavigation id="issues" />
      <BatchBreadcrumbs
        current={translate("batches.page.title" as never, { repository })}
      />
      {headerNodes.length > 0 && !phone
        ? <ShellSlot name="actions">{headerRow}</ShellSlot>
        : null}
      <UI.Stack gap="spacious" data-testid="batch-page">
        <UI.PageHeader
          variant="list"
          flush
          title={
            <>
              {translate("batches.page.title" as never, { repository })}{" "}
              <UI.Badge tone={stateBadge.tone}>
                {translate(stateBadge.key as never)}
              </UI.Badge>
            </>
          }
          subtitle={translate("batches.page.subtitle" as never, {
            name: lookups.personName(batch.startedBy) ?? someone,
            time: lookups.time(batch.startedAt),
            mode,
          })}
          actions={headerNodes.length === 0 || !phone ? null : headerRow}
        />
        {notice === null
          ? null
          : (
            <UI.InlineNotice tone="error" onDismiss={() => setNotice(null)}>
              {translate(
                (notice === "conflict"
                  ? "batches.page.conflict"
                  : notice === "notAllowed"
                  ? "batches.start.error.forbidden"
                  : "batches.page.actionFailed") as never,
              )}
            </UI.InlineNotice>
          )}
        <UI.AlertBanner
          actionLayout="stretch"
          tone={banner.tone === "neutral" ? "information" : banner.tone}
          action={bannerButtons.length === 0
            ? undefined
            : (
              <UI.Inline gap="compact">
                {bannerButtons}
              </UI.Inline>
            )}
          data-testid="batch-banner"
        >
          <UI.Stack gap="none">
            <UI.Text variant="strong">{say(translate, banner.title)}</UI.Text>
            <UI.Text variant="muted">{say(translate, banner.body)}</UI.Text>
            {banner.extra === undefined
              ? null
              : (
                <UI.Text variant="muted" data-testid="batch-banner-waiting">
                  {say(translate, banner.extra)}
                </UI.Text>
              )}
          </UI.Stack>
        </UI.AlertBanner>
        <UI.Inline gap="standard" variant="thirds">
          {meterBlock(
            "issues",
            translate("batches.meter.issues.label" as never),
            translate("batches.meter.issues.help" as never),
            translate("batches.meter.of" as never, {
              value: reading.issues.value,
              limit: reading.issues.limit,
            }),
            reading.issues.value,
            reading.issues.limit,
            reading.issues.state,
          )}
          {meterBlock(
            "time",
            translate("batches.meter.time.label" as never),
            translate("batches.meter.time.help" as never),
            translate("batches.meter.of" as never, {
              value: lookups.duration(reading.time.value),
              limit: lookups.duration(reading.time.limit),
            }),
            reading.time.value,
            reading.time.limit,
            reading.time.state,
          )}
          {meterBlock(
            "spend",
            translate("batches.meter.spend.label" as never),
            translate("batches.meter.spend.help" as never),
            spendText,
            reading.spend.value,
            reading.spend.limit,
            reading.spend.state,
          )}
        </UI.Inline>
        <UI.Stack gap="compact">
          <UI.Inline gap="compact" variant="between">
            <UI.Heading level="section">
              {translate("batches.issues.heading" as never)}
            </UI.Heading>
            <UI.Text variant="muted">
              {translate("batches.issues.summary" as never, {
                merged,
                passed: rows.passedOver.length,
              })}
            </UI.Text>
          </UI.Inline>
          {tableRows.length === 0
            ? (
              <UI.Text variant="muted">
                {translate("batches.issues.empty" as never)}
              </UI.Text>
            )
            : phone
            ? (
              <UI.Stack
                gap="none"
                role="list"
                aria-label={translate("batches.issues.caption" as never)}
              >
                {tableRows.map(({ issue, position }) => (
                  <div key={issue.id} role="listitem">
                    <UI.StackedRow
                      titleLines="wrap"
                      title={issueLink(issue)}
                      status={issueBadge(issue)}
                      selected={issue.state === "started"}
                    >
                      <UI.Stack gap="tight">
                        {passedOverReason(issue) === null
                          ? null
                          : (
                            <UI.Text variant="caption">
                              {passedOverReason(issue)}
                            </UI.Text>
                          )}
                        <UI.Text variant="caption">
                          {[
                            position === null ? null : `${position}`,
                            issue.startedAt === null
                              ? null
                              : lookups.time(issue.startedAt),
                            costCell(issue),
                          ].filter(Boolean).join(" · ")}
                        </UI.Text>
                        {taskButton(issue)}
                      </UI.Stack>
                    </UI.StackedRow>
                  </div>
                ))}
              </UI.Stack>
            )
            : (
              <UI.DataTable
                variant="ruled"
                inset="edge"
                rowSize="double"
                caption={translate("batches.issues.caption" as never)}
                captionHidden
                rows={tableRows}
                getRowKey={({ issue }) => issue.id}
                getRowAttributes={({ issue }) => ({
                  "data-batch-issue": issue.id,
                  ...(issue.state === "started"
                    ? { "data-selected": "true" }
                    : {}),
                })}
                columns={[
                  {
                    id: "position",
                    header: translate("batches.issues.col.position" as never),
                    width: "56px",
                    cell: ({ position }) => position === null ? "" : position,
                  },
                  {
                    id: "issue",
                    header: translate("batches.issues.col.issue" as never),
                    cell: ({ issue }) => issueCell(issue),
                  },
                  {
                    id: "state",
                    header: translate("batches.issues.col.state" as never),
                    width: "128px",
                    cell: ({ issue }) => issueBadge(issue),
                  },
                  {
                    id: "started",
                    header: translate("batches.issues.col.started" as never),
                    width: "172px",
                    cell: ({ issue }) =>
                      issue.startedAt === null
                        ? ""
                        : lookups.time(issue.startedAt),
                  },
                  {
                    id: "cost",
                    header: translate("batches.issues.col.cost" as never),
                    width: "140px",
                    align: "end",
                    cell: ({ issue }) => costCell(issue),
                  },
                  {
                    id: "task",
                    // The button says it; the heading is kept for screen readers only.
                    header: (
                      <UI.VisuallyHidden>
                        {translate("batches.action.openTask" as never)}
                      </UI.VisuallyHidden>
                    ),
                    width: "128px",
                    align: "end",
                    cell: ({ issue }) => taskButton(issue),
                  },
                ]}
              />
            )}
        </UI.Stack>
      </UI.Stack>
      <UI.AlertDialog
        open={stopOpen}
        onOpenChange={(open) => !open && !stop.isPending && setStopOpen(false)}
        state={stop.isPending ? "confirming" : "open"}
        variant="destructive"
        title={translate("batches.stop.title" as never)}
        cancelAction={
          <UI.Button
            variant="secondary"
            disabled={stop.isPending}
            onClick={() => setStopOpen(false)}
          >
            {translate("batches.stop.keep" as never)}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            variant="destructive"
            disabled={stop.isPending}
            aria-busy={stop.isPending || undefined}
            onClick={() =>
              stop.mutate(
                stopChoices(batch) === "choice" && stopChoice === "cancel",
              )}
          >
            {translate("batches.stop.confirm" as never)}
          </UI.Button>
        }
      >
        {stopChoices(batch) === "choice"
          ? (
            <UI.Stack gap="compact">
              <UI.Text>{translate("batches.stop.body" as never)}</UI.Text>
              <UI.Stack
                gap="compact"
                role="radiogroup"
                aria-label={translate("batches.stop.title" as never)}
              >
                <UI.PresetOption
                  name="batch-stop-choice"
                  value="after"
                  checked={stopChoice === "after"}
                  onChange={() => setStopChoice("after")}
                  title={translate("batches.stop.after" as never, {
                    number: facts.currentNumber ?? "",
                  })}
                  description={translate("batches.stop.afterHelp" as never, {
                    number: facts.currentNumber ?? "",
                  })}
                />
                <UI.PresetOption
                  name="batch-stop-choice"
                  value="cancel"
                  checked={stopChoice === "cancel"}
                  onChange={() => setStopChoice("cancel")}
                  title={translate("batches.stop.cancel" as never, {
                    number: facts.currentNumber ?? "",
                  })}
                  description={translate("batches.stop.cancelHelp" as never, {
                    number: facts.currentNumber ?? "",
                  })}
                />
              </UI.Stack>
            </UI.Stack>
          )
          : <UI.Text>{translate("batches.stop.nothing" as never)}</UI.Text>}
      </UI.AlertDialog>
      <UI.AlertDialog
        open={cancelNowOpen}
        onOpenChange={(open) =>
          !open && !stop.isPending && setCancelNowOpen(false)}
        state={stop.isPending ? "confirming" : "open"}
        variant="destructive"
        title={translate("batches.cancelNow.title" as never, {
          number: facts.currentNumber ?? "",
        })}
        cancelAction={
          <UI.Button
            variant="secondary"
            disabled={stop.isPending}
            onClick={() => setCancelNowOpen(false)}
          >
            {translate("batches.cancelNow.keep" as never)}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            variant="destructive"
            disabled={stop.isPending}
            aria-busy={stop.isPending || undefined}
            onClick={() => stop.mutate(true)}
          >
            {translate("batches.cancelNow.confirm" as never, {
              number: facts.currentNumber ?? "",
            })}
          </UI.Button>
        }
      >
        <UI.Text>{translate("batches.cancelNow.body" as never)}</UI.Text>
      </UI.AlertDialog>
    </>
  );
}
