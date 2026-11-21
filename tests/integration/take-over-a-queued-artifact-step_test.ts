import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
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
import { admitRepositoryExecutionJob } from "../../packages/persistence/src/repository-admission.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { reconcileBudgetLedger } from "../../apps/server/src/modules/work/budget-recovery.ts";
import { cancelQueuedJobsOfRun } from "../../apps/server/src/modules/execution/coordination.ts";
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
    // The job was never claimed, so the event names no attempt.
    assertEquals(events.rows[0].attemptId, null);

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

// #412 slice 3b: restart. The person gives a queued step one more attempt that
// starts fresh, with a note, and the step keeps its frozen agent and budget.

/** The run with `brief` completed by a person and `implement` admitted queued. */
async function queuedImplementStep(fixture: Fixture, label: string) {
  const s = await queuedBriefStep(fixture, label);
  const artifact = await artifactFor(fixture, s.taskId);
  const done = await takeOver(fixture, s.run.id, s.key.stepKey, {
    mode: "complete",
    artifactId: artifact.artifactId,
    versionId: artifact.versionId,
  });
  assertEquals(done.status, 201, await done.clone().text());
  const next = await s.workflow.findNext(s.run.id, s.owner);
  assert(next !== undefined, "the run has an implement step");
  const admitted = await s.workflow.admit(next, s.owner);
  assert(admitted.jobId, "the implement step is admitted with a job");
  return { ...s, implementKey: next, implementJobId: admitted.jobId };
}

const jobRow = async (fixture: Fixture, jobId: string) =>
  (await fixture.pgDatabase.query<{
    maxAttempts: number;
    checkpoints: unknown;
    stepNotes: string[] | null;
    agentVersionId: string | null;
    status: string;
  }>(
    `select max_attempts as "maxAttempts", current_checkpoints as checkpoints,
            input->'stepNotes' as "stepNotes",
            agent_version_id as "agentVersionId", status
       from bakery.jobs where id = $1`,
    [jobId],
  )).rows[0];

Deno.test("AC: a person restarts a queued step with a note: one more fresh attempt, same agent, note delivered", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "restart-ok");
    const before = await jobRow(fixture, s.implementJobId);
    // A checkpoint left by an earlier attempt must not carry into the restart.
    await fixture.pgDatabase.query(
      `update bakery.jobs set current_checkpoints = '[{"step":"old"}]'::jsonb
        where id = $1`,
      [s.implementJobId],
    );

    const response = await takeOver(fixture, s.run.id, s.implementKey.stepKey, {
      mode: "restart",
      note: "Start from the helper, not from scratch.",
      reason: "The first attempt went the wrong way.",
    });
    assertEquals(response.status, 201, await response.clone().text());

    const after = await jobRow(fixture, s.implementJobId);
    assertEquals(after.maxAttempts, before.maxAttempts + 1);
    assertEquals(after.checkpoints, []);
    assertEquals(after.agentVersionId, before.agentVersionId);
    assertEquals(after.status, "queued");
    assertEquals(after.stepNotes, ["Start from the helper, not from scratch."]);

    // The note is recorded and delivered to this job, so the integrity check
    // that admission and claim run still accepts the job.
    const delivered = await fixture.pgDatabase.query<{ body: string }>(
      `select note.body from bakery.run_step_note_deliveries delivery
         join bakery.run_step_notes note on note.id = delivery.note_id
        where delivery.job_id = $1`,
      [s.implementJobId],
    );
    assertEquals(delivered.rows.map((row) => row.body), [
      "Start from the helper, not from scratch.",
    ]);
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        admitRepositoryExecutionJob(
          transaction,
          fixture.organizationId,
          s.implementJobId,
          { enqueue: false },
        ),
    );

    const ledger = await fixture.pgDatabase.query<
      { mode: string; text: string; reason: string }
    >(
      `select detail->>'mode' as mode, text, reason
         from bakery.decisions_ledger
        where run_id = $1 and kind = 'takeover' and detail->>'mode' = 'restart'`,
      [s.run.id],
    );
    assertEquals(ledger.rows.length, 1);
    assertEquals(
      ledger.rows[0].text,
      "Start from the helper, not from scratch.",
    );
  }));

Deno.test("AC: a restart whose budget reservation is no longer held, or whose step has a live attempt, is refused by name and changes nothing", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "restart-refuse");
    const before = await jobRow(fixture, s.implementJobId);
    const unchanged = async () =>
      assertEquals(await jobRow(fixture, s.implementJobId), before);
    const restart = () =>
      takeOver(fixture, s.run.id, s.implementKey.stepKey, {
        mode: "restart",
        note: "Try again.",
      });

    // A job a worker holds is live.
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'running' where id = $1`,
      [s.implementJobId],
    );
    await refusedWith(await restart(), 409, "attempt_live");
    await fixture.pgDatabase.query(
      `update bakery.jobs set status = 'queued' where id = $1`,
      [s.implementJobId],
    );

    // The funded step's reservation was released: no unfunded attempt.
    await fixture.pgDatabase.query(
      `update bakery.budget_reservations set status = 'released'
        where id = (select installation_reservation_id from bakery.jobs
                     where id = $1)`,
      [s.implementJobId],
    );
    await refusedWith(await restart(), 409, "budget_not_reserved");
    await unchanged();
    const notes = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_step_notes where run_id = $1`,
      [s.run.id],
    );
    assertEquals(notes.rows[0].n, "0");
  }));

// A job canceled before any worker took it gives back what was held for it,
// on every path that cancels one. Each test starts from a real funded model
// job (`implement`, admitted queued) and reads the money back.

/** What is held for the job, and the run account's reserved total. */
async function held(fixture: Fixture, runId: string, jobId: string) {
  const reservation = await fixture.pgDatabase.query<
    { reservation: string; intent: string; reserved: string }
  >(
    `select reservation.status as reservation, intent.status as intent,
            (select reserved_usd::text from bakery.budget_accounts
              where scope = 'run' and run_id = $2) as reserved
       from bakery.jobs job
       join bakery.budget_reservations reservation
         on reservation.id = job.installation_reservation_id
       join bakery.budget_action_intents intent
         on intent.installation_reservation_id = job.installation_reservation_id
      where job.id = $1`,
    [jobId, runId],
  );
  return reservation.rows[0];
}

Deno.test("AC: taking over a queued step gives back its held budget in the same transaction", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "takeover-release");
    const before = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([before.reservation, before.intent], ["held", "held"]);
    assert(Number(before.reserved) > 0, "something is held for the step");

    // Label the funded job as an artifact action so the takeover accepts it;
    // the reservation under test is the real one admission made.
    await fixture.pgDatabase.query(
      `update bakery.jobs set action = 'rpi.design' where id = $1`,
      [s.implementJobId],
    );
    const artifact = await artifactFor(fixture, s.taskId);
    const response = await takeOver(
      fixture,
      s.run.id,
      s.implementKey.stepKey,
      {
        mode: "complete",
        artifactId: artifact.artifactId,
        versionId: artifact.versionId,
      },
    );
    assertEquals(response.status, 201, await response.clone().text());

    const after = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([after.reservation, after.intent], ["released", "released"]);
    assertEquals(Number(after.reserved), 0);
  }));

Deno.test("AC: canceling a run with a queued funded job gives back its held budget", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "cancel-release");
    const before = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([before.reservation, before.intent], ["held", "held"]);

    const response = await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/runs/${s.run.id}/controls`,
      { body: { action: "cancel" } },
    );
    assert(response.status < 300, await response.clone().text());

    const after = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([after.reservation, after.intent], ["released", "released"]);
    assertEquals(Number(after.reserved), 0);
  }));

Deno.test("AC: cancelQueuedJobsOfRun gives back the held budget of the queued jobs it cancels", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "queued-release");
    const before = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([before.reservation, before.intent], ["held", "held"]);

    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        cancelQueuedJobsOfRun(transaction, {
          organizationId: fixture.organizationId,
          runId: s.run.id,
          traceId: crypto.randomUUID().replaceAll("-", ""),
        }),
    );

    const after = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([after.reservation, after.intent], ["released", "released"]);
    assertEquals(Number(after.reserved), 0);
  }));

// The reviewer's two cases: cancelling a run must always succeed, and a
// takeover must not leave money held or release money that may be spent.

/** Makes the job's provider call look dispatched, so its release is in doubt. */
const looksDispatched = (fixture: Fixture, jobId: string) =>
  fixture.pgDatabase.query(
    `update bakery.provider_call_intents call
        set provider_call_id = 'dispatched-' || call.id::text
       from bakery.jobs job
      where job.id = $1
        and call.installation_reservation_id = job.installation_reservation_id`,
    [jobId],
  );

Deno.test("AC: canceling a run still succeeds when a job's reservation cannot be released, and leaves it held", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "cancel-unreleasable");
    await looksDispatched(fixture, s.implementJobId);

    const response = await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/runs/${s.run.id}/controls`,
      { body: { action: "cancel" } },
    );
    assert(response.status < 300, await response.clone().text());

    const run = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.workflow_runs where id = $1`,
      [s.run.id],
    );
    assertEquals(run.rows[0].status, "canceled");
    // Left for reconciliation, untouched by the failed attempt to release it.
    const after = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([after.reservation, after.intent], ["held", "held"]);
  }));

Deno.test("AC: canceling a run whose job's reservation is already released still succeeds", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "cancel-released");
    await fixture.pgDatabase.query(
      `update bakery.budget_action_intents set status = 'released'
        where installation_reservation_id = (
          select installation_reservation_id from bakery.jobs where id = $1)`,
      [s.implementJobId],
    );
    const response = await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/runs/${s.run.id}/controls`,
      { body: { action: "cancel" } },
    );
    assert(response.status < 300, await response.clone().text());
  }));

Deno.test("AC: a takeover refuses by name when releasing the job's budget is in doubt, and changes nothing", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "takeover-doubt");
    await fixture.pgDatabase.query(
      `update bakery.jobs set action = 'rpi.design' where id = $1`,
      [s.implementJobId],
    );
    await looksDispatched(fixture, s.implementJobId);
    const artifact = await artifactFor(fixture, s.taskId);

    await refusedWith(
      await takeOver(fixture, s.run.id, s.implementKey.stepKey, {
        mode: "complete",
        artifactId: artifact.artifactId,
        versionId: artifact.versionId,
      }),
      409,
      "budget_release_dispatch_ambiguous",
    );
    const job = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.jobs where id = $1`,
      [s.implementJobId],
    );
    assertEquals(job.rows[0].status, "queued");
    const after = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([after.reservation, after.intent], ["held", "held"]);
  }));

Deno.test("AC: a takeover of a retry-waiting job is refused while its reservation is unsettled, and goes through once it is", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "takeover-retry");
    await fixture.pgDatabase.query(
      `update bakery.jobs set action = 'rpi.design' where id = $1`,
      [s.implementJobId],
    );
    // One attempt already ended, so the job waits for a retry.
    const worker = await registeredWorker(fixture);
    await fixture.pgDatabase.query(
      `insert into bakery.job_attempts (
         organization_id, job_id, worker_host_id, worker_session_id,
         worker_session_generation, attempt_no, fence, lease_token_hash,
         lease_expires_at, status, ended_at
       ) select host.organization_id, $2, host.id, host.worker_session_id,
                host.worker_session_generation, 1, 1, 'lease',
                clock_timestamp() - interval '1 minute', 'failed',
                clock_timestamp() - interval '1 minute'
           from bakery.worker_hosts host
          where host.organization_id = $1 and host.id = $3`,
      [
        fixture.organizationId,
        s.implementJobId,
        worker.registration.workerHostId,
      ],
    );
    const artifact = await artifactFor(fixture, s.taskId);
    const body = {
      mode: "complete",
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
    };

    await refusedWith(
      await takeOver(fixture, s.run.id, s.implementKey.stepKey, body),
      409,
      "budget_unsettled",
    );
    const job = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.jobs where id = $1`,
      [s.implementJobId],
    );
    assertEquals(job.rows[0].status, "queued");

    // Once reconciliation has settled what the attempt spent, nothing is left
    // held and the takeover goes through.
    await fixture.pgDatabase.query(
      `update bakery.budget_reservations set status = 'settled'
        where id = (select installation_reservation_id from bakery.jobs
                     where id = $1)`,
      [s.implementJobId],
    );
    const response = await takeOver(
      fixture,
      s.run.id,
      s.implementKey.stepKey,
      body,
    );
    assertEquals(response.status, 201, await response.clone().text());
  }));

// The reaper: a canceled job's held reservation must not outlive the job. The
// cancel paths release at once what never ran; the budget reconciliation sweep
// releases the rest (apps/server/src/modules/work/budget-recovery.ts,
// reconcileBudgetLedger -> findCanceledJobReleaseCandidates).

/** The funded implement job, canceled by something that did not release it. */
async function canceledHeld(fixture: Fixture, label: string) {
  const s = await queuedImplementStep(fixture, label);
  await fixture.pgDatabase.query(
    `update bakery.jobs set status = 'canceled' where id = $1`,
    [s.implementJobId],
  );
  const before = await held(fixture, s.run.id, s.implementJobId);
  assertEquals([before.reservation, before.intent], ["held", "held"]);
  return s;
}

const expireReservation = (fixture: Fixture, jobId: string) =>
  fixture.pgDatabase.query(
    `update bakery.budget_reservations
        set expires_at = clock_timestamp() - interval '1 minute'
      where id = (select installation_reservation_id from bakery.jobs
                   where id = $1)`,
    [jobId],
  );

async function addAttempt(fixture: Fixture, jobId: string, status: string) {
  const worker = await registeredWorker(fixture);
  await fixture.pgDatabase.query(
    `insert into bakery.job_attempts (
       organization_id, job_id, worker_host_id, worker_session_id,
       worker_session_generation, attempt_no, fence, lease_token_hash,
       lease_expires_at, status
     ) select host.organization_id, $2, host.id, host.worker_session_id,
              host.worker_session_generation, 1, 1, 'lease',
              clock_timestamp() + interval '1 hour', $4
         from bakery.worker_hosts host
        where host.organization_id = $1 and host.id = $3`,
    [
      fixture.organizationId,
      jobId,
      worker.registration.workerHostId,
      status,
    ],
  );
}

Deno.test("AC: the sweep releases the held budget of a canceled job that never ran", () =>
  withFixture(async (fixture) => {
    const s = await canceledHeld(fixture, "sweep-unclaimed");
    const swept = await reconcileBudgetLedger(fixture.pgDatabase);
    assert(swept.releases >= 1, "the sweep released a reservation");
    const after = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([after.reservation, after.intent], ["released", "released"]);
    assertEquals(Number(after.reserved), 0);
  }));

Deno.test("AC: the sweep waits for the reservation to expire before releasing a canceled job that had an attempt", () =>
  withFixture(async (fixture) => {
    const s = await canceledHeld(fixture, "sweep-attempted");
    await addAttempt(fixture, s.implementJobId, "failed");

    await reconcileBudgetLedger(fixture.pgDatabase);
    const early = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([early.reservation, early.intent], ["held", "held"]);

    await expireReservation(fixture, s.implementJobId);
    await reconcileBudgetLedger(fixture.pgDatabase);
    const late = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([late.reservation, late.intent], ["released", "released"]);
    assertEquals(Number(late.reserved), 0);
  }));

Deno.test("AC: the sweep never releases a canceled job with a live attempt or a dispatched provider call", () =>
  withFixture(async (fixture) => {
    const live = await canceledHeld(fixture, "sweep-live");
    await addAttempt(fixture, live.implementJobId, "running");
    await expireReservation(fixture, live.implementJobId);

    const dispatched = await canceledHeld(fixture, "sweep-dispatched");
    await looksDispatched(fixture, dispatched.implementJobId);
    await expireReservation(fixture, dispatched.implementJobId);

    await reconcileBudgetLedger(fixture.pgDatabase);
    for (const s of [live, dispatched]) {
      const after = await held(fixture, s.run.id, s.implementJobId);
      assertEquals([after.reservation, after.intent], ["held", "held"]);
    }
  }));

Deno.test("AC: canceling a retry-waiting job that had an attempt leaves its reservation held for reconciliation", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "cancel-attempted");
    // One attempt already ended, so the job waits for a retry. That attempt may
    // have spent against the reservation, so the cancel path must not release it
    // as unspent: usage reconciliation (or the sweep, after expiry) settles it.
    await addAttempt(fixture, s.implementJobId, "failed");

    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        cancelQueuedJobsOfRun(transaction, {
          organizationId: fixture.organizationId,
          runId: s.run.id,
          traceId: crypto.randomUUID().replaceAll("-", ""),
        }),
    );

    const job = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.jobs where id = $1`,
      [s.implementJobId],
    );
    assertEquals(job.rows[0].status, "canceled");
    const after = await held(fixture, s.run.id, s.implementJobId);
    assertEquals([after.reservation, after.intent], ["held", "held"]);
    assert(Number(after.reserved) > 0, "the money is still held");
  }));

// qa2's finding: two restarts at once could append their notes to the job in
// job-lock order while the notes were stamped with their transaction start, so
// the job's stepNotes and its recorded deliveries disagreed and the job could
// never be admitted again.
Deno.test("AC: simultaneous restarts keep a job's notes and deliveries in the same order", () =>
  withFixture(async (fixture) => {
    const s = await queuedBriefStep(fixture, "restart-concurrent");
    const admit = () =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          admitRepositoryExecutionJob(
            transaction,
            fixture.organizationId,
            s.jobId,
            { enqueue: false },
          ),
      );
    for (let round = 0; round < 8; round++) {
      const pair = await Promise.all(
        ["a", "b"].map((side) =>
          takeOver(fixture, s.run.id, s.key.stepKey, {
            mode: "restart",
            note: `round ${round} ${side}`,
          })
        ),
      );
      for (const response of pair) {
        assertEquals(response.status, 201, await response.clone().text());
      }
      // The integrity check admission and claim run: stepNotes equal the
      // recorded deliveries, in order. A mismatch refuses the job for good.
      await admit();
    }
    const job = await fixture.pgDatabase.query<{ n: number }>(
      `select jsonb_array_length(input->'stepNotes') as n
         from bakery.jobs where id = $1`,
      [s.jobId],
    );
    assertEquals(job.rows[0].n, 16);
  }));

// qa2's second finding, settled as a documented rule: a funded job that has a
// finished attempt is not restartable while its reservation is held, because
// that attempt may already have spent against it; an unfunded job is.
Deno.test("AC: restart of a funded job with a finished attempt is refused budget_unsettled, and changes nothing", () =>
  withFixture(async (fixture) => {
    const s = await queuedImplementStep(fixture, "restart-funded-attempted");
    await addAttempt(fixture, s.implementJobId, "failed");
    const before = await jobRow(fixture, s.implementJobId);

    await refusedWith(
      await takeOver(fixture, s.run.id, s.implementKey.stepKey, {
        mode: "restart",
        note: "Try again.",
      }),
      409,
      "budget_unsettled",
    );
    assertEquals(await jobRow(fixture, s.implementJobId), before);
    const notes = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_step_notes where run_id = $1`,
      [s.run.id],
    );
    assertEquals(notes.rows[0].n, "0");
  }));

Deno.test("AC: restart of an unfunded job after an ended attempt gives it one more attempt and the note", () =>
  withFixture(async (fixture) => {
    const s = await queuedBriefStep(fixture, "restart-unfunded-attempted");
    await addAttempt(fixture, s.jobId, "failed");
    const before = await jobRow(fixture, s.jobId);

    const response = await takeOver(fixture, s.run.id, s.key.stepKey, {
      mode: "restart",
      note: "Use the brief template.",
    });
    assertEquals(response.status, 201, await response.clone().text());
    const after = await jobRow(fixture, s.jobId);
    assertEquals(after.maxAttempts, before.maxAttempts + 1);
    assertEquals(after.stepNotes, ["Use the brief template."]);
    assertEquals(after.checkpoints, []);
  }));
