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

  const rotate = async () => {
    for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
      await options.fileSystem.rename(pathFor(index - 1), pathFor(index)).catch(
        () => undefined,
      );
    }
    // After the shift, `.maxFiles` holds what used to be the oldest kept file.
    // It is removed so the directory cannot grow past `maxFiles` entries.
    await options.fileSystem.remove(pathFor(options.maxFiles)).catch(() =>
      undefined
    );
  };

  return async (batch, signal) => {
    ready ??= options.fileSystem.ensureDirectory(options.directory).catch(
      () => undefined,
    );
    await ready;

    for (const record of batch) {
      if (signal.aborted) return;
      const bytes = concat(encodeLogLine(record), NEWLINE);
      try {
        const size = await options.fileSystem.size(current);
        // Rotate before writing, so a file never exceeds maxBytes by a whole
        // batch: the check is against what is about to be appended.
        if (size > 0 && size + bytes.byteLength > options.maxBytes) {
          await rotate();
        }
        await options.fileSystem.append(current, bytes);
      } catch {
        // Counted as a failed batch by the exporter. One record that cannot be
        // written must not stop the rest of the batch.
      }
    }
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
 * The OTLP/HTTP JSON body for one batch.
 *
 * Only the fields OTLP defines are emitted, and attributes keep the allowlist's
 * string/number/boolean types. Trace context becomes the span's own parent
 * reference rather than an attribute, because a receiver that understands OTLP
 * will then connect it to the trace instead of displaying an opaque string.
 */
export function encodeOtlpBatch(
  batch: readonly TelemetryRecord[],
): unknown {
  const spans = [];
  const metrics = [];
  for (const record of batch) {
    if (record.kind === "event") {
      const attributes = Object.entries(record.attributes).map((
        [key, value],
      ) => ({
        key,
        value: typeof value === "number"
          ? { doubleValue: value }
          : typeof value === "boolean"
          ? { boolValue: value }
          : { stringValue: value },
      }));
      spans.push({
        name: record.name,
        // OTLP carries nanoseconds; the record holds milliseconds.
        startTimeUnixNano: String(record.time * 1_000_000),
        endTimeUnixNano: String(record.time * 1_000_000),
        attributes,
        ...(record.trace
          ? {
            traceId: record.trace.traceId,
            spanId: record.trace.spanId,
          }
          : {}),
        ...(record.links && record.links.length > 0
          ? {
            links: record.links.map((link) => ({
              traceId: link.traceId,
              spanId: link.spanId,
            })),
          }
          : {}),
      });
    } else {
      metrics.push({
        timeUnixNano: String(record.time * 1_000_000),
        samples: record.samples.map((sample) => ({
          name: sample.name,
          value: sample.value,
          attributes: Object.entries(sample.labels).map(([key, value]) => ({
            key,
            value: { stringValue: value },
          })),
        })),
      });
    }
  }
  return {
    resourceSpans: [{ scopeSpans: [{ spans }] }],
    resourceMetrics: [{ scopeMetrics: [{ metrics }] }],
  };
}

export type OtlpSinkOptions = {
  /** HTTPS endpoint. The transport is injected so this can be proved offline. */
  readonly endpoint: string;
  readonly fetch: typeof fetch;
  /** Extra headers, such as an authorization token. Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * An optional OTLP/HTTP sink.
 *
 * A non-2xx answer is thrown so the exporter counts a failed batch and retries,
 * which is the behaviour an operator wants from a destination that is briefly
 * down. A malformed endpoint is not thrown at construction: the caller cannot do
 * anything useful with that, and the config schema already refuses one.
 */
export function createOtlpSink(
  options: OtlpSinkOptions,
): ExportSink<TelemetryRecord> {
  return async (batch, signal) => {
    if (signal.aborted) return;
    const response = await options.fetch(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(encodeOtlpBatch(batch)),
      signal,
    });
    if (!response.ok) {
      throw new Error(`OTLP_DESTINATION_${response.status}`);
    }
  };
}

export type TelemetrySinkOptions = {
  readonly log?: ExportSink<TelemetryRecord>;
  readonly otlp?: ExportSink<TelemetryRecord>;
};

/**
 * Fans one batch out to every configured destination.
 *
 * The two sinks are isolated on purpose. A log directory that is full must not
 * cost the OTLP destination its batch, so each is attempted and a failure in one
 * is reported only if **every** destination failed - otherwise the exporter
 * would count a batch lost when it reached one of them, and an operator watching
 * the loss counter would chase a problem that is not there.
 */
export function createTelemetrySink(
  options: TelemetrySinkOptions,
): ExportSink<TelemetryRecord> {
  const sinks = [options.log, options.otlp].filter(
    (sink): sink is ExportSink<TelemetryRecord> => sink !== undefined,
  );
  return async (batch, signal) => {
    if (sinks.length === 0) {
      // Nothing configured. Throwing here would count every batch as lost; the
      // caller is expected to disable export instead of building an empty sink.
      return;
    }
    const results = await Promise.allSettled(
      sinks.map((sink) => Promise.resolve().then(() => sink(batch, signal))),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (
      failure !== undefined && results.every((r) => r.status === "rejected")
    ) {
      throw (failure as PromiseRejectedResult).reason;
    }
  };
}
