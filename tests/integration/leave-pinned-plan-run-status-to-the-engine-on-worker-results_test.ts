import { assert, assertEquals } from "@std/assert";
import {
  readExecutionState,
  registeredWorker,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  type RegisteredWorker,
  resultBody,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";

// #30 E3b-1. A flat run's rows are all created at admission, so the worker
// result path may roll the run up from them: failed if any row failed,
// completed when every row is. A compiled-plan run creates rows on demand and
// treats a failed repeat iteration as an outcome, so for it only the engine,
// asking the interpreter, may finish the run. The marker is the `runtime`
// section of the run snapshot, the same test `planRuntimeFromSnapshot` makes.

const fault = () => ({
  type: "about:blank",
  title: "Harness timed out",
  status: 504,
  detail: "The harness hit its time limit.",
  code: "CLAUDE_HARNESS_TIMEOUT",
  requestId: crypto.randomUUID(),
  retryable: false,
});

type Seeded = {
  jobId: string;
  runId: string;
  taskId: string;
  sessionId: string;
};

async function seed(
  fixture: WorkerFixture,
  options: { plan: boolean; runStatus?: "queued" | "running" },
): Promise<
  Seeded & { assignment: WorkerAssignment; worker: RegisteredWorker }
> {
  const worker = await registeredWorker(fixture, {
    name: `e3b1-${crypto.randomUUID().slice(0, 8)}`,
  });
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await claimAssignment(fixture, worker);
  // A nonmodel fixture keeps this independent of live billing admission;
  // terminal ingestion resolves the persisted action.
  await fixture.pgDatabase.query(
    `update bakery.jobs set action = 'harness.implement'
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, assignment.jobId],
  );
  if (options.plan) {
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = snapshot || jsonb_build_object('runtime', '{}'::jsonb)
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.runId],
    );
  }
  if (options.runStatus) {
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set status = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.runId, options.runStatus],
    );
  }
  return { ...job, assignment, worker };
}

function post(
  fixture: WorkerFixture,
  seeded: Awaited<ReturnType<typeof seed>>,
  status: "completed" | "failed" | "canceled",
) {
  const { assignment, worker } = seeded;
  const body = {
    ...resultBody(assignment, {
      status,
      ...(status === "completed"
        ? {
          result: {
            headSha: "head",
            baseSha: "base",
            sessionId: seeded.sessionId,
            artifacts: [],
            claudeCodeVersion: "2.0.0",
            model: "claude",
            capabilities: ["git", "shell", "web", "model"],
            events: [],
            telemetry: { providerUsage: null, costUsd: null },
          },
        }
        : status === "failed"
        ? { fault: fault() }
        : {
          cancellation: {
            processExited: true,
            exitedAt: new Date().toISOString(),
            cleanupStatus: "complete",
          },
        }),
    }),
  };
  return workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/attempts/${assignment.attemptId}/result`,
    body,
    { idempotencyKey: crypto.randomUUID() },
  );
}

async function expectApplied(response: Response) {
  assertEquals(response.status, 200, await response.text());
}

async function taskStatus(fixture: WorkerFixture, taskId: string) {
  return (await fixture.pgDatabase.query<{ status: string }>(
    `select status from bakery.tasks where organization_id = $1 and id = $2`,
    [fixture.organizationId, taskId],
  )).rows[0]?.status;
}

Deno.test("a flat run still completes, with its task, when its only step completes", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seed(fixture, { plan: false });
    const response = await post(fixture, seeded, "completed");
    await expectApplied(response);
    const state = await readExecutionState(fixture.pgDatabase, seeded.jobId);
    assertEquals(state.step.status, "completed");
    assertEquals(state.run.status, "completed");
    assert(state.run.finishedAt !== null);
    assertEquals(await taskStatus(fixture, seeded.taskId), "completed");
  }));

Deno.test("a flat run still fails, with its task, when its only step fails", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seed(fixture, { plan: false });
    const response = await post(fixture, seeded, "failed");
    await expectApplied(response);
    const state = await readExecutionState(fixture.pgDatabase, seeded.jobId);
    assertEquals(state.step.status, "failed");
    assertEquals(state.run.status, "failed");
    assertEquals(await taskStatus(fixture, seeded.taskId), "failed");
  }));

for (const status of ["completed", "failed", "canceled"] as const) {
  Deno.test(`a pinned plan run stays running, with its task untouched, when a step ${status}`, () =>
    withWorkerFixture(async (fixture) => {
      const seeded = await seed(fixture, { plan: true, runStatus: "running" });
      const taskBefore = await taskStatus(fixture, seeded.taskId);
      const response = await post(fixture, seeded, status);
      await expectApplied(response);
      const state = await readExecutionState(fixture.pgDatabase, seeded.jobId);
      assertEquals(state.step.status, status);
      assertEquals(state.run.status, "running");
      assertEquals(state.run.finishedAt, null);
      assertEquals(await taskStatus(fixture, seeded.taskId), taskBefore);
    }));
}

Deno.test("a pinned plan run still moves from queued to running on its first result", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seed(fixture, { plan: true, runStatus: "queued" });
    const response = await post(fixture, seeded, "completed");
    await expectApplied(response);
    const state = await readExecutionState(fixture.pgDatabase, seeded.jobId);
    assertEquals(state.run.status, "running");
    assertEquals(state.run.finishedAt, null);
  }));

Deno.test("a late result for a plan run the engine already finished does not reopen or conflict", () =>
  withWorkerFixture(async (fixture) => {
    const seeded = await seed(fixture, { plan: true, runStatus: "running" });
    // The engine finished the run (for instance canceled it) while the
    // worker's report was in flight.
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set status = 'canceled', finished_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, seeded.runId],
    );
    const response = await post(fixture, seeded, "completed");
    await expectApplied(response);
    const state = await readExecutionState(fixture.pgDatabase, seeded.jobId);
    assertEquals(state.run.status, "canceled");
  }));
