import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { REVIEW_LOOP_LIMITS } from "../../../packages/contracts/src/review-evidence.ts";
import { baseProfileConfig } from "../repository-rule-entries.ts";
import { reviewLoopFromSnapshot } from "../../../packages/persistence/src/repository-admission.ts";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import { createBakeryPostgresWorkflowRepository } from "../../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  FIXED_CODING_PRESET,
  FIXED_CODING_REVIEWED_PRESET,
} from "../../../packages/contracts/src/workflow-presets.ts";
import {
  apiCall,
  createCodingAgent,
  createPresetTask,
  expectJson,
  presetBilling,
  presetBudgetEnv,
  presetBudgetPolicy,
  type PresetRepository,
  presetRunBody,
  seedFundedCodingAgent,
  seedPresetRepository,
} from "../fixed-coding-preset.ts";
import { numbersRule, publishOrganizationRules } from "../pinned-rules.ts";
import { seedProviderPricingSnapshot } from "../funded-model-job.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
  receiveInspectionSource,
} from "../repository-inspection.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../worker-execution.ts";
import { withWorkerFixture } from "../worker-execution/scenarios.ts";
import {
  BASE_SHA,
  checkOutput,
  observation,
} from "../deterministic-checks/observations.ts";
import { finding, fingerprintOf, reviewOutput } from "./fixtures.ts";

// Issue #94 (B10.03) Phase 3, integration lane: the reviewed preset through
// the real `runs.create` route, the real engine admission and the real claim
// route, against Postgres. Nothing here fakes the delivery references: the
// resolvers run over the snapshot the route froze and over the step outputs
// the claim query reads back from the database.

type Fixture = WorkerFixture;

const REVIEWED = "fixed-coding-reviewed";
const COMMANDS = [
  { id: "magic.numbers", argv: ["pnpm", "test:unit"] },
  { id: "lint", argv: ["pnpm", "lint"] },
];
const DECISIONS = [
  { commandId: "magic.numbers", mode: "require" },
  { commandId: "lint", mode: "warn" },
];
const ALL_EFFECTS = [
  "artifact_only",
  "repository_revision",
  "evidence_only",
  "review_evidence",
];
const CHECK_POLICY = {
  schemaVersion: 1 as const,
  platform: "linux" as const,
  tools: [{ tool: "git" as const, required: true }],
  checks: [{
    id: "source.integrity",
    template: "source.integrity.v1" as const,
    tool: null,
    paths: [],
    required: true,
  }],
};
const HEAD_ONE = "1".repeat(40);
const HEAD_TWO = "3".repeat(40);

type RunBody = {
  id: string;
  status: string;
  workflowVersionId: string;
  budgetLimitUsd: string;
};
type AvailabilityBody = {
  status: string;
  reasons: string[];
  minimumBudgetLimitUsd: string | null;
};
type PresetsPage = {
  items: Array<{ id: string; availability: AvailabilityBody | null }>;
};
type Bindings = Partial<
  Record<"harness.implement" | "harness.repair" | "review.independent", string>
>;

const withFixture = <T>(work: (fixture: Fixture) => Promise<T>) =>
  withWorkerFixture(work, { env: presetBudgetEnv });

const policyDraft = (allowedEffects: readonly string[]) => ({
  schemaVersion: 1 as const,
  commands: COMMANDS,
  allowedEffects,
  lockedConfiguration: { branches: true, worktree: true, checker: true },
  decisions: DECISIONS,
});

/** A hand-built observed (v2) profile config, enough for availability reads. */
async function observedConfigExtra(
  bindings: Bindings,
  allowedEffects: readonly string[] = ALL_EFFECTS,
) {
  return {
    schemaVersion: 2 as const,
    checkPolicy: CHECK_POLICY,
    fixedPolicy: {
      ...policyDraft(allowedEffects),
      trustedChecker: {
        kind: "repository-inspection" as const,
        configDigest: await sha256Hex(canonicalJson(CHECK_POLICY)),
      },
    },
    agentBindings: bindings,
  };
}

async function reviewedAvailability(
  fixture: Fixture,
  repositoryId: string,
  presetId: string = REVIEWED,
): Promise<AvailabilityBody> {
  const page = await expectJson<PresetsPage>(
    await apiCall(
      fixture,
      fixture,
      "GET",
      `/v1/workflow-presets?repositoryId=${repositoryId}`,
    ),
    200,
  );
  const item = page.items.find(({ id }) => id === presetId);
  assert(item?.availability, `no availability for ${presetId}`);
  return item.availability;
}

/** Three funded agents: implement, repair and review. */
async function fundedAgents(
  fixture: Fixture,
  label: string,
  max?: number,
): Promise<Required<Bindings>> {
  const options = { maxUsdReservation: max };
  return {
    "harness.implement": await seedFundedCodingAgent(
      fixture,
      fixture,
      `${label}-i`,
      options,
    ),
    "harness.repair": await seedFundedCodingAgent(
      fixture,
      fixture,
      `${label}-r`,
      options,
    ),
    "review.independent": await seedFundedCodingAgent(
      fixture,
      fixture,
      `${label}-v`,
      options,
    ),
  };
}

/** A repository with a hand-built observed profile and the given bindings. */
async function observedRepository(
  fixture: Fixture,
  bindings: Bindings,
  allowedEffects: readonly string[] = ALL_EFFECTS,
): Promise<PresetRepository> {
  return await seedPresetRepository(fixture.pgDatabase, fixture, {
    profileExtra: await observedConfigExtra(bindings, allowedEffects),
  });
}

/**
 * Onboards a repository through the real inspection route and returns the
 * active observed profile it published, the way a worker-backed onboarding
 * does. Runs against this profile pass the real observation admission.
 */
async function onboardObserved(
  fixture: Fixture,
  bindings: Bindings,
  allowedEffects: readonly string[] = ALL_EFFECTS,
) {
  const harness = await openRepositoryInspectionHarness(
    { authDb: fixture.pgDatabase, appPg: fixture.runtimePgDatabase },
    fixture,
  );
  try {
    const repository = await harness.createRepository(false, {
      profileConfig: {
        ...baseProfileConfig,
        agentBindings: bindings,
        fixedPolicy: policyDraft(allowedEffects),
      },
      profileHeaders: { "If-Match": '"1"' },
    });
    await harness.onboard(repository.repositoryId);
    const assignment = await readInspectionAssignment(await harness.claim());
    await harness.start(assignment);
    const receipt = await receiveInspectionSource(harness, assignment);
    const report = await harness.report(assignment.input, receipt);
    const result = await harness.result(assignment, report);
    assertEquals(result.status, 200, await result.clone().text());
    const snapshot = await harness.snapshot(
      repository.repositoryId,
      assignment.jobId,
    );
    const profileId = assignment.input.profile.id;
    assertEquals(snapshot.active_profile_id, profileId);
    return {
      organizationId: fixture.organizationId,
      applicationId: repository.applicationId,
      repositoryId: repository.repositoryId,
      profileId,
      profileDigest: assignment.input.profile.digest,
      agentVersionId: bindings["harness.implement"] ?? null,
    } satisfies PresetRepository;
  } finally {
    await harness.close();
  }
}

async function startRun(
  fixture: Fixture,
  repository: PresetRepository,
  presetId: string,
  expectedStatus: number,
) {
  const task = await createPresetTask(fixture, fixture, repository);
  const response = await apiCall(
    fixture,
    fixture,
    "POST",
    `/v1/tasks/${task.id}/runs`,
    { body: presetRunBody(repository, { presetId }) },
  );
  const text = await response.text();
  assertEquals(response.status, expectedStatus, text);
  return { task, body: JSON.parse(text) as Record<string, unknown> };
}

type StepRow = {
  id: string;
  step_key: string;
  position: number;
  iteration: number;
  status: string;
};

async function stepRows(
  database: PgDatabase,
  organizationId: string,
  runId: string,
): Promise<StepRow[]> {
  const rows = await database.query<StepRow>(
    `select id, step_key, position, iteration, status from bakery.run_steps
      where organization_id = $1 and run_id = $2
      order by position, iteration, id`,
    [organizationId, runId],
  );
  return rows.rows;
}

async function snapshotOf(
  database: PgDatabase,
  organizationId: string,
  runId: string,
) {
  const result = await database.query<{ snapshot: Record<string, unknown> }>(
    `select snapshot from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  return result.rows[0].snapshot;
}

async function jobOf(
  database: PgDatabase,
  organizationId: string,
  stepId: string,
) {
  const result = await database.query<{
    id: string;
    action: string;
    status: string;
    input: Record<string, unknown>;
    agent_version_id: string | null;
    requirements: { capabilities: string[] };
  }>(
    `select id, action, status, input, agent_version_id, requirements
       from bakery.jobs where organization_id = $1 and run_step_id = $2`,
    [organizationId, stepId],
  );
  assertEquals(result.rows.length, 1);
  const job = result.rows[0];
  // The stored input carries the server-injected pinned profile; the step's
  // own input is everything else.
  assert(job.input.repositoryProfile !== undefined);
  return { ...job, input: withoutProfile(job.input) };
}

function withoutProfile(input: Record<string, unknown>) {
  const { repositoryProfile: _profile, ...rest } = input;
  return rest;
}

export function registerPresetIntegrationCases(): void {
  registerAvailabilityCases();
  registerRunCreationCases();
  registerIterationCases();
}

function registerAvailabilityCases(): void {
  Deno.test("reviewed availability names a review or repair agent problem by its own reason", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const agents = await fundedAgents(fixture, `av-${suffix}`);
      const verdict = async (
        bindings: Bindings,
        effects: readonly string[] = ALL_EFFECTS,
      ) =>
        await reviewedAvailability(
          fixture,
          (await observedRepository(fixture, bindings, effects)).repositoryId,
        );

      // Four reservations of one dollar: implement, review, repair, re-review.
      assertEquals(await verdict(agents), {
        status: "ready",
        reasons: [],
        minimumBudgetLimitUsd: "4",
      });

      // Unbound agents: each step reports its own reason, in a stable order.
      const missing = (...keys: Array<keyof Bindings>) => {
        const bindings: Bindings = { ...agents };
        for (const key of keys) delete bindings[key];
        return bindings;
      };
      assertEquals(
        (await verdict(missing("review.independent"))).reasons,
        ["review_agent_unavailable"],
      );
      assertEquals(
        (await verdict(missing("harness.repair"))).reasons,
        ["repair_agent_unavailable"],
      );
      assertEquals(
        (await verdict(
          missing("harness.implement", "harness.repair", "review.independent"),
        )).reasons,
        [
          "coding_agent_unbound",
          "review_agent_unavailable",
          "repair_agent_unavailable",
        ],
      );
      // No verdict about the budget minimum while a model step has no agent.
      assertEquals(
        (await verdict(missing("review.independent"))).minimumBudgetLimitUsd,
        null,
      );

      // A disabled, unbilled, unpriced or capability-denied agent is the same
      // single reason for its step.
      const disabled = await seedFundedCodingAgent(
        fixture,
        fixture,
        `dis-${suffix}`,
      );
      await fixture.pgDatabase.query(
        `update bakery.agent_definitions set enabled = false
          where organization_id = $1 and id = (
            select agent_id from bakery.agent_versions where id = $2
          )`,
        [fixture.organizationId, disabled],
      );
      assertEquals(
        (await verdict({ ...agents, "review.independent": disabled })).reasons,
        ["review_agent_unavailable"],
      );
      const unbilled = await createCodingAgent(
        fixture,
        fixture,
        `unb-${suffix}`,
        { harness: "codex" },
      );
      assertEquals(
        (await verdict({ ...agents, "harness.repair": unbilled })).reasons,
        ["repair_agent_unavailable"],
      );
      const unpriced = await seedFundedCodingAgent(
        fixture,
        fixture,
        `unp-${suffix}`,
        { priced: false },
      );
      assertEquals(
        (await verdict({ ...agents, "review.independent": unpriced })).reasons,
        ["review_agent_unavailable"],
      );
      const denied = presetBilling(`den-${suffix}`);
      await seedProviderPricingSnapshot(fixture.pgDatabase, {
        billing: denied,
      });
      const noReviewer = await createCodingAgent(
        fixture,
        fixture,
        `den-${suffix}`,
        { harness: "codex", billing: denied, allowedCapabilities: ["git"] },
      );
      assertEquals(
        (await verdict({ ...agents, "harness.repair": noReviewer })).reasons,
        ["repair_agent_unavailable"],
      );
      assertEquals(
        (await verdict({ ...agents, "review.independent": noReviewer }))
          .reasons,
        ["review_agent_unavailable"],
      );
    }));

  Deno.test("reviewed availability sums one mandatory path plus one repair cycle for the budget minimum", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const verdictFor = async (max: number) => {
        const agents = await fundedAgents(fixture, `bm${max}-${suffix}`, max);
        return await reviewedAvailability(
          fixture,
          (await observedRepository(fixture, agents)).repositoryId,
        );
      };
      // 3 + 3 + 3 + 3 = 12 equals the preset default: not below.
      assertEquals(await verdictFor(3), {
        status: "ready",
        reasons: [],
        minimumBudgetLimitUsd: "12",
      });
      // 4 + 4 + 4 + 4 = 16 exceeds the default budget of 12.
      assertEquals(await verdictFor(4), {
        status: "setup_required",
        reasons: ["budget_below_reservation"],
        minimumBudgetLimitUsd: "16",
      });
      // A single agent reservation of 5 would pass fixed-coding's 5.00 default
      // but the reviewed minimum is the whole path, so 20 is reported.
      assertEquals((await verdictFor(5)).minimumBudgetLimitUsd, "20");
    }));

  Deno.test("reviewed availability needs an observed fixed policy that allows every effect", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const agents = await fundedAgents(fixture, `ef-${suffix}`);
      const reasons = async (repository: PresetRepository) =>
        (await reviewedAvailability(fixture, repository.repositoryId)).reasons;

      for (const effect of ALL_EFFECTS) {
        assertEquals(
          await reasons(
            await observedRepository(
              fixture,
              agents,
              ALL_EFFECTS.filter((entry) => entry !== effect),
            ),
          ),
          ["profile_effect_denied"],
          effect,
        );
      }
      // A strict-v1 profile has no observed fixed policy at all.
      const v1 = await seedPresetRepository(fixture.pgDatabase, fixture, {
        profileExtra: { agentBindings: agents },
      });
      assertEquals(await reasons(v1), ["profile_effect_denied"]);
      // fixed-coding on that same profile is ready: nothing changed for it.
      assertEquals(
        (await reviewedAvailability(fixture, v1.repositoryId, "fixed-coding"))
          .reasons,
        [],
      );
    }));

  Deno.test("a bound require rule is satisfied by the reviewed preset and still blocks fixed-coding", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const agents = await fundedAgents(fixture, `rl-${suffix}`);
      const repository = await observedRepository(fixture, agents);
      await publishOrganizationRules(fixture, fixture, 0, [
        numbersRule({ locked: true }, { checkBinding: "magic.numbers" }),
      ]);
      const reviewed = await reviewedAvailability(
        fixture,
        repository.repositoryId,
      );
      assertEquals(reviewed.reasons, []);
      assertEquals(reviewed.status, "ready");
      const plain = await reviewedAvailability(
        fixture,
        repository.repositoryId,
        "fixed-coding",
      );
      assert(plain.reasons.includes("required_check_missing"));
    }));
}

function registerRunCreationCases(): void {
  Deno.test("a reviewed preset run starts through runs.create with brief, implement, check and review rows only", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const agents = await fundedAgents(fixture, `rc-${suffix}`);
      const repository = await onboardObserved(fixture, agents);
      assertEquals(
        (await reviewedAvailability(fixture, repository.repositoryId)).status,
        "ready",
      );
      const { body } = await startRun(fixture, repository, REVIEWED, 201);
      const run = body as unknown as RunBody;
      assertEquals(run.status, "queued");
      assertEquals(Number(run.budgetLimitUsd), 12);

      // The repair step has no row; the others keep their spec positions.
      const rows = await stepRows(
        fixture.pgDatabase,
        fixture.organizationId,
        run.id,
      );
      assertEquals(
        rows.map((row) => [row.step_key, row.position, row.iteration]),
        [["brief", 0, 0], ["implement", 1, 0], ["check", 3, 0], [
          "review",
          4,
          0,
        ]],
      );
      assertEquals(
        new Set(rows.map((row) => row.status)),
        new Set(["pending"]),
      );

      const snapshot = await snapshotOf(
        fixture.pgDatabase,
        fixture.organizationId,
        run.id,
      );
      // The loop bounds are frozen from the code-owned limits.
      assertEquals(snapshot.reviewLoop, {
        maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCycles,
        maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
        maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
      });
      assertEquals(reviewLoopFromSnapshot(snapshot), snapshot.reviewLoop);
      // The skipped repair step still has its agent and action binding frozen,
      // so an appended repair iteration admits against the same authority.
      const stepAgents = snapshot.stepAgents as Record<
        string,
        { agentVersionId: string }
      >;
      assertEquals(
        Object.keys(stepAgents).sort(),
        ["implement", "repair", "review"],
      );
      assertEquals(
        stepAgents.implement.agentVersionId,
        agents["harness.implement"],
      );
      assertEquals(
        stepAgents.repair.agentVersionId,
        agents["harness.repair"],
      );
      assertEquals(
        stepAgents.review.agentVersionId,
        agents["review.independent"],
      );
      const actions = snapshot.stepActions as Record<
        string,
        { action: string }
      >;
      assertEquals(actions.repair.action, "harness.repair");
      const workflow = snapshot.workflow as {
        digest: string;
        normalizedSpec: { steps: Array<{ id: string }> };
      };
      assertEquals(workflow.digest, FIXED_CODING_REVIEWED_PRESET.digest);
      assertEquals(
        workflow.normalizedSpec.steps.map((step) => step.id),
        ["brief", "implement", "repair", "check", "review"],
      );
    }));

  Deno.test("a fixed-coding run is unchanged: two rows and no loop bounds", () =>
    withFixture(async (fixture) => {
      const agent = await seedFundedCodingAgent(
        fixture,
        fixture,
        `fc-${crypto.randomUUID().slice(0, 8)}`,
      );
      const repository = await seedPresetRepository(
        fixture.pgDatabase,
        fixture,
        { agentVersionId: agent },
      );
      const { body } = await startRun(fixture, repository, "fixed-coding", 201);
      const run = body as unknown as RunBody;
      assertEquals(Number(run.budgetLimitUsd), 5);
      const rows = await stepRows(
        fixture.pgDatabase,
        fixture.organizationId,
        run.id,
      );
      assertEquals(rows.map((row) => [row.step_key, row.position]), [
        ["brief", 0],
        ["implement", 1],
      ]);
      const snapshot = await snapshotOf(
        fixture.pgDatabase,
        fixture.organizationId,
        run.id,
      );
      assertEquals(Object.hasOwn(snapshot, "reviewLoop"), false);
      assertEquals(reviewLoopFromSnapshot(snapshot), null);
      assertEquals(
        (snapshot.workflow as { digest: string }).digest,
        FIXED_CODING_PRESET.digest,
      );
    }));

  Deno.test("a mis-set profile is refused before any step can spend", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const agents = await fundedAgents(fixture, `ms-${suffix}`);
      const refuse = async (repository: PresetRepository, label: string) => {
        const { task, body } = await startRun(
          fixture,
          repository,
          REVIEWED,
          422,
        );
        assertEquals(
          (body as { issues?: Array<{ path: unknown; code: string }> }).issues
            ?.map((issue) => [issue.path, issue.code]),
          [[["repositoryProfileId"], "profile_effect_denied"]],
          label,
        );
        // Nothing was written: the task is still a draft and no run exists.
        const rows = await fixture.pgDatabase.query<
          { status: string; runs: string }
        >(
          `select task.status,
                  (select count(*)::text from bakery.workflow_runs
                    where organization_id = task.organization_id
                      and task_id = task.id) as runs
             from bakery.tasks task
            where task.organization_id = $1 and task.id = $2`,
          [fixture.organizationId, task.id],
        );
        assertEquals(rows.rows[0].status, "draft", label);
        assertEquals(rows.rows[0].runs, "0", label);
      };
      // A strict-v1 profile has no observed fixed policy; its bindings are
      // complete, so only the policy check can be what refuses the start.
      await refuse(
        await seedPresetRepository(fixture.pgDatabase, fixture, {
          profileExtra: { agentBindings: agents },
        }),
        "v1 profile",
      );
      // An observed profile whose policy lacks the review effect is refused too.
      await refuse(
        await onboardObserved(
          fixture,
          agents,
          ALL_EFFECTS.filter((effect) => effect !== "review_evidence"),
        ),
        "observed profile without review_evidence",
      );
      // The same v1 profile still starts fixed-coding.
      const v1 = await seedPresetRepository(fixture.pgDatabase, fixture, {
        profileExtra: { agentBindings: agents },
      });
      await startRun(fixture, v1, "fixed-coding", 201);
    }));
}

function registerIterationCases(): void {
  Deno.test("check and review admit from the recorded outputs and a later repair iteration admits from the latest ones", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const agents = await fundedAgents(fixture, `it-${suffix}`);
      const repository = await onboardObserved(fixture, agents);
      const { body } = await startRun(fixture, repository, REVIEWED, 201);
      const run = body as unknown as RunBody;
      const org = fixture.organizationId;
      const database = fixture.pgDatabase;
      const engine = createBakeryPostgresWorkflowRepository({
        database,
        maxAttempts: 1,
        budgetPolicy: presetBudgetPolicy,
      });
      const owner = await engine.acquireEngineOwner(
        run.id,
        crypto.randomUUID(),
        60_000,
      );
      assert(owner);
      const admit = async (stepKey: string, iteration: number) => {
        const admitted = await engine.admit({
          runId: run.id,
          stepKey,
          iteration,
          actionVersion: run.workflowVersionId,
        }, owner);
        assert(admitted.jobId, `${stepKey}@${iteration} must admit a job`);
        const row = (await stepRows(database, org, run.id)).find((step) =>
          step.step_key === stepKey && step.iteration === iteration
        );
        assert(row);
        return { stepId: row.id, job: await jobOf(database, org, row.id) };
      };
      const complete = async (stepId: string, output: unknown) => {
        await database.query(
          `update bakery.run_steps
              set status = 'completed', output = $3::jsonb, finished_at = now()
            where organization_id = $1 and id = $2`,
          [org, stepId, JSON.stringify(output)],
        );
      };
      const harnessOutput = (headSha: string) => ({
        headSha,
        baseSha: BASE_SHA,
        sessionId: crypto.randomUUID(),
        artifacts: [],
      });
      const claim = async (
        capabilities: string[],
        action: string,
      ): Promise<Record<string, unknown>> => {
        const worker = await registeredWorker(fixture, {
          name: `reviewed-${action}-${crypto.randomUUID().slice(0, 6)}`,
          capabilities,
        });
        const claimKey = crypto.randomUUID();
        const response = await workerRequest(
          fixture,
          worker.credential,
          "/v1/worker/claims",
          {
            claimKey,
            workerHostId: worker.registration.workerHostId,
            capabilities,
            supportedActions: [action],
          },
          { idempotencyKey: claimKey },
        );
        assertEquals(response.status, 200, await response.clone().text());
        return await response.json() as Record<string, unknown>;
      };
      try {
        // brief and implement: the first candidate.
        const brief = await admit("brief", 0);
        await complete(brief.stepId, {
          artifact: {
            artifactId: crypto.randomUUID(),
            versionId: crypto.randomUUID(),
            sha256: "d".repeat(64),
          },
        });
        const implement = await admit("implement", 0);
        await complete(implement.stepId, harnessOutput(HEAD_ONE));

        // check admits once implement has output, against the implemented head.
        const check = await admit("check", 0);
        assertEquals(check.job.action, "quality.check");
        assertEquals(check.job.input, {
          repositoryId: repository.repositoryId,
          revision: HEAD_ONE,
          checks: ["magic.numbers", "lint"],
        });
        // The real claim re-derives the same input from the stored outputs.
        const checkClaim = await claim(
          [...workerFixtureCapabilities],
          "quality.check",
        );
        assertEquals(checkClaim.jobId, check.job.id);
        assertEquals(
          withoutProfile(checkClaim.input as Record<string, unknown>),
          check.job.input,
        );
        const failed = observation({
          checkId: "magic.numbers",
          result: "failed",
          reason: "exit_nonzero",
          exitCode: 3,
        });
        const warned = observation({
          checkId: "lint",
          result: "failed",
          reason: "exit_nonzero",
          exitCode: 1,
        });
        const checked = checkOutput([failed, warned], {
          headSha: HEAD_ONE,
          failedCheckIds: [failed.checkRunId],
        });
        await complete(check.stepId, checked);

        // review admits with the check run ids of the same candidate.
        const review = await admit("review", 0);
        assertEquals(review.job.action, "review.independent");
        assertEquals(review.job.input, {
          repositoryId: repository.repositoryId,
          revision: HEAD_ONE,
          evidence: checked.checkRunIds,
        });
        assertEquals(review.job.agent_version_id, agents["review.independent"]);
        assert(review.job.requirements.capabilities.includes("reviewer"));
        assert(review.job.requirements.capabilities.includes("model"));
        // The review step owns one server-created session for its reviewer.
        const sessions = await database.query<{ count: string }>(
          `select count(*)::text as count from bakery.agent_sessions
            where organization_id = $1 and run_step_id = $2`,
          [org, review.stepId],
        );
        assertEquals(sessions.rows[0].count, "1");
        const blocker = finding({
          fingerprint: fingerprintOf(1),
          severity: "blocker",
          path: "src/upload.ts",
        });
        const minor = finding({
          fingerprint: fingerprintOf(2),
          severity: "minor",
        });
        await complete(
          review.stepId,
          reviewOutput([blocker, minor], { headSha: HEAD_ONE }),
        );

        // The result hook (phase 4) appends the next iteration with the app
        // role. Rows with higher iteration and fresh positions are all the
        // engine needs: it orders by position, iteration, id.
        const maxPosition = Math.max(
          ...(await stepRows(database, org, run.id)).map((row) => row.position),
        );
        for (const [offset, key] of ["repair", "check", "review"].entries()) {
          await fixture.runtimePgDatabase.query(
            `insert into bakery.run_steps
               (organization_id, run_id, step_key, position, iteration, status,
                input)
             values ($1, $2, $3, $4, 1, 'pending', '{}'::jsonb)`,
            [org, run.id, key, maxPosition + 1 + offset],
          );
        }
        const next = await engine.findNext(run.id);
        assertEquals(
          next && [next.stepKey, next.iteration],
          ["repair", 1],
        );

        // repair@1 reads the latest check and review outputs and the head of
        // the candidate they judged.
        const repair = await admit("repair", 1);
        assertEquals(repair.job.action, "harness.repair");
        assertEquals(repair.job.agent_version_id, agents["harness.repair"]);
        assertEquals(repair.job.input, {
          repositoryId: repository.repositoryId,
          revision: HEAD_ONE,
          findings: [blocker],
          failedChecks: [{
            checkRunId: failed.checkRunId,
            checkId: "magic.numbers",
            result: "failed",
            reason: "exit_nonzero",
            exitCode: 3,
          }],
        });
        // The repair step gets its own session (its output carries one).
        const repairSessions = await database.query<{ count: string }>(
          `select count(*)::text as count from bakery.agent_sessions
            where organization_id = $1 and run_step_id = $2`,
          [org, repair.stepId],
        );
        assertEquals(repairSessions.rows[0].count, "1");
        const repairClaim = await claim(
          [...workerFixtureCapabilities],
          "harness.repair",
        );
        assertEquals(repairClaim.jobId, repair.job.id);
        assertEquals(
          withoutProfile(repairClaim.input as Record<string, unknown>),
          repair.job.input,
        );
        await complete(repair.stepId, harnessOutput(HEAD_TWO));

        // The next check and review follow the repaired head, not the first.
        const checkTwo = await admit("check", 1);
        assertEquals(
          (checkTwo.job.input as { revision: string }).revision,
          HEAD_TWO,
        );
        const passed = checkOutput(
          [
            observation({ checkId: "magic.numbers" }),
            observation({ checkId: "lint" }),
          ],
          { headSha: HEAD_TWO },
        );
        await complete(checkTwo.stepId, passed);
        const reviewTwo = await admit("review", 1);
        assertEquals(reviewTwo.job.input, {
          repositoryId: repository.repositoryId,
          revision: HEAD_TWO,
          evidence: passed.checkRunIds,
        });
        assertNotEquals(
          (reviewTwo.job.input as { evidence: string[] }).evidence,
          checked.checkRunIds,
        );
      } finally {
        await engine.releaseEngineOwner(owner);
      }
    }));
}
