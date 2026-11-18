import { assert, assertEquals } from "@std/assert";
import {
  createLogSink,
  createOtlpSink,
  createRotatingLogSink,
  createTelemetrySink,
  encodeLogLine,
  encodeOtlpMetrics,
  encodeOtlpTraces,
  otlpSignalUrl,
  type RotatingLogFileSystem,
} from "../../apps/server/src/platform/telemetry-sink.ts";
import type { TelemetryRecord } from "@bakery/config/telemetry";

/**
 * The sink is where redacted telemetry actually leaves the process (#23).
 *
 * Two properties are worth more than the rest and are asserted first: it writes
 * exactly the fields it was handed and nothing else, and no failure inside it
 * can reach the code being observed.
 */

function eventRecord(
  overrides: Partial<Extract<TelemetryRecord, { kind: "event" }>> = {},
): TelemetryRecord {
  return {
    kind: "event",
    name: "bakery.job.completed",
    time: 1_700_000_000_000,
    attributes: { action: "work.run", outcome: "completed", attempts: 2 },
    ...overrides,
  };
}

function memoryFileSystem(): RotatingLogFileSystem & {
  readonly files: Map<string, Uint8Array>;
  readonly renames: [string, string][];
} {
  const files = new Map<string, Uint8Array>();
  const renames: [string, string][] = [];
  return {
    files,
    renames,
    append(path, bytes) {
      const existing = files.get(path) ?? new Uint8Array();
      const next = new Uint8Array(existing.byteLength + bytes.byteLength);
      next.set(existing, 0);
      next.set(bytes, existing.byteLength);
      files.set(path, next);
      return Promise.resolve();
    },
    size(path) {
      return Promise.resolve(files.get(path)?.byteLength ?? 0);
    },
    rename(from, to) {
      const existing = files.get(from);
      if (existing === undefined) return Promise.reject(new Error("ENOENT"));
      files.set(to, existing);
      files.delete(from);
      renames.push([from, to]);
      return Promise.resolve();
    },
    remove(path) {
      files.delete(path);
      return Promise.resolve();
    },
    ensureDirectory() {
      return Promise.resolve();
    },
  };
}

const signal = () => new AbortController().signal;

Deno.test("a log line is one line, whatever the values contain", () => {
  // A newline inside a value would split one record across two log lines, and a
  // log reader would then count two events where there was one.
  const line = encodeLogLine(
    eventRecord({ attributes: { action: "a\nb", outcome: "c\r\nd" } }),
  );
  const text = new TextDecoder().decode(line);
  assertEquals(text.includes("\n"), false);
  assertEquals(text.includes("\r"), false);

  const parsed = JSON.parse(text);
  assertEquals(parsed.name, "bakery.job.completed");
  assertEquals(parsed.attributes.action, "a\nb");
});

Deno.test("the log sink writes only the fields it was given", async () => {
  // The allowlist ran upstream. A sink that added a field would be a second,
  // unnoticed redaction boundary - and the one that leaks.
  const written: string[] = [];
  const sink = createLogSink((line) => {
    written.push(new TextDecoder().decode(line));
  });
  await sink([eventRecord()], signal());

  const parsed = JSON.parse(written.join(""));
  assertEquals(
    Object.keys(parsed).sort(),
    ["attributes", "kind", "name", "time"],
  );
  assertEquals(Object.keys(parsed.attributes).sort(), [
    "action",
    "attempts",
    "outcome",
  ]);
});

Deno.test("the log sink stops at an aborted signal instead of writing the batch", async () => {
  const written: string[] = [];
  const controller = new AbortController();
  controller.abort();
  const sink = createLogSink((line) => {
    written.push(new TextDecoder().decode(line));
  });
  await sink([eventRecord(), eventRecord()], controller.signal);
  assertEquals(written.length, 0);
});

Deno.test("rotation keeps the directory bounded and never exceeds a file's cap", async () => {
  const fileSystem = memoryFileSystem();
  const sink = createRotatingLogSink({
    directory: "/var/log/bakery",
    maxBytes: 400,
    maxFiles: 3,
    fileSystem,
  });

  // Enough records to force several rotations. Each record is ~110 bytes, so 40
  // of them is well past three files' worth.
  const batch = Array.from({ length: 40 }, () => eventRecord());
  await sink(batch, signal());

  // At most maxFiles entries exist, and none of them exceeds the cap.
  assert(
    fileSystem.files.size <= 3,
    `expected at most 3 files, found ${fileSystem.files.size}`,
  );
  for (const [path, bytes] of fileSystem.files) {
    assert(
      bytes.byteLength <= 400,
      `${path} is ${bytes.byteLength} bytes, over the 400-byte cap`,
    );
  }
  // And nothing was lost silently: the newest file has content.
  const current = fileSystem.files.get("/var/log/bakery/telemetry.ndjson");
  assert(current !== undefined && current.byteLength > 0);
});

Deno.test("a rotation that cannot rename stops the batch instead of growing past the cap", async () => {
  // Keeping the disk bounded is the whole point of rotating. Appending past the
  // cap because a rename failed trades that bound for logs nobody can find, so
  // the batch stops, the exporter counts it failed, and the cap holds.
  const fileSystem = memoryFileSystem();
  fileSystem.rename = () => Promise.reject(new Error("EBUSY"));
  const sink = createRotatingLogSink({
    directory: "/var/log/bakery",
    maxBytes: 400,
    maxFiles: 2,
    fileSystem,
  });
  await sink(Array.from({ length: 40 }, () => eventRecord()), signal());
  for (const [path, bytes] of fileSystem.files) {
    assert(
      bytes.byteLength <= 400,
      `${path} is ${bytes.byteLength} bytes, over the 400-byte cap`,
    );
  }
});

Deno.test("a collector base resolves to one URL per signal, and a signal URL is refused", () => {
  // OTLP/HTTP has one path per signal. A single URL cannot serve both, so an
  // endpoint that already names a signal is refused rather than quietly
  // dropping the other half of the telemetry.
  assertEquals(
    otlpSignalUrl("https://collector.test", "traces"),
    "https://collector.test/v1/traces",
  );
  assertEquals(
    otlpSignalUrl("https://collector.test/", "metrics"),
    "https://collector.test/v1/metrics",
  );
  assertEquals(
    otlpSignalUrl("https://collector.test/v1", "traces"),
    "https://collector.test/v1/traces",
  );
  assertEquals(
    otlpSignalUrl("https://collector.test/v1/traces", "traces"),
    undefined,
  );
});

Deno.test("every span carries the ids OTLP requires, including one with no trace", () => {
  // A span without a trace and span id is invalid and a real collector rejects
  // the batch. A record with no W3C context becomes its own root instead.
  const body = encodeOtlpTraces([
    eventRecord(),
    eventRecord({
      trace: {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        sampled: true,
      },
    }),
  ]) as {
    resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
  };
  const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
  assertEquals(spans.length, 2);

  const [bare, traced] = spans;
  assertEquals(/^[0-9a-f]{32}$/.test(bare!.traceId as string), true);
  assertEquals(/^[0-9a-f]{16}$/.test(bare!.spanId as string), true);
  // The synthesized ids are a real root, not the all-zero id.
  assertEquals(bare!.traceId === "0".repeat(32), false);
  assertEquals(bare!.spanId === "0".repeat(16), false);

  // The record's own context is used when it has one.
  assertEquals(traced!.traceId, "0af7651916cd43dd8448eb211c80319c");
  assertEquals(traced!.spanId, "b7ad6b7169203331");
  assertEquals(traced!.kind, 1);
  // The trace id must not also appear as an attribute: a collector would show it
  // twice and connect the span to nothing.
  const keys = (traced!.attributes as { key: string }[]).map((a) => a.key);
  assertEquals(keys.includes("traceId"), false);
  assertEquals(keys.includes("trace_id"), false);
});

Deno.test("metrics are grouped once per instrument, as a gauge or a monotonic sum", () => {
  // OTLP defines a metric once and carries the series as its data points.
  // Emitting one metric per sample describes the same instrument many times, and
  // a counter is a monotonic cumulative sum rather than a flag.
  const body = encodeOtlpMetrics([
    {
      kind: "metrics",
      time: 1_700_000_000_000,
      samples: [
        {
          name: "bakery_queue_age_seconds",
          kind: "gauge",
          value: 3,
          labels: { state: "queued" },
        },
        {
          name: "bakery_queue_age_seconds",
          kind: "gauge",
          value: 5,
          labels: { state: "running" },
        },
        { name: "bakery_jobs_total", kind: "counter", value: 7, labels: {} },
      ],
    },
  ]) as {
    resourceMetrics: {
      scopeMetrics: { metrics: Record<string, unknown>[] }[];
    }[];
  };
  const metrics = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
  assertEquals(metrics.length, 2, "one metric per instrument, not per sample");

  const gauge = metrics.find((m) => m.name === "bakery_queue_age_seconds")!;
  const gaugePoints = (gauge.gauge as { dataPoints: unknown[] }).dataPoints;
  assertEquals(gaugePoints.length, 2);
  assertEquals(gauge.sum, undefined);

  const counter = metrics.find((m) => m.name === "bakery_jobs_total")!;
  const sum = counter.sum as {
    dataPoints: unknown[];
    isMonotonic: boolean;
    aggregationTemporality: number;
  };
  assertEquals(sum.isMonotonic, true);
  assertEquals(sum.aggregationTemporality, 2);
  assertEquals(counter.gauge, undefined);
});

Deno.test("the OTLP sink posts each signal to its own path, and only when it has one", async () => {
  // Posting resourceSpans and resourceMetrics in one body to one URL is rejected
  // by every real collector - that was the defect this test exists for.
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const sink = createOtlpSink({
    endpoint: "https://collector.test",
    fetch: ((url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch,
  });

  await sink([eventRecord()], signal());
  assertEquals(calls.length, 1, "an event batch makes one trace request");
  assertEquals(calls[0]!.url, "https://collector.test/v1/traces");
  assertEquals(calls[0]!.body.resourceMetrics, undefined);

  calls.length = 0;
  await sink([{
    kind: "metrics",
    time: 1_700_000_000_000,
    samples: [{
      name: "bakery_jobs_total",
      kind: "counter",
      value: 1,
      labels: {},
    }],
  }], signal());
  assertEquals(calls.length, 1, "a metric batch makes one metric request");
  assertEquals(calls[0]!.url, "https://collector.test/v1/metrics");
  assertEquals(calls[0]!.body.resourceSpans, undefined);
});

Deno.test("an OTLP destination that answers badly fails the batch so it is retried", async () => {
  const sink = createOtlpSink({
    endpoint: "https://collector.test",
    fetch: (() =>
      Promise.resolve(new Response("nope", { status: 503 }))) as typeof fetch,
  });
  let threw = false;
  try {
    await sink([eventRecord()], signal());
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("an abort sends nothing", async () => {
  let called = 0;
  const controller = new AbortController();
  controller.abort();
  const sink = createOtlpSink({
    endpoint: "https://collector.test",
    fetch: (() => {
      called += 1;
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch,
  });
  await sink([eventRecord()], controller.signal);
  assertEquals(called, 0);
});

Deno.test("one failed destination does not cost the other its batch, and both are counted", async () => {
  // "telemetry is failing" and "the log directory is full while OTLP is fine"
  // call for different responses, so the counters are per destination.
  let logged = 0;
  const failures: string[] = [];
  const sink = createTelemetrySink({
    log: (batch) => {
      logged += batch.length;
    },
    otlp: () => Promise.reject(new Error("503")),
    onDestinationFailure: (destination) => {
      failures.push(destination);
    },
  });
  await sink([eventRecord()], signal());
  assertEquals(logged, 1);
  assertEquals(sink.stats().log.sent, 1);
  assertEquals(sink.stats().log.failed, 0);
  assertEquals(sink.stats().otlp.failed, 1);
  assertEquals(failures, ["otlp"]);
});

Deno.test("the batch counts as lost once, when every destination failed", async () => {
  const failures: string[] = [];
  const sink = createTelemetrySink({
    log: () => Promise.reject(new Error("ENOSPC")),
    otlp: () => Promise.reject(new Error("503")),
    onDestinationFailure: (destination) => {
      failures.push(destination);
    },
  });
  let threw = 0;
  try {
    await sink([eventRecord()], signal());
  } catch {
    threw += 1;
  }
  // Thrown once, not once per destination: one batch must not inflate the
  // exporter's loss count by the number of destinations.
  assertEquals(threw, 1);
  assertEquals(failures, ["log", "otlp"]);
  assertEquals(sink.stats().log.failed, 1);
  assertEquals(sink.stats().otlp.failed, 1);
});

Deno.test("a sink with no destinations sends nothing and throws nothing", async () => {
  // Building an empty sink is a caller mistake, but it must not look like a loss
  // on every batch: the exporter's disabled state is the honest representation.
  const sink = createTelemetrySink({});
  await sink([eventRecord()], signal());
  assertEquals(sink.stats().otlp.sent, 0);
});

Deno.test("a write failure is reported once, not swallowed", async () => {
  // Swallowing it would make a permanently full disk indistinguishable from an
  // idle server, and failedBatches would never see it.
  const sink = createRotatingLogSink({
    directory: "/var/log/bakery",
    maxBytes: 400,
    maxFiles: 2,
    fileSystem: {
      ...memoryFileSystem(),
      append: () => Promise.reject(new Error("ENOSPC")),
    },
  });
  let threw = false;
  try {
    await sink([eventRecord(), eventRecord()], signal());
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
