import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type BoundedExporterOptions,
  createBoundedExporter,
  type ExportLoss,
  MAX_STUCK_SENDS,
} from "../../packages/config/src/telemetry-export.ts";

/** Seeded xorshift32, so a schedule is the same on every run. */
function seeded(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

// AC1: given a disabled or slow exporter, when jobs execute, then lease
// renewal, completion and usage settlement continue and queues remain bounded.
// The exporter is the only thing telemetry hands work to, so these cases pin
// what it may never do: block its caller, grow without bound, lose count of an
// item, or outlive its shutdown deadline.

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

const base = {
  capacity: 10,
  batchSize: 5,
  sendTimeoutMs: 200,
  maxAttempts: 2,
  retryDelayMs: 2,
  intervalMs: 5,
} as const;

function make<T>(
  send: BoundedExporterOptions<T>["send"],
  overrides: Partial<BoundedExporterOptions<T>> = {},
) {
  return createBoundedExporter<T>({ ...base, send, ...overrides });
}

/** Every offered item is somewhere, exactly once. */
function conserved(stats: ReturnType<ReturnType<typeof make>["stats"]>) {
  const { offered, queued, inFlight, exported, discarded, dropped } = stats;
  assertEquals(
    offered,
    queued + inFlight + exported + discarded + dropped.queueFull +
      dropped.sendFailed + dropped.shutdown,
    JSON.stringify(stats),
  );
}

Deno.test("a disabled exporter keeps nothing and costs nothing", () => {
  const exporter = make<number>(undefined);
  const started = performance.now();
  for (let index = 0; index < 200_000; index += 1) {
    assertEquals(exporter.offer(index), false);
  }
  assert(performance.now() - started < 1000, "offers must be O(1)");
  const stats = exporter.stats();
  assertEquals(stats.disabled, true);
  assertEquals(stats.queued, 0);
  assertEquals(stats.discarded, 200_000);
  assertEquals(stats.dropped, { queueFull: 0, sendFailed: 0, shutdown: 0 });
  conserved(stats);
});

Deno.test("offering never runs the sink and never waits for it", async () => {
  let calls = 0;
  const exporter = make<number>(() => {
    calls += 1;
    return new Promise(() => {});
  });
  for (let index = 0; index < 50; index += 1) exporter.offer(index);
  // Not in this tick and not in the microtasks that follow it either.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(
    calls,
    0,
    "the sink must only ever run from the exporter's own timer",
  );
  await exporter.close(20);
});

Deno.test("a sink that never answers cannot make the queue or memory grow", async () => {
  const exporter = make<number>(() => new Promise(() => {}), {
    sendTimeoutMs: 60_000,
  });
  for (let index = 0; index < 1000; index += 1) exporter.offer(index);
  let stats = exporter.stats();
  assertEquals(stats.queued, base.capacity);
  assertEquals(stats.dropped.queueFull, 1000 - base.capacity);
  conserved(stats);
  await until(
    () => exporter.stats().inFlight === base.batchSize,
    "a batch in flight",
  );
  for (let index = 0; index < 1000; index += 1) exporter.offer(index);
  stats = exporter.stats();
  assert(stats.queued <= base.capacity, `queued ${stats.queued}`);
  assert(stats.inFlight <= base.batchSize, `in flight ${stats.inFlight}`);
  conserved(stats);
  await exporter.close(30);
  conserved(exporter.stats());
});

Deno.test("a sink that ignores its abort signal is cut off by the timeout and the next batch goes on", async () => {
  let call = 0;
  const received: number[][] = [];
  const exporter = make<number>((batch) => {
    call += 1;
    if (call <= 2) return new Promise(() => {});
    received.push([...batch]);
    return Promise.resolve();
  }, { sendTimeoutMs: 15, maxAttempts: 2, batchSize: 3, capacity: 9 });
  for (let index = 0; index < 6; index += 1) exporter.offer(index);
  await until(
    () => exporter.stats().exported === 3,
    "the second batch to export",
  );
  const stats = exporter.stats();
  assertEquals(stats.dropped.sendFailed, 3);
  assertEquals(stats.failedBatches, 1);
  assertEquals(received, [[3, 4, 5]]);
  conserved(stats);
  await exporter.close(50);
});

Deno.test("a batch is retried and then delivered once, not duplicated", async () => {
  let attempts = 0;
  const delivered: number[][] = [];
  const exporter = make<number>((batch) => {
    attempts += 1;
    if (attempts <= 2) return Promise.reject(new Error("collector down"));
    delivered.push([...batch]);
    return Promise.resolve();
  }, { maxAttempts: 3, retryDelayMs: 1 });
  for (const item of [1, 2, 3]) exporter.offer(item);
  await until(() => exporter.stats().exported === 3, "export");
  assertEquals(delivered, [[1, 2, 3]]);
  assertEquals(attempts, 3);
  assertEquals(exporter.stats().failedBatches, 0);
  conserved(exporter.stats());
  await exporter.close(20);
});

Deno.test("a sink that throws, rejects with nothing or throws a string is counted and never escapes", async () => {
  const behaviours = [
    () => {
      throw new Error("sync");
    },
    () => Promise.reject(undefined),
    () => {
      throw "a string";
    },
    () => Promise.reject({ not: "an error" }),
  ];
  let index = 0;
  const exporter = make<number>(
    () => behaviours[index++ % behaviours.length](),
    {
      maxAttempts: 1,
      batchSize: 1,
      capacity: 8,
    },
  );
  for (let item = 0; item < 4; item += 1) exporter.offer(item);
  await until(
    () => exporter.stats().failedBatches === 4,
    "four failed batches",
  );
  assertEquals(exporter.stats().dropped.sendFailed, 4);
  conserved(exporter.stats());
  await exporter.close(20);
});

Deno.test("sends never overlap", async () => {
  let running = 0;
  let peak = 0;
  const exporter = make<number>(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await pause(8);
    running -= 1;
  }, { batchSize: 2, capacity: 20, intervalMs: 1 });
  for (let item = 0; item < 20; item += 1) exporter.offer(item);
  await until(() => exporter.stats().exported === 20, "export of 20");
  assertEquals(peak, 1);
  await exporter.close(20);
});

Deno.test("closing while a send is in flight never starts a second send", async () => {
  let running = 0;
  let peak = 0;
  const exporter = make<number>(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await pause(25);
    running -= 1;
  }, { batchSize: 2, capacity: 20, intervalMs: 1 });
  for (let item = 0; item < 20; item += 1) exporter.offer(item);
  await until(() => exporter.stats().inFlight > 0, "a send in flight");
  await exporter.close(2000);
  assertEquals(peak, 1);
  assertEquals(exporter.stats().exported, 20);
});

Deno.test("closing during a retry backoff does not wait the backoff out", async () => {
  let tries = 0;
  const exporter = make<number>(() => {
    tries += 1;
    return Promise.reject(new Error("collector down"));
  }, { maxAttempts: 3, retryDelayMs: 60_000, sendTimeoutMs: 50 });
  exporter.offer(1);
  await until(() => tries === 1, "the first attempt");
  await pause(10);
  const started = performance.now();
  await exporter.close(5000);
  const elapsed = performance.now() - started;
  assert(elapsed < 1000, `close waited ${elapsed} ms for a 60 s backoff`);
  assertEquals(tries, 1, "a closing exporter makes no further attempt");
  const stats = exporter.stats();
  assertEquals(stats.dropped.sendFailed, 1);
  conserved(stats);
});

Deno.test("items leave in the order they arrived when nothing is dropped", async () => {
  const order: number[] = [];
  const exporter = make<number>((batch) => {
    order.push(...batch);
    return Promise.resolve();
  }, { capacity: 100, batchSize: 7 });
  for (let item = 0; item < 100; item += 1) exporter.offer(item);
  await until(() => exporter.stats().exported === 100, "export of 100");
  assertEquals(order, Array.from({ length: 100 }, (_, i) => i));
  await exporter.close(20);
});

Deno.test("a sink that never settles is called only a bounded number of times, so abandoned sends cannot pile up", async () => {
  let calls = 0;
  const exporter = make<number>(() => {
    calls += 1;
    return new Promise(() => {});
  }, {
    sendTimeoutMs: 8,
    maxAttempts: 1,
    batchSize: 1,
    capacity: 60,
    intervalMs: 1,
  });
  for (let item = 0; item < 60; item += 1) exporter.offer(item);
  await until(
    () => exporter.stats().queued === 0 && exporter.stats().inFlight === 0,
    "the queue to be shed",
  );
  // Each timed-out send leaves a promise the sink may never settle. Once this
  // many are outstanding the exporter stops calling it and sheds instead.
  assertEquals(calls, MAX_STUCK_SENDS);
  assertEquals(exporter.stats().dropped.sendFailed, 60);
  conserved(exporter.stats());
  // Offers that arrive while it is stuck are shed without another call.
  for (let item = 0; item < 20; item += 1) exporter.offer(item);
  await until(
    () => exporter.stats().queued === 0,
    "the later offers to be shed",
  );
  assertEquals(calls, MAX_STUCK_SENDS);
  await exporter.close(20);
});

Deno.test("a stuck send that finally settles lets the exporter send again", async () => {
  const release: Array<() => void> = [];
  let healthy = false;
  const delivered: number[] = [];
  const exporter = make<number>((batch) => {
    if (healthy) {
      delivered.push(...batch);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => release.push(resolve));
  }, {
    sendTimeoutMs: 8,
    maxAttempts: 1,
    batchSize: 1,
    capacity: 30,
    intervalMs: 1,
  });
  for (let item = 0; item < 10; item += 1) exporter.offer(item);
  await until(
    () => exporter.stats().queued === 0 && exporter.stats().inFlight === 0,
    "shedding",
  );
  assertEquals(release.length, MAX_STUCK_SENDS);
  healthy = true;
  for (const settle of release) settle();
  await pause(10);
  exporter.offer(99);
  await until(
    () => delivered.includes(99),
    "a send after the stuck ones settled",
  );
  conserved(exporter.stats());
  await exporter.close(20);
});

Deno.test("the caller's own timers keep running while the sink hangs", async () => {
  const exporter = make<number>(() => new Promise(() => {}), {
    sendTimeoutMs: 60_000,
  });
  for (let item = 0; item < 100; item += 1) exporter.offer(item);
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
  }, 2);
  await pause(120);
  clearInterval(heartbeat);
  // Lease renewal, completion and settlement are timers and promises like this.
  assert(ticks >= 15, `only ${ticks} ticks in 120 ms`);
  await exporter.close(20);
});

Deno.test("close returns by its deadline with a hung sink, aborts it and counts what was left", async () => {
  let seen: AbortSignal | undefined;
  const exporter = make<number>((_batch, signal) => {
    seen = signal;
    return new Promise(() => {});
  }, { sendTimeoutMs: 60_000 });
  for (let item = 0; item < 8; item += 1) exporter.offer(item);
  await until(() => exporter.stats().inFlight > 0, "a batch in flight");
  const started = performance.now();
  await exporter.close(60);
  const elapsed = performance.now() - started;
  assert(elapsed < 600, `close took ${elapsed} ms`);
  assertEquals(seen?.aborted, true, "the sink must be told to stop");
  const stats = exporter.stats();
  assertEquals(stats.closed, true);
  assertEquals(stats.queued + stats.inFlight, 0);
  assertEquals(stats.dropped.shutdown, 8);
  conserved(stats);
});

Deno.test("close flushes a healthy exporter completely before its deadline", async () => {
  const sent: number[] = [];
  const exporter = make<number>((batch) => {
    sent.push(...batch);
    return Promise.resolve();
  }, { capacity: 50, intervalMs: 1000 });
  for (let item = 0; item < 30; item += 1) exporter.offer(item);
  await exporter.close(500);
  assertEquals(sent.length, 30);
  const stats = exporter.stats();
  assertEquals(stats.exported, 30);
  assertEquals(stats.dropped, { queueFull: 0, sendFailed: 0, shutdown: 0 });
  conserved(stats);
});

Deno.test("an exporter that is closed refuses and counts further offers, and closing twice is harmless", async () => {
  const exporter = make<number>(() => Promise.resolve());
  await exporter.close(20);
  await exporter.close(20);
  assertEquals(exporter.offer(1), false);
  assertEquals(exporter.stats().dropped.shutdown, 1);
  conserved(exporter.stats());
});

Deno.test("every loss is reported with its reason, and a reporter that throws changes nothing", async () => {
  const losses: ExportLoss[] = [];
  const exporter = make<number>(() => Promise.reject(new Error("down")), {
    capacity: 2,
    batchSize: 2,
    maxAttempts: 1,
    onLoss: (loss) => {
      losses.push(loss);
      throw new Error("reporter failed");
    },
  });
  for (let item = 0; item < 5; item += 1) exporter.offer(item);
  await until(() => exporter.stats().failedBatches === 1, "a failed batch");
  assertEquals(
    losses.filter((l) => l.reason === "queue-full").reduce(
      (n, l) => n + l.count,
      0,
    ),
    3,
  );
  assertEquals(
    losses.filter((l) => l.reason === "send-failed").reduce(
      (n, l) => n + l.count,
      0,
    ),
    2,
  );
  conserved(exporter.stats());
  await exporter.close(20);
});

Deno.test("no timer is left running by an idle, a failed or a closed exporter", async () => {
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
    const idle = make<number>(() => Promise.resolve());
    await idle.close(20);
    assertEquals(live.size, 0, "idle then closed");

    const healthy = make<number>(() => Promise.resolve());
    healthy.offer(1);
    await until(() => healthy.stats().exported === 1, "export");
    assertEquals(live.size, 0, "nothing scheduled once the queue is empty");
    await healthy.close(20);
    assertEquals(live.size, 0, "healthy then closed");

    const failing = make<number>(() => Promise.reject(new Error("x")), {
      maxAttempts: 2,
    });
    failing.offer(1);
    await until(() => failing.stats().failedBatches === 1, "a failure");
    await failing.close(20);
    assertEquals(live.size, 0, "failed then closed");

    const pending = make<number>(() => Promise.resolve(), {
      intervalMs: 60_000,
    });
    pending.offer(1);
    assertEquals(live.size, 1, "one flush is scheduled while an item waits");
    await pending.close(500);
    assertEquals(live.size, 0, "closed with a flush still scheduled");

    let tried = 0;
    const backingOff = make<number>(() => {
      tried += 1;
      return Promise.reject(new Error("x"));
    }, { maxAttempts: 3, retryDelayMs: 60_000 });
    backingOff.offer(1);
    await until(() => tried === 1, "the first attempt");
    await pause(10);
    await backingOff.close(500);
    assertEquals(live.size, 0, "closed during a retry pause");

    const hung = make<number>(() => new Promise(() => {}), {
      sendTimeoutMs: 60_000,
    });
    hung.offer(1);
    await until(() => hung.stats().inFlight === 1, "in flight");
    await hung.close(20);
    assertEquals(live.size, 0, "hung then closed");
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const id of live) realClear(id as ReturnType<typeof setTimeout>);
  }
});

Deno.test("options that would make the queue unbounded or the exporter meaningless are refused", async () => {
  const ok = { ...base, send: () => Promise.resolve() };
  const bad: Array<Partial<BoundedExporterOptions<number>>> = [
    { capacity: 0 },
    { capacity: 1.5 },
    { capacity: 100_001 },
    { batchSize: 0 },
    { batchSize: base.capacity + 1 },
    { sendTimeoutMs: 0 },
    { maxAttempts: 0 },
    { maxAttempts: 11 },
    { retryDelayMs: -1 },
    { intervalMs: 0 },
    { capacity: Number.NaN },
    { sendTimeoutMs: Number.POSITIVE_INFINITY },
  ];
  for (const overrides of bad) {
    assertThrows(
      () => createBoundedExporter<number>({ ...ok, ...overrides }),
      RangeError,
      undefined,
      JSON.stringify(overrides),
    );
  }
  await createBoundedExporter<number>(ok).close(1);
});

Deno.test("under a seeded random schedule of outcomes every item is accounted for and the queue never exceeds its cap", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = seeded(seed);
    const exporter = make<number>(() => {
      switch (random() % 4) {
        case 0:
          return Promise.resolve();
        case 1:
          return Promise.reject(new Error("down"));
        case 2:
          return new Promise(() => {});
        default:
          return pause(1 + (random() % 6));
      }
    }, {
      capacity: 12,
      batchSize: 4,
      sendTimeoutMs: 8,
      maxAttempts: 2,
      retryDelayMs: 1,
      intervalMs: 1,
    });
    for (let round = 0; round < 40; round += 1) {
      const burst = random() % 15;
      for (let item = 0; item < burst; item += 1) {
        exporter.offer(round * 100 + item);
      }
      const stats = exporter.stats();
      assert(stats.queued <= 12, `seed ${seed}: queued ${stats.queued}`);
      assert(stats.inFlight <= 4, `seed ${seed}: in flight ${stats.inFlight}`);
      conserved(stats);
      await pause(random() % 4);
    }
    await exporter.close(150);
    const stats = exporter.stats();
    assertEquals(stats.queued + stats.inFlight, 0, `seed ${seed}`);
    conserved(stats);
  }
});
