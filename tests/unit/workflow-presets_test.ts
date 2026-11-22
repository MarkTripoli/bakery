import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  contractSchemas,
  findMissingDescriptions,
  workerActionOutputCarriesSession,
} from "../../packages/contracts/src/contracts.ts";
import {
  FIXED_CODING_DEFINITION,
  FIXED_CODING_PRESET,
  FIXED_CODING_REVIEWED_PRESET,
  IMPLEMENT_INSTRUCTIONS_MAX_LENGTH,
  renderImplementInstructions,
  WORKFLOW_PRESET_IDS,
  workflowPresetById,
} from "../../packages/contracts/src/workflow-presets.ts";
import {
  assertActionInput,
  workflowActionBinding,
  workflowActionCapabilities,
} from "../../packages/persistence/src/action-admission.ts";
import { actionAndInputFromSnapshot } from "../../packages/persistence/src/repository-admission.ts";
import {
  extractFixedWorkflowSteps,
  WorkflowNotExecutableError,
} from "../../apps/server/src/modules/work/run-steps.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  boundBriefPlan,
  presetActionSteps,
  presetBriefInputs,
  presetOutput,
  repeatAround,
} from "../../apps/server/src/modules/work/workflow-presets.ts";

const repositoryId = "00000000-0000-4000-8000-0000000000a1";
const artifact = {
  artifactId: "00000000-0000-4000-8000-0000000000b1",
  versionId: "00000000-0000-4000-8000-0000000000b2",
  sha256: "c".repeat(64),
};
const runId = "00000000-0000-4000-8000-0000000000c1";

/** Revision 2's flat spec: the form the claim-time flat path still reads. */
const RETIRED_FLAT_SPEC = {
  kind: "fixed" as const,
  workflow: { kind: "fixed" as const },
  steps: [
    {
      id: "brief",
      uses: "task.brief",
      with: { brief: "$input.brief", repositoryId: "$task.repositoryId" },
    },
    {
      id: "implement",
      uses: "harness.implement",
      with: {
        repositoryId: "$task.repositoryId",
        planArtifact: "$step.brief.artifact.versionId",
        instructions: "$input.instructions",
      },
    },
  ],
};

function snapshot(inputs: unknown, spec: unknown = FIXED_CODING_PRESET.spec) {
  return {
    schemaVersion: 1,
    executionMode: "repository",
    inputs,
    workflow: {
      id: runId,
      revision: FIXED_CODING_PRESET.revision,
      digest: FIXED_CODING_PRESET.digest,
      normalizedSpec: spec,
    },
    repositoryProfile: null,
    stepAgents: {},
    stepActions: {
      "flow.brief": workflowActionBinding("task.brief"),
      "flow.implement": workflowActionBinding("harness.implement"),
      brief: workflowActionBinding("task.brief"),
      implement: workflowActionBinding("harness.implement"),
    },
    admission: { dependencies: [], status: "queued", reason: null },
  };
}

Deno.test("the fixed coding preset digest pins its canonical specification", async () => {
  assertEquals(
    FIXED_CODING_PRESET.digest,
    await sha256Hex(canonicalJson(FIXED_CODING_PRESET.spec)),
  );
  assertEquals(WORKFLOW_PRESET_IDS, ["fixed-coding", "fixed-coding-reviewed"]);
  assertEquals(workflowPresetById("fixed-coding"), FIXED_CODING_PRESET);
  assertEquals(workflowPresetById("unknown"), undefined);
  assertEquals(FIXED_CODING_PRESET.defaultBudgetLimitUsd, "5.00");
  const changed = { ...FIXED_CODING_PRESET.spec, steps: [] };
  assertNotEquals(
    await sha256Hex(canonicalJson(changed)),
    FIXED_CODING_PRESET.digest,
  );
});

Deno.test("the preset is a compiled plan whose actions run in authored order", async () => {
  const steps = await presetActionSteps(FIXED_CODING_PRESET.spec);
  assertEquals(steps.map((step) => [step.key, step.action]), [
    ["flow.brief", "task.brief"],
    ["flow.implement", "harness.implement"],
  ]);
  for (const step of steps) {
    // A compiled site records the capabilities its node requests; asserting the
    // registry accepts them is what keeps a preset from claiming an unknown one.
    workflowActionCapabilities(step.action, step.requires);
  }
  // The flat executor refuses it: the container is what makes a run a plan.
  let thrown: unknown;
  try {
    extractFixedWorkflowSteps(FIXED_CODING_PRESET.spec, "fixed");
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof WorkflowNotExecutableError, String(thrown));
});

Deno.test("preset references resolve to inputs accepted by the registered action schemas", () => {
  const brief = presetBriefInputs({
    title: "Add retry",
    description: "Retry the upload.",
    task_type: "feature",
  });
  const run = snapshot(brief, RETIRED_FLAT_SPEC);
  const briefInput = actionAndInputFromSnapshot({
    runSnapshot: run,
    stepKey: "brief",
    stepOutputs: {},
    repositoryId,
  });
  assertEquals(briefInput.action, "task.brief");
  assertEquals(briefInput.input, { brief: brief.brief, repositoryId });
  assertActionInput("task.brief", briefInput.input);

  const implementInput = actionAndInputFromSnapshot({
    runSnapshot: run,
    stepKey: "implement",
    stepOutputs: { brief: { artifact } },
    repositoryId,
  });
  assertEquals(implementInput.action, "harness.implement");
  assertEquals(implementInput.input, {
    repositoryId,
    planArtifact: artifact.versionId,
    instructions: brief.instructions,
  });
  assertActionInput("harness.implement", implementInput.input);
  assertThrows(() =>
    actionAndInputFromSnapshot({
      runSnapshot: run,
      stepKey: "implement",
      stepOutputs: {},
      repositoryId,
    })
  );
});

Deno.test("task.brief input rejects unknown fields and out-of-range briefs", () => {
  const valid = {
    brief: { title: "t", description: "", taskType: "bug" },
    repositoryId,
  };
  const schema = contractSchemas.TaskBriefInput;
  assert(schema.safeParse(valid).success);
  assert(!schema.safeParse({ ...valid, extra: true }).success);
  assert(
    !schema.safeParse({
      ...valid,
      // `taskType` is an organization work-type label, not an enum: any label
      // travels here unchanged. What is still out of range is a label past the
      // 40-character bound.
      brief: { ...valid.brief, taskType: "x".repeat(41) },
    }).success,
  );
  assert(
    !schema.safeParse({
      ...valid,
      // The descriptor declares a kebab-case pattern for `taskType`, and a
      // declared pattern is a constraint: a label that is not one is refused
      // even though it is short enough to pass the length bound.
      brief: { ...valid.brief, taskType: "Not A Label" },
    }).success,
  );
  assert(
    !schema.safeParse({
      ...valid,
      brief: { ...valid.brief, description: "x".repeat(20_001) },
    }).success,
  );
  assert(
    !schema.safeParse({ ...valid, brief: { ...valid.brief, title: " " } })
      .success,
  );
});

Deno.test("task.brief publishes an artifact without needing a harness session", () => {
  assertEquals(workerActionOutputCarriesSession("task.brief"), false);
  assertEquals(workerActionOutputCarriesSession("harness.implement"), true);
  assertEquals(workerActionOutputCarriesSession("quality.check"), false);
});

Deno.test("RunCreate requires exactly one of workflowVersionId and presetId, and presets are a closed enum", () => {
  const base = { executionMode: "repository", repositoryProfileId: runId };
  const schema = contractSchemas.RunCreate;
  assert(schema.safeParse({ ...base, presetId: "fixed-coding" }).success);
  assert(
    schema.safeParse({ ...base, presetId: "fixed-coding-reviewed" }).success,
  );
  assert(schema.safeParse({ ...base, workflowVersionId: runId }).success);
  assert(!schema.safeParse(base).success);
  assert(
    !schema.safeParse({
      ...base,
      presetId: "fixed-coding",
      workflowVersionId: runId,
    }).success,
  );
  assert(!schema.safeParse({ ...base, presetId: "other" }).success);
  assert(
    schema.safeParse({
      ...base,
      workflowVersionId: runId,
      inputs: { any: "thing" },
    }).success,
  );
});

Deno.test("preset schemas are described and the availability reasons are closed", () => {
  for (
    const name of [
      "WorkflowPreset",
      "WorkflowPresetAvailability",
      "WorkflowPresetStep",
      "WorkflowPresetsListQuery",
      "Page<WorkflowPreset>",
      "TaskBrief",
      "TaskBriefInput",
      "RunCreate",
    ] as const
  ) {
    assertEquals(findMissingDescriptions(contractSchemas[name]), [], name);
  }
  const availability = contractSchemas.WorkflowPresetAvailability;
  assert(
    availability.safeParse({
      status: "ready",
      reasons: [],
      minimumBudgetLimitUsd: null,
    }).success,
  );
  assert(
    availability.safeParse({
      status: "ready",
      reasons: [],
      minimumBudgetLimitUsd: "1.500000",
    }).success,
  );
  // The field is additive on the wire: an older server omits it, and the
  // composer then has no typed-budget minimum to enforce.
  assert(availability.safeParse({ status: "ready", reasons: [] }).success);
  assert(
    availability.safeParse({
      status: "setup_required",
      reasons: ["no_active_profile", "budget_policy_unavailable"],
      minimumBudgetLimitUsd: null,
    }).success,
  );
  assert(
    availability.safeParse({
      status: "setup_required",
      reasons: ["review_agent_unavailable", "repair_agent_unavailable"],
      minimumBudgetLimitUsd: null,
    }).success,
  );
  assert(
    !availability.safeParse({
      status: "setup_required",
      reasons: ["other"],
      minimumBudgetLimitUsd: null,
    }).success,
  );
  assert(
    !availability.safeParse({
      status: "later",
      reasons: [],
      minimumBudgetLimitUsd: null,
    }).success,
  );
});

const approvedPlan = {
  planRevisionId: "00000000-0000-4000-8000-0000000000d1",
  revision: 2,
  digest: "d".repeat(64),
  title: "Add retry",
  steps: [
    { id: "s1", title: "Write test", detail: "Cover the retry path." },
    { id: "s2", title: "Implement", detail: "" },
  ],
};

Deno.test("the fixed coding preset is revision 3 and its implement step takes instructions", () => {
  assertEquals(FIXED_CODING_PRESET.revision, 3);
  const implement = FIXED_CODING_DEFINITION.steps.find((step) =>
    step.id === "flow"
  ) as { steps: { id: string; with: Record<string, string> }[] };
  assertEquals(
    implement.steps.find((step) => step.id === "implement")?.with.instructions,
    "$input.instructions",
  );
  assert(
    FIXED_CODING_PRESET.sourceYaml.includes(
      "instructions: $input.instructions",
    ),
  );
});

Deno.test("implement instructions render title and description with no plan", () => {
  assertEquals(
    renderImplementInstructions({ title: "T", description: "D" }),
    "Task: T\n\nD",
  );
  assertEquals(
    renderImplementInstructions({ title: "T", description: "" }),
    "Task: T",
  );
});

Deno.test("implement instructions render the approved plan deterministically", () => {
  const first = renderImplementInstructions({
    title: "T",
    description: "D",
    approvedPlan,
  });
  assertEquals(
    first,
    renderImplementInstructions({ title: "T", description: "D", approvedPlan }),
  );
  assertEquals(
    first,
    "Task: T\n\nD\n\nApproved plan (revision 2): Add retry\n1. Write test\n   Cover the retry path.\n2. Implement",
  );
  const brief = presetBriefInputs(
    { title: "T", description: "D", task_type: "feature" },
    approvedPlan,
  );
  assertEquals(brief.brief.approvedPlan, approvedPlan);
  assertEquals(brief.instructions, first);
  assertEquals(
    presetBriefInputs({ title: "T", description: "D", task_type: "feature" })
      .brief,
    { title: "T", description: "D", taskType: "feature" },
  );
});

Deno.test("implement instructions are bounded and never split a surrogate pair", () => {
  for (const pad of ["x", "\u{1F600}"]) {
    for (let extra = 0; extra < 3; extra++) {
      const out = renderImplementInstructions({
        title: "T",
        description: "a".repeat(extra) + pad.repeat(5000),
      });
      assert(out.length <= IMPLEMENT_INSTRUCTIONS_MAX_LENGTH);
      assert(out.endsWith("\n[truncated]"));
      // A lone surrogate would not survive a UTF-8 round trip.
      assertEquals(
        new TextDecoder().decode(new TextEncoder().encode(out)),
        out,
      );
    }
  }
});

Deno.test("brief plan stays inside the run-inputs cap with a huge multi-byte description", () => {
  const plan = {
    planRevisionId: "00000000-0000-4000-8000-000000000001",
    revision: 3,
    digest: "d".repeat(64),
    title: "Big",
    steps: Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      title: `Step ${i}`,
      detail: "\u00e9".repeat(1500),
    })),
  };
  const out = presetBriefInputs(
    { title: "T", description: "\u00e9".repeat(40000), task_type: "feature" },
    plan,
  );
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  assert(bytes < 100_000, `inputs ${bytes} bytes`);
  const kept = out.brief.approvedPlan!;
  assertEquals(kept.planRevisionId, plan.planRevisionId);
  assertEquals(kept.digest, plan.digest);
  assertEquals(kept.steps.map((s) => s.id), plan.steps.map((s) => s.id));
  // Every cut or emptied detail is flagged; none is silently shortened.
  assert(kept.steps.every((s) => s.detailShortened === true));
  // A small plan is untouched and unflagged.
  assertEquals(boundBriefPlan(plan, 0), plan);
});

Deno.test("a preset's list read names the repeat its repair steps sit in, and no other step", async () => {
  const reviewed = presetOutput(
    FIXED_CODING_REVIEWED_PRESET,
    await presetActionSteps(FIXED_CODING_REVIEWED_PRESET.spec),
    null,
  );
  // The read still satisfies the published contract.
  contractSchemas.WorkflowPreset.parse(reviewed);
  const inRepeat = reviewed.steps.filter((step) =>
    "repeatId" in step && step.repeatId !== undefined
  );
  assertEquals(
    inRepeat.map((step) => [step.id, step.uses, step.repeatId, step.repeatMax]),
    [
      ["repair.repair_implement", "harness.repair", "repair", 2],
      ["repair.repair_check", "quality.check", "repair", 2],
      ["repair.repair_review", "review.independent", "repair", 2],
    ],
  );
  // Steps outside the loop carry neither field, so an older reader sees the
  // shape it always saw.
  for (const step of reviewed.steps.filter((one) => !inRepeat.includes(one))) {
    assertEquals(Object.keys(step).sort(), ["id", "uses"], step.id);
  }
  // A preset with no repeat names none.
  const plain = presetOutput(
    FIXED_CODING_PRESET,
    await presetActionSteps(FIXED_CODING_PRESET.spec),
    null,
  );
  contractSchemas.WorkflowPreset.parse(plain);
  for (const step of plain.steps) {
    assertEquals(Object.keys(step).sort(), ["id", "uses"], step.id);
  }
});

Deno.test("the repeat fields are bounded like a repeat's own limit", () => {
  const base = {
    id: "repair.repair_implement",
    uses: "harness.repair",
  };
  const accepts = (extra: Record<string, unknown>) =>
    contractSchemas.WorkflowPresetStep.safeParse({ ...base, ...extra })
      .success;
  assert(accepts({ repeatId: "repair", repeatMax: 2 }));
  assert(accepts({}));
  assert(!accepts({ repeatId: "repair", repeatMax: 0 }));
  assert(!accepts({ repeatId: "repair", repeatMax: 9 }));
  assert(!accepts({ repeatId: "repair", repeatMax: 1.5 }));
});

Deno.test("an action site reports its nearest enclosing repeat, and only a readable one", () => {
  const document = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "nested",
    description: "x",
    inputs: {},
    steps: [
      { id: "plain", uses: "task.brief" },
      {
        id: "outer",
        repeat: {
          max: 3,
          steps: [
            { id: "a", uses: "harness.repair" },
            {
              id: "inner",
              repeat: {
                max: 2,
                steps: [{ id: "b", uses: "review.independent" }],
              },
            },
          ],
        },
      },
      {
        id: "broken",
        repeat: { max: 0, steps: [{ id: "c", uses: "review.independent" }] },
      },
      {
        id: "wrapper",
        repeat: {
          max: 4,
          steps: [{
            id: "badinner",
            repeat: {
              max: "two",
              steps: [{ id: "d", uses: "quality.check" }],
            },
          }],
        },
      },
    ],
  } as never;
  // A step outside every repeat reports none.
  assertEquals(repeatAround(document, ["steps", 0]), undefined);
  // A step directly in a repeat reports that repeat's id and limit.
  assertEquals(
    repeatAround(document, ["steps", 1, "repeat", "steps", 0]),
    { id: "outer", max: 3 },
  );
  // The nearest enclosing repeat wins over an outer one.
  assertEquals(
    repeatAround(document, [
      "steps",
      1,
      "repeat",
      "steps",
      1,
      "repeat",
      "steps",
      0,
    ]),
    { id: "inner", max: 2 },
  );
  // A repeat whose limit is not a whole number of at least one names nothing.
  assertEquals(
    repeatAround(document, ["steps", 2, "repeat", "steps", 0]),
    undefined,
  );
  // An unreadable inner repeat falls back to the readable one around it.
  assertEquals(
    repeatAround(document, [
      "steps",
      3,
      "repeat",
      "steps",
      0,
      "repeat",
      "steps",
      0,
    ]),
    { id: "wrapper", max: 4 },
  );
});
