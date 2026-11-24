import type { Translator } from "@bakery/i18n";
import type { RunStepListResponse } from "../api/client.ts";
import { capitalized, stepName } from "./task-step-approval/model.ts";

type RunStep = RunStepListResponse["items"][number];

/**
 * A timeline row as RunTimeline in @bakery/ui reads it. Declared here, as plain
 * strings, so this module loads without the UI package and its styles (a unit
 * test imports it). TaskRunSection hands the rows to RunTimeline, so the
 * compiler checks they still fit.
 */
export type TimelineRow = {
  description?: string;
  id: string;
  status?:
    | "queued"
    | "active"
    | "waiting"
    | "failed"
    | "complete"
    | "canceled"
    | "skipped"
    | "blocked";
  scope?: "step" | "run" | "control";
  reason?: string;
  time?: string;
  /** The time as the person reads it; `time` stays the machine value. */
  timeLabel?: string;
  title: string;
};

/** The deterministic worker fault when no coding harness is installed. */
export const HARNESS_UNAVAILABLE_CODE = "DETERMINISTIC_EVIDENCE_UNAVAILABLE";

const STEP_STATUS: Record<
  RunStep["status"],
  NonNullable<TimelineRow["status"]>
> = {
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

/** A step's name for people: the known title, else its key in words. */
export function stepTitle(t: Translator, stepKey: string): string {
  const known = KNOWN_STEPS[stepKey as keyof typeof KNOWN_STEPS];
  return known ? t(known) : capitalized(stepName(stepKey));
}

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
 * The step rows of a run, from server records only: its steps and their
 * recorded faults. Nothing is inferred from timing or order. The run's own
 * state (queued, completed, failed, blocked) is not a row: the run line says it
 * once, so the list never repeats it.
 */
export function stepTimelineEvents(
  steps: readonly RunStep[],
  t: Translator,
  /** Steps waiting on a model, by id, with what their row says (#70). */
  waiting: ReadonlyMap<string, string> = new Map(),
  /** How a time reads for the person; without it the record's own text shows. */
  formatTime: (iso: string) => string = (iso) => iso,
): TimelineRow[] {
  return steps.map((step) => {
    const known = KNOWN_STEPS[step.stepKey as keyof typeof KNOWN_STEPS];
    const budgetKey = budgetFaultReason(step);
    const waitingText = waiting.get(step.id);
    return {
      id: step.id,
      title: known ? t(known) : step.stepKey,
      description: waitingText ?? t(`tasks.run.step.${step.status}`),
      reason: step.status !== "failed"
        ? undefined
        : hasHarnessFault(step)
        ? t("tasks.timeline.stepFault")
        : budgetKey
        ? t(budgetKey)
        : undefined,
      time: step.finishedAt ?? step.startedAt ?? step.createdAt,
      timeLabel: formatTime(
        step.finishedAt ?? step.startedAt ?? step.createdAt,
      ),
      status: waitingText === undefined ? STEP_STATUS[step.status] : "waiting",
    };
  });
}
