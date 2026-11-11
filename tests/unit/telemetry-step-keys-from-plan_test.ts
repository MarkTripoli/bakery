import { assert, assertEquals } from "@std/assert";
import {
  compileWorkflowDocument,
  expandStepKeys,
  WORKFLOW_COMPILER_LIMITS,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { createTelemetryRedactor } from "../../packages/config/src/telemetry-attributes.ts";

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
