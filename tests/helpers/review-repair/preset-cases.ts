import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { parse as parseYaml } from "yaml";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { RepositoryProfileConfigSchema } from "../../../packages/contracts/src/repository-profile-config.ts";
import { deriveRepositoryInspectionConfig } from "../../../apps/server/src/modules/projects/repository-inspect.ts";
import { baseProfileConfig } from "../repository-rule-entries.ts";
import {
  REVIEW_LOOP_LIMITS,
  serializedBytes,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  OrganizationRepositoryRulesSchema,
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
  candidateHeadSha,
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
  presetBriefInputs,
} from "../../../apps/server/src/modules/work/workflow-presets.ts";
import {
  assertStepsSatisfyRules,
  repositoryRuleWorkflowStages,
} from "../../../apps/server/src/modules/workflows/rule-guard.ts";
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
  fingerprintOf,
  JOB_INPUT_STEP_MARGIN_BYTES,
  loopSpec,
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
function reviewedSnapshot(
  overrides: {
    spec?: unknown;
    profile?: unknown;
  } = {},
) {
  const spec = overrides.spec ?? PRESET.spec;
  const steps = (spec as { steps: Array<{ id: string; uses: string }> }).steps;
  return {
    schemaVersion: 1,
    executionMode: "repository",
    inputs: presetBriefInputs({
      title: "Add retry",
      description: "Retry the upload.",
      task_type: "feature",
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
    stepActions: Object.fromEntries(
      steps.map((step) => [step.id, workflowActionBinding(step.uses)]),
    ),
    admission: { dependencies: [], status: "queued", reason: null },
  };
}

function derive(
  stepKey: string,
  stepOutputs: StepOutputs,
  snapshot: unknown = reviewedSnapshot(),
) {
  return actionAndInputFromSnapshot({
    runSnapshot: snapshot,
    stepKey,
    stepOutputs,
    repositoryId,
  });
}

const implementOutput = (headSha = HEAD_SHA) => ({
  headSha,
  baseSha: BASE_SHA,
  sessionId: crypto.randomUUID(),
  artifacts: [],
});

/** Outputs once implement has finished: the first candidate. */
const afterImplement = (): StepOutputs => ({
  brief: { artifact },
  implement: implementOutput(),
});

function assertUnresolved(run: () => unknown, message?: string): void {
  assertThrows(run, Error, "WORKFLOW_INPUT_UNRESOLVED", message);
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
    assertEquals(
      FIXED_CODING_PRESET.digest,
      "8d243ab0b8f9a81d16aa8f87612364d6778c65f7e7560b69342ce257a79f4091",
    );
    assertEquals(FIXED_CODING_PRESET.revision, 2);
    assertEquals(FIXED_CODING_PRESET.defaultBudgetLimitUsd, "5.00");
    assertEquals(FIXED_CODING_PRESET.spec.steps.map((step) => step.id), [
      "brief",
      "implement",
    ]);

    assertEquals(PRESET.revision, 1);
    assertEquals(PRESET.slug, "preset:fixed-coding-reviewed");
    assertEquals(PRESET.defaultBudgetLimitUsd, "12.00");
    assertEquals(PRESET.digest, await sha256Hex(canonicalJson(PRESET.spec)));
    assertNotEquals(PRESET.digest, FIXED_CODING_PRESET.digest);
    assertEquals(PRESET.stages, FIXED_CODING_PRESET.stages);
    assertEquals(
      PRESET.spec.steps.map((step) => [step.id, step.uses]),
      [
        ["brief", "task.brief"],
        ["implement", "harness.implement"],
        ["repair", "harness.repair"],
        ["check", "quality.check"],
        ["review", "review.independent"],
      ],
    );
    // Every step is scoped to the task's repository.
    for (const step of PRESET.spec.steps) {
      assertEquals(step.with.repositoryId, "$task.repositoryId", step.id);
    }
    // Its brief and implement steps are the shared fixed-coding steps.
    assertEquals(
      PRESET.spec.steps.slice(0, 2),
      FIXED_CODING_PRESET.spec.steps,
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
    const withOf = (id: string) =>
      PRESET.spec.steps.find((step) => step.id === id)!.with;
    assertEquals(withOf("repair"), {
      repositoryId: "$task.repositoryId",
      revision: DELIVERY_REFERENCES.headSha,
      findings: DELIVERY_REFERENCES.blockingFindings,
      failedChecks: DELIVERY_REFERENCES.failedChecks,
    });
    assertEquals(withOf("check"), {
      repositoryId: "$task.repositoryId",
      revision: DELIVERY_REFERENCES.headSha,
      checks: DELIVERY_REFERENCES.checkIds,
    });
    assertEquals(withOf("review"), {
      repositoryId: "$task.repositoryId",
      revision: DELIVERY_REFERENCES.headSha,
      evidence: "$step.check.checkRunIds",
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
  Deno.test("$delivery.headSha is the head of the last harness step that reported one", () => {
    const snapshot = reviewedSnapshot();
    // Only implement has run: its head is the candidate.
    assertEquals(candidateHeadSha(snapshot, afterImplement()), HEAD_SHA);
    // A repair that has run supersedes the implement step it repaired.
    assertEquals(
      candidateHeadSha(snapshot, {
        ...afterImplement(),
        repair: implementOutput(REPAIRED_SHA),
      }),
      REPAIRED_SHA,
    );
    // Steps that are not harness steps never name a candidate, even when
    // their output carries a headSha.
    assertEquals(
      candidateHeadSha(snapshot, {
        ...afterImplement(),
        check: checkOutput([observation()], { headSha: "9".repeat(40) }),
        review: reviewOutput([], { headSha: "8".repeat(40) }),
      }),
      HEAD_SHA,
    );
    // A harness step without a string headSha is skipped.
    assertEquals(
      candidateHeadSha(snapshot, {
        ...afterImplement(),
        repair: { sessionId: crypto.randomUUID() },
      }),
      HEAD_SHA,
    );
  });

  Deno.test("$delivery.headSha is unresolved until a harness step has reported", () => {
    const snapshot = reviewedSnapshot();
    assertUnresolved(() => candidateHeadSha(snapshot, {}));
    assertUnresolved(() => candidateHeadSha(snapshot, { brief: { artifact } }));
    assertUnresolved(() =>
      candidateHeadSha(snapshot, { implement: { headSha: 7 } })
    );
    assertUnresolved(() => candidateHeadSha(snapshot, null));
    assertUnresolved(() => candidateHeadSha(null, afterImplement()));
    assertUnresolved(() => candidateHeadSha({ workflow: {} }, {}));
    // Check and review need the candidate; with no output they cannot start.
    for (const stepKey of ["repair", "check", "review"]) {
      assertUnresolved(() => derive(stepKey, {}), stepKey);
    }
  });

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
      check: checkOutput([observation({ checkId: UNIT })]),
    };
    const review = derive("review", checked);
    assertEquals(review.action, "review.independent");
    assertEquals(review.input, {
      repositoryId,
      revision: HEAD_SHA,
      evidence: checked.check.checkRunIds,
    });
    assertActionInput("review.independent", review.input);

    // After a repair the next iteration's steps use the repaired head.
    const repaired = { ...checked, repair: implementOutput(REPAIRED_SHA) };
    assertEquals(
      (derive("check", repaired).input as { revision: string }).revision,
      REPAIRED_SHA,
    );
    assertEquals(
      (derive("review", repaired).input as { revision: string }).revision,
      REPAIRED_SHA,
    );
  });

  Deno.test("$delivery.checkIds lists every fixed policy command and needs no step output", () => {
    const check = derive("check", afterImplement());
    assertEquals((check.input as { checks: string[] }).checks, [UNIT, LINT]);
    // A step that carries only this reference resolves with no outputs at all.
    const alone = reviewedSnapshot({
      spec: {
        kind: "fixed",
        workflow: { kind: "fixed" },
        steps: [{
          id: "check",
          uses: "quality.check",
          with: { checks: DELIVERY_REFERENCES.checkIds },
        }],
      },
    });
    assertEquals(derive("check", {}, alone).input, { checks: [UNIT, LINT] });
    // No pinned profile, no fixed policy or no commands: unresolved.
    for (
      const profile of [
        null,
        { config: { schemaVersion: 2 } },
        { config: { schemaVersion: 2, fixedPolicy: { commands: [] } } },
        { config: { fixedPolicy: { commands: [{ argv: ["x"] }] } } },
      ]
    ) {
      assertUnresolved(
        () => derive("check", afterImplement(), reviewedSnapshot({ profile })),
        JSON
          .stringify(profile),
      );
    }
  });

  Deno.test("$delivery.failedChecks keeps only the required checks the verified output lists as failed", () => {
    const unit = observation({
      checkId: UNIT,
      result: "failed",
      reason: "exit_nonzero",
      exitCode: 3,
    });
    // `lint` fails too, but it only warns, so the verified output omits it.
    const lint = observation({
      checkId: LINT,
      result: "failed",
      reason: "exit_nonzero",
      exitCode: 1,
    });
    const format = observation({ checkId: "format" });
    const output = checkOutput([unit, lint, format], {
      failedCheckIds: [unit.checkRunId],
    });
    const repair = derive("repair", {
      ...afterImplement(),
      check: output,
      review: reviewOutput([]),
    });
    assertEquals(repair.action, "harness.repair");
    assertEquals((repair.input as { failedChecks: unknown }).failedChecks, [{
      checkRunId: unit.checkRunId,
      checkId: UNIT,
      result: "failed",
      reason: "exit_nonzero",
      exitCode: 3,
    }]);
  });

  Deno.test("$delivery.failedChecks carries unavailable results, null exit codes and observation order", () => {
    const missing = observation({
      checkId: UNIT,
      result: "unavailable",
      reason: "tool_missing",
      exitCode: null,
    });
    const timedOut = observation({
      checkId: "e2e",
      result: "failed",
      reason: "deadline",
      exitCode: null,
    });
    const fine = observation({ checkId: LINT });
    const output = checkOutput([timedOut, fine, missing], {
      failedCheckIds: [missing.checkRunId, timedOut.checkRunId],
    });
    const input = derive("repair", {
      ...afterImplement(),
      check: output,
      review: reviewOutput([]),
    }).input as { failedChecks: Array<Record<string, unknown>> };
    // Observation order, not failedCheckIds order.
    assertEquals(input.failedChecks.map((entry) => entry.checkId), [
      "e2e",
      UNIT,
    ]);
    assertEquals(input.failedChecks.map((entry) => entry.exitCode), [
      null,
      null,
    ]);
    // A row the output lists as failed but whose result is `passed` is never
    // handed to a repair: FailedCheck has no passed result.
    const passed = observation({ checkId: UNIT });
    const inconsistent = checkOutput([passed], {
      failedCheckIds: [passed.checkRunId],
    });
    assertEquals(
      (derive("repair", {
        ...afterImplement(),
        check: inconsistent,
        review: reviewOutput([]),
      }).input as { failedChecks: unknown[] }).failedChecks,
      [],
    );
  });

  Deno.test("$delivery.failedChecks is unresolved without a well-formed check output", () => {
    const ready = { ...afterImplement(), review: reviewOutput([]) };
    assertUnresolved(() => derive("repair", ready), "no check output");
    for (
      const check of [
        { failedCheckIds: [], observations: "x" },
        { failedCheckIds: "x", observations: [] },
        { failedCheckIds: [1], observations: [] },
        { failedCheckIds: [], observations: [{ checkId: "unit" }] },
        {
          failedCheckIds: [],
          observations: [{
            checkRunId: "a",
            checkId: "b",
            result: "failed",
            reason: "exit_nonzero",
          }],
        },
        {
          failedCheckIds: [],
          observations: Array.from(
            { length: 33 },
            () => observation({ result: "failed", reason: "exit_nonzero" }),
          ),
        },
      ]
    ) {
      assertUnresolved(() => derive("repair", { ...ready, check }));
    }
  });

  Deno.test("$delivery.blockingFindings keeps the latest review's blocking findings, blocker first", () => {
    const major = finding({
      fingerprint: fingerprintOf(2),
      severity: "major",
      path: "src/b.ts",
    });
    const blocker = finding({
      fingerprint: fingerprintOf(1),
      severity: "blocker",
      path: "src/a.ts",
    });
    const minor = finding({ fingerprint: fingerprintOf(3), severity: "minor" });
    const note = finding({ fingerprint: fingerprintOf(4), severity: "note" });
    const outputs = {
      ...afterImplement(),
      check: checkOutput([observation({
        checkId: UNIT,
        result: "failed",
        reason: "exit_nonzero",
        exitCode: 1,
      })]),
      review: reviewOutput([major, minor, blocker, note]),
    };
    const input = derive("repair", outputs).input as {
      findings: unknown[];
      failedChecks: unknown[];
    };
    assertEquals(input.findings, [blocker, major]);
    assertEquals(input.failedChecks.length, 1);
    assertActionInput("harness.repair", derive("repair", outputs).input);

    // Clean findings give an empty list; the failed check alone drives repair.
    const clean = derive("repair", {
      ...outputs,
      review: reviewOutput([minor, note]),
    }).input as { findings: unknown[] };
    assertEquals(clean.findings, []);
  });

  Deno.test("$delivery.blockingFindings derives blocking from severity, not from the stored flag", () => {
    // A stored output nobody verified can carry a flag that disagrees with the
    // severity. The flag must neither hide a blocker nor hand a note to repair.
    const hiddenBlocker = finding({
      fingerprint: fingerprintOf(1),
      severity: "blocker",
      blocking: false,
      path: "src/a.ts",
    });
    const hiddenMajor = finding({
      fingerprint: fingerprintOf(2),
      severity: "major",
      blocking: false,
      path: "src/b.ts",
    });
    const widenedMinor = finding({
      fingerprint: fingerprintOf(3),
      severity: "minor",
      blocking: true,
    });
    const widenedNote = finding({
      fingerprint: fingerprintOf(4),
      severity: "note",
      blocking: true,
    });
    const agreeing = finding({
      fingerprint: fingerprintOf(5),
      severity: "major",
      path: "src/c.ts",
    });
    const outputs = (
      findings: Parameters<typeof reviewOutput>[0],
    ) => ({
      ...afterImplement(),
      check: checkOutput([observation()]),
      review: reviewOutput(findings),
    });
    const input = derive(
      "repair",
      outputs([
        widenedNote,
        hiddenMajor,
        widenedMinor,
        agreeing,
        hiddenBlocker,
      ]),
    ).input as { findings: Array<Record<string, unknown>> };
    // Blocker first, then the two majors in report order; the emitted rows
    // read `blocking: true` whatever the stored flag said.
    assertEquals(input.findings, [
      { ...hiddenBlocker, blocking: true },
      { ...hiddenMajor, blocking: true },
      agreeing,
    ]);
    assertActionInput("harness.repair", input);
    // A stored flag that agrees with the severity gives the same answer, so
    // the flag cannot change the set in either direction.
    const agreeingFlags = [hiddenBlocker, hiddenMajor, agreeing].map((
      entry,
    ) => ({
      ...entry,
      blocking: true,
    }));
    assertEquals(
      derive("repair", outputs(agreeingFlags)).input,
      derive("repair", outputs([hiddenBlocker, hiddenMajor, agreeing])).input,
    );
    // Only non-blocking severities with a lying flag: nothing to repair.
    assertEquals(
      (derive("repair", outputs([widenedMinor, widenedNote])).input as {
        findings: unknown[];
      }).findings,
      [],
    );
  });

  Deno.test("$delivery.blockingFindings is unresolved without a well-formed review output", () => {
    const ready = {
      ...afterImplement(),
      check: checkOutput([observation()]),
    };
    assertUnresolved(() => derive("repair", ready), "no review output");
    const bad = [
      { findings: "x" },
      { findings: [null] },
      { findings: [{ severity: "urgent", detail: "x", blocking: true }] },
      { findings: [{ severity: "major", detail: 5, blocking: true }] },
      { findings: [{ severity: "major", detail: "x", blocking: "yes" }] },
      {
        findings: Array.from(
          { length: REVIEW_LOOP_LIMITS.maxFindings + 1 },
          (_, index) => finding({ fingerprint: fingerprintOf(index + 1) }),
        ),
      },
    ];
    for (const review of bad) {
      assertUnresolved(() => derive("repair", { ...ready, review }));
    }
  });

  Deno.test("$delivery.blockingFindings never passes more than the review byte budget", () => {
    const fingerprints = Array.from(
      { length: REVIEW_LOOP_LIMITS.maxFindings },
      (_, index) => fingerprintOf(index + 1),
    );
    const outputsWith = (findings: unknown[]) => ({
      ...afterImplement(),
      check: checkOutput([observation()]),
      review: { ...reviewOutput([]), findings },
    });
    // 25 blocking findings at the field maxima do not fit as stored.
    const huge = fingerprints.map((_, index) => worstCaseFinding(index));
    assert(serializedBytes(huge) > REVIEW_LOOP_LIMITS.resultByteBudget);
    const fitted = (derive("repair", outputsWith(huge)).input as {
      findings: Array<{ fingerprint: string; severity: string }>;
    }).findings;
    assert(
      serializedBytes(fitted) <= REVIEW_LOOP_LIMITS.resultByteBudget,
      `${serializedBytes(fitted)} bytes`,
    );
    // Shortening never drops a blocking finding.
    assertEquals(fitted.map((entry) => entry.fingerprint), fingerprints);
    // Blocking findings whose identifying fields alone exceed the budget are
    // refused rather than hidden.
    const impossible = fingerprints.map((_, index) =>
      worstCaseFinding(index, "\u{1F600}")
    );
    assertUnresolved(() => derive("repair", outputsWith(impossible)));
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
      check: checkOutput(failed),
      review: reviewOutput(
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
      check: checkOutput([unit]),
      review: reviewOutput([blocker]),
    })) as StepOutputs;
    const snapshot = JSON.parse(JSON.stringify(reviewedSnapshot()));
    const admitted = derive("repair", stored, snapshot);
    const jobInput = JSON.parse(JSON.stringify(admitted.input));
    const row = {
      runSnapshot: snapshot,
      stepKey: "repair",
      stepOutputs: stored,
      repositoryId,
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
    // The step outputs are the only input: a newer harness output changes the
    // derived revision, so a stale job cannot claim against a moved candidate.
    assertFalse(
      executionJobInputMatchesSnapshot(
        {
          ...row,
          stepOutputs: { ...stored, repair: implementOutput(REPAIRED_SHA) },
        },
        "harness.repair",
        jobInput,
      ),
    );
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

  Deno.test("each reviewed preset step either resolves from the profile alone or is deferred", () => {
    const steps = extractFixedWorkflowSteps(PRESET.spec);
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
        !stepReferencesEarlierOutput(step) && step.key === "brief",
        step.key,
      );
    }
    for (const step of steps.filter((entry) => entry.key !== "brief")) {
      assert(stepReferencesEarlierOutput(step), step.key);
    }
  });
}

function registerOnDemandStepCases(): void {
  Deno.test("the reviewed preset marks only its repair step on demand and keeps spec positions", () => {
    const steps = extractFixedWorkflowSteps(PRESET.spec);
    assertEquals(
      steps.map((step) => [step.key, step.position, step.onDemand ?? false]),
      [
        ["brief", 0, false],
        ["implement", 1, false],
        ["repair", 2, true],
        ["check", 3, false],
        ["review", 4, false],
      ],
    );
    // Plain fixed-coding has no loop, so nothing is on demand.
    assertEquals(
      extractFixedWorkflowSteps(FIXED_CODING_PRESET.spec).map((step) =>
        step.onDemand
      ),
      [undefined, undefined],
    );
  });

  Deno.test("a repair step is on demand only inside the exact loop shape", () => {
    const cases: Array<[string, unknown, boolean]> = [
      ["loop", PRESET.spec, true],
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
    await insertRunSteps(transaction, {
      organizationId: "org",
      runId: "run",
      steps: extractFixedWorkflowSteps(PRESET.spec),
    });
    assertEquals(calls.length, 1);
    const [org, run, ...columns] = calls[0].parameters as [
      string,
      string,
      ...unknown[],
    ];
    assertEquals([org, run], ["org", "run"]);
    // Triples of (key, position, encoded input): positions keep the spec index.
    const rows: Array<[unknown, unknown]> = [];
    for (let index = 0; index < columns.length; index += 3) {
      rows.push([columns[index], columns[index + 1]]);
    }
    assertEquals(rows, [
      ["brief", 0],
      ["implement", 1],
      ["check", 3],
      ["review", 4],
    ]);
    // fixed-coding still gets a row for every step.
    calls.length = 0;
    await insertRunSteps(transaction, {
      organizationId: "org",
      runId: "run",
      steps: extractFixedWorkflowSteps(FIXED_CODING_PRESET.spec),
    });
    assertEquals(calls[0].parameters.length, 2 + 2 * 3);
  });
}

function registerLoopLimitCases(): void {
  const withLimit = (maxRepairCycles: unknown) => ({
    ...PRESET.spec,
    limits: { maxRepairCycles },
  });

  Deno.test("a review loop freezes the default bounds and a workflow may lower or choose the repair count", () => {
    assertEquals(reviewLoopLimitsFor(PRESET.spec), {
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
      reviewLoopLimitsFor({ ...PRESET.spec, limits: { wallClock: "24h" } })
        ?.maxRepairCycles,
      REVIEW_LOOP_LIMITS.maxRepairCycles,
    );
  });

  Deno.test("a repair count outside the ceiling invalidates the workflow", () => {
    for (const bad of [-1, 9, 1.5, "2", null, Number.NaN]) {
      assertThrows(
        () => reviewLoopLimitsFor(withLimit(bad)),
        Error,
        "WORKFLOW_VERSION_INVALID",
        String(bad),
      );
    }
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
    const limits = reviewLoopLimitsFor(PRESET.spec)!;
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
  const rules = (commandId: string) =>
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

  Deno.test("a check that lists $delivery.checkIds is the all-checks marker", () => {
    const stages = repositoryRuleWorkflowStages(
      extractFixedWorkflowSteps(PRESET.spec),
    );
    assertEquals(stages, [
      { checks: [], producesRevision: false },
      { checks: [], producesRevision: true },
      { checks: [], producesRevision: true },
      { checks: [RULE_GUARD_ALL_CHECKS], producesRevision: false },
      { checks: [], producesRevision: false },
    ]);
    assertEquals(RULE_GUARD_ALL_CHECKS, "*");
  });

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

  Deno.test("run admission rules: the reviewed preset satisfies a bound require rule, fixed-coding does not", () => {
    const reviewed = extractFixedWorkflowSteps(PRESET.spec);
    const plain = extractFixedWorkflowSteps(FIXED_CODING_PRESET.spec);
    // Any bound command is covered by the reviewed preset's check stage.
    for (const commandId of ["unit", "magic.numbers", "something-else"]) {
      assertStepsSatisfyRules(rules(commandId), reviewed);
    }
    // fixed-coding has no check stage, so the same rule is a missing stage.
    const refusal = assertThrows(
      () => assertStepsSatisfyRules(rules("unit"), plain),
      StandardError,
    );
    assertEquals(
      (refusal.params as { issues: Array<{ code: string }> }).issues.map((
        issue,
      ) => issue.code),
      ["repository_rule_stage_missing"],
    );
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
  const reviewedSteps = extractFixedWorkflowSteps(PRESET.spec);
  const plainSteps = extractFixedWorkflowSteps(FIXED_CODING_PRESET.spec);

  Deno.test("the reviewed preset needs an observed fixed policy that allows all four effects", () => {
    const denies = (profile: unknown) =>
      fixedPolicyDeniesSteps(config(profile), reviewedSteps);
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

  Deno.test("fixed-coding availability by effects is exactly what it always was", () => {
    const denies = (profile: unknown) =>
      fixedPolicyDeniesSteps(config(profile), plainSteps);
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
