import { assert, assertEquals, assertExists } from "@std/assert";
import {
  deriveReviewPins,
  type ReviewPins,
} from "../../../apps/server/src/modules/delivery/index.ts";
import { createBakeryPostgresWorkflowRepository } from "../../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import { baseProfileConfig } from "../repository-rule-entries.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  presetBudgetPolicy,
  type PresetRepository,
  presetRunBody,
  seedFundedCodingAgent,
} from "../fixed-coding-preset.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
  receiveInspectionSource,
} from "../repository-inspection.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
} from "../worker-execution.ts";
import {
  claimAssignment,
  postWorkerResult,
  type RegisteredWorker,
  resultBody,
  withWorkerFixture,
  type WorkerAssignment,
} from "../worker-execution/scenarios.ts";
import { insertCheckRun } from "../deterministic-checks/run-fixture.ts";
import {
  BASE_SHA,
  checkOutput,
  observation,
} from "../deterministic-checks/observations.ts";
import { type FindingFixture, reviewOutput } from "./fixtures.ts";

/**
 * A real reviewed-preset run for the issue #94 integration and security lanes.
 * The run is created through `runs.create` against an onboarded observed
 * profile, its steps are admitted by the production engine repository, the
 * implement, repair and review results go through the real worker result
 * route, and the checks are the rows a `quality.check` finalizer would have
 * written (they are seeded as the owner because that finalizer is #83's
 * subject, not this one's). Everything the review finalizer reads is real: the
 * snapshot, the step outputs, the agent sessions, the attempts, the pinned job
 * input and the check rows.
 */

export const REVIEWED_PRESET = "fixed-coding-reviewed";

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
/** Candidate heads of the successive iterations. */
export const HEADS = ["1", "3", "4", "5"].map((digit) => digit.repeat(40));

/** What a command did in a seeded check step. */
export type Outcome = "pass" | "fail" | "unavailable";

const OUTCOME_ROWS = {
  pass: { result: "passed", reason: "verified", exitCode: 0 },
  fail: { result: "failed", reason: "exit_nonzero", exitCode: 1 },
  unavailable: {
    result: "unavailable",
    reason: "tool_missing",
    exitCode: null,
  },
} as const;

export type StepRow = {
  id: string;
  step_key: string;
  position: number;
  iteration: number;
  status: string;
  input: unknown;
  output: unknown;
  error: unknown;
};

export type AdmittedStep = {
  readonly stepId: string;
  readonly job: {
    readonly id: string;
    readonly action: string;
    readonly input: Record<string, unknown>;
  };
};

export type SeededChecks = {
  readonly stepId: string;
  readonly rows: ReadonlyArray<{
    readonly id: string;
    readonly checkId: string;
    readonly outcome: Outcome;
    readonly outputDigest: string;
  }>;
};

export type ReviewTurn = {
  readonly iteration: number;
  readonly stepId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly assignment: WorkerAssignment;
  readonly worker: RegisteredWorker;
  readonly pins: ReviewPins;
  /** Claims the job again after a requeue, as the same reviewer host. */
  reclaim(): Promise<ReviewTurn>;
  /** An honest report for this review; `overrides` replace report fields. */
  report(
    findings?: readonly FindingFixture[],
    overrides?: Record<string, unknown>,
  ): ReturnType<typeof reviewOutput>;
  /** Posts a completed result through the real worker route. */
  post(result: unknown, key?: string): Promise<Response>;
  /** Posts a failed result carrying a fault through the real worker route. */
  fail(
    fault: { code: string; retryable: boolean },
    key?: string,
  ): Promise<Response>;
};

export type CycleRow = {
  id: string;
  ordinal: number;
  run_step_id: string;
  job_id: string | null;
  attempt_id: string | null;
  fence: string | null;
  reviewer_session_id: string;
  reviewer_principal_id: string;
  implementer_session_id: string;
  implementer_principal_id: string;
  head_sha: string;
  base_sha: string;
  policy_digest: string;
  status: string;
  finding_count: number;
  blocking_count: number;
  created_at: Date;
};

export type DecisionRow = {
  id: string;
  ordinal: number;
  review_cycle_id: string | null;
  decision: string;
  reason: string;
  head_sha: string;
  base_sha: string | null;
  policy_digest: string | null;
  failed_checks: Array<Record<string, unknown>>;
  blocking_fingerprints: string[];
  limits: Record<string, number>;
};

export type FindingRow = {
  id: string;
  review_cycle_id: string;
  fingerprint: string;
  severity: string;
  path: string;
  line: number | null;
  body: string;
};

export type LoopWorld = {
  readonly fixture: WorkerFixture;
  readonly repository: PresetRepository;
  readonly runId: string;
  readonly taskId: string;
  /** Admits `stepKey` at `iteration` through the production engine. */
  admit(stepKey: string, iteration: number): Promise<AdmittedStep>;
  /** Completes `brief` and runs `implement` through the real result route. */
  implement(headSha?: string): Promise<{
    stepId: string;
    sessionId: string;
    worker: RegisteredWorker;
    workerHostId: string;
    principalId: string;
  }>;
  /** Admits and runs `repair@iteration`, reporting `headSha`. */
  repair(
    iteration: number,
    headSha: string,
    host?: RegisteredWorker,
  ): Promise<AdmittedStep & { sessionId: string }>;
  /** Admits `check@iteration`, seeds its rows and completes the step. */
  check(
    iteration: number,
    headSha: string,
    outcomes?: Readonly<Record<string, Outcome>>,
    options?: { digest?: string; createdAt?: Date; rows?: boolean },
  ): Promise<SeededChecks>;
  /** Admits `review@iteration` and claims it as a reviewer host. */
  review(
    iteration: number,
    options?: { worker?: RegisteredWorker; capabilities?: string[] },
  ): Promise<ReviewTurn>;
  steps(): Promise<StepRow[]>;
  runStatus(): Promise<string>;
  taskStatus(): Promise<string>;
  cycles(): Promise<CycleRow[]>;
  findings(cycleId: string): Promise<FindingRow[]>;
  decisions(): Promise<DecisionRow[]>;
  /** Count of the three evidence tables' rows for this run, to prove silence. */
  evidenceCounts(): Promise<
    { cycles: number; findings: number; decisions: number }
  >;
  /** Audit entries of `operation` for the run's organization, oldest first. */
  audits(
    operation: string,
    outcome?: string,
  ): Promise<Array<{ outcome: string; details: Record<string, unknown> }>>;
  /** Sessions of one step. */
  sessionIds(stepId: string): Promise<string[]>;
  /** Replaces `reviewLoop` bounds in the run snapshot (an owner-role edit). */
  setLoopLimits(limits: Partial<Record<string, number>>): Promise<void>;
  /** The newest job input of one step, as stored. */
  jobInput(stepId: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

const policyDraft = () => ({
  schemaVersion: 1 as const,
  commands: COMMANDS,
  allowedEffects: ALL_EFFECTS,
  lockedConfiguration: { branches: true, worktree: true, checker: true },
  decisions: DECISIONS,
});

type Bindings = Record<
  "harness.implement" | "harness.repair" | "review.independent",
  string
>;

/** Onboards a repository through the real inspection route (observed profile). */
async function onboardObserved(
  fixture: WorkerFixture,
  bindings: Bindings,
): Promise<PresetRepository> {
  const harness = await openRepositoryInspectionHarness(
    { authDb: fixture.pgDatabase, appPg: fixture.runtimePgDatabase },
    fixture,
  );
  try {
    const repository = await harness.createRepository(false, {
      profileConfig: {
        ...baseProfileConfig,
        agentBindings: bindings,
        fixedPolicy: policyDraft(),
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
      agentVersionId: bindings["harness.implement"],
    } satisfies PresetRepository;
  } finally {
    await harness.close();
  }
}

/** Runs `work` with a fixture that has the budget policy a model step needs. */
export function withLoopFixture<T>(
  work: (fixture: WorkerFixture) => Promise<T>,
): Promise<T> {
  return withWorkerFixture(work, { env: presetBudgetEnv });
}

const sha = (text: string) => sha256Hex(canonicalJson(text));

/**
 * Starts a reviewed run and returns the helpers above. `budgetLimitUsd` sets
 * the run budget (default 12, the preset's), `maxUsd` each agent's reservation.
 */
export async function openLoopWorld(
  fixture: WorkerFixture,
  options: { budgetLimitUsd?: string; maxUsd?: number } = {},
): Promise<LoopWorld> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agent = (label: string) =>
    seedFundedCodingAgent(fixture, fixture, `${label}-${suffix}`, {
      maxUsdReservation: options.maxUsd,
    });
  const bindings: Bindings = {
    "harness.implement": await agent("i"),
    "harness.repair": await agent("r"),
    "review.independent": await agent("v"),
  };
  const repository = await onboardObserved(fixture, bindings);
  const task = await createPresetTask(fixture, fixture, repository);
  const run = await expectJson<{ id: string; workflowVersionId: string }>(
    await apiCall(fixture, fixture, "POST", `/v1/tasks/${task.id}/runs`, {
      body: presetRunBody(repository, {
        presetId: REVIEWED_PRESET,
        ...(options.budgetLimitUsd === undefined
          ? {}
          : { budgetLimitUsd: options.budgetLimitUsd }),
      }),
    }),
    201,
  );
  const org = fixture.organizationId;
  const database: PgDatabase = fixture.pgDatabase;
  const engine = createBakeryPostgresWorkflowRepository({
    database,
    maxAttempts: 3,
    budgetPolicy: presetBudgetPolicy,
  });
  const owner = await engine.acquireEngineOwner(
    run.id,
    crypto.randomUUID(),
    600_000,
  );
  assertExists(owner);
  const reviewerCapabilities = [...workerFixtureCapabilities, "reviewer"];

  const stepRows = async (): Promise<StepRow[]> =>
    (await database.query<StepRow>(
      `select id, step_key, position, iteration, status, input, output, error
         from bakery.run_steps
        where organization_id = $1 and run_id = $2
        order by position, iteration, id`,
      [org, run.id],
    )).rows;
  const stepIdOf = async (key: string, iteration: number) => {
    const row = (await stepRows()).find((step) =>
      step.step_key === key && step.iteration === iteration
    );
    assertExists(row, `${key}@${iteration} has no row`);
    return row.id;
  };
  const jobInput = async (stepId: string) => {
    const job = await database.query<{ input: Record<string, unknown> }>(
      `select input from bakery.jobs
        where organization_id = $1 and run_step_id = $2
        order by created_at desc, id desc limit 1`,
      [org, stepId],
    );
    assertExists(job.rows[0], "the step has no job");
    return job.rows[0].input;
  };
  const sessionIds = async (stepId: string) =>
    (await database.query<{ id: string }>(
      `select id from bakery.agent_sessions
        where organization_id = $1 and run_step_id = $2
        order by created_at, id`,
      [org, stepId],
    )).rows.map(({ id }) => id);
  const completeStep = async (stepId: string, output: unknown) => {
    await database.query(
      `update bakery.run_steps
          set status = 'completed', output = $3::jsonb, finished_at = now()
        where organization_id = $1 and id = $2`,
      [org, stepId, JSON.stringify(output)],
    );
  };
  const admit = async (
    stepKey: string,
    iteration: number,
  ): Promise<AdmittedStep> => {
    const admitted = await engine.admit({
      runId: run.id,
      stepKey,
      iteration,
      actionVersion: run.workflowVersionId,
    }, owner);
    assert(admitted.jobId, `${stepKey}@${iteration} must admit a job`);
    const stepId = await stepIdOf(stepKey, iteration);
    const job = await database.query<
      { id: string; action: string; input: Record<string, unknown> }
    >(
      `select id, action, input from bakery.jobs
        where organization_id = $1 and run_step_id = $2`,
      [org, stepId],
    );
    assertEquals(job.rows.length, 1);
    const { repositoryProfile: _profile, ...input } = job.rows[0].input;
    return { stepId, job: { ...job.rows[0], input } };
  };
  const workerHost = async (worker: RegisteredWorker) => {
    const host = await database.query<{ principal_id: string }>(
      `select principal_id from bakery.worker_hosts
        where organization_id = $1 and id = $2`,
      [org, worker.registration.workerHostId],
    );
    return host.rows[0].principal_id;
  };
  const harnessResult = async (
    stepId: string,
    action: string,
    headSha: string,
    host?: RegisteredWorker,
  ) => {
    // A host that can implement and also review, so one host may do both.
    const worker = host ?? await registeredWorker(fixture, {
      name: `loop-${action}-${crypto.randomUUID().slice(0, 6)}`,
      capabilities: reviewerCapabilities,
    });
    const assignment = await claimAssignment(fixture, worker, {
      capabilities: reviewerCapabilities,
      supportedActions: [action],
    });
    const [sessionId] = await sessionIds(stepId);
    assertExists(sessionId);
    const response = await postWorkerResult(
      fixture,
      worker,
      assignment,
      resultBody(assignment, {
        result: {
          headSha,
          baseSha: BASE_SHA,
          sessionId,
          artifacts: [],
        },
      }),
      crypto.randomUUID(),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return {
      sessionId,
      worker,
      workerHostId: worker.registration.workerHostId,
      principalId: await workerHost(worker),
    };
  };

  const world: LoopWorld = {
    fixture,
    repository,
    runId: run.id,
    taskId: task.id,
    admit,
    async implement(headSha = HEADS[0]) {
      const brief = await admit("brief", 0);
      await completeStep(brief.stepId, {
        artifact: {
          artifactId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          sha256: "d".repeat(64),
        },
      });
      const implement = await admit("implement", 0);
      const done = await harnessResult(
        implement.stepId,
        "harness.implement",
        headSha,
      );
      return { stepId: implement.stepId, ...done };
    },
    async repair(iteration, headSha, host) {
      const repair = await admit("repair", iteration);
      const done = await harnessResult(
        repair.stepId,
        "harness.repair",
        headSha,
        host,
      );
      return { ...repair, sessionId: done.sessionId };
    },
    async check(iteration, headSha, outcomes = {}, options = {}) {
      const check = await admit("check", iteration);
      const stored = await jobInput(check.stepId);
      // The check job carries the same pinned profile as a review job, so the
      // pins a finalizer would derive are the ones its rows must carry.
      const pins = await deriveReviewPins({ ...stored, revision: headSha });
      const rows = [];
      for (const command of pins.commands) {
        const outcome = outcomes[command.checkId] ?? "pass";
        const outputDigest = options.digest ??
          await sha(`${command.checkId}:${outcome}:${iteration}`);
        const id = options.rows === false
          ? crypto.randomUUID()
          : await insertCheckRun(database, {
            organizationId: org,
            runId: run.id,
            runStepId: check.stepId,
            jobId: check.job.id,
            checkId: command.checkId,
            ruleKey: command.ruleKey,
            ...OUTCOME_ROWS[outcome],
            durationMs: 120,
            outputDigest,
            headSha,
            baseSha: pins.baseSha,
            profileDigest: pins.profileDigest,
            policyDigest: pins.policyDigest,
            subjectDigest: command.subjectDigest,
            checkerDigest: pins.checkerDigest,
            createdAt: options.createdAt ?? new Date(),
          });
        rows.push({ id, checkId: command.checkId, outcome, outputDigest });
      }
      const observations = rows.map((row) =>
        observation({
          checkRunId: row.id,
          checkId: row.checkId,
          outputDigest: row.outputDigest,
          ...OUTCOME_ROWS[row.outcome],
        })
      );
      const requiredFailures = rows.filter((row) =>
        row.outcome !== "pass" &&
        pins.commands.find(({ checkId }) => checkId === row.checkId)?.mode ===
          "require"
      ).map(({ id }) => id);
      await completeStep(
        check.stepId,
        checkOutput(observations, {
          headSha,
          baseSha: pins.baseSha,
          policyDigest: pins.policyDigest,
          allRequired: requiredFailures.length === 0,
          failedCheckIds: requiredFailures,
        }),
      );
      return { stepId: check.stepId, rows };
    },
    async review(iteration, reviewOptions = {}) {
      const review = await admit("review", iteration);
      const capabilities = reviewOptions.capabilities ?? reviewerCapabilities;
      const worker = reviewOptions.worker ?? await registeredWorker(fixture, {
        name: `loop-review-${crypto.randomUUID().slice(0, 6)}`,
        capabilities,
      });
      const [sessionId] = await sessionIds(review.stepId);
      assertExists(sessionId);
      const pins = await deriveReviewPins(await jobInput(review.stepId));
      const turn = async (): Promise<ReviewTurn> => {
        const assignment = await claimAssignment(fixture, worker, {
          capabilities,
          supportedActions: ["review.independent"],
        });
        assertEquals(assignment.jobId, review.job.id);
        return {
          iteration,
          stepId: review.stepId,
          jobId: assignment.jobId,
          attemptId: assignment.attemptId,
          sessionId,
          assignment,
          worker,
          pins,
          reclaim: turn,
          report(findings = [], overrides = {}) {
            return reviewOutput(findings, {
              reviewId: crypto.randomUUID(),
              sessionId,
              headSha: pins.headSha,
              baseSha: pins.baseSha,
              policyDigest: pins.policyDigest,
              ...overrides,
            });
          },
          post(result, key = crypto.randomUUID()) {
            return postWorkerResult(
              fixture,
              worker,
              assignment,
              resultBody(assignment, {
                result: result as Record<string, unknown>,
              }),
              key,
            );
          },
          fail(fault, key = crypto.randomUUID()) {
            return postWorkerResult(
              fixture,
              worker,
              assignment,
              resultBody(assignment, {
                status: "failed",
                fault: {
                  type: "about:blank",
                  title: "Reviewer failed",
                  status: fault.retryable ? 503 : 500,
                  detail: "The reviewer could not run.",
                  code: fault.code,
                  requestId: crypto.randomUUID(),
                  retryable: fault.retryable,
                },
              }),
              key,
            );
          },
        };
      };
      return await turn();
    },
    steps: stepRows,
    async runStatus() {
      return (await database.query<{ status: string }>(
        "select status from bakery.workflow_runs where organization_id = $1 and id = $2",
        [org, run.id],
      )).rows[0].status;
    },
    async taskStatus() {
      return (await database.query<{ status: string }>(
        "select status from bakery.tasks where organization_id = $1 and id = $2",
        [org, task.id],
      )).rows[0].status;
    },
    async cycles() {
      return (await database.query<CycleRow>(
        `select id, ordinal, run_step_id, job_id, attempt_id, fence::text,
                reviewer_session_id, reviewer_principal_id,
                implementer_session_id, implementer_principal_id, head_sha,
                base_sha, policy_digest, status, finding_count, blocking_count,
                created_at
           from bakery.review_cycles
          where organization_id = $1 and run_id = $2 order by ordinal`,
        [org, run.id],
      )).rows;
    },
    async findings(cycleId) {
      return (await database.query<FindingRow>(
        `select id, review_cycle_id, fingerprint, severity, path, line, body
           from bakery.review_findings
          where organization_id = $1 and review_cycle_id = $2
          order by fingerprint`,
        [org, cycleId],
      )).rows;
    },
    async decisions() {
      return (await database.query<DecisionRow>(
        `select id, ordinal, review_cycle_id, decision, reason, head_sha,
                base_sha, policy_digest, failed_checks, blocking_fingerprints,
                limits
           from bakery.delivery_decisions
          where organization_id = $1 and run_id = $2 order by ordinal`,
        [org, run.id],
      )).rows;
    },
    async evidenceCounts() {
      const count = async (table: string, column: string, value: string) =>
        Number(
          (await database.query<{ count: string }>(
            `select count(*)::text as count from bakery.${table}
            where organization_id = $1 and ${column} = $2`,
            [org, value],
          )).rows[0].count,
        );
      const cycles = await count("review_cycles", "run_id", run.id);
      const decisions = await count("delivery_decisions", "run_id", run.id);
      const findings = Number(
        (await database.query<{ count: string }>(
          `select count(*)::text as count from bakery.review_findings finding
           join bakery.review_cycles cycle
             on cycle.organization_id = finding.organization_id
            and cycle.id = finding.review_cycle_id
          where cycle.organization_id = $1 and cycle.run_id = $2`,
          [org, run.id],
        )).rows[0].count,
      );
      return { cycles, findings, decisions };
    },
    async audits(operation, outcome) {
      return (await database.query<
        { outcome: string; details: Record<string, unknown> }
      >(
        `select outcome, details from bakery.audit_events
          where organization_id = $1 and operation = $2
            and ($3::text is null or outcome = $3)
          order by created_at, id`,
        [org, operation, outcome ?? null],
      )).rows;
    },
    sessionIds,
    async setLoopLimits(limits) {
      for (const [key, value] of Object.entries(limits)) {
        await database.query(
          `update bakery.workflow_runs
              set snapshot = jsonb_set(snapshot, array['reviewLoop', $3::text],
                                       to_jsonb($4::integer))
            where organization_id = $1 and id = $2`,
          [org, run.id, key, value],
        );
      }
    },
    async jobInput(stepId) {
      return await jobInput(stepId);
    },
    async close() {
      await engine.releaseEngineOwner(owner);
    },
  };
  return world;
}

/**
 * Runs `work` against a fresh reviewed run that has already finished
 * `implement` and the seed `check` (every command passing unless `seed` says
 * otherwise), and releases the engine owner afterwards.
 */
export async function withReviewedRun<T>(
  work: (world: LoopWorld, seeded: SeededChecks) => Promise<T>,
  options: {
    budgetLimitUsd?: string;
    maxUsd?: number;
    seed?: Readonly<Record<string, Outcome>>;
    /** Skip implement and the seed check, for a test that drives them itself. */
    bare?: boolean;
  } = {},
): Promise<T> {
  return await withLoopFixture(async (fixture) => {
    const world = await openLoopWorld(fixture, options);
    try {
      let seeded: SeededChecks = { stepId: "", rows: [] };
      if (options.bare !== true) {
        await world.implement(HEADS[0]);
        seeded = await world.check(0, HEADS[0], options.seed ?? {});
      }
      return await work(world, seeded);
    } finally {
      await world.close();
    }
  });
}
