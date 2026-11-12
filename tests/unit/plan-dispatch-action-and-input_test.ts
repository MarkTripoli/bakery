import { assertEquals, assertThrows } from "@std/assert";
import {
  actionAndInputFromPlanDispatch,
  actionAndInputFromSnapshot,
  planDispatchFromRow,
} from "../../packages/persistence/src/repository-admission.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

// #30 E3b-2b. A compiled plan's dispatch becomes the action, input, required
// capabilities and frozen agent of a worker job, in the shape a flat step has.

const agentId = "00000000-0000-4000-8000-000000000002";
const otherAgentId = "00000000-0000-4000-8000-000000000005";
const skillVersion = "00000000-0000-8000-8000-000000000004";
const digest = "a".repeat(64);

const frozen = (id: string) => ({
  agentVersionId: id,
  revision: 1,
  digest,
  config: {
    harness: "pi",
    billing: {
      provider: "immutable-provider",
      billingAccountId: "immutable-account",
      model: "immutable-model",
      billingRoute: "api",
      maxTokens: 2048,
      maxUsdReservation: 1,
      pricingMetadataSnapshot: "immutable-pricing-v1",
    },
    skillBindings: { primary: skillVersion },
  },
  skillRefs: [{ versionId: skillVersion, digest }],
});

const dispatch = (over: Record<string, unknown> = {}) => ({
  action: "quality.check",
  input: { repositoryId: "r", revision: "abc", checks: ["fmt"] },
  requires: [] as string[],
  ...over,
});

const refusal = (run: () => unknown) => (assertThrows(run, Error).message);

Deno.test("a dispatch without an agent becomes its action and input, whatever agents the run froze", () => {
  const snapshot = { inputs: {}, planAgents: { [agentId]: frozen(agentId) } };
  const resolved = actionAndInputFromPlanDispatch({
    snapshot,
    dispatch: dispatch(),
  });
  assertEquals(resolved.action, "quality.check");
  assertEquals(resolved.input, dispatch().input);
  assertEquals(resolved.agent, null);
});

Deno.test("a named agent is read from the run's frozen plan agents, by version id", () => {
  const snapshot = { inputs: {}, planAgents: { [agentId]: frozen(agentId) } };
  const resolved = actionAndInputFromPlanDispatch({
    snapshot,
    dispatch: dispatch({ agentVersionId: agentId }),
  });
  assertEquals(resolved.agent?.agentVersionId, agentId);
  assertEquals(resolved.agent?.skillRefs, [{
    versionId: skillVersion,
    digest,
  }]);
});

Deno.test("a named agent the run did not freeze is refused, never looked up elsewhere", () => {
  assertEquals(
    refusal(() =>
      actionAndInputFromPlanDispatch({
        snapshot: { inputs: {}, planAgents: { [agentId]: frozen(agentId) } },
        dispatch: dispatch({ agentVersionId: otherAgentId }),
      })
    ),
    "FROZEN_STEP_AGENT_MISSING",
  );
  assertEquals(
    refusal(() =>
      actionAndInputFromPlanDispatch({
        snapshot: { inputs: {} },
        dispatch: dispatch({ agentVersionId: agentId }),
      })
    ),
    "FROZEN_STEP_AGENT_MISSING",
  );
});

Deno.test("a frozen agent filed under another version's id, or a malformed map, is refused", () => {
  assertEquals(
    refusal(() =>
      actionAndInputFromPlanDispatch({
        snapshot: {
          inputs: {},
          planAgents: { [agentId]: frozen(otherAgentId) },
        },
        dispatch: dispatch({ agentVersionId: agentId }),
      })
    ),
    "FROZEN_STEP_AGENT_INVALID",
  );
  for (const planAgents of [null, [], "x", 3]) {
    assertEquals(
      refusal(() =>
        actionAndInputFromPlanDispatch({
          snapshot: { inputs: {}, planAgents },
          dispatch: dispatch(),
        })
      ),
      "FROZEN_STEP_AGENTS_INVALID",
    );
  }
  assertEquals(
    refusal(() =>
      actionAndInputFromPlanDispatch({
        snapshot: {
          inputs: {},
          planAgents: { [agentId]: { agentVersionId: agentId } },
        },
        dispatch: dispatch(),
      })
    ),
    "FROZEN_STEP_AGENT_INVALID",
  );
});

Deno.test("a snapshot that is not an object is refused by name", () => {
  for (const snapshot of [null, [], "s", 4]) {
    assertEquals(
      refusal(() =>
        actionAndInputFromPlanDispatch({ snapshot, dispatch: dispatch() })
      ),
      "WORKFLOW_PLAN_SNAPSHOT_INVALID",
    );
  }
});

Deno.test("the dispatch's own capability request is added to the action's registered ones, and an unknown one is refused", () => {
  const plain = actionAndInputFromPlanDispatch({
    snapshot: { inputs: {} },
    dispatch: dispatch(),
  });
  const asked = actionAndInputFromPlanDispatch({
    snapshot: { inputs: {} },
    dispatch: dispatch({ requires: ["model"] }),
  });
  assertEquals(plain.requiredCapabilities.includes("model"), false);
  assertEquals(asked.requiredCapabilities.includes("model"), true);
  for (const capability of plain.requiredCapabilities) {
    assertEquals(asked.requiredCapabilities.includes(capability), true);
  }
  assertThrows(() =>
    actionAndInputFromPlanDispatch({
      snapshot: { inputs: {} },
      dispatch: dispatch({ requires: ["not-a-capability"] }),
    })
  );
});

const recorded = (over: Record<string, unknown> = {}) => ({
  key: "gate",
  id: "gate",
  action: "quality.check",
  input: { repositoryId: "r", revision: "abc", checks: ["fmt"] },
  requires: [],
  retry: { maxAttempts: 2, backoffMs: 1000, on: [] },
  timeoutMs: 600000,
  iterationPath: [],
  ...over,
});

const reasonOf = (run: () => unknown) => {
  const error = assertThrows(run, StandardError);
  assertEquals(error.code, "STATE_CONFLICT");
  return (error.params as { reason?: string } | undefined)?.reason;
};

Deno.test("a recorded dispatch is read back as the fields a job is built from", () => {
  assertEquals(planDispatchFromRow(recorded()), {
    action: "quality.check",
    input: recorded().input,
    requires: [],
    retry: { maxAttempts: 2 },
  });
  assertEquals(
    planDispatchFromRow(recorded({ agentVersionId: agentId })).agentVersionId,
    agentId,
  );
});

Deno.test("a missing or malformed recorded dispatch is a state conflict, never a guess", () => {
  for (
    const bad of [
      null,
      undefined,
      [],
      "x",
      recorded({ action: "" }),
      recorded({ action: 3 }),
      recorded({ requires: "git" }),
      recorded({ requires: [1] }),
      recorded({ agentVersionId: 7 }),
      recorded({ retry: null }),
      recorded({ retry: { maxAttempts: 0 } }),
      recorded({ retry: { maxAttempts: 1.5 } }),
      recorded({ retry: { maxAttempts: "2" } }),
      (() => {
        const { input: _input, ...withoutInput } = recorded();
        return withoutInput;
      })(),
    ]
  ) {
    assertEquals(
      reasonOf(() => planDispatchFromRow(bad)),
      "workflow_plan_dispatch_invalid",
    );
  }
});

Deno.test("actionAndInputFromSnapshot serves a plan run from the recorded dispatch and never from the flat spec", () => {
  const snapshot = {
    inputs: {},
    runtime: {},
    // A flat spec that would name a different action for the same key.
    workflow: {
      normalizedSpec: {
        steps: [{ id: "gate", uses: "harness.implement", with: {} }],
      },
    },
  };
  const resolved = actionAndInputFromSnapshot({
    runSnapshot: snapshot,
    stepKey: "gate",
    stepOutputs: {},
    repositoryId: null,
    stepDispatch: recorded(),
  });
  assertEquals(resolved.action, "quality.check");
  assertEquals(resolved.input, recorded().input);
  assertEquals(
    reasonOf(() =>
      actionAndInputFromSnapshot({
        runSnapshot: snapshot,
        stepKey: "gate",
        stepOutputs: {},
        repositoryId: null,
      })
    ),
    "workflow_plan_dispatch_invalid",
  );
});

Deno.test("a snapshot without a runtime section ignores any dispatch and keeps the flat reading", () => {
  const flat = {
    inputs: {},
    workflow: {
      normalizedSpec: {
        steps: [{
          id: "gate",
          uses: "quality.check",
          with: { checks: ["fmt"] },
        }],
      },
    },
  };
  const resolved = actionAndInputFromSnapshot({
    runSnapshot: flat,
    stepKey: "gate",
    stepOutputs: {},
    repositoryId: null,
    stepDispatch: recorded({ action: "harness.implement" }),
  });
  assertEquals(resolved.action, "quality.check");
});

Deno.test("an implement step gets the run's frozen instructions unless it carries its own, as a flat step does", () => {
  const snapshot = { inputs: { instructions: "Frozen task text." } };
  const bare = actionAndInputFromPlanDispatch({
    snapshot,
    dispatch: dispatch({
      action: "harness.implement",
      input: { repositoryId: "r" },
    }),
  });
  assertEquals(
    (bare.input as { instructions?: string }).instructions,
    "Frozen task text.",
  );
  const own = actionAndInputFromPlanDispatch({
    snapshot,
    dispatch: dispatch({
      action: "harness.implement",
      input: { repositoryId: "r", instructions: "Its own text." },
    }),
  });
  assertEquals(
    (own.input as { instructions?: string }).instructions,
    "Its own text.",
  );
});
