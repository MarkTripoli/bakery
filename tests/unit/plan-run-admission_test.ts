import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  buildWorkflowPlan,
  compileWorkflowDocument,
  type WorkflowSemanticDocument,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { readPlanAgents } from "../../packages/persistence/src/repository-admission.ts";
import {
  planActionAgentBindings,
  planRunInputs,
  referencedPlanAgentIds,
  writePlanRun,
} from "../../apps/server/src/modules/workflow-adapter/plan-admission.ts";
import {
  planActionAgentsFromSnapshot,
  planInputsFromSnapshot,
  planRuntimeFromSnapshot,
  PlanStateError,
  planTaskFromSnapshot,
} from "../../apps/server/src/modules/workflow-adapter/plan-state.ts";
import { REPO_ID, workflow } from "../helpers/workflow-interpreter.ts";

// #30 E3b-2c. Admission writes the sections a compiled plan runs on: its
// frozen document and pin, the task and inputs `$task` and `$input` read, and
// the agents its steps run as. Whatever it writes must be readable by the very
// functions the engine reads it with; a section that is not is refused here,
// before any row exists, never left for the engine to trip over.

const BUILD_AGENT = "00000000-0000-4000-8000-0000000000a1";
const DEFAULT_AGENT = "00000000-0000-4000-8000-0000000000a2";
const PROFILE_AGENT = "00000000-0000-4000-8000-0000000000a3";
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

const INPUTS = {
  repo: { type: "uuid", required: true },
  count: { type: "integer", required: false },
  mode: { type: "string", required: false, enum: ["fast", "slow"] },
};

async function document(
  over: { agents?: Record<string, string>; stepAgent?: boolean } = {},
): Promise<WorkflowSemanticDocument> {
  const result = await compileWorkflowDocument({
    ...workflow([
      { id: "seed", uses: "workflow.noop", with: { x: 1 } },
      {
        id: "build",
        needs: ["seed"],
        uses: "harness.implement",
        ...(over.stepAgent === false ? {} : { agentVersionId: BUILD_AGENT }),
        with: { repositoryId: "$input.repo", planArtifact: "$step.seed.plan" },
      },
      {
        id: "again",
        needs: ["build"],
        uses: "harness.implement",
        with: { repositoryId: "$input.repo", planArtifact: "$step.seed.plan" },
      },
    ], INPUTS),
    ...(over.agents === undefined ? {} : { agents: over.agents }),
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result.document;
}

const task = { id: REPO_ID, title: "t", description: "d", status: "draft" };

/** A column as the database hands it back. */
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The first issue of an unprocessable refusal: where it is and which code. */
const refusal = (run: () => unknown) => {
  const error = assertThrows(run, StandardError);
  const issue = (error.params as {
    issues?: { path: string[]; code: string }[];
  } | undefined)?.issues?.[0];
  return issue === undefined
    ? undefined
    : { path: issue.path, code: issue.code };
};

// --- inputs

Deno.test("run inputs are checked against what the plan declares and frozen whole", async () => {
  const doc = await document();
  assertEquals(planRunInputs(doc, { repo: REPO_ID, count: 3, mode: "fast" }), {
    repo: REPO_ID,
    count: 3,
    mode: "fast",
  });
  // An optional input that is not given is frozen as null, so `$input.count`
  // reads the same on every resume.
  assertEquals(planRunInputs(doc, { repo: REPO_ID }), {
    repo: REPO_ID,
    count: null,
    mode: null,
  });
});

Deno.test("an input that is missing, undeclared or of the wrong kind is refused at its own path", async () => {
  const doc = await document();
  const cases: [unknown, string, string][] = [
    [{}, "repo", "input_required"],
    [null, "repo", "input_required"],
    [undefined, "repo", "input_required"],
    [{ repo: REPO_ID, extra: 1 }, "extra", "input_unknown"],
    [{ repo: "not-a-uuid" }, "repo", "input_invalid"],
    [{ repo: REPO_ID, count: 1.5 }, "count", "input_invalid"],
    [{ repo: REPO_ID, count: "3" }, "count", "input_invalid"],
    [{ repo: REPO_ID, mode: "medium" }, "mode", "input_invalid"],
    [{ repo: REPO_ID, mode: 7 }, "mode", "input_invalid"],
  ];
  for (const [supplied, name, reason] of cases) {
    assertEquals(
      refusal(() => planRunInputs(doc, supplied)),
      { path: ["inputs", name], code: reason },
      JSON.stringify(supplied),
    );
  }
  for (const supplied of [[], "x", 3, true]) {
    assertEquals(
      refusal(() => planRunInputs(doc, supplied)),
      { path: ["inputs"], code: "inputs_not_object" },
    );
  }
});

// --- which agent a step runs as

Deno.test("an action with no step agent falls back to the workflow's agents map, then the profile's bindings", async () => {
  const doc = await document({
    agents: { "harness.implement": DEFAULT_AGENT },
  });
  assertEquals(planActionAgentBindings(doc, undefined), {
    "harness.implement": DEFAULT_AGENT,
  });
  // The workflow's own binding wins over the profile's.
  assertEquals(
    planActionAgentBindings(doc, { "harness.implement": PROFILE_AGENT }),
    { "harness.implement": DEFAULT_AGENT },
  );
  const bare = await document();
  assertEquals(
    planActionAgentBindings(bare, { "harness.implement": PROFILE_AGENT }),
    { "harness.implement": PROFILE_AGENT },
  );
  assertEquals(planActionAgentBindings(bare, undefined), {});
});

Deno.test("an action whose every step names its own agent needs no fallback, and a binding for another action is not frozen", async () => {
  const doc = await document({
    stepAgent: true,
    agents: { "harness.implement": DEFAULT_AGENT },
  });
  // `again` has no step agent, so the fallback is needed here.
  assertEquals(planActionAgentBindings(doc, undefined), {
    "harness.implement": DEFAULT_AGENT,
  });
  const result = await compileWorkflowDocument(
    workflow([{
      id: "only",
      uses: "harness.implement",
      agentVersionId: BUILD_AGENT,
      with: { repositoryId: "$input.repo", planArtifact: "p" },
    }], INPUTS),
  );
  assert(result.ok);
  assertEquals(
    planActionAgentBindings(result.document, {
      "harness.implement": PROFILE_AGENT,
      "quality.check": PROFILE_AGENT,
    }),
    {},
  );
});

Deno.test("the agents a plan runs as are exactly the step agents and the fallbacks, once each", async () => {
  const doc = await document({
    agents: { "harness.implement": DEFAULT_AGENT },
  });
  const bindings = planActionAgentBindings(doc, undefined);
  assertEquals(referencedPlanAgentIds(doc, bindings), [
    BUILD_AGENT,
    DEFAULT_AGENT,
  ]);
  assertEquals(referencedPlanAgentIds(await document(), {}), [BUILD_AGENT]);
  // Sanity: the plan the ids are read from is the one the engine runs.
  assertEquals(
    buildWorkflowPlan(doc).steps.filter((step) => step.kind === "action")
      .map((step) => step.agentVersionId),
    [undefined, BUILD_AGENT, undefined],
  );
});

// --- the written sections

async function written(
  over: Partial<Parameters<typeof writePlanRun>[0]> = {},
) {
  const doc = over.document ?? await document({
    agents: { "harness.implement": DEFAULT_AGENT },
  });
  return await writePlanRun({
    document: doc,
    task,
    inputs: { repo: REPO_ID, count: 2 },
    agents: {
      [BUILD_AGENT]: frozen(BUILD_AGENT),
      [DEFAULT_AGENT]: frozen(DEFAULT_AGENT),
    },
    actionAgents: { "harness.implement": DEFAULT_AGENT },
    ...over,
  });
}

Deno.test("what admission writes is read back by the functions the engine reads it with", async () => {
  const sections = await written();
  const snapshot = stored({ schemaVersion: 1, ...sections });
  const runtime = await planRuntimeFromSnapshot(snapshot);
  assert(runtime !== null);
  assertEquals(runtime.pin, sections.runtime.pin);
  assertEquals(runtime.document, stored(sections.runtime.document));
  assertEquals(planInputsFromSnapshot(snapshot), {
    repo: REPO_ID,
    count: 2,
    mode: null,
  });
  assertEquals(planTaskFromSnapshot(snapshot), task);
  assertEquals(
    [...readPlanAgents(snapshot).keys()].sort(),
    [BUILD_AGENT, DEFAULT_AGENT],
  );
  assertEquals(planActionAgentsFromSnapshot(snapshot), {
    "harness.implement": DEFAULT_AGENT,
  });
  // The runtime section has exactly its two keys: the engine refuses any other.
  assertEquals(Object.keys(sections.runtime).sort(), ["document", "pin"]);
});

Deno.test("a plan with no agents writes empty agent sections that still read back", async () => {
  const result = await compileWorkflowDocument(
    workflow([{ id: "only", uses: "workflow.noop" }], {}),
  );
  assert(result.ok);
  const sections = await writePlanRun({
    document: result.document,
    task,
    inputs: null,
    agents: {},
    actionAgents: {},
  });
  const snapshot = stored({ schemaVersion: 1, ...sections });
  assertEquals(planInputsFromSnapshot(snapshot), {});
  assertEquals([...readPlanAgents(snapshot).keys()], []);
  assertEquals(planActionAgentsFromSnapshot(snapshot), {});
});

Deno.test("a document the engine could not read is refused before anything is written, by the engine's own code", async () => {
  const doc = await document({
    agents: { "harness.implement": DEFAULT_AGENT },
  });
  for (
    const broken of [
      { ...doc, kind: "other" },
      { ...doc, compilerVersion: 9 },
      { ...doc, steps: "nope" },
      null,
      [],
    ]
  ) {
    const error = await assertRejects(
      () => written({ document: broken as unknown as typeof doc }),
      PlanStateError,
    );
    assertEquals(error.code, "plan_snapshot_invalid");
  }
});

Deno.test("a task or inputs section that is not plain data is refused", async () => {
  for (const bad of [null, [], "x", 3, undefined]) {
    const error = await assertRejects(
      () => written({ task: bad as never }),
      PlanStateError,
    );
    assertEquals(error.code, "plan_snapshot_invalid");
  }
  // Data a jsonb column would change or drop is not data the run can resume on.
  for (
    const lossy of [
      { id: () => 1 },
      { id: 1n },
      { id: Number.NaN },
      { id: new Date(0) },
      { id: new Map() },
    ]
  ) {
    const error = await assertRejects(
      () => written({ task: lossy as never }),
      PlanStateError,
    );
    assertEquals(error.code, "plan_snapshot_invalid");
  }
});

Deno.test("agents the plan does not reference, or references and the run did not freeze, are refused", async () => {
  const frozenBoth = {
    [BUILD_AGENT]: frozen(BUILD_AGENT),
    [DEFAULT_AGENT]: frozen(DEFAULT_AGENT),
  };
  const refuses = async (over: Parameters<typeof written>[0]) => {
    const error = await assertRejects(() => written(over), PlanStateError);
    assertEquals(error.code, "plan_snapshot_invalid");
  };
  // A step names an agent that was not frozen.
  await refuses({ agents: { [DEFAULT_AGENT]: frozen(DEFAULT_AGENT) } });
  // The fallback names an agent that was not frozen.
  await refuses({ agents: { [BUILD_AGENT]: frozen(BUILD_AGENT) } });
  // An agent nothing references is not frozen into the run.
  await refuses({
    agents: { ...frozenBoth, [PROFILE_AGENT]: frozen(PROFILE_AGENT) },
  });
  // As many agents as the plan names, but not the ones it names.
  await refuses({
    agents: {
      [BUILD_AGENT]: frozen(BUILD_AGENT),
      [PROFILE_AGENT]: frozen(PROFILE_AGENT),
    },
  });
  // A frozen agent filed under another version's id.
  await refuses({
    agents: { ...frozenBoth, [DEFAULT_AGENT]: frozen(BUILD_AGENT) },
  });
  // A frozen agent the engine could not read.
  await refuses({
    agents: {
      ...frozenBoth,
      [DEFAULT_AGENT]: { agentVersionId: DEFAULT_AGENT } as never,
    },
  });
  // A fallback for an action the plan does not run, or to a malformed id.
  await refuses({
    actionAgents: {
      "harness.implement": DEFAULT_AGENT,
      "quality.check": BUILD_AGENT,
    },
  });
  await refuses({ actionAgents: { "harness.implement": "not-an-id" } });
  // The fallback is not the one the plan's own rules produce.
  await refuses({ actionAgents: { "harness.implement": BUILD_AGENT } });
  await refuses({ actionAgents: {} });
});

Deno.test("the sections never alias the caller's objects", async () => {
  const doc = await document({
    agents: { "harness.implement": DEFAULT_AGENT },
  });
  const input = { repo: REPO_ID, count: 2 };
  const sections = await written({ document: doc, inputs: input });
  input.count = 99;
  assertEquals((sections.inputs as { count: number }).count, 2);
  assert(sections.task !== task);
});

Deno.test("the fallback-agent section is read strictly, and a run that froze none has an empty one", () => {
  assertEquals(planActionAgentsFromSnapshot({}), {});
  assertEquals(
    planActionAgentsFromSnapshot({
      planActionAgents: { "harness.implement": DEFAULT_AGENT },
    }),
    { "harness.implement": DEFAULT_AGENT },
  );
  const refused = (snapshot: unknown) =>
    assertThrows(() => planActionAgentsFromSnapshot(snapshot), PlanStateError)
      .code;
  for (const snapshot of [null, [], "x", 3, undefined]) {
    assertEquals(refused(snapshot), "plan_snapshot_invalid");
  }
  for (const planActionAgents of [null, [], "x", 3]) {
    assertEquals(refused({ planActionAgents }), "plan_snapshot_invalid");
  }
  for (
    const planActionAgents of [
      { "Harness.Implement": DEFAULT_AGENT },
      { harness: DEFAULT_AGENT },
      { "harness.implement": "not-an-id" },
      { "harness.implement": DEFAULT_AGENT.toUpperCase() },
      { "harness.implement": 7 },
      { "harness.implement": null },
    ]
  ) {
    assertEquals(refused({ planActionAgents }), "plan_snapshot_invalid");
  }
  // More fallbacks than a plan can have actions is a malformed section.
  const tooMany = Object.fromEntries(
    Array.from(
      { length: 101 },
      (_, index) => [`action.a${index}`, DEFAULT_AGENT],
    ),
  );
  assertEquals(
    refused({ planActionAgents: tooMany }),
    "plan_snapshot_invalid",
  );
});

Deno.test("a run cannot freeze more than 100 agents, and the bound is judged before any agent is read", () => {
  const entries = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        {},
      ]),
    );
  // Over the bound the section is refused as a whole.
  assertThrows(
    () => readPlanAgents({ planAgents: entries(101) }),
    Error,
    "FROZEN_STEP_AGENTS_INVALID",
  );
  // At the bound each agent is read, and these are not agents.
  assertThrows(
    () => readPlanAgents({ planAgents: entries(100) }),
    Error,
    "FROZEN_STEP_AGENT_INVALID",
  );
});
