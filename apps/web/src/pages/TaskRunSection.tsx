import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { JobAttemptRead } from "../api/client.ts";
import { runQueryOptions, runStepsListQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import type { DurableSyncConnectivity } from "../api/durable-sync.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { TaskRunRevision } from "./TaskRunRevision.tsx";
import { TaskRunOutput } from "./TaskRunOutput.tsx";
import { TaskRunControls } from "./TaskRunControls.tsx";
import { runTimelineEvents } from "./task-timeline.ts";
import { TaskRunSectionView } from "./task-run-section-view.tsx";

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

/** Read the task's authoritative current run, never infer one from list order. */
export function TaskRunSection(
  { taskId, runId, enabled, connectivity = "online", artifacts }: {
    taskId: string;
    runId: string;
    enabled: boolean;
    /** Sync connectivity; anything but `online` shows as a banner, never a row. */
    connectivity?: DurableSyncConnectivity;
    artifacts?: ReactNode;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
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
  const steps = useQuery({
    ...runStepsListQueryOptions(api, scope, runId, {
      cursor: cursors.at(-1),
      limit: 25,
    }),
    enabled: activeRun,
  });
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
        setStepUpdate({ name: latest.stepKey, status: latest.status });
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
  const forbidden = failure?.kind === "problem" &&
    failure.problem.status === 403;
  return (
    <TaskRunSectionView
      title={t("tasks.run.heading")}
      overview={
        <>
          <UI.Heading level="section">{t("tasks.run.heading")}</UI.Heading>
          <UI.Text
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={t("tasks.run.updates")}
          >
            {validRun && run.data
              ? (
                <>
                  {t("tasks.run.heading")}:{" "}
                  {t(`tasks.run.status.${run.data.status}`)}
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
          </UI.Text>
          {validRun && run.data
            ? (
              <>
                <UI.Text>{run.data.id}</UI.Text>
                <UI.Badge>{t(`tasks.run.status.${run.data.status}`)}</UI.Badge>
              </>
            )
            : null}
        </>
      }
      details={
        <>
          <UI.Text>
            {usage
              ? t("tasks.run.output.usage", {
                input: usage.inputTokens ?? t("tasks.run.unknown"),
                output: usage.outputTokens ?? t("tasks.run.unknown"),
                cost: usage.costUsd ?? t("tasks.run.unknown"),
              })
              : t("tasks.run.output.usageUnknown")}
          </UI.Text>
          {validRun && run.data && !steps.isPending && !steps.isError &&
              !invalidSteps && steps.data
            ? (
              <UI.RunTimeline
                label={t("tasks.run.timeline")}
                connectivity={connectivity === "online"
                  ? undefined
                  : connectivity}
                connectivityLabel={t(
                  `tasks.timeline.connectivity.${
                    connectivity === "online" ? "unknown" : connectivity
                  }`,
                )}
                events={[
                  ...runTimelineEvents(run.data, steps.data.items, t, {
                    first: cursors.length === 1,
                    last: !steps.data.nextCursor,
                  }),
                  ...(receipts.authority === authority ? receipts.events : []),
                ]}
              />
            )
            : null}
          {validRun && run.data
            ? (
              <UI.CursorControls
                variant="previousNext"
                state={steps.isFetching ? "loading" : "ready"}
                hasPrevious={cursors.length > 1}
                hasNext={!steps.isError && !invalidSteps &&
                  !!steps.data?.nextCursor}
                onPrevious={() => setCursors(cursors.slice(0, -1))}
                onNext={() => {
                  if (steps.data?.nextCursor) {
                    setCursors([
                      ...cursors,
                      steps.data.nextCursor,
                    ]);
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
            )
            : null}
          {/* A blocked run waits on a dependency and takes no controls. */}
          {run.data?.status === "blocked" && validRun ? null : (
            <TaskRunControls
              key={`${scope.sessionGeneration}:${scope.organizationId}:${taskId}:${runId}`}
              taskId={taskId}
              runId={runId}
              enabled={activeRun}
              onReceipt={(event) =>
                setReceipts((current) => ({
                  authority,
                  events: [
                    ...(current.authority === authority ? current.events : []),
                    event,
                  ],
                }))}
            />
          )}
        </>
      }
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
      execution={run.isPending
        ? <UI.Text>{t("tasks.session.state.loading")}</UI.Text>
        : run.isError || mismatch
        ? (
          <UI.ErrorState
            title={t(forbidden ? "tasks.live.forbidden" : "tasks.live.error")}
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
                <UI.ErrorState
                  title={t(
                    forbidden ? "tasks.live.forbidden" : "tasks.live.error",
                  )}
                  action={!forbidden && (
                    <UI.Button onClick={() => void steps.refetch()}>
                      {t("tasks.live.retry")}
                    </UI.Button>
                  )}
                />
              )
              : (
                <>
                  {steps.data.items.length === 0 && (
                    <UI.Text>{t("tasks.run.noSteps")}</UI.Text>
                  )}
                  {steps.data.items.length > 0 && (
                    <>
                      {steps.data.items.length > 1 && (
                        <UI.Combobox
                          label={t("tasks.run.output.step")}
                          value={selectedStepId}
                          options={steps.data.items.map((step) => ({
                            value: step.id,
                            label: step.stepKey,
                          }))}
                          onChange={(event) =>
                            setOutputStepId(event.target.value)}
                        />
                      )}
                      <TaskRunOutput
                        key={selectedStepId}
                        taskId={taskId}
                        onUsageChange={onUsageChange}
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
