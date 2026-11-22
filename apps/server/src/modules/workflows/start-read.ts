import { StandardError } from "@bakery/contracts/http";
import type { WorkflowStart } from "@bakery/contracts/workflow-starts";
import { neutralFieldsOf } from "../integrations/neutral-events.ts";
import { readStartSchedules } from "./start-schedules.ts";

/**
 * Reads a version's starts the way they will run, once, for save and publish.
 *
 * A schedule start goes through the scheduler's own parsers
 * (`readStartSchedules`). An event start must name a neutral kind that a source
 * emits or reserves and filter only on fields that kind declares, with values
 * of the declared type, so a start that nothing could ever fire is refused
 * where the author can fix it and not frozen into an immutable version.
 */
export function readStarts(
  starts: readonly WorkflowStart[],
): WorkflowStart[] {
  for (const start of starts) {
    if (start.on.kind !== "event") continue;
    const declared = neutralFieldsOf(start.on.eventKind);
    if (declared === undefined) {
      throw refused("start_event_kind_unknown", start.id);
    }
    for (const [key, value] of Object.entries(start.on.filter)) {
      // Own keys only: `constructor` and `toString` are not event fields.
      if (!Object.hasOwn(declared, key)) {
        throw refused("start_filter_key_unsupported", start.id);
      }
      const fits = declared[key] === "number"
        ? typeof value === "number" && Number.isSafeInteger(value)
        : typeof value === "string";
      if (!fits) throw refused("start_filter_value_type", start.id);
    }
  }
  return readStartSchedules(starts);
}

function refused(reason: string, startId: string): StandardError {
  return new StandardError({
    code: "VALIDATION_FAILED",
    params: { reason, startId },
  });
}
