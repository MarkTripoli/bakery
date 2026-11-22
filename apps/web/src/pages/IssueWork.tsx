import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type {
  TicketRequestViewResponse,
  TicketTaskLinkResponse,
} from "../api/client.ts";
import {
  openQuestionsQueryOptions,
  organizationMembersQueryOptions,
  pullRequestsQueryOptions,
  questionsQueryOptions,
  repositoryQueryOptions,
  runControlCapabilitiesQueryOptions,
  taskQueryOptions,
  ticketLinksByIssueQueryOptions,
  ticketRequestsQueryOptions,
} from "../api/query.ts";
import { failureStatus } from "../app/async-state.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ageOf } from "./issue-state.ts";
import {
  currentRequest,
  noteView,
  PROGRESS_TONE,
  progressNext,
  progressReason,
  questionRow,
  type QuestionRowView,
  startedBy,
  STOP_POLL_MS,
  STOP_SLOW_MS,
  stoppableRunId,
  stopsBeforeStart,
  waitsOnAnswer,
  workFinished,
  type WorkStartedBy,
} from "./issues/work-model.ts";

/** Focus the element with this test id once the screen has settled: where each exit of the Stop work question lands. */
function focusTestId(testId: string): void {
  focusAfterPaint(() =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  );
}

type Translate = ReturnType<typeof useI18n>["translate"];

/** The catalog key for who started the work: a known person is named, an unknown one is "a teammate". */
function byKey(by: WorkStartedBy): string {
  if (by.kind === "member" && by.name !== null) return "named";
  if (by.kind === "memberAdopted" && by.name !== null) return "namedAdopted";
  return by.kind;
}

/** "12 minutes ago", or "just now" inside the first minute. */
function ago(at: string, translate: Translate): string {
  const age = ageOf(at, Date.now());
  if (age === null) return "";
  if (age === "now") return translate("issues.work.justNow" as never);
  return translate("issues.work.ago" as never, {
    age: translate(`issues.age.${age.unit}` as never, { count: age.count }),
  });
}

/** A pull request a task opened, as "#214 Open" with its link to GitHub. */
function PullRequests({ taskId }: { readonly taskId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const pulls = useQuery({
    ...pullRequestsQueryOptions(api, scope, taskId),
    enabled: scope.organizationId !== null,
  });
  const items = pulls.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <>
      {items.map((pull) => (
        <UI.Inline gap="compact" key={pull.id}>
          {pull.url.startsWith("https://")
            ? (
              <UI.Link
                href={pull.url}
                variant="quiet"
                target="_blank"
                rel="noreferrer"
                aria-label={translate("issues.work.pullNamed" as never, {
                  number: pull.providerNumber,
                })}
              >
                #{pull.providerNumber}
                <span aria-hidden="true">↗</span>
              </UI.Link>
            )
            : <UI.Text>#{pull.providerNumber}</UI.Text>}
          <UI.Badge
            tone={pull.status === "merged"
              ? "success"
              : pull.status === "open"
              ? "information"
              : "neutral"}
          >
            {translate(`issues.work.pull.${pull.status}` as never)}
          </UI.Badge>
        </UI.Inline>
      ))}
    </>
  );
}

/**
 * The row at the top of "Bakery's work" while the task waits on a question: what
 * it asks and one way to answer it. The answer form stays on the task page, so
 * there is one place to answer; this row only points at it.
 */
function QuestionRow(
  { row, taskId, canWrite, phone }: {
    readonly row: QuestionRowView;
    readonly taskId: string;
    /** Developers and administrators may answer; others see who can. */
    readonly canWrite: boolean;
    /** On a phone the button goes under the text, the width of the row. */
    readonly phone: boolean;
  },
) {
  const navigate = useNavigate();
  const { translate } = useI18n();
  if (row.kind === "expired") {
    // The way to the task is the "Open task" button of the line below.
    return (
      <UI.InlineNotice tone="neutral">
        {translate("issues.work.question.expired" as never)}
      </UI.InlineNotice>
    );
  }
  const answer = canWrite
    ? (
      <UI.Button
        variant="primary"
        onClick={() =>
          void navigate({ to: "/tasks/$taskId", params: { taskId } })}
      >
        {translate("issues.work.question.answer" as never)}
      </UI.Button>
    )
    : undefined;
  return (
    <UI.InlineNotice
      tone="warning"
      data-testid="issue-question"
      action={phone ? undefined : answer}
    >
      <UI.Stack gap="compact">
        <UI.Text variant="strong">
          {translate(
            (row.count === 1
              ? "issues.work.question.one"
              : "issues.work.question.many") as never,
            { count: row.count },
          )}
        </UI.Text>
        {row.lines.map((line, index) => (
          <UI.Text key={index} lines={2}>{line}</UI.Text>
        ))}
        <UI.Text variant="caption">
          {translate("issues.work.question.asked" as never, {
            when: ago(row.askedAt, translate),
          })}
        </UI.Text>
        {canWrite ? null : (
          <UI.Text variant="caption">
            {translate("issues.work.question.cannot" as never)}
          </UI.Text>
        )}
        {phone ? answer : null}
      </UI.Stack>
    </UI.InlineNotice>
  );
}

const TASK_TONE = {
  draft: "neutral",
  queued: "information",
  active: "information",
  waiting_input: "warning",
  blocked: "warning",
  completed: "success",
  failed: "danger",
  canceled: "neutral",
} as const;

/** One repository the work went to: its role, its name, how that part is going, its pull requests. */
function RepositoryLine(
  { target }: { readonly target: TicketRequestViewResponse["targets"][number] },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const repository = useQuery({
    ...repositoryQueryOptions(api, scope, target.repositoryId),
    enabled: scope.organizationId !== null,
  });
  const task = useQuery({
    ...taskQueryOptions(api, scope, target.childTaskId ?? ""),
    enabled: scope.organizationId !== null && target.childTaskId !== null,
  });
  return (
    <UI.DescriptionItem
      title={
        <UI.Inline gap="compact">
          <UI.Text>{target.role}</UI.Text>
          <UI.Text variant="muted">
            {repository.data
              ? `${repository.data.owner}/${repository.data.name}`
              : translate("issues.work.repositoryLoading" as never)}
          </UI.Text>
        </UI.Inline>
      }
      action={
        <UI.Inline gap="compact">
          {task.data
            ? (
              <UI.Badge tone={TASK_TONE[task.data.status]}>
                {translate(`issues.work.task.${task.data.status}` as never)}
              </UI.Badge>
            )
            : null}
          {target.childTaskId !== null
            ? <PullRequests taskId={target.childTaskId} />
            : null}
        </UI.Inline>
      }
    />
  );
}

/** A task that only mentions the issue: its title and state. */
function MentionedTask({ link }: { readonly link: TicketTaskLinkResponse }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const task = useQuery({
    ...taskQueryOptions(api, scope, link.taskId),
    enabled: scope.organizationId !== null,
  });
  if (!task.data) return null;
  return (
    <UI.Inline gap="compact">
      <UI.Link
        href={`/tasks/${link.taskId}`}
        variant="quiet"
        onClick={(event) => {
          event.preventDefault();
          void navigate({
            to: "/tasks/$taskId",
            params: { taskId: link.taskId },
          });
        }}
      >
        {task.data.title}
      </UI.Link>
      <UI.Badge tone={TASK_TONE[task.data.status]}>
        {translate(`issues.work.task.${task.data.status}` as never)}
      </UI.Badge>
    </UI.Inline>
  );
}

/** Bakery's note on the GitHub issue: how it is doing and the one action it earns. */
function NoteLine(
  { link, issueUrl, canWrite }: {
    readonly link: TicketTaskLinkResponse;
    readonly issueUrl: string;
    readonly canWrite: boolean;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const resync = useMutation({
    mutationKey: ["ticketTaskLinks.resyncNote", link.id],
    mutationFn: async () => {
      const result = await api.tickets.resyncNote({
        organizationId: scope.organizationId as string,
        linkId: link.id,
        version: link.version,
        idempotencyKey: crypto.randomUUID(),
      });
      // Already updating is not an error: the note is on its way.
      if (!result.ok && failureStatus(result.error) !== 409) throw result.error;
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });
  const view = noteView(link);
  const updating = resync.isPending || view.state === "pending";
  const words = updating
    ? translate("issues.work.note.pending" as never)
    : view.state === "failed"
    ? translate("issues.work.note.failed" as never, {
      reason: translate(`issues.work.note.reason.${view.reason}` as never),
    })
    : translate(`issues.work.note.${view.state}` as never);
  const action = updating
    ? null
    : view.state === "healthy" || view.state === "recreated"
    ? "view"
    : view.state === "unknown"
    ? "post"
    : "retry";
  return (
    <UI.Inline gap="compact" aria-live="polite">
      <UI.Text variant="muted">
        {translate("issues.work.note.label" as never)}: {words}
      </UI.Text>
      {action === "view"
        ? (
          <UI.Link
            href={issueUrl}
            variant="quiet"
            target="_blank"
            rel="noreferrer"
          >
            {translate("issues.work.note.view" as never)}
            <span aria-hidden="true">↗</span>
          </UI.Link>
        )
        : null}
      {(action === "post" || action === "retry") && canWrite
        ? (
          <UI.Button
            variant="quiet"
            disabled={resync.isPending}
            onClick={() => resync.mutate()}
          >
            {translate(
              (action === "post"
                ? "issues.work.note.post"
                : "issues.work.note.retry") as never,
            )}
          </UI.Button>
        )
        : null}
    </UI.Inline>
  );
}

/**
 * "Bakery's work" on the issue page: how far the work has got, where it went, its
 * pull requests and Bakery's note on GitHub. Not shown until there is some work.
 */
export function IssueWork(
  { issueId, issueNumber, issueUrl, canWrite, reasonSentence }: {
    readonly issueId: string;
    /** The issue's number, for the question Stop work asks. */
    readonly issueNumber: number | null;
    readonly issueUrl: string;
    /** Developers and administrators may retry the note. */
    readonly canWrite: boolean;
    /** The sentence for a reason code, in the issue's own words. */
    readonly reasonSentence: (code: string) => string;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const viewer = useSession().identity?.principalId ?? null;
  const queryClient = useQueryClient();
  // The request this person asked to stop, and when: it reads "Stopping…" until
  // the server reports the work ended, and is read again every few seconds.
  const [stopped, setStopped] = useState<
    { readonly requestId: string; readonly at: number } | null
  >(null);
  const [confirming, setConfirming] = useState(false);
  const [slow, setSlow] = useState(false);
  const requests = useQuery({
    ...ticketRequestsQueryOptions(api, scope, issueId),
    refetchInterval: (query) => {
      if (stopped === null) return false;
      const latest = currentRequest(query.state.data?.items ?? []);
      return latest?.id === stopped.requestId && !workFinished(latest.progress)
        ? STOP_POLL_MS
        : false;
    },
  });
  const links = useQuery(ticketLinksByIssueQueryOptions(api, scope, issueId));
  const members = useQuery(organizationMembersQueryOptions(api, scope));
  const nameOf = (principalId: string) =>
    members.data?.items.find((member) => member.principalId === principalId)
      ?.displayName ?? null;
  const request = currentRequest(requests.data?.items ?? []);
  const runId = request === null ? null : stoppableRunId(request);
  const stopping = request !== null && stopped?.requestId === request.id &&
    !workFinished(request.progress);
  // Whether this person may stop the run is the run's own read, as on the task page.
  const capabilities = useQuery({
    ...runControlCapabilitiesQueryOptions(api, scope, runId ?? ""),
    enabled: scope.organizationId !== null && runId !== null &&
      stopped === null,
  });
  const mayStop = runId !== null &&
    (capabilities.data?.actions.some((item) =>
      item.action === "cancel" && item.canRequest
    ) ?? false);
  const stop = useMutation({
    mutationKey: ["runs.control", "cancel"],
    mutationFn: async (target: { requestId: string; runId: string }) => {
      const result = await api.controlRun({
        organizationId: scope.organizationId as string,
        runId: target.runId,
        input: { action: "cancel" },
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (_run, target) =>
      setStopped({ requestId: target.requestId, at: Date.now() }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });
  const progress = request?.progress ?? null;
  // A paused request can show "paused" for a while after the run is stopped.
  useEffect(() => {
    setSlow(false);
    if (stopped === null || progress !== "suspended") return;
    const timer = setTimeout(
      () => setSlow(true),
      Math.max(0, STOP_SLOW_MS - (Date.now() - stopped.at)),
    );
    return () => clearTimeout(timer);
  }, [stopped, progress]);
  // The work this person stopped has ended: the issue's own status card reads
  // the same request, so it is read again once, instead of saying "in progress"
  // beside Stopped.
  const stoppedAndEnded = stopped !== null && request !== null &&
    request.id === stopped.requestId && workFinished(request.progress);
  useEffect(() => {
    if (!stoppedAndEnded) return;
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  }, [stoppedAndEnded, queryClient]);
  const linkItems = links.data?.items ?? [];
  const own = request === null
    ? undefined
    : linkItems.find((link) => link.id === request.ticketTaskLinkId);
  const mentioned = linkItems.filter((link) => link.id !== own?.id);
  const task = useQuery({
    ...taskQueryOptions(api, scope, own?.taskId ?? ""),
    enabled: scope.organizationId !== null && own !== undefined,
  });
  // Read once: the row and the progress badge both speak from it.
  const phone = useShellViewport() === "phone";
  // Every open question, paged; the newest page of all questions is read only
  // when none is open, to tell whether the newest one expired.
  const openQuestions = useQuery({
    ...openQuestionsQueryOptions(api, scope, own?.taskId ?? ""),
    enabled: scope.organizationId !== null && own !== undefined,
  });
  const noneOpen = openQuestions.data?.items.length === 0;
  const newestQuestions = useQuery({
    ...questionsQueryOptions(api, scope, own?.taskId ?? ""),
    enabled: scope.organizationId !== null && own !== undefined && noneOpen,
  });
  const questions = openQuestions.isError ? openQuestions : newestQuestions;
  const asking = questionRow(openQuestions.data?.items ?? []) ??
    (noneOpen ? questionRow(newestQuestions.data?.items ?? []) : null);

  if (requests.isPending || links.isPending) {
    return <UI.Skeleton shape="row" />;
  }
  if (requests.isError || links.isError) {
    return (
      <UI.InlineNotice
        tone="error"
        action={
          <UI.Button
            variant="secondary"
            onClick={() => {
              void requests.refetch();
              void links.refetch();
            }}
          >
            {translate("issues.retry" as never)}
          </UI.Button>
        }
      >
        {translate("issues.work.loadFailed" as never)}
      </UI.InlineNotice>
    );
  }
  if (request === null && linkItems.length === 0) return null;

  const by = request === null ? null : startedBy(request, viewer, nameOf);
  const reason = request === null ? null : progressReason(request);
  const next = request === null ? "none" : progressNext(request.progress);
  const repositoryTargets = request?.targets ?? [];
  const stopButton = (
    <UI.Button
      variant="secondary"
      data-testid="issue-stop-work"
      onClick={() => {
        stop.reset();
        setConfirming(true);
      }}
    >
      {translate("issues.work.stop.button" as never)}
    </UI.Button>
  );

  const openTaskButton = next === "openTask" && own !== undefined && !stopping
    ? (
      <UI.Button
        variant="secondary"
        onClick={() =>
          void navigate({
            to: "/tasks/$taskId",
            params: { taskId: own.taskId },
          })}
      >
        {translate("issues.work.openTask" as never)}
      </UI.Button>
    )
    : null;
  // On a phone a row with both buttons shows them as one row of equal buttons.
  const openAndStopTogether = phone && openTaskButton !== null && mayStop &&
    !stopping;

  return (
    <UI.Stack
      gap="standard"
      role="region"
      aria-label={translate("issues.work.title" as never)}
    >
      <UI.Heading level="section">
        {translate("issues.work.title" as never)}
      </UI.Heading>
      {own !== undefined && questions.isError
        ? (
          <UI.InlineNotice
            tone="error"
            action={
              <UI.Button
                variant="secondary"
                onClick={() => void questions.refetch()}
              >
                {translate("issues.retry" as never)}
              </UI.Button>
            }
          >
            {translate("issues.work.question.loadFailed" as never)}
          </UI.InlineNotice>
        )
        : null}
      {own !== undefined && asking !== null
        ? (
          <QuestionRow
            row={asking}
            taskId={own.taskId}
            canWrite={canWrite}
            phone={phone}
          />
        )
        : null}
      {request !== null && by !== null
        ? (
          <UI.Stack
            gap="compact"
            aria-live="polite"
            data-testid="issue-work-progress"
          >
            <UI.Inline gap="compact">
              {stopping
                ? (
                  <UI.Badge tone="neutral">
                    {translate("issues.work.progress.stopping" as never)}
                  </UI.Badge>
                )
                : (
                  <UI.Badge
                    tone={waitsOnAnswer(request.progress, asking)
                      ? "warning"
                      : PROGRESS_TONE[request.progress]}
                  >
                    {translate(
                      (waitsOnAnswer(request.progress, asking)
                        ? "issues.work.progress.needsAnswer"
                        : `issues.work.progress.${request.progress}`) as never,
                    )}
                  </UI.Badge>
                )}
              {reason !== null && !stopping
                ? <UI.Text>{reasonSentence(reason)}</UI.Text>
                : null}
              <UI.Text variant="muted">
                {[
                  translate(`issues.work.by.${byKey(by)}` as never, {
                    label: by.kind === "label" ? by.label ?? "" : "",
                    name: by.kind === "member" || by.kind === "memberAdopted"
                      ? by.name ?? ""
                      : "",
                  }),
                  ago(request.createdAt, translate),
                ].filter(Boolean).join(" · ")}
              </UI.Text>
              {!openAndStopTogether ? openTaskButton : null}
              {mayStop && !stopping && !phone ? stopButton : null}
            </UI.Inline>
            {openAndStopTogether
              ? (
                // One row of two equal buttons, so they read as a pair.
                <UI.Inline variant="actions" gap="compact">
                  {openTaskButton}
                  {stopButton}
                </UI.Inline>
              )
              : mayStop && !stopping && phone
              ? stopButton
              : null}
            {stop.isError && !stopping
              ? (
                <UI.InlineNotice tone="error">
                  {translate("issues.work.stop.failed" as never)}
                </UI.InlineNotice>
              )
              : null}
            {stopping && slow
              ? (
                <UI.Text variant="caption">
                  {translate("issues.work.stop.slow" as never)}
                </UI.Text>
              )
              : null}
            {stopsBeforeStart(request)
              ? (
                <UI.Text variant="caption">
                  {translate("issues.work.stop.beforeStart" as never)}
                </UI.Text>
              )
              : null}
            {confirming && runId !== null
              ? (
                <UI.AlertDialog
                  open
                  data-actions-layout="stack"
                  onOpenChange={(open) => {
                    if (!open && !stop.isPending) {
                      setConfirming(false);
                      focusTestId("issue-stop-work");
                    }
                  }}
                  state={stop.isPending ? "confirming" : "open"}
                  title={issueNumber === null
                    ? translate("issues.work.stop.titleNoNumber" as never)
                    : translate("issues.work.stop.title" as never, {
                      number: issueNumber,
                    })}
                  variant="destructive"
                  cancelAction={
                    <UI.Button
                      variant="secondary"
                      disabled={stop.isPending}
                      onClick={() => {
                        setConfirming(false);
                        focusTestId("issue-stop-work");
                      }}
                    >
                      {translate("issues.work.stop.keep" as never)}
                    </UI.Button>
                  }
                  confirmAction={
                    <UI.Button
                      variant="destructive"
                      disabled={stop.isPending}
                      loading={stop.isPending}
                      onClick={() =>
                        stop.mutateAsync({ requestId: request.id, runId }).then(
                          () => {
                            setConfirming(false);
                            focusTestId("issue-work-progress");
                          },
                          // The notice under the row says it failed; the row is unchanged.
                          () => setConfirming(false),
                        )}
                    >
                      {translate("issues.work.stop.confirm" as never)}
                    </UI.Button>
                  }
                >
                  <UI.Text>
                    {translate("issues.work.stop.body" as never)}
                  </UI.Text>
                </UI.AlertDialog>
              )
              : null}
          </UI.Stack>
        )
        : null}
      {task.data !== undefined && own !== undefined
        ? (
          <UI.Link
            href={`/tasks/${own.taskId}`}
            variant="quiet"
            onClick={(event) => {
              event.preventDefault();
              void navigate({
                to: "/tasks/$taskId",
                params: { taskId: own.taskId },
              });
            }}
          >
            {task.data.title}
          </UI.Link>
        )
        : null}
      {repositoryTargets.length > 1
        ? (
          <UI.DescriptionList>
            {repositoryTargets.map((target) => (
              <RepositoryLine
                key={target.repositoryId + target.role}
                target={target}
              />
            ))}
          </UI.DescriptionList>
        )
        : repositoryTargets.length === 1 &&
            repositoryTargets[0]!.childTaskId !== null
        ? <PullRequests taskId={repositoryTargets[0]!.childTaskId} />
        : own !== undefined
        ? <PullRequests taskId={own.taskId} />
        : null}
      {own !== undefined
        ? <NoteLine link={own} issueUrl={issueUrl} canWrite={canWrite} />
        : null}
      {mentioned.length > 0
        ? (
          <UI.Stack gap="compact">
            <UI.Heading level="section">
              {translate("issues.work.mentionedBy" as never)}
            </UI.Heading>
            {mentioned.map((link) => (
              <MentionedTask
                key={link.id}
                link={link}
              />
            ))}
          </UI.Stack>
        )
        : null}
    </UI.Stack>
  );
}
