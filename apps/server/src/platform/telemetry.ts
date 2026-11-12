/**
 * The server's telemetry: the facade from `@bakery/config/telemetry`, built
 * with the bounds and the allowlist the server needs and no sink.
 *
 * With no sink the exporter is disabled: an event costs one counter and nothing
 * is queued, so a server that has not been given a destination behaves exactly
 * as it did before. A sink (rotated structured logs, an optional OTLP
 * destination) is supplied by the slice that adds them; everything here holds
 * whatever that sink does, because the exporter's queue is bounded and the
 * routes only ever call `event` after their transaction has committed.
 */
import {
  createTelemetry,
  type Telemetry,
  type TelemetryRecord,
} from "@bakery/config/telemetry";
import { createTelemetryRedactor } from "@bakery/config/telemetry-attributes";
import {
  EXECUTION_TELEMETRY_EVENTS,
  JOB_OUTCOMES,
} from "../modules/execution/telemetry.ts";

/**
 * Bounds of the server's exporter.
 *
 * - `capacity` caps what waits for a sink, so a sink that never answers holds
 *   at most this many records; the rest are dropped and counted.
 * - `batchSize` sets throughput: the exporter lets timers run between batches
 *   (one timer turn, about a millisecond, each), so 50 a batch is far more than
 *   the server emits. A batch of 1 would cap export at a few hundred a second.
 * - A send gets `sendTimeoutMs` per attempt and `maxAttempts` tries before the
 *   batch is dropped and counted; a closing server does not retry.
 */
export const SERVER_TELEMETRY_EXPORTER = Object.freeze({
  capacity: 1000,
  batchSize: 50,
  sendTimeoutMs: 5_000,
  maxAttempts: 3,
  retryDelayMs: 200,
  intervalMs: 500,
});

/** How long shutdown waits for telemetry to flush before abandoning the rest. */
export const SERVER_TELEMETRY_CLOSE_MS = 1_000;

export type ServerTelemetryOptions = {
  /** Where records go. Leave out to disable export. */
  readonly send?: (
    batch: readonly TelemetryRecord[],
    signal: AbortSignal,
  ) => Promise<void> | void;
};

export function createServerTelemetry(
  options: ServerTelemetryOptions = {},
): Telemetry {
  return createTelemetry({
    send: options.send,
    exporter: SERVER_TELEMETRY_EXPORTER,
    redact: createTelemetryRedactor({ outcomes: JOB_OUTCOMES }),
    events: Object.values(EXECUTION_TELEMETRY_EVENTS),
  });
}
