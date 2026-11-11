import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import {
  problemCode,
  readExecutionState,
  registeredWorker,
  seedEligibleJob,
  workerRequest,
} from "../worker-execution.ts";
import { withWorkerFixture } from "./scenarios.ts";
import { eventBody } from "./scenarios.ts";
import { seedLegacyLeasedModelAttempt } from "./legacy-attempt.ts";
Deno.test("legacy already-leased result ingestion accepts immutable evidence scoped to the assigned run step", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-contract-result",
    });
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
    const event = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, eventId, "1", "2026-09-20T00:00:01.000Z"),
      { idempotencyKey: eventId },
    );
    assertEquals(event.status, 200);
    // Durable evidence is admitted at run-step scope and reused across retries;
    // the attempt/fence above authenticates this mutation, not the old evidence.
    const resultBody = {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      localSeq: "2",
      status: "completed",
      result: {
        headSha: "head",
        baseSha: "base",
        sessionId: job.sessionId,
        artifacts: [],
      },
    } as const;
    const resultKey = crypto.randomUUID();
    const result = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      resultBody,
      { idempotencyKey: resultKey },
    );
    assertEquals(result.status, 200);
    const resultRaw = new Uint8Array(await result.arrayBuffer());
    const ack = contractSchemas.WorkerAck.parse(
      JSON.parse(new TextDecoder().decode(resultRaw)),
    );
    assertEquals(ack.lastEventSeq, "2");
    const terminal = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(terminal.events.length, 2);
    assertEquals(terminal.attempts[0].lastEventSeq, "2");
    assertEquals(terminal.attempts[0].status, "completed");
    assertEquals(terminal.job.status, "completed");

    const replay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      resultBody,
      { idempotencyKey: resultKey },
    );
    assertEquals(replay.status, 200);
    assertEquals(new Uint8Array(await replay.arrayBuffer()), resultRaw);
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      terminal,
    );

    const wrongProof = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      { ...resultBody, leaseToken: `${assignment.leaseToken}-wrong` },
      { idempotencyKey: resultKey },
    );
    assertEquals(wrongProof.status, 422);
    assertEquals(await problemCode(wrongProof), "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      terminal,
    );
  }));

Deno.test("legacy already-leased worker event and result routes bind UUID idempotency keys to mutation identity", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-contract-mutation-identity",
    });
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
    const eventId = crypto.randomUUID().toUpperCase();
    const eventRequest = eventBody(
      assignment,
      eventId,
      "1",
      "2026-09-20T00:00:01.000Z",
    );
    const firstEvent = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventRequest,
      { idempotencyKey: eventId },
    );
    assertEquals(firstEvent.status, 200);
    const firstEventRaw = new Uint8Array(await firstEvent.arrayBuffer());
    const replayedEvent = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventRequest,
      { idempotencyKey: eventId },
    );
    assertEquals(replayedEvent.status, 200);
    assertEquals(
      new Uint8Array(await replayedEvent.arrayBuffer()),
      firstEventRaw,
    );
    const eventBaseline = await readExecutionState(
      fixture.pgDatabase,
      job.jobId,
    );

    const changedEvent = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        ...eventRequest,
        events: [{
          ...eventRequest.events[0],
          payload: { acceptedAt: "2026-09-20T00:00:02.000Z" },
        }],
      },
      { idempotencyKey: eventId },
    );
    assertEquals(changedEvent.status, 422);
    assertEquals(
      await problemCode(changedEvent),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const differentEventId = crypto.randomUUID();
    const differentEvent = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        ...eventRequest,
        events: [{
          ...eventRequest.events[0],
          eventId: differentEventId,
        }],
      },
      { idempotencyKey: differentEventId },
    );
    assertEquals(differentEvent.status, 422);
    assertEquals(
      await problemCode(differentEvent),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const mismatchedEventKey = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventRequest,
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(mismatchedEventKey.status, 422);
    assertEquals(
      await problemCode(mismatchedEventKey),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const nonUuidEventKey = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventRequest,
      { idempotencyKey: "not-a-uuid" },
    );
    assertEquals(nonUuidEventKey.status, 428);
    assertEquals(await problemCode(nonUuidEventKey), "PRECONDITION_REQUIRED");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      eventBaseline,
    );

    const resultJob = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const resultWorker = await registeredWorker(fixture, {
      name: "issue39-contract-mutation-identity-result",
    });
    const resultAssignment = await seedLegacyLeasedModelAttempt(
      fixture,
      resultWorker,
      resultJob.jobId,
    );
    const resultBody = {
      leaseToken: resultAssignment.leaseToken,
      fence: resultAssignment.fence,
      localSeq: "1",
      status: "completed",
      result: {
        headSha: "head",
        baseSha: "base",
        sessionId: resultJob.sessionId,
        artifacts: [],
      },
    };
    const resultKey = crypto.randomUUID().toUpperCase();
    const firstResult = await workerRequest(
      fixture,
      resultWorker.credential,
      `/v1/worker/attempts/${resultAssignment.attemptId}/result`,
      resultBody,
      { idempotencyKey: resultKey },
    );
    assertEquals(firstResult.status, 200);
    const firstResultRaw = new Uint8Array(await firstResult.arrayBuffer());
    const resultEventRow = await fixture.pgDatabase.query<
      { eventId: string }
    >(
      `select event_id as "eventId"
     from bakery.attempt_events
    where organization_id = $1 and attempt_id = $2 and local_seq = $3`,
      [
        fixture.organizationId,
        resultAssignment.attemptId,
        resultBody.localSeq,
      ],
    );
    assertEquals(resultEventRow.rows[0].eventId, resultKey.toLowerCase());
    const replayedResult = await workerRequest(
      fixture,
      resultWorker.credential,
      `/v1/worker/attempts/${resultAssignment.attemptId}/result`,
      resultBody,
      { idempotencyKey: resultKey },
    );
    assertEquals(replayedResult.status, 200);
    assertEquals(
      new Uint8Array(await replayedResult.arrayBuffer()),
      firstResultRaw,
    );
    const resultBaseline = await readExecutionState(
      fixture.pgDatabase,
      resultJob.jobId,
    );
    const changedResult = await workerRequest(
      fixture,
      resultWorker.credential,
      `/v1/worker/attempts/${resultAssignment.attemptId}/result`,
      {
        ...resultBody,
        result: { ...resultBody.result, headSha: "changed" },
      },
      { idempotencyKey: resultKey },
    );
    assertEquals(changedResult.status, 422);
    assertEquals(
      await problemCode(changedResult),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const differentResultKey = await workerRequest(
      fixture,
      resultWorker.credential,
      `/v1/worker/attempts/${resultAssignment.attemptId}/result`,
      resultBody,
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(differentResultKey.status, 422);
    assertEquals(
      await problemCode(differentResultKey),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const nonUuidResultKey = await workerRequest(
      fixture,
      resultWorker.credential,
      `/v1/worker/attempts/${resultAssignment.attemptId}/result`,
      resultBody,
      { idempotencyKey: "not-a-uuid" },
    );
    assertEquals(nonUuidResultKey.status, 428);
    assertEquals(
      await problemCode(nonUuidResultKey),
      "PRECONDITION_REQUIRED",
    );
    assertEquals(
      await readExecutionState(fixture.pgDatabase, resultJob.jobId),
      resultBaseline,
    );
  }));
