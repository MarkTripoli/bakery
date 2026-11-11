import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import {
  enrollWorker,
  problemCode,
  readExecutionState,
  registeredWorker,
  registerWorker,
  seedEligibleJob,
  workerCredential,
  workerFixtureCapabilities,
  workerRequest,
} from "../worker-execution.ts";
import { withWorkerFixture } from "./scenarios.ts";
import { seedEligibleNonmodelJob } from "./nonmodel-job.ts";
import { claimAssignment, heartbeatRequest } from "./scenarios.ts";
Deno.test("worker protocol negotiation and lost-claim heartbeat fields match contracts", () =>
  withWorkerFixture(async (fixture) => {
    const enrollmentResponse = await enrollWorker(fixture, {
      name: "issue39-contract-protocol",
    });
    const enrollment = await enrollmentResponse.json() as {
      enrollmentToken: string;
    };
    const credential = workerCredential();
    const registration = await registerWorker(
      fixture,
      enrollment.enrollmentToken,
      credential,
      {
        name: "issue39-contract-protocol",
        protocolVersion: 2,
      },
    );
    assertEquals(registration.status, 200);
    assertEquals(
      registration.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    const registrationBody = contractSchemas.WorkerRegistrationResult.parse(
      await registration.json(),
    );
    const heartbeatInput = contractSchemas.WorkerHeartbeat.parse({
      workerHostId: registrationBody.workerHostId,
      observedAt: "2026-09-20T00:00:00.000Z",
      activeAttemptIds: [],
      ackCommandIds: [],
      rejectedCommandIds: [],
      pendingClaimKey: crypto.randomUUID(),
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "0",
    });
    const heartbeat = await workerRequest(
      fixture,
      credential,
      "/v1/worker/heartbeat",
      heartbeatInput,
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(heartbeat.status, 200);
    assertEquals(
      heartbeat.headers.get("X-Bakery-Worker-Protocol-Version"),
      "2",
    );
    assertEquals(heartbeat.headers.get("Idempotent-Replayed"), null);
    const heartbeatBody = contractSchemas.WorkerHeartbeatResult.parse(
      await heartbeat.json(),
    );
    assertEquals(heartbeatBody.reconciledAttemptIds, []);
  }));

Deno.test("worker route responses match catalog schemas and claim keys are bound to HTTP idempotency", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-contract-shapes",
    });
    const otherWorker = await registeredWorker(fixture, {
      name: "issue39-contract-shapes-other",
    });
    contractSchemas.WorkerRegistrationResult.parse(worker.registration);
    const heartbeat = await heartbeatRequest(fixture, worker);
    assertEquals(heartbeat.status, 200);
    const heartbeatBody = contractSchemas.WorkerHeartbeatResult.parse(
      await heartbeat.json(),
    );
    assertEquals(heartbeatBody.workerHostId, worker.registration.workerHostId);

    const hostMismatchKey = crypto.randomUUID();
    const hostMismatch = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey: hostMismatchKey,
        workerHostId: otherWorker.registration.workerHostId,
        capabilities: ["git"],
      },
      { idempotencyKey: hostMismatchKey },
    );
    assertEquals(hostMismatch.status, 403);
    assertEquals(await problemCode(hostMismatch), "AUTH_FORBIDDEN");
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const mismatch = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey: crypto.randomUUID(),
        workerHostId: worker.registration.workerHostId,
        capabilities: ["git"],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(mismatch.status, 400);
    assertEquals(await problemCode(mismatch), "MALFORMED_REQUEST");

    const assignment = contractSchemas.JobAssignment.parse(
      await claimAssignment(fixture, worker, { claimKey }),
    );
    assertEquals(assignment.jobId, job.jobId);
    assertEquals(assignment.workerHostId, worker.registration.workerHostId);
  }));

Deno.test("fresh claims reject unfunded harness work and progress to a nonmodel job", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { slots: 2 });
    const unfunded = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      { action: "harness.implement", priority: 100 },
    );
    const funding = await fixture.pgDatabase.query<{
      agent: string | null;
      billing: unknown;
      reservation: string | null;
    }>(
      `select agent_version_id as agent, billing, installation_reservation_id as reservation
         from bakery.jobs where organization_id = $1 and id = $2`,
      [fixture.organizationId, unfunded.jobId],
    );
    assertEquals(funding.rows, [{
      agent: null,
      billing: null,
      reservation: null,
    }]);
    const valid = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = contractSchemas.JobAssignment.parse(
      await claimAssignment(fixture, worker),
    );
    assertEquals(assignment.jobId, valid.jobId);
    assertEquals(assignment.action, "quality.check");
    assertEquals(assignment.billing, null);
    assertEquals(assignment.installationReservationId, null);
    const rejected = await readExecutionState(
      fixture.pgDatabase,
      unfunded.jobId,
    );
    assertEquals(rejected.job.status, "failed");
    assertEquals(rejected.attempts.length, 0);
    const failure = await fixture.pgDatabase.query<{ code: string }>(
      `select error->>'code' as code from bakery.run_steps where organization_id = $1 and id = $2`,
      [fixture.organizationId, unfunded.runStepId],
    );
    assertEquals(failure.rows, [{ code: "INVALID_ASSIGNMENT_PAYLOAD" }]);
    const claimKey = crypto.randomUUID();
    const empty = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
        supportedActions: ["harness.implement", "quality.check"],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(empty.status, 204);
    assertEquals(
      await readExecutionState(fixture.pgDatabase, unfunded.jobId),
      rejected,
    );
  }));
