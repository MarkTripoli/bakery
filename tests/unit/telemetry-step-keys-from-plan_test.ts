import { assert, assertEquals } from "@std/assert";
import {
  compileWorkflowDocument,
  expandStepKeys,
  WORKFLOW_COMPILER_LIMITS,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  createTelemetryRedactor,
  MAX_STEP_KEY_LENGTH,
  MAX_STEP_KEY_SEGMENTS,
  STEP_KEY_SEGMENT,
} from "../../packages/config/src/telemetry-attributes.ts";

// `bakery.step.key` is accepted only as a step the run declared. This drives the
// real workflow compiler, so what the redactor is told is exactly what a
// consumer would read off a compiled plan, and every key the plan can allocate,
// loop iterations and parallel lanes included, has to pass.

type Def = Record<string, unknown>;

const noop = (id: string): Def => ({
  id,
  uses: "workflow.noop",
  timeout: "10s",
});

const repeat = (id: string, body: Def): Def => ({
  id,
  repeat: {
    max: 2,
    seed: { currentCandidate: { done: false } },
    until: "$repeat.currentCandidate.done == true",
    outputs: { currentCandidate: { done: false } },
    ...body,
  },
});

function workflow(steps: unknown[]): Def {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs: {
      repositoryId: { type: "uuid", required: true },
      target: { type: "string", required: true },
    },
    steps,
  };
}

/** Nested repeats inside parallel lanes: the deepest keys a plan produces. */
const nested = workflow([
  repeat("outer", {
    max: 8,
    seed: {
      steps: [noop("setup")],
      outputs: { currentCandidate: { done: false } },
    },
    steps: [{
      id: "fan",
      parallel: {
        maxConcurrency: 3,
        join: "all-required",
        failurePolicy: "stop-dependent",
        branches: ["lane_a", "lane_b", "lane_c"].map((id) => ({
          id,
          repository: "main",
          steps: [
            repeat("inner", {
              max: 3,
              seed: {
                steps: [noop("prep")],
                outputs: { currentCandidate: { done: false } },
              },
              steps: [noop("work")],
            }),
          ],
        })),
      },
    }],
  }),
  noop("after"),
]);

async function plan() {
  const result = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(nested)),
  );
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result.plan;
}

Deno.test("every key a compiled plan can allocate is accepted when its qualified ids are declared", async () => {
  const compiled = await plan();
  const stepIds = compiled.steps.map((step) => step.qualifiedId);
  const keys = expandStepKeys(compiled);
  // Guards the premise: the plan really does produce nested, iterated keys.
  assertEquals(keys.length, 1 + 8 * 3 * (1 + 3) + 1);
  assert(keys.includes("outer@0.setup"));
  assert(keys.includes("outer@8.fan.lane_c.inner@3.work"));
  assert(keys.includes("after"));
  assert(stepIds.some((id) => id.split(".").length >= 4));
  assert(stepIds.length <= WORKFLOW_COMPILER_LIMITS.expandedSteps);

  const redactor = createTelemetryRedactor({ stepIds });
  for (const key of keys) {
    assertEquals(
      redactor({ "bakery.step.key": key }).attributes,
      { "bakery.step.key": key },
      key,
    );
  }
});

Deno.test("a key from the plan is refused by a redactor for a different run, and by one with no ids", async () => {
  const compiled = await plan();
  const keys = expandStepKeys(compiled);
  const other = createTelemetryRedactor({
    stepIds: ["unrelated", "other.run"],
  });
  const bare = createTelemetryRedactor({});
  for (const key of keys) {
    assertEquals(other({ "bakery.step.key": key }).invalid, [
      "bakery.step.key",
    ]);
    assertEquals(bare({ "bakery.step.key": key }).invalid, ["bakery.step.key"]);
  }
});

Deno.test("a plan's keys with one character changed are refused", async () => {
  const compiled = await plan();
  const redactor = createTelemetryRedactor({
    stepIds: compiled.steps.map((step) => step.qualifiedId),
  });
  for (const key of expandStepKeys(compiled)) {
    for (const damaged of [`${key}x`, `x${key}`, key.slice(1), `${key}.`]) {
      assertEquals(
        redactor({ "bakery.step.key": damaged }).invalid,
        ["bakery.step.key"],
        damaged,
      );
    }
  }
});

Deno.test("a consumer narrows the redactor to one run's plan without touching the base", async () => {
  const compiled = await plan();
  const base = createTelemetryRedactor({ stepIds: ["shared"] });
  const run = base.withStepIds(compiled.steps.map((step) => step.qualifiedId));
  assertEquals(
    run({ "bakery.step.key": "outer@8.fan.lane_c.inner@3.work" }).invalid,
    [],
  );
  assertEquals(base({ "bakery.step.key": "outer@0.setup" }).invalid, [
    "bakery.step.key",
  ]);
});

// A qualified id grows by one segment for a sequence, a branch arm and a repeat
// body, and by two for a parallel group (its id and its lane's id). The
// redactor must be able to declare every id the compiler can produce, so its
// limits are checked against the compiler here, not against a guess.

type Kind = "S" | "B" | "R" | "P";

let serial = 0;
const named = (tag: string, width: number) => {
  const base = `n${++serial}_${tag}`;
  return width > base.length ? base + "x".repeat(width - base.length) : base;
};

/** One leaf action wrapped by `shape`, outermost first, ids padded to `width`. */
function nestedWorkflow(shape: string, width: number): Def {
  const leaf = (): Def => ({
    id: named("a", width),
    uses: "workflow.noop",
    timeout: "10s",
  });
  let node: Def = leaf();
  for (let index = shape.length - 1; index >= 0; index -= 1) {
    const inner = node;
    switch (shape[index] as Kind) {
      case "S":
        node = { id: named("s", width), steps: [inner] };
        break;
      case "B":
        node = {
          id: named("b", width),
          branch: {
            when: '$input.target == "prod"',
            then: [inner],
            else: [leaf()],
          },
        };
        break;
      case "R":
        node = repeat(named("r", width), { steps: [inner] });
        break;
      case "P":
        node = {
          id: named("p", width),
          parallel: {
            maxConcurrency: 1,
            join: "all-required",
            failurePolicy: "stop-dependent",
            branches: [{
              id: named("l", width),
              repository: "main",
              steps: [inner],
            }],
          },
        };
        break;
    }
  }
  return workflow([node]);
}

async function compiledPlan(shape: string, width = 64) {
  const result = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(nestedWorkflow(shape, width))),
  );
  assert(
    result.ok,
    `${shape}: ${result.ok ? "" : JSON.stringify(result.diagnostics)}`,
  );
  return result.plan;
}

Deno.test("the segment limit is what the compiler's depth limit allows, derived and not guessed", () => {
  const wrappers = WORKFLOW_COMPILER_LIMITS.nodeDepth - 1;
  // Each wrapper is at most a parallel group, which adds two segments, and the
  // leaf adds one.
  assertEquals(MAX_STEP_KEY_SEGMENTS, 2 * wrappers + 1);
  // The longest key: every segment at the id limit with the widest marker the
  // grammar admits, joined by dots.
  const widest = 64 + "@999".length;
  assertEquals(
    MAX_STEP_KEY_LENGTH >=
      MAX_STEP_KEY_SEGMENTS * widest + MAX_STEP_KEY_SEGMENTS - 1,
    true,
  );
  const worstKey = Array.from(
    { length: MAX_STEP_KEY_SEGMENTS },
    () => `a${"b".repeat(63)}@999`,
  ).join(".");
  assertEquals(worstKey.length <= MAX_STEP_KEY_LENGTH, true);
  assert(
    worstKey.split(".").every((segment) => STEP_KEY_SEGMENT.test(segment)),
  );
});

Deno.test("nested parallel groups from 1 to the compiler's depth limit can all be declared and traced", async () => {
  const limit = WORKFLOW_COMPILER_LIMITS.nodeDepth - 1;
  for (let groups = 1; groups <= limit; groups += 1) {
    const compiled = await compiledPlan("P".repeat(groups));
    const stepIds = compiled.steps.map((step) => step.qualifiedId);
    const deepest = Math.max(...stepIds.map((id) => id.split(".").length));
    assertEquals(deepest, 2 * groups + 1, `${groups} groups`);
    // QA's reproducer: this used to throw once the id passed 10 segments.
    const redactor = createTelemetryRedactor({ stepIds });
    for (const key of expandStepKeys(compiled)) {
      assertEquals(
        redactor({ "bakery.step.key": key }).attributes,
        { "bakery.step.key": key },
        `${groups} groups: ${key.slice(0, 60)}`,
      );
    }
  }
  // One level past the compiler's limit is not a plan at all.
  const tooDeep = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(nestedWorkflow("P".repeat(limit + 1), 8))),
  );
  assert(!tooDeep.ok, "the compiler's depth limit is what bounds the segments");
});

Deno.test("no mix of node kinds at any legal depth, with 64-character ids, produces an id or key the redactor cannot handle", async () => {
  const kinds = "SBRP";
  const shapes: string[] = [];
  const grow = (prefix: string, depth: number) => {
    if (prefix) shapes.push(prefix);
    if (depth === 0) return;
    for (const kind of kinds) grow(prefix + kind, depth - 1);
  };
  grow("", 4);
  let seed = 20261111;
  const random =
    () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
  for (let length = 5; length <= 9; length += 1) {
    for (let index = 0; index < 120; index += 1) {
      shapes.push(Array.from({ length }, () => kinds[random() % 4]).join(""));
    }
  }
  for (let length = 1; length <= 9; length += 1) {
    for (const kind of kinds) shapes.push(kind.repeat(length));
  }
  let compiledShapes = 0;
  let rejectedShapes = 0;
  let longestKey = 0;
  let mostSegments = 0;
  for (const shape of shapes) {
    const result = await compileWorkflowDocument(
      JSON.parse(JSON.stringify(nestedWorkflow(shape, 64))),
    );
    if (!result.ok) {
      rejectedShapes += 1;
      continue;
    }
    compiledShapes += 1;
    const stepIds = result.plan.steps.map((step) => step.qualifiedId);
    const redactor = createTelemetryRedactor({ stepIds });
    for (const id of stepIds) {
      mostSegments = Math.max(mostSegments, id.split(".").length);
    }
    for (const key of expandStepKeys(result.plan)) {
      longestKey = Math.max(longestKey, key.length);
      assertEquals(
        redactor({ "bakery.step.key": key }).invalid,
        [],
        `${shape}: ${key.slice(0, 50)}`,
      );
    }
  }
  // Guards the search itself: it must reach the deep end and see rejections.
  // 976 shapes are tried (340 exhaustive up to length 4, 600 random of length
  // 5 to 9, 36 uniform chains); the compiler rejects those nested past its
  // limit, so a search that has stopped reaching the deep end fails here.
  assert(compiledShapes >= 700, `only ${compiledShapes} shapes compiled`);
  assert(
    rejectedShapes >= 100,
    `only ${rejectedShapes} shapes were too deep, so the limit was not reached`,
  );

  assertEquals(mostSegments, MAX_STEP_KEY_SEGMENTS);
  assert(longestKey <= MAX_STEP_KEY_LENGTH);
  assert(longestKey > 900, `the longest key found was only ${longestKey}`);
});

Deno.test("an id one segment past the maximum, or a key one character past the maximum length, is still refused", () => {
  const segment = (index: number) => `s${"b".repeat(5)}${index}`;
  const tooMany = Array.from(
    { length: MAX_STEP_KEY_SEGMENTS + 1 },
    (_, i) => segment(i),
  );
  let refused = false;
  try {
    createTelemetryRedactor({ stepIds: [tooMany.join(".")] });
  } catch (error) {
    refused = error instanceof RangeError;
  }
  assert(
    refused,
    "an id longer than any plan can produce must not be declarable",
  );
  const atLimit = Array.from(
    { length: MAX_STEP_KEY_SEGMENTS },
    (_, i) => segment(i),
  ).join(".");
  const redactor = createTelemetryRedactor({ stepIds: [atLimit] });
  assertEquals(redactor({ "bakery.step.key": atLimit }).invalid, []);
  assertEquals(
    redactor({ "bakery.step.key": `${atLimit}.${segment(99)}` }).invalid,
    ["bakery.step.key"],
  );
  assertEquals(
    redactor({ "bakery.step.key": "a".repeat(MAX_STEP_KEY_LENGTH + 1) })
      .invalid,
    ["bakery.step.key"],
  );
});
