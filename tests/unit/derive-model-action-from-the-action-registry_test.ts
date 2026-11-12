import { assert, assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  contractSchemas,
  workerActionCapabilities,
} from "../../packages/contracts/src/contracts.ts";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  type WorkflowActionName,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { isModelAction } from "../../apps/server/src/modules/work/budget.ts";

// #182: the server decided "does this action run a model?" from the worker
// transport table, which lists only 7 of the 19 registered workflow actions, so
// it threw for the other 12 even where the registry (and so the compiler) says
// "model". #226: the fix then consulted only the registry and so threw for the 4
// actions only a worker runs (mcp.discover, secret.identity.read, ...), which
// repository profiles and admission name. There are two tables, each holding
// actions the other lacks, and the answer comes from whichever holds the action:
// the registry first, then the worker table, and a typed refusal for neither.

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

/** The actions a worker runs, as the assignment contract lists them. */
const workerActions = (() => {
  const action = (contractSchemas.JobAssignment as unknown as {
    shape: { action: { options: readonly string[] } };
  }).shape.action;
  return [...action.options];
})();

const registered = (action: string) =>
  Object.hasOwn(WORKFLOW_ACTION_METADATA, action);

Deno.test("every action a worker runs is classified, never refused (#226)", () => {
  assert(workerActions.length >= 11, "the worker action list was not read");
  for (const action of workerActions) {
    const expected = registered(action)
      ? registryRunsModel(action as WorkflowActionName)
      : workerActionCapabilities(action).includes("model");
    assertEquals(isModelAction(action), expected, action);
  }
});

Deno.test("actions only a worker runs are classified from the worker table (#226)", () => {
  const workerOnly = workerActions.filter((action) => !registered(action));
  // The four the first fix broke: a repository profile names mcp.discover, and
  // admission names secret.identity.read.
  for (
    const action of [
      "mcp.discover",
      "secret.identity.read",
      "repository.inspect",
      "coordinator.turn",
    ]
  ) {
    assert(
      workerOnly.includes(action),
      `${action} is expected to be worker-only`,
    );
    assertEquals(
      isModelAction(action),
      workerActionCapabilities(action).includes("model"),
      action,
    );
  }
  assertEquals(isModelAction("mcp.discover"), false);
  assertEquals(isModelAction("secret.identity.read"), false);
});

Deno.test("where both tables hold an action they agree, so the order of lookup cannot matter (#226)", () => {
  const both = workerActions.filter(registered);
  assert(both.length >= 7, "the overlap was not found");
  for (const action of both) {
    assertEquals(
      workerActionCapabilities(action).includes("model"),
      registryRunsModel(action as WorkflowActionName),
      `${action}: the two tables disagree`,
    );
  }
});

Deno.test("an action neither table holds is refused with a typed error, not guessed to be a non-model action", () => {
  // Including names an object inherits: "constructor" is not an action.
  for (
    const name of ["not.an.action", "", "constructor", "toString", "__proto__"]
  ) {
    const error = assertThrows(() => isModelAction(name), StandardError);
    assertEquals(error.code, "STATE_CONFLICT", name);
    assertEquals(error.params?.["reason"], "workflow_action_unsupported", name);
    // The reason is a fixed code; the name the caller sent is not echoed.
    assert(
      !JSON.stringify(error.params ?? {}).includes(name || "\u0000"),
      name,
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
