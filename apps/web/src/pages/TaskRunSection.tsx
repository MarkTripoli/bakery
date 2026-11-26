import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { JobAttemptRead } from "../api/client.ts";
import {
  runControlCapabilitiesQueryOptions,
  runQueryOptions,
  runStepsListQueryOptions,
} from "../api/query.ts";
import { SessionRunNow, SessionStepThread } from "./SessionStepThread.tsx";
import { useSessionThread } from "./useSessionThread.ts";
import { usePublishNowLine } from "./now-line-slot.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import type { DurableSyncConnectivity } from "../api/durable-sync.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useConnectivity } from "../app/connectivity.ts";
import { formatDate } from "@bakery/i18n";
import { RouterLink } from "../app/router-link.tsx";
import { knownCommits, ReferenceText } from "../app/ReferenceText.tsx";
import { ReferenceLink } from "../app/ReferenceLink.tsx";
import { TaskRunRevision } from "./TaskRunRevision.tsx";
import { TaskRunOutput } from "./TaskRunOutput.tsx";
import { TaskRunControls } from "./TaskRunControls.tsx";
import {
  RunRulesChangedNotice,
  RunRulesDetails,
  useRunRules,
} from "./RunRules.tsx";
import { stepTimelineEvents, stepTitle } from "./task-timeline.ts";
import { TaskRunSectionView } from "./task-run-section-view.tsx";
import { runOutcome, stepName } from "./task-step-approval/model.ts";
import { useStepApproval } from "./task-step-approval/use-step-approval.ts";
import { LINK_SLOT, withLink } from "./with-link.tsx";
import { DeliverySection } from "./task-delivery/DeliverySection.tsx";
import { focusMessageField } from "./task-delivery/focus-message.ts";
import { HandOver } from "./task-handover/HandOver.tsx";
import { useHandoverEvents } from "./task-handover/use-handover-events.ts";
import { RouteWaiting } from "./task-waiting/RouteWaiting.tsx";
import { WaitingFor } from "./task-waiting/WaitingFor.tsx";
import { stepRowCopy } from "./task-waiting/model.ts";
import { useWaitingOffers } from "./task-waiting/use-waiting-offers.ts";

/**
 * Picks the step whose output the run view shows: the viewer's choice when it
 * is still on this page, else the running step, else the latest step that has
 * started, else the first. Never an unstarted step that cannot have output.
 */
function resolveOutputStepId(
  items:
    | readonly { readonly id: string; readonly status: string }[]
    | undefined,
  chosenId: string | null,
): string {
  if (!items || items.length === 0) return "";
  const chosen = items.find((step) => step.id === chosenId);
  if (chosen) return chosen.id;
  const running = items.find((step) => step.status === "running");
  if (running) return running.id;
  // pending, waiting, skipped and canceled steps may never have run.
  const started = items.filter((step) =>
    step.status !== "pending" && step.status !== "waiting" &&
    step.status !== "skipped" && step.status !== "canceled"
  );
  return (started.at(-1) ?? items[0]).id;
}

/** Reads only the string `code` of a recorded step fault; never free text. */
function stepFaultCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** The tone of the one status badge beside the "Current run" heading. */
const RUN_TONES = {
  queued: "neutral",
  running: "information",
  waiting_input: "warning",
  waiting_capacity: "warning",
  paused: "neutral",
  canceling: "warning",
  canceled: "neutral",
  completed: "success",
  failed: "danger",
  blocked: "warning",
} as const;

/** Where the server caps the tasks a blocked run names (work/run-query.ts). */
const MAX_BLOCKING_TASKS = 25;

/**
 * What a blocked run says (design-ux, #57 item 13). The reason and the tasks are
 * read from the server; a reason the page does not know is said as unknown
 * rather than guessed at, and a dependency reason names the tasks it waits on.
 */
function BlockedNotice(
  { run }: {
    readonly run: {
      readonly blockedReason?: string | null;
      readonly blockingTasks?: readonly {
        readonly id: string;
        readonly title: string;
      }[];
    };
  },
) {
  const { translate: t } = useI18n();
  if (run.blockedReason === null || run.blockedReason === undefined) {
    return <UI.Text>{t("tasks.run.blockedWaiting")}</UI.Text>;
  }
  if (run.blockedReason !== "dependency_incomplete") {
    return <UI.Text>{t("tasks.run.blockedUnknownWhy")}</UI.Text>;
  }
  const tasks = run.blockingTasks ?? [];
  if (tasks.length === 0) {
    return <UI.Text>{t("tasks.run.blockedWaiting")}</UI.Text>;
  }
  const link = (task: (typeof tasks)[number]) => (
    <RouterLink
      params={{ taskId: task.id }}
      to="/tasks/$taskId"
      variant="sentence"
    >
      {task.title}
    </RouterLink>
  );
  if (tasks.length === 1) {
    return (
      <UI.Text>
        {withLink(
          t("tasks.run.blockedWaitingForOne", { task: LINK_SLOT }),
          link(tasks[0]),
        )}
      </UI.Text>
    );
  }
  return (
    <UI.Stack gap="compact">
      <UI.Text>
        {t("tasks.run.blockedWaitingForMany", { count: tasks.length })}
      </UI.Text>
      <UI.Stack gap="tight" role="list">
        {tasks.map((task) => (
          <UI.Inline key={task.id} role="listitem">
            {link(task)}
          </UI.Inline>
        ))}
      </UI.Stack>
      {tasks.length < MAX_BLOCKING_TASKS
        ? null
        : <UI.Text variant="muted">{t("tasks.run.blockedWaitingMore")}
        </UI.Text>}
    </UI.Stack>
  );
}

/** Read the task's authoritative current run, never infer one from list order. */
export function TaskRunSection(
  {
    taskId,
    runId,
    enabled,
    connectivity = "online",
    artifacts,
    landingStepId,
    onReviewStep,
  }: {
    onReviewStep?: () => void;
    taskId: string;
    runId: string;
    enabled: boolean;
    landingStepId?: string | null;
    connectivity?: DurableSyncConnectivity;
    artifacts?: ReactNode;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate: t, locale, timeZone } = useI18n();
  const online = useConnectivity() === "online";
  const [outputStepId, setOutputStepId] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const authority =
    `${scope.sessionGeneration}:${scope.organizationId}:${taskId}:${runId}`;
  const [receipts, setReceipts] = useState<{
    authority: string;
    events: UI.RunTimelineEvent[];
  }>({ authority, events: [] });
  const run = useQuery({
    ...runQueryOptions(api, scope, runId),
    enabled: enabled && scope.organizationId !== null,
  });
  const validRun = !run.isError && run.data?.taskId === taskId;
  const activeRun = enabled && validRun;
  // The same read the Run actions menu makes (one cached request): a machine
  // that cannot steer is told once, since the menu simply leaves those actions out.
  const capabilities = useQuery({
    ...runControlCapabilitiesQueryOptions(api, scope, runId),
    enabled: activeRun && scope.organizationId !== null,
  });
  const steeringUnsupported =
    capabilities.data?.actions.some((item) => item.reason === "unsupported") ===
      true;
  const steps = useQuery({
    ...runStepsListQueryOptions(api, scope, runId, {
      cursor: cursors.at(-1),
      limit: 25,
    }),
    enabled: activeRun,
  });
  // The steps waiting on a model, once each has waited a minute (#70).
  const waiting = useWaitingOffers({
    runId,
    enabled: activeRun,
    waitingOnModel: run.data?.waitingOnModel,
  });
  const waitingOffers = waiting.offers;
  // A failed read of the choices still leaves the run waiting on a model.
  const waitingOnModel = waitingOffers.length > 0 || waiting.failed;
  const stepApproval = useStepApproval(taskId, runId);
  const waitingOnYou = enabled && stepApproval.approval?.mayDecide === true;
  const waitingOnOthers = enabled && stepApproval.approval !== null &&
    !waitingOnYou;
  const approvalStepName = stepName(stepApproval.step?.stepKey ?? null);
  const outcome = runOutcome(stepApproval.latest, run.data?.status);
  const outcomePerson = outcome === null
    ? null
    : stepApproval.nameOf(outcome.decidedBy) ??
      t("tasks.stepApproval.outcome.someone");
  const stepLanded = useRef(false);
  useEffect(() => {
    if (!landingStepId || stepLanded.current || !steps.data) return;
    if (steps.data.items.some((step) => step.id === landingStepId)) {
      stepLanded.current = true;
      setOutputStepId(landingStepId);
    } else if (steps.data.nextCursor && !steps.isFetching) {
      const next = steps.data.nextCursor;
      setCursors((current) => [...current, next]);
    }
  }, [landingStepId, steps.data, steps.isFetching]);
  const observedSteps = useRef<
    {
      cursor: string | undefined;
      statuses: Map<string, string>;
    } | null
  >(null);
  const [stepUpdate, setStepUpdate] = useState<
    {
      name: string;
      status:
        | "pending"
        | "running"
        | "waiting"
        | "completed"
        | "failed"
        | "skipped"
        | "canceled";
    } | null
  >(null);
  const cursor = cursors.at(-1);
  useEffect(() => {
    if (
      !activeRun || steps.isError || !steps.data ||
      steps.data.items.some((step) => step.runId !== runId)
    ) return;
    const previous = observedSteps.current;
    if (previous && previous.cursor === cursor) {
      const changed = steps.data.items.filter((step) =>
        previous.statuses.has(step.id) &&
        previous.statuses.get(step.id) !== step.status
      );
      const latest = changed.at(-1);
      if (latest) {
        setStepUpdate({
          name: stepName(latest.stepKey),
          status: latest.status,
        });
      }
    } else {
      setStepUpdate(null);
    }
    observedSteps.current = {
      cursor,
      statuses: new Map(steps.data.items.map((step) => [step.id, step.status])),
    };
  }, [activeRun, cursor, runId, steps.data, steps.isError]);
  const mismatch = !!run.data && run.data.taskId !== taskId;
  const invalidSteps = steps.data?.items.some((step) => step.runId !== runId);
  const selectedStepId = resolveOutputStepId(steps.data?.items, outputStepId);
  const itemParam = typeof globalThis.location === "undefined"
    ? null
    : new URLSearchParams(globalThis.location.search).get("item");
  // The thread for the step on screen, and, when a different step is the one
  // running, that step's too, so the line above the composer can name it.
  const runningStepId =
    steps.data?.items.find((step) => step.status === "running")?.id ?? null;
  const readable = activeRun && !steps.isError && !invalidSteps && !!steps.data;
  const selectedThread = useSessionThread(readable ? selectedStepId : null);
  const otherRunning = runningStepId !== null &&
    runningStepId !== selectedStepId;
  const runningThread = useSessionThread(
    readable && otherRunning ? runningStepId : null,
  );
  const runningSource = runningStepId === null
    ? null
    : otherRunning
    ? runningThread
    : selectedThread;
  const runningStepKey = steps.data?.items.find((step) =>
    step.id === runningStepId
  )?.stepKey;
  const threadShown = selectedThread.phase === "ready";
  // The line about the running step lives in the footer above the composer, so
  // it stays in view however far the page has scrolled; where the page has no
  // footer for it, it is drawn here.
  const selectRunning = useCallback(
    () => setOutputStepId(runningStepId),
    [runningStepId],
  );
  const nowLine = useMemo(
    () =>
      runningSource
        ? (
          <SessionRunNow
            source={runningSource}
            stepName={otherRunning && runningStepKey !== undefined
              ? stepTitle(t, runningStepKey)
              : undefined}
            onSelect={selectRunning}
          />
        )
        : null,
    [runningSource, otherRunning, runningStepKey, selectRunning, t],
  );
  const nowLinePublished = usePublishNowLine(nowLine);
  const usageAuthority = `${authority}:${selectedStepId}`;
  const [usageRecord, setUsageRecord] = useState<
    {
      authority: string;
      value: JobAttemptRead["outcome"]["usage"];
    } | null
  >(null);
  const onUsageChange = useCallback(
    (value: JobAttemptRead["outcome"]["usage"]) => {
      setUsageRecord({ authority: usageAuthority, value });
    },
    [usageAuthority],
  );
  const usage = activeRun && !steps.isError && !invalidSteps &&
      usageRecord?.authority === usageAuthority
    ? usageRecord.value
    : null;
  const failure = run.error ?? steps.error;
  const rules = useRunRules({
    taskId,
    runId,
    enabled: validRun && run.data !== undefined,
  });
  const stepNames = new Map(
    (steps.data?.items ?? []).map((step) =>
      [step.id, stepName(step.stepKey)] as const
    ),
  );
  const showRulesDetails = () => {
    const details = document.getElementById("run-details");
    if (details instanceof HTMLDetailsElement) details.open = true;
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-testid="run-rules-heading"]')
        ?.focus()
    );
  };
  const forbidden = failure?.kind === "problem" &&
    failure.problem.status === 403;
  const timeOf = (iso: string) =>
    formatDate(new Date(iso), locale, { timeZone, timeStyle: "short" });
  // The run's state is written once, on one line, beside its badge (#57).
  const runLine = (() => {
    if (!validRun || !run.data) return null;
    const current = run.data;
    if (outcome !== null && outcomePerson !== null) {
      return (
        <UI.Text data-placement="line">
          {outcome.decision === "reject"
            ? t("tasks.stepApproval.outcome.rejected", {
              name: outcomePerson,
              step: approvalStepName,
            })
            : outcome.note === ""
            ? t("tasks.stepApproval.outcome.changes", { name: outcomePerson })
            : t("tasks.stepApproval.outcome.changesNote", {
              name: outcomePerson,
              note: outcome.note,
            })}
        </UI.Text>
      );
    }
    if (waitingOnYou && online) {
      return (
        <>
          <UI.Text data-placement="line">
            {t("tasks.stepApproval.line", { step: approvalStepName })}
          </UI.Text>
          <UI.Button onClick={onReviewStep}>
            {t("tasks.stepApproval.review", { step: approvalStepName })}
          </UI.Button>
        </>
      );
    }
    if (waitingOnOthers && online) {
      return (
        <UI.Text data-placement="line">
          {t("tasks.stepApproval.refusal.outside")}
        </UI.Text>
      );
    }
    if (!online) {
      return (
        <UI.Text data-placement="line">{t("tasks.controls.offline")}</UI.Text>
      );
    }
    switch (current.status) {
      case "queued":
        return (
          <UI.Text data-placement="line">{t("tasks.run.line.queued")}</UI.Text>
        );
      case "running":
      case "waiting_input":
      case "waiting_capacity":
        return (
          <UI.Text data-placement="line">
            {t("tasks.run.line.started", {
              time: timeOf(current.startedAt ?? current.createdAt),
            })}
          </UI.Text>
        );
      case "paused":
        return (
          <UI.Text data-placement="line">{t("tasks.run.line.paused")}</UI.Text>
        );
      case "blocked":
        return <BlockedNotice run={current} />;
      case "failed":
        return (
          <UI.Text data-placement="line">{t("tasks.run.line.failed")}</UI.Text>
        );
      case "canceled":
        return (
          <UI.Text data-placement="line">
            {t("tasks.run.line.canceled", {
              time: timeOf(current.finishedAt ?? current.updatedAt),
            })}
          </UI.Text>
        );
      case "completed": {
        const stepsKnown = steps.data !== undefined && !steps.isError &&
          !invalidSteps && cursors.length === 1 && !steps.data.nextCursor;
        const lasted = current.startedAt !== null && current.finishedAt !== null
          ? Math.max(
            0,
            Date.parse(current.finishedAt) - Date.parse(current.startedAt),
          )
          : null;
        if (!stepsKnown || lasted === null) {
          return (
            <UI.Text data-placement="line">
              {t("tasks.run.line.finishedAt", {
                time: timeOf(current.finishedAt ?? current.updatedAt),
              })}
            </UI.Text>
          );
        }
        const whole = Math.round(lasted / 1000);
        return (
          <UI.Text data-placement="line">
            {t("tasks.run.line.finished", {
              steps: steps.data.items.length,
              duration: lasted < 1000
                ? t("tasks.run.duration.instant")
                : whole < 60
                ? t("tasks.run.duration.seconds", { seconds: whole })
                : t("tasks.run.duration.minutes", {
                  minutes: Math.floor(whole / 60),
                  seconds: whole % 60,
                }),
            })}
          </UI.Text>
        );
      }
      case "canceling":
        return null;
    }
  })();
  // A step list is drawn newest first. A finished, failed or paused run folds
  // everything past the newest three under one link; a running one shows all.
  const handoverEvents = useHandoverEvents(
    steps.data?.items ?? [],
    activeRun && !invalidSteps,
  );
  const stepEvents =
    validRun && run.data && !steps.isPending && !steps.isError &&
      !invalidSteps && steps.data && steps.data.items.length > 0
      ? [
        ...stepTimelineEvents(
          steps.data.items,
          t,
          new Map(
            waitingOffers.map((offer) =>
              [offer.runStepId, stepRowCopy(offer, t)] as const
            ),
          ),
          (iso) =>
            formatDate(new Date(iso), locale, {
              timeZone,
              dateStyle: "medium",
              timeStyle: "short",
            }),
        ),
        ...handoverEvents,
        ...(receipts.authority === authority ? receipts.events : []),
      ].reverse()
      : null;
  const folds = stepEvents !== null && run.data !== undefined &&
    ["completed", "failed", "canceled", "paused"].includes(run.data.status) &&
    stepEvents.length > 3;
  const timelineProps = {
    label: t("tasks.run.timeline"),
    connectivity: connectivity === "online" ? undefined : connectivity,
    connectivityLabel: t(
      `tasks.timeline.connectivity.${
        connectivity === "online" ? "unknown" : connectivity
      }`,
    ),
  };
  return (
    <TaskRunSectionView
      title={t("tasks.run.heading")}
      overview={
        <>
          <UI.Inline gap="standard">
            <UI.Heading
              id="task-run-heading"
              level="section"
              tabIndex={-1}
            >
              {t("tasks.run.heading")}
            </UI.Heading>
            {validRun && run.data
              ? (
                <UI.Badge
                  tone={outcome !== null
                    ? outcome.decision === "reject" ? "danger" : "warning"
                    : waitingOnModel || waitingOnYou
                    ? "warning"
                    : RUN_TONES[run.data.status]}
                >
                  {outcome !== null
                    ? t(`tasks.stepApproval.outcome.badge.${outcome.decision}`)
                    : waitingOnYou
                    ? t("tasks.stepApproval.badge")
                    : waitingOnModel
                    ? t("tasks.waiting.badge")
                    : t(`tasks.run.status.${run.data.status}`)}
                </UI.Badge>
              )
              : null}
            {runLine}
            {validRun && run.data && run.data.status !== "blocked" &&
                outcome === null
              ? (
                <TaskRunControls
                  key={`${scope.sessionGeneration}:${scope.organizationId}:${taskId}:${runId}`}
                  taskId={taskId}
                  runId={runId}
                  enabled={activeRun}
                  paused={run.data.status === "paused"}
                  onReceipt={(event) =>
                    setReceipts((current) => ({
                      authority,
                      events: [
                        ...(current.authority === authority
                          ? current.events
                          : []),
                        event,
                      ],
                    }))}
                />
              )
              : null}
          </UI.Inline>
          {activeRun && run.data !== undefined &&
              !["completed", "canceled"].includes(run.data.status)
            ? <WaitingFor runId={runId} />
            : null}
          {steeringUnsupported && (
            <UI.InlineNotice
              tone="information"
              data-ui-region="steering-unsupported"
            >
              {t("tasks.conversation.steering.unsupported")}
            </UI.InlineNotice>
          )}
          {validRun && run.data
            ? (
              <RouteWaiting
                key={runId}
                taskId={taskId}
                runId={runId}
                offers={waitingOffers}
                failed={waiting.failed}
                retrying={waiting.retrying}
                onRetry={waiting.retry}
              />
            )
            : null}
          {validRun && run.data && steps.data && !invalidSteps
            ? (
              <HandOver
                key={`handover:${runId}`}
                taskId={taskId}
                runId={runId}
                runVersion={run.data.version}
                steps={steps.data.items}
                canControl={capabilities.data?.actions.some((item) =>
                  item.canRequest
                ) === true}
                online={online}
              />
            )
            : null}
          <UI.VisuallyHidden
            role={threadShown ? undefined : "status"}
            aria-live={threadShown ? undefined : "polite"}
            aria-atomic={threadShown ? undefined : "true"}
            aria-label={t("tasks.run.updates")}
          >
            {validRun && run.data
              ? (
                <>
                  {t("tasks.run.heading")}: {outcome !== null
                    ? t(`tasks.stepApproval.outcome.badge.${outcome.decision}`)
                    : waitingOnModel
                    ? t("tasks.waiting.badge")
                    : t(`tasks.run.status.${run.data.status}`)}
                  {stepUpdate && !steps.isError && !invalidSteps
                    ? (
                      <>
                        . {t("tasks.run.stepUpdate")}: {stepUpdate.name} —{" "}
                        {t(`tasks.run.step.${stepUpdate.status}`)}
                      </>
                    )
                    : null}
                </>
              )
              : null}
          </UI.VisuallyHidden>
          {validRun && run.data
            ? (
              <RunRulesChangedNotice
                model={rules}
                onShowDetails={showRulesDetails}
              />
            )
            : null}
        </>
      }
      timeline={stepEvents === null ? null : (
        // One compact group: the always-mounted (usually empty) status region
        // and the list share a tight gap instead of each taking a full one.
        <UI.Stack gap="compact">
          <UI.RunTimeline
            {...timelineProps}
            events={folds ? stepEvents.slice(0, 3) : stepEvents}
          />
          {folds && (
            <UI.Disclosure
              data-testid="run-earlier-steps"
              summary={t("tasks.run.earlierSteps", {
                count: stepEvents.length - 3,
              })}
            >
              <UI.RunTimeline
                events={stepEvents.slice(3)}
                label={t("tasks.run.earlierStepsLabel")}
              />
            </UI.Disclosure>
          )}
          {(cursors.length > 1 || !!steps.data?.nextCursor) && (
            <UI.CursorControls
              variant="previousNext"
              state={steps.isFetching ? "loading" : "ready"}
              hasPrevious={cursors.length > 1}
              hasNext={!steps.isError && !invalidSteps &&
                !!steps.data?.nextCursor}
              onPrevious={() => setCursors(cursors.slice(0, -1))}
              onNext={() => {
                if (steps.data?.nextCursor) {
                  setCursors([...cursors, steps.data.nextCursor]);
                }
              }}
              labels={{
                controls: t("tasks.run.timeline"),
                end: t("projects.onboarding.pagination.endOfResults"),
                loadMore: t("projects.onboarding.pagination.loadMore"),
                loading: t("projects.onboarding.pagination.loading"),
                next: t("projects.onboarding.pagination.next"),
                previous: t("projects.onboarding.pagination.previous"),
                retry: t("tasks.live.retry"),
              }}
            />
          )}
        </UI.Stack>
      )}
      details={validRun && run.data
        ? (
          <UI.Disclosure id="run-details" summary={t("tasks.run.details")}>
            <UI.Text data-testid="run-id-row">
              {t("tasks.run.id")}{" "}
              <ReferenceLink kind="run" value={run.data.id} />
            </UI.Text>
            {(run.data.workspaceBaseSha ?? run.data.baseSha) === null ? null : (
              // The commit the run started from: it used to show only inside
              // the Changes box, which is not drawn when nothing is recorded.
              <UI.Text>
                <ReferenceText
                  known={knownCommits([
                    run.data.workspaceBaseSha ?? run.data.baseSha,
                  ])}
                  text={t("tasks.run.startedFrom", {
                    sha: UI.shortReference(
                      "commit",
                      (run.data.workspaceBaseSha ?? run.data.baseSha)!,
                    ),
                  })}
                />
              </UI.Text>
            )}
            <RunRulesDetails
              finished={run.data.finishedAt !== null}
              model={rules}
              settingsVersion={run.data.repositoryProfileRevision}
              stepNames={stepNames}
            />
            {usage
              ? (
                <UI.Text>
                  {t("tasks.run.output.usage", {
                    input: usage.inputTokens ?? t("tasks.run.unknown"),
                    output: usage.outputTokens ?? t("tasks.run.unknown"),
                    cost: usage.costUsd ?? t("tasks.run.unknown"),
                  })}
                </UI.Text>
              )
              : null}
          </UI.Disclosure>
        )
        : null}
      revision={!run.isPending && !run.isError && !mismatch && validRun &&
          run.data &&
          !steps.isPending && !steps.isError && !invalidSteps
        ? (
          <TaskRunRevision
            taskId={taskId}
            runId={runId}
            baseSha={run.data.workspaceBaseSha ?? run.data.baseSha}
          />
        )
        : null}
      artifacts={artifacts}
      delivery={activeRun && run.data
        ? (
          <DeliverySection
            taskId={taskId}
            runId={runId}
            enabled={activeRun}
            baseSha={run.data.workspaceBaseSha ?? run.data.baseSha}
            paused={run.data.status === "paused"}
            offline={connectivity === "offline" ||
              connectivity === "reconnecting"}
            onTellBakery={() => void focusMessageField()}
            onOpenRules={() =>
              void navigate({ to: "/settings/organization/repository-rules" })}
          />
        )
        : null}
      execution={run.isPending
        ? (
          <UI.Stack
            aria-busy="true"
            aria-label={t("tasks.session.state.loading")}
            gap="standard"
          >
            {[0, 1, 2].map((row) => <UI.Skeleton shape="row" key={row} />)}
          </UI.Stack>
        )
        : run.isError || mismatch
        ? (
          <UI.ErrorState
            title={t(
              forbidden ? "tasks.live.forbidden" : "tasks.run.loadFailed",
            )}
            action={!forbidden && (
              <UI.Button onClick={() => void run.refetch()}>
                {t("tasks.live.retry")}
              </UI.Button>
            )}
          />
        )
        : validRun && run.data
        ? (
          <>
            {steps.isPending
              ? <UI.Text>{t("tasks.inbox.loading")}</UI.Text>
              : steps.isError || invalidSteps
              ? (
                <UI.InlineNotice tone={forbidden ? "error" : "warning"}>
                  <UI.Stack gap="compact">
                    <UI.Text>
                      {t(
                        forbidden ? "tasks.live.forbidden" : "tasks.live.error",
                      )}
                    </UI.Text>
                    {!forbidden && (
                      <UI.Inline gap="compact">
                        <UI.Button
                          variant="outline"
                          onClick={() => void steps.refetch()}
                        >
                          {t("tasks.live.retry")}
                        </UI.Button>
                      </UI.Inline>
                    )}
                  </UI.Stack>
                </UI.InlineNotice>
              )
              : (
                <>
                  {steps.data.items.length > 0 && (
                    <>
                      {steps.data.items.length > 1 && (
                        <UI.Combobox
                          label={t("session.thread.stepSelect")}
                          value={selectedStepId}
                          options={steps.data.items.map((step) => ({
                            value: step.id,
                            label: stepTitle(t, step.stepKey),
                          }))}
                          onChange={(event) =>
                            setOutputStepId(event.target.value)}
                        />
                      )}
                      <UI.Stack gap="none" data-landing-step={selectedStepId}>
                        <SessionStepThread
                          key={selectedStepId}
                          taskId={taskId}
                          source={selectedThread}
                          // With one step there is no Step select to say which step this is.
                          stepName={steps.data.items.length === 1
                            ? stepTitle(t, steps.data.items[0]!.stepKey)
                            : undefined}
                          highlightedItemId={itemParam ?? undefined}
                          rawOutput={
                            <TaskRunOutput
                              taskId={taskId}
                              onUsageChange={onUsageChange}
                              quiet={threadShown}
                              stepId={selectedStepId}
                              stepStatus={steps.data?.items.find((step) =>
                                step.id === selectedStepId
                              )?.status}
                              stepErrorCode={stepFaultCode(
                                steps.data?.items.find((step) =>
                                  step.id === selectedStepId
                                )?.error,
                              )}
                            />
                          }
                        />
                      </UI.Stack>
                      {nowLinePublished ? null : nowLine}
                    </>
                  )}
                </>
              )}
          </>
        )
        : null}
    />
  );
}
