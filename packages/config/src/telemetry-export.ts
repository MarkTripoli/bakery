/**
 * A bounded, non-blocking hand-off from the code being observed to a telemetry
 * sink. Telemetry is never allowed to be a dependency of execution: lease
 * renewal, completion and usage settlement must go on when the exporter is
 * disabled, slow, failing or hung, and the memory it holds must stay bounded
 * whatever the sink does.
 *
 * The guarantees, each pinned by a test:
 *
 * - `offer` is O(1), synchronous, never runs sink or reporter code and never
 *   throws.
 * - At most `capacity` items wait and at most `batchSize` are in flight. A full
 *   queue drops the newest item and counts it. The references held at once are
 *   bounded by `capacity + batchSize * (2 + MAX_STUCK_SENDS)`: the queue, the
 *   batch being sent, the copy the live attempt was handed, and the copy each
 *   abandoned send still holds.
 * - The sink is handed a copy of its batch for every attempt, and the size is
 *   counted once before the first. Whatever it does to that array, a retry
 *   carries the same items and every counter is exact.
 * - Sends never overlap, and each is cut off after `sendTimeoutMs` even if the
 *   sink ignores its abort signal. A sink that never settles leaves a promise
 *   behind after every timeout, so after `MAX_STUCK_SENDS` of them are
 *   outstanding the exporter stops calling it and sheds instead.
 * - `close(deadlineMs)` returns by its deadline however the sink behaves.
 * - Every offered item is accounted for in exactly one place:
 *   `offered = queued + inFlight + exported + discarded + dropped.*`.
 * - No timer exists unless there is something to flush or report, and none
 *   outlives a call or `close`.
 *
 * Loss is reported, never hidden: each drop is counted by reason and passed to
 * `onLoss`, which is where an export-loss metric attaches. Reports are totals
 * per reason, delivered a tick after the loss, so a slow reporter cannot slow
 * the code that is being observed and a burst of drops is one call.
 */

/** Largest queue that may be asked for. */
export const MAX_EXPORT_CAPACITY = 100_000;

/** Most attempts at one batch. */
export const MAX_EXPORT_ATTEMPTS = 10;

/**
 * Timed-out sends that may be outstanding at once. Each is a promise the sink
 * never settled, holding its batch, so this bounds what a sink that hangs
 * forever can make the process retain.
 */
export const MAX_STUCK_SENDS = 4;

/**
 * Longest delay a timer holds. A larger one fires at once, which turned a
 * 50-day timeout into an immediate one, so options past it are refused and a
 * `close` deadline past it is clamped.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Longest pause between two attempts at one batch. */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Delivers one batch. `signal` aborts when the exporter gives up on the send.
 *
 * What a sink does is contained: it may throw, reject, never settle or edit the
 * array it is handed, and the exporter carries on. One thing is not contained.
 * An abort listener the sink registers on `signal` runs inside the runtime's
 * own `abort()`, so if that listener throws the runtime reports an uncaught
 * error (an `error` event in Deno, `uncaughtException` in Node) that nothing in
 * the exporter can intercept. Keep abort listeners from throwing.
 */
export type ExportSink<T> = (
  batch: readonly T[],
  signal: AbortSignal,
) => Promise<void> | void;

/** Items lost, and why. */
export type ExportLoss = {
  readonly count: number;
  /** `queue-full`: no room. `send-failed`: every attempt failed or timed out. `shutdown`: still queued or in flight at close. */
  readonly reason: "queue-full" | "send-failed" | "shutdown";
};

export type BoundedExporterOptions<T> = {
  /** The destination. `undefined` disables export: nothing is queued. */
  readonly send: ExportSink<T> | undefined;
  /** Most items waiting at once. */
  readonly capacity: number;
  /** Most items per send; at most `capacity`. */
  readonly batchSize: number;
  /** Deadline of one send attempt, in milliseconds. */
  readonly sendTimeoutMs: number;
  /** Attempts at one batch before it is dropped. */
  readonly maxAttempts: number;
  /** Pause before the second attempt; it doubles for each one after. */
  readonly retryDelayMs: number;
  /** How long after an item arrives the exporter waits before sending. */
  readonly intervalMs: number;
  /**
   * Told of losses: one call per reason with the count since the last, a tick
   * after the first of them. May throw, or be async and reject; neither changes
   * anything, and what it returns is never waited for, so a slow async reporter
   * can overlap the next report. An item offered from inside it is refused and
   * counted as `dropped.reentrant`.
   */
  readonly onLoss?: (loss: ExportLoss) => void | PromiseLike<unknown>;
};

export type ExportStats = {
  readonly disabled: boolean;
  readonly closed: boolean;
  readonly offered: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly exported: number;
  /** Offers made while export is disabled; not a loss. */
  readonly discarded: number;
  readonly dropped: {
    readonly queueFull: number;
    readonly sendFailed: number;
    readonly shutdown: number;
    /** Offers made from inside `onLoss`, refused so a reporter cannot recurse. */
    readonly reentrant: number;
  };
  /** Batches that used every attempt and were dropped. */
  readonly failedBatches: number;
};

export type BoundedExporter<T> = {
  /** Queues an item. False when it was not kept. Never throws, never waits. */
  offer(item: T): boolean;
  stats(): ExportStats;
  /**
   * Flushes what it can until `deadlineMs`, then abandons the rest. Idempotent.
   * A deadline past what a timer holds waits that long; one that is missing,
   * negative or not a number abandons at once.
   */
  close(deadlineMs: number): Promise<void>;
};

/** Fixed-size ring: no allocation per item and nothing retained after a take. */
class Ring<T> {
  readonly #items: Array<T | undefined>;
  #head = 0;
  #size = 0;

  constructor(readonly capacity: number) {
    this.#items = new Array(capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(item: T): boolean {
    if (this.#size === this.capacity) return false;
    this.#items[(this.#head + this.#size) % this.capacity] = item;
    this.#size += 1;
    return true;
  }

  take(max: number): T[] {
    const count = Math.min(max, this.#size);
    const out = new Array<T>(count);
    for (let index = 0; index < count; index += 1) {
      const slot = (this.#head + index) % this.capacity;
      out[index] = this.#items[slot] as T;
      this.#items[slot] = undefined;
    }
    this.#head = (this.#head + count) % this.capacity;
    this.#size -= count;
    return out;
  }
}

/** A timer that can be cancelled, so no path leaves one running. */
function after(ms: number) {
  let id: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"elapsed">((resolve) => {
    id = setTimeout(() => resolve("elapsed"), ms);
  });
  return { promise, cancel: () => clearTimeout(id) };
}

/**
 * Makes sure a value the caller's code returned cannot reject unhandled. A
 * reporter typed to return nothing may still be an async function, and an
 * unhandled rejection ends a Node 24 process; this is the one place the
 * exporter calls caller code without a promise chain of its own to catch it.
 */
function swallowRejection(value: unknown): void {
  try {
    if (
      (typeof value === "object" || typeof value === "function") &&
      value !== null &&
      typeof (value as PromiseLike<unknown>).then === "function"
    ) {
      (value as PromiseLike<unknown>).then(undefined, () => {});
    }
  } catch {
    // A thenable whose `then` throws, or a revoked proxy: nothing to wait for.
  }
}

/** Lets the process exit with the timer pending, where the runtime allows it. */
function unref(id: unknown): void {
  try {
    (id as { unref?: () => void }).unref?.();
    (globalThis as { Deno?: { unrefTimer?: (id: number) => void } }).Deno
      ?.unrefTimer?.(id as number);
  } catch {
    // Not every runtime has it; a pending timer is then merely kept alive.
  }
}

function integerBetween(name: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
}

function finiteBetween(name: string, value: number, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be a finite number from ${min} to ${max}`,
    );
  }
}

export function createBoundedExporter<T>(
  options: BoundedExporterOptions<T>,
): BoundedExporter<T> {
  const { send, capacity, batchSize, sendTimeoutMs, maxAttempts } = options;
  integerBetween("capacity", capacity, 1, MAX_EXPORT_CAPACITY);
  integerBetween("batchSize", batchSize, 1, capacity);
  integerBetween("maxAttempts", maxAttempts, 1, MAX_EXPORT_ATTEMPTS);
  finiteBetween("sendTimeoutMs", sendTimeoutMs, 1, MAX_TIMER_MS);
  finiteBetween("retryDelayMs", options.retryDelayMs, 0, MAX_TIMER_MS);
  finiteBetween("intervalMs", options.intervalMs, 1, MAX_TIMER_MS);

  const ring = new Ring<T>(capacity);
  const shutdown = new AbortController();
  const shutdownSignalled = new Promise<"shutdown">((resolve) => {
    shutdown.signal.addEventListener("abort", () => resolve("shutdown"), {
      once: true,
    });
  });

  let startClosing!: () => void;
  const closingStarted = new Promise<"closing">((resolve) => {
    startClosing = () => resolve("closing");
  });

  let offered = 0;
  let inFlight = 0;
  let exported = 0;
  let discarded = 0;
  let failedBatches = 0;
  let stuck = 0;
  const dropped = { queueFull: 0, sendFailed: 0, shutdown: 0, reentrant: 0 };
  let closing = false;
  let closed = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  // Losses are noted here and reported later, as totals per reason: the
  // reporter is the caller's code and may be slow, so it never runs inside
  // `offer`, and a burst of drops is one call.
  const pendingLoss: Record<ExportLoss["reason"], number> = {
    "queue-full": 0,
    "send-failed": 0,
    shutdown: 0,
  };
  let lossTimer: ReturnType<typeof setTimeout> | undefined;
  let reporting = false;

  const reportLosses = () => {
    if (lossTimer !== undefined) clearTimeout(lossTimer);
    lossTimer = undefined;
    for (const reason of ["queue-full", "send-failed", "shutdown"] as const) {
      const count = pendingLoss[reason];
      if (count === 0) continue;
      pendingLoss[reason] = 0;
      reporting = true;
      try {
        swallowRejection(options.onLoss?.({ reason, count }));
      } catch {
        // A broken reporter must not reach the code being observed.
      } finally {
        reporting = false;
      }
    }
  };

  const lost = (reason: ExportLoss["reason"], count: number) => {
    if (!options.onLoss) return;
    pendingLoss[reason] += count;
    if (lossTimer === undefined) {
      lossTimer = setTimeout(reportLosses, 0);
      unref(lossTimer);
    }
  };

  const schedule = () => {
    if (flushTimer !== undefined || running !== undefined || closing) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void pump();
    }, options.intervalMs);
    unref(flushTimer);
  };

  /** One send attempt after another until the batch is sent, given up on or abandoned. */
  const deliver = async (
    batch: readonly T[],
  ): Promise<"sent" | "failed" | "abandoned"> => {
    for (let attempt = 1;; attempt += 1) {
      if (shutdown.signal.aborted) return "abandoned";
      if (stuck >= MAX_STUCK_SENDS) return "failed";
      const controller = new AbortController();
      const onShutdown = () => controller.abort();
      shutdown.signal.addEventListener("abort", onShutdown, { once: true });
      const timeout = after(sendTimeoutMs);
      let settled = false;
      // Its own copy, so a sink that edits what it is handed (a draining sink
      // is ordinary) changes nothing here and a retry carries the same items.
      const handed = [...batch];
      const call = Promise.resolve()
        .then(() => (send as ExportSink<T>)(handed, controller.signal))
        .then(() => "sent" as const, () => "error" as const)
        .finally(() => {
          settled = true;
        });
      let outcome: "sent" | "error" | "timeout" | "shutdown";
      try {
        outcome = await Promise.race([
          call,
          timeout.promise.then(() => "timeout" as const),
          shutdownSignalled,
        ]);
      } finally {
        timeout.cancel();
        shutdown.signal.removeEventListener("abort", onShutdown);
      }
      if (outcome === "sent") return "sent";
      // Whatever ended the attempt, tell the sink to stop; it may not listen.
      controller.abort();
      if (!settled) {
        stuck += 1;
        void call.finally(() => {
          stuck -= 1;
        });
      }
      if (outcome === "shutdown") return "abandoned";
      if (attempt >= (closing ? 1 : maxAttempts)) return "failed";
      const pause = after(
        Math.min(options.retryDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS),
      );
      try {
        const woken = await Promise.race([
          pause.promise,
          shutdownSignalled,
          closingStarted,
        ]);
        if (woken === "shutdown") return "abandoned";
        // A closing exporter does not wait out a backoff to retry.
        if (woken === "closing") return "failed";
      } finally {
        pause.cancel();
      }
    }
  };

  const run = async () => {
    try {
      while (ring.size > 0 && !shutdown.signal.aborted) {
        const batch = ring.take(batchSize);
        // Counted once, before any sink sees anything.
        const size = batch.length;
        inFlight = size;
        const outcome = await deliver(batch);
        inFlight = 0;
        if (outcome === "sent") {
          exported += size;
        } else if (outcome === "abandoned") {
          dropped.shutdown += size;
          lost("shutdown", size);
        } else {
          dropped.sendFailed += size;
          failedBatches += 1;
          lost("send-failed", size);
        }
      }
    } finally {
      inFlight = 0;
    }
  };

  const pump = (): Promise<void> => {
    running ??= run().finally(() => {
      running = undefined;
      if (!closing && ring.size > 0) schedule();
    });
    return running;
  };

  return {
    offer(item) {
      offered += 1;
      if (reporting) {
        dropped.reentrant += 1;
        return false;
      }
      if (!send) {
        discarded += 1;
        return false;
      }
      if (closing) {
        dropped.shutdown += 1;
        lost("shutdown", 1);
        return false;
      }
      if (!ring.push(item)) {
        dropped.queueFull += 1;
        lost("queue-full", 1);
        return false;
      }
      schedule();
      return true;
    },

    stats() {
      return {
        disabled: !send,
        closed,
        offered,
        queued: ring.size,
        inFlight,
        exported,
        discarded,
        dropped: { ...dropped },
        failedBatches,
      };
    },

    close(deadlineMs) {
      closePromise ??= (async () => {
        closing = true;
        startClosing();
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
        const wait = typeof deadlineMs === "number" && deadlineMs > 0
          ? Math.min(deadlineMs, MAX_TIMER_MS)
          : 0;
        const deadline = after(wait);
        try {
          const flushing = pump();
          await Promise.race([flushing, deadline.promise]);
          shutdown.abort();
          await flushing;
        } finally {
          deadline.cancel();
        }
        const rest = ring.take(ring.size).length;
        if (rest > 0) {
          dropped.shutdown += rest;
          lost("shutdown", rest);
        }
        reportLosses();
        closed = true;
      })();
      return closePromise;
    },
  };
}
