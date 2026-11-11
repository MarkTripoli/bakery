import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import {
  problemCode,
  readExecutionState,
  registeredWorker,
  workerRequest,
} from "../worker-execution.ts";
import { withWorkerFixture } from "./scenarios.ts";
import { seedEligibleNonmodelJob } from "./nonmodel-job.ts";
import { claimAssignment, eventBody } from "./scenarios.ts";
Deno.test("event replay returns the saved ack while gaps and changed duplicates remain unconsumed", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-contract-journal",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = contractSchemas.JobAssignment.parse(
      await claimAssignment(fixture, worker, { claimKey }),
    );
    const eventId = crypto.randomUUID();
    const body = eventBody(
      assignment,
      eventId,
      "1",
      "2026-09-20T00:00:01.000Z",
    );
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      body,
      { idempotencyKey: eventId },
    );
    assertEquals(first.status, 200);
    const firstRaw = new Uint8Array(await first.arrayBuffer());
    const firstAck = contractSchemas.WorkerAck.parse(
      JSON.parse(new TextDecoder().decode(firstRaw)),
    );
    assertEquals(firstAck, {
      eventId,
      status: "applied",
      lastEventSeq: "1",
    });
    const beforeReplay = await readExecutionState(
      fixture.pgDatabase,
      job.jobId,
    );

    const exactReplay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      body,
      { idempotencyKey: eventId },
    );
    assertEquals(exactReplay.status, 200);
    assertEquals(new Uint8Array(await exactReplay.arrayBuffer()), firstRaw);
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      beforeReplay,
    );

    const gapId = crypto.randomUUID();
    const gap = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, gapId, "3", "2026-09-20T00:00:03.000Z"),
      { idempotencyKey: gapId },
    );
    assertEquals(gap.status, 409);
    assertEquals(await problemCode(gap), "EXPECTED_SEQUENCE");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      beforeReplay,
    );

    const changed = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, eventId, "1", "2026-09-20T00:00:02.000Z"),
      { idempotencyKey: eventId },
    );
    assertEquals(changed.status, 422);
    assertEquals(await problemCode(changed), "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      beforeReplay,
    );
    const mixedId = crypto.randomUUID();
    const mixed = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [
          body.events[0],
          {
            eventId: mixedId,
            localSeq: "2",
            eventType: "job.progress",
            payload: { message: "mixed replay/new", percent: null },
          },
        ],
      },
      { idempotencyKey: mixedId },
    );
    assertEquals(mixed.status, 200);
    const mixedAck = contractSchemas.WorkerAck.parse(await mixed.json());
    assertEquals(mixedAck.lastEventSeq, "2");
    const afterMixed = await readExecutionState(
      fixture.pgDatabase,
      job.jobId,
    );
    const regressed = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [
          {
            eventId: mixedId,
            localSeq: "2",
            eventType: "job.progress",
            payload: { message: "mixed replay/new", percent: null },
          },
          body.events[0],
        ],
      },
      { idempotencyKey: body.events[0].eventId },
    );
    assertEquals(regressed.status, 400);
    assertEquals(await problemCode(regressed), "MALFORMED_REQUEST");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      afterMixed,
    );
  }));
Deno.test("gapped event batches roll back lifecycle and journal mutation before recovery", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-contract-atomic-event-batch",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = contractSchemas.JobAssignment.parse(
      await claimAssignment(fixture, worker, { claimKey }),
    );
    const firstEventId = crypto.randomUUID();
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(
        assignment,
        firstEventId,
        "1",
        "2026-09-20T00:00:01.000Z",
      ),
      { idempotencyKey: firstEventId },
    );
    assertEquals(first.status, 200);
    const baseline = await readExecutionState(
      fixture.pgDatabase,
      job.jobId,
    );
    assertEquals(baseline.attempts[0].lastEventSeq, "1");

    const startedEvent = {
      eventId: crypto.randomUUID(),
      localSeq: "2",
      eventType: "job.started",
      payload: {
        startedAt: "2026-09-20T00:00:02.000Z",
        workspaceId: crypto.randomUUID(),
      },
    };
    const gappedTailId = crypto.randomUUID();
    const gapped = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [
          startedEvent,
          {
            eventId: gappedTailId,
            localSeq: "4",
            eventType: "job.progress",
            payload: { message: "gap", percent: null },
          },
        ],
      },
      { idempotencyKey: gappedTailId },
    );
    assertEquals(gapped.status, 409);
    assertEquals(await problemCode(gapped), "EXPECTED_SEQUENCE");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      baseline,
    );

    const changedDuplicateLater = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [
          {
            eventId: crypto.randomUUID(),
            localSeq: "2",
            eventType: "job.progress",
            payload: { message: "prefix", percent: null },
          },
          {
            eventId: firstEventId,
            localSeq: "3",
            eventType: "job.accepted",
            payload: { acceptedAt: "2026-09-20T00:00:03.000Z" },
          },
        ],
      },
      { idempotencyKey: firstEventId },
    );
    assertEquals(changedDuplicateLater.status, 422);
    assertEquals(
      await problemCode(changedDuplicateLater),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      baseline,
    );

    const recoveredEventId = crypto.randomUUID();
    const validReplay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [
          startedEvent,
          {
            eventId: recoveredEventId,
            localSeq: "3",
            eventType: "job.progress",
            payload: { message: "recovered", percent: 50 },
          },
        ],
      },
      { idempotencyKey: recoveredEventId },
    );
    assertEquals(validReplay.status, 200);
    const validAck = contractSchemas.WorkerAck.parse(
      await validReplay.json(),
    );
    assertEquals(validAck.lastEventSeq, "3");
    const recovered = await readExecutionState(
      fixture.pgDatabase,
      job.jobId,
    );
    assertEquals(
      recovered.events.map(({ localSeq }) => localSeq),
      ["1", "2", "3"],
    );
    assertEquals(recovered.attempts[0].lastEventSeq, "3");
    assertEquals(recovered.attempts[0].status, "running");
    assertEquals(recovered.job.status, "running");
  }));
