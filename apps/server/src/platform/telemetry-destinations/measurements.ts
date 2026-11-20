import type { TelemetryRecord } from "@bakery/config/telemetry";

/**
 * The six kinds of measurement a destination can be told to receive.
 *
 * This is a closed list: the settings page draws one checkbox for each, and the
 * server maps every record it emits onto them here, in one place. A record that
 * maps to none is never sent anywhere, so adding an emitter without deciding
 * what kind it is cannot leak it to a destination by accident.
 */
export const MEASUREMENT_KINDS = Object.freeze(
  [
    "cost",
    "durations",
    "results",
    "skills",
    "health",
    "errors",
  ] as const,
);

export type MeasurementKind = typeof MEASUREMENT_KINDS[number];

/** Whether a string is one of the six kinds. */
export function isMeasurementKind(value: unknown): value is MeasurementKind {
  return typeof value === "string" &&
    (MEASUREMENT_KINDS as readonly string[]).includes(value);
}

/**
 * Event names mapped to the kinds they carry. A job's completion says both how
 * long it took and how it ended, so it belongs to two kinds.
 */
const EVENT_MEASUREMENTS: Readonly<Record<string, readonly MeasurementKind[]>> =
  Object.freeze({
    // Not mapped until the record carries what the kind promises: usage.settled
    // holds only the attempt id (no amount, no tokens), and job.completed holds
    // the outcome but no duration. A kind comes back here as it is emitted.
    "job.completed": ["results"],
    "lease.renewed": ["health"],
  });

/**
 * The kinds a record carries. The server's metric samples are all health: queue
 * age, leases, retries, spool size and export failures.
 */
export function measurementsOf(
  record: TelemetryRecord,
): readonly MeasurementKind[] {
  if (record.kind === "metrics") return ["health"];
  return EVENT_MEASUREMENTS[record.name] ?? [];
}
