import { assert, assertEquals } from "@std/assert";
import { REVIEW_LOOP_LIMITS } from "../../../packages/contracts/src/review-evidence.ts";
import { baseProfileConfig } from "../repository-rule-entries.ts";
import { reviewLoopFromSnapshot } from "../../../packages/persistence/src/repository-admission.ts";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import { createBakeryPostgresWorkflowRepository } from "../../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { readPlanHost } from "../../../apps/server/src/modules/delivery/plan-host.ts";
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
import { type WorkerFixture } from "../worker-execution.ts";
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
export async function observedConfigExtra(
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
export async function fundedAgents(
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
export async function onboardObserved(
  fixture: Readonly<{
    pgDatabase: PgDatabase;
    runtimePgDatabase: PgDatabase;
    organizationId: string;
    principalId: string;
  }>,
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

export async function startRun(
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
  Deno.test("a reviewed preset run starts through runs.create as a plan: no step rows, the plan's loop bounds frozen", () =>
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

      // A plan run writes no step rows: the engine appends each step as the
      // plan decides it.
      assertEquals(
        await stepRows(
          fixture.pgDatabase,
          fixture.organizationId,
          run.id,
        ),
        [],
      );

      const snapshot = await snapshotOf(
        fixture.pgDatabase,
        fixture.organizationId,
        run.id,
      );
      // The loop bounds are frozen from the plan's own repeat bound.
      assertEquals(snapshot.reviewLoop, {
        maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCycles,
        maxLoopDurationMs: REVIEW_LOOP_LIMITS.maxLoopDurationMs,
        maxFindings: REVIEW_LOOP_LIMITS.maxFindings,
      });
      assertEquals(reviewLoopFromSnapshot(snapshot), snapshot.reviewLoop);
      // The plan and the agent each step will run as are frozen.
      const runtime = snapshot.runtime as {
        document: { steps: Array<{ id: string }> };
      };
      assertEquals(runtime.document.steps.map((step) => step.id), [
        "flow",
        "repair",
      ]);
      assertEquals(
        Object.keys(snapshot.planAgents as object).sort(),
        Object.values(agents).sort(),
      );
      assertEquals(snapshot.planActionAgents, {
        "harness.implement": agents["harness.implement"],
        "harness.repair": agents["harness.repair"],
        "review.independent": agents["review.independent"],
      });
      // The flat sections are empty, not missing: flat readers still work.
      assertEquals(snapshot.stepAgents, {});
      assertEquals(snapshot.stepActions, {});
      const workflow = snapshot.workflow as { digest: string };
      assertEquals(workflow.digest, FIXED_CODING_REVIEWED_PRESET.digest);
    }));

  Deno.test("a fixed-coding run is a plan too: no step rows and no loop bounds", () =>
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
      assertEquals(
        await stepRows(
          fixture.pgDatabase,
          fixture.organizationId,
          run.id,
        ),
        [],
      );
      const snapshot = await snapshotOf(
        fixture.pgDatabase,
        fixture.organizationId,
        run.id,
      );
      assertEquals(Object.hasOwn(snapshot, "reviewLoop"), false);
      assertEquals(reviewLoopFromSnapshot(snapshot), null);
      const runtime = snapshot.runtime as {
        document: { steps: Array<{ id: string }> };
      };
      assertEquals(runtime.document.steps.map((step) => step.id), ["flow"]);
      assertEquals(Object.keys(snapshot.planAgents as object), [agent]);
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
  const engineFor = (fixture: Fixture) =>
    createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 1,
      budgetPolicy: presetBudgetPolicy,
      // The host resolves `$delivery` from the run's own rows.
      planHost: readPlanHost,
    });

  const harnessOutput = (headSha: string) => ({
    headSha,
    baseSha: BASE_SHA,
    sessionId: crypto.randomUUID(),
    artifacts: [],
  });

  const complete = async (
    fixture: Fixture,
    runId: string,
    stepKey: string,
    output: unknown,
  ) => {
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set status = 'completed', output = $3::jsonb, finished_at = now()
        where organization_id = $1 and run_id = $2 and step_key = $4`,
      [fixture.organizationId, runId, JSON.stringify(output), stepKey],
    );
  };

  const stepOf = async (
    fixture: Fixture,
    runId: string,
    stepKey: string,
  ) => {
    const row = (await stepRows(
      fixture.pgDatabase,
      fixture.organizationId,
      runId,
    )).find((step) => step.step_key === stepKey);
    assert(row, `no row for ${stepKey}`);
    return row;
  };

  const next = async (
    engine: ReturnType<typeof engineFor>,
    runId: string,
    owner: NonNullable<
      Awaited<ReturnType<typeof engine.acquireEngineOwner>>
    >,
    expected: string,
  ) => {
    const key = await engine.findNext(runId, owner);
    assertEquals(key?.stepKey, expected);
    assert(key);
    return key;
  };

  // Drives brief, implement and check to a chosen check output, returning the
  // check output so the caller can judge the review that follows.
  const runToCheck = async (
    fixture: Fixture,
    repository: PresetRepository,
    engine: ReturnType<typeof engineFor>,
    owner: NonNullable<
      Awaited<ReturnType<typeof engine.acquireEngineOwner>>
    >,
    runId: string,
    checked: unknown,
  ) => {
    const brief = await next(engine, runId, owner, "flow.brief");
    await engine.admit(brief, owner);
    await complete(fixture, runId, "flow.brief", {
      artifact: {
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: "d".repeat(64),
      },
    });
    const implement = await next(engine, runId, owner, "flow.implement");
    await engine.admit(implement, owner);
    await complete(fixture, runId, "flow.implement", harnessOutput(HEAD_ONE));

    const check = await next(engine, runId, owner, "flow.check");
    const checkJob = await engine.admit(check, owner);
    assert(checkJob.jobId);
    const checkRow = await stepOf(fixture, runId, "flow.check");
    assertEquals(
      (await jobOf(
        fixture.pgDatabase,
        fixture.organizationId,
        checkRow.id,
      )).input,
      {
        repositoryId: repository.repositoryId,
        revision: HEAD_ONE,
        checks: ["magic.numbers", "lint"],
      },
    );
    await complete(fixture, runId, "flow.check", checked);
    return checked;
  };

  Deno.test("a clean review ends the reviewed plan without entering the repair body", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const agents = await fundedAgents(fixture, `it-${suffix}`);
      const repository = await onboardObserved(fixture, agents);
      const { body } = await startRun(fixture, repository, REVIEWED, 201);
      const run = body as unknown as RunBody;
      const engine = engineFor(fixture);
      const owner = await engine.acquireEngineOwner(
        run.id,
        crypto.randomUUID(),
        60_000,
      );
      assert(owner);
      try {
        const checked = checkOutput(
          [
            observation({ checkId: "magic.numbers" }),
            observation({ checkId: "lint" }),
          ],
          { headSha: HEAD_ONE },
        );
        await runToCheck(fixture, repository, engine, owner, run.id, checked);

        const review = await next(engine, run.id, owner, "flow.review");
        const reviewJob = await engine.admit(review, owner);
        assert(reviewJob.jobId);
        const reviewRow = await stepOf(fixture, run.id, "flow.review");
        assertEquals(
          (await jobOf(
            fixture.pgDatabase,
            fixture.organizationId,
            reviewRow.id,
          )).input,
          {
            repositoryId: repository.repositoryId,
            revision: HEAD_ONE,
            evidence: checked.checkRunIds,
          },
        );
        await complete(
          fixture,
          run.id,
          "flow.review",
          reviewOutput([], { headSha: HEAD_ONE }),
        );

        // The repeat's until is satisfied: the plan is over and no repair row
        // was ever appended.
        assertEquals(await engine.findNext(run.id, owner), undefined);
        assertEquals(
          (await stepRows(
            fixture.pgDatabase,
            fixture.organizationId,
            run.id,
          )).map((row) => row.step_key),
          ["flow.brief", "flow.implement", "flow.check", "flow.review"],
        );
      } finally {
        await engine.releaseEngineOwner(owner);
      }
    }));

  Deno.test("a blocking review enters the repair body and the repair step reads the candidate", () =>
    withFixture(async (fixture) => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const agents = await fundedAgents(fixture, `it-${suffix}`);
      const repository = await onboardObserved(fixture, agents);
      const { body } = await startRun(fixture, repository, REVIEWED, 201);
      const run = body as unknown as RunBody;
      const engine = engineFor(fixture);
      const owner = await engine.acquireEngineOwner(
        run.id,
        crypto.randomUUID(),
        60_000,
      );
      assert(owner);
      try {
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
        await runToCheck(fixture, repository, engine, owner, run.id, checked);

        const review = await next(engine, run.id, owner, "flow.review");
        await engine.admit(review, owner);
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
          fixture,
          run.id,
          "flow.review",
          reviewOutput([blocker, minor], { headSha: HEAD_ONE }),
        );

        // The until is false, so the plan enters the repeat body at iteration 1.
        const repair = await next(
          engine,
          run.id,
          owner,
          "repair@1.repair_implement",
        );
        const repairJob = await engine.admit(repair, owner);
        assert(repairJob.jobId);
        const repairRow = await stepOf(
          fixture,
          run.id,
          "repair@1.repair_implement",
        );
        assertEquals(
          (await jobOf(
            fixture.pgDatabase,
            fixture.organizationId,
            repairRow.id,
          )).input,
          {
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
          },
        );
        // The repair step gets its own reviewer session.
        const sessions = await fixture.pgDatabase.query<{ count: string }>(
          `select count(*)::text as count from bakery.agent_sessions
            where organization_id = $1 and run_step_id = $2`,
          [fixture.organizationId, repairRow.id],
        );
        assertEquals(sessions.rows[0].count, "1");
      } finally {
        await engine.releaseEngineOwner(owner);
      }
    }));
}
