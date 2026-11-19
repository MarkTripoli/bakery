import type { WorkflowStart } from "@bakery/contracts/workflow-starts";
import { canonicalTimeZone, parseCron } from "./automations/schedule.ts";
import { StandardError } from "@bakery/contracts/http";

/**
 * Reads a version's starts through the parsers that will execute them.
 *
 * The contract says a schedule start carries a five-field expression and an
 * IANA zone, which is a shape and not a promise: `61 * * * *` and
 * `Europe/Nowhere` both pass it. A version is immutable once published, so a
 * schedule that the scheduler cannot read would be frozen into that version
 * forever and would fail at the first tick rather than at the author's desk.
 * Reading it here means the refusal lands on publish, where it can be fixed.
 *
 * The zone is returned in its canonical spelling so two versions naming the
 * same zone store the same text.
 */
export function readStartSchedules(
  starts: readonly WorkflowStart[],
): WorkflowStart[] {
  return starts.map((start) => {
    if (start.on.kind !== "schedule") return start;
    try {
      parseCron(start.on.cron);
    } catch {
      throw scheduleRefused("start_schedule_cron_invalid", start.id);
    }
    let timezone: string;
    try {
      timezone = canonicalTimeZone(start.on.timezone);
    } catch {
      throw scheduleRefused("start_schedule_timezone_invalid", start.id);
    }
    return { ...start, on: { ...start.on, timezone } };
  });
}

function scheduleRefused(reason: string, startId: string): StandardError {
  return new StandardError({
    code: "VALIDATION_FAILED",
    params: { reason, startId },
  });
}
