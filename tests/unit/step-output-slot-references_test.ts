import { assert, assertEquals } from "@std/assert";
import {
  compileWorkflowDocument,
  documentOutputSlot,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  type ActionDispatch,
  pinWorkflowRuntime,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  documentSlotsOf,
  nextPlanStep,
  planRuntimeFromSnapshot,
  type PlanStepRow,
} from "../../apps/server/src/modules/workflow-adapter/plan-state.ts";
import {
  compiled,
  noop,
  type Step,
  workflow,
} from "../helpers/workflow-interpreter.ts";

const ARTIFACT = {
  artifactId: "00000000-0000-4000-8000-0000000000c1",
  versionId: "00000000-0000-4000-8000-0000000000c2",
  sha256: "a".repeat(64),
};

const BUDGET = {
  prompt: "Write the plan.",
  maxTurns: 4,
  timeout: "5m",
  maxCostUsd: 1,
  allowedTools: ["read"],
};

const writer = (extra: Step = {}): Step => ({
  id: "plan",
  uses: "agent.freeform",
  role: "writer",
  outputs: [{ name: "plan", kind: "plan" }],
  with: BUDGET,
  ...extra,
});

const reader = (from: string, extra: Step = {}): Step => ({
  id: "build",
  needs: ["plan"],
  uses: "agent.freeform",
  role: "writer",
  inputs: [{ name: "plan", from }],
  with: { ...BUDGET, prompt: "Build it." },
  ...extra,
});

async function diagnose(steps: Step[]) {
  const result = await compileWorkflowDocument(workflow(steps));
  return result.ok ? [] : result.diagnostics.map(({ code }) => code);
}

Deno.test("the slot is bound only by an action that publishes one document, with exactly one slot", () => {
  const one = [{ name: "plan" }];
  assertEquals(documentOutputSlot("agent.freeform", one), "plan");
  assertEquals(documentOutputSlot("agent.freeform", undefined), undefined);
  assertEquals(documentOutputSlot("agent.freeform", []), undefined);
  assertEquals(
    documentOutputSlot("agent.freeform", [{ name: "a" }, { name: "b" }]),
    undefined,
  );
  assertEquals(documentOutputSlot("workflow.noop", one), undefined);
});

Deno.test("a read of the declared slot compiles, and so do its reference fields", async () => {
  for (
    const from of [
      "$step.plan.outputs.plan",
      "$step.plan.outputs.plan.versionId",
      "$step.plan.outputs.plan.artifactId",
      "$step.plan.outputs.plan.sha256",
    ]
  ) {
    assertEquals(await diagnose([writer(), reader(from)]), [], from);
  }
});

Deno.test("a read the engine could not resolve is refused when the workflow compiles", async () => {
  const refused = async (from: string, steps: Step[]) => {
    const codes = await diagnose(steps);
    assert(codes.length > 0, `${from} compiled`);
  };
  await refused("a slot that was not declared", [
    writer(),
    reader("$step.plan.outputs.other"),
  ]);
  await refused("a field the reference does not have", [
    writer(),
    reader("$step.plan.outputs.plan.path"),
  ]);
  await refused("a second slot, which binds no document", [
    writer({
      outputs: [{ name: "plan", kind: "plan" }, {
        name: "notes",
        kind: "notes",
      }],
    }),
    reader("$step.plan.outputs.plan"),
  ]);
  await refused("an action that publishes no document", [
    noop("plan", { outputs: [{ name: "plan", kind: "plan" }] }),
    reader("$step.plan.outputs.plan"),
  ]);
  await refused("a step that does not exist", [
    writer(),
    reader("$step.missing.outputs.plan"),
  ]);
  await refused("a step that declared no slot", [
    writer({ outputs: undefined }),
    reader("$step.plan.outputs.plan"),
  ]);
});

const BUILD_INPUTS = {};

async function runtimeOf(document: Awaited<ReturnType<typeof compiled>>) {
  const snapshot = JSON.parse(JSON.stringify({
    schemaVersion: 1,
    inputs: BUILD_INPUTS,
    runtime: { pin: await pinWorkflowRuntime(document), document },
  }));
  const runtime = await planRuntimeFromSnapshot(snapshot);
  assert(runtime !== null);
  return runtime;
}

const planRow = (output: unknown): PlanStepRow => ({
  stepKey: "plan",
  iteration: 0,
  status: "completed",
  output: output as PlanStepRow["output"],
});

function ask(
  runtime: Awaited<ReturnType<typeof runtimeOf>>,
  rows: readonly PlanStepRow[],
) {
  return nextPlanStep(runtime, {
    inputs: BUILD_INPUTS,
    task: {},
    rows: JSON.parse(JSON.stringify(rows)),
  });
}

Deno.test("the reader's dispatch carries the document its writer published", async () => {
  const document = await compiled([
    writer(),
    reader("$step.plan.outputs.plan"),
  ]);
  assertEquals([...documentSlotsOf(document)], [["plan", "plan"]]);
  const runtime = await runtimeOf(document);
  const next = ask(runtime, [planRow({ artifacts: [ARTIFACT] })]);
  assert(next.kind === "dispatch" && next.step.kind === "action");
  const step: ActionDispatch = next.step;
  assertEquals(step.key, "build");
  assertEquals(step.inputs, [{ slot: "plan", value: ARTIFACT }]);
});

Deno.test("a field of the document is read the same way", async () => {
  const document = await compiled([
    writer(),
    reader("$step.plan.outputs.plan.versionId"),
  ]);
  const next = ask(await runtimeOf(document), [
    planRow({ artifacts: [ARTIFACT] }),
  ]);
  assert(next.kind === "dispatch" && next.step.kind === "action");
  assertEquals(next.step.inputs, [
    { slot: "plan", value: ARTIFACT.versionId },
  ]);
});

Deno.test("the stored row is not rewritten, and a step that published nothing binds null", async () => {
  const document = await compiled([
    writer(),
    reader("$step.plan.outputs.plan"),
  ]);
  const runtime = await runtimeOf(document);
  const row = planRow({ artifacts: [ARTIFACT] });
  const before = JSON.stringify(row);
  ask(runtime, [row]);
  assertEquals(JSON.stringify(row), before);
  for (const output of [{ artifacts: [] }, {}, null]) {
    const next = ask(runtime, [planRow(output)]);
    assert(next.kind === "dispatch" && next.step.kind === "action");
    assertEquals(next.step.inputs, [{ slot: "plan", value: null }]);
  }
});
