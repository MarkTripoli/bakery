import { assert, assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  contractSchemas,
  UnknownWorkerActionError,
  workerActionCapabilities,
  WorkerActionContractError,
  workerContractFaultCode,
} from "../../packages/contracts/src/contracts.ts";
import transport from "../../packages/contracts/generated/transport-schemas.ts";
import { executionActionCapabilities } from "../../packages/persistence/src/action-admission.ts";
import { isDispatchable } from "../../apps/server/src/modules/workflows/action-runtime.ts";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  type WorkflowActionName,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { isModelAction } from "../../apps/server/src/modules/work/budget.ts";
import { workflowRuntimeImplementedActions } from "../../packages/contracts/src/implemented-actions.ts";

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
  // Three of the four the first fix broke: a repository profile names
  // mcp.discover. secret.identity.read became a plan action in #400.
  for (
    const action of [
      "mcp.discover",
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
  assert(
    !workerOnly.includes("secret.identity.read"),
    "secret.identity.read is a registered plan action",
  );
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

// ---- #244: a defect in Bakery's own worker table is not an unknown action.
// The classification must read a typed discriminant, so these tests build each
// family by breaking the table itself, never by matching a message.

const workerTable = transport.workerActions as Record<string, unknown>;

/** Runs `body` with one worker action's entry replaced, then restores it. */
function withBrokenWorkerAction<T>(
  action: string,
  replacement: unknown,
  body: () => T,
): T {
  const original = workerTable[action];
  workerTable[action] = replacement;
  try {
    return body();
  } finally {
    workerTable[action] = original;
  }
}

/** A worker action whose contract matches its published metadata. */
const consistentAction = workerActions.find((action) =>
  registered(action)
) as string;

/** A worker action the registry does not publish: worker-only control actions. */
const workerOnlyAction = workerActions.find((action) => !registered(action));

const wireCode = (run: () => unknown): string => {
  const error = assertThrows(run, StandardError);
  return `${error.code}`;
};

Deno.test("a registered action with no capabilities is a contract defect, not an unknown action (#244)", () => {
  // A worker-table-only action: for one the registry publishes, the budget path
  // answers from the registry and never reads this table (asserted separately).
  const entry = workerTable[workerOnlyAction as string] as Record<
    string,
    unknown
  >;
  const { capabilities: _dropped, ...withoutCapabilities } = entry;
  withBrokenWorkerAction(
    workerOnlyAction as string,
    withoutCapabilities,
    () => {
      assertEquals(
        wireCode(() => isModelAction(workerOnlyAction as string)),
        "WORKER_ACTION_CAPABILITIES_INVALID",
      );
    },
  );
});

Deno.test("a capability that is not a string is the same defect, not an unknown action (#244)", () => {
  const entry = workerTable[workerOnlyAction as string] as Record<
    string,
    unknown
  >;
  withBrokenWorkerAction(
    workerOnlyAction as string,
    { ...entry, capabilities: ["model", 42] },
    () => {
      assertEquals(
        wireCode(() => isModelAction(workerOnlyAction as string)),
        "WORKER_ACTION_CAPABILITIES_INVALID",
      );
    },
  );
});

Deno.test("a contract that drifted from the published metadata is its own defect (#244)", () => {
  // Drift needs an action the registry publishes, and it surfaces on the paths
  // that read the worker table (dispatch and admission); the budget path answers
  // from the registry first and never sees this table for a published action.
  const entry = workerTable[consistentAction] as Record<string, unknown>;
  withBrokenWorkerAction(
    consistentAction,
    { ...entry, outputSchema: "drifted" },
    () => {
      // Dispatch reads the worker table for every registered action, which is
      // why drift surfaces there; the budget and admission paths answer from the
      // registry for a published action and never see this defect. Dispatch
      // rethrows the typed error rather than a wire problem, which is the point:
      // the defect must not become a routing decision.
      const dispatched = assertThrows(
        () => isDispatchable(consistentAction as WorkflowActionName),
        WorkerActionContractError,
      );
      assertEquals(dispatched.defect, "contract_drift");
      const read = assertThrows(
        () => workerActionCapabilities(consistentAction),
        WorkerActionContractError,
      );
      assertEquals(read.defect, "contract_drift");
      // And the wire mapping both error-reporting paths use is the family code.
      assertEquals(
        workerContractFaultCode(dispatched.defect),
        "WORKER_ACTION_CONTRACT_DRIFT",
      );
    },
  );
});

Deno.test("the classification reads a discriminant, so rewording a message changes nothing (#244)", () => {
  // The two families must answer differently, and each error must carry its own
  // defect. A fix that inspects error.message fails both halves.
  const entry = workerTable[consistentAction] as Record<string, unknown>;
  const { capabilities: _dropped, ...withoutCapabilities } = entry;
  const missing = withBrokenWorkerAction(
    consistentAction,
    withoutCapabilities,
    () =>
      assertThrows(
        () => workerActionCapabilities(consistentAction),
        WorkerActionContractError,
      ),
  );
  const drift = withBrokenWorkerAction(
    consistentAction,
    { ...entry, outputSchema: "drifted" },
    () =>
      assertThrows(
        () => workerActionCapabilities(consistentAction),
        WorkerActionContractError,
      ),
  );
  assertEquals(missing.defect, "capabilities_invalid");
  assertEquals(drift.defect, "contract_drift");
  assert(missing.defect !== drift.defect);
  // The arbitrary-message half: the discriminant survives any wording.
  assertEquals(
    new WorkerActionContractError("contract_drift", "anything at all").defect,
    "contract_drift",
  );
  assertEquals(
    new WorkerActionContractError("capabilities_invalid", "anything at all")
      .defect,
    "capabilities_invalid",
  );
});

Deno.test("an action nobody registered is still the caller's unknown action (#244)", () => {
  const error = assertThrows(
    () => workerActionCapabilities("not.an.action"),
    UnknownWorkerActionError,
  );
  assertEquals(error.name, "UnknownWorkerActionError");
  // And the budget path still answers the caller's refusal, unchanged.
  assertEquals(
    wireCode(() => isModelAction("not.an.action")),
    "STATE_CONFLICT",
  );
});

Deno.test("a worker-only control action with no published metadata still classifies (#244)", () => {
  assert(workerOnlyAction !== undefined, "no worker-only action in the table");
  // Accepted by design: these carry their own typed transport contracts.
  assertEquals(
    isModelAction(workerOnlyAction),
    workerActionCapabilities(workerOnlyAction).includes("model"),
  );
});

Deno.test("dispatch treats a contract defect as the defect, never as 'not dispatchable' (#244)", () => {
  const entry = workerTable[consistentAction] as Record<string, unknown>;
  const { capabilities: _dropped, ...withoutCapabilities } = entry;
  withBrokenWorkerAction(consistentAction, withoutCapabilities, () => {
    // Rethrown, not swallowed: routing must not silently take another path.
    assertThrows(
      () => isDispatchable(consistentAction as WorkflowActionName),
      WorkerActionContractError,
    );
  });
  // The unknown action keeps answering false.
  assertEquals(isDispatchable("not.an.action" as WorkflowActionName), false);
});

Deno.test("admission reports a contract defect as the defect, not as unavailable (#244)", () => {
  // Admission reads the worker table for an action the registry does not
  // publish, so that is where its own mapping is observable.
  const entry = workerTable[workerOnlyAction as string] as Record<
    string,
    unknown
  >;
  const { capabilities: _dropped, ...withoutCapabilities } = entry;
  withBrokenWorkerAction(
    workerOnlyAction as string,
    withoutCapabilities,
    () => {
      assertEquals(
        wireCode(() => executionActionCapabilities(workerOnlyAction as string)),
        "WORKER_ACTION_CAPABILITIES_INVALID",
      );
    },
  );
  // And an unknown action keeps its own refusal, not a contract code.
  assertEquals(
    wireCode(() => executionActionCapabilities("not.an.action")),
    "STATE_CONFLICT",
  );
});

// #400: a THIRD table. `workflowRuntimeImplementedActions` lists the actions the
// server runtime executes in-process. It overlaps the worker table on seven
// actions and holds two the worker table lacks (`rpi.plan`, `workflow.noop`).
// Plan admission used to know only the worker table and refused those two, which
// is why the coordination lane could not admit a `workflow.noop` step. The
// budget.ts precedent applies to capabilities too: where two tables hold an
// action they must agree, so the order of lookup cannot matter.
Deno.test("where the runtime and worker tables hold an action they agree on capabilities", () => {
  const both = workflowRuntimeImplementedActions.filter((action) =>
    workerActions.includes(action)
  );
  assert(both.length >= 7, "the runtime/worker overlap was not found");
  for (const action of both) {
    assertEquals(
      executionActionCapabilities(action),
      [...workerActionCapabilities(action)],
      `${action}: the runtime and worker tables disagree on capabilities`,
    );
  }
});

Deno.test("an action only the runtime implements is admitted from registry capabilities", () => {
  const runtimeOnly = workflowRuntimeImplementedActions.filter((action) =>
    !workerActions.includes(action)
  );
  assert(runtimeOnly.length >= 2, "the runtime-only actions were not found");
  for (const action of runtimeOnly) {
    // The worker table refuses it: no worker runs it, and adding a row there
    // would lie about the executor.
    assertThrows(
      () => workerActionCapabilities(action),
      UnknownWorkerActionError,
      `unsupported worker action capabilities: ${action}`,
    );
    // Admission answers from the registry instead, exactly as the registry
    // answers for engine projections.
    assertEquals(
      executionActionCapabilities(action),
      [...WORKFLOW_ACTION_METADATA[action as WorkflowActionName].capabilities],
      `${action}: admission did not admit a runtime-implemented action`,
    );
  }
});

Deno.test("admitting runtime-implemented actions does not admit an unknown action", () => {
  // The widening is bounded by the two known tables: a name in neither still
  // gets the typed refusal rather than a silent pass.
  const wireCode = (fn: () => unknown) => {
    try {
      fn();
      return "no-throw";
    } catch (error) {
      return (error as { params?: { reason?: string } }).params?.reason ??
        "no-reason";
    }
  };
  assertEquals(
    wireCode(() => executionActionCapabilities("rpi.unimplemented")),
    "workflow_action_unavailable",
  );
});
