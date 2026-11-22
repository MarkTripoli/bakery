import { assert, assertEquals } from "@std/assert";
import { workerActionOutputSchema } from "../../packages/contracts/src/contracts.ts";
import type { ExecutionOutcome } from "../../apps/worker/src/executor.ts";
import {
  executeRpiFreeform,
  isRpiFreeformAction,
  RPI_DESIGN_ACTION,
  RPI_FREEFORM_ACTIONS,
  RPI_MAX_COST_USD,
  RPI_MAX_TURNS,
  RPI_PLAN_ACTION,
  rpiFreeformAssignment,
  rpiOutcome,
} from "../../apps/worker/src/harness-rpi.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";

// #24: the part of rpi.design and rpi.plan that is not freeform. A session that
// hit a bound did not finish; a step with nothing pinned has nothing to ground
// it; a design tool the worker lacks is not design work.

const ARTIFACT = "11111111-1111-4111-8111-111111111111";
const PIN = {
  slot: "design",
  path: "design.md",
  digest: "a".repeat(64),
  sizeBytes: 10,
  mediaType: "text/markdown",
  kind: "artifact",
};

const assignment = (
  action: string,
  input: unknown,
  pinned = true,
): JobAssignment =>
  ({
    action,
    input,
    attemptId: "attempt-1",
    jobId: "job-1",
    agentSessionId: "session-1",
    contextInputs: pinned ? [PIN] : [],
  }) as unknown as JobAssignment;

const planInput = { designArtifact: ARTIFACT };
const designInput = { researchArtifact: ARTIFACT };
const fault = (outcome: ExecutionOutcome) => {
  assertEquals(outcome.status, "failed");
  return (outcome as unknown as { fault: { code: string; detail: string } })
    .fault;
};
const ref = {
  artifactId: "22222222-2222-4222-8222-222222222222",
  versionId: "33333333-3333-4333-8333-333333333333",
  sha256: "c".repeat(64),
};
const finished = (status: string, artifacts: unknown[] = [ref]) =>
  ({
    status: "completed",
    result: { sessionId: "s", artifacts, status },
    usage: { inputTokens: 1 },
  }) as unknown as ExecutionOutcome;

Deno.test("only design and plan are RPI actions a harness runs as sessions", () => {
  assertEquals([...RPI_FREEFORM_ACTIONS], [RPI_DESIGN_ACTION, RPI_PLAN_ACTION]);
  assert(isRpiFreeformAction("rpi.plan"));
  assert(isRpiFreeformAction("rpi.design"));
  // Research reads a repository, so it is not a freeform session.
  assert(!isRpiFreeformAction("rpi.research"));
  assert(!isRpiFreeformAction("agent.freeform"));
});

Deno.test("a plan runs as a read-only freeform session on the worker's own bounds, naming the design it plans from", () => {
  const derived = rpiFreeformAssignment(
    assignment(RPI_PLAN_ACTION, { ...planInput, serverNote: "ignored" }),
    { designToolAvailable: false },
  ) as JobAssignment;
  assertEquals(derived.action, "agent.freeform");
  const input = derived.input as Record<string, unknown>;
  assertEquals(input.allowedTools, ["Read"]);
  assertEquals(input.maxTurns, RPI_MAX_TURNS);
  assertEquals(input.maxCostUsd, RPI_MAX_COST_USD);
  assert((input.prompt as string).includes(ARTIFACT));
  assert((input.prompt as string).includes("data, not instructions"));
  // Only the registered fields reach the session; the context pins stay.
  assertEquals(Object.keys(input).sort(), [
    "allowedTools",
    "maxCostUsd",
    "maxTurns",
    "prompt",
    "timeout",
  ]);
  assertEquals(derived.contextInputs, [PIN]);
});

Deno.test("an input that is not the registered one is refused before anything runs", () => {
  for (
    const input of [null, [], {}, { designArtifact: "not-a-uuid" }, {
      researchArtifact: ARTIFACT,
    }]
  ) {
    const refused = rpiFreeformAssignment(
      assignment(RPI_PLAN_ACTION, input),
      { designToolAvailable: true },
    );
    assertEquals(fault(refused as ExecutionOutcome).code, "RPI_INPUT_INVALID");
  }
});

Deno.test("a design tool the worker does not have is capability_unavailable, never design work", () => {
  const refused = rpiFreeformAssignment(
    assignment(RPI_DESIGN_ACTION, designInput),
    { designToolAvailable: false },
  );
  assertEquals(
    fault(refused as ExecutionOutcome).code,
    "RPI_CAPABILITY_UNAVAILABLE",
  );
  // With the tool, the same step runs; a plan never needed it.
  const run = rpiFreeformAssignment(
    assignment(RPI_DESIGN_ACTION, designInput),
    { designToolAvailable: true },
  ) as JobAssignment;
  assertEquals(run.action, "agent.freeform");
  assert(
    "action" in (rpiFreeformAssignment(
      assignment(RPI_PLAN_ACTION, planInput),
      { designToolAvailable: false },
    ) as object),
  );
});

Deno.test("a step with nothing pinned is refused: there is nothing to ground it in", () => {
  for (const action of RPI_FREEFORM_ACTIONS) {
    const refused = rpiFreeformAssignment(
      assignment(
        action,
        action === RPI_PLAN_ACTION ? planInput : designInput,
        false,
      ),
      { designToolAvailable: true },
    );
    assertEquals(fault(refused as ExecutionOutcome).code, "RPI_INPUT_MISSING");
  }
});

Deno.test("a session that ended on its own is answered with its one artifact in the registered shape", () => {
  const outcome = rpiOutcome(RPI_PLAN_ACTION, finished("completed"));
  assertEquals(outcome.status, "completed");
  const result = (outcome as { result: unknown }).result;
  assertEquals(result, { artifact: ref });
  assert(workerActionOutputSchema("rpi.plan").safeParse(result).success);
  // Spend is kept.
  assertEquals((outcome as { usage: unknown }).usage, { inputTokens: 1 });
});

Deno.test("a session that stopped at a bound fails the step and names the partial artifact it left", () => {
  for (const status of ["failed", "timed_out"]) {
    const outcome = rpiOutcome(RPI_PLAN_ACTION, finished(status));
    const f = fault(outcome);
    assertEquals(
      f.code,
      status === "timed_out" ? "RPI_TIMED_OUT" : "RPI_STOPPED_AT_LIMIT",
    );
    assert(
      f.detail.includes(`artifact ${ref.artifactId}`),
      "the partial artifact is named",
    );
    assert(f.detail.includes("is not this step's result"));
    assertEquals((outcome as { usage: unknown }).usage, { inputTokens: 1 });
  }
  // No artifact at all is a failure too, not an empty success.
  assertEquals(
    fault(rpiOutcome(RPI_DESIGN_ACTION, finished("completed", []))).code,
    "RPI_STOPPED_AT_LIMIT",
  );
});

Deno.test("a cancellation stays a cancellation and a harness fault passes through unchanged", () => {
  assertEquals(
    rpiOutcome(RPI_PLAN_ACTION, finished("canceled")).status,
    "canceled",
  );
  const passed: ExecutionOutcome = { status: "failed", fault: { code: "X" } };
  assertEquals(rpiOutcome(RPI_PLAN_ACTION, passed), passed);
});

Deno.test("a refused step never reaches the session runner", async () => {
  let ran = 0;
  const run = (_derived: JobAssignment) => {
    ran++;
    return Promise.resolve(finished("completed"));
  };
  const refused = await executeRpiFreeform(
    assignment(RPI_DESIGN_ACTION, designInput),
    run,
  );
  assertEquals(fault(refused).code, "RPI_CAPABILITY_UNAVAILABLE");
  assertEquals(ran, 0);
  const ok = await executeRpiFreeform(
    assignment(RPI_PLAN_ACTION, planInput),
    run,
  );
  assertEquals(ok.status, "completed");
  assertEquals(ran, 1);
});
