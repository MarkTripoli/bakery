/**
 * The call that code on the lease, completion and settlement paths makes to
 * say something happened. It composes the pieces of the telemetry package: the
 * allowlist that decides which fields may leave, the bounded exporter that
 * hands them to a sink without ever waiting, and the metrics registry whose
 * labels are closed.
 *
 * Its one promise is to the caller: whatever the sink, the redactor, the clock
 * or the arguments do, `event` returns at once and the caller is none the
 * wiser. A disabled sink costs a counter. Everything that goes wrong is counted
 * in the telemetry's own metrics (`bakery_telemetry_*`) so an operator can see
 * that telemetry is losing data, which is how export loss becomes visible
 * without ever blocking work.
 */
import type {
  BoundedExporter,
  BoundedExporterOptions,
  ExportSink,
  ExportStats,
} from "./telemetry-export.ts";
import { createBoundedExporter } from "./telemetry-export.ts";
import {
  createMetricsRegistry,
  type MetricSample,
  type MetricSpecs,
  type MetricsRegistry,
} from "./telemetry-metrics.ts";
import type { RedactedTelemetryAttributes } from "./telemetry-attributes.ts";
import {
  formatTraceparent,
  MAX_TRACE_LINKS,
  parseTraceLink,
  parseTraceparent,
  type TraceContext,
  type TraceLink,
} from "./telemetry-trace.ts";

/** One thing handed to the sink. */
export type TelemetryRecord =
  | {
    readonly kind: "event";
    readonly name: string;
    /** Milliseconds since the epoch, or 0 when the clock was unusable. */
    readonly time: number;
    /** Only fields the allowlist admitted. */
    readonly attributes: Readonly<Record<string, string | number | boolean>>;
    readonly trace?: TraceContext;
    readonly links?: readonly TraceLink[];
  }
  | {
    readonly kind: "metrics";
    readonly time: number;
    readonly samples: readonly MetricSample[];
  };

export type TelemetryOptions = {
  /** The destination. `undefined` disables export. */
  readonly send: ExportSink<TelemetryRecord> | undefined;
  readonly exporter: Omit<
    BoundedExporterOptions<TelemetryRecord>,
    "send" | "onLoss"
  >;
  /** The allowlist; see `createTelemetryRedactor`. May throw: that is counted. */
  readonly redact: (input: unknown) => RedactedTelemetryAttributes;
  /** The event names that may be recorded. Anything else is counted and dropped. */
  readonly events: Iterable<string>;
  /** The application's own metrics. */
  readonly metrics?: MetricSpecs;
  /** Clock in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
};

/** Trace parts an event may carry; both are validated before they are kept. */
export type TelemetryTrace = {
  readonly context?: unknown;
  readonly links?: unknown;
};

export type Telemetry = {
  /** Records an event. Never throws, never waits. */
  event(name: string, attributes?: unknown, trace?: TelemetryTrace): void;
  /** The application's metrics and the telemetry's own. */
  readonly metrics: Pick<MetricsRegistry, "inc" | "set" | "snapshot">;
  /** Offers the current metrics as one record. Never throws, never waits. */
  flushMetrics(): void;
  stats(): ExportStats;
  /** Flushes what it can until the deadline, then abandons the rest. */
  close(deadlineMs: number): Promise<void>;
};

/** Names of the telemetry's own metrics. */
export const TELEMETRY_META_METRICS = Object.freeze({
  events: "bakery_telemetry_events_total",
  lost: "bakery_telemetry_export_lost_total",
  redacted: "bakery_telemetry_redacted_fields_total",
  queueDepth: "bakery_telemetry_queue_depth",
});

/** Application metrics may not use this prefix. */
const RESERVED_METRIC_PREFIX = "bakery_telemetry_";

/** Most event names one telemetry may declare. */
export const MAX_TELEMETRY_EVENTS = 64;

/** Trace link entries examined per event, so a huge array costs nothing. */
const MAX_LINK_ENTRIES_EXAMINED = 64;

const EVENT_NAME = /^[a-z][a-z0-9_.]{1,63}$/;

const metaSpecs: MetricSpecs = {
  [TELEMETRY_META_METRICS.events]: {
    kind: "counter",
    help: "Events handed to telemetry, by what became of them.",
    labels: {
      outcome: ["recorded", "discarded", "unknown_event", "dropped", "failed"],
    },
  },
  [TELEMETRY_META_METRICS.lost]: {
    kind: "counter",
    help: "Records lost on the way to the sink, by reason.",
    labels: { reason: ["queue_full", "send_failed", "shutdown"] },
  },
  [TELEMETRY_META_METRICS.redacted]: {
    kind: "counter",
    help: "Event fields removed by the allowlist, by kind.",
    labels: { kind: ["unregistered", "invalid"] },
  },
  [TELEMETRY_META_METRICS.queueDepth]: {
    kind: "gauge",
    help: "Records waiting to be exported.",
  },
};

function eventNames(events: Iterable<string>): ReadonlySet<string> {
  const names = new Set<string>();
  let yielded = 0;
  for (const name of events) {
    yielded += 1;
    if (yielded > MAX_TELEMETRY_EVENTS) {
      throw new RangeError("telemetry events: too many event names");
    }
    if (typeof name !== "string" || !EVENT_NAME.test(name)) {
      // The offending name is deliberately not part of the message.
      throw new RangeError("telemetry events: an event name is not acceptable");
    }
    names.add(name);
  }
  return names;
}

/** A trace context as two well-formed ids and a flag, or nothing. */
function validContext(context: unknown): TraceContext | undefined {
  try {
    return parseTraceparent(formatTraceparent(context as TraceContext));
  } catch {
    return undefined;
  }
}

/** The links of an event: well-formed ones only, at most {@link MAX_TRACE_LINKS}. */
function validLinks(links: unknown): TraceLink[] {
  const kept: TraceLink[] = [];
  try {
    if (!Array.isArray(links)) return kept;
    const examine = Math.min(links.length, MAX_LINK_ENTRIES_EXAMINED);
    for (
      let index = 0;
      index < examine && kept.length < MAX_TRACE_LINKS;
      index += 1
    ) {
      try {
        const link = parseTraceLink(links[index]);
        if (link) kept.push(link);
      } catch {
        // One unreadable entry costs that link.
      }
    }
  } catch {
    // A list that cannot be read at all contributes nothing.
  }
  return kept;
}

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const names = eventNames(options.events);
  const application = options.metrics ?? {};
  for (const name of Object.keys(application)) {
    if (name.startsWith(RESERVED_METRIC_PREFIX)) {
      throw new RangeError(
        "telemetry metrics: a metric uses the reserved prefix",
      );
    }
  }
  const registry = createMetricsRegistry({ ...application, ...metaSpecs });
  // No loss callback is registered. The exporter counts every drop by reason in
  // its stats, and the loss metric is brought up to those counts whenever the
  // metrics are read, so it is exact at that moment, needs no timer and cannot
  // be re-entered by the code that reports it.
  const exporter: BoundedExporter<TelemetryRecord> = createBoundedExporter({
    ...options.exporter,
    send: options.send,
  });
  const lostReasons = [
    ["queueFull", "queue_full"],
    ["sendFailed", "send_failed"],
    ["shutdown", "shutdown"],
  ] as const;
  const accounted = { queueFull: 0, sendFailed: 0, shutdown: 0 };
  /** Adds to the loss metric what the exporter has dropped since the last read. */
  const syncLoss = () => {
    try {
      const { dropped } = exporter.stats();
      for (const [key, reason] of lostReasons) {
        const delta = dropped[key] - accounted[key];
        if (delta > 0) {
          accounted[key] = dropped[key];
          registry.inc(TELEMETRY_META_METRICS.lost, { reason }, delta);
        }
      }
    } catch {
      // Counting is best effort; the exporter's own stats stay exact.
    }
  };
  const clock = options.now ?? Date.now;
  const count = (outcome: string) =>
    registry.inc(TELEMETRY_META_METRICS.events, { outcome });

  const timeNow = (): number => {
    try {
      const value = clock();
      return typeof value === "number" && Number.isSafeInteger(value) &&
          value >= 0
        ? value
        : 0;
    } catch {
      return 0;
    }
  };

  return {
    event(name, attributes, trace) {
      try {
        if (typeof name !== "string" || !names.has(name)) {
          count("unknown_event");
          return;
        }
        if (exporter.stats().disabled) {
          count("discarded");
          return;
        }
        const redacted = options.redact(attributes);
        if (redacted.unregisteredCount > 0) {
          registry.inc(
            TELEMETRY_META_METRICS.redacted,
            { kind: "unregistered" },
            redacted.unregisteredCount,
          );
        }
        if (redacted.invalid.length > 0) {
          registry.inc(
            TELEMETRY_META_METRICS.redacted,
            { kind: "invalid" },
            redacted.invalid.length,
          );
        }
        let context: TraceContext | undefined;
        let links: TraceLink[] = [];
        try {
          context = trace?.context === undefined
            ? undefined
            : validContext(trace.context);
          links = validLinks(trace?.links);
        } catch {
          // An unreadable trace argument is left out; the event still goes.
        }
        const record: TelemetryRecord = {
          kind: "event",
          name,
          time: timeNow(),
          attributes: { ...redacted.attributes },
          ...(context ? { trace: context } : {}),
          ...(links.length > 0 ? { links } : {}),
        };
        count(exporter.offer(record) ? "recorded" : "dropped");
      } catch {
        try {
          count("failed");
        } catch {
          // Counting is best effort too.
        }
      }
    },

    metrics: {
      inc: (name, labels, by) => registry.inc(name, labels, by),
      set: (name, labels, value) => registry.set(name, labels, value),
      snapshot: () => {
        syncLoss();
        return registry.snapshot();
      },
    },

    flushMetrics() {
      try {
        syncLoss();
        registry.set(
          TELEMETRY_META_METRICS.queueDepth,
          {},
          exporter.stats().queued,
        );
        exporter.offer({
          kind: "metrics",
          time: timeNow(),
          samples: registry.snapshot(),
        });
      } catch {
        // A snapshot that cannot be taken is simply not sent.
      }
    },

    stats: () => exporter.stats(),

    close: (deadlineMs) => exporter.close(deadlineMs),
  };
}
