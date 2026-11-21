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
import type { ExportSink } from "@bakery/config/telemetry-export";
import {
  createTelemetry,
  type Telemetry,
  type TelemetryRecord,
} from "@bakery/config/telemetry";
import { createTelemetryRedactor } from "@bakery/config/telemetry-attributes";
import {
  TELEMETRY_LOG_MAX_BYTES,
  TELEMETRY_LOG_MAX_FILES,
  type TelemetrySinkConfig,
} from "@bakery/config/telemetry-sink";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { OPERATIONAL_METRIC_SPECS } from "./operational-metrics.ts";
import {
  createRotatingLogSink,
  createTelemetrySink,
  type RotatingLogFileSystem,
  type TelemetrySink,
} from "./telemetry-sink.ts";
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
    // The registry refuses a metric it was not told about, so the catalogue is
    // declared where the telemetry is built rather than discovered at runtime.
    metrics: OPERATIONAL_METRIC_SPECS,
  });
}

/**
 * Builds the server's telemetry from configuration.
 *
 * This exists as a named function rather than three lines inside `main.ts`
 * because the wiring itself is what has failed before: a facade that is built
 * with no sink looks identical to a working one from every behaviour test, and
 * the only way to prove production exports is to call the same function
 * production calls.
 *
 * With no sink configured this returns a disabled telemetry, which is the
 * documented default and not an error.
 */
export function createServerTelemetryFromConfig(
  config: TelemetrySinkConfig | undefined,
  options: {
    /**
     * Delivers each batch to the destinations saved in the app. It only enqueues
     * (see `createDestinationFanout`), so it is handed to the sink as a
     * destination of its own and never waits for one of them.
     */
    readonly destinations?: ExportSink<TelemetryRecord>;
  } = {},
): ServerTelemetry {
  if (config === undefined && options.destinations === undefined) {
    return createServerTelemetry();
  }
  const log = config?.logDir === undefined ? undefined : createRotatingLogSink({
    directory: config.logDir,
    maxBytes: config.logMaxBytes ?? TELEMETRY_LOG_MAX_BYTES,
    maxFiles: config.logMaxFiles ?? TELEMETRY_LOG_MAX_FILES,
    fileSystem: nodeRotatingLogFileSystem,
  });
  // The sink carries per-destination counters, and slice 2 publishes them from
  // the metric sampler. They cannot be recorded here: a metric write from inside
  // the sink's own call tree is refused as reentrant, so the honest place to
  // export them is outside it. The sink is handed out for that reader alone.
  // The "otlp" slot of the sink is the fan-out of the destinations saved in the
  // app; each of those keeps its own state, which the Monitoring page shows.
  const sink = createTelemetrySink({ log, otlp: options.destinations });
  const telemetry = createServerTelemetry({ send: sink });
  return Object.assign(telemetry, { sink }) as ServerTelemetry;
}

/** The server's telemetry facade, plus the sink whose counters it cannot see. */
export type ServerTelemetry = Telemetry & { readonly sink?: TelemetrySink };

/**
 * The filesystem the rotating sink uses.
 *
 * `node:fs/promises` rather than `Deno.writeTextFile`, because #139 removes Deno
 * and new code should not add to the migration. Appends open with `a` so two
 * writers cannot interleave inside a line.
 */
const nodeRotatingLogFileSystem: RotatingLogFileSystem = {
  async append(path, bytes) {
    const handle = await open(path, "a");
    try {
      await handle.write(bytes);
    } finally {
      await handle.close();
    }
  },
  async size(path) {
    try {
      const stats = await stat(path);
      return stats.size;
    } catch {
      return 0;
    }
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    await rm(path, { force: true });
  },
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true });
  },
};
