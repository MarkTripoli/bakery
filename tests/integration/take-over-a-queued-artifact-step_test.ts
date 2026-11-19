import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  presetBudgetPolicy,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";

// #412 slice 3a. Chapter 25 section 9 (O20): a person becomes a step's
// completer. A step whose action produces an artifact, whose job is still
// queued with no live attempt, is completed with an artifact the person names;
// the server takes the digest from its own row, and the engine goes on to the
// next step. A live attempt is refused: the person stops it first.

type RunBody = { id: string };
type StepBody = {
  status: string;
  output: {
    artifact: { artifactId: string; versionId: string; sha256: string };
  };
};

const withFixture = <T>(work: Parameters<typeof withWorkerFixture<T>>[0]) =>
  withWorkerFixture(work, { env: presetBudgetEnv });
type Fixture = Parameters<Parameters<typeof withFixture>[0]>[0];

/** A started preset run whose first step (task.brief) is admitted and queued. */
async function queuedBriefStep(fixture: Fixture, label: string) {
  const agent = await seedFundedCodingAgent(fixture, fixture, label);
  const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
    agentVersionId: agent,
  });
  const task = await createPresetTask(fixture, fixture, repository);
  const run = await expectJson<RunBody>(
    await startPresetRun(fixture, fixture, task, repository),
    201,
  );
  const workflow = createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 1,
    budgetPolicy: presetBudgetPolicy,
  });
  const owner = await workflow.acquireEngineOwner(
    run.id,
    crypto.randomUUID(),
    60_000,
  );
  assert(owner);
  const key = await workflow.findNext(run.id, owner);
  assert(key !== undefined, "the run has a first step");
  const admission = await workflow.admit(key, owner);
  assert(admission.jobId, "the first step is admitted with a job");
  const taskId = (await fixture.pgDatabase.query<{ taskId: string }>(
    `select task_id as "taskId" from bakery.workflow_runs where id = $1`,
    [run.id],
  )).rows[0].taskId;
  return {
    run,
    key,
    owner,
    workflow,
    repository,
    jobId: admission.jobId,
    taskId,
  };
}

async function artifactFor(fixture: Fixture, taskId: string) {
  const artifact = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifacts (organization_id, task_id, artifact_type, name)
     values ($1, $2, 'brief', $3) returning id`,
    [fixture.organizationId, taskId, `taken-over-${crypto.randomUUID()}`],
  );
  const sha = "ab".repeat(32);
  const version = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_versions (
       organization_id, artifact_id, task_id, author_id, revision, content,
       sha256, size_bytes, media_type
     ) values ($1, $2, $3, $4, 1, $5, $6, 3, 'application/json')
     returning id`,
    [
      fixture.organizationId,
      artifact.rows[0].id,
      taskId,
      fixture.principalId,
      new Uint8Array([1, 2, 3]),
      sha,
    ],
  );
  return {
    artifactId: artifact.rows[0].id,
    versionId: version.rows[0].id,
    sha,
  };
}

async function refusedWith(
  response: Response,
  status: number,
  reason?: string,
) {
  assertEquals(response.status, status);
  const body = await response.json() as { code: string; reason?: string };
  if (reason !== undefined) assertEquals(body.reason, reason);
}

const takeOver = (
  fixture: Fixture,
  runId: string,
  stepKey: string,
  body: Record<string, unknown>,
) =>
  apiCall(
    fixture,
    fixture,
    "POST",
    `/v1/runs/${runId}/steps/${stepKey}/takeover`,
    { body },
  );

Deno.test("AC: a person completes a queued artifact step, and the engine goes on to the next step", () =>
  withFixture(async (fixture) => {
    const s = await queuedBriefStep(fixture, "takeover-ok");
    const artifact = await artifactFor(fixture, s.taskId);

    const response = await takeOver(fixture, s.run.id, s.key.stepKey, {
      mode: "complete",
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
      reason: "The agent was stuck; I wrote the brief.",
    });
    assertEquals(response.status, 201, await response.clone().text());
    const step = await response.json() as StepBody;
    assertEquals(step.status, "completed");
    // The digest is the server's own, not anything the caller sent.
    assertEquals(step.output.artifact, {
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
      sha256: artifact.sha,
    });

    const job = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.jobs where id = $1`,
      [s.jobId],
    );
    assertEquals(job.rows[0].status, "canceled");

    const ledger = await fixture.pgDatabase.query<
      { reason: string; decidedBy: string; stepKey: string }
    >(
      `select reason, decided_by as "decidedBy", detail->>'stepKey' as "stepKey"
         from bakery.decisions_ledger where run_id = $1 and kind = 'takeover'`,
      [s.run.id],
    );
    assertEquals(ledger.rows.length, 1);
    assertEquals(
      ledger.rows[0].reason,
      "The agent was stuck; I wrote the brief.",
    );
    assertEquals(ledger.rows[0].decidedBy, fixture.principalId);

    // The engine wakes on this event and reads the step rows.
    const events = await fixture.pgDatabase.query<
      { attemptId: string | null; status: string }
    >(
      `select payload->>'attemptId' as "attemptId", payload->>'status' as status
         from bakery.domain_events
        where event_type = 'job.completed' and aggregate_id = $1`,
      [s.jobId],
    );
    assertEquals(events.rows.length, 1);
    assertEquals(events.rows[0].status, "completed");

    const next = await s.workflow.findNext(s.run.id, s.owner);
    assert(next !== undefined, "the run has a next step");
    assertEquals(next.stepKey.endsWith("implement"), true);
  }));

Deno.test("AC: a step with a live attempt, another task's artifact or a non-artifact action is refused and nothing changes", () =>
  withFixture(async (fixture) => {
    const s = await queuedBriefStep(fixture, "takeover-refuse");
    const artifact = await artifactFor(fixture, s.taskId);
    const body = {
      mode: "complete",
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
    };
    const unchanged = async () => {
      const row = await fixture.pgDatabase.query<
        { stepStatus: string; jobStatus: string; ledger: string }
      >(
        `select step.status as "stepStatus", job.status as "jobStatus",
                (select count(*)::text from bakery.decisions_ledger
                  where run_id = $1 and kind = 'takeover') as ledger
           from bakery.run_steps step
           join bakery.jobs job on job.run_step_id = step.id
          where step.run_id = $1`,
        [s.run.id],
      );
      assertEquals(row.rows[0].ledger, "0");
      assertEquals(row.rows[0].jobStatus === "canceled", false);
      assertEquals(row.rows[0].stepStatus === "completed", false);
    };

    // A job a worker holds is live.
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'running' where id = $1`,
      [s.jobId],
    );
    await refusedWith(
      await takeOver(fixture, s.run.id, s.key.stepKey, body),
      409,
      "attempt_live",
    );
    await unchanged();

    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'queued' where id = $1`,
      [s.jobId],
    );

    // An artifact version that belongs to another task of the organization.
    const otherTask = await createPresetTask(fixture, fixture, s.repository, {
      title: "Another task",
    });
    const foreign = await artifactFor(fixture, otherTask.id);
    assertEquals(
      (await takeOver(fixture, s.run.id, s.key.stepKey, {
        mode: "complete",
        artifactId: foreign.artifactId,
        versionId: foreign.versionId,
      })).status,
      404,
    );
    await unchanged();

    // An action whose output is evidence the system attests, not an artifact.
    await fixture.pgDatabase.query(
      `update bakery.jobs set action = 'harness.implement' where id = $1`,
      [s.jobId],
    );
    await refusedWith(
      await takeOver(fixture, s.run.id, s.key.stepKey, body),
      409,
      "takeover_unsupported_action",
    );
    await unchanged();
  }));
