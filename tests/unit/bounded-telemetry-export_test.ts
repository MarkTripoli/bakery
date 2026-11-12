import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type BoundedExporterOptions,
  createBoundedExporter,
  type ExportLoss,
  MAX_STUCK_SENDS,
  MAX_TIMER_MS,
  MIN_LOSS_REPORT_GAP_MS,
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
      dropped.sendFailed + dropped.shutdown + dropped.reentrant,
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
  assertEquals(stats.dropped, {
    queueFull: 0,
    sendFailed: 0,
    shutdown: 0,
    reentrant: 0,
  });
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
  assertEquals(stats.dropped, {
    queueFull: 0,
    sendFailed: 0,
    shutdown: 0,
    reentrant: 0,
  });
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
  // Reports are delivered a tick after the loss, one per reason.
  await until(
    () => losses.reduce((n, l) => n + l.count, 0) === 5,
    "all five losses to be reported",
  );
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

    // A loss is noted and its report scheduled; closing must deliver it and
    // leave no timer behind, however soon after the drop it is called.
    const reporting = make<number>(() => Promise.reject(new Error("x")), {
      capacity: 1,
      batchSize: 1,
      maxAttempts: 1,
      onLoss: () => {},
    });
    reporting.offer(1);
    reporting.offer(2);
    await reporting.close(100);
    assertEquals(live.size, 0, "closed with a loss report pending");

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

// ---- QA round 1 on #120 ----------------------------------------------------
// The sink is handed the batch it is told to read. Whatever it does to that
// array, the accounting identity holds and a retry carries the same items.

type Mutation = [name: string, mutate: (batch: number[]) => void];
const mutations: Mutation[] = [
  ["splice(0, 2)", (batch) => void batch.splice(0, 2)],
  ["splice(0)", (batch) => void batch.splice(0)],
  ["pop()", (batch) => void batch.pop()],
  ["length = 0", (batch) => void (batch.length = 0)],
  ["push(99)", (batch) => void batch.push(99)],
  ["shift() until empty (a draining sink)", (batch) => {
    while (batch.length > 0) batch.shift();
  }],
  ["reverse()", (batch) => void batch.reverse()],
];

for (const [name, mutate] of mutations) {
  Deno.test(`a sink that does ${name} to its batch and then succeeds is counted for every item it was given`, async () => {
    const exporter = make<number>((batch) => {
      mutate(batch as number[]);
    }, { capacity: 20, batchSize: 6 });
    for (let item = 1; item <= 6; item += 1) exporter.offer(item);
    await until(() => exporter.stats().exported === 6, "export of 6");
    const stats = exporter.stats();
    assertEquals(stats.exported, 6);
    assertEquals(stats.offered, 6);
    assertEquals(stats.dropped.sendFailed, 0);
    conserved(stats);
    await exporter.close(50);
  });

  Deno.test(`a sink that does ${name} and then fails is retried with every item, not what it left`, async () => {
    const seen: number[][] = [];
    let attempts = 0;
    const exporter = make<number>((batch) => {
      attempts += 1;
      seen.push([...batch]);
      mutate(batch as number[]);
      if (attempts === 1) throw new Error("collector down");
    }, { capacity: 20, batchSize: 4, maxAttempts: 2, retryDelayMs: 1 });
    for (let item = 1; item <= 4; item += 1) exporter.offer(item);
    await until(() => exporter.stats().exported === 4, "export of 4");
    assertEquals(seen, [[1, 2, 3, 4], [1, 2, 3, 4]]);
    assertEquals(exporter.stats().dropped.sendFailed, 0);
    conserved(exporter.stats());
    await exporter.close(50);
  });
}

Deno.test("a sink that edits its batch and then never answers is dropped for the size it was given", async () => {
  const exporter = make<number>((batch) => {
    (batch as number[]).splice(0);
    return new Promise(() => {});
  }, { capacity: 20, batchSize: 5, sendTimeoutMs: 15, maxAttempts: 1 });
  for (let item = 1; item <= 5; item += 1) exporter.offer(item);
  await until(() => exporter.stats().failedBatches === 1, "a failed batch");
  assertEquals(exporter.stats().dropped.sendFailed, 5);
  conserved(exporter.stats());
  await exporter.close(50);
});

Deno.test("a sink that edits its batch and is then abandoned at close is counted for the size it was given", async () => {
  const exporter = make<number>((batch) => {
    (batch as number[]).length = 0;
    return new Promise(() => {});
  }, { capacity: 20, batchSize: 5, sendTimeoutMs: 60_000 });
  for (let item = 1; item <= 5; item += 1) exporter.offer(item);
  await until(() => exporter.stats().inFlight === 5, "a batch in flight");
  await exporter.close(30);
  const stats = exporter.stats();
  assertEquals(stats.dropped.shutdown, 5);
  assertEquals(stats.exported, 0);
  conserved(stats);
});

Deno.test("what the sink is handed is not what the exporter keeps: each attempt gets its own array", async () => {
  const handed: Array<readonly number[]> = [];
  const exporter = make<number>((batch) => {
    handed.push(batch);
  }, { capacity: 20, batchSize: 3 });
  for (let item = 1; item <= 6; item += 1) exporter.offer(item);
  await until(() => exporter.stats().exported === 6, "export of 6");
  assertEquals(new Set(handed).size, handed.length, "no array is handed twice");
  // Keeping a reference past the call and editing it later changes nothing.
  for (const batch of handed) (batch as number[]).push(-1);
  assertEquals(exporter.stats().exported, 6);
  conserved(exporter.stats());
  await exporter.close(50);
});

// ---- timers ----------------------------------------------------------------

Deno.test("a timer value past what a timer can hold is refused instead of firing at once", () => {
  const ok = { ...base, send: () => Promise.resolve() };
  for (
    const overrides of [
      { sendTimeoutMs: MAX_TIMER_MS + 1 },
      { sendTimeoutMs: 3e9 },
      { intervalMs: MAX_TIMER_MS + 1 },
      { intervalMs: 3e9 },
      { retryDelayMs: MAX_TIMER_MS + 1 },
      { retryDelayMs: 3e9 },
    ]
  ) {
    let error: unknown;
    try {
      createBoundedExporter<number>({ ...ok, ...overrides });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof RangeError, JSON.stringify(overrides));
  }
  // The largest value a timer holds is allowed.
  createBoundedExporter<number>({
    ...ok,
    sendTimeoutMs: MAX_TIMER_MS,
    intervalMs: MAX_TIMER_MS,
    retryDelayMs: MAX_TIMER_MS,
  }).close(1);
});

Deno.test("close clamps its deadline: a huge one waits, and a missing or negative one abandons at once", async () => {
  for (const huge of [3e9, MAX_TIMER_MS + 1, Number.POSITIVE_INFINITY]) {
    const sent: number[] = [];
    const exporter = make<number>(async (batch) => {
      await pause(40);
      sent.push(...batch);
    }, { capacity: 20, batchSize: 5, intervalMs: 1000 });
    for (let item = 1; item <= 10; item += 1) exporter.offer(item);
    await exporter.close(huge);
    assertEquals(sent.length, 10, `close(${huge}) abandoned a healthy queue`);
    assertEquals(exporter.stats().dropped.shutdown, 0);
    conserved(exporter.stats());
  }
  for (const none of [Number.NaN, -5, 0, "soon" as unknown as number]) {
    const exporter = make<number>(() => new Promise(() => {}), {
      sendTimeoutMs: 60_000,
    });
    for (let item = 1; item <= 8; item += 1) exporter.offer(item);
    await until(() => exporter.stats().inFlight > 0, "a batch in flight");
    const started = performance.now();
    await exporter.close(none);
    assert(performance.now() - started < 500, `close(${none}) did not return`);
    const stats = exporter.stats();
    assertEquals(stats.dropped.shutdown, 8, `close(${none})`);
    conserved(stats);
  }
});

// ---- the loss reporter ------------------------------------------------------

Deno.test("a loss reporter that offers more is stopped: those offers are refused and counted, not recursed into", async () => {
  let reports = 0;
  const exporter: ReturnType<typeof make<number>> = make<number>(
    () => Promise.reject(new Error("down")),
    {
      capacity: 1,
      batchSize: 1,
      maxAttempts: 1,
      onLoss: () => {
        reports += 1;
        for (let index = 0; index < 5; index += 1) exporter.offer(-1);
      },
    },
  );
  for (let item = 0; item < 3; item += 1) exporter.offer(item);
  await until(() => exporter.stats().failedBatches >= 1, "a failed batch");
  await exporter.close(100);
  const stats = exporter.stats();
  assert(
    stats.offered < 100,
    `offered ${stats.offered}: the reporter recursed`,
  );
  assert(reports < 20, `${reports} reports`);
  assert(stats.dropped.reentrant >= 5, "the reporter's own offers are counted");
  conserved(stats);
});

Deno.test("a slow loss reporter does not slow the offers that cause the reports", async () => {
  let reports = 0;
  let reported = 0;
  const exporter = make<number>(() => new Promise(() => {}), {
    capacity: 1,
    batchSize: 1,
    sendTimeoutMs: 60_000,
    onLoss: ({ count }) => {
      reports += 1;
      reported += count;
      const until = performance.now() + 15;
      while (performance.now() < until) { /* a reporter that blocks */ }
    },
  });
  exporter.offer(0);
  const started = performance.now();
  for (let item = 1; item <= 200; item += 1) exporter.offer(item);
  const elapsed = performance.now() - started;
  assert(elapsed < 100, `200 dropped offers took ${elapsed} ms`);
  assertEquals(reports, 0, "no report runs inside an offer");
  await until(() => reported >= 199, "the reports");
  assert(reports <= 5, `${reports} reports for 199 losses: they must coalesce`);
  assertEquals(reported, exporter.stats().dropped.queueFull);
  await exporter.close(50);
});

Deno.test("reports are totals per reason and nothing is lost between them", async () => {
  const totals: Record<string, number> = {};
  const exporter = make<number>(() => Promise.reject(new Error("down")), {
    capacity: 3,
    batchSize: 3,
    maxAttempts: 1,
    onLoss: ({ reason, count }) => {
      totals[reason] = (totals[reason] ?? 0) + count;
    },
  });
  for (let item = 0; item < 10; item += 1) exporter.offer(item);
  await until(() => exporter.stats().failedBatches >= 1, "a failed batch");
  await exporter.close(100);
  const stats = exporter.stats();
  assertEquals(totals["queue-full"], stats.dropped.queueFull);
  assertEquals(totals["send-failed"], stats.dropped.sendFailed);
  assertEquals(totals["shutdown"] ?? 0, stats.dropped.shutdown);
  conserved(stats);
  // What a closed exporter refuses is still counted, and no longer reported.
  const before = { ...totals };
  exporter.offer(99);
  await pause(2 * MIN_LOSS_REPORT_GAP_MS);
  const after = exporter.stats();
  assertEquals(after.dropped.shutdown, stats.dropped.shutdown + 1);
  assertEquals(totals, before, "a closed exporter reports nothing more");
  conserved(after);
});

Deno.test("close delivers any report still pending before it returns", async () => {
  let reported = 0;
  const exporter = make<number>(() => new Promise(() => {}), {
    capacity: 1,
    batchSize: 1,
    sendTimeoutMs: 60_000,
    onLoss: ({ count }) => {
      reported += count;
    },
  });
  for (let item = 0; item < 6; item += 1) exporter.offer(item);
  await exporter.close(20);
  // Five were dropped for room and one was in flight at close; none is missing.
  assertEquals(reported, exporter.stats().offered);
  assertEquals(reported, 6);
});

// ---- review round 2 ---------------------------------------------------------
// `onLoss` is typed to return nothing, which an async function satisfies. Its
// rejection is nobody's to handle but ours: unhandled, it ends a Node 24
// process, and the exporter exists so that telemetry can never do that to the
// code it observes.

/** Runs `work` and returns every rejection nobody handled while it ran. */
async function unhandledDuring(work: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    seen.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onUnhandled);
  try {
    await work();
    // Unhandled rejections are reported after the microtask queue drains.
    await pause(50);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
  }
  return seen;
}

const reporters: Array<[string, () => unknown]> = [
  [
    "an async reporter that throws",
    () => Promise.reject(new Error("async boom")),
  ],
  [
    "an async reporter that rejects with nothing",
    () => Promise.reject(undefined),
  ],
  ["a thenable that rejects", () => ({
    then: (_: unknown, reject: (reason: unknown) => void) =>
      reject(new Error("thenable boom")),
  })],
  ["a thenable whose then throws", () => ({
    then: () => {
      throw new Error("then boom");
    },
  })],
  ["a thenable whose then getter throws", () => ({
    get then(): never {
      throw new Error("getter boom");
    },
  })],
  ["a reporter that returns a revoked proxy", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    return revoked.proxy;
  }],
  ["a reporter that returns a promise that resolves", () => Promise.resolve()],
  ["a thenable whose then returns a rejecting promise", () => ({
    then: () => Promise.reject(new Error("returned from then")),
  })],
  ["a class with an async then that throws", () =>
    new (class {
      // deno-lint-ignore require-await
      async then() {
        throw new Error("async then");
      }
    })()],
  ["a promise subclass whose then returns a rejecting promise", () => {
    class Evil extends Promise<void> {
      override then(): never {
        return Promise.reject(new Error("subclass then")) as never;
      }
    }
    return new Evil(() => {});
  }],
  ["a thenable chain three deep that ends in a rejection", () => {
    const link = (depth: number): unknown => ({
      then: () =>
        depth > 0 ? link(depth - 1) : Promise.reject(new Error("deep")),
    });
    return link(3);
  }],
  ["a thenable whose then hands back itself", () => {
    const self: { then: () => unknown } = { then: () => self };
    return self;
  }],
];

for (const [name, report] of reporters) {
  Deno.test(`a loss reporter that is ${name} neither throws nor leaves an unhandled rejection`, async () => {
    let reports = 0;
    const unhandled = await unhandledDuring(async () => {
      const exporter = make<number>(() => Promise.reject(new Error("down")), {
        capacity: 1,
        batchSize: 1,
        maxAttempts: 1,
        onLoss: () => {
          reports += 1;
          return report() as void;
        },
      });
      for (let item = 0; item < 4; item += 1) exporter.offer(item);
      await until(() => exporter.stats().failedBatches >= 1, "a failed batch");
      await exporter.close(100);
      conserved(exporter.stats());
    });
    assert(reports >= 1, "the reporter was never called");
    assertEquals(unhandled, []);
  });
}

// ---- QA round 3 -------------------------------------------------------------
// A reporter that awaits and then offers escaped the old flag, which was only
// true while the reporter's synchronous part ran. Each offer it made into a full
// queue was a new loss, which scheduled a new report, so it called itself 400 to
// 700 times a second and kept going after close. Offers are now attributed by
// async context, which follows whatever the reporter starts.

/** A full queue behind a send that never answers: item 0 in flight, 1 queued. */
async function fullQueue(onLoss: (loss: ExportLoss) => unknown) {
  const exporter = make<number>(() => new Promise(() => {}), {
    capacity: 1,
    batchSize: 1,
    sendTimeoutMs: 60_000,
    maxAttempts: 1,
    onLoss: onLoss as BoundedExporterOptions<number>["onLoss"],
  });
  exporter.offer(0);
  await until(() => exporter.stats().inFlight === 1, "an item in flight");
  exporter.offer(1);
  exporter.offer(2);
  exporter.offer(3);
  return exporter;
}

const feeders: Array<
  [name: string, offers: number, start: (offer: () => void) => unknown]
> = [
  ["after an await", 1, async (offer) => {
    await null;
    offer();
  }],
  ["after several awaits", 3, async (offer) => {
    for (let index = 0; index < 3; index += 1) {
      await null;
      offer();
    }
  }],
  ["after a sleep", 1, async (offer) => {
    await pause(20);
    offer();
  }],
  // The reporter returns nothing: no promise to wait for, yet the work it
  // started is still its own.
  ["from a timer it started", 1, (offer) => {
    setTimeout(offer, 1);
  }],
  ["from a microtask it started", 1, (offer) => {
    queueMicrotask(offer);
  }],
  ["from a then it started", 1, (offer) => {
    Promise.resolve().then(offer);
  }],
  ["from inside a thenable it returned", 1, (offer) => ({
    then(done: () => void) {
      setTimeout(() => {
        offer();
        done();
      }, 1);
    },
  })],
];

for (const [name, offers, start] of feeders) {
  Deno.test(`a loss reporter that offers ${name} is not reported to again, now or after close`, async () => {
    let reports = 0;
    const exporter: Awaited<ReturnType<typeof fullQueue>> = await fullQueue(
      () => {
        reports += 1;
        return start(() => {
          exporter.offer(-1);
        });
      },
    );
    await until(
      () => exporter.stats().dropped.reentrant >= offers,
      "the reporter's own offers",
    );
    // Long enough for a loop to show: it called itself every MIN_LOSS_REPORT_GAP_MS.
    await pause(4 * MIN_LOSS_REPORT_GAP_MS);
    assertEquals(
      reports,
      1,
      "one loss, one report: the reporter fed nothing back",
    );
    const live = exporter.stats();
    assertEquals(live.dropped.reentrant, offers);
    assertEquals(live.dropped.queueFull, 2, "only the two real drops");
    conserved(live);

    await exporter.close(20);
    const reportsAtClose = reports;
    await pause(4 * MIN_LOSS_REPORT_GAP_MS);
    assertEquals(reports, reportsAtClose, "no report after close");
    conserved(exporter.stats());
  });
}

Deno.test("what a closed exporter refuses is counted and nothing is reported or scheduled", async () => {
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
    let reports = 0;
    const exporter = make<number>(() => Promise.resolve(), {
      onLoss: () => {
        reports += 1;
      },
    });
    await exporter.close(20);
    assertEquals(live.size, 0);
    for (let item = 0; item < 50; item += 1) exporter.offer(item);
    assertEquals(live.size, 0, "refusing offers after close schedules nothing");
    await pause(3 * MIN_LOSS_REPORT_GAP_MS);
    assertEquals(reports, 0, "and reports nothing");
    const stats = exporter.stats();
    assertEquals(stats.dropped.shutdown, 50, "but every one is counted");
    conserved(stats);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const id of live) realClear(id as ReturnType<typeof setTimeout>);
  }
});

Deno.test("a reporter that is still working does not make the application's own offers fail", async () => {
  // The first design held the refusal until the reporter's promise settled,
  // which blacked out every offer for as long as an async reporter took.
  let pending = false;
  let refusedWhilePending = 0;
  let reportsStarted = 0;
  const exporter = make<number>(() => Promise.reject(new Error("down")), {
    capacity: 50,
    batchSize: 50,
    maxAttempts: 1,
    onLoss: async () => {
      reportsStarted += 1;
      pending = true;
      await pause(120);
      pending = false;
    },
  });
  exporter.offer(0);
  await until(() => pending, "a reporter in progress");
  for (let item = 1; item <= 10; item += 1) {
    if (!exporter.offer(item)) refusedWhilePending += 1;
  }
  assert(
    pending,
    "the reporter was still working while the application offered",
  );
  assertEquals(refusedWhilePending, 0);
  assertEquals(exporter.stats().dropped.reentrant, 0);
  await exporter.close(300);
  assert(reportsStarted >= 1);
  conserved(exporter.stats());
});

Deno.test("a reporter that offers to a different exporter is not refused there", async () => {
  const other = make<number>(() => Promise.resolve());
  const exporter: Awaited<ReturnType<typeof fullQueue>> = await fullQueue(
    async () => {
      await null;
      assertEquals(other.offer(7), true, "another exporter accepts it");
      exporter.offer(-1);
    },
  );
  await until(() => exporter.stats().dropped.reentrant >= 1, "the refusal");
  await until(() => other.stats().exported === 1, "the other export");
  assertEquals(other.stats().dropped.reentrant, 0);
  await exporter.close(20);
  await other.close(20);
});

Deno.test("reports are never closer together than the gap", async () => {
  const at: number[] = [];
  const exporter = make<number>(() => new Promise(() => {}), {
    capacity: 1,
    batchSize: 1,
    sendTimeoutMs: 60_000,
    onLoss: () => {
      at.push(performance.now());
    },
  });
  exporter.offer(0);
  await until(() => exporter.stats().inFlight === 1, "an item in flight");
  exporter.offer(1);
  exporter.offer(2);
  await until(() => at.length === 1, "the first report");
  // A loss right after a report waits out the rest of the gap.
  exporter.offer(3);
  await until(() => at.length === 2, "the second report");
  assert(
    at[1] - at[0] >= MIN_LOSS_REPORT_GAP_MS - 5,
    `${at[1] - at[0]} ms between reports`,
  );
  assert(at[1] - at[0] < MIN_LOSS_REPORT_GAP_MS + 1000, "and not much longer");
  await exporter.close(20);
});

Deno.test("close reports what is pending at once, however recently the last report was", async () => {
  let reported = 0;
  const exporter = make<number>(() => new Promise(() => {}), {
    capacity: 1,
    batchSize: 1,
    sendTimeoutMs: 60_000,
    onLoss: ({ count }) => {
      reported += count;
    },
  });
  for (let item = 0; item < 4; item += 1) exporter.offer(item);
  await until(() => reported >= 2, "the first report");
  exporter.offer(10);
  exporter.offer(11);
  const closed = exporter.close(20);
  await closed;
  assertEquals(
    reported,
    exporter.stats().offered,
    "nothing is left unreported",
  );
});

Deno.test("a callback the reporter queued from outside its context is still bounded: rate-limited, and over at close", async () => {
  // Async context cannot follow a callback that a timer created earlier drains
  // from a mailbox. The reporter's offers then look like the application's, so
  // the loop is real; what stops it is the gap between reports and close.
  const mailbox: Array<() => void> = [];
  const drain = setInterval(() => {
    for (const run of mailbox.splice(0)) run();
  }, 1);
  try {
    let reports = 0;
    const exporter: Awaited<ReturnType<typeof fullQueue>> = await fullQueue(
      () => {
        reports += 1;
        mailbox.push(() => {
          exporter.offer(-1);
        });
      },
    );
    const started = performance.now();
    await pause(8 * MIN_LOSS_REPORT_GAP_MS);
    const elapsed = performance.now() - started;
    assert(
      reports >= 3,
      `${reports} reports: the escape did not happen, so this proves nothing`,
    );
    assert(
      reports <= Math.floor(elapsed / MIN_LOSS_REPORT_GAP_MS) + 2,
      `${reports} reports in ${elapsed} ms`,
    );
    assertEquals(exporter.stats().dropped.reentrant, 0, "it really did escape");
    await exporter.close(20);
    const reportsAtClose = reports;
    await pause(6 * MIN_LOSS_REPORT_GAP_MS);
    assertEquals(reports, reportsAtClose, "and it stops at close");
  } finally {
    clearInterval(drain);
  }
});

Deno.test("a reporter's then is read once, so a getter cannot answer differently the second time", async () => {
  let reads = 0;
  let reports = 0;
  const exporter = make<number>(() => Promise.reject(new Error("down")), {
    capacity: 1,
    batchSize: 1,
    maxAttempts: 1,
    onLoss: () => {
      reports += 1;
      return {
        get then() {
          reads += 1;
          // Callable, so an implementation that reads it once to check and
          // again to call it reads twice; one that reads undefined stops early.
          return () => undefined;
        },
      } as unknown as void;
    },
  });
  for (let item = 0; item < 4; item += 1) exporter.offer(item);
  await until(() => exporter.stats().failedBatches >= 1, "a failed batch");
  await exporter.close(100);
  assert(reports >= 1);
  assertEquals(reads, reports, "one read of then per report");
});

Deno.test("a long chain of thenables is followed to a bound and then left alone", async () => {
  let calls = 0;
  const link = (depth: number): unknown => ({
    then: () => {
      calls += 1;
      return depth > 0 ? link(depth - 1) : undefined;
    },
  });
  let reports = 0;
  const exporter = make<number>(() => Promise.reject(new Error("down")), {
    capacity: 1,
    batchSize: 1,
    maxAttempts: 1,
    onLoss: () => {
      reports += 1;
      return link(50) as void;
    },
  });
  for (let item = 0; item < 4; item += 1) exporter.offer(item);
  await until(() => exporter.stats().failedBatches >= 1, "a failed batch");
  await exporter.close(100);
  assert(reports >= 1);
  assert(
    calls <= reports * 8,
    `${calls} calls for ${reports} reports: not bounded`,
  );
  assert(calls >= reports, "it was followed at all");
});

// ---- Node ------------------------------------------------------------------
// The module is meant to run under Node 24 as well (epic #139). Deno compiles
// TypeScript that Node's type stripping refuses, such as a parameter property,
// so this loads the file as Node would and repeats the loop case there, where
// AsyncLocalStorage is Node's own.

Deno.test("the exporter loads and holds its guarantees under Node's type stripping", async () => {
  const url =
    new URL("../../packages/config/src/telemetry-export.ts", import.meta.url)
      .href;
  const script = `
    import { createBoundedExporter, MIN_LOSS_REPORT_GAP_MS } from ${
    JSON.stringify(url)
  };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const unhandled = [];
    process.on("unhandledRejection", (e) => unhandled.push(String(e)));
    let calls = 0;
    const exporter = createBoundedExporter({
      send: () => new Promise(() => {}),
      capacity: 1, batchSize: 1, sendTimeoutMs: 60000, maxAttempts: 1,
      retryDelayMs: 0, intervalMs: 2,
      onLoss: async () => { calls += 1; await null; exporter.offer(-1); },
    });
    exporter.offer(0);
    while (exporter.stats().inFlight !== 1) await sleep(2);
    exporter.offer(1); exporter.offer(2); exporter.offer(3);
    await sleep(4 * MIN_LOSS_REPORT_GAP_MS);
    const before = { calls, ...exporter.stats().dropped };
    await exporter.close(20);
    const atClose = calls;
    await sleep(4 * MIN_LOSS_REPORT_GAP_MS);
    // three shapes whose then() hands back a rejection nobody holds
    const exotic = [
      () => ({ then: () => Promise.reject(new Error("a")) }),
      () => new (class { async then() { throw new Error("b"); } })(),
      () => { class E extends Promise { then() { return Promise.reject(new Error("c")); } } return new E(() => {}); },
    ];
    for (const make of exotic) {
      const e = createBoundedExporter({
        send: () => Promise.reject(new Error("down")),
        capacity: 1, batchSize: 1, sendTimeoutMs: 100, maxAttempts: 1,
        retryDelayMs: 0, intervalMs: 2, onLoss: () => make(),
      });
      for (let i = 0; i < 4; i++) e.offer(i);
      await sleep(3 * MIN_LOSS_REPORT_GAP_MS);
      await e.close(20);
    }
    await sleep(100);
    console.log("NODE_RESULT " + JSON.stringify({
      version: process.versions.node, before, atClose, after: calls, unhandled,
    }));
  `;
  const { execFile } = await import("node:child_process");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "node",
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { timeout: 20_000 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${error.message}\n${stderr}`))
          : resolve(stdout),
    );
  });
  const line = output.split("\n").find((l) => l.startsWith("NODE_RESULT "));
  assert(line, `node printed no result: ${output}`);
  const result = JSON.parse(line.slice("NODE_RESULT ".length));
  assertEquals(
    result.before.calls,
    1,
    `node ${result.version}: one loss, one report`,
  );
  assertEquals(result.before.reentrant, 1);
  assertEquals(result.after, result.atClose, "no report after close");
  assertEquals(result.unhandled, [], "no unhandled rejection under Node");
});

// ---- #184: a producer that waits on the sink must not starve timers ----------
// When outer code awaits a promise the sink resolves and then offers again, the
// next batch used to be taken in the same burst of microtasks as the sink's
// resolution, so the pump never gave a timer a turn: 200,000 sink calls ran
// before a 20 ms timer fired, and 5,000,000 blocked timers for up to 119 s. The
// pump now yields a macrotask between batches.

/** An outside feeder that offers, then waits for the sink to be called. */
function feedFromOutside(
  exporter: ReturnType<typeof make<number>>,
  calls: () => number,
  setRelease: (release: () => void) => void,
  limit: number,
) {
  let feeding = true;
  const done = (async () => {
    while (feeding && calls() < limit) {
      const answered = new Promise<void>((resolve) => setRelease(resolve));
      exporter.offer(1);
      await answered;
    }
  })();
  return {
    stop: async () => {
      feeding = false;
      await Promise.race([done, pause(200)]);
    },
  };
}

Deno.test("an outside awaiter fed by the sink cannot starve timers", async () => {
  const LIMIT = 100_000;
  let calls = 0;
  let release: (() => void) | undefined;
  let timerFiredAtCall = -1;
  const exporter = make<number>(
    () => {
      calls += 1;
      release?.();
    },
    { capacity: 5, batchSize: 1, intervalMs: 3, maxAttempts: 1 },
  );
  setTimeout(() => {
    timerFiredAtCall = calls;
  }, 20);
  const feeder = feedFromOutside(
    exporter,
    () => calls,
    (r) => release = r,
    LIMIT,
  );
  await until(() => timerFiredAtCall >= 0, "an ordinary 20 ms timer", 10_000);
  await feeder.stop();
  await exporter.close(100);
  assert(calls > 3, `the exporter made progress: ${calls} sends`);
  assert(
    timerFiredAtCall < 5_000,
    `the timer waited for ${timerFiredAtCall} sink calls (the feeder's limit is ${LIMIT})`,
  );
  conserved(exporter.stats());
});

Deno.test("yielding between batches still drains a large backlog in good time", async () => {
  const exported: number[] = [];
  const exporter = make<number>(
    (batch) => {
      exported.push(...batch);
    },
    { capacity: 10_000, batchSize: 100, intervalMs: 1, maxAttempts: 1 },
  );
  for (let item = 0; item < 10_000; item += 1) exporter.offer(item);
  const started = performance.now();
  await until(
    () => exporter.stats().exported === 10_000,
    "the whole backlog",
    20_000,
  );
  const took = performance.now() - started;
  assertEquals(exported.length, 10_000);
  assertEquals(exported[0], 0);
  assertEquals(exported[9_999], 9_999, "in order");
  assert(took < 8_000, `100 batches of 100 took ${took.toFixed(0)} ms`);
  await exporter.close(100);
  conserved(exporter.stats());
});

Deno.test("a closing exporter does not wait out the yield between batches more than a tick", async () => {
  let calls = 0;
  const exporter = make<number>(
    () => {
      calls += 1;
    },
    { capacity: 1000, batchSize: 1, intervalMs: 1, maxAttempts: 1 },
  );
  for (let item = 0; item < 1000; item += 1) exporter.offer(item);
  const started = performance.now();
  await exporter.close(5_000);
  const took = performance.now() - started;
  assertEquals(calls, 1000, "everything queued was sent before close returned");
  assert(took < 5_000, `closing took ${took.toFixed(0)} ms`);
  conserved(exporter.stats());
});

Deno.test("an outside awaiter fed by a sink that answers and then fails cannot starve timers either", async () => {
  // The failure branch needs its own yield: a sink that wakes the waiting
  // producer and then throws drops the batch without ever sending it.
  const LIMIT = 100_000;
  let calls = 0;
  let release: (() => void) | undefined;
  let timerFiredAtCall = -1;
  const exporter = make<number>(
    () => {
      calls += 1;
      release?.();
      throw new Error("down");
    },
    { capacity: 5, batchSize: 1, intervalMs: 3, maxAttempts: 1 },
  );
  setTimeout(() => {
    timerFiredAtCall = calls;
  }, 20);
  const feeder = feedFromOutside(
    exporter,
    () => calls,
    (r) => release = r,
    LIMIT,
  );
  await until(() => timerFiredAtCall >= 0, "an ordinary 20 ms timer", 10_000);
  await feeder.stop();
  await exporter.close(100);
  assert(exporter.stats().failedBatches > 3, "the batches really failed");
  assert(
    timerFiredAtCall < 5_000,
    `the timer waited for ${timerFiredAtCall} failed sends (the feeder's limit is ${LIMIT})`,
  );
  conserved(exporter.stats());
});
