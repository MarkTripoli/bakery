import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ENGINE_PROJECTION_ACTIONS,
  isEngineProjectionAction,
  WORKFLOW_ACTION_METADATA,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import {
  executionActionCapabilities,
  projectionOutputOf,
} from "../../packages/persistence/src/action-admission.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { finding, fingerprintOf } from "../helpers/review-repair/fixtures.ts";

// #397 PR 2. A `projection_only` action has no worker: the engine completes it
// in its own pass, with the validated input as its output. The set of actions
// that may complete that way is named, so a registry entry that later declares
// the policy does not start completing silently.

const evidence = (over: Record<string, unknown> = {}) => ({
  headSha: "1".repeat(40),
  baseSha: "2".repeat(40),
  policyDigest: "c".repeat(64),
  checksPassed: true,
  checkRunIds: [crypto.randomUUID()],
  failedCheckIds: [],
  blockingFindings: 0,
  reviewId: crypto.randomUUID(),
  findings: [],
  ...over,
});

const reasonOf = (error: unknown) =>
  error instanceof StandardError ? error.params?.reason : undefined;

Deno.test("the engine completes exactly the actions the registry declares projection_only, and today that is one", () => {
  const declared = Object.entries(WORKFLOW_ACTION_METADATA)
    .filter(([, metadata]) => metadata.effectPolicy === "projection_only")
    .map(([name]) => name).sort();
  assertEquals(declared, ["delivery.candidate_evidence"]);
  assertEquals([...ENGINE_PROJECTION_ACTIONS].sort(), declared);
  for (const name of Object.keys(WORKFLOW_ACTION_METADATA)) {
    assertEquals(
      isEngineProjectionAction(name),
      declared.includes(name),
      name,
    );
  }
  assertEquals(isEngineProjectionAction("not.registered"), false);
});

Deno.test("a projection action declares no capability and cancels at once", () => {
  for (const name of ENGINE_PROJECTION_ACTIONS) {
    const metadata = WORKFLOW_ACTION_METADATA[name];
    assertEquals(metadata.capabilities, []);
    assertEquals(metadata.cancel, "immediate");
    assertEquals(metadata.input, metadata.output);
  }
});

Deno.test("admission knows a projection action has no capability, and still refuses an action nobody can run", () => {
  assertEquals(executionActionCapabilities("delivery.candidate_evidence"), []);
  // A projection takes no declared requirement: nothing runs it on a host.
  const declared = assertThrows(() =>
    executionActionCapabilities("delivery.candidate_evidence", ["git"])
  );
  assertEquals(reasonOf(declared), "workflow_action_requirements_invalid");
  // `rpi.plan` is registered and runtime-implemented, so admission now answers
  // for it from the registry (see the runtime/worker agreement test). This
  // assertion used to expect `workflow_action_unavailable`; the admission fix
  // falsified that, and the fix is what the runtime-implemented set intends.
  assertEquals(executionActionCapabilities("rpi.plan"), ["model"]);
  // An action in NEITHER table keeps its typed refusal - the widening is
  // bounded, not a blanket pass.
  const unavailable = assertThrows(() =>
    executionActionCapabilities("rpi.unimplemented")
  );
  assertEquals(reasonOf(unavailable), "workflow_action_unavailable");
});

Deno.test("the output of a projection is its validated input, unchanged", () => {
  const input = evidence({
    checksPassed: false,
    failedCheckIds: [crypto.randomUUID()],
    blockingFindings: 1,
    findings: [
      finding({ fingerprint: fingerprintOf(1), severity: "blocker" }),
    ],
  });
  assertEquals(projectionOutputOf("delivery.candidate_evidence", input), input);
});

Deno.test("an input that is not the action's own shape is refused, and an action that is not a projection has no output to make", () => {
  for (
    const bad of [
      evidence({ blockingFindings: "none" }),
      evidence({ checkRunIds: [] }),
      { ...evidence(), extra: true },
    ]
  ) {
    const error = assertThrows(() =>
      projectionOutputOf("delivery.candidate_evidence", bad)
    );
    assertEquals(reasonOf(error), "workflow_action_input_invalid");
  }
  const notProjection = assertThrows(() =>
    projectionOutputOf("quality.check", evidence())
  );
  assertEquals(reasonOf(notProjection), "workflow_action_unavailable");
  assert(true);
});

Deno.test("an engine-settled delivery action may redeclare the capability its registry entry holds, and nothing else (#43)", () => {
  for (
    const name of ["delivery.prepare", "delivery.deploy", "delivery.health"]
  ) {
    assertEquals(executionActionCapabilities(name), ["delivery"]);
    assertEquals(executionActionCapabilities(name, ["delivery"]), ["delivery"]);
    assertEquals(executionActionCapabilities(name, []), ["delivery"]);
    const extra = assertThrows(() =>
      executionActionCapabilities(name, ["not-a-capability"])
    );
    assertEquals(reasonOf(extra), "workflow_action_requirements_invalid");
    const twice = assertThrows(() =>
      executionActionCapabilities(name, ["delivery", "delivery"])
    );
    assertEquals(reasonOf(twice), "workflow_action_requirements_invalid");
  }
});
