import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { parse as parseYaml } from "yaml";
import {
  planDeliveryFrom,
  planRunView,
} from "../../../apps/server/src/modules/delivery/plan-run-view.ts";
import {
  compileWorkflowDocumentDetailed,
} from "../../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import {
  type JsonValue,
  nextStep,
} from "../../../packages/contracts/src/workflow-interpreter/mod.ts";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import { RepositoryProfileConfigSchema } from "../../../packages/contracts/src/repository-profile-config.ts";
import { deriveRepositoryInspectionConfig } from "../../../apps/server/src/modules/projects/repository-inspect.ts";
import { baseProfileConfig } from "../repository-rule-entries.ts";
import {
  REVIEW_LOOP_LIMITS,
  serializedBytes,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  repositoryRuleStageViolations,
  RULE_GUARD_ALL_CHECKS,
} from "../../../packages/contracts/src/repository-rules.ts";
import {
  DELIVERY_REFERENCES,
  FIXED_CODING_PRESET,
  FIXED_CODING_REVIEWED_PRESET,
  WORKFLOW_PRESET_IDS,
  WORKFLOW_PRESETS,
  workflowPresetById,
} from "../../../packages/contracts/src/workflow-presets.ts";
import type { RepositoryVersionedProfileConfig } from "../../../packages/contracts/src/repository-inspection.ts";
import {
  assertActionInput,
  workflowActionBinding,
} from "../../../packages/persistence/src/action-admission.ts";
import {
  actionAndInputFromSnapshot,
  executionJobInputMatchesSnapshot,
  reviewLoopFromSnapshot,
} from "../../../packages/persistence/src/repository-admission.ts";
import {
  extractFixedWorkflowSteps,
  insertRunSteps,
  reviewLoopLimitsFor,
  stepReferencesEarlierOutput,
} from "../../../apps/server/src/modules/work/run-steps.ts";
import {
  fixedPolicyDeniesSteps,
  presetActionSteps,
  presetBriefInputs,
} from "../../../apps/server/src/modules/work/workflow-presets.ts";
import {
  repositoryRuleWorkflowStages,
} from "../../../apps/server/src/modules/workflows/rule-guard.ts";
import {
  planReviewLoopLimits,
} from "../../../apps/server/src/modules/review-loop/limits.ts";
import type { PgTransactionClient } from "../../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import {
  BASE_SHA,
  checkOutput,
  enumMembers,
  HEAD_SHA,
  observation,
  transportType,
} from "../deterministic-checks/observations.ts";
import {
  finding,
  JOB_INPUT_STEP_MARGIN_BYTES,
  loopSpec,
  REVIEW_LOOP_ACTIONS,
  reviewOutput,
  worstCaseFinding,
} from "./fixtures.ts";

// Issue #94 (B10.03) Phase 3: the engine and preset side. Everything here is
// pure: no database and no process, so the unit lane runs it.

const repositoryId = "00000000-0000-4000-8000-0000000000a1";
const artifact = {
  artifactId: "00000000-0000-4000-8000-0000000000b1",
  versionId: "00000000-0000-4000-8000-0000000000b2",
  sha256: "c".repeat(64),
};
const REPAIRED_SHA = "3".repeat(40);
const UNIT = "unit";
const LINT = "lint";

const PRESET = FIXED_CODING_REVIEWED_PRESET;

type StepOutputs = Record<string, unknown>;

/** The frozen run snapshot of a reviewed-preset run, as admission writes it. */
/** The plan's action steps by qualified id, for the flat readers' plan view. */
function planRunSteps(
  spec: unknown,
): readonly { stepKey: string; action: string }[] {
  return Object.entries(planActionNodes(spec)).map(([stepKey, action]) => ({
    stepKey,
    action,
  }));
}

/** The plan's action nodes by qualified id, from the definition's own nodes. */
function planActionNodes(spec: unknown): Record<string, string> {
  const actions: Record<string, string> = {};
  type Node = {
    id: string;
    uses?: string;
    steps?: Node[];
    repeat?: { steps?: Node[] };
  };
  const walk = (nodes: readonly Node[], prefix: string): void => {
    for (const node of nodes) {
      const key = `${prefix}${node.id}`;
      if (typeof node.uses === "string") actions[key] = node.uses;
      if (node.steps !== undefined) walk(node.steps, `${key}.`);
      if (node.repeat?.steps !== undefined) walk(node.repeat.steps, `${key}.`);
    }
  };
  walk((spec as { steps: Node[] }).steps, "");
  return actions;
}

/** The plan's action bindings by qualified id, from the definition's own nodes. */
function planActionBindings(spec: unknown): Record<string, unknown> {
  const bindings: Record<string, unknown> = {};
  type Node = {
    id: string;
    uses?: string;
    steps?: Node[];
    repeat?: { steps?: Node[] };
  };
  const walk = (nodes: readonly Node[], prefix: string): void => {
    for (const node of nodes) {
      const key = `${prefix}${node.id}`;
      if (typeof node.uses === "string") {
        bindings[key] = workflowActionBinding(node.uses);
      }
      if (node.steps !== undefined) walk(node.steps, `${key}.`);
      if (node.repeat?.steps !== undefined) walk(node.repeat.steps, `${key}.`);
    }
  };
  walk((spec as { steps: Node[] }).steps, "");
  return bindings;
}

function reviewedSnapshot(
  overrides: {
    spec?: unknown;
    profile?: unknown;
  } = {},
) {
  const spec = overrides.spec ?? PRESET.spec;
  const frozen = {
    schemaVersion: 1,
    executionMode: "repository",
    inputs: presetBriefInputs({
      title: "Add retry",
      description: "Retry the upload.",
      task_type: "feature",
      repository_id: repositoryId,
    }),
    workflow: {
      id: "00000000-0000-4000-8000-0000000000c1",
      revision: PRESET.revision,
      digest: PRESET.digest,
      normalizedSpec: spec,
    },
    repositoryProfile: overrides.profile === undefined
      ? {
        config: {
          schemaVersion: 2,
          fixedPolicy: {
            commands: [
              { id: UNIT, argv: ["pnpm", "test:unit"] },
              { id: LINT, argv: ["pnpm", "lint"] },
            ],
          },
        },
      }
      : overrides.profile,
    stepAgents: {},
    // The definition nests its actions, so the frozen step actions are keyed by
    // the plan's qualified ids (`flow.brief`, `repair.repair_implement`).
    stepActions: planActionBindings(spec),
    admission: { dependencies: [], status: "queued", reason: null },
  };
  // The reviewed preset is a compiled plan: the readers that answer for a flat
  // run (`candidateHeadSha`, `deliveryFactsFrom`, the `$delivery` resolvers) read
  // `workflow.normalizedSpec.steps`, so the snapshot is handed to them through
  // the plan view #472 built for exactly this.
  const view = planRunView(frozen, planRunSteps(spec)) as Record<
    string,
    unknown
  >;
  // A case that overrides the spec with a flat workflow asks about the flat
  // reader's own behaviour; mark it so `derive` keeps that reader.
  const flatOverride = overrides.spec !== undefined &&
    typeof overrides.spec === "object" && overrides.spec !== null &&
    !Object.hasOwn(overrides.spec, "apiVersion");
  return flatOverride ? { ...view, flatSpecOverride: true } : view;
}

// The reviewed preset is a compiled plan, so a step's input is what the engine
// resolves at dispatch, not what the flat snapshot reader derives. The authored
// outputs these cases use are keyed by the stage ids (`brief`, `implement`,
// `check`, `review`, `repair`); the plan keys them by their path (`flow.brief`,
// `repair.repair_check`, ...), so they are mapped onto the plan before the
// interpreter is asked.
const reviewedPlan = await compileWorkflowDocumentDetailed(PRESET.spec, {
  catalog: defaultWorkflowCompilerCatalog(),
});
const reviewedDocument = reviewedPlan.result.ok
  ? reviewedPlan.result.document
  : null;
const planKeyOf = (stageKey: string): string => {
  const steps: Array<{ qualifiedId: string; action: string }> = [];
  if (reviewedPlan.result.ok) {
    for (const step of reviewedPlan.result.plan.steps) {
      if (step.kind === "action") {
        steps.push({
          qualifiedId: step.qualifiedId,
          action: step.action ?? "",
        });
      }
    }
  }
  // A stage key names the plan step by its own id (`check` -> `flow.check`) or,
  // for the repair stage, by the action it runs (`repair` -> `harness.repair`).
  return steps.find((step) =>
    step.qualifiedId === stageKey ||
    step.qualifiedId.endsWith(`.${stageKey}`) ||
    step.action.endsWith(`.${stageKey}`)
  )?.qualifiedId ?? stageKey;
};

function derive(
  stepKey: string,
  stepOutputs: StepOutputs,
  snapshot: unknown = reviewedSnapshot(),
) {
  const key = planKeyOf(stepKey);
  // A case that overrides the spec with a flat workflow is testing the flat
  // reader's own behaviour, so it keeps that reader.
  const flatOverride = (snapshot as { flatSpecOverride?: boolean })
    .flatSpecOverride === true;
  if (reviewedDocument === null || flatOverride) {
    return actionAndInputFromSnapshot({
      runSnapshot: snapshot,
      stepKey,
      stepOutputs,
      repositoryId,
    });
  }
  // The interpreter answers with the next step, so a case that hands in outputs
  // *past* the step it asks about is asking a question about that step: keep
  // only what the plan runs before it.
  const order = reviewedPlan.result.ok
    ? reviewedPlan.result.plan.steps.flatMap((step) =>
      step.kind === "action" ? [step.qualifiedId] : []
    )
    : [];
  // A step inside a repeat runs under an iteration suffix (`repair.repair_implement@1`),
  // so the recorded outputs and the dispatch key both carry it. These cases model
  // the first repair iteration.
  const repeatKeys = new Map<string, string>();
  if (reviewedPlan.result.ok) {
    for (const step of reviewedPlan.result.plan.steps) {
      if (step.kind !== "action" || step.loops.length === 0) continue;
      let runtime = step.qualifiedId;
      for (const loop of step.loops) {
        runtime = runtime.replace(`${loop.repeat}.`, `${loop.repeat}@1.`);
      }
      repeatKeys.set(step.qualifiedId, runtime);
    }
  }
  const runtimeKeyOf = (base: string): string => repeatKeys.get(base) ?? base;
  const before = new Set(order.slice(0, Math.max(order.indexOf(key), 0)));
  const steps = new Map<
    string,
    { status: "completed"; output: JsonValue }
  >(
    Object.entries(stepOutputs).filter(([stageKey]) =>
      before.has(planKeyOf(stageKey))
    ).map(([stageKey, output]) => [
      runtimeKeyOf(planKeyOf(stageKey)),
      { status: "completed" as const, output: output as JsonValue },
    ]),
  );
  const dispatch = nextStep(reviewedDocument, {
    inputs: ((snapshot as { inputs?: Record<string, JsonValue> }).inputs ??
      {}) as Record<string, JsonValue>,
    task: { repositoryId } as JsonValue,
    steps: steps as unknown as ReadonlyMap<
      string,
      { status: "completed"; output: JsonValue }
    >,
    ...(planDeliveryFrom(snapshot, stepOutputs) === undefined
      ? {}
      : { delivery: planDeliveryFrom(snapshot, stepOutputs) as JsonValue }),
  });
  if (dispatch.kind !== "dispatch" || dispatch.step.kind !== "action") {
    throw new Error("WORKFLOW_INPUT_UNRESOLVED");
  }
  if (dispatch.step.key !== runtimeKeyOf(key)) {
    throw new Error("WORKFLOW_INPUT_UNRESOLVED");
  }
  return { action: dispatch.step.action, input: dispatch.step.input };
}

const implementOutput = (headSha = HEAD_SHA) => ({
  headSha,
  baseSha: BASE_SHA,
  sessionId: crypto.randomUUID(),
  artifacts: [],
});

/** Outputs once implement has finished: the first candidate. */
const afterImplement = (): StepOutputs => ({
  "flow.brief": { artifact },
  "flow.implement": implementOutput(),
});

/**
 * `$delivery` that the run cannot resolve yet. A flat snapshot reader answers
 * `WORKFLOW_INPUT_UNRESOLVED`; a plan resolves the same absence in the engine,
 * which refuses the dispatch as unavailable. Both mean "this reads no value
 * yet", so the assertion accepts either signal by kind.
 */
function assertUnresolved(run: () => unknown, message?: string): void {
  const thrown = assertThrows(run, Error, undefined, message);
  const text = `${(thrown as Error).message} ${
    JSON.stringify((thrown as { params?: unknown }).params ?? {})
  }`;
  assert(
    text.includes("WORKFLOW_INPUT_UNRESOLVED") ||
      text.includes("has not resolved yet") ||
      text.includes("delivery_unresolved") ||
      text.includes("UNAVAILABLE") ||
      text.includes("STATE_CONFLICT"),
    `expected an unresolved signal, got ${text}`,
  );
}

export function registerPresetCases(): void {
  registerPresetShapeCases();
  registerResolverCases();
  registerStrictAdmissionCases();
  registerOnDemandStepCases();
  registerLoopLimitCases();
  registerRuleGuardCases();
  registerProfileAndCopyCases();
}

function registerPresetShapeCases(): void {
  Deno.test("the reviewed preset is appended after fixed-coding, which stays untouched", async () => {
    assertEquals([...WORKFLOW_PRESET_IDS], [
      "fixed-coding",
      "fixed-coding-reviewed",
    ]);
    assertEquals(WORKFLOW_PRESETS.map((preset) => preset.id), [
      "fixed-coding",
      "fixed-coding-reviewed",
    ]);
    assertEquals(workflowPresetById("fixed-coding-reviewed"), PRESET);
    assertEquals(workflowPresetById("fixed-coding"), FIXED_CODING_PRESET);
    // fixed-coding keeps its exact digest, revision, budget and steps.
    // Revision 3 republished it as a compiled definition (#399); the digest
    // pins that document, and its one top-level node is the sequence.
    assertEquals(
      FIXED_CODING_PRESET.digest,
      await sha256Hex(
        canonicalJson(FIXED_CODING_PRESET.spec),
      ),
    );
    assertEquals(FIXED_CODING_PRESET.revision, 3);
    assertEquals(FIXED_CODING_PRESET.defaultBudgetLimitUsd, "5.00");
    assertEquals(FIXED_CODING_PRESET.spec.steps.map((step) => step.id), [
      "flow",
    ]);

    assertEquals(PRESET.revision, 2);
    assertEquals(PRESET.slug, "preset:fixed-coding-reviewed");
    assertEquals(PRESET.defaultBudgetLimitUsd, "12.00");
    assertEquals(PRESET.digest, await sha256Hex(canonicalJson(PRESET.spec)));
    assertNotEquals(PRESET.digest, FIXED_CODING_PRESET.digest);
    assertEquals(PRESET.stages, FIXED_CODING_PRESET.stages);
    // Revision 2 is the compiled plan: the four stages inside `flow`, then the
    // bounded repair loop as its own node.
    assertEquals(PRESET.spec.steps.map((step) => step.id), [
      "flow",
      "repair",
    ]);
    assertEquals(
      (await presetActionSteps(PRESET.spec)).map((step) => [
        step.key,
        step.action,
      ]),
      [
        ["flow.brief", "task.brief"],
        ["flow.implement", "harness.implement"],
        ["flow.check", "quality.check"],
        ["flow.review", "review.independent"],
        ["repair.repair_implement", "harness.repair"],
        ["repair.repair_check", "quality.check"],
        ["repair.repair_review", "review.independent"],
      ],
    );
  });

  Deno.test("the reviewed preset's source YAML parses to exactly its spec", () => {
    assertEquals(parseYaml(PRESET.sourceYaml), PRESET.spec);
    assertEquals(
      parseYaml(FIXED_CODING_PRESET.sourceYaml),
      FIXED_CODING_PRESET.spec,
    );
  });

  Deno.test("the reviewed preset reads its candidate, checks and findings from delivery references", () => {
    // The definition nests its nodes: `flow` holds the stages, `repair` the loop.
    type Node = {
      id: string;
      with?: Record<string, string>;
      steps?: Node[];
      repeat?: { steps?: Node[] };
    };
    const nodes = PRESET.spec.steps as readonly Node[];
    const find = (id: string, list: readonly Node[]): Node | undefined => {
      for (const node of list) {
        if (node.id === id) return node;
        const children = [...(node.steps ?? []), ...(node.repeat?.steps ?? [])];
        const hit = children.length === 0 ? undefined : find(id, children);
        if (hit !== undefined) return hit;
      }
      return undefined;
    };
    const withOf = (id: string) => {
      const node = find(id, nodes);
      assert(node !== undefined, `the definition must hold ${id}`);
      return node.with ?? {};
    };
    assertEquals(withOf("repair_implement"), {
      repositoryId: "$input.repositoryId",
      revision: "$repeat.currentCandidate.headSha",
      findings: DELIVERY_REFERENCES.blockingFindings,
      failedChecks: DELIVERY_REFERENCES.failedChecks,
    });
    assertEquals(withOf("check"), {
      repositoryId: "$input.repositoryId",
      revision: "$step.flow.implement.headSha",
      checks: DELIVERY_REFERENCES.checkIds,
    });
    assertEquals(withOf("review"), {
      repositoryId: "$input.repositoryId",
      revision: "$step.flow.implement.headSha",
      evidence: "$step.flow.check.checkRunIds",
    });
    assertEquals(
      Object.values(DELIVERY_REFERENCES).sort(),
      [
        "$delivery.blockingFindings",
        "$delivery.checkIds",
        "$delivery.failedChecks",
        "$delivery.headSha",
      ],
    );
  });

  Deno.test("the preset list schema accepts both preset ids and rejects others", () => {
    const base = {
      revision: 1,
      digest: "a".repeat(64),
      nameKey: "workflowPresets.fixedCodingReviewed.name",
      steps: [{ id: "brief", uses: "task.brief" }],
      defaultBudgetLimitUsd: "12.00",
      availability: null,
    };
    for (const id of WORKFLOW_PRESET_IDS) {
      assert(contractSchemas.WorkflowPreset.safeParse({ ...base, id }).success);
    }
    assertFalse(
      contractSchemas.WorkflowPreset.safeParse({ ...base, id: "other" })
        .success,
    );
  });
}

function registerResolverCases(): void {
  Deno.test("the check and review inputs follow the current candidate", () => {
    const outputs = afterImplement();
    const check = derive("check", outputs);
    assertEquals(check.action, "quality.check");
    assertEquals(check.input, {
      repositoryId,
      revision: HEAD_SHA,
      checks: [UNIT, LINT],
    });
    assertActionInput("quality.check", check.input);

    const checked = {
      ...outputs,
      "flow.check": checkOutput([observation({ checkId: UNIT })]),
    };
    const review = derive("review", checked);
    assertEquals(review.action, "review.independent");
    assertEquals(review.input, {
      repositoryId,
      revision: HEAD_SHA,
      evidence: checked["flow.check"].checkRunIds,
    });
    assertActionInput("review.independent", review.input);

    // After a repair the next iteration's steps use the repaired head: the
    // repeat body's own check and review, not the first candidate's. A failed
    // check and a blocking finding keep the loop inside its body.
    const repaired = {
      ...checked,
      "flow.check": checkOutput([
        observation({
          checkId: UNIT,
          result: "failed",
          reason: "exit_nonzero",
          exitCode: 1,
        }),
      ]),
      "flow.review": reviewOutput([finding({ severity: "blocker" })]),
      "repair.repair_implement": implementOutput(REPAIRED_SHA),
      "repair.repair_check": checkOutput([
        observation({ checkId: UNIT, result: "passed" }),
      ]),
    };
    assertEquals(
      (derive("repair.repair_check", repaired).input as { revision: string })
        .revision,
      REPAIRED_SHA,
    );
    assertEquals(
      (derive("repair.repair_review", repaired).input as { revision: string })
        .revision,
      REPAIRED_SHA,
    );
  });

  Deno.test("the worst-case repair input stays inside the job input step margin", () => {
    const failed = Array.from({ length: 32 }, (_, index) =>
      observation({
        checkId: `${"c".repeat(99)}${index % 10}`,
        result: "unavailable",
        reason: "metadata_too_large",
        exitCode: 255,
      }));
    const input = derive("repair", {
      ...afterImplement(),
      "flow.check": checkOutput(failed),
      "flow.review": reviewOutput(
        Array.from(
          { length: REVIEW_LOOP_LIMITS.maxFindings },
          (_, index) => worstCaseFinding(index, "é"),
        ),
      ),
    }).input;
    assertActionInput("harness.repair", input);
    const bytes = serializedBytes(input);
    assert(
      bytes <= JOB_INPUT_STEP_MARGIN_BYTES,
      `${bytes} bytes exceed the ${JOB_INPUT_STEP_MARGIN_BYTES} byte margin`,
    );
    assertEquals(
      (input as { failedChecks: unknown[] }).failedChecks.length,
      32,
    );
  });

  Deno.test("admission and claim-time re-derivation resolve the same repair input", () => {
    const unit = observation({
      checkId: UNIT,
      result: "failed",
      reason: "exit_nonzero",
      exitCode: 1,
    });
    const blocker = finding({ severity: "blocker" });
    // The shape the claim query builds: latest output per step, round-tripped
    // through JSON the way Postgres stores it.
    const stored = JSON.parse(JSON.stringify({
      ...afterImplement(),
      "flow.check": checkOutput([unit]),
      "flow.review": reviewOutput([blocker]),
    })) as StepOutputs;
    // A plan run's snapshot carries its runtime section, and the step row
    // carries the dispatch the engine recorded for it.
    const snapshot = {
      ...JSON.parse(JSON.stringify(reviewedSnapshot())),
      runtime: { document: reviewedDocument },
      planAgents: {},
    };
    const admitted = derive("repair", stored, snapshot);
    const jobInput = JSON.parse(JSON.stringify(admitted.input));
    const row = {
      runSnapshot: snapshot,
      stepKey: "repair@1.repair_implement",
      stepOutputs: stored,
      repositoryId,
      stepDispatch: {
        action: "harness.repair",
        input: jobInput,
        requires: [],
        retry: { maxAttempts: 1 },
      },
    };
    assert(
      executionJobInputMatchesSnapshot(row, "harness.repair", jobInput),
    );
    // Any drift in the stored job input is refused at claim time.
    for (
      const drifted of [
        { ...jobInput, revision: REPAIRED_SHA },
        { ...jobInput, findings: [] },
        { ...jobInput, failedChecks: [] },
        { ...jobInput, repositoryId: crypto.randomUUID() },
      ]
    ) {
      assertFalse(
        executionJobInputMatchesSnapshot(row, "harness.repair", drifted),
      );
    }
    // A newer harness output moving the candidate is the plan view's own
    // behaviour (`tests/unit/read-a-plan-run-like-a-flat-one_test.ts` owns it),
    // so this case stays on the preset's admission/claim agreement.
    // Deriving twice from the same facts is deterministic.
    assertEquals(
      canonicalJson(derive("repair", stored, snapshot).input),
      canonicalJson(admitted.input),
    );
  });

  Deno.test("unknown delivery references are unresolved, never passed through", () => {
    const snapshot = reviewedSnapshot({
      spec: {
        kind: "fixed",
        workflow: { kind: "fixed" },
        steps: [
          { id: "one", uses: "task.brief", with: { x: "$delivery.nope" } },
          {
            id: "two",
            uses: "task.brief",
            with: { x: "$delivery.headSha.extra" },
          },
          { id: "three", uses: "task.brief", with: { x: "$delivery." } },
        ],
      },
    });
    for (const stepKey of ["one", "two", "three"]) {
      assertUnresolved(() => derive(stepKey, afterImplement(), snapshot));
    }
  });
}

function registerStrictAdmissionCases(): void {
  const reference = (input: unknown) => stepReferencesEarlierOutput({ input });

  Deno.test("strict admission tolerates references that need earlier step output", () => {
    assert(reference({ planArtifact: "$step.brief.artifact.versionId" }));
    assert(reference({ revision: DELIVERY_REFERENCES.headSha }));
    assert(reference({ findings: DELIVERY_REFERENCES.failedChecks }));
    assert(reference({ findings: DELIVERY_REFERENCES.blockingFindings }));
    assert(reference({
      nested: { deeper: [DELIVERY_REFERENCES.headSha] },
    }));
    // The pinned profile alone resolves checkIds; nothing else is deferred.
    assertFalse(reference({ checks: DELIVERY_REFERENCES.checkIds }));
    assertFalse(reference({ brief: "$input.brief", repositoryId: "x" }));
    assertFalse(reference({}));
    assertFalse(reference(null));
    assertFalse(reference(undefined));
    // A misspelled delivery name is not deferred, so admission fails loudly.
    assertFalse(reference({ revision: "$delivery.headsha" }));
    assertFalse(reference({ revision: "$delivery.headSha.extra" }));
    assertFalse(reference({ revision: "$delivery.checkIdsX" }));
    assertFalse(reference({ text: "mentions $delivery.headSha in prose" }));
  });

  Deno.test("each reviewed preset step either resolves from the profile alone or is deferred", async () => {
    const steps = await presetActionSteps(PRESET.spec);
    const snapshot = reviewedSnapshot();
    for (const step of steps) {
      let resolved = true;
      try {
        derive(step.key, {}, snapshot);
      } catch (error) {
        assertEquals((error as Error).message, "WORKFLOW_INPUT_UNRESOLVED");
        resolved = false;
      }
      // Whatever cannot resolve with no outputs is exactly what strict
      // admission measures from its literal input.
      assertEquals(
        resolved,
        !stepReferencesEarlierOutput(step) && step.key === "flow.brief",
        step.key,
      );
    }
    for (const step of steps.filter((entry) => entry.key !== "flow.brief")) {
      assert(stepReferencesEarlierOutput(step), step.key);
    }
  });
}

function registerOnDemandStepCases(): void {
  Deno.test("the reviewed preset marks only its repair step on demand and keeps spec positions", async () => {
    // The plan's actions in authored order: the four stages inside `flow`, then
    // the repeat body's repair, re-check and re-review.
    const steps = await presetActionSteps(PRESET.spec);
    assertEquals(
      steps.map((step) => [step.key, step.position]),
      [
        ["flow.brief", 0],
        ["flow.implement", 1],
        ["flow.check", 2],
        ["flow.review", 3],
        ["repair.repair_implement", 4],
        ["repair.repair_check", 5],
        ["repair.repair_review", 6],
      ],
    );
    // Plain fixed-coding has no loop and no on-demand step: its plan is the
    // two actions in one sequence.
    assertEquals(
      await presetActionSteps(FIXED_CODING_PRESET.spec).then((steps) =>
        steps.map((step) => step.onDemand)
      ),
      [undefined, undefined],
    );
  });

  Deno.test("a repair step is on demand only inside the exact loop shape", () => {
    // The compiled reviewed preset declares the loop as a repeat, so its repair
    // action is the one the engine appends when the candidate is not clean.
    assert(reviewedPlan.result.ok);
    const planRepair = reviewedPlan.result.plan.steps.find((step) =>
      step.kind === "action" && step.action === "harness.repair"
    );
    assert(planRepair !== undefined, "the plan must hold a repair action");
    assertEquals(planRepair.kind === "action" && planRepair.loops.length, 1);
    const cases: Array<[string, unknown, boolean]> = [
      [
        "repair after check",
        loopSpec([
          "harness.implement",
          "quality.check",
          "harness.repair",
          "review.independent",
        ]),
        false,
      ],
      [
        "no revision step before repair",
        loopSpec([
          "task.brief",
          "harness.repair",
          "quality.check",
          "review.independent",
        ]),
        false,
      ],
      [
        "conditional check",
        loopSpec([
          "harness.implement",
          "harness.repair",
          { uses: "quality.check", if: "true" },
          "review.independent",
        ]),
        false,
      ],
      [
        "two reviews",
        loopSpec([
          "harness.implement",
          "harness.repair",
          "quality.check",
          "review.independent",
          "review.independent",
        ]),
        false,
      ],
      [
        "no review",
        loopSpec([
          "harness.implement",
          "harness.repair",
          "quality.check",
        ]),
        false,
      ],
    ];
    for (const [label, spec, onDemand] of cases) {
      const repair = extractFixedWorkflowSteps(spec).filter((step) =>
        step.action === "harness.repair"
      );
      assertEquals(repair.length, 1, label);
      assertEquals(repair[0].onDemand === true, onDemand, label);
    }
  });

  Deno.test("a workflow cannot use the reserved delivery gate step id", () => {
    const spec = {
      kind: "fixed",
      workflow: { kind: "fixed" },
      steps: [{ id: "delivery_gate", uses: "workflow.noop", with: {} }],
    };
    assertThrows(
      () => extractFixedWorkflowSteps(spec),
      Error,
      "WORKFLOW_VERSION_INVALID",
    );
    // Other noop ids stay fine.
    extractFixedWorkflowSteps({
      ...spec,
      steps: [{ id: "delivery_done", uses: "workflow.noop", with: {} }],
    });
  });

  Deno.test("run admission inserts no row for an on-demand step", async () => {
    const calls: Array<{ sql: string; parameters: unknown[] }> = [];
    const transaction = {
      query: (sql: string, parameters: unknown[]) => {
        calls.push({ sql, parameters });
        return Promise.resolve({ rows: [] });
      },
    } as unknown as PgTransactionClient;
    // A flat loop spec is the executor's own shape: the repair step is on
    // demand, so admission writes no row for it and the rows that exist keep
    // their spec positions. A compiled preset is a plan, and plan admission
    // writes no step rows at all (the engine appends each one).
    const flat = loopSpec(REVIEW_LOOP_ACTIONS);
    await insertRunSteps(transaction, {
      organizationId: "org",
      runId: "run",
      steps: extractFixedWorkflowSteps(flat),
    });
    assertEquals(calls.length, 1);
    const [org, run] = calls[0].parameters as [string, string];
    assertEquals([org, run], ["org", "run"]);
    const rowsOf = (parameters: unknown[]) => {
      const [, , ...triples] = parameters as [unknown, unknown, ...unknown[]];
      const rows: Array<[unknown, unknown]> = [];
      for (let index = 0; index < triples.length; index += 3) {
        rows.push([triples[index], triples[index + 1]]);
      }
      return rows;
    };
    // Triples of (key, position, encoded input): positions keep the spec index.
    assertEquals(rowsOf(calls[0].parameters), [
      ["step0", 0],
      ["step1", 1],
      ["step3", 3],
      ["step4", 4],
    ]);
    // fixed-coding is a compiled plan now, so its action list is the plan's
    // keys, not a flat list admission could insert.
    const plain = await presetActionSteps(FIXED_CODING_PRESET.spec);
    assertEquals(plain.map((step) => [step.key, step.position]), [
      ["flow.brief", 0],
      ["flow.implement", 1],
    ]);
  });
}

function registerLoopLimitCases(): void {
  // The compiled reviewed preset declares its bound on its repeat node; a flat
  // workflow declares it in `limits.maxRepairCycles`.
  const flatLoop = loopSpec(REVIEW_LOOP_ACTIONS);
  const withLimit = (maxRepairCycles: unknown) => ({
    ...flatLoop,
    limits: { maxRepairCycles },
  });

  Deno.test("a review loop freezes the default bounds and a workflow may lower or choose the repair count", () => {
    assertEquals(planReviewLoopLimits(reviewedDocument!), {
      maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCycles,
      maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
      maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
    });
    assertEquals(reviewLoopLimitsFor(flatLoop), {
      maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCycles,
      maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
      maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
    });
    assertEquals(reviewLoopLimitsFor(withLimit(0))?.maxRepairCycles, 0);
    assertEquals(reviewLoopLimitsFor(withLimit(1))?.maxRepairCycles, 1);
    assertEquals(reviewLoopLimitsFor(withLimit(5))?.maxRepairCycles, 5);
    assertEquals(
      reviewLoopLimitsFor(withLimit(REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling))
        ?.maxRepairCycles,
      REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling,
    );
    // Other limits keys do not change the loop bounds.
    assertEquals(
      reviewLoopLimitsFor({ ...flatLoop, limits: { wallClock: "24h" } })
        ?.maxRepairCycles,
      REVIEW_LOOP_LIMITS.maxRepairCycles,
    );
  });

  Deno.test("a repair count outside the ceiling invalidates the workflow", async () => {
    for (const bad of [-1, 9, 1.5, "2", null, Number.NaN]) {
      assertThrows(
        () => reviewLoopLimitsFor(withLimit(bad)),
        Error,
        "WORKFLOW_VERSION_INVALID",
        String(bad),
      );
    }
    // A compiled definition's bound is its repeat's `max`, and the compiler
    // refuses one past the ceiling before any run can freeze it.
    const tooMany = JSON.parse(JSON.stringify(PRESET.spec));
    tooMany.steps[1].repeat.max = REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling + 1;
    const compiled = await compileWorkflowDocumentDetailed(tooMany, {
      catalog: defaultWorkflowCompilerCatalog(),
    });
    assertFalse(compiled.result.ok);
  });

  Deno.test("a spec without the loop shape freezes no bounds", () => {
    assertEquals(reviewLoopLimitsFor(FIXED_CODING_PRESET.spec), null);
    assertEquals(reviewLoopLimitsFor({ steps: [] }), null);
    assertEquals(reviewLoopLimitsFor(null), null);
    // A limit on a workflow with no loop is ignored, not an error.
    assertEquals(
      reviewLoopLimitsFor({
        ...FIXED_CODING_PRESET.spec,
        limits: { maxRepairCycles: 99 },
      }),
      null,
    );
  });

  Deno.test("the snapshot reader returns the frozen bounds and fails closed on a malformed key", () => {
    const limits = planReviewLoopLimits(reviewedDocument!)!;
    assertEquals(reviewLoopFromSnapshot({ reviewLoop: limits }), limits);
    assertEquals(reviewLoopFromSnapshot({}), null);
    assertEquals(reviewLoopFromSnapshot(null), null);
    assertEquals(reviewLoopFromSnapshot("x"), null);
    for (
      const malformed of [
        null,
        {},
        { ...limits, extra: 1 },
        { ...limits, maxRepairCycles: 9 },
        { ...limits, maxFindings: 26 },
        { ...limits, maxLoopDurationMs: 0 },
        { maxRepairCycles: 2, maxLoopDurationMs: 1 },
      ]
    ) {
      assertThrows(
        () => reviewLoopFromSnapshot({ reviewLoop: malformed }),
        Error,
        "RUN_SNAPSHOT_REVIEW_LOOP_INVALID",
        JSON.stringify(malformed),
      );
    }
  });
}

function registerRuleGuardCases(): void {
  Deno.test("the marker covers every bound command, in order, and nothing else does", () => {
    const need = [
      { ruleKey: "code.magicNumbers" as const, commandId: "any.command" },
      { ruleKey: "code.magicStrings" as const, commandId: "other" },
    ];
    const stage = (checks: readonly string[], producesRevision = false) => ({
      checks,
      producesRevision,
    });
    const implement = stage([], true);
    // implement -> repair -> check(*) satisfies every requirement.
    assertEquals(
      repositoryRuleStageViolations(need, [
        implement,
        stage([], true),
        stage([RULE_GUARD_ALL_CHECKS]),
      ]),
      [],
    );
    // The marker before the last revision-producing stage does not count.
    assertEquals(
      repositoryRuleStageViolations(need, [
        implement,
        stage([RULE_GUARD_ALL_CHECKS]),
        stage([], true),
      ]).map((violation) => violation.reason),
      ["stage_before_revision", "stage_before_revision"],
    );
    // No check stage at all is still a missing stage.
    assertEquals(
      repositoryRuleStageViolations(need, [implement, stage([], true)]).map((
        violation,
      ) => violation.reason),
      ["stage_missing", "stage_missing"],
    );
  });

  Deno.test("a literal checks array can never forge the all-checks marker", () => {
    const forged = repositoryRuleWorkflowStages([
      { action: "harness.implement", input: {} },
      { action: "quality.check", input: { checks: [RULE_GUARD_ALL_CHECKS] } },
      {
        action: "quality.check",
        input: { checks: ["unit", RULE_GUARD_ALL_CHECKS] },
      },
    ]);
    assertEquals(forged.map((stage) => stage.checks), [[], [], ["unit"]]);
    // A reference to anything else than the delivery list is not the marker.
    const other = repositoryRuleWorkflowStages([
      { action: "quality.check", input: { checks: "$input.checks" } },
      { action: "quality.check", input: { checks: "*" } },
    ]);
    assertEquals(other.map((stage) => stage.checks), [[], []]);
  });
}

function registerProfileAndCopyCases(): void {
  const config = (value: unknown) =>
    value as unknown as RepositoryVersionedProfileConfig;
  const policy = (allowedEffects: string[], commands = 1) => ({
    commands: Array.from({ length: commands }, (_, index) => ({
      id: `c${index}`,
      argv: ["x"],
    })),
    allowedEffects,
  });
  const ALL = [
    "artifact_only",
    "repository_revision",
    "evidence_only",
    "review_evidence",
  ];
  // The reviewed preset is a compiled plan now: its actions come from the plan.
  const reviewedSteps = () => presetActionSteps(PRESET.spec);
  // The compiled plan's action steps: same actions, keys prefixed by `flow.`.
  const plainSteps = () => presetActionSteps(FIXED_CODING_PRESET.spec);

  Deno.test("the reviewed preset needs an observed fixed policy that allows all four effects", async () => {
    const steps = await reviewedSteps();
    const denies = (profile: unknown) =>
      fixedPolicyDeniesSteps(config(profile), steps);
    assertFalse(denies({ schemaVersion: 2, fixedPolicy: policy(ALL) }));
    // No policy, a v1 draft, a policy without commands or a missing effect.
    assert(denies({ schemaVersion: 1 }));
    assert(denies({ schemaVersion: 2 }));
    assert(denies({ schemaVersion: 1, fixedPolicy: policy(ALL) }));
    assert(denies({ schemaVersion: 2, fixedPolicy: policy(ALL, 0) }));
    for (const effect of ALL) {
      assert(
        denies({
          schemaVersion: 2,
          fixedPolicy: policy(ALL.filter((entry) => entry !== effect)),
        }),
        effect,
      );
    }
  });

  Deno.test("fixed-coding availability by effects is exactly what it always was", async () => {
    const steps = await plainSteps();
    const denies = (profile: unknown) =>
      fixedPolicyDeniesSteps(config(profile), steps);
    // No policy permits the plain coding steps.
    assertFalse(denies({ schemaVersion: 1 }));
    assertFalse(denies({ schemaVersion: 2 }));
    assertFalse(
      denies({
        schemaVersion: 1,
        fixedPolicy: policy(["artifact_only", "repository_revision"]),
      }),
    );
    assert(
      denies({ schemaVersion: 1, fixedPolicy: policy(["evidence_only"]) }),
    );
    assert(
      denies({ schemaVersion: 1, fixedPolicy: policy(["artifact_only"]) }),
    );
  });

  Deno.test("observed v2 derivation carries the baseline agent bindings, and none stays none", async () => {
    // Agent bindings are repository intent: a run on the observed profile can
    // only admit its model steps if the observed profile still names them.
    const envelope = {
      organizationId: "00000000-0000-4000-8000-000000000001",
      applicationId: "00000000-0000-4000-8000-000000000002",
      repositoryId: "00000000-0000-4000-8000-000000000003",
      source: {
        mappingRevision: "rev-1",
        mappingDigest: "a".repeat(64),
        baseSha: "b".repeat(40),
        manifestDigest: await sha256Hex(canonicalJson([])),
      },
      entries: [],
    };
    const bindings = {
      "harness.implement": crypto.randomUUID(),
      "harness.repair": crypto.randomUUID(),
      "review.independent": crypto.randomUUID(),
    };
    const observed = deriveRepositoryInspectionConfig(
      RepositoryProfileConfigSchema.parse({
        ...baseProfileConfig,
        agentBindings: bindings,
      }),
      envelope,
    );
    assertEquals(observed.agentBindings, bindings);
    // Re-deriving from an observed baseline keeps them.
    assertEquals(
      deriveRepositoryInspectionConfig(observed, envelope).agentBindings,
      bindings,
    );
    const without = deriveRepositoryInspectionConfig(
      RepositoryProfileConfigSchema.parse(baseProfileConfig),
      envelope,
    );
    assertEquals("agentBindings" in without, false);
  });

  Deno.test("every contract availability reason has web setup copy and a translation", async () => {
    const reasons = enumMembers(
      (transportType("WorkflowPresetAvailability").fieldTypes as Record<
        string,
        string
      >).reasons.replace(/\[\]$/, ""),
    );
    assert(reasons.includes("review_agent_unavailable"));
    assert(reasons.includes("repair_agent_unavailable"));
    assertEquals(reasons.length, 14);

    // The web package is a React build the Deno lane cannot import, so the
    // composer's reason list and preset copy are read from its source.
    const labels = await Deno.readTextFile(
      new URL(
        "../../../apps/web/src/pages/task-composer-labels.ts",
        import.meta.url,
      ),
    );
    const list = /export const SETUP_REASONS[^=]*=\s*\[([^\]]*)\]/.exec(labels);
    assert(list, "SETUP_REASONS list not found");
    const webReasons = [...list[1].matchAll(/"([a-z_]+)"/g)].map((match) =>
      match[1]
    );
    assertEquals([...webReasons].sort(), [...reasons].sort());

    const catalogs: Record<string, Record<string, string>> = {};
    for (const locale of ["en", "en-XA", "ar-XB"]) {
      catalogs[locale] = JSON.parse(
        await Deno.readTextFile(
          new URL(
            `../../../packages/i18n/locales/${locale}.json`,
            import.meta.url,
          ),
        ),
      );
    }
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const reason of reasons) {
        const key = `tasks.composer.setup.${reason}`;
        assert(
          typeof catalog[key] === "string" && catalog[key].length > 20,
          `${locale} lacks ${key}`,
        );
      }
      for (const key of ["title", "description"]) {
        const preset = `tasks.preset.fixedCodingReviewed.${key}`;
        assert(
          typeof catalog[preset] === "string" && catalog[preset].length > 20,
          `${locale} lacks ${preset}`,
        );
      }
    }
    // The journeys select the first preset's radio by /Fixed coding/. Neither
    // the title nor the description of the reviewed preset may match it, or
    // those specs would find two radios against a real server.
    for (
      const key of [
        "tasks.preset.fixedCodingReviewed.title",
        "tasks.preset.fixedCodingReviewed.description",
      ]
    ) {
      assertFalse(/Fixed coding/.test(catalogs.en[key]), key);
    }
    // presetCopy names a case for every preset id, so none falls back to its id.
    for (const id of WORKFLOW_PRESET_IDS) {
      assert(labels.includes(`case "${id}":`), `presetCopy has no case ${id}`);
    }
  });
}
