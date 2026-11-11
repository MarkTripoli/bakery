import { assert, assertEquals } from "@std/assert";
import {
  createTelemetry,
  TELEMETRY_META_METRICS,
  type TelemetryOptions,
  type TelemetryRecord,
} from "../../packages/config/src/telemetry.ts";
import { createTelemetryRedactor } from "../../packages/config/src/telemetry-attributes.ts";
import { MAX_TRACE_LINKS } from "../../packages/config/src/telemetry-trace.ts";
import type { MetricSample } from "../../packages/config/src/telemetry-metrics.ts";

// The facade is what code on the lease, completion and settlement paths calls.
// It has one job beyond composing the pieces: whatever the sink, the redactor,
// the clock or the arguments do, the call returns at once and the caller is
// none the wiser. The record that does leave carries only what the allowlist
// admits, ids as attributes and never as metric labels.

const uuid = "0b9a1f0e-5a3c-4c1e-8f6a-2d4b7c9e1a30";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "00f067aa0ba902b7";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 3000) {
  const stop = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > stop) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await pause(2);
  }
}

const redact = createTelemetryRedactor({
  outcomes: ["AUTH_FORBIDDEN", "TIMEOUT"],
});

const baseExporter = {
  capacity: 10,
  batchSize: 5,
  sendTimeoutMs: 200,
  maxAttempts: 1,
  retryDelayMs: 1,
  intervalMs: 3,
} as const;

function make(overrides: Partial<TelemetryOptions> = {}) {
  const sent: TelemetryRecord[] = [];
  const telemetry = createTelemetry({
    send: (batch) => {
      sent.push(...batch);
    },
    exporter: baseExporter,
    redact,
    events: ["lease.renewed", "job.completed", "usage.settled"],
    metrics: {
      jobs_total: {
        kind: "counter",
        help: "Jobs finished.",
        labels: { outcome: ["done", "failed"] },
      },
    },
    ...overrides,
  });
  return { telemetry, sent };
}

/** The value of one meta metric series. */
function meta(
  samples: readonly MetricSample[],
  name: string,
  label?: string,
): number {
  const found = samples.find((sample) =>
    sample.name === name &&
    (label === undefined || Object.values(sample.labels).includes(label))
  );
  return found?.value ?? 0;
}

Deno.test("an event leaves as a record with redacted attributes, the time and a valid trace", async () => {
  const { telemetry, sent } = make({ now: () => 1_700_000_000_000 });
  telemetry.event(
    "lease.renewed",
    {
      "bakery.run.id": uuid,
      "bakery.outcome": "TIMEOUT",
      "bakery.retry.count": 2,
      prompt: "summarize the contract",
      "bakery.task.id": "not-a-uuid",
    },
    {
      context: { traceId, spanId, sampled: true },
      links: [{ traceId: "1".repeat(32), spanId: "1".repeat(16) }],
    },
  );
  await telemetry.close(500);
  assertEquals(sent.length, 1);
  assertEquals(sent[0], {
    kind: "event",
    name: "lease.renewed",
    time: 1_700_000_000_000,
    attributes: {
      "bakery.run.id": uuid,
      "bakery.outcome": "TIMEOUT",
      "bakery.retry.count": 2,
    },
    trace: { traceId, spanId, sampled: true },
    links: [{ traceId: "1".repeat(32), spanId: "1".repeat(16) }],
  });
  const wire = JSON.stringify(sent);
  assert(!wire.includes("summarize"));
  assert(!wire.includes("not-a-uuid"));
  assert(!wire.includes("prompt"));
});

Deno.test("an event name outside the declared list is counted and sends nothing", async () => {
  const { telemetry, sent } = make();
  for (
    const name of ["lease.lost", "", "LEASE.RENEWED", uuid, "x".repeat(10_000)]
  ) {
    telemetry.event(name, { "bakery.run.id": uuid });
  }
  telemetry.event(undefined as unknown as string);
  telemetry.event(42 as unknown as string);
  await telemetry.close(200);
  assertEquals(sent, []);
  assertEquals(
    meta(
      telemetry.metrics.snapshot(),
      TELEMETRY_META_METRICS.events,
      "unknown_event",
    ),
    7,
  );
});

Deno.test("a disabled sink costs a counter: nothing is redacted, queued or sent", async () => {
  let redactions = 0;
  const { telemetry, sent } = make({
    send: undefined,
    redact: (input) => {
      redactions += 1;
      return redact(input);
    },
  });
  for (let index = 0; index < 50_000; index += 1) {
    telemetry.event("job.completed", { "bakery.run.id": uuid });
  }
  telemetry.metrics.inc("jobs_total", { outcome: "done" }, 3);
  telemetry.flushMetrics();
  await telemetry.close(100);
  assertEquals(redactions, 0);
  assertEquals(sent, []);
  assertEquals(telemetry.stats().disabled, true);
  const samples = telemetry.metrics.snapshot();
  assertEquals(
    meta(samples, TELEMETRY_META_METRICS.events, "discarded"),
    50_000,
  );
  // Metrics are still kept in memory, so a scrape endpoint can read them.
  assertEquals(meta(samples, "jobs_total", "done"), 3);
});

Deno.test("a sink that never answers cannot slow the caller, grow the queue or hide the loss", async () => {
  const { telemetry } = make({
    send: () => new Promise(() => {}),
    exporter: { ...baseExporter, sendTimeoutMs: 60_000 },
  });
  const started = performance.now();
  for (let index = 0; index < 20_000; index += 1) {
    telemetry.event("job.completed", { "bakery.run.id": uuid });
  }
  const elapsed = performance.now() - started;
  assert(elapsed < 1500, `20,000 events took ${elapsed} ms`);
  await until(() => telemetry.stats().inFlight > 0, "a batch in flight");
  const stats = telemetry.stats();
  assert(stats.queued <= baseExporter.capacity);
  assert(stats.inFlight <= baseExporter.batchSize);
  const samples = telemetry.metrics.snapshot();
  const recorded = meta(samples, TELEMETRY_META_METRICS.events, "recorded");
  const dropped = meta(samples, TELEMETRY_META_METRICS.events, "dropped");
  assertEquals(recorded + dropped, 20_000);
  assert(dropped > 19_000, `only ${dropped} dropped`);
  assertEquals(
    meta(samples, TELEMETRY_META_METRICS.lost, "queue_full"),
    stats.dropped.queueFull,
  );
  await telemetry.close(50);
});

Deno.test("a slow sink does not slow the caller either", async () => {
  const { telemetry } = make({
    send: () => pause(80),
    exporter: { ...baseExporter, capacity: 50, batchSize: 10 },
  });
  const started = performance.now();
  for (let index = 0; index < 2000; index += 1) {
    telemetry.event("usage.settled", { "bakery.run.id": uuid });
  }
  assert(performance.now() - started < 500, "calls must not wait for sends");
  await telemetry.close(1000);
});

Deno.test("a redactor, a clock or an argument that throws is counted and never reaches the caller", async () => {
  const boom = () => {
    throw new Error("boom");
  };
  const failing = make({ redact: boom });
  failing.telemetry.event("job.completed", { "bakery.run.id": uuid });
  assertEquals(
    meta(
      failing.telemetry.metrics.snapshot(),
      TELEMETRY_META_METRICS.events,
      "failed",
    ),
    1,
  );
  await failing.telemetry.close(100);

  const clock = make({ now: boom });
  clock.telemetry.event("job.completed", { "bakery.run.id": uuid });
  await clock.telemetry.close(200);
  assertEquals(clock.sent[0]?.kind === "event" && clock.sent[0].time, 0);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile = make();
  for (
    const attributes of [
      revoked.proxy,
      new Proxy({}, { ownKeys: boom, get: boom }),
      null,
      undefined,
      "text",
      7,
    ]
  ) {
    hostile.telemetry.event("job.completed", attributes);
  }
  await hostile.telemetry.close(200);
  assert(
    hostile.sent.every((record) =>
      record.kind === "event" && Object.keys(record.attributes).length === 0
    ),
  );
});

Deno.test("a clock that is not a usable time is recorded as zero", async () => {
  for (
    const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY, "now", 1.5e300]
  ) {
    const { telemetry, sent } = make({ now: () => bad as number });
    telemetry.event("job.completed", {});
    await telemetry.close(200);
    assertEquals(sent[0]?.kind === "event" && sent[0].time, 0, String(bad));
  }
});

Deno.test("a trace context that is not two well-formed ids is left out, and links are validated and bounded", async () => {
  const { telemetry, sent } = make({
    exporter: { ...baseExporter, capacity: 50 },
  });
  const badContexts: unknown[] = [
    { traceId: "please summarize", spanId, sampled: true },
    { traceId, spanId: "<script>", sampled: true },
    { traceId: "0".repeat(32), spanId, sampled: true },
    { traceId: traceId.toUpperCase(), spanId, sampled: true },
    {},
    null,
    "00-trace",
    42,
  ];
  for (const context of badContexts) {
    telemetry.event("lease.renewed", {}, { context });
  }
  const links = Array.from({ length: 40 }, (_, i) => ({
    traceId: i.toString(16).padStart(32, "a"),
    spanId: i.toString(16).padStart(16, "b"),
  }));
  telemetry.event("lease.renewed", {}, {
    links: [
      { traceId: "bad", spanId: "bad" },
      "junk",
      null,
      { traceId, spanId, secret: "do not send" },
      ...links,
    ],
  });
  await telemetry.close(500);
  const events = sent.filter((r) => r.kind === "event");
  for (const record of events.slice(0, badContexts.length)) {
    assert(record.kind === "event" && record.trace === undefined);
  }
  const withLinks = events.at(-1);
  assert(withLinks?.kind === "event");
  assertEquals(withLinks.links?.length, MAX_TRACE_LINKS);
  for (const link of withLinks.links ?? []) {
    assertEquals(Object.keys(link).sort(), ["spanId", "traceId"]);
    assert(link.traceId.length === 32 && link.spanId.length === 16);
  }
  // The three invalid entries before it were skipped, the extra field stripped.
  assertEquals(withLinks.links?.[0], { traceId, spanId });
  assert(!JSON.stringify(sent).includes("do not send"));
});

Deno.test("hostile trace arguments never throw", async () => {
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const boom = () => {
    throw new Error("boom");
  };
  const { telemetry } = make();
  for (
    const trace of [
      { links: revoked.proxy },
      { links: new Proxy([], { get: boom, has: boom }) },
      { context: new Proxy({}, { get: boom }) },
      { links: { length: 1e9, 0: { traceId, spanId } } },
      { links: Object.assign([], { length: 4_294_967_295 }) },
      null,
      "trace",
      7,
    ]
  ) {
    telemetry.event("lease.renewed", {}, trace as never);
  }
  await telemetry.close(300);
});

Deno.test("redacted fields are counted by kind and never echoed", async () => {
  const { telemetry, sent } = make();
  telemetry.event("job.completed", {
    "bakery.run.id": uuid,
    "user.email": "someone@example.com",
    "output.chunk": "secret text",
    "bakery.retry.count": -1,
    "bakery.outcome": "NOT_ON_THE_LIST",
  });
  await telemetry.close(200);
  const samples = telemetry.metrics.snapshot();
  assertEquals(
    meta(samples, TELEMETRY_META_METRICS.redacted, "unregistered"),
    2,
  );
  assertEquals(meta(samples, TELEMETRY_META_METRICS.redacted, "invalid"), 2);
  const everything = JSON.stringify([sent, samples]);
  for (
    const text of [
      "someone@example.com",
      "secret text",
      "NOT_ON_THE_LIST",
      "user.email",
    ]
  ) {
    assert(!everything.includes(text), `${text} leaked`);
  }
});

Deno.test("an id is an attribute of an event and never a metric label", async () => {
  const { telemetry, sent } = make();
  telemetry.event("job.completed", { "bakery.run.id": uuid });
  telemetry.metrics.inc("jobs_total", { outcome: uuid, runId: uuid });
  telemetry.metrics.inc("jobs_total", { outcome: "done" });
  telemetry.flushMetrics();
  await telemetry.close(300);
  const metricsRecord = sent.find((r) => r.kind === "metrics");
  assert(metricsRecord?.kind === "metrics");
  assert(!JSON.stringify(metricsRecord).includes(uuid), "an id became a label");
  const event = sent.find((r) => r.kind === "event");
  assert(event?.kind === "event" && event.attributes["bakery.run.id"] === uuid);
  assertEquals(meta(metricsRecord.samples, "jobs_total", "other"), 1);
});

Deno.test("flushing metrics offers one record with the application's and the telemetry's own metrics", async () => {
  const { telemetry, sent } = make({ now: () => 5 });
  telemetry.metrics.inc("jobs_total", { outcome: "failed" }, 4);
  telemetry.event("lease.renewed", {});
  telemetry.flushMetrics();
  await telemetry.close(300);
  const records = sent.filter((r) => r.kind === "metrics");
  assertEquals(records.length, 1);
  const record = records[0];
  assert(record.kind === "metrics");
  assertEquals(record.time, 5);
  const names = new Set(record.samples.map((s) => s.name));
  assert(names.has("jobs_total"));
  assert(names.has(TELEMETRY_META_METRICS.events));
  assert(names.has(TELEMETRY_META_METRICS.queueDepth));
});

Deno.test("export loss is a metric: queue, send and shutdown losses are counted by reason", async () => {
  const { telemetry } = make({
    send: () => Promise.reject(new Error("collector down")),
    exporter: { ...baseExporter, capacity: 3, batchSize: 3, maxAttempts: 1 },
  });
  for (let index = 0; index < 8; index += 1) {
    telemetry.event("job.completed", {});
  }
  await until(() => telemetry.stats().failedBatches === 1, "a failed batch");
  telemetry.event("job.completed", {});
  await telemetry.close(100);
  telemetry.event("job.completed", {});
  const samples = telemetry.metrics.snapshot();
  assertEquals(meta(samples, TELEMETRY_META_METRICS.lost, "queue_full"), 5);
  assertEquals(
    meta(samples, TELEMETRY_META_METRICS.lost, "send_failed") >= 3,
    true,
  );
  assertEquals(meta(samples, TELEMETRY_META_METRICS.lost, "shutdown"), 1);
});

Deno.test("close flushes what it can and an event after close is counted as dropped", async () => {
  const { telemetry, sent } = make({
    exporter: { ...baseExporter, intervalMs: 10_000 },
  });
  for (let index = 0; index < 4; index += 1) {
    telemetry.event("usage.settled", {});
  }
  await telemetry.close(500);
  assertEquals(sent.length, 4);
  telemetry.event("usage.settled", {});
  assertEquals(
    meta(
      telemetry.metrics.snapshot(),
      TELEMETRY_META_METRICS.events,
      "dropped",
    ),
    1,
  );
});

Deno.test("what it is made from is validated: event names, the reserved metric prefix and the exporter limits", () => {
  const build = (overrides: Partial<TelemetryOptions>) =>
    createTelemetry({
      send: undefined,
      exporter: baseExporter,
      redact,
      events: ["job.completed"],
      ...overrides,
    });
  const bad: Array<[string, Partial<TelemetryOptions>]> = [
    ["upper case event", { events: ["Job.Completed"] }],
    ["event with a space", { events: ["job completed"] }],
    ["empty event", { events: [""] }],
    ["event that looks like an id", { events: [uuid] }],
    ["event too long", { events: ["a".repeat(65)] }],
    ["too many events", {
      events: Array.from({ length: 65 }, (_, i) => `event_${i}x`),
    }],
    ["reserved prefix", {
      metrics: { bakery_telemetry_custom: { kind: "counter", help: "h" } },
    }],
    ["exporter capacity zero", { exporter: { ...baseExporter, capacity: 0 } }],
    ["endless events", {
      events: (function* () {
        for (;;) yield "job.completed";
      })(),
    }],
  ];
  for (const [name, overrides] of bad) {
    let error: unknown;
    try {
      // The endless generator is bounded by the construction under test.
      build(overrides);
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof RangeError, `${name}: ${String(error)}`);
    assert(
      !String((error as Error).message).includes(uuid),
      `${name} echoed an entry`,
    );
  }
  build({});
});

Deno.test("no timer is left running by a telemetry that was used and closed", async () => {
  const live = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const id: unknown = realSet(() => {
      live.delete(id);
      handler();
    }, ms);
    live.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    live.delete(id);
    realClear(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  try {
    const { telemetry } = make();
    for (let index = 0; index < 20; index += 1) {
      telemetry.event("lease.renewed", {});
    }
    telemetry.flushMetrics();
    await telemetry.close(500);
    assertEquals(live.size, 0);
    const disabled = make({ send: undefined });
    disabled.telemetry.event("lease.renewed", {});
    disabled.telemetry.flushMetrics();
    await disabled.telemetry.close(100);
    assertEquals(live.size, 0);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const id of live) realClear(id as ReturnType<typeof setTimeout>);
  }
});

// ---- export loss is read, not reported ----------------------------------------
// The loss metric used to be fed by the exporter's loss callback, whose timing
// the exporter is free to change (deferred, coalesced, rate limited). It is now
// read from the exporter's own counts whenever the metrics are, so it is exact
// at that moment and depends on no callback.

const reasons = [
  ["queueFull", "queue_full"],
  ["sendFailed", "send_failed"],
  ["shutdown", "shutdown"],
] as const;

function lostMatchesStats(
  samples: readonly MetricSample[],
  stats: ReturnType<ReturnType<typeof make>["telemetry"]["stats"]>,
  what: string,
) {
  for (const [key, reason] of reasons) {
    assertEquals(
      meta(samples, TELEMETRY_META_METRICS.lost, reason),
      stats.dropped[key],
      `${what}: ${reason}`,
    );
  }
}

Deno.test("the loss metric is exact in the same tick as the drop, with nothing to wait for", () => {
  const { telemetry } = make({
    send: () => new Promise(() => {}),
    exporter: {
      ...baseExporter,
      capacity: 2,
      batchSize: 1,
      sendTimeoutMs: 60_000,
    },
  });
  for (let index = 0; index < 50; index += 1) {
    telemetry.event("job.completed", {});
  }
  const stats = telemetry.stats();
  assert(stats.dropped.queueFull > 40, "the queue overflowed");
  lostMatchesStats(telemetry.metrics.snapshot(), stats, "same tick");
});

Deno.test("reading the metrics again does not count a loss twice", async () => {
  const { telemetry } = make({
    send: () => new Promise(() => {}),
    exporter: {
      ...baseExporter,
      capacity: 1,
      batchSize: 1,
      sendTimeoutMs: 60_000,
    },
  });
  for (let index = 0; index < 10; index += 1) {
    telemetry.event("job.completed", {});
  }
  const first = telemetry.metrics.snapshot();
  const second = telemetry.metrics.snapshot();
  telemetry.flushMetrics();
  const third = telemetry.metrics.snapshot();
  const queueFull = meta(first, TELEMETRY_META_METRICS.lost, "queue_full");
  assert(queueFull > 0);
  assertEquals(
    meta(second, TELEMETRY_META_METRICS.lost, "queue_full"),
    queueFull,
  );
  // The flush offered one more record into a full queue, which is one more loss.
  lostMatchesStats(third, telemetry.stats(), "after a flush");
  await telemetry.close(20);
});

Deno.test("the metrics record that is sent carries the losses counted when it was taken", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: TelemetryRecord[] = [];
  const telemetry = createTelemetry({
    send: async (batch) => {
      await gate;
      sent.push(...batch);
    },
    exporter: {
      ...baseExporter,
      capacity: 2,
      batchSize: 2,
      sendTimeoutMs: 60_000,
    },
    redact,
    events: ["job.completed"],
  });
  // Two queue, eight are dropped for room.
  for (let index = 0; index < 10; index += 1) {
    telemetry.event("job.completed", {});
  }
  assertEquals(telemetry.stats().dropped.queueFull, 8);
  // The held send takes the queued pair, which makes room for the record.
  await until(() => telemetry.stats().inFlight === 2, "a batch in flight");
  telemetry.flushMetrics();
  assertEquals(telemetry.stats().queued, 1, "the metrics record was accepted");
  release();
  await telemetry.close(500);
  const record = sent.find((r) => r.kind === "metrics");
  assert(record && record.kind === "metrics", "a metrics record was sent");
  assertEquals(
    meta(record.samples, TELEMETRY_META_METRICS.lost, "queue_full"),
    8,
    "the record carries the eight losses counted before it was taken",
  );
});

Deno.test("losses are exact under a seeded random mix of events, reads, flushes and a close", async () => {
  let seed = 90210;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let round = 0; round < 40; round += 1) {
    const { telemetry } = make({
      send: random() < 0.5
        ? () => new Promise(() => {})
        : () => Promise.reject(new Error("down")),
      exporter: {
        ...baseExporter,
        capacity: 1 + Math.floor(random() * 6),
        batchSize: 1,
        sendTimeoutMs: random() < 0.5 ? 60_000 : 5,
      },
    });
    let last = { queue_full: 0, send_failed: 0, shutdown: 0 };
    const read = (what: string) => {
      const samples = telemetry.metrics.snapshot();
      lostMatchesStats(samples, telemetry.stats(), `round ${round} ${what}`);
      const now = {
        queue_full: meta(samples, TELEMETRY_META_METRICS.lost, "queue_full"),
        send_failed: meta(samples, TELEMETRY_META_METRICS.lost, "send_failed"),
        shutdown: meta(samples, TELEMETRY_META_METRICS.lost, "shutdown"),
      };
      for (const reason of Object.keys(now) as Array<keyof typeof now>) {
        assert(now[reason] >= last[reason], `${reason} went down`);
      }
      last = now;
    };
    const steps = 20 + Math.floor(random() * 30);
    for (let step = 0; step < steps; step += 1) {
      const pick = random();
      if (pick < 0.6) telemetry.event("job.completed", {});
      else if (pick < 0.75) read("a read");
      else if (pick < 0.9) telemetry.flushMetrics();
      else await pause(1);
    }
    read("before close");
    await telemetry.close(10);
    read("after close");
    telemetry.event("job.completed", {});
    read("an event after close");
  }
});

Deno.test("dropping events and reading the metrics schedules no timer: the facade has no loss reporter", async () => {
  const live = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const id: unknown = realSet(() => {
      live.delete(id);
      handler();
    }, ms);
    live.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    live.delete(id);
    realClear(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  try {
    const { telemetry } = make({
      send: () => new Promise(() => {}),
      exporter: {
        ...baseExporter,
        capacity: 1,
        batchSize: 1,
        sendTimeoutMs: 60_000,
      },
    });
    telemetry.event("job.completed", {});
    telemetry.event("job.completed", {});
    await until(() => telemetry.stats().inFlight === 1, "an item in flight");
    const before = live.size;
    for (let index = 0; index < 1000; index += 1) {
      telemetry.event("job.completed", {});
    }
    telemetry.metrics.snapshot();
    telemetry.flushMetrics();
    assert(telemetry.stats().dropped.queueFull >= 1000);
    assertEquals(
      live.size,
      before,
      "a loss that is only counted needs no timer; a reporter would add one",
    );
    await telemetry.close(20);
    assertEquals(live.size, 0, "and nothing is left behind by close");
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const id of live) realClear(id as ReturnType<typeof setTimeout>);
  }
});
