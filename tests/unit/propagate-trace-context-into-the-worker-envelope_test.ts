import { assert, assertEquals } from "@std/assert";
import {
  childTraceContext,
  formatTraceparent,
  parseTraceparent,
} from "@bakery/config/telemetry-trace";
import { traceEnvironment } from "../../apps/worker/src/harness-common.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { assignmentTraceparent } from "../../apps/server/src/modules/execution/claim-application.ts";

/**
 * W3C propagation into the worker envelope (#23, slice 3).
 *
 * The outbox half already existed: `domain_events.traceparent` and its
 * integration test. The gap was the worker's claim envelope — `JobAssignment`
 * carried `traceId` but no W3C context, so every harness subprocess started an
 * unrelated trace and an operator could not follow one request into the work it
 * caused.
 */

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const CALLER_SPAN = "b7ad6b7169203331";

Deno.test("a harness child inherits the trace context as TRACEPARENT", () => {
  // TRACEPARENT is the W3C convention for handing a context to a child process.
  // Following it is what lets a harness's own spans join the caller's trace.
  const traceparent = formatTraceparent(childTraceContext({
    traceId: TRACE,
    spanId: CALLER_SPAN,
    sampled: true,
  }));
  assertEquals(traceEnvironment({ traceparent }), { TRACEPARENT: traceparent });
});

Deno.test("an assignment without context adds no variable at all", () => {
  // An empty map means callers can spread it unconditionally, and a harness sees
  // no TRACEPARENT rather than an empty one it would fail to parse.
  assertEquals(traceEnvironment({}), {});
  assertEquals(traceEnvironment({ traceparent: undefined }), {});
});

Deno.test("the envelope's traceparent is a child of the caller's span", () => {
  // A claim is one leg of work inside the caller's trace. Reusing the caller's
  // span id would make the worker's span indistinguishable from the request's,
  // so the envelope must carry the same trace id and a different span id.
  const child = childTraceContext({
    traceId: TRACE,
    spanId: CALLER_SPAN,
    sampled: true,
  });
  const parsed = parseTraceparent(formatTraceparent(child));
  assert(parsed !== undefined, "a well-formed context was not produced");
  assertEquals(parsed.traceId, TRACE);
  assert(parsed.spanId !== CALLER_SPAN, "the worker reuses the caller's span");
  assertEquals(parsed.sampled, true);
});

Deno.test("the generated contract refuses a malformed trace context", () => {
  // The wire type is the guard: a worker that receives junk would either drop it
  // or join an unrelated trace, so the envelope cannot carry it at all. Proven
  // against the generated schema, not a copy of the regex.
  const schema = contractSchemas.JobAssignment;
  const shape = schema as unknown as {
    shape: Record<
      string,
      { safeParse: (value: unknown) => { success: boolean } }
    >;
  };
  const field = shape.shape.traceparent;
  assert(field !== undefined, "the envelope has no traceparent field");

  for (
    const bad of [
      "",
      "not-a-traceparent",
      // A future version is not read by guessing.
      `01-${TRACE}-${CALLER_SPAN}-01`,
      // Uppercase hex is not the W3C layout.
      `00-${TRACE.toUpperCase()}-${CALLER_SPAN}-01`,
      // A flag other than 00 or 01.
      `00-${TRACE}-${CALLER_SPAN}-02`,
      // A truncated span id.
      `00-${TRACE}-${CALLER_SPAN.slice(0, 8)}-01`,
    ]
  ) {
    assert(
      field.safeParse(bad).success === false,
      `the envelope accepted ${JSON.stringify(bad)}`,
    );
  }
  assert(
    field.safeParse(`00-${TRACE}-${CALLER_SPAN}-01`).success,
    "the envelope refused a valid context",
  );
});

Deno.test("a claim continues the caller's trace in a new span", () => {
  // The server path, not the helper: a head that reused the caller's span, or
  // one that ignored the header entirely, both fail here.
  const traced = parseTraceparent(
    assignmentTraceparent(
      new Headers({ traceparent: `00-${TRACE}-${CALLER_SPAN}-01` }),
    ),
  );
  assert(traced !== undefined, "the claim produced no usable context");
  assertEquals(traced.traceId, TRACE);
  assert(traced.spanId !== CALLER_SPAN, "the claim reuses the caller's span");
  assertEquals(traced.sampled, true);
});

Deno.test("a claim with no context still produces a frozen root trace", () => {
  // Refusing work over a missing tracing header would be a worse failure than a
  // broken trace, so an absent header yields a fresh root instead of an error.
  const fresh = parseTraceparent(assignmentTraceparent(new Headers()));
  assert(fresh !== undefined, "a claim with no header produced no context");
  assertEquals(fresh.spanId.length, 16);
});

Deno.test("a malformed header is replaced, never echoed into the envelope", () => {
  // The caller's bytes must not reach the worker: a junk header is dropped, and
  // what replaces it is a well-formed context of our own.
  const hostile = "00-zzzz-not-a-trace-parent-01";
  const produced = assignmentTraceparent(new Headers({ traceparent: hostile }));
  assert(produced.includes(hostile) === false, "the hostile header was echoed");
  assert(
    parseTraceparent(produced) !== undefined,
    "no valid context replaced it",
  );
});
