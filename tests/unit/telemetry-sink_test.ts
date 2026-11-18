import { assert, assertEquals } from "@std/assert";
import {
  createLogSink,
  createOtlpSink,
  createRotatingLogSink,
  createTelemetrySink,
  encodeLogLine,
  encodeOtlpBatch,
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

Deno.test("a rotation that cannot rename still writes the current file", async () => {
  // A telemetry sink that stops writing because a rename failed turns a
  // filesystem problem into a telemetry outage. The gap is counted; the outage
  // would not be.
  const fileSystem = memoryFileSystem();
  fileSystem.rename = () => Promise.reject(new Error("EBUSY"));
  const sink = createRotatingLogSink({
    directory: "/var/log/bakery",
    maxBytes: 100,
    maxFiles: 2,
    fileSystem,
  });
  await sink(Array.from({ length: 5 }, () => eventRecord()), signal());
  const current = fileSystem.files.get("/var/log/bakery/telemetry.ndjson");
  assert(current !== undefined);
  assert(current.byteLength > 100);
});

Deno.test("a write that throws does not escape the sink", async () => {
  // The exporter catches, but a sink throwing from inside its own catch is how
  // telemetry becomes an execution failure. Absorbing here is what makes that
  // impossible rather than unlikely.
  const sink = createRotatingLogSink({
    directory: "/var/log/bakery",
    maxBytes: 400,
    maxFiles: 2,
    fileSystem: {
      ...memoryFileSystem(),
      append: () => Promise.reject(new Error("ENOSPC")),
      size: () => Promise.reject(new Error("EIO")),
      ensureDirectory: () => Promise.reject(new Error("EACCES")),
    },
  });
  await sink([eventRecord(), eventRecord()], signal());
});

Deno.test("the OTLP body carries trace context as a reference, not a string attribute", () => {
  const body = encodeOtlpBatch([
    eventRecord({
      trace: {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        sampled: true,
      },
      links: [{
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
      }],
    }),
    {
      kind: "metrics",
      time: 1_700_000_000_001,
      samples: [
        {
          name: "bakery_queue_age_seconds",
          kind: "gauge",
          value: 3,
          labels: { state: "queued" },
        },
      ],
    },
  ]) as {
    resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    resourceMetrics: {
      scopeMetrics: { metrics: Record<string, unknown>[] }[];
    }[];
  };

  const span = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  assertEquals(span.traceId, "0af7651916cd43dd8448eb211c80319c");
  assertEquals(span.spanId, "b7ad6b7169203331");
  // The trace id must not ALSO appear as an attribute: a receiver would show it
  // twice and connect the span to nothing.
  const attributeKeys = (span.attributes as { key: string }[]).map((a) =>
    a.key
  );
  assertEquals(attributeKeys.includes("traceId"), false);
  assertEquals(attributeKeys.includes("trace_id"), false);
  assertEquals((span.links as unknown[]).length, 1);

  const metric = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!;
  assertEquals(
    (metric.samples as { name: string }[])[0]!.name,
    "bakery_queue_age_seconds",
  );
});

Deno.test("an OTLP destination that answers badly fails the batch so it is retried", async () => {
  const sink = createOtlpSink({
    endpoint: "https://collector.example.test/v1/traces",
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

Deno.test("an OTLP destination that is unreachable surfaces the failure, and an abort does not send", async () => {
  const sink = createOtlpSink({
    endpoint: "https://collector.example.test/v1/traces",
    fetch: (() => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });
  let threw = false;
  try {
    await sink([eventRecord()], signal());
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  // Aborted before the call: nothing is attempted.
  let called = 0;
  const controller = new AbortController();
  controller.abort();
  const counting = createOtlpSink({
    endpoint: "https://collector.example.test/v1/traces",
    fetch: (() => {
      called += 1;
      return Promise.resolve(new Response("", { status: 200 }));
    }) as typeof fetch,
  });
  await counting([eventRecord()], controller.signal);
  assertEquals(called, 0);
});

Deno.test("one failed destination does not cost the other its batch", async () => {
  // A full log directory must not lose the OTLP batch. Counting a batch lost when
  // it reached one destination would send an operator chasing a problem that is
  // not there.
  let logged = 0;
  const sink = createTelemetrySink({
    log: (batch) => {
      logged += batch.length;
    },
    otlp: () => Promise.reject(new Error("503")),
  });
  await sink([eventRecord()], signal());
  assertEquals(logged, 1);
});

Deno.test("the batch counts as lost only when every destination failed", async () => {
  const sink = createTelemetrySink({
    log: () => Promise.reject(new Error("ENOSPC")),
    otlp: () => Promise.reject(new Error("503")),
  });
  let threw = false;
  try {
    await sink([eventRecord()], signal());
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("a sink with no destinations sends nothing and throws nothing", async () => {
  // Building an empty sink is a caller mistake, but it must not look like a loss
  // on every batch: the exporter's disabled state is the honest representation.
  const sink = createTelemetrySink({});
  await sink([eventRecord()], signal());
});
