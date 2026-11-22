import { assertEquals, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import {
  assertImplementedWorkflowActionRegistry,
  ImplementedActionRegistryError,
  workflowRuntimeImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import { createWorkflowActionRuntime } from "../../apps/server/src/modules/workflows/action-runtime.ts";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  WORKFLOW_ACTION_REGISTRY_VERSION,
  type WorkflowActionHandlerDeclaration,
  type WorkflowActionRegistration,
  WorkflowActionRegistry,
  WorkflowActionRegistryError,
} from "../../packages/contracts/src/workflow-action-registry.ts";

const testOnlyHandler = (input: unknown): unknown => input;

function registration(
  action: keyof typeof WORKFLOW_ACTION_METADATA = "rpi.design",
): WorkflowActionRegistration {
  const metadata = WORKFLOW_ACTION_METADATA[action];
  return {
    action,
    version: WORKFLOW_ACTION_REGISTRY_VERSION,
    metadata,
    handler: {
      action,
      version: WORKFLOW_ACTION_REGISTRY_VERSION,
      inputSchema: metadata.input,
      outputSchema: metadata.output,
      handle: testOnlyHandler,
    },
  };
}

Deno.test("workflow registry exposes the exact documented metadata allowlist", () => {
  assertEquals(WORKFLOW_ACTION_NAMES.length, 24);
  assertEquals(Object.keys(WORKFLOW_ACTION_METADATA), [
    ...WORKFLOW_ACTION_NAMES,
  ]);
  assertEquals(WORKFLOW_ACTION_METADATA["rpi.research"], {
    input: "ResearchInput",
    output: "ResearchOutput",
    capabilities: ["model", "web"],
    cancel: "cooperative",
    retry: {
      maxAttempts: 2,
      backoff: "30s",
      faults: ["DEPENDENCY_TIMEOUT", "DEPENDENCY_UNAVAILABLE"],
    },
    effectPolicy: "artifact_only",
  });
  assertEquals(WORKFLOW_ACTION_METADATA["harness.implement"], {
    input: "ImplementInput",
    output: "HarnessOutput",
    capabilities: ["git", "shell", "web", "model"],
    cancel: "cooperative_fenced",
    retry: {
      maxAttempts: 1,
      backoff: "0s",
      faults: ["WORKER_UNAVAILABLE"],
    },
    effectPolicy: "repository_revision",
  });
  assertEquals(WORKFLOW_ACTION_METADATA["delivery.health"], {
    input: "HealthInput",
    output: "HealthOutput",
    capabilities: ["delivery"],
    cancel: "cooperative",
    retry: {
      maxAttempts: 3,
      backoff: "1m",
      faults: ["DEPENDENCY_TIMEOUT", "DEPENDENCY_UNAVAILABLE"],
    },
    effectPolicy: "evidence_only",
  });
  assertEquals(WORKFLOW_ACTION_METADATA["workflow.noop"], {
    input: "EmptyInput",
    output: "EmptyOutput",
    capabilities: [],
    cancel: "immediate",
    retry: { maxAttempts: 1, backoff: "0s", faults: [] },
    effectPolicy: "none",
  });
  // #554 added these two without teaching the enumerations about them, which is
  // what left this lane red on main. Pinning their metadata here is what makes
  // the count above mean something: a bump alone would pass for any two actions.
  assertEquals(WORKFLOW_ACTION_METADATA["workflow.stop"], {
    input: "WorkflowStopInput",
    output: "WorkflowStopOutput",
    capabilities: [],
    cancel: "immediate",
    retry: { maxAttempts: 1, backoff: "0s", faults: [] },
    effectPolicy: "none",
  });
  assertEquals(WORKFLOW_ACTION_METADATA["human.approval"], {
    input: "HumanApprovalInput",
    output: "HumanApprovalOutput",
    capabilities: [],
    cancel: "cooperative",
    retry: { maxAttempts: 1, backoff: "0s", faults: [] },
    effectPolicy: "none",
  });
  assertEquals(WORKFLOW_ACTION_METADATA["evaluation.sample"], {
    input: "EvaluationInput",
    output: "EvaluationOutput",
    capabilities: ["model", "storage"],
    cancel: "cooperative",
    retry: {
      maxAttempts: 1,
      backoff: "0s",
      faults: ["DEPENDENCY_UNAVAILABLE"],
    },
    effectPolicy: "evaluation_write",
  });
  // #44 slice 2: the deterministic scorer runs no model; the judge does.
  assertEquals(WORKFLOW_ACTION_METADATA["evaluation.check"], {
    input: "EvaluationCheckInput",
    output: "EvaluationCheckOutput",
    capabilities: ["storage"],
    cancel: "cooperative",
    retry: {
      maxAttempts: 2,
      backoff: "30s",
      faults: ["DEPENDENCY_UNAVAILABLE"],
    },
    effectPolicy: "evaluation_write",
  });
  assertEquals(WORKFLOW_ACTION_METADATA["evaluation.score"], {
    input: "EvaluationScoreInput",
    output: "EvaluationScoreOutput",
    capabilities: ["model", "storage"],
    cancel: "cooperative",
    retry: {
      maxAttempts: 1,
      backoff: "0s",
      faults: ["DEPENDENCY_UNAVAILABLE"],
    },
    effectPolicy: "evaluation_write",
  });
  assertEquals(WORKFLOW_ACTION_METADATA["task.brief"], {
    input: "TaskBriefInput",
    output: "ArtifactOutput",
    capabilities: [],
    cancel: "immediate",
    retry: {
      maxAttempts: 3,
      backoff: "30s",
      faults: ["DEPENDENCY_UNAVAILABLE"],
    },
    effectPolicy: "artifact_only",
  });
});

Deno.test("workflow registry stores only immutable registered handlers", () => {
  const candidate = registration();
  const registry = new WorkflowActionRegistry().register(candidate);
  const registered = registry.get("rpi.design");

  assertEquals(registered.action, "rpi.design");
  assertEquals(registered.handler.handle({ value: 1 }), { value: 1 });
  assertEquals(Object.isFrozen(registered), true);
  assertEquals(Object.isFrozen(registered.metadata), true);
  assertEquals(Object.isFrozen(registered.metadata.capabilities), true);
  assertEquals(Object.isFrozen(registered.metadata.retry), true);
  assertEquals(Object.isFrozen(registered.metadata.retry.faults), true);
  assertEquals(Object.isFrozen(registered.handler), true);
  assertEquals(Object.isFrozen(registry.list()), true);
  assertThrows(
    () => registry.get("rpi.research"),
    WorkflowActionRegistryError,
    "unavailable",
  );
});

Deno.test("workflow registry rejects unknown, duplicate, and version-mismatched actions", () => {
  const registry = new WorkflowActionRegistry().register(registration());
  assertThrows(
    () => registry.register(registration()),
    WorkflowActionRegistryError,
    "duplicate",
  );
  assertThrows(
    () =>
      new WorkflowActionRegistry().register({
        ...registration(),
        action: "provider.execute",
      } as never),
    WorkflowActionRegistryError,
    "unknown workflow action",
  );
  assertThrows(
    () =>
      new WorkflowActionRegistry().register({
        ...registration(),
        version: 2,
      } as never),
    WorkflowActionRegistryError,
    "version mismatch",
  );
});

Deno.test("workflow registry rejects metadata drift and arbitrary capabilities", () => {
  const base = registration();
  for (
    const metadata of [
      { ...base.metadata, input: "OtherInput" },
      { ...base.metadata, output: "OtherOutput" },
      {
        ...base.metadata,
        capabilities: [...base.metadata.capabilities, "docker"],
      },
      { ...base.metadata, cancel: "immediate" },
      { ...base.metadata, retry: { ...base.metadata.retry, maxAttempts: 3 } },
      { ...base.metadata, effectPolicy: "none" },
      { ...base.metadata, executableSource: "console.log('no')" },
    ]
  ) {
    assertThrows(
      () =>
        new WorkflowActionRegistry().register({
          ...base,
          metadata,
        } as never),
      WorkflowActionRegistryError,
      "metadata mismatch",
    );
  }
});

Deno.test("workflow registry rejects inconsistent handler declarations", () => {
  const base = registration();
  const mutations: Array<Partial<WorkflowActionHandlerDeclaration>> = [
    { action: "rpi.plan" },
    { version: 2 as never },
    { inputSchema: "OtherInput" },
    { outputSchema: "OtherOutput" },
    { handle: undefined as never },
  ];
  for (const mutation of mutations) {
    assertThrows(
      () =>
        new WorkflowActionRegistry().register({
          ...base,
          handler: { ...base.handler, ...mutation },
        }),
      WorkflowActionRegistryError,
      "handler declaration mismatch",
    );
  }
  assertThrows(
    () =>
      new WorkflowActionRegistry().register({
        ...base,
        handler: { ...base.handler, adapter: "provider" },
      } as never),
    WorkflowActionRegistryError,
    "handler declaration mismatch",
  );
});

Deno.test("workflow runtime registers the exact runtime set with strict schemas", () => {
  const runtime = createWorkflowActionRuntime();
  assertEquals(
    runtime.list().map(({ action }) => action).sort(),
    [
      "agent.freeform",
      "delivery.deploy",
      "delivery.health",
      "delivery.prepare",
      "evaluation.check",
      "evaluation.score",
      "harness.implement",
      "harness.repair",
      "human.approval",
      "quality.check",
      "review.independent",
      "rpi.design",
      "rpi.plan",
      "rpi.research",
      "secret.identity.read",
      "task.brief",
      "workflow.noop",
      "workflow.stop",
    ],
  );
  const { handle } = runtime.get("workflow.noop").handler;
  assertEquals(handle({}), {});
  assertThrows(() => handle({ x: 1 }));
  for (const name of ["EmptyInput", "EmptyOutput"] as const) {
    const schema = contractSchemas[name];
    assertEquals(schema.safeParse({}).success, true);
    assertEquals(schema.safeParse({ x: 1 }).success, false);
    assertEquals(descriptionDefectKind(schema.description, name), undefined);
  }
});

Deno.test("workflow runtime assertions reject tampering and drift", () => {
  const noop = WORKFLOW_ACTION_METADATA["workflow.noop"];
  assertThrows(
    () =>
      new WorkflowActionRegistry().register({
        ...registration("workflow.noop"),
        handler: {
          ...registration("workflow.noop").handler,
          inputSchema: "Other",
        },
      }),
    WorkflowActionRegistryError,
    "handler declaration mismatch",
  );
  const { EmptyOutput: _omitted, ...withoutOutput } = contractSchemas;
  assertThrows(
    () => createWorkflowActionRuntime(withoutOutput),
    ImplementedActionRegistryError,
    noop.output,
  );
  assertThrows(
    () =>
      assertImplementedWorkflowActionRegistry(
        new WorkflowActionRegistry(),
        workflowRuntimeImplementedActions,
      ),
    ImplementedActionRegistryError,
  );
  assertThrows(
    () =>
      assertImplementedWorkflowActionRegistry(
        new WorkflowActionRegistry()
          .register(registration("workflow.noop"))
          .register(registration("rpi.design")),
        workflowRuntimeImplementedActions,
      ),
    ImplementedActionRegistryError,
  );
});
