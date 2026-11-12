import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  type WorkflowActionName,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { isModelAction } from "../../apps/server/src/modules/work/budget.ts";

// #182: the server decided "does this action run a model?" from the worker
// transport table, which lists only 7 of the 19 registered actions, so it threw
// for the other 12 even where the registry (and so the compiler) says "model".
// The registry is the one source of truth; these tests hold the server to it.

const AGENT_VERSION = "abcdefab-cdef-4abc-8def-abcdefabcdef";

const registryRunsModel = (action: WorkflowActionName): boolean =>
  WORKFLOW_ACTION_METADATA[action].capabilities.includes("model");

Deno.test("isModelAction answers from the action registry for every registered action", () => {
  for (const action of WORKFLOW_ACTION_NAMES) {
    assertEquals(isModelAction(action), registryRunsModel(action), action);
  }
});

Deno.test("the registry-only model actions the old rule threw for are model actions", () => {
  for (const action of ["rpi.research", "rpi.plan", "evaluation.sample"]) {
    assert(
      registryRunsModel(action as WorkflowActionName),
      `${action} is expected to be a model action in the registry`,
    );
    assertEquals(isModelAction(action), true, action);
  }
});

Deno.test("an action without the model capability is not a model action", () => {
  assertEquals(isModelAction("workflow.noop"), false);
  assertEquals(isModelAction("delivery.merge"), false);
});

Deno.test("an unregistered action is refused by name, not guessed to be a non-model action", () => {
  // Including names an object inherits: "constructor" is not a registered action.
  for (
    const name of ["not.an.action", "", "constructor", "toString", "__proto__"]
  ) {
    assertThrows(
      () => isModelAction(name),
      Error,
      "unsupported workflow action",
    );
  }
});

Deno.test("it agrees with the compiler's rule for which steps may select an agent version", async () => {
  // The compiler accepts agentVersionId exactly on model actions. Whatever the
  // budget and executor paths decide must be the same decision.
  for (const action of WORKFLOW_ACTION_NAMES) {
    const result = await compileWorkflowDocument({
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "model-rule",
      description: "One step that selects an agent version.",
      inputs: {},
      steps: [{ id: "probe", uses: action, agentVersionId: AGENT_VERSION }],
    });
    const refused = !result.ok &&
      result.diagnostics.some((diagnostic) =>
        diagnostic.code === "step_agent_version_forbidden"
      );
    assertEquals(refused, !isModelAction(action), action);
  }
});
