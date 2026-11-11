import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  childTraceContext,
  formatTraceparent,
  linkedContinuation,
  MAX_TRACE_LINKS,
  newTraceContext,
  parseTraceparent,
  traceLinkOf,
} from "../../packages/config/src/telemetry-trace.ts";
import {
  MAX_TELEMETRY_STRING_LENGTH,
  redactTelemetryAttributes,
  TELEMETRY_ATTRIBUTE_NAMES,
} from "../../packages/config/src/telemetry-attributes.ts";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "00f067aa0ba902b7";
const valid = `00-${traceId}-${spanId}-01`;
const uuid = "0b9a1f0e-5a3c-4c1e-8f6a-2d4b7c9e1a30";

/** Deterministic randomness: every byte comes from the supplied sequence. */
function bytesFrom(...fills: number[]) {
  let call = 0;
  return (length: number) => {
    const fill = fills[Math.min(call, fills.length - 1)];
    call += 1;
    return new Uint8Array(length).fill(fill);
  };
}

Deno.test("a version-00 traceparent yields its ids and sampled flag", () => {
  assertEquals(parseTraceparent(valid), { traceId, spanId, sampled: true });
  assertEquals(parseTraceparent(`00-${traceId}-${spanId}-00`), {
    traceId,
    spanId,
    sampled: false,
  });
  // Only the sampled bit carries meaning here; the other flag bits are ignored.
  assertEquals(parseTraceparent(`00-${traceId}-${spanId}-03`)?.sampled, true);
  assertEquals(parseTraceparent(`00-${traceId}-${spanId}-02`)?.sampled, false);
});

Deno.test("a malformed or hostile traceparent starts a new trace instead of being trusted", () => {
  const zeroTrace = "0".repeat(32);
  const zeroSpan = "0".repeat(16);
  const rejected: Array<string | null | undefined> = [
    undefined,
    null,
    "",
    "garbage",
    valid.toUpperCase(),
    `00-${traceId}-${spanId}`,
    `00-${traceId}-${spanId}-01-extra`,
    `00-${traceId}-${spanId}-01 `,
    ` ${valid}`,
    `00-${zeroTrace}-${spanId}-01`,
    `00-${traceId}-${zeroSpan}-01`,
    `ff-${traceId}-${spanId}-01`,
    `00-${traceId.slice(1)}-${spanId}-01`,
    `00-${traceId}-${spanId}0-01`,
    `00-${"g".repeat(32)}-${spanId}-01`,
    `0-${traceId}-${spanId}-01`,
    `00_${traceId}_${spanId}_01`,
    valid.replace("-01", "-1"),
    "00-" + "a".repeat(100_000),
  ];
  for (const value of rejected) {
    assertEquals(
      parseTraceparent(value),
      undefined,
      String(value).slice(0, 80),
    );
  }
});

Deno.test("a future version is read by the version-00 layout and never by guessing", () => {
  assertEquals(parseTraceparent(`01-${traceId}-${spanId}-01`), {
    traceId,
    spanId,
    sampled: true,
  });
  // Extra fields are allowed after a dash for a later version, and only there.
  assertEquals(
    parseTraceparent(`01-${traceId}-${spanId}-01-future-field`)?.traceId,
    traceId,
  );
  assertEquals(parseTraceparent(`01-${traceId}-${spanId}-01x`), undefined);
  assertEquals(parseTraceparent(`01-${traceId}-${spanId}-01future`), undefined);
});

Deno.test("formatting round-trips and always writes version 00", () => {
  for (const sampled of [true, false]) {
    const context = { traceId, spanId, sampled };
    const header = formatTraceparent(context);
    assertEquals(header, `00-${traceId}-${spanId}-0${sampled ? 1 : 0}`);
    assertEquals(parseTraceparent(header), context);
  }
});

Deno.test("a new root trace and a child are well formed, and a child stays in its parent's trace", () => {
  const root = newTraceContext();
  assertEquals(parseTraceparent(formatTraceparent(root)), root);
  assertEquals(root.sampled, true);

  const child = childTraceContext(root);
  assertEquals(child.traceId, root.traceId);
  assertNotEquals(child.spanId, root.spanId);
  assertEquals(child.sampled, root.sampled);
  assertEquals(parseTraceparent(formatTraceparent(child)), child);

  const seen = new Set<string>();
  for (let index = 0; index < 200; index += 1) {
    seen.add(childTraceContext(root).spanId);
  }
  assertEquals(seen.size, 200, "span ids are not reused");
});

Deno.test("an unsampled parent decision is inherited rather than reversed", () => {
  const parent = { traceId, spanId, sampled: false };
  assertEquals(childTraceContext(parent).sampled, false);
});

Deno.test("a random source that returns zeros can never produce an all-zero id", () => {
  const zeros = bytesFrom(0, 0, 0, 7);
  const root = newTraceContext(zeros);
  assertNotEquals(root.traceId, "0".repeat(32));
  assertNotEquals(root.spanId, "0".repeat(16));
  assert(parseTraceparent(formatTraceparent(root)) !== undefined);
  const stuck = bytesFrom(0);
  const fallback = newTraceContext(stuck);
  assertNotEquals(fallback.traceId, "0".repeat(32));
  assertNotEquals(fallback.spanId, "0".repeat(16));
});

Deno.test("a wake after a long wait is a fresh trace linked to the span it resumes, never a span kept open", () => {
  const before = { traceId, spanId, sampled: true };
  const resumed = linkedContinuation(before);
  assertNotEquals(resumed.context.traceId, before.traceId);
  assertNotEquals(resumed.context.spanId, before.spanId);
  assertEquals(resumed.links, [{ traceId, spanId }]);
  assertEquals(resumed.links[0], traceLinkOf(before));
  assertEquals(resumed.context.sampled, true);
  assertEquals(
    parseTraceparent(formatTraceparent(resumed.context)),
    resumed.context,
  );
});

Deno.test("links stay bounded however many times a step is retried", () => {
  const prior = Array.from({ length: MAX_TRACE_LINKS * 4 }, (_, index) => ({
    traceId: index.toString(16).padStart(32, "1"),
    spanId: index.toString(16).padStart(16, "1"),
  }));
  const resumed = linkedContinuation(prior[0], prior.slice(1));
  assertEquals(resumed.links.length, MAX_TRACE_LINKS);
  assertEquals(resumed.links[0], prior[0], "the span being resumed is kept");
  // The newest history is kept after it, not the oldest.
  assertEquals(resumed.links.at(-1), prior.at(-1));
});

Deno.test("each registered attribute kind admits exactly its own shape", () => {
  const input = {
    "bakery.run.id": uuid,
    "bakery.attempt.id": uuid,
    "bakery.job.id": uuid,
    "bakery.task.id": uuid,
    "bakery.repository.id": uuid,
    "bakery.step.key": "implement.review",
    "bakery.action": "installation.seats.get",
    "bakery.provider.category": "model",
    "bakery.outcome": "AUTH_FORBIDDEN",
    "bakery.actor.hash": "a".repeat(64),
    "bakery.duration_ms": 12.5,
    "bakery.retry.count": 3,
    "bakery.logical_attempt": 2,
    "bakery.lease.lost": false,
  };
  const result = redactTelemetryAttributes(input);
  assertEquals(result.attributes, input);
  assertEquals(result.unregisteredCount, 0);
  assertEquals(result.invalid, []);
});

Deno.test("every registered name is covered by the shape test above", () => {
  assertEquals(
    [...TELEMETRY_ATTRIBUTE_NAMES].sort(),
    [
      "bakery.action",
      "bakery.actor.hash",
      "bakery.attempt.id",
      "bakery.duration_ms",
      "bakery.job.id",
      "bakery.lease.lost",
      "bakery.logical_attempt",
      "bakery.outcome",
      "bakery.provider.category",
      "bakery.repository.id",
      "bakery.retry.count",
      "bakery.run.id",
      "bakery.step.key",
      "bakery.task.id",
    ],
  );
});

Deno.test("a registered name with the wrong value is rejected and reported by name only", () => {
  const result = redactTelemetryAttributes({
    "bakery.run.id": "not-a-uuid",
    "bakery.retry.count": -1,
    "bakery.duration_ms": Number.NaN,
    "bakery.lease.lost": "false",
    "bakery.outcome": "lower_case",
    "bakery.actor.hash": "a".repeat(63),
    "bakery.task.id": uuid,
  });
  assertEquals(result.attributes, { "bakery.task.id": uuid });
  assertEquals(
    [...result.invalid].sort(),
    [
      "bakery.actor.hash",
      "bakery.duration_ms",
      "bakery.lease.lost",
      "bakery.outcome",
      "bakery.retry.count",
      "bakery.run.id",
    ],
  );
  assert(!JSON.stringify(result).includes("not-a-uuid"));
});

Deno.test("numbers must be finite, non-negative and within their bound", () => {
  const bad = [
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    366 * 86_400_000 + 1,
  ];
  for (const value of bad) {
    assertEquals(
      redactTelemetryAttributes({ "bakery.duration_ms": value }).attributes,
      {},
      String(value),
    );
  }
  for (const value of [1.5, 366 * 86_400_000]) {
    assertEquals(
      redactTelemetryAttributes({ "bakery.duration_ms": value }).attributes,
      { "bakery.duration_ms": value },
    );
  }
  for (const value of [1.5, -1, 2 ** 53, 1_000_001]) {
    assertEquals(
      redactTelemetryAttributes({ "bakery.retry.count": value }).attributes,
      {},
      `count ${value}`,
    );
  }
});

Deno.test("an unregistered name is dropped and only counted, never echoed", () => {
  const result = redactTelemetryAttributes({
    "bakery.task.id": uuid,
    "user.email": "someone@example.com",
    "prompt": "summarize the contract",
    ["x".repeat(40)]: 1,
  });
  assertEquals(result.attributes, { "bakery.task.id": uuid });
  assertEquals(result.unregisteredCount, 3);
  assertEquals(result.invalid, []);
  const serialized = JSON.stringify(result);
  assert(!serialized.includes("someone@example.com"));
  assert(!serialized.includes("user.email"));
  assert(!serialized.includes("prompt"));
});

Deno.test("a name or code is accepted at the length limit and refused one character past it", () => {
  // Every segment is valid on its own, so only the total length can refuse it.
  const name = (last: number) =>
    `${"a".repeat(40)}.${"a".repeat(40)}.${"a".repeat(last)}`;
  const code = (last: number) =>
    `${"A".repeat(16)}_`.repeat(5) + "B".repeat(last);
  assertEquals(name(14).length, MAX_TELEMETRY_STRING_LENGTH);
  assertEquals(code(11).length, MAX_TELEMETRY_STRING_LENGTH);
  assertEquals(
    redactTelemetryAttributes({ "bakery.action": name(14) }).attributes,
    { "bakery.action": name(14) },
  );
  assertEquals(
    redactTelemetryAttributes({ "bakery.outcome": code(11) }).attributes,
    { "bakery.outcome": code(11) },
  );
  assertEquals(
    redactTelemetryAttributes({ "bakery.action": name(15) }).invalid,
    ["bakery.action"],
  );
  assertEquals(
    redactTelemetryAttributes({ "bakery.outcome": code(12) }).invalid,
    ["bakery.outcome"],
  );
});

Deno.test("a very large string is refused quickly", () => {
  const huge = "a".repeat(MAX_TELEMETRY_STRING_LENGTH * 1000);
  const started = performance.now();
  const result = redactTelemetryAttributes({
    "bakery.action": huge,
    "bakery.step.key": huge,
    "bakery.outcome": huge.toUpperCase(),
    "bakery.run.id": huge,
  });
  assertEquals(result.attributes, {});
  assertEquals(result.invalid.length, 4);
  assert(
    performance.now() - started < 250,
    "rejection must not scan the value",
  );
});

Deno.test("redaction never throws into the code that is being observed", () => {
  const hostile = {
    get "bakery.task.id"(): string {
      throw new Error("getter boom");
    },
    "bakery.run.id": uuid,
  };
  const proxy = new Proxy({}, {
    ownKeys: () => {
      throw new Error("ownKeys boom");
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (
    const input of [hostile, proxy, cyclic, null, undefined, 7, "text", []]
  ) {
    const result = redactTelemetryAttributes(
      input as unknown as Record<string, unknown>,
    );
    assertEquals(typeof result.attributes, "object");
  }
  // Other attributes survive a getter that fails, so one bad field costs one field.
  assertEquals(
    redactTelemetryAttributes(hostile).attributes["bakery.run.id"],
    uuid,
  );
});

Deno.test("symbol keys, inherited properties and a __proto__ key carry nothing", () => {
  const inherited = Object.create({ "bakery.task.id": uuid });
  assertEquals(redactTelemetryAttributes(inherited).attributes, {});
  const withSymbol = { [Symbol("bakery.task.id")]: uuid };
  assertEquals(redactTelemetryAttributes(withSymbol).attributes, {});
  const parsed = JSON.parse(
    '{"__proto__":{"polluted":true},"bakery.run.id":"' +
      uuid + '"}',
  );
  const result = redactTelemetryAttributes(parsed);
  assertEquals(result.attributes, { "bakery.run.id": uuid });
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
  assertEquals(Object.getPrototypeOf(result.attributes), null);
});
