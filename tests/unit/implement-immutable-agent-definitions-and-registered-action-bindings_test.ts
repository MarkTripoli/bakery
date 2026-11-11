import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  AgentVersionCreateConfigSchema,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  WORKFLOW_ACTION_METADATA,
  WORKFLOW_ACTION_NAMES,
  WORKFLOW_ACTION_REGISTRY_VERSION,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  validateWorkflowBindings,
  validateWorkflowDefinitionStatic,
} from "../../apps/server/src/modules/workflows/validation.ts";
import {
  AGENT_VERSION_ID_PATTERN,
  isAgentVersionSelector,
  selectStepAgentVersion,
} from "../../packages/persistence/src/action-admission.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { createWorkflowActionRuntime } from "../../apps/server/src/modules/workflows/action-runtime.ts";
import { createWorkflowActionRoutes } from "../../apps/server/src/modules/workflow-actions/routes.ts";
import {
  assertDispatchableWorkflowActionsRegistered,
  ImplementedActionRegistryError,
  workflowRuntimeImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  workerActionCapabilities,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import { WorkflowActionRegistry } from "../../packages/contracts/src/workflow-action-registry.ts";
import * as persistence from "../../packages/persistence/src/index.ts";
import { extractFixedWorkflowSteps } from "../../apps/server/src/modules/work/run-steps.ts";
import { actionAndInputFromSnapshot } from "../../packages/persistence/src/repository-admission.ts";

const stepAgent = "00000000-0000-4000-8000-000000000001";
const workflowAgent = "00000000-0000-4000-8000-000000000002";
const profileAgent = "00000000-0000-4000-8000-000000000003";
const digest = "a".repeat(64);
const action = "quality.check";

Deno.test("selectStepAgentVersion resolves all eight presence combinations", () => {
  for (const hasStep of [false, true]) {
    for (const hasWorkflow of [false, true]) {
      for (const hasProfile of [false, true]) {
        const result = selectStepAgentVersion({
          action,
          stepAgentVersionId: hasStep ? stepAgent : null,
          workflowAgents: hasWorkflow ? { [action]: workflowAgent } : undefined,
          profileAgentBindings: hasProfile
            ? { [action]: profileAgent }
            : undefined,
        });
        const expected = hasStep
          ? { source: "step", agentVersionId: stepAgent }
          : hasWorkflow
          ? { source: "workflow", agentVersionId: workflowAgent }
          : hasProfile
          ? { source: "profile", agentVersionId: profileAgent }
          : { source: "none", agentVersionId: null };
        assertEquals(result, expected);
      }
    }
  }
});

Deno.test("selectStepAgentVersion ignores bindings for other actions", () => {
  assertEquals(
    selectStepAgentVersion({
      action,
      stepAgentVersionId: undefined,
      workflowAgents: { "rpi.design": workflowAgent },
      profileAgentBindings: { "rpi.design": profileAgent },
    }),
    { source: "none", agentVersionId: null },
  );
});

Deno.test("isAgentVersionSelector accepts only well-formed uuid strings", () => {
  for (const value of [stepAgent, workflowAgent, stepAgent.toUpperCase()]) {
    assertEquals(isAgentVersionSelector(value), true);
  }
  for (
    const value of [
      null,
      undefined,
      {},
      [],
      7,
      "",
      "not-a-uuid",
      "00000000-0000-9000-8000-000000000001",
      "00000000-0000-4000-c000-000000000001",
      ` ${stepAgent}`,
    ]
  ) {
    assertEquals(isAgentVersionSelector(value), false);
  }
  assertEquals(AGENT_VERSION_ID_PATTERN.test(stepAgent), true);
});

Deno.test("the selector pattern has exactly one definition", async () => {
  assertEquals(persistence.AGENT_VERSION_ID_PATTERN, AGENT_VERSION_ID_PATTERN);
  for (
    const path of [
      "apps/server/src/modules/work/run-steps.ts",
      "apps/server/src/modules/workflows/validation.ts",
      "packages/persistence/src/repository-admission.ts",
    ]
  ) {
    const source = await Deno.readTextFile(
      new URL(`../../${path}`, import.meta.url),
    );
    assertEquals(source.includes("AGENT_VERSION_ID_PATTERN ="), false, path);
  }
});

function workflowSpec(stepSelector?: unknown, withSelector = false) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "selector table",
    agents: { [action]: workflowAgent },
    steps: [{
      id: "quality",
      uses: action,
      ...(withSelector ? { agentVersionId: stepSelector } : {}),
      with: { checks: ["fmt"] },
    }],
  };
}

Deno.test("run step extraction accepts valid and rejects malformed step selectors", () => {
  assertEquals(
    extractFixedWorkflowSteps(workflowSpec(stepAgent, true))[0]
      .stepAgentVersionId,
    stepAgent,
  );
  assertEquals(
    extractFixedWorkflowSteps(workflowSpec())[0].stepAgentVersionId,
    null,
  );
  for (const value of [null, undefined, {}, "not-a-uuid", 7]) {
    assertThrows(
      () => extractFixedWorkflowSteps(workflowSpec(value, true)),
      Error,
      "WORKFLOW_VERSION_INVALID",
    );
  }
});

function snapshot(frozenAgentId: string, stepSelector?: string) {
  return {
    schemaVersion: 1,
    executionMode: "repository",
    inputs: {},
    workflow: {
      id: "00000000-0000-4000-8000-000000000010",
      revision: 1,
      digest,
      normalizedSpec: workflowSpec(stepSelector, stepSelector !== undefined),
    },
    repositoryProfile: {
      config: {
        schemaVersion: 1,
        workflow: { kind: "fixed" },
        branches: { base: "main", allowedPatterns: ["feature/*"] },
        worktree: { root: ".bakery/worktrees" },
        agentBindings: { [action]: profileAgent },
      },
    },
    stepAgents: {
      quality: {
        agentVersionId: frozenAgentId,
        revision: 1,
        digest,
        config: { harness: "pi" },
        skillRefs: [],
      },
    },
  };
}

Deno.test("snapshot projection precedence is step, then workflow, then profile", () => {
  const project = (frozen: string, selector?: string) =>
    actionAndInputFromSnapshot({
      runSnapshot: snapshot(frozen, selector),
      stepKey: "quality",
      stepOutputs: {},
      repositoryId: null,
    }).agent?.agentVersionId;
  assertEquals(project(stepAgent, stepAgent), stepAgent);
  assertEquals(project(workflowAgent), workflowAgent);
  assertThrows(
    () => project(workflowAgent, stepAgent),
    Error,
    "FROZEN_STEP_AGENT_MISMATCH",
  );
});

// Part 2: validation and publication.

const orgId = "00000000-0000-4000-8000-0000000000b1";

async function stubTransaction(
  allowedCapabilities: readonly string[],
  options: { billing?: boolean; agentIds?: readonly string[] } = {},
): Promise<PgTransactionClient> {
  const config = AgentVersionCreateConfigSchema.parse({
    harness: "codex",
    allowedCapabilities,
    ...(options.billing === false ? {} : {
      billing: {
        provider: "preset-provider",
        billingAccountId: "preset-account",
        model: "preset-model",
        billingRoute: "api",
        maxTokens: 1_000,
        maxUsdReservation: 1,
        pricingMetadataSnapshot: "preset-price",
      },
    }),
  });
  const rowDigest = await sha256Hex(canonicalJson(config));
  const ids = options.agentIds ?? [stepAgent, workflowAgent];
  const rows = ids.map((id, index) => ({
    id,
    revision: index + 1,
    config,
    digest: rowDigest,
    agent_enabled: true,
  }));
  return {
    query: (_sql: string, params: unknown[]) => {
      const wanted = new Set(params[1] as string[]);
      const found = rows.filter((row) => wanted.has(row.id));
      return Promise.resolve({ rows: found, rowCount: found.length });
    },
  } as unknown as PgTransactionClient;
}

Deno.test("static validation: invalid step selector and override keys never echo values", async () => {
  const report = await validateWorkflowDefinitionStatic({
    kind: "fixed",
    model: "leaked-model-value",
    steps: [
      {
        id: "ab",
        uses: "workflow.noop",
        agentVersionId: "leaked-selector",
        billing: "leaked-billing-value",
      },
    ],
  });
  assertFalse(report.valid);
  assertEquals(
    report.errors.map(({ path, code }) => ({ path, code })),
    [
      { path: "/model", code: "step_binding_override_forbidden" },
      { path: "/steps/0/agentVersionId", code: "step_agent_version_invalid" },
      { path: "/steps/0/billing", code: "step_binding_override_forbidden" },
    ],
  );
  const serialized = JSON.stringify(report);
  for (
    const leaked of [
      "leaked-model-value",
      "leaked-selector",
      "leaked-billing-value",
    ]
  ) {
    assertFalse(serialized.includes(leaked));
  }
});

Deno.test("model_agent_unbound warns only when neither step nor workflow binds", async () => {
  const warningsFor = async (
    steps: unknown[],
    extra: Record<string, unknown> = {},
  ) =>
    (await validateWorkflowDefinitionStatic({ kind: "fixed", steps, ...extra }))
      .warnings.filter((w) => w.code === "model_agent_unbound")
      .map((w) => w.path);
  assertEquals(
    await warningsFor([{ id: "impl", uses: "harness.implement" }]),
    ["/steps/0/uses"],
  );
  assertEquals(
    await warningsFor([
      { id: "impl", uses: "harness.implement", agentVersionId: stepAgent },
    ]),
    [],
  );
  assertEquals(
    await warningsFor([{ id: "impl", uses: "harness.implement" }], {
      agents: { "harness.implement": workflowAgent },
    }),
    [],
  );
});

Deno.test("bindings report step, workflow and none sources with pointer attribution inputs", async () => {
  const transaction = await stubTransaction(
    ["git", "shell", "web", "model", "browser"],
  );
  const result = await validateWorkflowBindings(transaction, orgId, {
    kind: "fixed",
    steps: [
      { id: "brief", uses: "task.brief" },
      { id: "first", uses: "harness.implement", agentVersionId: stepAgent },
      { id: "second", uses: "harness.implement" },
    ],
    agents: { "harness.implement": workflowAgent },
  });
  assertEquals(result.errors, []);
  assertEquals(result.bindings.map((b) => [b.stepId, b.source]), [
    ["brief", "none"],
    ["first", "step"],
    ["second", "workflow"],
  ]);
  const [brief, first, second] = result.bindings;
  assertEquals(brief.agentVersionId, null);
  assertEquals(brief.revision, null);
  assertEquals(brief.digest, null);
  assertEquals(first.agentVersionId, stepAgent);
  assertEquals(first.revision, 1);
  assertEquals(second.agentVersionId, workflowAgent);
  assertEquals(second.revision, 2);
  assert(/^[0-9a-f]{64}$/.test(first.digest ?? ""));
  assert(first.modelBillingRequired);
  assert(first.requiredCapabilities.includes("model"));
  for (const binding of result.bindings) {
    assertEquals(Object.keys(binding).sort(), [
      "action",
      "agentVersionId",
      "digest",
      "modelBillingRequired",
      "requiredCapabilities",
      "revision",
      "source",
      "stepId",
    ]);
    assert(binding.source !== "profile");
  }
});

Deno.test("binding failures attribute to the step or the workflow map, never both", async () => {
  // No billing: the model-requiring implement action is refused for both bindings.
  const transaction = await stubTransaction(["git", "shell", "web", "model"], {
    billing: false,
  });
  const result = await validateWorkflowBindings(transaction, orgId, {
    kind: "fixed",
    steps: [
      { id: "first", uses: "harness.implement", agentVersionId: stepAgent },
      { id: "second", uses: "harness.implement" },
    ],
    agents: { "harness.implement": workflowAgent },
  });
  assertEquals(result.bindings, []);
  const paths = result.errors.map(({ path }) => path);
  assert(paths.includes("/steps/0/agentVersionId"));
  assert(paths.includes("/agents/harness.implement"));
  assertFalse(JSON.stringify(result).includes(stepAgent));
});

Deno.test("unknown step-level version fails at the step pointer without echoing the id", async () => {
  const transaction = await stubTransaction(["git", "shell", "web", "model"], {
    agentIds: [],
  });
  const result = await validateWorkflowBindings(transaction, orgId, {
    kind: "fixed",
    steps: [
      { id: "first", uses: "harness.implement", agentVersionId: stepAgent },
    ],
  });
  assertEquals(
    result.errors.map(({ path, code }) => ({ path, code })),
    [{ path: "/steps/0/agentVersionId", code: "agent_version_unavailable" }],
  );
  assertEquals(result.bindings, []);
  assertFalse(JSON.stringify(result).includes(stepAgent));
});

Deno.test("unbound steps need no database round trip", async () => {
  const transaction = {
    query: () => Promise.reject(new Error("must not query")),
  } as unknown as PgTransactionClient;
  const result = await validateWorkflowBindings(transaction, orgId, {
    kind: "fixed",
    steps: [{ id: "impl", uses: "harness.implement" }],
  });
  assertEquals(result.errors, []);
  assertEquals(result.bindings[0].source, "none");
});

type Json = Record<string, unknown>;

const generated = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../packages/contracts/generated/contracts.json",
      import.meta.url,
    ),
  ),
) as { schemas: Record<string, Json> };

const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

function enumOf(schema: Json, ...path: string[]): string[] {
  let node: Json = schema;
  for (const key of path) {
    const next = (node.properties as Record<string, Json> | undefined)?.[key];
    assert(next, `schema property ${key}`);
    node = next;
  }
  if (node.type === "array") node = node.items as Json;
  assert(Array.isArray(node.enum), `enum at ${path.join(".")}`);
  return sorted(node.enum as string[]);
}

const declarationOf = (actionId: (typeof WORKFLOW_ACTION_NAMES)[number]) => ({
  actionId,
  version: WORKFLOW_ACTION_REGISTRY_VERSION,
  ...WORKFLOW_ACTION_METADATA[actionId],
  capabilities: [...WORKFLOW_ACTION_METADATA[actionId].capabilities],
  retry: {
    ...WORKFLOW_ACTION_METADATA[actionId].retry,
    faults: [...WORKFLOW_ACTION_METADATA[actionId].retry.faults],
  },
  modelBillingRequired: WORKFLOW_ACTION_METADATA[actionId].capabilities
    .includes("model"),
});

Deno.test("transport declaration enums equal the registry value sets", () => {
  const all = WORKFLOW_ACTION_NAMES.map((name) =>
    WORKFLOW_ACTION_METADATA[name]
  );
  const expected = {
    actionId: sorted(WORKFLOW_ACTION_NAMES),
    capabilities: sorted(all.flatMap((entry) => entry.capabilities)),
    cancel: sorted(all.map((entry) => entry.cancel)),
    effectPolicy: sorted(all.map((entry) => entry.effectPolicy)),
    backoff: sorted(all.map((entry) => entry.retry.backoff)),
    faults: sorted(all.flatMap((entry) => entry.retry.faults)),
  };
  const declaration = generated.schemas.WorkflowActionDeclaration;
  const retry = generated.schemas.WorkflowActionRetry;
  assertEquals(enumOf(declaration, "actionId"), expected.actionId);
  assertEquals(enumOf(declaration, "capabilities"), expected.capabilities);
  assertEquals(enumOf(declaration, "cancel"), expected.cancel);
  assertEquals(enumOf(declaration, "effectPolicy"), expected.effectPolicy);
  assertEquals(enumOf(retry, "backoff"), expected.backoff);
  assertEquals(enumOf(retry, "faults"), expected.faults);
  assertEquals(
    enumOf(generated.schemas.WorkflowActionVersionPath, "actionId"),
    expected.actionId,
  );
  assertEquals(
    enumOf(generated.schemas.WorkflowStepBinding, "action"),
    expected.actionId,
  );
  assertEquals(
    enumOf(generated.schemas.WorkflowStepBinding, "requiredCapabilities"),
    expected.capabilities,
  );
  const zodSchema = contractSchemas.WorkflowActionDeclaration;
  for (const name of WORKFLOW_ACTION_NAMES) {
    assertEquals(zodSchema.safeParse(declarationOf(name)).success, true, name);
  }
  assertEquals(
    zodSchema.safeParse({ ...declarationOf("rpi.plan"), actionId: "nope" })
      .success,
    false,
  );
});

Deno.test("modelBillingRequired is true exactly when capabilities include model", () => {
  for (const name of WORKFLOW_ACTION_NAMES) {
    assertEquals(
      declarationOf(name).modelBillingRequired,
      (WORKFLOW_ACTION_METADATA[name].capabilities as readonly string[])
        .includes("model"),
      name,
    );
  }
  assertEquals(declarationOf("harness.implement").modelBillingRequired, true);
  assertEquals(declarationOf("workflow.noop").modelBillingRequired, false);
});

Deno.test("WorkflowStepBinding publishes four sources and a bare sha256 digest", () => {
  assertEquals(
    enumOf(generated.schemas.WorkflowStepBinding, "source"),
    ["none", "profile", "step", "workflow"],
  );
  const binding = {
    stepId: "implement",
    action: "harness.implement",
    source: "step",
    agentVersionId: stepAgent,
    revision: 1,
    digest,
    requiredCapabilities: ["git", "model"],
    modelBillingRequired: true,
  };
  const schema = contractSchemas.WorkflowStepBinding;
  assert(schema.safeParse(binding).success);
  assert(
    schema.safeParse({
      ...binding,
      source: "none",
      agentVersionId: null,
      revision: null,
      digest: null,
    }).success,
  );
  assertFalse(
    schema.safeParse({ ...binding, digest: `sha256:${digest}` }).success,
  );
  assertFalse(schema.safeParse({ ...binding, digest: "a".repeat(63) }).success);
  assertFalse(schema.safeParse({ ...binding, source: "default" }).success);
  assertFalse(schema.safeParse({ ...binding, model: "gpt" }).success);
});

const runtimeSet = [
  "agent.freeform",
  "harness.implement",
  "harness.repair",
  "quality.check",
  "review.independent",
  "rpi.design",
  "rpi.plan",
  "task.brief",
  "workflow.noop",
];
const validImplement = {
  repositoryId: "00000000-0000-4000-8000-0000000000a1",
  planArtifact: "00000000-0000-4000-8000-0000000000a2",
};

Deno.test("runtime registers the exact set and the dispatchable assertion rejects omissions", () => {
  assertEquals([...workflowRuntimeImplementedActions].sort(), runtimeSet);
  const runtime = createWorkflowActionRuntime();
  assertEquals(runtime.list().map(({ action }) => action).sort(), runtimeSet);
  const dispatchable = (name: string) => {
    try {
      workerActionCapabilities(name);
      return true;
    } catch {
      return false;
    }
  };
  for (const omitted of runtimeSet.filter((name) => dispatchable(name))) {
    const partial = new WorkflowActionRegistry();
    for (const entry of runtime.list()) {
      if (entry.action !== omitted) partial.register(entry);
    }
    assertThrows(
      () => assertDispatchableWorkflowActionsRegistered(partial, dispatchable),
      ImplementedActionRegistryError,
      omitted,
    );
  }
});

Deno.test("worker-dispatched declarations pin outputSchema to the registry and the worker contract", () => {
  const runtime = createWorkflowActionRuntime();
  for (const name of runtimeSet) {
    if (name === "workflow.noop" || name === "rpi.plan") continue;
    const metadata = WORKFLOW_ACTION_METADATA[name as "quality.check"];
    const { handler } = runtime.get(name as "quality.check");
    assertEquals(handler.outputSchema, metadata.output);
    assertEquals(handler.inputSchema, metadata.input);
    assert(workerActionOutputSchema(name) !== undefined);
  }
});

Deno.test("harness.implement handler admits valid input and rejects model or unknown keys", () => {
  const { handle } = createWorkflowActionRuntime().get("harness.implement")
    .handler;
  const result = handle(validImplement) as Record<string, unknown>;
  assertEquals(result, {
    dispatch: "worker_job",
    action: "harness.implement",
    version: WORKFLOW_ACTION_REGISTRY_VERSION,
    input: validImplement,
  });
  assert(Object.isFrozen(result));
  assertThrows(() => handle({ ...validImplement, model: "x" }));
  assertThrows(() => handle({ ...validImplement, billing: {} }));
  assertThrows(() => handle({}));
});

Deno.test("rpi.plan handler fails workflow_action_unavailable", () => {
  const { handle } = createWorkflowActionRuntime().get("rpi.plan").handler;
  const error = assertThrows(
    () => handle({ designArtifact: validImplement.planArtifact }),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
  assertEquals(error.params, { reason: "workflow_action_unavailable" });
  assertThrows(() => handle({}));
});

Deno.test("runtime and discovery construction fail on schema drift", () => {
  const { PlanInput: _omitted, ...drifted } = contractSchemas;
  assertThrows(
    () => createWorkflowActionRuntime(drifted),
    ImplementedActionRegistryError,
    "PlanInput",
  );
  assertThrows(
    () =>
      createWorkflowActionRoutes({
        publicBaseUrl: "https://bakery.test",
        browserSession: (_context, next) => next(),
        schemas: drifted,
      }),
    ImplementedActionRegistryError,
    "PlanInput",
  );
});
