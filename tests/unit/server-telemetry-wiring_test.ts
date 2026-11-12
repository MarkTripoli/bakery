import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createServerTelemetry,
  SERVER_TELEMETRY_CLOSE_MS,
  SERVER_TELEMETRY_EXPORTER,
} from "../../apps/server/src/platform/telemetry.ts";
import {
  emitExecutionEvent,
  EXECUTION_TELEMETRY_EVENTS,
  JOB_OUTCOMES,
} from "../../apps/server/src/modules/execution/telemetry.ts";
import { TELEMETRY_META_METRICS } from "../../packages/config/src/telemetry.ts";
import {
  MAX_EXPORT_CAPACITY,
} from "../../packages/config/src/telemetry-export.ts";
import type { TelemetryRecord } from "../../packages/config/src/telemetry.ts";
import type { MetricSample } from "../../packages/config/src/telemetry-metrics.ts";

// The execution routes tell telemetry about lease renewals, completions and
// usage settlements. The server's telemetry decides what survives (a closed
// vocabulary of events and outcomes, ids only), how much can wait for a sink
// (a fixed bound) and what happens with no sink at all (nothing, at the cost of
// a counter). The helper the routes call must never be able to affect them.

const attempt = "0b9a1f0e-5a3c-4c1e-8f6a-2d4b7c9e1a30";
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

const counter = (
  samples: readonly MetricSample[],
  name: string,
  label: string,
) =>
  samples.find((s) =>
    s.name === name && Object.values(s.labels).includes(label)
  )
    ?.value ?? 0;

function recording() {
  const sent: TelemetryRecord[] = [];
  const telemetry = createServerTelemetry({
    send: (batch) => {
      sent.push(...batch);
    },
  });
  return { telemetry, sent };
}

Deno.test("with no sink an event costs a counter and nothing is queued", async () => {
  const telemetry = createServerTelemetry();
  for (let index = 0; index < 5; index += 1) {
    telemetry.event(EXECUTION_TELEMETRY_EVENTS.leaseRenewed, {
      "bakery.attempt.id": attempt,
    });
  }
  telemetry.flushMetrics();
  const stats = telemetry.stats();
  assertEquals(stats.disabled, true);
  assertEquals(stats.queued, 0);
  assertEquals(stats.inFlight, 0);
  assertEquals(
    counter(
      telemetry.metrics.snapshot(),
      TELEMETRY_META_METRICS.events,
      "discarded",
    ),
    5,
  );
  await telemetry.close(SERVER_TELEMETRY_CLOSE_MS);
});

Deno.test("every event the routes emit is in the server's allowlist, and every outcome they carry survives it", async () => {
  const { telemetry, sent } = recording();
  telemetry.event(EXECUTION_TELEMETRY_EVENTS.leaseRenewed, {
    "bakery.attempt.id": attempt,
  });
  telemetry.event(EXECUTION_TELEMETRY_EVENTS.usageSettled, {
    "bakery.attempt.id": attempt,
  });
  for (const outcome of JOB_OUTCOMES) {
    telemetry.event(EXECUTION_TELEMETRY_EVENTS.jobCompleted, {
      "bakery.attempt.id": attempt,
      "bakery.outcome": outcome,
    });
  }
  await telemetry.close(500);
  const events = sent.filter((r) => r.kind === "event");
  assertEquals(events.length, 2 + JOB_OUTCOMES.length);
  assertEquals(
    counter(
      telemetry.metrics.snapshot(),
      TELEMETRY_META_METRICS.events,
      "unknown_event",
    ),
    0,
    "no event the routes emit is outside the allowlist",
  );
  const completed = events.filter((e) =>
    e.kind === "event" && e.name === "job.completed"
  );
  assertEquals(
    completed.map((e) =>
      e.kind === "event" ? e.attributes["bakery.outcome"] : null
    ).sort(),
    [...JOB_OUTCOMES].sort(),
  );
  for (const event of events) {
    assert(
      event.kind === "event" &&
        event.attributes["bakery.attempt.id"] === attempt,
    );
  }
});

Deno.test("what is not an id or a listed outcome never leaves: a token, a payload, a made-up outcome and an unlisted event", async () => {
  const { telemetry, sent } = recording();
  const token = "lease-token-abcdef0123456789abcdef0123456789";
  telemetry.event(EXECUTION_TELEMETRY_EVENTS.jobCompleted, {
    "bakery.attempt.id": attempt,
    "bakery.outcome": token, // a secret in a field that expects a word
    leaseToken: token,
    prompt: "summarize the contract",
    result: { text: "secret output" },
    "bakery.job.id": "not-a-uuid",
  });
  telemetry.event("lease.stolen", { "bakery.attempt.id": attempt });
  await telemetry.close(500);
  const text = JSON.stringify(sent);
  for (
    const forbidden of [
      token,
      "summarize",
      "secret output",
      "not-a-uuid",
      "lease.stolen",
    ]
  ) {
    assert(!text.includes(forbidden), `${forbidden} reached the sink`);
  }
  const record = sent.find((r) => r.kind === "event");
  assert(record && record.kind === "event");
  assertEquals(record.attributes, { "bakery.attempt.id": attempt });
  const samples = telemetry.metrics.snapshot();
  assertEquals(
    counter(samples, TELEMETRY_META_METRICS.events, "unknown_event"),
    1,
  );
  assert(
    counter(samples, TELEMETRY_META_METRICS.redacted, "unregistered") >= 3,
  );
  assert(counter(samples, TELEMETRY_META_METRICS.redacted, "invalid") >= 2);
});

Deno.test("the server's exporter bounds are sane and fit the exporter's own limits", () => {
  const {
    capacity,
    batchSize,
    sendTimeoutMs,
    maxAttempts,
    retryDelayMs,
    intervalMs,
  } = SERVER_TELEMETRY_EXPORTER;
  assert(capacity >= 1 && capacity <= MAX_EXPORT_CAPACITY);
  assert(batchSize >= 1 && batchSize <= capacity);
  assert(
    batchSize >= 10,
    "a batch of 1 would cap export at a few hundred a second",
  );
  assert(
    sendTimeoutMs >= 1 && maxAttempts >= 1 && retryDelayMs >= 0 &&
      intervalMs >= 1,
  );
  assert(Object.isFrozen(SERVER_TELEMETRY_EXPORTER));
  assert(
    SERVER_TELEMETRY_CLOSE_MS > 0 && SERVER_TELEMETRY_CLOSE_MS < 5_000,
    "inside the 5 s shutdown",
  );
});

Deno.test("a sink that never answers holds at most the capacity, drops the rest and counts it, and shutdown still ends", async () => {
  const telemetry = createServerTelemetry({
    send: () => new Promise(() => {}),
  });
  const started = performance.now();
  for (let index = 0; index < 10_000; index += 1) {
    telemetry.event(EXECUTION_TELEMETRY_EVENTS.leaseRenewed, {
      "bakery.attempt.id": attempt,
    });
  }
  const elapsed = performance.now() - started;
  assert(elapsed < 1500, `10,000 events took ${elapsed} ms`);
  await until(() => telemetry.stats().inFlight > 0, "a batch in flight");
  const stats = telemetry.stats();
  assert(stats.queued <= SERVER_TELEMETRY_EXPORTER.capacity);
  assert(stats.inFlight <= SERVER_TELEMETRY_EXPORTER.batchSize);
  assert(
    stats.dropped.queueFull > 8_000,
    `only ${stats.dropped.queueFull} dropped`,
  );
  assertEquals(
    counter(
      telemetry.metrics.snapshot(),
      TELEMETRY_META_METRICS.lost,
      "queue_full",
    ),
    stats.dropped.queueFull,
    "the drops are visible as a metric",
  );
  const closing = performance.now();
  await telemetry.close(SERVER_TELEMETRY_CLOSE_MS);
  assert(
    performance.now() - closing < SERVER_TELEMETRY_CLOSE_MS + 1000,
    "close returned within its deadline although the sink never answered",
  );
});

Deno.test("emitExecutionEvent does nothing without telemetry and hands over the name and attributes with it", () => {
  emitExecutionEvent(undefined, "job.completed", {
    "bakery.attempt.id": attempt,
  });
  const seen: unknown[][] = [];
  emitExecutionEvent(
    { event: (...args) => void seen.push(args) },
    "lease.renewed",
    { "bakery.attempt.id": attempt },
  );
  assertEquals(seen, [["lease.renewed", { "bakery.attempt.id": attempt }]]);
});

Deno.test("emitExecutionEvent never throws, whatever the telemetry does", () => {
  for (
    const telemetry of [
      {
        event: () => {
          throw new Error("sync boom");
        },
      },
      {
        event: () => {
          throw "a string";
        },
      },
      {
        event: () => {
          throw undefined;
        },
      },
      {
        event: () =>
          ({
            then: () => {
              throw new Error("then boom");
            },
          }) as never,
      },
      {
        get event(): never {
          throw new Error("getter boom");
        },
      },
    ]
  ) {
    emitExecutionEvent(telemetry as never, "job.completed", {});
  }
});

Deno.test("emitExecutionEvent handles a promise the telemetry returns, so a rejection is not left unhandled", async () => {
  const seen: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    seen.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    emitExecutionEvent(
      { event: () => Promise.reject(new Error("async boom")) as never },
      "job.completed",
      {},
    );
    emitExecutionEvent(
      {
        event: (async () => {
          await null; // a real async function: it rejects after it has awaited
          throw new Error("async fn boom");
        }) as never,
      },
      "job.completed",
      {},
    );
    emitExecutionEvent(
      {
        event: () =>
          ({
            then: (_: unknown, reject: (e: unknown) => void) =>
              reject(new Error("thenable")),
          }) as never,
      },
      "job.completed",
      {},
    );
    await pause(50);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
  assertEquals(seen, []);
});

Deno.test("emitExecutionEvent never calls a foreign then, so no hostile promise shape leaves a rejection unhandled", async () => {
  const seen: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    seen.push(event.reason);
    event.preventDefault();
  };
  // Every `then` below, if called, returns a promise that rejects and that
  // nobody holds: the shapes a handler attached by calling `then` cannot cover.
  const thenCalls: string[] = [];
  class HostilePromise<T> extends Promise<T> {
    override then<A = T, B = never>(): Promise<A | B> {
      thenCalls.push("subclass then");
      return Promise.reject(new Error("subclass then rejects"));
    }
  }
  const ownThen = Promise.reject(new Error("rejected, with its own then"));
  Object.defineProperty(ownThen, "then", {
    value: () => {
      thenCalls.push("own-property then");
      return Promise.reject(new Error("own-property then rejects"));
    },
  });
  const ports: Record<string, unknown> = {
    "a thenable whose then returns a rejected promise": {
      then: () => {
        thenCalls.push("thenable then");
        return Promise.reject(new Error("thenable then rejects"));
      },
    },
    "a thenable whose then is an async function that throws": {
      then: async () => {
        thenCalls.push("async then");
        await null;
        throw new Error("async then throws");
      },
    },
    "a rejected Promise subclass whose then returns a rejected promise":
      HostilePromise
        .reject(new Error("rejected subclass")),
    "a rejected Promise with its own then property": ownThen,
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    for (const [shape, returned] of Object.entries(ports)) {
      emitExecutionEvent(
        { event: () => returned as never },
        "job.completed",
        {},
      );
      assertEquals(thenCalls, [], `${shape}: its then was called`);
    }
    await pause(50);
    assertEquals(seen, [], "a hostile shape left a rejection unhandled");
    // The control: with no handler, this runtime does report the rejection, so
    // the empty list above means something.
    void Promise.reject(new Error("control"));
    await pause(50);
    assertEquals(
      seen.length,
      1,
      "the detector did not see an unhandled rejection",
    );
  } finally {
    // Whatever a failing run left pending is reported to this listener, not to
    // the runner, so the assertion that failed is the one that is shown.
    await pause(50);
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
});

Deno.test("the event names and outcome words are part of what sinks key on, so they are pinned as literals", () => {
  assertEquals({ ...EXECUTION_TELEMETRY_EVENTS }, {
    leaseRenewed: "lease.renewed",
    jobCompleted: "job.completed",
    usageSettled: "usage.settled",
  });
  assertEquals([...JOB_OUTCOMES], ["completed", "failed", "canceled"]);
  // And they cannot be changed afterwards by anything that imports them.
  assert(Object.isFrozen(JOB_OUTCOMES));
  assert(Object.isFrozen(EXECUTION_TELEMETRY_EVENTS));
  assertThrows(
    () => (JOB_OUTCOMES as unknown as string[]).push("lost"),
    TypeError,
  );
  assertThrows(
    () => {
      (EXECUTION_TELEMETRY_EVENTS as Record<string, string>).leaseRenewed = "x";
    },
    TypeError,
  );
});
