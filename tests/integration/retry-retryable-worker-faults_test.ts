import { assert, assertEquals } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  claimAssignment,
  postWorkerResult,
  type RegisteredWorker,
  resultBody,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";
import {
  adminRequest,
  readExecutionState,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";

function fault(retryable: boolean, code = "CLAUDE_HARNESS_TIMEOUT") {
  return {
    type: "about:blank",
    title: "Harness timed out",
    status: 504,
    detail: "The harness hit its time limit.",
    code,
    requestId: crypto.randomUUID(),
    retryable,
  };
}

async function failAttempt(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  assignment: WorkerAssignment,
  retryable: boolean,
): Promise<Response> {
  return await postWorkerResult(
    fixture,
    worker,
    assignment,
    resultBody(assignment, { status: "failed", fault: fault(retryable) }),
    crypto.randomUUID(),
  );
}

async function lifecycle(
  fixture: WorkerFixture,
  job: { jobId: string; runId: string; taskId: string },
) {
  const row = (await fixture.pgDatabase.query<{
    jobStatus: string;
    runStatus: string;
    stepStatus: string;
    taskStatus: string;
    maxAttempts: number;
  }>(
    `select job.status as "jobStatus", run.status as "runStatus",
            step.status as "stepStatus", task.status as "taskStatus",
            job.max_attempts as "maxAttempts"
       from bakery.jobs job
       join bakery.run_steps step on step.id = job.run_step_id
       join bakery.workflow_runs run on run.id = step.run_id
       join bakery.tasks task on task.id = run.task_id
      where job.id = $1 and run.id = $2 and task.id = $3`,
    [job.jobId, job.runId, job.taskId],
  )).rows[0];
  assert(row !== undefined);
  return row;
}

async function jobEventCount(
  fixture: WorkerFixture,
  jobId: string,
  eventType: string,
): Promise<number> {
  return Number(
    (await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.domain_events
      where organization_id = $1 and aggregate_id = $2 and event_type = $3`,
      [fixture.organizationId, jobId, eventType],
    )).rows[0]?.count,
  );
}

async function intentStatuses(
  fixture: WorkerFixture,
  runId: string,
): Promise<string[]> {
  return (await fixture.pgDatabase.query<{ status: string }>(
    `select status from bakery.budget_action_intents
      where organization_id = $1 and run_id = $2`,
    [fixture.organizationId, runId],
  )).rows.map((row) => row.status);
}

Deno.test("a retryable fault on attempt 1 requeues the job under a new fence", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "retry-fault-attempt-one",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    assertEquals((await lifecycle(fixture, job)).maxAttempts, 3);
    const first = await claimAssignment(fixture, worker);
    assertEquals(first.jobId, job.jobId);
    const heldBefore = await intentStatuses(fixture, job.runId);

    const response = await failAttempt(fixture, worker, first, true);
    assertEquals(response.status, 200);

    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.job.status, "queued");
    assertEquals(
      BigInt(state.job.currentFence),
      BigInt(first.fence) + 1n,
    );
    assertEquals(state.attempts.map((attempt) => attempt.status), ["failed"]);
    assertEquals(await lifecycle(fixture, job), {
      jobStatus: "queued",
      runStatus: "running",
      stepStatus: "running",
      // The fixture seeds the task as queued; a retry must not fail it.
      taskStatus: "queued",
      maxAttempts: 3,
    });
    assert(await jobEventCount(fixture, job.jobId, "job.updated") > 0);
    assertEquals(await jobEventCount(fixture, job.jobId, "job.completed"), 0);
    // No usage was reported, so the budget hold survives for the re-claim.
    assertEquals(await intentStatuses(fixture, job.runId), heldBefore);
    assert(heldBefore.every((status) => status === "held"));

    const second = await claimAssignment(fixture, worker);
    assertEquals(second.jobId, job.jobId);
    // The requeue bumped the fence and the claim bumped it again.
    assertEquals(BigInt(second.fence), BigInt(first.fence) + 2n);
  }));

Deno.test("the third retryable timeout is terminal with the timeout reason", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "retry-fault-attempt-three",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const fences: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const assignment = await claimAssignment(fixture, worker);
      assertEquals(assignment.jobId, job.jobId);
      fences.push(assignment.fence);
      assertEquals(
        (await failAttempt(fixture, worker, assignment, true)).status,
        200,
      );
      const status = (await lifecycle(fixture, job)).jobStatus;
      assertEquals(status, attempt < 3 ? "queued" : "failed");
    }
    assertEquals(fences, ["1", "3", "5"]);

    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(
      state.attempts.map((attempt) => [attempt.fence, attempt.status]),
      [["1", "failed"], ["3", "failed"], ["5", "failed"]],
    );
    assertEquals(state.step.status, "failed");
    assertEquals(
      (state.step.error as { code?: string }).code,
      "CLAUDE_HARNESS_TIMEOUT",
    );
    assertEquals(await lifecycle(fixture, job), {
      jobStatus: "failed",
      runStatus: "failed",
      stepStatus: "failed",
      taskStatus: "failed",
      maxAttempts: 3,
    });

    const claimKey = crypto.randomUUID();
    const fourth = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: workerFixtureCapabilities,
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(fourth.status, 204);

    const attempts = await adminRequest(
      fixture,
      `/v1/jobs/${job.jobId}/attempts?taskId=${job.taskId}`,
      undefined,
      { method: "GET" },
    );
    assertEquals(attempts.status, 200);
    const page = await attempts.json() as {
      items: Array<{ outcome: { reasonCode: string | null } }>;
    };
    assertEquals(page.items.length, 3);
    for (const item of page.items) {
      assertEquals(item.outcome.reasonCode, "timeout");
    }
  }));

Deno.test("a non-retryable fault is terminal on attempt 1", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "retry-fault-non-retryable",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(
      (await failAttempt(fixture, worker, assignment, false)).status,
      200,
    );
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.attempts.length, 1);
    assertEquals(await lifecycle(fixture, job), {
      jobStatus: "failed",
      runStatus: "failed",
      stepStatus: "failed",
      taskStatus: "failed",
      maxAttempts: 3,
    });
  }));

Deno.test("a retryable fault with max_attempts 1 is terminal", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "retry-fault-single-attempt",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      { maxAttempts: 1 },
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(
      (await failAttempt(fixture, worker, assignment, true)).status,
      200,
    );
    assertEquals(await lifecycle(fixture, job), {
      jobStatus: "failed",
      runStatus: "failed",
      stepStatus: "failed",
      taskStatus: "failed",
      maxAttempts: 1,
    });
  }));

Deno.test("a retryable fault after a cancel request is not requeued", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "retry-fault-after-cancel",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    await fixture.pgDatabase.query(
      `update bakery.jobs set cancel_requested_at = current_timestamp
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.jobId],
    );
    const response = await failAttempt(fixture, worker, assignment, true);
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, "CANCEL_REQUESTED");
    assert((await lifecycle(fixture, job)).jobStatus !== "queued");
  }));

Deno.test("the workflow engine reads a requeued job after a retryable failure as not terminal", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "retry-fault-engine-read",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const key = {
      runId: job.runId,
      stepKey: "worker",
      iteration: 0,
      actionVersion: job.workflowVersionId,
    };
    const repository = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 3,
    });
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(
      (await failAttempt(fixture, worker, assignment, true)).status,
      200,
    );
    const state = await repository.read(key);
    assert(state !== undefined && state !== null);
    // The failed last attempt of a queued job is a retry, not the step end.
    assertEquals(state.terminalFailure, undefined);
    assertEquals(state.attempts, 1);
    assertEquals(state.liveAttempts, 0);
    assertEquals(state.admission?.terminal, false);
    assertEquals(state.admission?.jobId, job.jobId);
  }));

async function openOutput(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  assignment: WorkerAssignment,
): Promise<Response> {
  const protocolVersion = (await fixture.pgDatabase.query<{ version: number }>(
    `select protocol_version as version from bakery.worker_hosts where id = $1`,
    [worker.registration.workerHostId],
  )).rows[0]?.version;
  assert(protocolVersion !== undefined);
  return await workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/output-bindings`,
    {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: worker.registration.workerSessionGeneration,
    },
    {
      idempotencyKey: crypto.randomUUID(),
      headers: {
        "X-Bakery-Worker-Protocol-Version": String(protocolVersion),
      },
    },
  );
}

Deno.test("a retried attempt binds output to the stream the failed attempt left open", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "retry-fault-output-binding",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const first = await claimAssignment(fixture, worker);
    const opened = await openOutput(fixture, worker, first);
    assertEquals(opened.status, 200);
    const firstBinding = await opened.json() as { sessionId: string };

    // The worker leaves the stream open for a failure the server will retry.
    assertEquals((await failAttempt(fixture, worker, first, true)).status, 200);
    assertEquals((await lifecycle(fixture, job)).jobStatus, "queued");
    const stream = (await fixture.pgDatabase.query<{ closed: boolean }>(
      `select closed from bakery.session_output_streams where id = $1`,
      [firstBinding.sessionId],
    )).rows[0];
    assertEquals(stream?.closed, false);

    // The second attempt opens a new producer generation on the same stream.
    const second = await claimAssignment(fixture, worker);
    const reopened = await openOutput(fixture, worker, second);
    assertEquals(reopened.status, 200);
    const secondBinding = await reopened.json() as {
      sessionId: string;
      writerGeneration: string;
    };
    assertEquals(secondBinding.sessionId, firstBinding.sessionId);
    assertEquals(secondBinding.writerGeneration, "2");
  }));

Deno.test("a terminal retryable failure still closes the output stream", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "retry-fault-terminal-close",
    });
    await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    let sessionId = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const assignment = await claimAssignment(fixture, worker);
      const opened = await openOutput(fixture, worker, assignment);
      assertEquals(opened.status, 200);
      sessionId = (await opened.json() as { sessionId: string }).sessionId;
      assertEquals(
        (await failAttempt(fixture, worker, assignment, true)).status,
        200,
      );
    }
    const stream = (await fixture.pgDatabase.query<{
      closed: boolean;
      archive_failure: string | null;
    }>(
      `select closed, archive_failure from bakery.session_output_streams
        where id = $1`,
      [sessionId],
    )).rows[0];
    assertEquals(stream?.closed, true);
    // A close without finalization authority would lose the transcript and
    // record this failure; the terminal close must keep authority.
    assertEquals(stream?.archive_failure, null);
  }));
