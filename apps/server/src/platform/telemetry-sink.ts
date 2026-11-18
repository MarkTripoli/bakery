/**
 * The telemetry destinations (#23).
 *
 * Until this file existed the server built its telemetry facade with no sink at
 * all, so every record was counted and discarded: the exporter was disabled by
 * configuration that nothing supplied. This is the slice that supplies it.
 *
 * Three properties matter more than throughput:
 *
 * - **A batch is redacted before it arrives.** The records here have already
 *   passed the allowlist in `telemetry-attributes.ts`, so a sink never sees a
 *   prompt, a credential or a diff. A sink is not allowed to widen that: it
 *   serialises exactly the fields it was given.
 * - **A failing sink cannot escape.** `send` runs inside the exporter, which
 *   catches, but a sink that throws synchronously from inside a catch is how a
 *   telemetry failure becomes an execution failure. Every sink here absorbs its
 *   own errors and resolves.
 * - **A slow sink cannot wedge the server.** The exporter bounds capacity and
 *   per-attempt time; the sinks stay awaitable and honour the abort signal so a
 *   hung write is abandoned rather than held.
 */
import type { TelemetryRecord } from "@bakery/config/telemetry";
import type { ExportSink } from "@bakery/config/telemetry-export";
import type { MetricKind } from "@bakery/config/telemetry-metrics";

/** One line of a structured log, as bytes. */
export type LogWrite = (line: Uint8Array) => Promise<void> | void;

const NEWLINE = new Uint8Array([0x0a]);

/**
 * Serialises one record to a single JSON line.
 *
 * Newlines inside a string value would split one record across two lines, so the
 * encoded form is what is written: `JSON.stringify` escapes them, and the only
 * raw newline is the one appended here.
 */
export function encodeLogLine(
  record: TelemetryRecord,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify(record));
}

/**
 * A sink over an injected writer.
 *
 * The writer is injected rather than opened here so rotation and serialisation
 * can be proved without touching a filesystem, and so the same sink serves a
 * file, a pipe or a test.
 */
export function createLogSink(write: LogWrite): ExportSink<TelemetryRecord> {
  return async (batch, signal) => {
    for (const record of batch) {
      if (signal.aborted) return;
      const line = encodeLogLine(record);
      await write(line);
      await write(NEWLINE);
    }
  };
}

/** What a rotating file sink needs from the filesystem. */
export type RotatingLogFileSystem = {
  /** Appends bytes to the current file, creating it when missing. */
  append(path: string, bytes: Uint8Array): Promise<void>;
  /** Size in bytes, or 0 when the file does not exist. */
  size(path: string): Promise<number>;
  /** Best effort: a rename that fails is not a reason to lose the batch. */
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Creates the directory when missing, recursively. */
  ensureDirectory(path: string): Promise<void>;
};

export type RotatingLogSinkOptions = {
  readonly directory: string;
  /** Bytes per file before it rotates. */
  readonly maxBytes: number;
  /** Files kept, including the current one. */
  readonly maxFiles: number;
  readonly fileSystem: RotatingLogFileSystem;
  /** Base name of the current file. */
  readonly fileName?: string;
};

/**
 * A size-rotated structured log sink.
 *
 * Rotation is by size rather than by clock because size is the property that
 * actually bounds the disk: a quiet server writes one small file, and a burst
 * cannot fill the volume regardless of how long it lasts.
 *
 * The rotation is deliberately simple and lossy at the edge: the current file is
 * shifted to `.1`, `.1` to `.2`, and the file beyond `maxFiles` is removed. A
 * rename that fails is swallowed, because a telemetry sink that stops execution
 * over a filesystem problem is worse than a gap in the logs - the gap is
 * counted by the exporter, the crash is not.
 */
export function createRotatingLogSink(
  options: RotatingLogSinkOptions,
): ExportSink<TelemetryRecord> {
  const fileName = options.fileName ?? "telemetry.ndjson";
  const current = `${options.directory}/${fileName}`;
  // Rotation state is per sink, so two sinks over one directory cannot both
  // believe they own the current file.
  let ready: Promise<void> | undefined;

  const pathFor = (index: number) =>
    index === 0 ? current : `${current}.${index}`;

  /**
   * Shifts the files down one, oldest out.
   *
   * Throws when the shift cannot complete. The caller must not treat that as a
   * quiet success: nothing was written, so a batch reported as sent would be a
   * batch the operator believes exists and does not.
   */
  const rotate = async (): Promise<void> => {
    // The oldest kept file goes first: removing it before the shift means the
    // shift never needs to overwrite a file it is about to create.
    await options.fileSystem.remove(pathFor(options.maxFiles));
    for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
      // A file that does not exist yet is not a failure: the first rotation has
      // nothing to shift at the higher indexes, and `rename` reports that as
      // ENOENT. Any other error means the shift is genuinely broken, which the
      // caller must see.
      try {
        await options.fileSystem.rename(pathFor(index - 1), pathFor(index));
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") continue;
        throw error;
      }
    }
  };

  return async (batch, signal) => {
    ready ??= options.fileSystem.ensureDirectory(options.directory).catch(
      () => undefined,
    );
    await ready;

    let written = 0;
    let failure: unknown;
    for (const record of batch) {
      if (signal.aborted) break;
      const bytes = concat(encodeLogLine(record), NEWLINE);
      const size = await options.fileSystem.size(current);
      // Rotate before writing so a file never exceeds maxBytes: the check is
      // against what is about to be appended, not what is already there. A
      // rotation that cannot complete throws, because the alternative - keep
      // appending past the cap - trades the disk bound, which is the whole point
      // of rotating, for logs nobody can find.
      if (size > 0 && size + bytes.byteLength > options.maxBytes) {
        await rotate();
      }
      try {
        await options.fileSystem.append(current, bytes);
        written += 1;
      } catch (error) {
        failure = error;
        break;
      }
    }
    // A partial batch is a failed batch. Returning normally after writing some
    // records would report the whole batch as sent while the rest of it was
    // dropped, which is the one outcome an operator cannot detect.
    if (failure !== undefined) throw failure;
  };
}

function concat(
  first: Uint8Array,
  second: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(first.byteLength + second.byteLength);
  out.set(first, 0);
  out.set(second, first.byteLength);
  return out;
}

/**
 * The OTLP signal a record belongs to.
 *
 * OTLP/HTTP has one path per signal: traces go to `/v1/traces`, metrics to
 * `/v1/metrics`. Posting one body carrying both is rejected by every real
 * collector, which is why the two encoders below are separate and the sink
 * chooses by what the batch actually contains.
 */
export type OtlpSignal = "traces" | "metrics";

const SIGNAL_PATHS: Readonly<Record<OtlpSignal, string>> = Object.freeze({
  traces: "/traces",
  metrics: "/metrics",
});

/**
 * Resolves the OTLP/HTTP URL for one signal.
 *
 * The configured endpoint is a collector base, not a signal URL: one URL cannot
 * serve two signals, so an endpoint that already names a signal is refused rather
 * than silently dropping the other half of the telemetry.
 */
export function otlpSignalUrl(
  endpoint: string,
  signal: OtlpSignal,
): string | undefined {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (/\/v1\/(?:traces|metrics)$/.test(trimmed)) return undefined;
  const base = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return `${base}${SIGNAL_PATHS[signal]}`;
}

/** A span id is 8 bytes; a span without one is invalid, so one is made. */
function randomSpanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function randomTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function otlpAttributes(
  attributes: Readonly<Record<string, string | number | boolean>>,
): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: typeof value === "number"
      ? { doubleValue: value }
      : typeof value === "boolean"
      ? { boolValue: value }
      : { stringValue: value },
  }));
}

/** The service identity a collector groups telemetry by. */
function otlpResource(): Record<string, unknown> {
  return {
    attributes: [
      { key: "service.name", value: { stringValue: "bakery-server" } },
    ],
  };
}

/**
 * The OTLP/HTTP trace body.
 *
 * Every span gets its own ids, because OTLP requires both and a collector keys
 * spans by spanId. A record with W3C context keeps the context's trace id and
 * names the context's span as its parent, so the events appear as children of
 * the work they describe rather than replacing it. A record without context is
 * its own root.
 */
export function encodeOtlpTraces(
  batch: readonly TelemetryRecord[],
): Record<string, unknown> {
  const spans = [];
  for (const record of batch) {
    if (record.kind !== "event") continue;
    spans.push({
      traceId: record.trace?.traceId ?? randomTraceId(),
      // A fresh id per span. Reusing the context's spanId would give every event
      // under one trace context the same span id, and a collector keys spans by
      // it: the events would collapse into one span instead of appearing as
      // separate children of the work they describe.
      spanId: randomSpanId(),
      ...(record.trace ? { parentSpanId: record.trace.spanId } : {}),
      name: record.name,
      // SPAN_KIND_INTERNAL: these are points in our own work, not RPC edges.
      kind: 1,
      startTimeUnixNano: `${record.time}000000`,
      endTimeUnixNano: `${record.time}000000`,
      attributes: otlpAttributes(record.attributes),
      status: { code: 0 },
      ...(record.links && record.links.length > 0
        ? {
          links: record.links.map((link) => ({
            traceId: link.traceId,
            spanId: link.spanId,
          })),
        }
        : {}),
    });
  }
  return {
    resourceSpans: [{
      resource: otlpResource(),
      scopeSpans: [{
        scope: { name: "bakery.telemetry" },
        spans,
      }],
    }],
  };
}

/**
 * The OTLP/HTTP metrics body.
 *
 * Samples are grouped by name and kind because OTLP defines a metric once and
 * carries the series as its data points; emitting one metric per sample would
 * describe the same metric many times, and a collector would treat them as
 * separate instruments. A counter is a monotonic cumulative sum, a gauge is a
 * gauge - the two are different OTLP types, not a flag.
 */
export function encodeOtlpMetrics(
  batch: readonly TelemetryRecord[],
): Record<string, unknown> {
  const grouped = new Map<string, {
    name: string;
    kind: MetricKind;
    points: Record<string, unknown>[];
  }>();
  for (const record of batch) {
    if (record.kind !== "metrics") continue;
    for (const sample of record.samples) {
      const key = `${sample.kind}:${sample.name}`;
      const entry = grouped.get(key) ??
        { name: sample.name, kind: sample.kind, points: [] };
      entry.points.push({
        asDouble: sample.value,
        timeUnixNano: `${record.time}000000`,
        attributes: Object.entries(sample.labels).map(([label, value]) => ({
          key: label,
          value: { stringValue: value },
        })),
      });
      grouped.set(key, entry);
    }
  }

  const metrics = [...grouped.values()].map((entry) =>
    entry.kind === "counter"
      ? {
        name: entry.name,
        sum: {
          dataPoints: entry.points,
          // CUMULATIVE (2) and monotonic: a counter only ever goes up.
          aggregationTemporality: 2,
          isMonotonic: true,
        },
      }
      : { name: entry.name, gauge: { dataPoints: entry.points } }
  );

  return {
    resourceMetrics: [{
      resource: otlpResource(),
      scopeMetrics: [{
        scope: { name: "bakery.telemetry" },
        metrics,
      }],
    }],
  };
}

export type OtlpSinkOptions = {
  /** Collector base URL; the signal path is appended. */
  readonly endpoint: string;
  readonly fetch: typeof fetch;
  /** Extra headers, such as an authorization token. Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * An optional OTLP/HTTP sink.
 *
 * One POST per signal the batch actually contains, to that signal's path. A batch
 * with no spans makes no trace request, so an idle server does not post empty
 * bodies. A refused or failed destination throws, once, so the exporter counts a
 * failed batch and retries it rather than believing a silent sink.
 */
export function createOtlpSink(
  options: OtlpSinkOptions,
): ExportSink<TelemetryRecord> {
  const tracesUrl = otlpSignalUrl(options.endpoint, "traces");
  const metricsUrl = otlpSignalUrl(options.endpoint, "metrics");
  return async (batch, signal) => {
    if (signal.aborted) return;
    const posts: { url: string; body: unknown }[] = [];
    if (batch.some((record) => record.kind === "event")) {
      // A signal-specific endpoint cannot serve the other signal; a hand-built
      // sink posting there still reaches the URL the operator gave.
      posts.push({
        url: tracesUrl ?? options.endpoint,
        body: encodeOtlpTraces(batch),
      });
    }
    if (batch.some((record) => record.kind === "metrics")) {
      posts.push({
        url: metricsUrl ?? options.endpoint,
        body: encodeOtlpMetrics(batch),
      });
    }

    const failures: unknown[] = [];
    await Promise.all(posts.map(async ({ url, body }) => {
      try {
        const response = await options.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...options.headers,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          failures.push(new Error(`OTLP_DESTINATION_${response.status}`));
        }
      } catch (error) {
        failures.push(error);
      }
    }));
    if (failures.length > 0) throw failures[0];
  };
}

/** Per-destination counters, so a broken destination is visible as itself. */
export type TelemetrySinkStats = {
  readonly sent: number;
  readonly failed: number;
};

export type TelemetrySinkOptions = {
  readonly log?: ExportSink<TelemetryRecord>;
  readonly otlp?: ExportSink<TelemetryRecord>;
  /** Called once per destination failure, so it can be counted as a metric. */
  readonly onDestinationFailure?: (
    destination: "log" | "otlp",
    error: unknown,
  ) => void;
};

export type TelemetrySink = ExportSink<TelemetryRecord> & {
  /** Counters per destination. One total would hide which one is broken. */
  stats(): Readonly<Record<"log" | "otlp", TelemetrySinkStats>>;
};

/**
 * Fans one batch out to every configured destination.
 *
 * Each destination is attempted and counted independently, because "telemetry is
 * failing" and "the log directory is full while OTLP is fine" call for different
 * responses. A failure in one does not stop the other: a full disk must not cost
 * the collector its batch.
 *
 * The batch is reported lost only if **every** destination failed, which is what
 * the exporter's counter means, and it is thrown once rather than once per
 * destination so one batch cannot inflate the loss count.
 */
export function createTelemetrySink(
  options: TelemetrySinkOptions,
): TelemetrySink {
  const destinations: ["log" | "otlp", ExportSink<TelemetryRecord>][] = [];
  if (options.log !== undefined) destinations.push(["log", options.log]);
  if (options.otlp !== undefined) destinations.push(["otlp", options.otlp]);

  const counters: Record<"log" | "otlp", { sent: number; failed: number }> = {
    log: { sent: 0, failed: 0 },
    otlp: { sent: 0, failed: 0 },
  };

  const send: ExportSink<TelemetryRecord> = async (batch, signal) => {
    if (destinations.length === 0) return;
    let failed = 0;
    let firstError: unknown;
    for (const [name, sink] of destinations) {
      try {
        await sink(batch, signal);
        counters[name].sent += 1;
      } catch (error) {
        counters[name].failed += 1;
        failed += 1;
        firstError ??= error;
        options.onDestinationFailure?.(name, error);
      }
    }
    if (failed === destinations.length) throw firstError;
  };

  return Object.assign(send, {
    stats: () => ({
      log: { ...counters.log },
      otlp: { ...counters.otlp },
    }),
  });
}
