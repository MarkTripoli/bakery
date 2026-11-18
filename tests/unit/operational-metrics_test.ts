import { assert, assertEquals } from "@std/assert";
import {
  createOperationalMetricSampler,
  OPERATIONAL_METRIC_SPECS,
  startOperationalMetricSampling,
} from "../../apps/server/src/platform/operational-metrics.ts";
import { createServerTelemetry } from "../../apps/server/src/platform/telemetry.ts";

/**
 * The operational metric producers (#23).
 *
 * The registry and the facade already existed; nothing recorded an application
 * metric and nothing flushed, so the machinery held zero series. These tests
 * check that the producers name real metrics, read the ledger, and actually
 * flush - the last one being the defect this file exists for.
 */

type Call =
  | { kind: "set"; name: string; labels: Record<string, string>; value: number }
  | { kind: "inc"; name: string; labels: Record<string, string>; by: number }
  | { kind: "flush" };

function fakeTelemetry() {
  const calls: Call[] = [];
  return {
    calls,
    telemetry: {
      metrics: {
        set(name: string, labels: unknown, value: unknown) {
          calls.push({
            kind: "set",
            name,
            labels: labels as Record<string, string>,
            value: value as number,
          });
        },
        inc(name: string, labels: unknown, by: unknown) {
          calls.push({
            kind: "inc",
            name,
            labels: labels as Record<string, string>,
            by: by as number,
          });
        },
        // The sampler never reads the snapshot; the facade's type requires it.
        snapshot: () => [],
      },
      flushMetrics() {
        calls.push({ kind: "flush" });
      },
    },
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      states: [
        { status: "queued", count: "3" },
        { status: "completed", count: "9" },
      ],
      queue_age_seconds: "42.5",
      live_leases: "2",
      expired_leases: "1",
      display_open_bytes: "1024",
      status_open_bytes: "64",
      retries: "5",
      ...overrides,
    }],
  };
}

const database = (row: unknown = snapshotRow()) => ({
  query: () => Promise.resolve(row as never),
});

Deno.test("every producer names a metric the real registry accepts", () => {
  // The registry is closed: an unlisted label value folds into `other` and an
  // unnamed metric is refused. Recording through the real facade is what proves
  // these names and label values are inside the catalogue rather than wishful.
  const telemetry = createServerTelemetry();
  for (const [key, spec] of Object.entries(OPERATIONAL_METRIC_SPECS)) {
    const values = Object.values(
      (spec as { labels?: Readonly<Record<string, readonly string[]>> })
        .labels ??
        {},
    );
    const labels = Object.fromEntries(
      Object.entries(
        (spec as { labels?: Readonly<Record<string, readonly string[]>> })
          .labels ?? {},
      ).map(([name, list]) => [name, list[0]!]),
    );
    // Specs are keyed by the metric name they define, so a rename cannot leave
    // the catalogue and the producer disagreeing.
    const name = key;
    if (spec.kind === "counter") {
      telemetry.metrics.inc(name, labels, 1);
    } else {
      telemetry.metrics.set(name, labels, values.length);
    }
    const sample = telemetry.metrics
      .snapshot()
      .find((s) => s.name === name && sameLabels(s.labels, labels));
    assert(sample !== undefined, `${name} was refused by the registry`);
  }
});

Deno.test("a sample records the ledger's numbers as it found them", async () => {
  const { calls, telemetry } = fakeTelemetry();
  const sampler = createOperationalMetricSampler({
    database: database(),
    telemetry,
  });
  await sampler.sample();

  const set = (name: string, labels: Record<string, string>) =>
    calls.find((call) =>
      call.kind === "set" && call.name === name &&
      sameLabels(call.labels, labels)
    );
  assertEquals(
    (set("bakery_jobs_by_status", { status: "queued" }) as { value: number })
      .value,
    3,
  );
  assertEquals(
    (set("bakery_jobs_by_status", { status: "completed" }) as { value: number })
      .value,
    9,
  );
  // bigint arrives as a string and a null aggregate means zero, not NaN.
  assertEquals(
    (set("bakery_queue_age_seconds", {}) as { value: number }).value,
    42.5,
  );
  assertEquals(
    (set("bakery_active_leases", { state: "live" }) as { value: number }).value,
    2,
  );
  assertEquals(
    (set("bakery_active_leases", { state: "expired" }) as { value: number })
      .value,
    1,
  );
  assertEquals(
    (set("bakery_spool_open_bytes", { channel: "display" }) as {
      value: number;
    }).value,
    1024,
  );
  assertEquals(
    (set("bakery_spool_open_bytes", { channel: "status" }) as {
      value: number;
    }).value,
    64,
  );
});

Deno.test("a sample flushes, because a metric that never leaves is not a metric", async () => {
  // The facade's metrics sat unflushed before this existed: recording into the
  // registry and emitting a record are different acts, and only the second one
  // is observable to an operator.
  const { calls, telemetry } = fakeTelemetry();
  await createOperationalMetricSampler({ database: database(), telemetry })
    .sample();
  assertEquals(calls.at(-1)?.kind, "flush");
});

Deno.test("cumulative retries become a counter delta, and never a negative one", async () => {
  // A counter that goes backwards is a lie an operator will act on, so a
  // restored backup or a deleted row must not emit a negative increment.
  const { calls, telemetry } = fakeTelemetry();
  let retries = "5";
  const sampler = createOperationalMetricSampler({
    database: {
      query: () => Promise.resolve(snapshotRow({ retries }) as never),
    },
    telemetry,
  });

  await sampler.sample();
  await sampler.sample();
  await sampler.sample();
  const increments = calls.filter((call) =>
    call.kind === "inc" && call.name === "bakery_job_retries_total"
  ) as { by: number }[];
  // First sample counts all five; the next two are unchanged, so no increment.
  assertEquals(increments.map((call) => call.by), [5]);

  retries = "8";
  await sampler.sample();
  retries = "2";
  await sampler.sample();
  const after = calls.filter((call) =>
    call.kind === "inc" && call.name === "bakery_job_retries_total"
  ) as { by: number }[];
  assertEquals(after.map((call) => call.by), [5, 3]);
});

Deno.test("a status the catalogue does not name is still recorded", async () => {
  // The registry folds an unknown value into `other` rather than dropping the
  // number, so a new status is visible before anyone catalogues it.
  const { calls, telemetry } = fakeTelemetry();
  await createOperationalMetricSampler({
    database: database(snapshotRow({
      states: [{ status: "paused", count: "4" }],
    })),
    telemetry,
  }).sample();
  const queued = calls.find((call) =>
    call.kind === "set" && call.name === "bakery_jobs_by_status"
  );
  assert(queued !== undefined, "an uncatalogued status was dropped entirely");
});

Deno.test("a failing query costs a sample, not the server", async () => {
  // This runs on a timer inside the server. A database blip must produce a gap
  // in the metrics, never a rejection that reaches the event loop unhandled.
  const { calls, telemetry } = fakeTelemetry();
  const sampler = createOperationalMetricSampler({
    database: { query: () => Promise.reject(new Error("connection lost")) },
    telemetry,
  });
  await sampler.sample();
  assertEquals(calls.length, 0);
});

Deno.test("an empty database samples zero rather than nothing", async () => {
  const { calls, telemetry } = fakeTelemetry();
  await createOperationalMetricSampler({
    database: database({
      rows: [{
        states: null,
        queue_age_seconds: null,
        live_leases: null,
        expired_leases: null,
        display_open_bytes: null,
        status_open_bytes: null,
        retries: null,
      }],
    }),
    telemetry,
  }).sample();
  const age = calls.find((call) =>
    call.kind === "set" && call.name === "bakery_queue_age_seconds"
  ) as { value: number };
  assertEquals(age.value, 0);
});

Deno.test("sampling starts on the interval and stops when stopped", () => {
  // "Exists" and "runs" are indistinguishable from outside; this is the property
  // that separates them, and the defect that started #23 was a component that was
  // built and never called.
  const { telemetry } = fakeTelemetry();
  let run: (() => void) | undefined;
  let cleared: number | undefined;
  const sampling = startOperationalMetricSampling({
    database: database(),
    telemetry,
    intervalMs: 1234,
    setInterval: (handler, ms) => {
      assertEquals(ms, 1234);
      run = handler;
      return 7;
    },
    clearInterval: (handle) => {
      cleared = handle;
    },
  });
  assert(run !== undefined, "sampling never scheduled a tick");
  sampling.stop();
  assertEquals(cleared, 7);
});

function sameLabels(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
}
