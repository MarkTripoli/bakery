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
import { claimAssignment } from "./scenarios.ts";
Deno.test("strict worker result variants reject without journal or lifecycle changes", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-contract-result-variants",
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
    const baseline = await readExecutionState(fixture.pgDatabase, job.jobId);
    const invalidResults = [
      {
        body: {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "1",
          status: "completed",
          result: {
            artifact: {
              artifactId: crypto.randomUUID(),
              versionId: crypto.randomUUID(),
              sha256: "a".repeat(64),
            },
          },
        },
        code: "VALIDATION_FAILED",
      },
      {
        body: {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "1",
          status: "failed",
          fault: { detail: "not a Problem document" },
        },
        code: "UNPROCESSABLE",
      },
      {
        body: {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          localSeq: "1",
          status: "canceled",
          cancellation: {
            processExited: false,
            exitedAt: "2026-09-20T00:00:01.000Z",
            cleanupStatus: "complete",
          },
        },
        code: "UNPROCESSABLE",
      },
    ];
    for (const { body, code } of invalidResults) {
      const response = await workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/result`,
        body,
        { idempotencyKey: crypto.randomUUID() },
      );
      assertEquals(response.status, 422);
      assertEquals(await problemCode(response), code);
      assertEquals(
        await readExecutionState(fixture.pgDatabase, job.jobId),
        baseline,
      );
    }
  }));

Deno.test("unknown and oversized worker events reject before journal mutation", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-contract-event-bounds",
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
    const baseline = await readExecutionState(fixture.pgDatabase, job.jobId);
    const requests = [
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.unknown",
          payload: {},
        }],
      },
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.progress",
          payload: { message: "x".repeat(32_001), percent: null },
        }],
      },
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [{
          eventId: crypto.randomUUID(),
          localSeq: "1",
          eventType: "job.succeeded",
          payload: {},
        }],
      },
    ];
    for (const body of requests) {
      const response = await workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/events`,
        body,
        { idempotencyKey: body.events[0].eventId },
      );
      assertEquals(response.status, 400);
      assertEquals(await problemCode(response), "MALFORMED_REQUEST");
      assertEquals(
        await readExecutionState(fixture.pgDatabase, job.jobId),
        baseline,
      );
    }
    const missingReferenceEventId = crypto.randomUUID();
    const missingReference = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [{
          eventId: missingReferenceEventId,
          localSeq: "1",
          eventType: "job.checkpoint",
          payload: {
            artifact: {
              artifactId: crypto.randomUUID(),
              versionId: crypto.randomUUID(),
              sha256: "a".repeat(64),
            },
            resumeHandleRef: null,
          },
        }],
      },
      { idempotencyKey: missingReferenceEventId },
    );
    assertEquals(missingReference.status, 404);
    assertEquals(await problemCode(missingReference), "RESOURCE_NOT_FOUND");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      baseline,
    );
  }));
