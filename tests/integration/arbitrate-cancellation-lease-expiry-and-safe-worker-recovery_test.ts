import { assert, assertEquals } from "@std/assert";
import { createAuthProvider } from "../../apps/server/src/modules/auth/index.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import { createBrowserSessionMiddleware } from "../../apps/server/src/modules/auth/middleware.ts";
import {
  createExecutionControlApp,
  createExecutionWorkerCleanupApp,
} from "../../apps/server/src/modules/execution/control.ts";
import { mainRouter } from "../../apps/server/src/main.ts";
import {
  claimAssignment,
  eventBody,
  heartbeatRequest,
  postWorkerEvent,
  postWorkerResult,
  type RegisteredWorker,
  resultBody,
  withWorkerFixture,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";
import { cancelRunWithoutAttempt } from "../../apps/server/src/modules/execution/coordination.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  adminRequest,
  closeWorkerScope,
  createWorkerScope,
  expireAndSupersedeAttempt,
  problemCode,
  readExecutionState,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";

import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { reclaimExpiredAttempts } from "../../packages/persistence/src/attempts.ts";
function controlAppForFixture(fixture: WorkerFixture) {
  const authStore = createPostgresAuthPersistence(
    fixture.runtimePgDatabase,
  );
  const auth = createAuthProvider({
    pgDatabase: fixture.runtimePgDatabase,
    config: fixture.config.auth!,
    persistence: authStore,
  });
  return createExecutionControlApp({
    database: fixture.runtimePgDatabase,
    browserSession: createBrowserSessionMiddleware({
      auth,
      store: authStore,
      publicBaseUrl: fixture.config.publicBaseUrl,
      trustedOrigins: [fixture.config.publicBaseUrl],
      secret: fixture.config.auth!.secret,
    }),
    publicBaseUrl: fixture.config.publicBaseUrl,
    secret: fixture.config.auth!.secret,
  });
}
function workerCleanupAppForFixture(fixture: WorkerFixture) {
  return createExecutionWorkerCleanupApp({
    database: fixture.runtimePgDatabase,
    publicBaseUrl: fixture.config.publicBaseUrl,
    secret: fixture.config.auth!.secret,
  });
}
Deno.test("production main dispatch reaches each composed app", async () => {
  const app = (status: number, code: string) => ({
    fetch: () => Response.json({ code }, { status }),
  });
  const handler = mainRouter({
    cleanup: app(401, "AUTH_REQUIRED"),
    control: app(403, "AUTH_FORBIDDEN"),
    app: app(404, "RESOURCE_NOT_FOUND"),
  });
  const cases: Array<[string, number, string]> = [
    ["/v1/worker/attempts/attempt/cleanup", 401, "AUTH_REQUIRED"],
    ["/v1/execution/attempts/attempt/control", 403, "AUTH_FORBIDDEN"],
    ["/v1/other", 404, "RESOURCE_NOT_FOUND"],
  ];
  for (const [pathname, status, code] of cases) {
    const response = await handler(
      new Request(`https://example.test${pathname}`),
      { remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 1 } },
    );
    assertEquals(response.status, status);
    assertEquals((await response.json()).code, code);
  }
});

Deno.test("canonical run control returns the documented Run projection", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-canonical-run-control",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, job.jobId);
    // An earlier harness step already completed with the base its worker
    // reported; the control response must project it like every other read.
    const workspaceBase = "c".repeat(40);
    const probeStepId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.run_steps (id, organization_id, run_id, step_key, position,
         iteration, status, input, output, finished_at)
       values ($1, $2, $3, 'workspace-base-probe', 99, 0, 'completed', '{}',
         $4::jsonb, clock_timestamp())`,
      [
        probeStepId,
        fixture.organizationId,
        job.runId,
        JSON.stringify({ baseSha: workspaceBase }),
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.jobs (id, organization_id, run_step_id, action, input,
         requirements, status, current_fence)
       values ($1, $2, $3, 'harness.implement', '{}', '{}', 'completed', 1)`,
      [crypto.randomUUID(), fixture.organizationId, probeStepId],
    );

    const response = await adminRequest(
      fixture,
      `/v1/runs/${job.runId}/controls`,
      { action: "cancel" },
      { idempotencyKey: "issue42-canonical-run-control-cancel" },
    );
    assertEquals(response.status, 201);
    const body = await response.json() as {
      id: string;
      status: string;
      commandType?: unknown;
      workspaceBaseSha?: unknown;
    };
    assertEquals(body.id, job.runId);
    assertEquals(body.status, "canceled");
    assertEquals(body.commandType, undefined);
    assertEquals(body.workspaceBaseSha, workspaceBase);
    const read = await adminRequest(
      fixture,
      `/v1/runs/${job.runId}`,
      undefined,
      { method: "GET" },
    );
    assertEquals(read.status, 200);
    assertEquals(
      (await read.json() as { workspaceBaseSha?: unknown }).workspaceBaseSha,
      body.workspaceBaseSha,
    );
  }));

Deno.test("two admitted control requests on one run each record their own event", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "e04-repeated-run-control",
    });
    // Pause and resume are admitted only for adapters that advertise steering.
    await fixture.pgDatabase.query(
      `update bakery.worker_hosts set adapter_capabilities = '["steer","follow_up"]'::jsonb
        where organization_id = $1`,
      [fixture.organizationId],
    );
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, job.jobId);
    for (const action of ["pause", "resume"]) {
      const response = await adminRequest(
        fixture,
        `/v1/runs/${job.runId}/controls`,
        { action },
        { idempotencyKey: `e04-repeated-run-control-${action}` },
      );
      assertEquals(response.status, 201, await response.clone().text());
    }
    const events = await fixture.pgDatabase.query<{ version: string }>(
      `select aggregate_version::text as version from bakery.domain_events
        where organization_id = $1 and aggregate_id = $2
          and event_type = 'run.control_requested'
        order by aggregate_version`,
      [fixture.organizationId, job.runId],
    );
    assertEquals(events.rows.length, 2);
    assert(events.rows[0].version !== events.rows[1].version);
  }));

async function runTerminalOrder(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  first: "cancel" | "success",
): Promise<void> {
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await claimAssignment(fixture, worker);
  assertEquals(assignment.jobId, job.jobId);
  const cancellation = resultBody(assignment, {
    status: "canceled",
    cancellation: {
      processExited: true,
      exitedAt: new Date().toISOString(),
      cleanupStatus: "complete",
    },
  });
  const success = resultBody(assignment, {
    status: "completed",
    result: {
      headSha: "head",
      baseSha: "base",
      sessionId: job.sessionId,
      artifacts: [],
    },
  });
  const bodies = first === "cancel"
    ? [cancellation, { ...success, localSeq: "2" }]
    : [success, { ...cancellation, localSeq: "2" }];
  const winnerResponse = await postWorkerResult(
    fixture,
    worker,
    assignment,
    bodies[0],
    crypto.randomUUID(),
  );
  const loserResponse = await postWorkerResult(
    fixture,
    worker,
    assignment,
    bodies[1],
    crypto.randomUUID(),
  );
  assertEquals(winnerResponse.status, 200);
  assertEquals(loserResponse.status, 409);
  assertEquals(await problemCode(loserResponse), "ALREADY_TERMINAL");
  const state = await readExecutionState(fixture.pgDatabase, job.jobId);
  assertEquals(state.attempts.length, 1);
  assertEquals(state.attempts[0].status, bodies[0].status);
  assertEquals(state.job.status, bodies[0].status);
}

async function runSimultaneousTerminalRace(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
): Promise<void> {
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await claimAssignment(fixture, worker);
  const preludeId = crypto.randomUUID();
  const prelude = await postWorkerEvent(
    fixture,
    worker,
    assignment,
    eventBody(assignment, preludeId),
    preludeId,
  );
  const preludeText = await prelude.text();
  assertEquals(prelude.status, 200, preludeText);
  const success = resultBody(assignment, {
    localSeq: "2",
    status: "completed",
    result: {
      headSha: "head",
      baseSha: "base",
      sessionId: job.sessionId,
      artifacts: [],
    },
  });
  const controlResponsePromise = controlAppForFixture(fixture).fetch(
    new Request(
      `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
          Cookie: fixture.adminCookie,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ action: "cancel" }),
      },
    ),
  );
  const resultResponsePromise = postWorkerResult(
    fixture,
    worker,
    assignment,
    success,
    crypto.randomUUID(),
  );
  const [controlResponse, resultResponse] = await Promise.all([
    controlResponsePromise,
    resultResponsePromise,
  ]);
  const resultWon = resultResponse.status === 200;
  assertEquals(resultWon ? controlResponse.status : resultResponse.status, 409);
  const loser = resultWon ? controlResponse : resultResponse;
  assertEquals(await problemCode(loser), "ALREADY_TERMINAL");
  assertEquals(resultWon || controlResponse.status === 202, true);
  const state = await readExecutionState(fixture.pgDatabase, job.jobId);
  assertEquals(state.attempts.length, 1);
  assertEquals(state.attempts[0].status, resultWon ? "completed" : "canceled");
  assertEquals(state.job.status, resultWon ? "completed" : "canceled");
}

Deno.test("durable terminal writes race through the API with one first winner", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-terminal-race",
    });
    await runTerminalOrder(fixture, worker, "cancel");
    await runTerminalOrder(fixture, worker, "success");
    await runSimultaneousTerminalRace(fixture, worker);
  }));
Deno.test(
  "canceled success result is rejected while cancellation is requested",
  () =>
    withWorkerFixture(async (fixture) => {
      const worker = await registeredWorker(fixture, {
        name: "issue42-cancel-requested-result",
      });
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      assertEquals(assignment.jobId, job.jobId);
      await fixture.pgDatabase.query(
        `update bakery.jobs
            set cancel_requested_at = current_timestamp,
                updated_at = current_timestamp,
                version = version + 1
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, job.jobId],
      );
      const success = await postWorkerResult(
        fixture,
        worker,
        assignment,
        resultBody(assignment, {
          localSeq: "1",
          status: "completed",
          result: {
            headSha: "head",
            baseSha: "base",
            sessionId: job.sessionId,
            artifacts: [],
          },
        }),
        crypto.randomUUID(),
      );
      assertEquals(success.status, 409);
      assertEquals(await problemCode(success), "CANCEL_REQUESTED");
    }),
);
Deno.test("superseded attempt rejects a stale terminal result target", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-superseded-target",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const staleAssignment = await claimAssignment(fixture, worker);
    await expireAndSupersedeAttempt(fixture.pgDatabase, job.jobId);
    const replacement = await claimAssignment(fixture, worker);
    assertEquals(replacement.jobId, job.jobId);
    assertEquals(replacement.attemptId === staleAssignment.attemptId, false);
    const staleResult = resultBody(staleAssignment, {
      status: "canceled",
      cancellation: {
        processExited: true,
        exitedAt: new Date().toISOString(),
        cleanupStatus: "complete",
      },
    });
    const response = await postWorkerResult(
      fixture,
      worker,
      staleAssignment,
      staleResult,
      crypto.randomUUID(),
    );
    assertEquals(response.status, 409);
    assertEquals(await problemCode(response), "LEASE_FENCED");
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.job.currentFence, replacement.fence);
    assertEquals(state.attempts.at(-1)?.id, replacement.attemptId);
  }));

Deno.test("accepted cancellation survives expired budget reclamation", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-cancelled-budget-reclaim",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    await fixture.pgDatabase.query(
      `update bakery.jobs
          set max_attempts = 1
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.jobId],
    );
    const controlApp = controlAppForFixture(fixture);
    const controlUrl =
      `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`;
    const cancellation = await controlApp.fetch(
      new Request(controlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
          "Cookie": fixture.adminCookie,
          "Idempotency-Key": "issue42-cancelled-budget-reclaim",
        },
        body: JSON.stringify({ action: "cancel" }),
      }),
    );
    const cancellationText = await cancellation.text();
    assertEquals(cancellation.status, 202, cancellationText);
    await fixture.pgDatabase.query(
      `update bakery.job_attempts
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, assignment.attemptId],
    );
    await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        reclaimExpiredAttempts(
          transaction,
          fixture.organizationId,
          undefined,
          null,
        ),
    );
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.job.status, "canceled");
    assertEquals(state.run.status, "canceled");
    assertEquals(state.step.status, "canceled");
    assertEquals(state.attempts[0].status, "canceled");
    assertEquals(state.attempts[0].result, {
      status: "canceled",
      cancellation: {
        processExited: false,
        exitedAt: null,
        cleanupStatus: "pending",
        terminationStatus: "pending",
      },
    });
  }));

Deno.test("worker-scoped resume survives terminal attempt state", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-terminal-worker-resume",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const terminal = await postWorkerResult(
      fixture,
      worker,
      assignment,
      resultBody(assignment, {
        status: "completed",
        result: {
          headSha: "head",
          baseSha: "base",
          sessionId: job.sessionId,
          artifacts: [],
        },
      }),
      crypto.randomUUID(),
    );
    assertEquals(terminal.status, 200);
    const controlApp = controlAppForFixture(fixture);
    const controlResponse = await controlApp.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
            "Cookie": fixture.adminCookie,
            "Idempotency-Key": "issue42-terminal-worker-resume",
          },
          body: JSON.stringify({ action: "resume" }),
        },
      ),
    );
    const controlText = await controlResponse.text();
    assertEquals(controlResponse.status, 202, controlText);
    const command = JSON.parse(controlText) as {
      payload: Record<string, unknown>;
    };
    assertEquals(command.payload.controlScope, "worker");
    assertEquals(command.payload.workerHostId, assignment.workerHostId);
    assertEquals(command.payload.workerSessionId, assignment.workerSessionId);
    assertEquals(
      command.payload.workerSessionGeneration,
      String(assignment.workerSessionGeneration),
    );
    const heartbeat = await heartbeatRequest(fixture, worker);
    assertEquals(heartbeat.status, 200);
    const body = await heartbeat.json() as {
      pendingCommands: Array<{
        commandType: string;
        payload: Record<string, unknown>;
      }>;
    };
    assertEquals(
      body.pendingCommands.map(({ commandType, payload }) => ({
        commandType,
        payload,
      })),
      [{
        commandType: "follow_up",
        payload: {
          controlAction: "resume",
          controlScope: "worker",
          workerHostId: assignment.workerHostId,
          workerSessionId: assignment.workerSessionId,
          workerSessionGeneration: String(assignment.workerSessionGeneration),
          fence: String(assignment.fence),
        },
      }],
    );
  }));

Deno.test("blocked lifecycle cancellation preserves blocked parents", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-blocked-lifecycle",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set status = 'blocked'
        where organization_id = $1
          and id = (
            select run_step_id
              from bakery.jobs
             where organization_id = $1 and id = $2
          )`,
      [fixture.organizationId, job.jobId],
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set status = 'blocked'
        where organization_id = $1
          and id = (
            select step.run_id
              from bakery.jobs as job
              join bakery.run_steps as step
                on step.organization_id = job.organization_id
               and step.id = job.run_step_id
             where job.organization_id = $1 and job.id = $2
          )`,
      [fixture.organizationId, job.jobId],
    );
    await fixture.pgDatabase.query(
      `update bakery.tasks
          set status = 'blocked'
        where organization_id = $1
          and id = (
            select run.task_id
              from bakery.jobs as job
              join bakery.run_steps as step
                on step.organization_id = job.organization_id
               and step.id = job.run_step_id
              join bakery.workflow_runs as run
                on run.organization_id = step.organization_id
               and run.id = step.run_id
             where job.organization_id = $1 and job.id = $2
          )`,
      [fixture.organizationId, job.jobId],
    );
    const controlApp = controlAppForFixture(fixture);
    const response = await controlApp.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
            "Cookie": fixture.adminCookie,
            "Idempotency-Key": "issue42-blocked-lifecycle-cancel",
          },
          body: JSON.stringify({ action: "cancel" }),
        },
      ),
    );
    assertEquals(response.status, 202);
    const command = await response.json() as { commandType: string };
    assertEquals(command.commandType, "cancel");
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.attempts[0].status, "canceled");
    assertEquals(state.step.status, "blocked");
    assertEquals(state.run.status, "blocked");
    const task = await fixture.pgDatabase.query<{ status: string }>(
      `select task.status
         from bakery.tasks as task
         join bakery.workflow_runs as run
           on run.organization_id = task.organization_id
          and run.task_id = task.id
         join bakery.run_steps as step
           on step.organization_id = run.organization_id
          and step.run_id = run.id
         join bakery.jobs as job
           on job.organization_id = step.organization_id
          and job.run_step_id = step.id
        where job.organization_id = $1 and job.id = $2`,
      [fixture.organizationId, job.jobId],
    );
    assertEquals(task.rows[0]?.status, "blocked");
  }));

const SUPPORTED_CONTROL_ACTIONS = [
  ["pause", "steer"],
  ["interrupt", "steer"],
  ["resume", "follow_up"],
  ["cancel", "cancel"],
] as const;

type ControlScenario = {
  worker: RegisteredWorker;
  job: { jobId: string };
  assignment: WorkerAssignment;
  controlApp: {
    fetch(request: Request): Response | Promise<Response>;
  };
  controlUrl: string;
};

async function createControlScenario(
  fixture: WorkerFixture,
  name: string,
): Promise<ControlScenario> {
  const worker = await registeredWorker(fixture, { name });
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const assignment = await claimAssignment(fixture, worker);
  assertEquals(assignment.jobId, job.jobId);
  return {
    worker,
    job,
    assignment,
    controlApp: controlAppForFixture(fixture),
    controlUrl:
      `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`,
  };
}

async function postControl(
  fixture: WorkerFixture,
  scenario: ControlScenario,
  body: Record<string, string>,
  idempotencyKey: string,
): Promise<Response> {
  return await scenario.controlApp.fetch(
    new Request(scenario.controlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  );
}

Deno.test("control producer enforces authentication, schema, size, and RBAC", () =>
  withWorkerFixture(async (fixture) => {
    const scenario = await createControlScenario(
      fixture,
      "issue42-control-authentication",
    );
    const before = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count
         from bakery.worker_commands
        where organization_id = $1 and attempt_id = $2`,
      [fixture.organizationId, scenario.assignment.attemptId],
    );
    const unauthenticated = await scenario.controlApp.fetch(
      new Request(scenario.controlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
        },
        body: JSON.stringify({ action: "pause" }),
      }),
    );
    assertEquals(unauthenticated.status, 401);
    assertEquals(await problemCode(unauthenticated), "AUTH_REQUIRED");
    const after = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count
         from bakery.worker_commands
        where organization_id = $1 and attempt_id = $2`,
      [fixture.organizationId, scenario.assignment.attemptId],
    );
    assertEquals(after.rows[0]?.count, before.rows[0]?.count);

    const malformed = await postControl(
      fixture,
      scenario,
      { action: "pause", unexpected: "true" },
      "issue42-control-malformed",
    );
    assertEquals(malformed.status, 422);
    assertEquals(await problemCode(malformed), "UNPROCESSABLE");
    const oversized = await postControl(
      fixture,
      scenario,
      { action: "pause", reason: "x".repeat(600_000) },
      "issue42-control-oversized",
    );
    assertEquals(oversized.status, 413);
    assertEquals(await problemCode(oversized), "BODY_TOO_LARGE");

    const grant = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.permission_grants (
         organization_id,
         principal_id,
         capability,
         granted_by_principal_id,
         policy_revision
       ) values ($1, $2, 'workers.enroll', $2, 1)
       returning id`,
      [fixture.organizationId, fixture.principalId],
    );
    try {
      await fixture.pgDatabase.query(
        `update bakery.organization_memberships
            set role = 'developer',
                updated_at = current_timestamp,
                version = version + 1
          where organization_id = $1 and principal_id = $2`,
        [fixture.organizationId, fixture.principalId],
      );
      const enrollmentOnly = await postControl(
        fixture,
        scenario,
        { action: "pause" },
        "issue42-control-enrollment-only",
      );
      assertEquals(enrollmentOnly.status, 403);
      assertEquals(await problemCode(enrollmentOnly), "AUTH_FORBIDDEN");
      await fixture.pgDatabase.query(
        "delete from bakery.permission_grants where id = $1",
        [grant.rows[0]?.id],
      );
      const developerOnly = await postControl(
        fixture,
        scenario,
        { action: "pause" },
        "issue42-control-developer-only",
      );
      assertEquals(developerOnly.status, 403);
      assertEquals(await problemCode(developerOnly), "AUTH_FORBIDDEN");
    } finally {
      await fixture.pgDatabase.query(
        `update bakery.organization_memberships
            set role = 'admin',
                updated_at = current_timestamp,
                version = version + 1
          where organization_id = $1 and principal_id = $2`,
        [fixture.organizationId, fixture.principalId],
      );
      if (grant.rows[0]) {
        await fixture.pgDatabase.query(
          "delete from bakery.permission_grants where id = $1",
          [grant.rows[0].id],
        );
      }
    }
  }));

Deno.test("control producer serializes worker and operator commands", () =>
  withWorkerFixture(async (fixture) => {
    const scenario = await createControlScenario(
      fixture,
      "issue42-control-lock-order",
    );
    const concurrent = await Promise.all([
      postControl(
        fixture,
        scenario,
        { action: "interrupt", reason: "operator" },
        "issue42-control-lock-worker",
      ),
      heartbeatRequest(fixture, scenario.worker, {
        activeAttemptIds: [scenario.assignment.attemptId],
      }),
    ]);
    assertEquals(
      concurrent.map((response) => response.status).sort((a, b) => a - b),
      [200, 202],
    );
    for (const [action, commandType] of SUPPORTED_CONTROL_ACTIONS) {
      const response = await postControl(
        fixture,
        scenario,
        { action, reason: "operator" },
        `issue42-control-${action}`,
      );
      const responseText = await response.text();
      assertEquals(response.status, 202, responseText);
      const command = JSON.parse(responseText) as {
        commandType: string;
        payload: unknown;
      };
      assertEquals(command.commandType, commandType);
      assertEquals(command.payload, {
        controlAction: action,
        controlScope: action === "resume" ? "worker" : "attempt",
        reason: "operator",
        workerHostId: scenario.assignment.workerHostId,
        workerSessionId: scenario.assignment.workerSessionId,
        workerSessionGeneration: String(
          scenario.assignment.workerSessionGeneration,
        ),
        fence: String(scenario.assignment.fence),
      });
      if (action === "pause") {
        const replay = await postControl(
          fixture,
          scenario,
          { action, reason: "operator" },
          `issue42-control-${action}`,
        );
        assertEquals(replay.status, 202);
        assertEquals(await replay.json(), command);
        const mismatch = await postControl(
          fixture,
          scenario,
          { action, reason: "different" },
          `issue42-control-${action}`,
        );
        assertEquals(mismatch.status, 422);
        assertEquals(
          await problemCode(mismatch),
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
        );
      }
    }
  }));

Deno.test("control cancellation cascades and accepts attested cleanup", () =>
  withWorkerFixture(async (fixture) => {
    const scenario = await createControlScenario(
      fixture,
      "issue42-control-lifecycle",
    );
    const cancellation = await postControl(
      fixture,
      scenario,
      { action: "cancel" },
      "issue42-control-lifecycle-cancel",
    );
    assertEquals(cancellation.status, 202);
    const cancellationMarker = await fixture.pgDatabase.query<{
      cancelRequestedAt: string | null;
    }>(
      `select cancel_requested_at as "cancelRequestedAt"
         from bakery.jobs
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, scenario.job.jobId],
    );
    assertEquals(cancellationMarker.rows.length, 1);
    const cancelRequestedAt = cancellationMarker.rows[0]?.cancelRequestedAt;
    assertEquals(cancelRequestedAt !== null, true);
    assertEquals(Number.isFinite(Date.parse(String(cancelRequestedAt))), true);
    const terminalCancellation = await postControl(
      fixture,
      scenario,
      { action: "cancel" },
      "issue42-control-lifecycle-terminal",
    );
    assertEquals(terminalCancellation.status, 409);
    assertEquals(await problemCode(terminalCancellation), "ALREADY_TERMINAL");
    const lifecycle = await fixture.pgDatabase.query<{
      jobStatus: string;
      stepStatus: string;
      runStatus: string;
      taskStatus: string;
      eventTypes: string[];
    }>(
      `select job.status as "jobStatus",
              step.status as "stepStatus",
              run.status as "runStatus",
              task.status as "taskStatus",
              coalesce(array_agg(distinct event.event_type order by event.event_type)
                filter (where event.event_type in
                  ('job.completed', 'job.updated', 'run.updated', 'tasks.updated')), '{}')
                as "eventTypes"
         from bakery.jobs as job
         join bakery.run_steps as step
           on step.organization_id = job.organization_id
          and step.id = job.run_step_id
         join bakery.workflow_runs as run
           on run.organization_id = step.organization_id
          and run.id = step.run_id
         join bakery.tasks as task
           on task.organization_id = run.organization_id
          and task.id = run.task_id
         left join bakery.domain_events as event
           on event.organization_id = job.organization_id
          and event.aggregate_id in (job.id, run.id, task.id)
        where job.organization_id = $1 and job.id = $2
        group by job.status, step.status, run.status, task.status`,
      [fixture.organizationId, scenario.job.jobId],
    );
    assertEquals(lifecycle.rows[0], {
      jobStatus: "canceled",
      stepStatus: "canceled",
      runStatus: "canceled",
      taskStatus: "canceled",
      eventTypes: [
        "job.completed",
        "job.updated",
        "run.updated",
        "tasks.updated",
      ],
    });
    const evidence = {
      fence: scenario.assignment.fence,
      workerSessionId: scenario.worker.registration.workerSessionId,
      workerSessionGeneration: String(
        scenario.worker.registration.workerSessionGeneration,
      ),
      observedByWorkerSessionId: scenario.worker.registration.workerSessionId,
      observedByWorkerSessionGeneration: String(
        scenario.worker.registration.workerSessionGeneration,
      ),
      exitedAt: new Date().toISOString(),
    };
    const adminCleanup = await scenario.controlApp.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/execution/attempts/${scenario.assignment.attemptId}/cleanup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
            Cookie: fixture.adminCookie,
          },
          body: JSON.stringify(evidence),
        },
      ),
    );
    assertEquals(adminCleanup.status, 404);
    assertEquals(await problemCode(adminCleanup), "RESOURCE_NOT_FOUND");
    const cleanupApp = workerCleanupAppForFixture(fixture);
    const cleanupPath =
      `/v1/worker/attempts/${scenario.assignment.attemptId}/cleanup`;
    const cleanup = await cleanupApp.fetch(
      new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${scenario.worker.credential}`,
          "Content-Type": "application/json",
          "X-Bakery-Worker-Protocol-Version": "2",
        },
        body: JSON.stringify(evidence),
      }),
    );
    assertEquals(cleanup.status, 200);
    const cleanupBody = await cleanup.json() as {
      cancellation: {
        cleanupStatus: string;
        terminationStatus: string;
        processExited: boolean;
        exitedAt: string;
        cleanupObserver: {
          observedBy: {
            workerSessionId: string;
            workerSessionGeneration: string;
          };
          attestedBy: {
            workerSessionId: string;
            workerSessionGeneration: string;
          };
        };
      };
    };
    assertEquals(cleanupBody.cancellation.cleanupStatus, "complete");
    assertEquals(cleanupBody.cancellation.terminationStatus, "confirmed");
    assertEquals(cleanupBody.cancellation.processExited, true);
    assertEquals(cleanupBody.cancellation.exitedAt, evidence.exitedAt);
    assertEquals(
      cleanupBody.cancellation.cleanupObserver.observedBy.workerSessionId,
      evidence.observedByWorkerSessionId,
    );
    assertEquals(
      cleanupBody.cancellation.cleanupObserver.attestedBy.workerSessionId,
      evidence.workerSessionId,
    );
    const staleCleanup = await cleanupApp.fetch(
      new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${scenario.worker.credential}`,
          "Content-Type": "application/json",
          "X-Bakery-Worker-Protocol-Version": "2",
        },
        body: JSON.stringify({
          ...evidence,
          fence: String(BigInt(scenario.assignment.fence) + 1n),
        }),
      }),
    );
    assertEquals(staleCleanup.status, 409);
    assertEquals(await problemCode(staleCleanup), "STATE_CONFLICT");
  }));

Deno.test("heartbeat returns the exact pending control command set", () =>
  withWorkerFixture(async (fixture) => {
    const scenario = await createControlScenario(
      fixture,
      "issue42-control-heartbeat",
    );
    for (const [action] of SUPPORTED_CONTROL_ACTIONS) {
      const response = await postControl(
        fixture,
        scenario,
        { action, reason: "operator" },
        `issue42-heartbeat-control-${action}`,
      );
      assertEquals(response.status, 202);
    }
    const heartbeat = await heartbeatRequest(fixture, scenario.worker, {
      activeAttemptIds: [scenario.assignment.attemptId],
    });
    const body = await heartbeat.json() as {
      pendingCommands: Array<{
        commandType: string;
        payload: unknown;
      }>;
    };
    const actual = body.pendingCommands.map((command) => [
      command.commandType,
      command.payload,
    ]).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
    const expected = SUPPORTED_CONTROL_ACTIONS.map(([action, commandType]) => [
      commandType,
      {
        controlAction: action,
        controlScope: action === "resume" ? "worker" : "attempt",
        reason: "operator",
        workerHostId: scenario.assignment.workerHostId,
        workerSessionId: scenario.assignment.workerSessionId,
        workerSessionGeneration: String(
          scenario.assignment.workerSessionGeneration,
        ),
        fence: String(scenario.assignment.fence),
      },
    ]).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
    assertEquals(actual, expected);
  }));
Deno.test("cleanup replays after session rotation without lock interleaving", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-cleanup-rotation",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, job.jobId);
    if (
      !worker.registration.workerSessionId ||
      worker.registration.workerSessionGeneration === undefined
    ) throw new Error("WORKER_SESSION_MISSING");
    const oldSessionId = worker.registration.workerSessionId;
    const oldSessionGeneration = String(
      worker.registration.workerSessionGeneration,
    );
    const controlApp = controlAppForFixture(fixture);
    const cancellation = await controlApp.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
            "Cookie": fixture.adminCookie,
            "Idempotency-Key": "issue42-cleanup-rotation-cancel",
          },
          body: JSON.stringify({ action: "cancel" }),
        },
      ),
    );
    assertEquals(cancellation.status, 202);
    const cleanupPath = `/v1/worker/attempts/${assignment.attemptId}/cleanup`;
    const cleanupApp = workerCleanupAppForFixture(fixture);
    const cleanupRequest = (evidence: Record<string, string>) =>
      cleanupApp.fetch(
        new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${worker.credential}`,
            "Content-Type": "application/json",
            "X-Bakery-Worker-Protocol-Version": "2",
          },
          body: JSON.stringify(evidence),
        }),
      );
    const exitedAt = new Date().toISOString();
    const firstEvidence = {
      fence: assignment.fence,
      workerSessionId: oldSessionId,
      workerSessionGeneration: oldSessionGeneration,
      observedByWorkerSessionId: oldSessionId,
      observedByWorkerSessionGeneration: oldSessionGeneration,
      exitedAt,
    };
    const firstCleanup = await cleanupRequest(firstEvidence);
    assertEquals(firstCleanup.status, 200);
    const firstCleanupBody = await firstCleanup.json();
    const rotatedSessionId = crypto.randomUUID();
    const rotatedSessionGeneration = (BigInt(oldSessionGeneration) + 1n)
      .toString();
    await fixture.pgDatabase.query(
      `update bakery.worker_hosts
          set worker_session_id = $1,
              worker_session_generation = $2
        where organization_id = $3
          and id = $4`,
      [
        rotatedSessionId,
        rotatedSessionGeneration,
        fixture.organizationId,
        worker.registration.workerHostId,
      ],
    );
    worker.registration.workerSessionId = rotatedSessionId;
    worker.registration.workerSessionGeneration = rotatedSessionGeneration;
    const replayEvidence = {
      fence: assignment.fence,
      workerSessionId: rotatedSessionId,
      workerSessionGeneration: rotatedSessionGeneration,
      observedByWorkerSessionId: oldSessionId,
      observedByWorkerSessionGeneration: oldSessionGeneration,
      exitedAt,
    };
    const responses = await Promise.race([
      Promise.all([
        cleanupRequest(replayEvidence),
        cleanupRequest(replayEvidence),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("CLEANUP_INTERLEAVING_TIMEOUT")),
          5_000,
        )
      ),
    ]);
    assertEquals(responses.map((response) => response.status), [200, 200]);
    const replayBodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    assertEquals(replayBodies[0], firstCleanupBody);
    assertEquals(replayBodies[1], firstCleanupBody);
    const oldAuthority = await cleanupRequest(firstEvidence);
    assertEquals(oldAuthority.status, 409);
    assertEquals(await problemCode(oldAuthority), "STATE_CONFLICT");
  }));
Deno.test(
  "cleanup rejects a same-org different-host identical session tuple",
  () =>
    withWorkerFixture(async (fixture) => {
      const worker = await registeredWorker(fixture, {
        name: "issue42-cleanup-owner",
      });
      const otherWorker = await registeredWorker(fixture, {
        name: "issue42-cleanup-other-host",
      });
      const job = await seedFundedModelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const assignment = await claimAssignment(fixture, worker);
      assertEquals(assignment.jobId, job.jobId);
      if (
        !worker.registration.workerSessionId ||
        worker.registration.workerSessionGeneration === undefined
      ) throw new Error("WORKER_SESSION_MISSING");
      const sessionId = worker.registration.workerSessionId;
      const sessionGeneration = String(
        worker.registration.workerSessionGeneration,
      );
      await fixture.pgDatabase.query(
        `update bakery.worker_hosts
            set worker_session_id = $1,
                worker_session_generation = $2
          where organization_id = $3
            and id in ($4, $5)`,
        [
          sessionId,
          sessionGeneration,
          fixture.organizationId,
          worker.registration.workerHostId,
          otherWorker.registration.workerHostId,
        ],
      );
      const cancellation = await controlAppForFixture(fixture).fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Origin": fixture.config.publicBaseUrl,
              "Bakery-Organization-Id": fixture.organizationId,
              "Cookie": fixture.adminCookie,
              "Idempotency-Key": "issue42-cleanup-owner-cancel",
            },
            body: JSON.stringify({ action: "cancel" }),
          },
        ),
      );
      assertEquals(cancellation.status, 202);
      const cleanupPath = `/v1/worker/attempts/${assignment.attemptId}/cleanup`;
      const cleanupApp = workerCleanupAppForFixture(fixture);
      const cleanupResponses = await Promise.all(
        [otherWorker.credential, worker.credential].map((workerCredential) => {
          const headers = {
            "Authorization": `Bearer ${workerCredential}`,
            "Content-Type": "application/json",
            "X-Bakery-Worker-Protocol-Version": "2",
          };
          return cleanupApp.fetch(
            new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                fence: assignment.fence,
                workerSessionId: sessionId,
                workerSessionGeneration: sessionGeneration,
                observedByWorkerSessionId: sessionId,
                observedByWorkerSessionGeneration: sessionGeneration,
                exitedAt: new Date().toISOString(),
              }),
            }),
          );
        }),
      );
      const foreignCleanup = cleanupResponses[0];
      const ownerCleanup = cleanupResponses[1];
      assertEquals(foreignCleanup.status, 404);
      assertEquals(await problemCode(foreignCleanup), "RESOURCE_NOT_FOUND");
      assertEquals(ownerCleanup.status, 200);
    }),
);

async function controls(
  fixture: WorkerFixture,
  runId: string,
  scope: { adminCookie: string; organizationId: string } = fixture,
): Promise<Response> {
  return await adminRequest(fixture, `/v1/runs/${runId}/controls`, undefined, {
    method: "GET",
    scope: scope as WorkerFixture,
  });
}

async function lifecycleStatuses(fixture: WorkerFixture, jobId: string) {
  const row = (await fixture.pgDatabase.query<{
    job: string;
    step: string;
    run: string;
    task: string;
    cancelRequested: boolean;
    fence: string;
  }>(
    `select job.status as job, step.status as step, run.status as run,
            task.status as task,
            job.cancel_requested_at is not null as "cancelRequested",
            job.current_fence::text as fence
       from bakery.jobs job
       join bakery.run_steps step on step.id = job.run_step_id
       join bakery.workflow_runs run on run.id = step.run_id
       join bakery.tasks task on task.id = run.task_id
      where job.id = $1`,
    [jobId],
  )).rows[0];
  assert(row !== undefined);
  return row;
}

async function workerCommandCount(
  fixture: WorkerFixture,
  attemptId: string,
): Promise<number> {
  return Number(
    (await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.worker_commands
      where organization_id = $1 and attempt_id = $2`,
      [fixture.organizationId, attemptId],
    )).rows[0]?.count,
  );
}

async function reclaim(fixture: WorkerFixture): Promise<void> {
  await withPgTransaction(
    fixture.pgDatabase,
    (transaction) =>
      reclaimExpiredAttempts(
        transaction,
        fixture.organizationId,
        undefined,
        null,
      ),
  );
}

Deno.test("a run whose job waits for retry is canceled without a worker", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "waiting-run-cancel",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, job.jobId);
    await fixture.pgDatabase.query(
      `update bakery.job_attempts
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, assignment.attemptId],
    );
    await reclaim(fixture);
    const waiting = await lifecycleStatuses(fixture, job.jobId);
    assertEquals(waiting.job, "queued");
    assertEquals(waiting.fence, "2");

    const before = await controls(fixture, job.runId);
    assertEquals(before.status, 200);
    assertEquals(
      (await before.json()).actions.map((
        action: { action: string; canRequest: boolean },
      ) => [action.action, action.canRequest]),
      [["pause", false], ["resume", false], ["cancel", true], [
        "interrupt",
        false,
      ]],
    );

    const idempotencyKey = "waiting-run-cancel-key";
    const response = await adminRequest(
      fixture,
      `/v1/runs/${job.runId}/controls`,
      { action: "cancel" },
      { idempotencyKey },
    );
    assertEquals(response.status, 201, await response.clone().text());
    assertEquals((await response.json()).status, "canceled");
    assertEquals(await lifecycleStatuses(fixture, job.jobId), {
      job: "canceled",
      step: "canceled",
      run: "canceled",
      task: "canceled",
      cancelRequested: true,
      fence: "3",
    });
    assertEquals(await workerCommandCount(fixture, assignment.attemptId), 0);

    const after = await controls(fixture, job.runId);
    assertEquals(
      (await after.json()).actions.map((
        action: { reason: string; canRequest: boolean },
      ) => [action.canRequest, action.reason]),
      Array(4).fill([false, "already_terminal"]),
    );
    const replay = await adminRequest(
      fixture,
      `/v1/runs/${job.runId}/controls`,
      { action: "cancel" },
      { idempotencyKey },
    );
    assertEquals(replay.status, 201);
    assertEquals((await replay.json()).status, "canceled");

    // A canceled waiting job is never claimed afterwards.
    const claimKey = crypto.randomUUID();
    const claim = await workerRequest(
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
    assertEquals(claim.status, 204);
    const attempts = await fixture.pgDatabase.query(
      `select id from bakery.job_attempts where job_id = $1`,
      [job.jobId],
    );
    assertEquals(attempts.rows.length, 1);
  }));

Deno.test("a never-claimed queued job is cancelable and emits no job completion", () =>
  withWorkerFixture(async (fixture) => {
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const response = await adminRequest(
      fixture,
      `/v1/runs/${job.runId}/controls`,
      { action: "cancel" },
      { idempotencyKey: "never-claimed-cancel" },
    );
    assertEquals(response.status, 201, await response.clone().text());
    assertEquals(await lifecycleStatuses(fixture, job.jobId), {
      job: "canceled",
      step: "canceled",
      run: "canceled",
      task: "canceled",
      cancelRequested: true,
      fence: "1",
    });
    const events = await fixture.pgDatabase.query<{ eventType: string }>(
      `select event_type as "eventType" from bakery.domain_events
        where organization_id = $1
          and event_type in ('job.completed', 'job.updated')
          and aggregate_id = $2`,
      [fixture.organizationId, job.jobId],
    );
    assertEquals(
      events.rows.filter((row) => row.eventType === "job.completed"),
      [],
    );
    const runEvents = await fixture.pgDatabase.query(
      `select 1 from bakery.domain_events
        where organization_id = $1 and event_type = 'run.updated'
          and aggregate_id = $2`,
      [fixture.organizationId, job.runId],
    );
    assert(runEvents.rows.length > 0);
  }));

Deno.test("pause on a waiting run keeps the no active attempt conflict", () =>
  withWorkerFixture(async (fixture) => {
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const response = await adminRequest(
      fixture,
      `/v1/runs/${job.runId}/controls`,
      { action: "pause" },
      { idempotencyKey: "waiting-run-pause" },
    );
    assertEquals(response.status, 409);
    assertEquals((await lifecycleStatuses(fixture, job.jobId)).job, "queued");
  }));

Deno.test("a cancel that finds a live attempt refuses the direct path", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "waiting-run-cancel-race",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, job.jobId);
    // A claim won the race: the direct cancel must hand back to the worker path.
    const error = await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        cancelRunWithoutAttempt(transaction, {
          organizationId: fixture.organizationId,
          runId: job.runId,
          traceId: crypto.randomUUID(),
        }),
    ).then(() => undefined, (cause: unknown) => cause);
    assert(error instanceof StandardError);
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals((await lifecycleStatuses(fixture, job.jobId)).job, "leased");
  }));

Deno.test("a viewer cannot cancel a waiting run and another tenant cannot see it", () =>
  withWorkerFixture(async (fixture) => {
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships
          set role = 'viewer', updated_at = current_timestamp,
              version = version + 1
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, fixture.principalId],
    );
    try {
      const denied = await adminRequest(
        fixture,
        `/v1/runs/${job.runId}/controls`,
        { action: "cancel" },
        { idempotencyKey: "waiting-run-viewer-cancel" },
      );
      assertEquals(denied.status, 403);
      assertEquals(await problemCode(denied), "AUTH_FORBIDDEN");
    } finally {
      await fixture.pgDatabase.query(
        `update bakery.organization_memberships
            set role = 'admin', updated_at = current_timestamp,
                version = version + 1
          where organization_id = $1 and principal_id = $2`,
        [fixture.organizationId, fixture.principalId],
      );
    }
    assertEquals((await lifecycleStatuses(fixture, job.jobId)).job, "queued");

    const other = await createWorkerScope(
      fixture,
      "waiting-run-other-tenant",
      fixture,
    );
    try {
      const foreign = await adminRequest(
        fixture,
        `/v1/runs/${job.runId}/controls`,
        { action: "cancel" },
        { idempotencyKey: "waiting-run-foreign-cancel", scope: other },
      );
      assertEquals(foreign.status, 404);
      assertEquals(await problemCode(foreign), "RESOURCE_NOT_FOUND");
    } finally {
      await closeWorkerScope(fixture, other);
    }
    assertEquals((await lifecycleStatuses(fixture, job.jobId)).job, "queued");
  }));
