import { assert, assertEquals } from "@std/assert";
import {
  childTraceContext,
  formatTraceparent,
  parseTraceparent,
} from "@bakery/config/telemetry-trace";
import { traceEnvironment } from "../../apps/worker/src/harness-common.ts";
import { claudeChildEnvironment } from "../../apps/worker/src/claude-harness.ts";
import { codexChildEnvironment } from "../../apps/worker/src/codex-harness.ts";
import { piChildEnvironment } from "../../apps/worker/src/pi-harness.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  assignmentFromJob,
  assignmentTraceparent,
} from "../../apps/server/src/modules/execution/claim-application.ts";

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
      // W3C makes an all-zero trace id invalid: a zero id is what a writer
      // emits when it has no context, so accepting one joins a trace that does
      // not exist. This is the case a hex-count pattern lets through.
      `00-${"0".repeat(32)}-${CALLER_SPAN}-01`,
      // The same for the parent id.
      `00-${TRACE}-${"0".repeat(16)}-01`,
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

Deno.test("every adapter launches its harness with the trace", () => {
  // One test per adapter, because QA found that removing the spread from any
  // one of them survived: three adapters share one helper, but each has to
  // actually call it. Asserted on the value the launch would receive.
  const traceparent = formatTraceparent(childTraceContext({
    traceId: TRACE,
    spanId: CALLER_SPAN,
    sampled: true,
  }));
  const launched: Array<[string, Readonly<Record<string, string>>]> = [
    [
      "claude",
      claudeChildEnvironment(
        { home: "/tmp/h", path: "/tmp/h/c" },
        { traceparent },
      ),
    ],
    [
      "codex",
      codexChildEnvironment({ home: "/tmp/h", codexHome: "/tmp/h/x" }, {
        traceparent,
      }),
    ],
    [
      "pi",
      piChildEnvironment({ home: "/tmp/h", agentDir: "/tmp/h/a" }, {
        traceparent,
      }),
    ],
  ];
  for (const [name, environment] of launched) {
    assertEquals(
      environment.TRACEPARENT,
      traceparent,
      `the ${name} adapter does not launch with TRACEPARENT`,
    );
  }
});

Deno.test("the envelope continues the run's trace, not the claim's", () => {
  // QA's finding: the claim request comes from the worker and carries no
  // context, so reading inbound headers gave every assignment a fresh root and
  // the originating request vanished at the process boundary. The durable
  // source is the run's `run.requested` event.
  const runContext = `00-${TRACE}-${CALLER_SPAN}-01`;
  const produced = parseTraceparent(
    assignmentTraceparent(new Headers(), runContext),
  );
  assert(produced !== undefined, "the envelope carried no context");
  assertEquals(produced.traceId, TRACE, "the run's trace was not continued");
  assert(produced.spanId !== CALLER_SPAN, "the run's span was reused");
});

Deno.test("a run context outranks an inbound claim header", () => {
  // The originating request is the truer parent: the worker's own header would
  // otherwise become the root for work the operator never asked for.
  const runTrace = "11111111111111111111111111111111";
  const produced = parseTraceparent(
    assignmentTraceparent(
      new Headers({ traceparent: `00-${TRACE}-${CALLER_SPAN}-01` }),
      `00-${runTrace}-${CALLER_SPAN}-01`,
    ),
  );
  assertEquals(produced?.traceId, runTrace);
});

Deno.test("the built assignment carries the context onto the wire", () => {
  // QA's mutant: delete `traceparent` from the object assignmentFromJob returns
  // and every other test still passes, because they all stop at the helper. The
  // field has to be in the envelope the worker actually parses.
  const repositoryId = "77777777-7777-4777-8777-777777777777";
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    action: "quality.check",
    requirements: {},
    input: { repositoryId, revision: "base", checks: ["test"] },
    currentCheckpoints: [],
    agentConfig: {},
    skillRefs: [],
    agentVersionId: "44444444-4444-4444-8444-444444444444",
    billing: null,
    installationReservationId: null,
    agentSessionId: null,
    currentFence: "1",
    originalTraceparent: `00-${TRACE}-${CALLER_SPAN}-01`,
  };
  const built = assignmentFromJob(
    job as never,
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "1",
    "lease-token-fixture",
    1n,
    new Date("2026-01-01T00:00:00Z"),
    30,
    new Date("2026-01-01T00:00:00Z"),
    null,
    null,
    assignmentTraceparent(new Headers(), job.originalTraceparent),
  );
  const wire = (built as { traceparent?: string }).traceparent;
  assert(wire !== undefined, "the assignment has no traceparent field");
  const parsed = parseTraceparent(wire);
  assert(parsed !== undefined, "the assignment carries an unusable context");
  assertEquals(parsed.traceId, TRACE);
});

Deno.test("a resumed context writes only the 00 and 01 flag bytes", () => {
  // The wire type refuses any flag but 00/01, so a context that remembered a
  // wider flag would produce a header our own parser rejects on the way back -
  // a trace that silently breaks at the process boundary. Parsing keeps only
  // the sampled bit, and formatting writes nothing else.
  for (
    const raw of [
      `00-${TRACE}-${CALLER_SPAN}-03`,
      `00-${TRACE}-${CALLER_SPAN}-ff`,
    ]
  ) {
    const parsed = parseTraceparent(raw);
    assert(parsed !== undefined, `${raw} did not parse`);
    const written = formatTraceparent(parsed);
    assert(
      /-0[01]$/.test(written),
      `a resumed context wrote ${written.slice(-3)} instead of a 00/01 flag`,
    );
    // Only the low bit survives: 03 and ff are odd, so both resume as sampled.
    assertEquals(written.slice(-2), "01");
  }
});
