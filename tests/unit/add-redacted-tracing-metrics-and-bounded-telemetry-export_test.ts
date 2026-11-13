import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  childTraceContext,
  formatTraceparent,
  linkedContinuation,
  MAX_TRACE_LINK_SCAN,
  MAX_TRACE_LINKS,
  newTraceContext,
  operationTraceContext,
  parseTraceLink,
  parseTraceparent,
  traceLinkOf,
} from "../../packages/config/src/telemetry-trace.ts";
import {
  createTelemetryRedactor,
  MAX_STEP_KEY_LENGTH,
  MAX_STEP_KEY_SEGMENTS,
  MAX_VOCABULARY_ENTRIES,
  MAX_VOCABULARY_ENTRY_LENGTH,
  redactTelemetryAttributes,
  STEP_ID_SEGMENT,
  STEP_KEY_SEGMENT,
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
  stepIds: ["build", "implement_review", "step_1", "outer.inner.build"],
  actions: ["installation.seats.get", "agents.activateVersion"],
  providerCategories: ["model"],
  outcomes: ["AUTH_FORBIDDEN"],
};
const redact = createTelemetryRedactor(vocabulary);

/** A value whose every trap throws, as a hostile or broken object might. */
function throwingProxy(target: object): object {
  const boom = () => {
    throw new Error("trap boom");
  };
  return new Proxy(target, {
    get: boom,
    has: boom,
    ownKeys: boom,
    getOwnPropertyDescriptor: boom,
    getPrototypeOf: boom,
  });
}

Deno.test("linkedContinuation never throws, whatever the resumed span or the history is", () => {
  const good = { traceId, spanId };
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const hostileHistories: unknown[] = [
    throwingProxy([]),
    throwingProxy([good]),
    revoked.proxy,
    new Proxy([good], {
      get(target, property) {
        if (property === "length") throw new Error("length boom");
        return Reflect.get(target, property);
      },
    }),
    "not an array",
    42,
    null,
    { length: 3, 0: good },
  ];
  for (const history of hostileHistories) {
    const result = linkedContinuation(good, history as typeof good[]);
    assertEquals(result.links[0], good);
    assertEquals(
      parseTraceparent(formatTraceparent(result.context)),
      result.context,
    );
  }
  const hostileResumed: unknown[] = [
    throwingProxy({}),
    throwingProxy({ traceId, spanId }),
    revoked.proxy,
    {
      traceId,
      spanId,
      get sampled(): boolean {
        throw new Error("sampled boom");
      },
    },
    undefined,
    null,
  ];
  for (const resumed of hostileResumed) {
    const result = linkedContinuation(resumed as typeof good, [good]);
    // Whatever could not be read is dropped; whatever is kept is a clean copy.
    assert(result.links.length <= 2, `${result.links.length} links`);
    for (const link of result.links) assertEquals(link, good);
    assertEquals(
      parseTraceparent(formatTraceparent(result.context)),
      result.context,
    );
  }
});

Deno.test("one unreadable entry in the history costs that link and no other", () => {
  const first = { traceId: "1".repeat(32), spanId: "1".repeat(16) };
  const third = { traceId: "3".repeat(32), spanId: "3".repeat(16) };
  const history = new Proxy([first, { traceId, spanId }, third], {
    get(target, property) {
      if (property === "1") throw new Error("entry boom");
      return Reflect.get(target, property);
    },
  });
  const result = linkedContinuation({ traceId, spanId }, history as never);
  assertEquals(result.links, [{ traceId, spanId }, first, third]);
});

Deno.test("a history that claims an enormous length is read for a bounded number of entries", () => {
  const sparse: Array<{ traceId: string; spanId: string }> = [];
  sparse.length = 4_294_967_295;
  const started = performance.now();
  const result = linkedContinuation({ traceId, spanId }, sparse);
  assert(performance.now() - started < 250, "the scan must stay bounded");
  assertEquals(result.links, [{ traceId, spanId }]);
  // Only the newest MAX_TRACE_LINK_SCAN entries are read; older valid links
  // behind a wall of invalid ones are not.
  const walled: unknown[] = [{
    traceId: "9".repeat(32),
    spanId: "9".repeat(16),
  }];
  for (let index = 0; index < MAX_TRACE_LINK_SCAN; index += 1) {
    walled.push("junk");
  }
  assertEquals(linkedContinuation({ traceId, spanId }, walled as never).links, [
    { traceId, spanId },
  ]);
  assert(MAX_TRACE_LINK_SCAN >= MAX_TRACE_LINKS);
});

Deno.test("each registered attribute kind admits exactly its own shape", () => {
  const input = {
    "bakery.run.id": uuid,
    "bakery.attempt.id": uuid,
    "bakery.job.id": uuid,
    "bakery.task.id": uuid,
    "bakery.repository.id": uuid,
    "bakery.step.key": "implement_review@2",
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

Deno.test("a step key is accepted only when its id path is one the run declared, loop iterations included", () => {
  const accepted = [
    "build",
    "build@0",
    "build@7",
    "build@999",
    "implement_review",
    "step_1",
    "outer.inner.build",
    "outer@2.inner@0.build",
    "outer@1.inner@3.build@12",
  ];
  for (const key of accepted) {
    assertEquals(
      redact({ "bakery.step.key": key }).attributes,
      { "bakery.step.key": key },
      key,
    );
  }
  const refused = [
    // Well-formed ids that the run did not declare.
    "deploy",
    "outer",
    "outer.inner",
    "inner.build",
    "build.outer",
    "Build",
    // The compiler's own grammar, broken one rule at a time.
    "build@1000",
    "build@01",
    "build@-1",
    "build@",
    "build@@1",
    "build@1@2",
    "@1",
    "@build",
    "build.",
    ".build",
    "outer..build",
    "outer.inner.build.extra",
    "build ",
    " build",
    "build\n",
    "build\u0000",
    "build​",
    "buildа",
    "build-1",
    "buind",
    "",
    "b",
    "a".repeat(MAX_STEP_KEY_LENGTH + 1),
    "a".repeat(128_000),
    Array.from({ length: MAX_STEP_KEY_SEGMENTS + 1 }, () => "build").join("."),
  ];
  for (const key of refused) {
    assertEquals(
      redact({ "bakery.step.key": key }).invalid,
      ["bakery.step.key"],
      key.slice(0, 40),
    );
  }
});

Deno.test("with no step ids declared every step key is refused, including a word-like one", () => {
  const bare = createTelemetryRedactor({});
  for (
    const key of [
      "build",
      "step_1",
      "please_summarize_the_task_and_attach_the_diff",
      "zk3lq9xv2rt7yb5nm1cp8hd4wg6sf0ja",
    ]
  ) {
    assertEquals(bare({ "bakery.step.key": key }).invalid, ["bakery.step.key"]);
  }
  assertEquals(
    redactTelemetryAttributes({ "bakery.step.key": "build" }).invalid,
    ["bakery.step.key"],
  );
});

Deno.test("a step id the run declares is checked against the compiler's grammar when the redactor is built", () => {
  const bad = [
    "",
    "a",
    "Build",
    "step-1",
    "step 1",
    "build@1",
    "build.",
    ".build",
    "a..b",
    "build\n",
    "x".repeat(65),
    `a${"b".repeat(64)}`,
    Array.from({ length: MAX_STEP_KEY_SEGMENTS + 1 }, () => "build").join("."),
    42 as unknown as string,
  ];
  for (const id of bad) {
    let message = "";
    try {
      createTelemetryRedactor({ stepIds: [id] });
    } catch (error) {
      assert(error instanceof RangeError);
      message = error.message;
    }
    assert(message.length > 0, `accepted ${JSON.stringify(id).slice(0, 30)}`);
    assert(!message.includes("xxxx"), "the message must not echo the entry");
  }
  // The grammar is a sanity check on a list the consumer already trusts, not
  // the protection: a lowercase token is a legal id segment. What keeps a
  // secret out is that a key is accepted only if the consumer declared it.
  assertEquals(
    createTelemetryRedactor({ stepIds: ["ghp_" + "x".repeat(36)] })({
      "bakery.step.key": "build",
    }).invalid,
    ["bakery.step.key"],
  );
  // The longest legal id is fine.
  const longest = Array.from(
    { length: MAX_STEP_KEY_SEGMENTS },
    () => `a${"b".repeat(63)}`,
  ).join(".");
  assert(longest.length <= MAX_STEP_KEY_LENGTH);
  assertEquals(
    createTelemetryRedactor({ stepIds: [longest] })({
      "bakery.step.key": longest,
    })
      .attributes,
    { "bakery.step.key": longest },
  );
});

Deno.test("each run gets its own step ids and nothing leaks between runs or back into the base", () => {
  const base = createTelemetryRedactor({
    ...vocabulary,
    stepIds: ["shared"],
  });
  const runA = base.withStepIds(["alpha", "alpha.one"]);
  const runB = base.withStepIds(["beta"]);
  assertEquals(runA({ "bakery.step.key": "alpha.one@2" }).invalid, []);
  assertEquals(runA({ "bakery.step.key": "beta" }).invalid, [
    "bakery.step.key",
  ]);
  assertEquals(runB({ "bakery.step.key": "alpha" }).invalid, [
    "bakery.step.key",
  ]);
  assertEquals(runB({ "bakery.step.key": "beta" }).invalid, []);
  // A run's ids replace the base's; they do not add to them.
  assertEquals(runA({ "bakery.step.key": "shared" }).invalid, [
    "bakery.step.key",
  ]);
  assertEquals(base({ "bakery.step.key": "shared" }).invalid, []);
  assertEquals(base({ "bakery.step.key": "alpha" }).invalid, [
    "bakery.step.key",
  ]);
  // The other vocabularies come along unchanged.
  assertEquals(
    runA({ "bakery.action": "installation.seats.get" }).invalid,
    [],
  );
  // The result can narrow again, and the ids are copied.
  const source = new Set(["gamma"]);
  const runC = runA.withStepIds(source);
  source.add("delta");
  assertEquals(runC({ "bakery.step.key": "delta" }).invalid, [
    "bakery.step.key",
  ]);
  assertEquals(runC({ "bakery.step.key": "gamma" }).invalid, []);
  // A bad id is refused here too.
  let threw = false;
  try {
    base.withStepIds(["NotAnId"]);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert(threw);
});

Deno.test("the step-key grammar is the one the server and the compiler enforce", async () => {
  // They declare it privately, so the only way to notice drift is to read the
  // sources. A change to any of them has to be made here as well.
  const checks: Array<[string, string]> = [
    [
      "../../apps/server/src/modules/work/run-steps.ts",
      `const STEP_ID_PATTERN = ${STEP_ID_SEGMENT};`,
    ],
    [
      "../../apps/server/src/modules/workflows/validation.ts",
      `const STEP_ID_PATTERN = ${STEP_ID_SEGMENT};`,
    ],
    [
      "../../packages/contracts/src/workflow-compiler/plan.ts",
      `const SEGMENT = ${STEP_KEY_SEGMENT};`,
    ],
  ];
  for (const [file, declaration] of checks) {
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

Deno.test("a vocabulary that never ends, or repeats one name forever, is stopped by counting every item it yields", () => {
  for (
    const key of [
      "actions",
      "providerCategories",
      "outcomes",
      "stepIds",
    ] as const
  ) {
    let pulled = 0;
    const endless = (function* () {
      for (;;) {
        pulled += 1;
        // Stand-in for a hang: the unfixed code would loop here for ever.
        if (pulled > MAX_VOCABULARY_ENTRIES * 10) {
          throw new Error("the generator was pulled without bound");
        }
        yield "build";
      }
    })();
    let error: unknown;
    try {
      createTelemetryRedactor({ [key]: endless });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof RangeError, `${key}: ${String(error)}`);
    assert(
      pulled <= MAX_VOCABULARY_ENTRIES + 1,
      `${key}: pulled ${pulled} items before stopping`,
    );
  }
});

Deno.test("duplicates count toward the vocabulary limit, and the limit itself is allowed", () => {
  const same = (count: number) => Array.from({ length: count }, () => "build");
  createTelemetryRedactor({ stepIds: same(MAX_VOCABULARY_ENTRIES) });
  let threw = false;
  try {
    createTelemetryRedactor({ stepIds: same(MAX_VOCABULARY_ENTRIES + 1) });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert(threw, "one item past the limit must be refused even when it repeats");
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

Deno.test("a revoked proxy, as the record or as a value, is refused without throwing", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const result = redact(revoked.proxy);
  assertEquals(result.attributes, {});
  assertEquals(result.invalid, []);
  const revokedArray = Proxy.revocable([], {});
  revokedArray.revoke();
  assertEquals(redact(revokedArray.proxy).attributes, {});
  // As a value of a registered field it is just a wrong value.
  assertEquals(redact({ "bakery.task.id": revoked.proxy }).invalid, [
    "bakery.task.id",
  ]);
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

Deno.test("an operation runs in a new span of the trace it was given, and starts a new trace only when it was given none it can use", () => {
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const callerSpan = "b7ad6b7169203331";
  const header = (flags: string) => `00-${traceId}-${callerSpan}-${flags}`;
  const valid = (context: { traceId: string; spanId: string }) => {
    assert(/^[0-9a-f]{32}$/.test(context.traceId), context.traceId);
    assert(/^[0-9a-f]{16}$/.test(context.spanId), context.spanId);
    assertNotEquals(context.traceId, "0".repeat(32));
    assertNotEquals(context.spanId, "0".repeat(16));
  };

  // A caller's trace continues in a span of its own, and its sampling stands.
  for (const [flags, sampled] of [["01", true], ["00", false]] as const) {
    const context = operationTraceContext({
      traceId,
      traceparent: header(flags),
    });
    valid(context);
    assertEquals(context.traceId, traceId);
    assertNotEquals(
      context.spanId,
      callerSpan,
      "the operation is not the caller's span",
    );
    assertEquals(context.sampled, sampled, flags);
  }
  // Nothing sent, but the edge already minted a trace id: keep it, recorded.
  const minted = operationTraceContext({ traceId, traceparent: undefined });
  valid(minted);
  assertEquals({ ...minted, spanId: "" }, {
    traceId,
    spanId: "",
    sampled: true,
  });

  // The persisted trace id and the span context must name the same trace.
  const mismatched = operationTraceContext({
    traceId: "11111111111111111111111111111111",
    traceparent: header("01"),
  });
  assertEquals(mismatched.traceId, "11111111111111111111111111111111");
  assertNotEquals(
    mismatched.spanId,
    callerSpan,
    "a header for another trace is not a parent",
  );
  // A hex trace id in capitals (the edge accepts them) is written as the specification requires.
  assertEquals(
    operationTraceContext({
      traceId: traceId.toUpperCase(),
      traceparent: undefined,
    }).traceId,
    traceId,
  );

  // Not usable: a fresh, valid, recorded trace. A dashed UUID is not a trace id.
  const unusable: unknown[] = [
    "6f1c0e6e-5c7b-4a07-9a4e-0b8f0a6f3f11",
    "0".repeat(32),
    "short",
    "",
    null,
    undefined,
    42,
    {},
  ];
  for (const value of unusable) {
    const context = operationTraceContext({
      traceId: value,
      traceparent: undefined,
    });
    valid(context);
    assertEquals(context.sampled, true, String(value));
    assertNotEquals(context.traceId, value);
  }
  // A header `parseTraceparent` cannot read, or version 00 with fields after
  // its own, is never a parent (a later version with extra fields is: see below).
  for (
    const bad of [
      header("01").toUpperCase(),
      `ff-${traceId}-${callerSpan}-01`,
      `00-${"0".repeat(32)}-${callerSpan}-01`,
      `00-${traceId}-${"0".repeat(16)}-01`,
      `${header("01")}-extra`,
      "x".repeat(600),
      42,
      null,
    ]
  ) {
    const context = operationTraceContext({ traceId, traceparent: bad });
    valid(context);
    assertEquals(context.traceId, traceId);
    assertEquals(context.sampled, true, String(bad));
  }
  // It cannot throw into the request it describes, whatever the request holds.
  const hostile = {
    get traceId(): string {
      throw new Error("trap");
    },
    get traceparent(): string {
      throw new Error("trap");
    },
  };
  valid(operationTraceContext(hostile));
  valid(operationTraceContext(null as never));
});

// #293: three behaviors of `operationTraceContext` that its tests did not pin
// and its comment got wrong.

Deno.test("a readable header is the parent when the persisted trace id is unusable, so the caller's trace continues", () => {
  const callerTrace = "0af7651916cd43dd8448eb211c80319c";
  const callerSpan = "b7ad6b7169203331";
  const unusable: unknown[] = [
    "6f1c0e6e-5c7b-4a07-9a4e-0b8f0a6f3f11",
    "0".repeat(32),
    "short",
    "",
    undefined,
    null,
    42,
  ];
  for (const value of unusable) {
    // Flags 00: a parent keeps the caller's decision not to sample; a fresh
    // trace would be recorded, so the flag tells the two apart.
    const context = operationTraceContext({
      traceId: value,
      traceparent: `00-${callerTrace}-${callerSpan}-00`,
    });
    assertEquals(context.traceId, callerTrace, String(value));
    assertNotEquals(
      context.spanId,
      callerSpan,
      "the operation is its own span",
    );
    assertEquals(context.sampled, false, String(value));
  }
});

Deno.test("a trace id of any length but 32 hex characters is not usable", () => {
  const good = "0af7651916cd43dd8448eb211c80319c";
  const notUsable = [
    good.slice(1),
    `${good}0`,
    `0${good}`,
    `${good}\n`,
    good + good,
    `g${good.slice(1)}`,
    ` ${good.slice(1)}`,
  ];
  for (const value of notUsable) {
    const context = operationTraceContext({
      traceId: value,
      traceparent: undefined,
    });
    assert(
      /^[0-9a-f]{32}$/.test(context.traceId),
      `${JSON.stringify(value)} gave ${context.traceId}`,
    );
    assertNotEquals(
      context.traceId,
      value.toLowerCase(),
      JSON.stringify(value),
    );
    assertEquals(context.sampled, true, "a fresh trace is recorded");
  }
});

Deno.test("a later-version header is read by the version-00 layout and is a parent, but version 00 with extra fields is not", () => {
  const callerSpan = "b7ad6b7169203331";
  const sampledOf = (traceparent: string) =>
    operationTraceContext({ traceId, traceparent });
  // Flags 00 stand for a parent (not sampled); a header that is no parent
  // leaves the operation in a recorded span of its own trace.
  assertEquals(sampledOf(`01-${traceId}-${callerSpan}-00`).sampled, false);
  assertEquals(
    sampledOf(`01-${traceId}-${callerSpan}-00-vendor-fields`).sampled,
    false,
    "a later version may add fields after a dash",
  );
  assertEquals(
    sampledOf(`01-${traceId}-${callerSpan}-00vendor`).sampled,
    true,
    "a later version's extra fields start after a dash",
  );
  assertEquals(
    sampledOf(`00-${traceId}-${callerSpan}-00-extra`).sampled,
    true,
    "version 00 is exactly its layout",
  );
  // Whatever the version it came in, what is stored is a version-00 header.
  assert(
    formatTraceparent(sampledOf(`01-${traceId}-${callerSpan}-00`)).startsWith(
      "00-",
    ),
  );
});
