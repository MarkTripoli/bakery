import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  expireAndSupersedeAttempt,
  problemCode,
  readExecutionState,
  registeredWorker,
  seedEligibleJob,
  type WorkerFixture,
  workerRequest,
} from "../worker-execution.ts";
import { seedLegacyLeasedModelAttempt } from "../worker-execution/legacy-attempt.ts";
import { eventBody, resultBody } from "../worker-execution/scenarios.ts";
import {
  assertFinalizerRejects,
  type CheckReportFixture,
  type CheckScenario,
  type EvidenceRef,
  organizationCheckRunCount,
  type Outcome,
  publishEvidence,
  purgeEvidence,
  type Rejection,
  type ScenarioOptions,
  seedCheckScenario,
} from "./finalizer-fixture.ts";
import { withCheckFixture } from "./finalizer-integration-cases.ts";
import {
  COHERENCE_FORGERIES,
  ECHO_FORGERIES,
  EVIDENCE,
  EVIDENCE_FORGERIES,
  MAGIC,
  MISMATCH,
  POLICY,
  RULE_SCENARIO,
  SELECTION_FORGERIES,
  withObservation,
} from "./finalizer-forgeries.ts";
import { insertCheckRun, seedRun } from "./run-fixture.ts";

/**
 * Adversarial cases for the `quality.check` finalizer: every way a report can
 * disagree with what the server derived from its own pins is refused, and a
 * refusal writes nothing. Each case runs twice on one claimed job. The first
 * run calls the finalizer so the problem reason is visible (the HTTP problem
 * body only carries `code` for a validation failure); the second posts the
 * same report through the real worker route and proves the route answers 422,
 * stores no step output and records no row.
 */

type Honest = { report: CheckReportFixture; evidence: EvidenceRef[] };
type Case = {
  name: string;
  expected: Rejection;
  options?: ScenarioOptions;
  outcomes?: Record<string, Outcome>;
  /** Route problem code when the wire schema refuses it first. */
  routeCode?: string;
  /** Builds the hostile result from an honest report and the scenario. */
  forge(
    honest: Honest,
    scenario: CheckScenario,
  ): unknown | Promise<unknown>;
};

const PLAIN_RUN_CASE: Case = {
  name: "the policy digest of a run without the pinned rules",
  expected: MISMATCH,
  options: RULE_SCENARIO,
  forge: async ({ report }, scenario) => {
    const plain = await seedCheckScenario(scenario.fixture, {
      commands: MAGIC,
    });
    return { ...report, policyDigest: plain.pins.policyDigest };
  },
};

const ECHO_CASES: Case[] = [...ECHO_FORGERIES, PLAIN_RUN_CASE];

const EVIDENCE_CASES: Case[] = [
  ...EVIDENCE_FORGERIES,
  {
    name: "evidence of another job's run step",
    expected: EVIDENCE,
    forge: async ({ report }, scenario) => {
      const other = await seedCheckScenario(scenario.fixture);
      const foreign = await other.evidence("foreign-evidence.json");
      return withObservation(report, 0, {
        evidence: foreign,
        outputDigest: foreign.sha256,
      });
    },
  },
  {
    name:
      "evidence whose artifact belongs to another task but is attached to this run step",
    expected: EVIDENCE,
    forge: async ({ report }, scenario) => {
      const other = await seedCheckScenario(scenario.fixture);
      assertNotEquals(other.taskId, scenario.taskId);
      const mixed = await publishEvidence(scenario.fixture, {
        taskId: other.taskId,
        runStepId: scenario.job.runStepId,
        name: "other-task-evidence.json",
        text: "another task",
      });
      return withObservation(report, 0, {
        evidence: mixed,
        outputDigest: mixed.sha256,
      });
    },
  },
  {
    name: "evidence of the same task but no run step",
    expected: EVIDENCE,
    forge: async ({ report }, scenario) => {
      const stray = await publishEvidence(scenario.fixture, {
        taskId: scenario.taskId,
        runStepId: null,
        name: "stray-evidence.json",
        text: "stray",
      });
      return withObservation(report, 0, {
        evidence: stray,
        outputDigest: stray.sha256,
      });
    },
  },
  {
    name: "a digest that is not the stored content digest",
    expected: EVIDENCE,
    forge: ({ report }) => {
      const wrong = "f".repeat(64);
      return withObservation(report, 0, {
        evidence: { ...report.observations[0]!.evidence!, sha256: wrong },
        outputDigest: wrong,
      });
    },
  },
  {
    name: "a version that does not exist",
    expected: EVIDENCE,
    forge: ({ report }) =>
      withObservation(report, 0, {
        evidence: {
          ...report.observations[0]!.evidence!,
          versionId: crypto.randomUUID(),
        },
      }),
  },
  {
    name: "a version paired with another artifact",
    expected: EVIDENCE,
    forge: ({ report }) =>
      withObservation(report, 0, {
        evidence: {
          ...report.observations[0]!.evidence!,
          artifactId: crypto.randomUUID(),
        },
      }),
  },
  {
    name: "purged evidence",
    expected: EVIDENCE,
    forge: async ({ report }, scenario) => {
      await purgeEvidence(
        scenario.fixture,
        report.observations[0]!.evidence!.versionId,
      );
      return report;
    },
  },
];

const POLICY_CASES: Case[] = [
  {
    name: "a job input without a repository profile",
    expected: POLICY,
    options: {
      input: ({ repositoryProfile: _profile, ...rest }) => rest,
    },
    forge: ({ report }) => report,
  },
  {
    name: "a strict-v1 profile with no fixed policy",
    expected: POLICY,
    options: {
      context: () => ({
        ...({} as Record<string, unknown>),
        organizationId: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        repositoryId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        revision: 1,
        digest: "a".repeat(64),
        config: {
          schemaVersion: 1,
          workflow: { kind: "fixed" },
          branches: { base: "main", allowedPatterns: ["feature/*"] },
          worktree: { root: ".bakery/worktrees" },
        },
        observationId: null,
        observationDigest: null,
        baseSha: null,
      }),
    },
    forge: ({ report }) => report,
  },
  {
    name: "a fixed policy digest that no longer matches the policy",
    expected: POLICY,
    options: {
      context: (context) => ({ ...context, fixedPolicyDigest: "d".repeat(64) }),
    },
    forge: ({ report }) => report,
  },
  {
    name: "a profile digest that no longer matches the profile",
    expected: POLICY,
    options: {
      context: (context) => ({ ...context, digest: "d".repeat(64) }),
    },
    forge: ({ report }) => report,
  },
  {
    name: "a profile with no inspected base commit",
    expected: POLICY,
    options: { context: (context) => ({ ...context, baseSha: null }) },
    forge: ({ report }) => report,
  },
  {
    name: "pinned rules edited after admission",
    expected: POLICY,
    options: {
      ...RULE_SCENARIO,
      context: (context) => {
        const rules = context.repositoryRules!;
        return {
          ...context,
          repositoryRules: {
            ...rules,
            entries: rules.entries.map((entry) => ({
              ...entry,
              mode: "guide",
            })),
          },
        };
      },
    },
    forge: ({ report }) => report,
  },
  {
    name: "a revision that is a branch name",
    expected: POLICY,
    options: { input: (base) => ({ ...base, revision: "main" }) },
    forge: ({ report }) => report,
  },
  {
    name: "a revision that is not lowercase hex",
    expected: POLICY,
    options: { input: (base) => ({ ...base, revision: "A".repeat(40) }) },
    forge: ({ report }) => report,
  },
  {
    name: "a selection that repeats a command",
    expected: POLICY,
    options: {
      input: (base) => ({
        ...base,
        checks: ["unit", "unit", "lint", "format"],
      }),
    },
    forge: ({ report }) => report,
  },
  {
    name: "a selection that names a command outside the policy",
    expected: POLICY,
    options: { input: (base) => ({ ...base, checks: ["unit", "deploy"] }) },
    forge: ({ report }) => report,
  },
];

/**
 * A harness.implement job whose attempt is leased and has accepted its first
 * event, so the next call is its result at sequence 2. `harness` is the
 * smallest output that satisfies the action's output schema.
 */
async function leasedHarnessJob(fixture: WorkerFixture, name: string) {
  const worker = await registeredWorker(fixture, { name });
  const job = await seedEligibleJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await seedLegacyLeasedModelAttempt(
    fixture,
    worker,
    job.jobId,
  );
  const eventId = crypto.randomUUID();
  const accepted = await workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/events`,
    eventBody(assignment, eventId, "1"),
    { idempotencyKey: eventId },
  );
  assertEquals(accepted.status, 200);
  const harness = {
    headSha: "head",
    baseSha: "base",
    sessionId: job.sessionId,
    artifacts: [],
  };
  return { worker, job, assignment, harness };
}

/**
 * Runs one hostile report: the finalizer refuses it with the expected reason
 * and writes nothing, then the real route answers 422 and leaves the step,
 * the job and the attempt exactly as they were.
 */
async function assertRefused(entry: Case): Promise<void> {
  await withCheckFixture(async (fixture) => {
    const scenario = await seedCheckScenario(fixture, entry.options);
    const honest = await scenario.honest(entry.outcomes);
    const forged = await entry.forge(honest, scenario);
    const before = await scenario.state();
    await assertFinalizerRejects(scenario, forged, entry.expected);
    const response = await scenario.post(forged);
    assertEquals(response.status, 422, entry.name);
    assertEquals(
      await problemCode(response),
      entry.routeCode ?? entry.expected.code,
      entry.name,
    );
    assertEquals(await scenario.rows(), [], entry.name);
    assertEquals(await organizationCheckRunCount(fixture), 0, entry.name);
    assertEquals(await scenario.audits(), 0, entry.name);
    // A refusal the finalizer made is audited as denied with its code and
    // reason; one the wire schema made never reaches the finalizer.
    assertEquals(
      await scenario.deniedAudits(),
      entry.routeCode === undefined
        ? [{ code: entry.expected.code, reason: entry.expected.reason }]
        : [],
      entry.name,
    );
    assertEquals(await scenario.state(), before, entry.name);
  });
}

function registerRefusals(title: string, cases: readonly Case[]): void {
  // One database per group keeps the lane short; each case seeds its own job.
  Deno.test(title, async (test) => {
    for (const entry of cases) {
      await test.step(entry.name, () => assertRefused(entry));
    }
  });
}

export function registerFinalizerSecurityCases(): void {
  registerRefusals(
    "a report cannot establish success: echoed verdicts and foreign identities are refused",
    ECHO_CASES,
  );
  registerRefusals(
    "a report must name exactly the selected commands, once each, in order",
    SELECTION_FORGERIES,
  );
  registerRefusals(
    "an observation must be one a process or a missing tool can produce",
    COHERENCE_FORGERIES,
  );
  registerRefusals(
    "evidence must be an immutable artifact version of the reporting step",
    EVIDENCE_CASES,
  );
  registerRefusals(
    "a job without a usable fixed policy records nothing",
    POLICY_CASES,
  );

  Deno.test("a replayed checkRunId or a repeated (job, fence, check) cannot record", async () => {
    await withCheckFixture(async (fixture) => {
      const accepted = await seedCheckScenario(fixture);
      const first = await accepted.honest();
      await accepted.finalize(first.report);
      const acceptedRows = await accepted.rows();
      assertEquals(acceptedRows.length, 3);

      // Another job reusing an accepted row id is refused, and its other
      // observations are not written.
      const replayer = await seedCheckScenario(fixture);
      const forged = withObservation(
        (await replayer.honest()).report,
        1,
        { checkRunId: first.report.observations[0]!.checkRunId },
      );
      const ids = forged.observations.map(({ checkRunId }) => checkRunId);
      await assertFinalizerRejects(
        replayer,
        { ...forged, checkRunIds: ids },
        MISMATCH,
      );
      assertEquals((await accepted.rows()).length, 3);

      // A row the job already holds for the same check and fence blocks the
      // whole report, not only that observation.
      const repeated = await seedCheckScenario(fixture);
      await insertCheckRun(fixture.pgDatabase, {
        organizationId: repeated.organizationId,
        runId: repeated.job.runId,
        runStepId: repeated.job.runStepId,
        jobId: repeated.job.jobId,
        attemptId: repeated.assignment.attemptId,
        fence: repeated.assignment.fence,
        checkId: "lint",
      });
      const honest = (await repeated.honest()).report;
      let thrown: unknown;
      try {
        await repeated.finalize(honest);
      } catch (error) {
        thrown = error;
      }
      assert(thrown instanceof StandardError);
      assertEquals(thrown.params?.reason, MISMATCH.reason);
      assertEquals((await repeated.rows()).length, 1);
      const response = await repeated.post(honest);
      assertEquals(response.status, 422);
      assertEquals((await repeated.rows()).length, 1);
      assertEquals(await repeated.deniedAudits(), [MISMATCH]);
    });
  });

  Deno.test("a result from a superseded fence cannot record", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture);
      const { report } = await scenario.honest();
      await expireAndSupersedeAttempt(fixture.pgDatabase, scenario.job.jobId);
      const before = await scenario.state();
      const response = await scenario.post(report);
      assert(response.status >= 400, String(response.status));
      assertEquals(await problemCode(response), "LEASE_FENCED");
      assertEquals(await scenario.rows(), []);
      assertEquals(await scenario.audits(), 0);
      // The fence is refused before the report is read, so nothing is denied.
      assertEquals(await scenario.deniedAudits(), []);
      assertEquals(await scenario.state(), before);
    });
  });

  Deno.test("a harness.implement result cannot create check rows, whatever it claims", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture);
      const { report } = await scenario.honest();
      await scenario.finalize(report);
      const rows = await scenario.rows();
      assertEquals(rows.length, 3);

      const { worker, job, assignment, harness } = await leasedHarnessJob(
        fixture,
        "b1002-harness-forger",
      );
      const before = await readExecutionState(fixture.pgDatabase, job.jobId);
      const forgeries: Array<Record<string, unknown>> = [
        // A check report in place of the harness output.
        report,
        // A harness output that also claims check data it did not produce.
        { ...harness, checkRunIds: report.checkRunIds },
        { ...harness, allRequired: true },
        { ...harness, observations: report.observations },
      ];
      for (const [index, forgery] of forgeries.entries()) {
        const response = await workerRequest(
          fixture,
          worker.credential,
          `/v1/worker/attempts/${assignment.attemptId}/result`,
          resultBody(assignment, { localSeq: "2", result: forgery }),
          { idempotencyKey: crypto.randomUUID() },
        );
        assertEquals(response.status, 422, `forgery ${index}`);
        // The wire schema refuses a foreign shape; a valid check report
        // reaches the harness output schema and is refused there.
        assert(
          ["UNPROCESSABLE", "VALIDATION_FAILED"].includes(
            await problemCode(response),
          ),
          `forgery ${index}`,
        );
      }
      assertEquals(
        await readExecutionState(fixture.pgDatabase, job.jobId),
        before,
      );
      // Nothing was written for the harness job, and the rows of the real
      // check job are untouched.
      const harnessRows = await fixture.pgDatabase.query(
        "select 1 from bakery.check_runs where job_id = $1",
        [job.jobId],
      );
      assertEquals(harnessRows.rows.length, 0);
      assertEquals(
        (await scenario.rows()).map((row) => row.id),
        rows.map((row) => row.id),
      );
    });
  });

  Deno.test("a result may cite only check rows of its own run, not those of another run of the same task or of another task", async () => {
    await withCheckFixture(async (fixture) => {
      const { worker, job, assignment, harness } = await leasedHarnessJob(
        fixture,
        "b1002-harness-cross-run",
      );
      const owner = {
        organizationId: fixture.organizationId,
        principalId: fixture.principalId,
      };
      // A second run of the job's own task, and a run of another task.
      const siblingRunId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.workflow_runs
           (id, organization_id, task_id, workflow_version_id, requested_by,
            status, snapshot, budget_limit_usd)
         select $3, organization_id, task_id, workflow_version_id,
                requested_by, 'queued', snapshot, 0
           from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, job.runId, siblingRunId],
      );
      const otherTask = await seedRun(fixture.pgDatabase, owner);
      assertNotEquals(otherTask.taskId, job.taskId);
      const rowOf = (runId: string) =>
        insertCheckRun(fixture.pgDatabase, {
          organizationId: fixture.organizationId,
          runId,
        });
      const siblingRow = await rowOf(siblingRunId);
      const otherTaskRow = await rowOf(otherTask.runId);
      const ownRow = await rowOf(job.runId);

      // Harness output keeps free-form telemetry, and the reference check
      // looks for `checkRunIds` anywhere in a result.
      const cite = (checkRunId: string) => ({
        ...harness,
        telemetry: { checkRunIds: [checkRunId] },
      });
      const post = (result: Record<string, unknown>) =>
        workerRequest(
          fixture,
          worker.credential,
          `/v1/worker/attempts/${assignment.attemptId}/result`,
          resultBody(assignment, { localSeq: "2", result }),
          { idempotencyKey: crypto.randomUUID() },
        );
      const before = await readExecutionState(fixture.pgDatabase, job.jobId);
      for (
        const [name, id] of [
          ["another run of the same task", siblingRow],
          ["a run of another task", otherTaskRow],
        ] as const
      ) {
        const response = await post(cite(id));
        assertEquals(response.status, 404, name);
        assertEquals(await problemCode(response), "RESOURCE_NOT_FOUND", name);
        assertEquals(
          await readExecutionState(fixture.pgDatabase, job.jobId),
          before,
          name,
        );
      }

      // The same payload shape citing a row of the job's own run is accepted,
      // so the refusals above come from the run predicate alone.
      const accepted = await post(cite(ownRow));
      assertEquals(accepted.status, 200, await accepted.clone().text());
    });
  });

  Deno.test("a refused report leaves one denied audit entry naming the comparison, no row and the same job state, and the job can still finish", async () => {
    await withCheckFixture(async (fixture) => {
      const scenario = await seedCheckScenario(fixture);
      const { report } = await scenario.honest({ unit: "fail" });
      const before = await scenario.state();
      const forged = { ...report, allRequired: true, failedCheckIds: [] };

      const refused = await scenario.post(forged);
      assertEquals(refused.status, 422);
      const body = await refused.text();
      assertEquals(
        (JSON.parse(body) as { code: string }).code,
        "VALIDATION_FAILED",
      );
      // The worker still learns no more than the code.
      assert(!body.includes("check_output_mismatch"), body);
      assertEquals(await scenario.rows(), []);
      assertEquals(await organizationCheckRunCount(fixture), 0);
      assertEquals(await scenario.state(), before);
      assertEquals(await scenario.audits(), 0);
      // Exactly the code and the reason: no digest, no id, no worker text.
      assertEquals(await scenario.deniedAudits(), [MISMATCH]);
      const entry = await fixture.pgDatabase.query<{
        outcome: string;
        resource_type: string;
        resource_id: string;
      }>(
        `select outcome, resource_type, resource_id from bakery.audit_events
          where organization_id = $1 and operation = 'delivery.checkRuns.record'`,
        [fixture.organizationId],
      );
      assertEquals(entry.rows, [{
        outcome: "denied",
        resource_type: "job_attempt",
        resource_id: scenario.assignment.attemptId,
      }]);

      // The refusal consumed nothing: the honest report is still accepted,
      // writes its rows and one success entry, and the denied entry stays.
      const accepted = await scenario.post(report);
      assertEquals(accepted.status, 200, await accepted.clone().text());
      assertEquals((await scenario.rows()).length, 3);
      assertEquals(await scenario.audits(), 1);
      assertEquals(await scenario.deniedAudits(), [MISMATCH]);
      assertEquals((await scenario.state()).step.output, report);
    });
  });
}
