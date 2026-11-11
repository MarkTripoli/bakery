import type * as UI from "@bakery/ui";
import type { Translator } from "@bakery/i18n";
import type { RunResponse, RunStepListResponse } from "../api/client.ts";

type RunStep = RunStepListResponse["items"][number];

/** The deterministic worker fault when no coding harness is installed. */
export const HARNESS_UNAVAILABLE_CODE = "DETERMINISTIC_EVIDENCE_UNAVAILABLE";

const STEP_STATUS: Record<RunStep["status"], UI.RunTimelineEvent["status"]> = {
  pending: "queued",
  running: "active",
  waiting: "waiting",
  completed: "complete",
  failed: "failed",
  skipped: "skipped",
  canceled: "canceled",
};

const KNOWN_STEPS = {
  brief: "tasks.timeline.step.brief",
  implement: "tasks.timeline.step.implement",
} as const;

/** True when the server recorded the missing-harness fault on this step. */
export function hasHarnessFault(step: Pick<RunStep, "error">): boolean {
  return step.error !== null && step.error !== undefined &&
    JSON.stringify(step.error).includes(HARNESS_UNAVAILABLE_CODE);
}

const BUDGET_CAP_CODES: readonly string[] = [
  "BUDGET_CAP_EXCEEDED",
  "PLAN_BUDGET_CAP_EXCEEDED",
];
const BUDGET_UNAVAILABLE_CODES: readonly string[] = [
  "BUDGET_POLICY_UNAVAILABLE",
  "BUDGET_POLICY_INVALID",
  "BUDGET_PRICING_UNAVAILABLE",
  "BILLING_CONFIGURATION_MISSING",
];

/** The copy key for a step the server failed at budget admission, if any. */
export function budgetFaultReason(
  step: Pick<RunStep, "error">,
):
  | "tasks.timeline.budgetCapExceeded"
  | "tasks.timeline.budgetUnavailable"
  | undefined {
  const code = (step.error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return undefined;
  if (BUDGET_CAP_CODES.includes(code)) {
    return "tasks.timeline.budgetCapExceeded";
  }
  return BUDGET_UNAVAILABLE_CODES.includes(code)
    ? "tasks.timeline.budgetUnavailable"
    : undefined;
}

/**
 * Timeline rows from server records only: the run, its steps and their
 * recorded faults. Nothing is inferred from timing or order. `first` and
 * `last` place the run-level entries on the first and last step page.
 */
export function runTimelineEvents(
  run: Pick<
    RunResponse,
    "id" | "status" | "createdAt" | "updatedAt" | "finishedAt"
  >,
  steps: readonly RunStep[],
  t: Translator,
  page: { first: boolean; last: boolean } = { first: true, last: true },
): UI.RunTimelineEvent[] {
  const events: UI.RunTimelineEvent[] = [];
  if (page.first) {
    events.push(
      run.status === "blocked"
        ? {
          id: `${run.id}:blocked`,
          scope: "run",
          status: "blocked",
          title: t("tasks.timeline.blocked"),
          // `blocked` is only ever set for an incomplete dependency, and a
          // blocked run takes no controls and never starts by itself here.
          reason: t("tasks.timeline.blockedDependency"),
          time: run.updatedAt,
        }
        : {
          id: `${run.id}:queued`,
          scope: "run",
          status: run.status === "queued" ? "queued" : "complete",
          title: t("tasks.timeline.queued"),
          time: run.createdAt,
        },
    );
  }
  for (const step of steps) {
    const known = KNOWN_STEPS[step.stepKey as keyof typeof KNOWN_STEPS];
    const budgetKey = budgetFaultReason(step);
    events.push({
      id: step.id,
      title: known ? t(known) : step.stepKey,
      description: t(`tasks.run.step.${step.status}`),
      reason: step.status !== "failed"
        ? undefined
        : hasHarnessFault(step)
        ? t("tasks.timeline.stepFault")
        : budgetKey
        ? t(budgetKey)
        : undefined,
      time: step.finishedAt ?? step.startedAt ?? step.createdAt,
      status: STEP_STATUS[step.status],
    });
  }
  if (
    page.last &&
    (run.status === "completed" || run.status === "failed" ||
      run.status === "canceled")
  ) {
    events.push({
      id: `${run.id}:terminal`,
      scope: "run",
      status: run.status === "completed" ? "complete" : run.status,
      title: t(
        run.status === "completed"
          ? "tasks.timeline.terminal.complete"
          : run.status === "failed"
          ? "tasks.timeline.terminal.failed"
          : "tasks.timeline.terminal.canceled",
      ),
      time: run.finishedAt ?? run.updatedAt,
    });
  }
  return events;
}
