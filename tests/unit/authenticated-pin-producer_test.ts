import { assertEquals, assertThrows } from "@std/assert";
import { extractFixedWorkflowSteps } from "../../apps/server/src/modules/work/run-steps.ts";
import { actionAndInputFromSnapshot } from "../../packages/persistence/src/repository-admission.ts";

const workflowAgent = "00000000-0000-4000-8000-000000000002";
const profileAgent = "00000000-0000-4000-8000-000000000003";
const otherAgent = "00000000-0000-4000-8000-000000000005";
const skillVersion = "00000000-0000-8000-8000-000000000004";
const digest = "a".repeat(64);
const billing = {
  provider: "immutable-provider",
  billingAccountId: "immutable-account",
  model: "immutable-model",
  billingRoute: "api" as const,
  maxTokens: 2048,
  maxUsdReservation: 1,
  pricingMetadataSnapshot: "immutable-pricing-v1",
};

function workflow(options: {
  workflowBinding?: string;
  stepSelector?: { readonly value: unknown };
  twoSteps?: boolean;
} = {}) {
  const step = (id: string) => ({
    id,
    uses: "quality.check",
    ...(options.stepSelector
      ? { agentVersionId: options.stepSelector.value }
      : {}),
    with: { checks: ["fmt"] },
  });
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "authenticated pin producer",
    ...(options.workflowBinding
      ? { agents: { "quality.check": options.workflowBinding } }
      : {}),
    steps: options.twoSteps ? [step("quality"), step("quality_two")] : [
      step("quality"),
    ],
  };
}

function snapshot(options: {
  workflowBinding?: string;
  profileBinding?: string;
  frozenAgentId?: string;
  includeFrozenMap?: boolean;
  stepSelector?: { readonly value: unknown };
}) {
  const normalizedSpec = workflow(options);
  const frozenAgent = options.frozenAgentId
    ? {
      agentVersionId: options.frozenAgentId,
      revision: 1,
      digest,
      config: {
        harness: "pi",
        billing,
        skillBindings: { primary: skillVersion },
      },
      skillRefs: [{ versionId: skillVersion, digest }],
    }
    : undefined;
  return {
    schemaVersion: 1,
    executionMode: "repository",
    inputs: {},
    workflow: {
      id: "00000000-0000-4000-8000-000000000010",
      revision: 1,
      digest,
      normalizedSpec,
    },
    repositoryProfile: {
      config: {
        schemaVersion: 1,
        workflow: { kind: "fixed" },
        branches: { base: "main", allowedPatterns: ["feature/*"] },
        worktree: { root: ".bakery/worktrees" },
        ...(options.profileBinding
          ? { agentBindings: { "quality.check": options.profileBinding } }
          : {}),
      },
    },
    ...(options.includeFrozenMap === false
      ? {}
      : { stepAgents: frozenAgent ? { quality: frozenAgent } : {} }),
  };
}

Deno.test("fixed-step extraction uses one workflow action binding for same-action steps", () => {
  assertEquals(
    extractFixedWorkflowSteps(
      workflow({ workflowBinding: workflowAgent, twoSteps: true }),
      "fixed",
    ),
    ["quality", "quality_two"].map((key, position) => ({
      key,
      action: "quality.check",
      input: { checks: ["fmt"] },
      position,
      workflowAgentVersionId: workflowAgent,
      stepAgentVersionId: null,
    })),
  );
});

Deno.test("fixed-step extraction accepts a valid step agent selector", () => {
  const [step] = extractFixedWorkflowSteps(
    workflow({
      workflowBinding: workflowAgent,
      stepSelector: { value: otherAgent },
    }),
    "fixed",
  );
  assertEquals(step.stepAgentVersionId, otherAgent);
  assertEquals(step.workflowAgentVersionId, workflowAgent);
});

Deno.test("fixed-step extraction rejects malformed step agent selectors", () => {
  for (const value of [null, "not-a-uuid", {}, undefined]) {
    assertThrows(() =>
      extractFixedWorkflowSteps(
        workflow({
          workflowBinding: workflowAgent,
          stepSelector: { value },
        }),
        "fixed",
      )
    );
  }
});

Deno.test("fixed-step extraction rejects malformed or unbounded workflow bindings", () => {
  assertThrows(() =>
    extractFixedWorkflowSteps(
      workflow({ workflowBinding: "not-a-uuid" }),
      "fixed",
    )
  );
  assertThrows(() =>
    extractFixedWorkflowSteps({
      ...workflow(),
      agents: Object.fromEntries(
        Array.from({ length: 18 }, (_, index) => [
          `action${index}.check`,
          workflowAgent,
        ]),
      ),
    }, "fixed")
  );
});

Deno.test("snapshot projection gives workflow action binding sole override precedence", () => {
  const projected = actionAndInputFromSnapshot({
    runSnapshot: snapshot({
      workflowBinding: workflowAgent,
      profileBinding: profileAgent,
      frozenAgentId: workflowAgent,
    }),
    stepKey: "quality",
    stepOutputs: {},
    repositoryId: null,
  });
  assertEquals(projected.action, "quality.check");
  assertEquals(projected.agent?.agentVersionId, workflowAgent);
  assertEquals(projected.agent?.config.billing, billing);
  assertEquals(projected.agent?.skillRefs, [{
    versionId: skillVersion,
    digest,
  }]);

  assertThrows(() =>
    actionAndInputFromSnapshot({
      runSnapshot: snapshot({
        workflowBinding: workflowAgent,
        profileBinding: profileAgent,
        frozenAgentId: profileAgent,
      }),
      stepKey: "quality",
      stepOutputs: {},
      repositoryId: null,
    })
  );
});

Deno.test("snapshot projection uses profile binding only as fallback", () => {
  assertEquals(
    actionAndInputFromSnapshot({
      runSnapshot: snapshot({
        profileBinding: profileAgent,
        frozenAgentId: profileAgent,
      }),
      stepKey: "quality",
      stepOutputs: {},
      repositoryId: null,
    }).agent?.agentVersionId,
    profileAgent,
  );
});

Deno.test("snapshot projection rejects malformed step selectors", () => {
  for (const value of [null, "not-a-uuid", {}, undefined]) {
    assertThrows(
      () =>
        actionAndInputFromSnapshot({
          runSnapshot: snapshot({
            workflowBinding: workflowAgent,
            profileBinding: profileAgent,
            frozenAgentId: workflowAgent,
            stepSelector: { value },
          }),
          stepKey: "quality",
          stepOutputs: {},
          repositoryId: null,
        }),
      Error,
      "WORKFLOW_AGENT_SELECTOR_INVALID",
    );
  }
});

Deno.test("snapshot projection gives a valid step selector precedence over workflow and profile", () => {
  const projected = actionAndInputFromSnapshot({
    runSnapshot: snapshot({
      workflowBinding: workflowAgent,
      profileBinding: profileAgent,
      frozenAgentId: otherAgent,
      stepSelector: { value: otherAgent },
    }),
    stepKey: "quality",
    stepOutputs: {},
    repositoryId: null,
  });
  assertEquals(projected.agent?.agentVersionId, otherAgent);
  assertEquals(
    actionAndInputFromSnapshot({
      runSnapshot: snapshot({
        workflowBinding: workflowAgent,
        frozenAgentId: workflowAgent,
        stepSelector: { value: workflowAgent },
      }),
      stepKey: "quality",
      stepOutputs: {},
      repositoryId: null,
    }).agent?.agentVersionId,
    workflowAgent,
  );
  assertThrows(
    () =>
      actionAndInputFromSnapshot({
        runSnapshot: snapshot({
          workflowBinding: workflowAgent,
          profileBinding: profileAgent,
          frozenAgentId: workflowAgent,
          stepSelector: { value: otherAgent },
        }),
        stepKey: "quality",
        stepOutputs: {},
        repositoryId: null,
      }),
    Error,
    "FROZEN_STEP_AGENT_MISMATCH",
  );
});

Deno.test("legacy snapshots remain agentless but new selectors require frozen context", () => {
  assertEquals(
    actionAndInputFromSnapshot({
      runSnapshot: snapshot({ includeFrozenMap: false }),
      stepKey: "quality",
      stepOutputs: {},
      repositoryId: null,
    }).agent,
    null,
  );
  assertEquals(
    actionAndInputFromSnapshot({
      runSnapshot: snapshot({}),
      stepKey: "quality",
      stepOutputs: {},
      repositoryId: null,
    }).agent,
    null,
  );
  assertThrows(() =>
    actionAndInputFromSnapshot({
      runSnapshot: snapshot({
        workflowBinding: workflowAgent,
        includeFrozenMap: false,
      }),
      stepKey: "quality",
      stepOutputs: {},
      repositoryId: null,
    })
  );
  assertThrows(() =>
    actionAndInputFromSnapshot({
      runSnapshot: snapshot({ frozenAgentId: otherAgent }),
      stepKey: "quality",
      stepOutputs: {},
      repositoryId: null,
    })
  );
});
