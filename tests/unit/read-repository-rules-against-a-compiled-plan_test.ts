import { assertEquals } from "@std/assert";
import {
  OrganizationRepositoryRulesSchema,
  type RepositoryRuleStageRequirement,
  repositoryRuleStageRequirements,
  repositoryRuleStageViolations,
  RULE_GUARD_ALL_CHECKS,
} from "../../packages/contracts/src/repository-rules.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/compile.ts";
import {
  FIXED_CODING_DEFINITION,
  FIXED_CODING_REVIEWED_DEFINITION,
  type WorkflowPresetDocument,
} from "../../packages/contracts/src/workflow-presets.ts";
import type { WorkflowNode } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { planRuleViolations } from "../../apps/server/src/modules/workflows/plan-rule-guard.ts";
import { compiled } from "../helpers/workflow-interpreter.ts";

// #398. A `require` rule names a fixed policy command, and the guard checks
// that the workflow runs it after the last stage that changes the revision. A
// flat workflow is a list, so the order is the list. A compiled plan has a
// shape: a branch arm or a guarded step may not run, a repeat body runs zero
// or more times, and the lanes of a parallel group have no order. The guard
// credits a check only when it runs after the last revision on EVERY path.

const req = (commandId: string): RepositoryRuleStageRequirement => ({
  ruleKey: "magic-numbers" as RepositoryRuleStageRequirement["ruleKey"],
  commandId,
});
const REQS = [req("x"), req("y")];

let counter = 0;
const base = () => ({
  id: `step_${++counter}`,
  needs: [] as string[],
  requires: [] as string[],
  timeoutMs: 60_000,
  retry: { maxAttempts: 1, backoffMs: 0, on: [] as string[] },
});
const GUARD = {
  kind: "compare",
  op: "eq",
  left: { kind: "ref", root: "input", path: ["go"] },
  right: { kind: "literal", value: true },
};

type Stage = "R" | "C*" | "Cx" | "Cy" | "N";
const node = (stage: Stage, guarded = false): WorkflowNode => {
  const common = { ...base(), ...(guarded ? { if: GUARD } : {}) };
  const action = stage === "R"
    ? "harness.implement"
    : stage === "N"
    ? "workflow.noop"
    : "quality.check";
  const checks = stage === "C*"
    ? { kind: "ref", root: "delivery", path: ["checkIds"] }
    : stage === "Cx"
    ? { kind: "literal", value: ["x"] }
    : stage === "Cy"
    ? { kind: "list", items: [{ kind: "literal", value: "y" }] }
    : undefined;
  return {
    kind: "action",
    ...common,
    action,
    with: {
      kind: "object",
      fields: checks === undefined ? {} : { checks },
    },
  } as unknown as WorkflowNode;
};
const seq = (...stages: Stage[]) => stages.map((stage) => node(stage));
const reasons = (steps: WorkflowNode[]) =>
  planRuleViolations(REQS, steps).map((v) => `${v.commandId}:${v.reason}`);

Deno.test("a plan that is a plain list reads exactly as the flat guard reads it", () => {
  const stageOf = (stage: Stage) => ({
    checks: stage === "C*"
      ? [RULE_GUARD_ALL_CHECKS]
      : stage === "Cx"
      ? ["x"]
      : stage === "Cy"
      ? ["y"]
      : [],
    producesRevision: stage === "R",
  });
  const tokens: Stage[] = ["R", "C*", "Cx", "Cy", "N"];
  let compared = 0;
  const walk = (prefix: Stage[]) => {
    if (prefix.length > 0) {
      assertEquals(
        planRuleViolations(REQS, seq(...prefix)),
        repositoryRuleStageViolations(REQS, prefix.map(stageOf)),
        prefix.join(" "),
      );
      compared += 1;
    }
    if (prefix.length === 5) return;
    for (const token of tokens) walk([...prefix, token]);
  };
  walk([]);
  assertEquals(compared, 3905);
});

Deno.test("a guarded step satisfies nothing, as a conditional stage does in a flat workflow", () => {
  assertEquals(
    reasons([node("R"), node("C*", true)]),
    ["x:stage_missing", "y:stage_missing"],
  );
  // A guarded revision may change the candidate after the check.
  assertEquals(
    reasons([node("R"), node("C*"), node("R", true)]),
    ["x:stage_before_revision", "y:stage_before_revision"],
  );
});

Deno.test("a check in one arm of a branch covers nothing, and a check in both arms covers", () => {
  const branch = (then: WorkflowNode[], other: WorkflowNode[]) =>
    ({
      kind: "branch",
      ...base(),
      when: GUARD,
      then,
      else: other,
      outputs: {},
    }) as unknown as WorkflowNode;
  assertEquals(
    reasons([node("R"), branch([node("C*")], [])]),
    ["x:stage_missing", "y:stage_missing"],
  );
  assertEquals(reasons([node("R"), branch([node("C*")], [node("C*")])]), []);
  // The arms may cover different commands: only what both cover is credited.
  assertEquals(
    reasons([node("R"), branch([node("Cx"), node("Cy")], [node("Cx")])]),
    ["y:stage_missing"],
  );
  // A revision in an arm, after an unconditional check, is not covered.
  assertEquals(
    reasons([node("R"), node("C*"), branch([node("R")], [])]),
    ["x:stage_before_revision", "y:stage_before_revision"],
  );
});

Deno.test("a repeat body runs zero or more times: a repair needs its own check inside the body", () => {
  const repeat = (body: WorkflowNode[], seedSteps: WorkflowNode[] = []) =>
    ({
      kind: "repeat",
      ...base(),
      max: 3,
      seed: seedSteps.length === 0
        ? {
          form: "mapping",
          currentCandidate: { kind: "literal", value: null },
        }
        : {
          form: "sequence",
          steps: seedSteps,
          currentCandidate: { kind: "literal", value: null },
        },
      until: GUARD,
      steps: body,
      currentCandidate: { kind: "literal", value: null },
    }) as unknown as WorkflowNode;
  // The reviewed workflow: implement, check everything, then repair + check in
  // the loop. Zero rounds leaves the seed check; one or more end with a check.
  assertEquals(
    reasons([node("R"), node("C*"), repeat([node("R"), node("C*")])]),
    [],
  );
  // A repair with no check after it may run after the seed check.
  assertEquals(
    reasons([node("R"), node("C*"), repeat([node("R"), node("N")])]),
    ["x:stage_before_revision", "y:stage_before_revision"],
  );
  // A check only inside the body never runs when the body runs zero times.
  assertEquals(
    reasons([node("R"), repeat([node("R"), node("C*")])]),
    ["x:stage_missing", "y:stage_missing"],
  );
  // Steps of a sequence seed run once, before the body.
  assertEquals(
    reasons([repeat([node("N")], [node("R"), node("C*")])]),
    [],
  );
});

Deno.test("a forEach body runs zero or more times, like a repeat body", () => {
  const loop = (body: WorkflowNode[]) =>
    ({
      kind: "forEach",
      ...base(),
      items: { kind: "literal", value: [] },
      max: 3,
      as: "item",
      steps: body,
    }) as unknown as WorkflowNode;
  // A revision inside the loop makes the plan bound; a check only inside the
  // loop covers nothing, since the list may be empty.
  assertEquals(reasons([node("N"), loop([node("R"), node("C*")])]), [
    "x:stage_missing",
    "y:stage_missing",
  ]);
  // A check before the loop and after each revision in it covers.
  assertEquals(
    reasons([node("R"), node("C*"), loop([node("R"), node("C*")])]),
    [],
  );
  // A revision with no check after it in the loop may come after the check.
  assertEquals(
    reasons([node("R"), node("C*"), loop([node("R"), node("N")])]),
    ["x:stage_before_revision", "y:stage_before_revision"],
  );
  // A check only inside the loop never runs when the list is empty.
  assertEquals(
    reasons([node("R"), loop([node("C*")])]),
    ["x:stage_missing", "y:stage_missing"],
  );
});

Deno.test("the lanes of a parallel group have no order: a check beside a revision covers nothing, beside other checks it adds up", () => {
  const parallel = (...lanes: WorkflowNode[][]) =>
    ({
      kind: "parallel",
      ...base(),
      maxConcurrency: 2,
      join: "all-required",
      failurePolicy: "stop-dependent",
      lanes: lanes.map((steps, index) => ({
        id: `lane_${index}`,
        needs: [],
        repository: "main",
        steps,
      })),
      outputs: {},
    }) as unknown as WorkflowNode;
  assertEquals(
    reasons([node("R"), parallel([node("Cx")], [node("Cy")])]),
    [],
  );
  assertEquals(
    reasons([parallel([node("R")], [node("C*")])]),
    ["x:stage_before_revision", "y:stage_before_revision"],
  );
  assertEquals(
    reasons([parallel([node("R"), node("C*")], [node("N")]), node("C*")]),
    [],
  );
});

Deno.test("a plan that never changes a revision is not bound, and a check after the last revision of a compiled plan is read from its real nodes", async () => {
  assertEquals(reasons([node("N"), node("N")]), []);
  const document = await compiled([
    {
      id: "implement",
      uses: "harness.implement",
      with: {
        repositoryId: "$input.repo",
        planArtifact: "00000000-0000-4000-8000-0000000000b1",
      },
    },
    {
      id: "check",
      needs: ["implement"],
      uses: "quality.check",
      with: {
        repositoryId: "$input.repo",
        revision: "$step.implement.headSha",
        checks: "$delivery.checkIds",
      },
    },
  ], { repo: { type: "uuid", required: true } });
  assertEquals(planRuleViolations(REQS, document.steps), []);
  assertEquals(planRuleViolations(REQS, document.steps.slice(0, 1)), [
    { ...req("x"), reason: "stage_missing" },
    { ...req("y"), reason: "stage_missing" },
  ]);
});

Deno.test("a lane that cannot revise does not undo the check a revising lane runs after its own revision", () => {
  const parallel = (...lanes: WorkflowNode[][]) =>
    ({
      kind: "parallel",
      ...base(),
      maxConcurrency: 2,
      join: "all-required",
      failurePolicy: "stop-dependent",
      lanes: lanes.map((steps, index) => ({
        id: `lane_${index}`,
        needs: [],
        repository: "main",
        steps,
      })),
      outputs: {},
    }) as unknown as WorkflowNode;
  // Every interleaving runs the check after the only revision (qa3, #476).
  assertEquals(
    reasons([parallel([node("R"), node("C*")], [node("N")])]),
    [],
  );
  // A check in a lane beside the revision still covers nothing.
  assertEquals(
    reasons([parallel([node("R")], [node("C*"), node("N")])]),
    ["x:stage_before_revision", "y:stage_before_revision"],
  );
});

Deno.test("a check on both arms of a branch always runs, so a revision after it is the reason, not a missing stage", () => {
  const branch = (then: WorkflowNode[], other: WorkflowNode[]) =>
    ({
      kind: "branch",
      ...base(),
      when: GUARD,
      then,
      else: other,
      outputs: {},
    }) as unknown as WorkflowNode;
  // qa3, #476: a check on both arms runs on every path.
  assertEquals(
    reasons([branch([node("C*")], [node("C*")]), node("R")]),
    ["x:stage_before_revision", "y:stage_before_revision"],
  );
  // On one arm only, no always-running check covers it.
  assertEquals(
    reasons([branch([node("C*")], []), node("R")]),
    ["x:stage_missing", "y:stage_missing"],
  );
  // Both arms covering different commands: only the command both run is always covered.
  assertEquals(
    reasons([branch([node("Cx"), node("Cy")], [node("Cx")]), node("R")]),
    ["x:stage_before_revision", "y:stage_missing"],
  );
});

Deno.test("the all-checks marker is never taken from a literal list, where it would only forge coverage", () => {
  const forged = (checks: unknown) =>
    ({
      kind: "action",
      ...base(),
      action: "quality.check",
      with: { kind: "object", fields: { checks } },
    }) as unknown as WorkflowNode;
  for (
    const checks of [
      { kind: "literal", value: [RULE_GUARD_ALL_CHECKS] },
      { kind: "literal", value: [RULE_GUARD_ALL_CHECKS, "other"] },
      {
        kind: "list",
        items: [{ kind: "literal", value: RULE_GUARD_ALL_CHECKS }],
      },
      { kind: "ref", root: "input", path: ["checks"] },
      { kind: "ref", root: "delivery", path: ["failedChecks"] },
    ]
  ) {
    assertEquals(
      reasons([node("R"), forged(checks)]),
      ["x:stage_missing", "y:stage_missing"],
      JSON.stringify(checks),
    );
  }
});

// #399. Moved here from the flat preset cases (which #400 deletes with the flat
// executor): the decision of record is that the plan guard owns compiled-plan
// stage coverage. The reviewed preset's plan runs its checks after the last
// revision, so a bound `require` rule is satisfied; the plain fixed-coding plan
// has no check after its implement, so the same rule is a missing stage.
const boundRule = (commandId: string) =>
  OrganizationRepositoryRulesSchema.parse({
    revision: 1,
    entries: [{
      ruleKey: "code.magicNumbers",
      enabled: true,
      mode: "require",
      options: {
        checkBinding: commandId,
        allowedNumbers: [0],
        excludedPaths: [],
      },
      locked: false,
    }],
  });

async function planOf(preset: WorkflowPresetDocument) {
  const result = await compileWorkflowDocument(preset);
  assertEquals(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result.document;
}

Deno.test("the plan guard reads a bound require rule: the reviewed preset satisfies it, fixed-coding does not", async () => {
  const reviewed = await planOf(FIXED_CODING_REVIEWED_DEFINITION);
  const plain = await planOf(FIXED_CODING_DEFINITION);
  // Any bound command is covered by the reviewed plan's check after implement.
  for (const commandId of ["unit", "magic.numbers", "something-else"]) {
    assertEquals(
      planRuleViolations(
        repositoryRuleStageRequirements(boundRule(commandId)),
        reviewed.steps,
      ),
      [],
      commandId,
    );
  }
  // fixed-coding has no check stage, so the same rule is a missing stage.
  assertEquals(
    planRuleViolations(
      repositoryRuleStageRequirements(boundRule("unit")),
      plain.steps,
    ).map((violation) => violation.reason),
    ["stage_missing"],
  );
});
