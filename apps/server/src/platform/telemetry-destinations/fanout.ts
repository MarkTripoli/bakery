import type { TelemetryRecord } from "@bakery/config/telemetry";
import {
  type BoundedExporter,
  createBoundedExporter,
  type ExportLoss,
  type ExportSink,
} from "@bakery/config/telemetry-export";
import { type MeasurementKind, measurementsOf } from "./measurements.ts";
import type {
  DestinationValues,
  ProviderDependencies,
  TelemetryProviderRegistry,
} from "./provider.ts";

/** A destination as saved: what it is, whether it is on, and what it receives. */
export type ConfiguredDestination = Readonly<{
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  measurements: readonly MeasurementKind[];
  /** The saved values with their secrets opened. Held in memory only. */
  values: DestinationValues;
}>;

/** How a destination is doing, as the settings page shows it. */
export type DestinationState =
  | "working"
  | "not_tested_yet"
  | "failing"
  | "dropping_data"
  | "off";

/** The last answer the destination gave to a real send. */
export type DestinationAnswer = Readonly<{
  /** Milliseconds since the epoch. */
  at: number;
  ok: boolean;
  /** A short reason when it did not accept; never the sign-in header. */
  reason: string | null;
}>;

export type DestinationRuntimeState = Readonly<{
  id: string;
  state: DestinationState;
  /** Milliseconds since the epoch of the last batch it accepted, or null. */
  lastAcceptedAt: number | null;
  lastAnswer: DestinationAnswer | null;
  /** Records dropped for this destination since it was configured. */
  dropped: number;
  /** Milliseconds since the epoch of the first of them, or null. */
  droppedSince: number | null;
}>;

/** Why a report of lost records was made. */
export type DestinationDropReason = "queue_full" | "send_failed" | "shutdown";

/**
 * One report of records Bakery could not deliver to a destination. The records
 * themselves are never kept, only how many were lost, when and why.
 */
export type DestinationDropReport = Readonly<{
  /** Counts up from 1 for this destination since the server started. */
  id: number;
  /** Milliseconds since the epoch. */
  at: number;
  reason: DestinationDropReason;
  count: number;
}>;

/** The most drop reports kept for one destination; the oldest go first. */
export const DROP_REPORTS_KEPT = 200;

/** The bounds of each destination's own queue. */
export type DestinationQueueBounds = Readonly<{
  capacity: number;
  batchSize: number;
  sendTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  intervalMs: number;
}>;

/**
 * Each destination has its own queue of this size, so a destination that is slow
 * or down fills and sheds only its own: the rest of the destinations, and every
 * execution, carry on.
 */
export const DESTINATION_QUEUE_BOUNDS: DestinationQueueBounds = Object.freeze({
  capacity: 1000,
  batchSize: 50,
  sendTimeoutMs: 5_000,
  maxAttempts: 3,
  retryDelayMs: 200,
  intervalMs: 500,
});

/** How long after a queue overflow a destination still reads "dropping data". */
export const DROPPING_WINDOW_MS = 60_000;

export type DestinationFanoutOptions = Readonly<{
  registry: TelemetryProviderRegistry;
  dependencies: ProviderDependencies;
  bounds?: DestinationQueueBounds;
  now?: () => number;
  /** Told when a destination's state changes, so an open page can update. */
  onStateChange?: (state: DestinationRuntimeState) => void;
}>;

export type DestinationFanout = Readonly<{
  /** Hand records to every destination; returns without waiting for any. */
  send: ExportSink<TelemetryRecord>;
  /** Replaces the set of destinations; unchanged ones keep their queue. */
  configure(destinations: readonly ConfiguredDestination[]): void;
  states(): ReadonlyMap<string, DestinationRuntimeState>;
  /** The destination's kept drop reports, oldest first; empty for an unknown one. */
  drops(id: string): readonly DestinationDropReport[];
  /** Flushes what it can until the deadline, then abandons the rest. */
  close(deadlineMs: number): Promise<void>;
}>;

type Entry = {
  readonly destination: ConfiguredDestination;
  readonly signature: string;
  readonly measurements: ReadonlySet<MeasurementKind>;
  readonly exporter: BoundedExporter<TelemetryRecord> | undefined;
  lastAcceptedAt: number | null;
  lastAnswer: DestinationAnswer | null;
  dropped: number;
  droppedSince: number | null;
  lastOverflowAt: number | null;
  /** The last {@link DROP_REPORTS_KEPT} loss reports, oldest first. */
  readonly drops: DestinationDropReport[];
  nextDropId: number;
  lastState: DestinationState;
  /** Why the kind cannot run, when it cannot. */
  unavailable: string | null;
};

function signatureOf(destination: ConfiguredDestination): string {
  return JSON.stringify([
    destination.kind,
    destination.enabled,
    [...destination.measurements].sort(),
    Object.entries(destination.values).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

/**
 * Delivers telemetry to every configured destination, each through its own
 * bounded queue.
 *
 * `send` only enqueues. It never waits for a destination, so the exporter in
 * front of it is never held by a slow one, and a destination's failure is
 * counted against that destination alone.
 */
export function createDestinationFanout(
  options: DestinationFanoutOptions,
): DestinationFanout {
  const now = options.now ?? Date.now;
  const bounds = options.bounds ?? DESTINATION_QUEUE_BOUNDS;
  let entries = new Map<string, Entry>();

  const stateOf = (entry: Entry): DestinationState => {
    if (!entry.destination.enabled) return "off";
    if (entry.unavailable !== null) return "failing";
    if (entry.lastAnswer === null) return "not_tested_yet";
    if (!entry.lastAnswer.ok) return "failing";
    if (
      entry.lastOverflowAt !== null &&
      now() - entry.lastOverflowAt < DROPPING_WINDOW_MS
    ) return "dropping_data";
    return "working";
  };

  const snapshot = (entry: Entry): DestinationRuntimeState =>
    Object.freeze({
      id: entry.destination.id,
      state: stateOf(entry),
      lastAcceptedAt: entry.lastAcceptedAt,
      lastAnswer: entry.lastAnswer,
      dropped: entry.dropped,
      droppedSince: entry.droppedSince,
    });

  const settle = (entry: Entry): void => {
    const state = stateOf(entry);
    if (state === entry.lastState) return;
    entry.lastState = state;
    try {
      options.onStateChange?.(snapshot(entry));
    } catch {
      // A listener that throws must not touch delivery.
    }
  };

  const build = (destination: ConfiguredDestination): Entry => {
    const provider = options.registry.get(destination.kind);
    const entry: Entry = {
      destination,
      signature: signatureOf(destination),
      measurements: new Set(destination.measurements),
      exporter: undefined,
      lastAcceptedAt: null,
      lastAnswer: null,
      dropped: 0,
      droppedSince: null,
      lastOverflowAt: null,
      drops: [],
      nextDropId: 1,
      lastState: destination.enabled ? "not_tested_yet" : "off",
      unavailable: provider === undefined
        ? "This kind of destination is not installed."
        : null,
    };
    if (!destination.enabled || provider === undefined) return entry;
    const deliver = provider.createSink(
      destination.values,
      options.dependencies,
    );
    const sink: ExportSink<TelemetryRecord> = async (batch, signal) => {
      try {
        await deliver(batch, signal);
      } catch (error) {
        entry.lastAnswer = Object.freeze({
          at: now(),
          ok: false,
          reason: reasonOf(error),
        });
        settle(entry);
        throw error;
      }
      entry.lastAcceptedAt = now();
      entry.lastAnswer = Object.freeze({
        at: entry.lastAcceptedAt,
        ok: true,
        reason: null,
      });
      settle(entry);
    };
    const onLoss = (loss: ExportLoss): void => {
      entry.dropped += loss.count;
      entry.droppedSince ??= now();
      if (loss.reason === "queue-full") entry.lastOverflowAt = now();
      entry.drops.push(Object.freeze({
        id: entry.nextDropId,
        at: now(),
        reason: loss.reason === "queue-full"
          ? "queue_full"
          : loss.reason === "send-failed"
          ? "send_failed"
          : "shutdown",
        count: loss.count,
      }));
      entry.nextDropId += 1;
      if (entry.drops.length > DROP_REPORTS_KEPT) entry.drops.shift();
      settle(entry);
    };
    return Object.assign(entry, {
      exporter: createBoundedExporter<TelemetryRecord>({
        send: sink,
        ...bounds,
        onLoss,
      }),
    });
  };

  return Object.freeze({
    send: (batch) => {
      for (const record of batch) {
        const kinds = measurementsOf(record);
        if (kinds.length === 0) continue;
        for (const entry of entries.values()) {
          if (entry.exporter === undefined) continue;
          if (kinds.some((kind) => entry.measurements.has(kind))) {
            entry.exporter.offer(record);
          }
        }
      }
    },

    configure(destinations) {
      const next = new Map<string, Entry>();
      for (const destination of destinations) {
        const kept = entries.get(destination.id);
        if (kept !== undefined && kept.signature === signatureOf(destination)) {
          next.set(destination.id, kept);
          continue;
        }
        next.set(destination.id, build(destination));
      }
      const previous = entries;
      entries = next;
      for (const [id, entry] of previous) {
        // A removed or changed destination stops at once; what it still held is
        // abandoned rather than delivered under settings it no longer has.
        if (next.get(id) !== entry) void entry.exporter?.close(0);
      }
    },

    states() {
      return new Map(
        [...entries].map(([id, entry]) => [id, snapshot(entry)] as const),
      );
    },

    drops(id) {
      return [...(entries.get(id)?.drops ?? [])];
    },

    async close(deadlineMs) {
      await Promise.all(
        [...entries.values()].map((entry) => entry.exporter?.close(deadlineMs)),
      );
    },
  });
}

/** A short, content-free reason: a status or a fixed phrase, never a header. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = /^OTLP_DESTINATION_(\d{3})$/.exec(message);
  if (status) return `The destination answered ${status[1]}.`;
  const refused = /^OTLP_ADDRESS_REFUSED:(.*)$/.exec(message);
  if (refused) return refused[1];
  if ((error as { name?: string })?.name === "AbortError") {
    return "The destination did not answer in time.";
  }
  return "Bakery could not reach the destination.";
}
