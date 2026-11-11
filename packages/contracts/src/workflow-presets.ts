/**
 * Code-owned workflow presets. A preset is a fixed workflow specification the
 * server materializes, per organization, as a published and digest-verified
 * workflow version when a run starts with `presetId`.
 */

export const WORKFLOW_PRESET_IDS = Object.freeze(
  ["fixed-coding", "fixed-coding-reviewed"] as const,
);

export type WorkflowPresetId = typeof WORKFLOW_PRESET_IDS[number];

export type WorkflowPresetSpec = Readonly<{
  kind: "fixed";
  workflow: Readonly<{ kind: "fixed" }>;
  steps: readonly Readonly<{
    id: string;
    uses: string;
    with: Readonly<Record<string, string>>;
  }>[];
}>;

/**
 * Step input references the workflow runtime resolves from run state rather
 * than from the run inputs or one named step. Each is a pure function of the
 * run snapshot and the recorded step outputs, so admission and the claim-time
 * re-derivation of a job input always agree.
 */
export const DELIVERY_REFERENCES = Object.freeze(
  {
    /** Head commit of the run's current candidate revision. */
    headSha: "$delivery.headSha",
    /** Ids of every fixed policy command of the pinned repository profile. */
    checkIds: "$delivery.checkIds",
    /** Required checks that did not pass on the candidate, as repair evidence. */
    failedChecks: "$delivery.failedChecks",
    /** Blocking findings of the latest independent review, blocker first. */
    blockingFindings: "$delivery.blockingFindings",
  } as const,
);

/**
 * The references that read earlier step outputs. Strict preset admission
 * resolves each step before any output exists, so it measures a step that
 * carries one of these from its literal input; `checkIds` is absent because
 * the pinned profile alone resolves it.
 */
export const DELIVERY_STEP_OUTPUT_REFERENCES: readonly string[] = Object.freeze(
  [
    DELIVERY_REFERENCES.headSha,
    DELIVERY_REFERENCES.failedChecks,
    DELIVERY_REFERENCES.blockingFindings,
  ],
);

/** Stage ids of the fixed build workflow, in order. */
export const WORKFLOW_STAGE_IDS = Object.freeze(
  ["discuss", "plan", "implement", "review"] as const,
);
export type WorkflowStageId = typeof WORKFLOW_STAGE_IDS[number];

/** What a stage waits for before the next one may start. */
export type WorkflowStageWaits = "automatic" | "human_approval";

export type WorkflowStageDefinition = Readonly<{
  id: WorkflowStageId;
  /** Default wait; a task's approval policy may select `human_approval` for stages marked selectable. */
  waits: WorkflowStageWaits;
  /** Whether a task's approval policy may choose how this stage waits. */
  policySelectable: boolean;
}>;

export type WorkflowPresetDefinition = Readonly<{
  id: WorkflowPresetId;
  revision: number;
  /** Organization workflow-definition slug the preset is materialized under. */
  slug: string;
  nameKey: string;
  /** Run budget applied when the caller supplies none, in US dollars. */
  defaultBudgetLimitUsd: string;
  /** Lowercase SHA-256 of the canonical JSON of `spec`; verified by tests and at admission. */
  digest: string;
  /** Authored YAML source stored beside the normalized specification. */
  sourceYaml: string;
  spec: WorkflowPresetSpec;
  /**
   * Stage policy surface. Stages are not part of `spec`, so the preset digest
   * and every already-materialized workflow version stay valid. Only the plan
   * stage can wait for a human today; the others run automatically.
   */
  stages: readonly WorkflowStageDefinition[];
}>;

const FIXED_CODING_SPEC: WorkflowPresetSpec = Object.freeze({
  kind: "fixed",
  workflow: Object.freeze({ kind: "fixed" as const }),
  steps: Object.freeze([
    Object.freeze({
      id: "brief",
      uses: "task.brief",
      with: Object.freeze({
        brief: "$input.brief",
        repositoryId: "$task.repositoryId",
      }),
    }),
    Object.freeze({
      id: "implement",
      uses: "harness.implement",
      with: Object.freeze({
        repositoryId: "$task.repositoryId",
        planArtifact: "$step.brief.artifact.versionId",
        instructions: "$input.instructions",
      }),
    }),
  ]),
});

/** Longest instruction text, in UTF-16 code units, the implement step accepts. */
export const IMPLEMENT_INSTRUCTIONS_MAX_LENGTH = 4000;

const INSTRUCTIONS_TRUNCATION_MARKER = "\n[truncated]";

/** Approved plan revision frozen into a run's brief. */
export type ApprovedPlanForInstructions = Readonly<{
  planRevisionId: string;
  revision: number;
  digest: string;
  title: string;
  steps: readonly Readonly<
    { id: string; title: string; detail: string; detailShortened?: boolean }
  >[];
}>;

/**
 * Deterministic implement-step instructions: the task title and description,
 * then the approved plan when one exists. Output never exceeds
 * `IMPLEMENT_INSTRUCTIONS_MAX_LENGTH` UTF-16 code units; a longer text is cut
 * on a code point boundary (never inside a surrogate pair) and ends with a
 * fixed marker.
 */
export function renderImplementInstructions(input: {
  title: string;
  description: string;
  approvedPlan?: ApprovedPlanForInstructions | null;
}): string {
  const lines = [`Task: ${input.title}`];
  if (input.description.length > 0) lines.push("", input.description);
  const plan = input.approvedPlan;
  if (plan) {
    lines.push(
      "",
      `Approved plan (revision ${plan.revision}): ${plan.title}`,
    );
    plan.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title}`);
      if (step.detail.length > 0) lines.push(`   ${step.detail}`);
    });
  }
  const text = lines.join("\n");
  if (text.length <= IMPLEMENT_INSTRUCTIONS_MAX_LENGTH) return text;
  let end = IMPLEMENT_INSTRUCTIONS_MAX_LENGTH -
    INSTRUCTIONS_TRUNCATION_MARKER.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + INSTRUCTIONS_TRUNCATION_MARKER;
}

/** The one fixed coding workflow: freeze the task brief, then implement it. */
export const FIXED_CODING_PRESET: WorkflowPresetDefinition = Object.freeze({
  id: "fixed-coding",
  revision: 2,
  slug: "preset:fixed-coding",
  nameKey: "workflowPresets.fixedCoding.name",
  defaultBudgetLimitUsd: "5.00",
  digest: "8d243ab0b8f9a81d16aa8f87612364d6778c65f7e7560b69342ce257a79f4091",
  sourceYaml: [
    "kind: fixed",
    "workflow: { kind: fixed }",
    "steps:",
    "  - id: brief",
    "    uses: task.brief",
    "    with: { brief: $input.brief, repositoryId: $task.repositoryId }",
    "  - id: implement",
    "    uses: harness.implement",
    "    with: { repositoryId: $task.repositoryId, planArtifact: $step.brief.artifact.versionId, instructions: $input.instructions }",
    "",
  ].join("\n"),
  spec: FIXED_CODING_SPEC,
  stages: Object.freeze(
    [
      Object.freeze({
        id: "discuss",
        waits: "automatic",
        policySelectable: false,
      }),
      Object.freeze({ id: "plan", waits: "automatic", policySelectable: true }),
      Object.freeze({
        id: "implement",
        waits: "automatic",
        policySelectable: false,
      }),
      Object.freeze({
        id: "review",
        waits: "automatic",
        policySelectable: false,
      }),
    ] as const,
  ),
});

const FIXED_CODING_STAGES = FIXED_CODING_PRESET.stages;

/**
 * The fixed coding spec extended with independent review and bounded repair.
 * Spec order is the order the rule guard reads, so `repair` sits before `check`:
 * the check then follows the last revision-producing step. `repair` is an
 * on-demand step that has no row at admission; the review result hook appends
 * a repair, check and review iteration when it decides to repair. Every
 * candidate revision, the checks, the findings and the failed checks are
 * `$delivery.*` references resolved from the frozen snapshot and the recorded
 * step outputs.
 */
const FIXED_CODING_REVIEWED_SPEC: WorkflowPresetSpec = Object.freeze({
  kind: "fixed",
  workflow: Object.freeze({ kind: "fixed" as const }),
  steps: Object.freeze([
    ...FIXED_CODING_SPEC.steps,
    Object.freeze({
      id: "repair",
      uses: "harness.repair",
      with: Object.freeze({
        repositoryId: "$task.repositoryId",
        revision: DELIVERY_REFERENCES.headSha,
        findings: DELIVERY_REFERENCES.blockingFindings,
        failedChecks: DELIVERY_REFERENCES.failedChecks,
      }),
    }),
    Object.freeze({
      id: "check",
      uses: "quality.check",
      with: Object.freeze({
        repositoryId: "$task.repositoryId",
        revision: DELIVERY_REFERENCES.headSha,
        checks: DELIVERY_REFERENCES.checkIds,
      }),
    }),
    Object.freeze({
      id: "review",
      uses: "review.independent",
      with: Object.freeze({
        repositoryId: "$task.repositoryId",
        revision: DELIVERY_REFERENCES.headSha,
        evidence: "$step.check.checkRunIds",
      }),
    }),
  ]),
});

/**
 * The fixed coding workflow with an independent review and a bounded repair
 * loop: brief, implement, then check and review the candidate, repairing it at
 * most a bounded number of times while required checks fail or the reviewer
 * reports blocking findings. `fixed-coding` is untouched beside it.
 */
export const FIXED_CODING_REVIEWED_PRESET: WorkflowPresetDefinition = Object
  .freeze({
    id: "fixed-coding-reviewed",
    revision: 1,
    slug: "preset:fixed-coding-reviewed",
    nameKey: "workflowPresets.fixedCodingReviewed.name",
    defaultBudgetLimitUsd: "12.00",
    digest: "865035049a6b7cb147618eadcd43366ae4a315747af337d7f23e0a90f1135f6c",
    sourceYaml: [
      "kind: fixed",
      "workflow: { kind: fixed }",
      "steps:",
      "  - id: brief",
      "    uses: task.brief",
      "    with: { brief: $input.brief, repositoryId: $task.repositoryId }",
      "  - id: implement",
      "    uses: harness.implement",
      "    with: { repositoryId: $task.repositoryId, planArtifact: $step.brief.artifact.versionId, instructions: $input.instructions }",
      "  - id: repair",
      "    uses: harness.repair",
      "    with: { repositoryId: $task.repositoryId, revision: $delivery.headSha, findings: $delivery.blockingFindings, failedChecks: $delivery.failedChecks }",
      "  - id: check",
      "    uses: quality.check",
      "    with: { repositoryId: $task.repositoryId, revision: $delivery.headSha, checks: $delivery.checkIds }",
      "  - id: review",
      "    uses: review.independent",
      "    with: { repositoryId: $task.repositoryId, revision: $delivery.headSha, evidence: $step.check.checkRunIds }",
      "",
    ].join("\n"),
    spec: FIXED_CODING_REVIEWED_SPEC,
    stages: FIXED_CODING_STAGES,
  });

/** Every preset in display order: `fixed-coding` stays first. */
export const WORKFLOW_PRESETS: readonly WorkflowPresetDefinition[] = Object
  .freeze([FIXED_CODING_PRESET, FIXED_CODING_REVIEWED_PRESET]);

export function workflowPresetById(
  id: string,
): WorkflowPresetDefinition | undefined {
  return WORKFLOW_PRESETS.find((preset) => preset.id === id);
}
