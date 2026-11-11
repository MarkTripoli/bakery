import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  childTraceContext,
  formatTraceparent,
  linkedContinuation,
  MAX_TRACE_LINKS,
  newTraceContext,
  parseTraceLink,
  parseTraceparent,
  traceLinkOf,
} from "../../packages/config/src/telemetry-trace.ts";
import {
  createTelemetryRedactor,
  MAX_VOCABULARY_ENTRIES,
  MAX_VOCABULARY_ENTRY_LENGTH,
  redactTelemetryAttributes,
  STEP_KEY_MAX_DIGITS,
  STEP_KEY_PATTERN,
  TELEMETRY_ATTRIBUTE_NAMES,
} from "../../packages/config/src/telemetry-attributes.ts";
import { FAULTS } from "../../packages/contracts/src/http.ts";
import * as implementedActions from "../../packages/contracts/src/implemented-actions.ts";

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

Deno.test("a stored link is read back only when both ids are well formed", () => {
  assertEquals(parseTraceLink({ traceId, spanId }), { traceId, spanId });
  // Extra properties are dropped, not carried.
  assertEquals(parseTraceLink({ traceId, spanId, note: "secret" }), {
    traceId,
    spanId,
  });
  for (
    const bad of [
      undefined,
      null,
      "link",
      42,
      [],
      {},
      { traceId },
      { spanId },
      { traceId: "please summarize the diff", spanId: "<script>" },
      { traceId: traceId.toUpperCase(), spanId },
      { traceId, spanId: spanId.toUpperCase() },
      { traceId: "0".repeat(32), spanId },
      { traceId, spanId: "0".repeat(16) },
      { traceId: traceId.slice(1), spanId },
      { traceId, spanId: `${spanId}0` },
      { traceId: 1, spanId: 2 },
      { traceId: `${traceId}\n`, spanId },
    ]
  ) {
    assertEquals(parseTraceLink(bad), undefined, JSON.stringify(bad));
  }
  const throwing = {
    get traceId(): string {
      throw new Error("getter boom");
    },
    spanId,
  };
  assertEquals(parseTraceLink(throwing), undefined);
});

Deno.test("a continuation keeps the links that are valid and drops the rest without echoing them", () => {
  const good = { traceId, spanId };
  const garbage = { traceId: "please summarize the diff", spanId: "<script>" };
  const resumed = linkedContinuation(
    garbage as unknown as typeof good,
    [
      garbage as unknown as typeof good,
      good,
      { ...good, note: "secret" } as typeof good,
    ],
  );
  assertEquals(resumed.links, [good, good]);
  assert(!JSON.stringify(resumed).includes("summarize"));
  assert(!JSON.stringify(resumed).includes("secret"));
  assert(!JSON.stringify(resumed).includes("script"));
  // A context that was never valid still starts a well-formed trace.
  assertEquals(
    parseTraceparent(formatTraceparent(resumed.context)),
    resumed.context,
  );
});

/** Every action id the contracts package implements, as the consumer would pass it. */
function implementedActionIds(): string[] {
  const ids = new Set<string>();
  for (const group of Object.values(implementedActions)) {
    if (group && typeof group === "object") {
      for (const value of Object.values(group)) {
        if (typeof value === "string") ids.add(value);
      }
    }
  }
  return [...ids];
}

const vocabulary = {
  actions: ["installation.seats.get", "agents.activateVersion"],
  providerCategories: ["model"],
  outcomes: ["AUTH_FORBIDDEN"],
};
const redact = createTelemetryRedactor(vocabulary);

Deno.test("each registered attribute kind admits exactly its own shape", () => {
  const input = {
    "bakery.run.id": uuid,
    "bakery.attempt.id": uuid,
    "bakery.job.id": uuid,
    "bakery.task.id": uuid,
    "bakery.repository.id": uuid,
    "bakery.step.key": "implement_review",
    "bakery.action": "installation.seats.get",
    "bakery.provider.category": "model",
    "bakery.outcome": "AUTH_FORBIDDEN",
    "bakery.actor.hash": "a".repeat(64),
    "bakery.duration_ms": 12.5,
    "bakery.retry.count": 3,
    "bakery.logical_attempt": 2,
    "bakery.lease.lost": false,
  };
  const result = redact(input);
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
  const result = redact({
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
      redact({ "bakery.duration_ms": value }).attributes,
      {},
      String(value),
    );
  }
  for (const value of [1.5, 366 * 86_400_000]) {
    assertEquals(redact({ "bakery.duration_ms": value }).attributes, {
      "bakery.duration_ms": value,
    });
  }
  for (const value of [1.5, -1, 2 ** 53, 1_000_001]) {
    assertEquals(
      redact({ "bakery.retry.count": value }).attributes,
      {},
      `count ${value}`,
    );
  }
});

Deno.test("a step key is the runtime step-id grammar with at most three digits", () => {
  for (
    const key of [
      "implement_review",
      "delivery_gate",
      "build",
      "step_1",
      "step_2",
      "review_2",
      "attempt_3",
      "try_1",
      "retry_10",
      "a_1",
      "lane_a2",
      "node2",
      "ab",
      "a_123",
      `a${"b".repeat(63)}`,
    ]
  ) {
    assertEquals(
      redact({ "bakery.step.key": key }).attributes,
      { "bakery.step.key": key },
      key,
    );
  }
  for (
    const key of [
      "",
      "a",
      "Step_1",
      "1step",
      "_step",
      "step-1",
      "step.one",
      "implement.review",
      "step 1",
      "step_1\n",
      " step_1",
      "step_а",
      "a_1234",
      "ab12cd34",
      `a${"b".repeat(64)}`,
      "a".repeat(128_000),
    ]
  ) {
    assertEquals(
      redact({ "bakery.step.key": key }).invalid,
      ["bakery.step.key"],
      key.slice(0, 40),
    );
  }
  assertEquals(STEP_KEY_MAX_DIGITS, 3);
});

Deno.test("the step-key grammar is the one the server enforces", async () => {
  // Both server modules declare it privately, so the only way to notice drift
  // is to read them. A change to either has to be made here as well.
  const declaration = `const STEP_ID_PATTERN = ${STEP_KEY_PATTERN};`;
  for (
    const file of [
      "../../apps/server/src/modules/work/run-steps.ts",
      "../../apps/server/src/modules/workflows/validation.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assert(
      source.includes(declaration),
      `${file} no longer declares ${declaration}`,
    );
  }
});

Deno.test("an action, provider category or outcome is accepted only as a member of its vocabulary", () => {
  const actions = ["installation.seats.get", "agents.activateVersion"];
  const redactor = createTelemetryRedactor({
    actions,
    providerCategories: ["model"],
    outcomes: ["AUTH_FORBIDDEN"],
  });
  const nearMisses: Array<[string, string[]]> = [
    ["bakery.action", [
      "installation.seats.get ",
      " installation.seats.get",
      "installation.seats.get\n",
      "installation.seats.get\u0000",
      "installation.seats.get​",
      "Installation.seats.get",
      "installation.seats.gets",
      "installation.seats",
      "seats.get",
      "agents.activateversion",
      "",
    ]],
    ["bakery.provider.category", ["Model", "model ", "models", "mode", ""]],
    ["bakery.outcome", [
      "auth_forbidden",
      "AUTH_FORBIDDEN ",
      "AUTH_FORBIDDEN2",
      "AUTH",
      "",
    ]],
  ];
  for (const [field, values] of nearMisses) {
    for (const value of values) {
      assertEquals(
        redactor({ [field]: value }).invalid,
        [field],
        `${field} ${JSON.stringify(value)}`,
      );
    }
  }
  // A name looking like an identifier is not enough: it has to be on the list.
  assertEquals(redactor({ "bakery.action": "tasks.create" }).invalid, [
    "bakery.action",
  ]);
  assertEquals(redactor({ "bakery.action": actions[0] }).attributes, {
    "bakery.action": actions[0],
  });
});

Deno.test("with no vocabulary an action, provider category and outcome are refused", () => {
  const result = redactTelemetryAttributes({
    "bakery.action": "installation.seats.get",
    "bakery.provider.category": "model",
    "bakery.outcome": "AUTH_FORBIDDEN",
    "bakery.task.id": uuid,
  });
  assertEquals(result.attributes, { "bakery.task.id": uuid });
  assertEquals(
    [...result.invalid].sort(),
    ["bakery.action", "bakery.outcome", "bakery.provider.category"],
  );
});

Deno.test("a vocabulary is copied, so changing the original cannot widen it", () => {
  const actions = new Set(["installation.seats.get"]);
  const redactor = createTelemetryRedactor({ actions });
  actions.add("tasks.create");
  assertEquals(redactor({ "bakery.action": "tasks.create" }).invalid, [
    "bakery.action",
  ]);
  // Any iterable is read once, when the redactor is made.
  const lazy = createTelemetryRedactor({
    actions: (function* () {
      yield "agents.list";
    })(),
  });
  assertEquals(lazy({ "bakery.action": "agents.list" }).attributes, {
    "bakery.action": "agents.list",
  });
  assertEquals(lazy({ "bakery.action": "agents.list" }).invalid, []);
});

Deno.test("a vocabulary of anything but short names is refused when it is built", () => {
  const secret = "ghp_" + "x".repeat(40);
  for (
    const bad of [
      [""],
      ["x".repeat(MAX_VOCABULARY_ENTRY_LENGTH + 1)],
      [secret + "x".repeat(60)],
      [42 as unknown as string],
      [null as unknown as string],
    ]
  ) {
    let message = "";
    try {
      createTelemetryRedactor({ actions: bad });
    } catch (error) {
      assert(error instanceof RangeError);
      message = error.message;
    }
    assert(message.length > 0, `accepted ${JSON.stringify(bad).slice(0, 30)}`);
    assert(!message.includes("xxxx"), "the message must not echo the entry");
  }
  // The boundaries themselves are fine.
  createTelemetryRedactor({
    actions: ["x".repeat(MAX_VOCABULARY_ENTRY_LENGTH)],
    outcomes: Array.from({ length: MAX_VOCABULARY_ENTRIES }, (_, i) => `O${i}`),
  });
  let tooMany = false;
  try {
    createTelemetryRedactor({
      outcomes: Array.from(
        { length: MAX_VOCABULARY_ENTRIES + 1 },
        (_, i) => `O${i}`,
      ),
    });
  } catch (error) {
    tooMany = error instanceof RangeError;
  }
  assert(tooMany, "an oversized vocabulary must be refused");
});

Deno.test("the real action registry and fault catalog work as vocabularies", () => {
  const actions = implementedActionIds();
  const outcomes = Object.keys(FAULTS);
  assert(actions.length > 100, `only ${actions.length} actions found`);
  assert(outcomes.includes("AUTH_FORBIDDEN"));
  const redactor = createTelemetryRedactor({ actions, outcomes });
  for (const action of actions) {
    assertEquals(redactor({ "bakery.action": action }).invalid, [], action);
  }
  for (const outcome of outcomes) {
    assertEquals(redactor({ "bakery.outcome": outcome }).invalid, [], outcome);
  }
  // Nothing close to a real name gets in.
  for (const action of actions.slice(0, 40)) {
    for (const near of [`${action}x`, `${action} `, action.toUpperCase()]) {
      assertEquals(redactor({ "bakery.action": near }).invalid, [
        "bakery.action",
      ], near);
    }
  }
});

Deno.test("a name that is only registered somewhere else is not accepted in another field", () => {
  const redactor = createTelemetryRedactor({
    actions: ["agents.list"],
    providerCategories: ["model"],
    outcomes: ["AUTH_FORBIDDEN"],
  });
  assertEquals(
    redactor({ "bakery.provider.category": "agents.list" }).invalid,
    [
      "bakery.provider.category",
    ],
  );
  assertEquals(redactor({ "bakery.action": "model" }).invalid, [
    "bakery.action",
  ]);
  assertEquals(redactor({ "bakery.outcome": "model" }).invalid, [
    "bakery.outcome",
  ]);
});

Deno.test("an unregistered name is dropped and only counted, never echoed", () => {
  const result = redact({
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

Deno.test("a very large string is refused quickly", () => {
  const huge = "a".repeat(128_000);
  const started = performance.now();
  const result = redact({
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
    const result = redact(input as unknown as Record<string, unknown>);
    assertEquals(typeof result.attributes, "object");
  }
  // Other attributes survive a getter that fails, so one bad field costs one field.
  assertEquals(redact(hostile).attributes["bakery.run.id"], uuid);
});

Deno.test("symbol keys, inherited properties and a __proto__ key carry nothing", () => {
  const inherited = Object.create({ "bakery.task.id": uuid });
  assertEquals(redact(inherited).attributes, {});
  const withSymbol = { [Symbol("bakery.task.id")]: uuid };
  assertEquals(redact(withSymbol).attributes, {});
  const parsed = JSON.parse(
    '{"__proto__":{"polluted":true},"bakery.run.id":"' + uuid + '"}',
  );
  const result = redact(parsed);
  assertEquals(result.attributes, { "bakery.run.id": uuid });
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
  assertEquals(Object.getPrototypeOf(result.attributes), null);
});
