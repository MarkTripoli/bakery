import { assert, assertEquals } from "@std/assert";
import {
  createOperationalMetricSampler,
  OPERATIONAL_METRIC_SPECS,
  SNAPSHOT_SQL,
  startOperationalMetricSampling,
  stopSamplingThenCloseTelemetry,
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
  //
  // A gap, though, is not silence: QA found this swallowed entirely, which made
  // "the database is unavailable" look exactly like "nothing is happening". What
  // is asserted is that the failure is counted and nothing else is recorded - a
  // stale reading left over from before the failure would be worse than a gap.
  const { calls, telemetry } = fakeTelemetry();
  const sampler = createOperationalMetricSampler({
    database: { query: () => Promise.reject(new Error("connection lost")) },
    telemetry,
  });
  await sampler.sample();
  // The failure is counted, then flushed so it leaves the process; nothing else
  // is recorded, so a stale reading cannot outlive the failure that caused it.
  assertEquals(calls, [
    {
      kind: "inc",
      name: "bakery_metric_sample_failures_total",
      labels: {},
      by: 1,
    },
    { kind: "flush" },
  ]);
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

Deno.test("export failures are published per destination, as deltas", async () => {
  // The sink counts per destination, but a metric write from inside its own call
  // tree is refused as reentrant, so this is the only place the numbers can be
  // published. Per destination matters: a full disk and a rejecting collector
  // need different fixes, and one total hid which one was broken.
  const telemetry = createServerTelemetry();
  let log = 0;
  let otlp = 0;
  const failures = () =>
    telemetry.metrics.snapshot()
      .filter((sample) =>
        sample.name === "bakery_export_destination_failures_total"
      )
      .map((sample) => [sample.labels.destination, sample.value] as const);
  const sampler = createOperationalMetricSampler({
    database: database(),
    telemetry,
    sink: { stats: () => ({ log: { failed: log }, otlp: { failed: otlp } }) },
  });

  // Nothing has failed yet, so nothing is recorded.
  await sampler.sample();
  assertEquals(failures().length, 0);

  log = 2;
  await sampler.sample();
  // The sink's counter is cumulative and unchanged, so no second increment.
  await sampler.sample();

  otlp = 3;
  await sampler.sample();

  assertEquals(new Map(failures()), new Map([["log", 2], ["otlp", 3]]));
});

Deno.test("a sink rebuilt under the sampler never emits a negative count", async () => {
  // A rebuilt sink starts its counters again at zero. Recording the raw value
  // would subtract 5 from a counter, and a counter that goes backwards is a
  // number an operator acts on wrongly.
  const telemetry = createServerTelemetry();
  let failed = 5;
  const sampler = createOperationalMetricSampler({
    database: database(),
    telemetry,
    sink: { stats: () => ({ log: { failed } }) },
  });
  await sampler.sample();
  failed = 0;
  await sampler.sample();
  const values = telemetry.metrics.snapshot()
    .filter((sample) =>
      sample.name === "bakery_export_destination_failures_total"
    )
    .map((sample) => sample.value);
  assert(values.every((value) => value >= 0), `negative delta: ${values}`);
});

Deno.test("a live lease counts only attempts that still hold one", () => {
  // QA ran the aggregate on a fresh Postgres and got 3 live leases where 1 was
  // held: every attempt with a future lease_expires_at was counted, including
  // completed and failed ones, whose expiry is a leftover timestamp. The status
  // has to be part of the definition, not just the clock.
  //
  // Read as one clause rather than a substring search: `status = 'leased'`
  // appearing anywhere in the statement is not the same as it qualifying the
  // live count, and the first version of this test passed while the filter was
  // gone.
  const sql = SNAPSHOT_SQL;
  const live =
    /count\(\*\)\s+filter\s*\(\s*where\s+status\s*=\s*'leased'\s+and\s+lease_expires_at\s*>\s*now\(\)\s*\)/i
      .test(sql);
  assert(
    live,
    `the live lease count does not require a leased attempt:\n${sql}`,
  );
  const expired =
    /count\(\*\)\s+filter\s*\(\s*where\s+status\s*=\s*'leased'\s+and\s+lease_expires_at\s*<=\s*now\(\)\s*\)/i
      .test(sql);
  assert(expired, "the expired lease count does not require a leased attempt");
});

Deno.test("a failed sample is counted and reported, never swallowed", async () => {
  const telemetry = createServerTelemetry();
  const failures: string[] = [];
  const sampler = createOperationalMetricSampler({
    database: {
      query: () => Promise.reject(new Error("connection terminated")),
    },
    telemetry,
    onSampleError: (failure) => failures.push(failure),
  });

  await sampler.sample();

  assertEquals(failures, ["query_failed"]);
  const counted = telemetry.metrics.snapshot().filter((sample) =>
    sample.name === "bakery_metric_sample_failures_total"
  );
  assertEquals(counted.length, 1);
  assertEquals(counted[0]!.value, 1);
  // The reporter is told what kind of failure it was, never the driver's message,
  // which can quote a statement or a row value.
  assertEquals(
    failures.every((failure) => !failure.includes("terminated")),
    true,
  );
});

Deno.test("shutdown stops sampling before it closes telemetry", async () => {
  // QA found the inline ordering untested: a mutant that swapped it survived.
  const order: string[] = [];
  await stopSamplingThenCloseTelemetry({
    sampling: { stop: () => order.push("stop") },
    closeTelemetry: () => {
      order.push("close");
      return Promise.resolve();
    },
  });
  assertEquals(order, ["stop", "close"]);
});

Deno.test("the production wiring samples on its interval and stops when told", async () => {
  // The mutant QA killed by hand: delete the start call in main.ts and every
  // unit test still passes. This reads the wiring main.ts calls, so removing it
  // from the entry point or breaking the interval both show up here.
  //
  // The tick is counted on the database, not on the schedule: a version that
  // scheduled a timer whose callback did nothing would satisfy "a tick was
  // scheduled" and sample nothing, which is the defect this whole issue is about.
  let reads = 0;
  let handle: (() => void) | undefined;
  let cleared = false;
  const sampling = startOperationalMetricSampling({
    database: {
      query: () => {
        reads += 1;
        return Promise.resolve({ rows: [] } as never);
      },
    },
    telemetry: createServerTelemetry(),
    intervalMs: 25,
    setInterval: (run) => {
      handle = run;
      return 7;
    },
    clearInterval: (clearedHandle) => {
      assertEquals(clearedHandle, 7);
      cleared = true;
    },
  });

  assert(handle !== undefined, "sampling did not schedule a tick");
  handle!();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(reads, 1, "a scheduled tick did not read the ledger");
  sampling.stop();
  assertEquals(cleared, true, "stop() did not clear the interval");
});

Deno.test("the server entry point starts sampling and stops it on shutdown", async () => {
  // QA's mutant, exactly: remove the start call from main.ts and every other
  // test still passes, because they all call the wiring themselves. The wiring
  // existing and the server using it are different facts, and the defect this
  // issue began with was a component that was built and never called. So this
  // reads the entry point.
  const main = await Deno.readTextFile(
    new URL("../../apps/server/src/main.ts", import.meta.url),
  );
  assert(
    /startOperationalMetricSampling\(\{/.test(main),
    "main.ts does not start operational metric sampling",
  );
  assert(
    /stopSamplingThenCloseTelemetry\(\{/.test(main),
    "main.ts never stops sampling, so the interval outlives the server",
  );
  assert(
    /sink: telemetry\.sink/.test(main),
    "main.ts does not hand the sink to the sampler, so export failures go unpublished",
  );
});
