import { assertEquals, assertFalse, assertNotEquals } from "@std/assert";
import {
  sanitizeSentryError,
  sanitizeSentrySpan,
} from "../../packages/config/src/sentry-privacy.ts";

type ErrorEvent = Parameters<typeof sanitizeSentryError>[0];
type StreamedSpanJSON = Parameters<typeof sanitizeSentrySpan>[0];

Deno.test("error telemetry excludes content and credentials while preserving source locations and trace linkage", () => {
  const secret = "SENSITIVE_SENTINEL_123";
  const event: ErrorEvent = {
    type: undefined,
    request: {
      url: `https://example.com/task?prompt=${secret}`,
      headers: { Authorization: secret },
      data: secret,
    },
    user: { email: secret, ip_address: secret },
    extra: { prompt: secret },
    tags: { task: secret },
    fingerprint: ["bakery", "query", secret],
    breadcrumbs: [{ message: secret }],
    contexts: {
      trace: {
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
        data: { prompt: secret },
      },
      arbitrary: { content: secret },
    },
    exception: {
      values: [{
        type: "Error",
        value: secret,
        stacktrace: {
          frames: [{
            filename:
              `https://key:${secret}@example.com/assets/main.js?secret=${secret}`,
            function: "submitTask",
            lineno: 12,
            colno: 4,
            in_app: true,
            vars: { prompt: secret },
            context_line: secret,
          }],
        },
      }],
    },
    debug_meta: {
      images: [{
        type: "sourcemap",
        debug_id: "01234567-89ab-4cde-89ab-0123456789ab",
        code_file: `https://example.com/assets/main.js?secret=${secret}`,
      }],
    },
  };
  const sanitized = sanitizeSentryError(event, "web");
  assertFalse(JSON.stringify(sanitized).includes(secret));
  assertEquals(sanitized.contexts?.trace?.trace_id, "a".repeat(32));
  assertEquals(sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0], {
    filename: "https://example.com/assets/main.js",
    function: "submitTask",
    lineno: 12,
    colno: 4,
    in_app: true,
    debug_id: undefined,
  });
  assertEquals(
    sanitized.debug_meta?.images?.[0]?.debug_id,
    "01234567-89ab-4cde-89ab-0123456789ab",
  );
});

Deno.test("streamed spans retain timing and linkage without sensitive names or attributes", () => {
  const secret = "SENSITIVE_SENTINEL_123";
  const span: StreamedSpanJSON = {
    trace_id: "a".repeat(32),
    span_id: "b".repeat(16),
    parent_span_id: "c".repeat(16),
    name: secret,
    start_timestamp: 100,
    end_timestamp: 102,
    status: "ok",
    is_segment: true,
    attributes: {
      "sentry.op": "queue.process",
      "sentry.sample_rate": secret,
      "sentry.kind": secret,
      "gen_ai.input.messages": secret,
      "http.url": secret,
      "db.query.text": secret,
      leaseToken: secret,
    },
  };
  const sanitized = sanitizeSentrySpan(span, undefined, {
    environment: "preview",
    release: "bakery@test-release",
    service: "worker",
  });
  assertFalse(JSON.stringify(sanitized).includes(secret));
  assertEquals(sanitized.name, "Execute worker assignment");
  assertEquals(sanitized.end_timestamp, 102);
  assertEquals(sanitized.parent_span_id, "c".repeat(16));
  assertEquals(sanitized.attributes["sentry.op"], "queue.process");
  assertEquals(sanitized.attributes["sentry.environment"], "preview");
  assertEquals(sanitized.attributes["sentry.release"], "bakery@test-release");
  assertEquals(sanitized.attributes["service.name"], "worker");
  assertEquals(sanitized.attributes["sentry.segment.id"], span.span_id);
});

Deno.test("navigation names survive only when supplied by static application routes", () => {
  const span: StreamedSpanJSON = {
    trace_id: "a".repeat(32),
    span_id: "b".repeat(16),
    name: "/tasks/$taskId",
    start_timestamp: 100,
    status: "ok",
    is_segment: true,
    attributes: { "sentry.op": "navigation" },
  };
  const names = new Set(["/tasks/$taskId"]);
  assertEquals(sanitizeSentrySpan(span, names).name, "/tasks/$taskId");
  assertEquals(
    sanitizeSentrySpan({ ...span, name: "/tasks/private-content" }, names).name,
    "Page navigation",
  );
});

Deno.test("only shaped attribution tags survive, and never other tag content", () => {
  const secret = "SENSITIVE_SENTINEL_123";
  const sanitized = sanitizeSentryError({
    type: undefined,
    tags: {
      service: "web",
      "bakery.source": "query",
      "bakery.operation": "tasks.list",
      "user.email": secret,
      "bakery.operation.extra": secret,
    },
  }, "web");
  assertEquals(sanitized.tags, {
    service: "web",
    "bakery.source": "query",
    "bakery.operation": "tasks.list",
  });
  assertEquals(
    sanitizeSentryError({
      type: undefined,
      tags: {
        service: "web",
        "bakery.source": secret,
        "bakery.operation": secret,
      },
    }, "web").tags,
    { service: "web" },
  );
});

Deno.test("the grouping identity of a handled failure survives the filter, so one operation is one issue", () => {
  const sanitized = sanitizeSentryError({
    type: undefined,
    tags: { "bakery.source": "query", "bakery.operation": "tasks.list" },
    fingerprint: ["bakery", "query", "tasks.list"],
  }, "web");
  assertEquals(sanitized.fingerprint, ["bakery", "query", "tasks.list"]);
  // Two operations that share this one call site and redacted message are only
  // distinguishable as separate issues because the fingerprint survived.
  assertNotEquals(
    sanitizeSentryError({
      type: undefined,
      fingerprint: ["bakery", "query", "tasks.get"],
    }, "web").fingerprint,
    sanitized.fingerprint,
  );
});

Deno.test("a fingerprint outside the client's allowed shape is dropped rather than grouped on", () => {
  const secret = "SENSITIVE_SENTINEL_123";
  for (
    const fingerprint of [
      ["bakery", "query", `tasks.list?prompt=${secret}`],
      ["bakery", secret, "tasks.list"],
      [secret, "query", "tasks.list"],
      ["bakery", "query"],
      ["bakery", "query", "tasks.list", secret],
      [secret],
    ]
  ) {
    const sanitized = sanitizeSentryError({
      type: undefined,
      fingerprint,
    }, "web");
    assertEquals(sanitized.fingerprint, undefined);
    assertFalse(JSON.stringify(sanitized).includes(secret));
  }
  assertEquals(
    sanitizeSentryError({ type: undefined }, "web").fingerprint,
    undefined,
  );
});
