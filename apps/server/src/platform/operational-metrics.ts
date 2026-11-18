/**
 * The server's own operational metrics (#23).
 *
 * The metric machinery already existed — a cardinality-bounded registry and a
 * facade that can flush it — but nothing recorded an application metric and
 * nothing ever flushed, so the registry was an elaborate way to hold zero
 * series. This file supplies the producers.
 *
 * Three rules shape it:
 *
 * - **Labels are closed.** Every label lists its values here, so a run id, a job
 *   id or a session id can never become a dimension that multiplies the series
 *   until the metrics backend falls over. Durable ids belong in traces.
 * - **The ledger is the source.** Every number is an aggregate over a durable
 *   Postgres row, not an in-process counter, so a restart does not reset the
 *   queue depth to zero and an operator sees the same number the database holds.
 * - **A sample never breaks execution.** This runs on a timer inside the server;
 *   a slow or failing query costs a skipped sample, never a stalled request.
 */
import type { PgDatabase } from "@bakery/persistence/postgres";
import type { MetricSpecs } from "@bakery/config/telemetry-metrics";
import type { Telemetry } from "@bakery/config/telemetry";

/**
 * What the server measures.
 *
 * Names and labels are the contract: a dashboard or alert written against them
 * keeps working. Label values are lowercase words, never ids.
 */
export const OPERATIONAL_METRIC_SPECS = Object.freeze(
  {
    /** Jobs waiting to be claimed, by the state they are waiting in. */
    bakery_jobs_by_status: {
      kind: "gauge",
      help: "Jobs in the ledger by status.",
      labels: {
        status: [
          "queued",
          "leased",
          "running",
          "completed",
          "failed",
          "canceled",
          "canceling",
          "expired",
        ],
      },
    },
    /** How long the oldest unclaimable job has been waiting. */
    bakery_queue_age_seconds: {
      kind: "gauge",
      help: "Age in seconds of the oldest queued job.",
    },
    /** Leases held right now, and leases that lapsed without being renewed. */
    bakery_active_leases: {
      kind: "gauge",
      help: "Job leases by whether they are live or expired.",
      labels: { state: ["live", "expired"] },
    },
    /**
     * Spool bytes still held for open streams, by what they carry.
     *
     * Deliberately not called "unread": the schema records what was written
     * (`display_bytes`, `status_bytes`) and whether the stream is closed, but no
     * reader cursor, so written-minus-read is not computable. A metric that claims
     * to measure lag and cannot is worse than one that says what it measures.
     */
    bakery_spool_open_bytes: {
      kind: "gauge",
      help: "Session output bytes held for streams that are not closed.",
      labels: { channel: ["display", "status"] },
    },
    /** Attempts beyond the first, which is what a retry costs an operator. */
    bakery_job_retries_total: {
      kind: "counter",
      help: "Job attempts after the first, cumulatively.",
    },
    /**
     * Batches a telemetry destination refused.
     *
     * Per destination, because "the collector is rejecting us" and "the log
     * directory is full" call for different fixes, and a single total hid which
     * one was broken. The sink already counts them; nothing could publish them
     * from inside its own call tree, which is why this lives here.
     */
    bakery_export_destination_failures_total: {
      kind: "counter",
      help: "Telemetry batches a destination failed to accept.",
      labels: { destination: ["log", "otlp"] },
    },
  } as const satisfies MetricSpecs,
);

export type OperationalMetricSpecs = typeof OPERATIONAL_METRIC_SPECS;

/**
 * The aggregate the sampler reads, already reduced by Postgres.
 *
 * One round trip rather than six: every field is a scalar or a small
 * status/count pair, so the server never pulls a row per job into memory to count
 * it.
 */
const SNAPSHOT_SQL = `
with job_states as (
  select status, count(*)::bigint as count
  from bakery.jobs
  group by status
),
queue_age as (
  select coalesce(
    max(greatest(0, extract(epoch from (now() - available_at)))),
    0
  ) as seconds
  from bakery.jobs
  where status = 'queued'
),
leases as (
  select
    count(*) filter (where lease_expires_at > now())::bigint as live,
    count(*) filter (
      where lease_expires_at <= now() and status = 'leased'
    )::bigint as expired
  from bakery.job_attempts
),
spool as (
  select
    coalesce(sum(display_bytes), 0)::bigint as display_open,
    coalesce(sum(status_bytes), 0)::bigint as status_open
  from bakery.session_output_streams
  where not closed
),
retries as (
  select count(*) filter (where attempt_no > 1)::bigint as total
  from bakery.job_attempts
)
select
  (select jsonb_agg(jsonb_build_object('status', status, 'count', count))
   from job_states) as states,
  (select seconds from queue_age) as queue_age_seconds,
  (select live from leases) as live_leases,
  (select expired from leases) as expired_leases,
  (select display_open from spool) as display_open_bytes,
  (select status_open from spool) as status_open_bytes,
  (select total from retries) as retries
`;

/** What a sample needs. Everything is injected so the sampler is testable. */
export type OperationalMetricSamplerDeps = {
  readonly database: Pick<PgDatabase, "query">;
  readonly telemetry: Pick<Telemetry, "metrics" | "flushMetrics">;
  /** Per-destination batch failures, read from the sink's own counters. */
  readonly sink?: { stats(): Readonly<Record<string, { failed: number }>> };
};

export type OperationalMetricSampler = {
  /** Reads the ledger once and records what it found. Never throws. */
  sample(): Promise<void>;
};

/**
 * Builds the sampler.
 *
 * Cumulative ledger totals become counter deltas, clamped at zero: a deleted row
 * or a restored backup must not emit a negative `inc`, and a counter that goes
 * backwards is a lie an operator will act on.
 */
export function createOperationalMetricSampler(
  deps: OperationalMetricSamplerDeps,
): OperationalMetricSampler {
  let previousRetries = 0;
  const previousFailed: Record<string, number> = {};

  return {
    async sample() {
      let result;
      try {
        result = await deps.database.query<{
          states: { status: string; count: string }[] | null;
          queue_age_seconds: string | number | null;
          live_leases: string | number | null;
          expired_leases: string | number | null;
          display_open_bytes: string | number | null;
          status_open_bytes: string | number | null;
          retries: string | number | null;
        }>(SNAPSHOT_SQL);
      } catch {
        // A failed sample is a gap in the metrics, not a failed server. The next
        // tick tries again and the exporter's own loss counter keeps the gap
        // visible.
        return;
      }
      const row = result.rows[0];
      if (row === undefined) return;

      // Every status the ledger holds is recorded, including one the spec did
      // not name: the registry folds an unknown value into `other` rather than
      // dropping the number, so a new status is visible before it is catalogued.
      for (const state of row.states ?? []) {
        deps.telemetry.metrics.set(
          "bakery_jobs_by_status",
          { status: state.status },
          asNumber(state.count),
        );
      }
      deps.telemetry.metrics.set(
        "bakery_queue_age_seconds",
        {},
        asNumber(row.queue_age_seconds),
      );
      deps.telemetry.metrics.set(
        "bakery_active_leases",
        { state: "live" },
        asNumber(row.live_leases),
      );
      deps.telemetry.metrics.set(
        "bakery_active_leases",
        { state: "expired" },
        asNumber(row.expired_leases),
      );
      deps.telemetry.metrics.set(
        "bakery_spool_open_bytes",
        { channel: "display" },
        asNumber(row.display_open_bytes),
      );
      deps.telemetry.metrics.set(
        "bakery_spool_open_bytes",
        { channel: "status" },
        asNumber(row.status_open_bytes),
      );

      const retries = asNumber(row.retries);
      const delta = retries - previousRetries;
      if (delta > 0) {
        deps.telemetry.metrics.inc("bakery_job_retries_total", {}, delta);
      }
      previousRetries = retries;

      // A destination failure is cumulative in the sink, so what is recorded is
      // the delta since the last sample. Clamped at zero for the same reason the
      // retry counter is: a rebuilt sink starts again at nothing, and a counter
      // that goes backwards is a number an operator will act on wrongly.
      for (
        const [destination, counters] of Object.entries(
          deps.sink?.stats() ?? {},
        )
      ) {
        const delta = counters.failed - (previousFailed[destination] ?? 0);
        previousFailed[destination] = counters.failed;
        if (delta > 0) {
          deps.telemetry.metrics.inc(
            "bakery_export_destination_failures_total",
            { destination },
            delta,
          );
        }
      }

      // The whole point of recording is that the numbers leave the process. The
      // facade's metrics sat unflushed before this existed, so flushing belongs
      // to the thing that produces them.
      deps.telemetry.flushMetrics();
    },
  };
}

/** How often the server samples the ledger. */
export const OPERATIONAL_METRIC_INTERVAL_MS = 15_000;

export type OperationalMetricSamplingOptions = OperationalMetricSamplerDeps & {
  readonly intervalMs?: number;
  /** Starts the interval; injected so a test drives ticks deterministically. */
  readonly setInterval?: (run: () => void, ms: number) => number;
  readonly clearInterval?: (handle: number) => void;
};

/**
 * Starts sampling on an interval and returns how to stop it.
 *
 * This is the production wiring as a named function, for the same reason slice 1
 * has one: the sampler existing and the sampler running are indistinguishable
 * from the outside, and the defect that started this issue was exactly a
 * component that was built and never called.
 *
 * The interval is `unref`'d where the runtime allows it, so sampling never keeps
 * a shutting-down process alive.
 */
export function startOperationalMetricSampling(
  options: OperationalMetricSamplingOptions,
): { stop(): void; sample(): Promise<void> } {
  const sampler = createOperationalMetricSampler(options);
  const schedule = options.setInterval ??
    ((run, ms) => {
      const handle = setInterval(run, ms);
      // A timer that outlives the work is a shutdown that never finishes.
      (handle as unknown as { unref?: () => void }).unref?.();
      return handle as unknown as number;
    });
  const handle = schedule(
    () => {
      // Fire and forget: this runs on a timer, so an unhandled rejection here
      // would take down the process for a telemetry sample.
      void sampler.sample();
    },
    options.intervalMs ?? OPERATIONAL_METRIC_INTERVAL_MS,
  );
  return {
    stop: () => (options.clearInterval ?? clearInterval)(handle),
    sample: () => sampler.sample(),
  };
}

/** Postgres returns bigint as a string; a null aggregate means zero, not NaN. */
function asNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
