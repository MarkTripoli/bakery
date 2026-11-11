import { assert, assertEquals } from "@std/assert";
import {
  contractSchemas,
  workerActionOutputSchema,
} from "../../../packages/contracts/src/contracts.ts";
import {
  problemCode,
  readExecutionState,
  registeredWorker,
  seedEligibleJob,
  workerRequest,
} from "../worker-execution.ts";
import { withWorkerFixture } from "./scenarios.ts";
import { seedLegacyLeasedModelAttempt } from "./legacy-attempt.ts";
Deno.test("legacy already-leased terminal run-step guard rolls back result and successful results journal durable wakeups", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-contract-terminal-guard",
    });
    const guardedJob = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const guardedAssignment = await seedLegacyLeasedModelAttempt(
      fixture,
      worker,
      guardedJob.jobId,
    );
    await fixture.pgDatabase.query(
      `update bakery.run_steps
      set status = 'canceled', finished_at = current_timestamp
    where organization_id = $1 and id = $2`,
      [fixture.organizationId, guardedJob.runStepId],
    );
    const guardedBefore = await readExecutionState(
      fixture.pgDatabase,
      guardedJob.jobId,
    );
    const guardedResult = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${guardedAssignment.attemptId}/result`,
      {
        leaseToken: guardedAssignment.leaseToken,
        fence: guardedAssignment.fence,
        localSeq: "1",
        status: "completed",
        result: {
          headSha: "head",
          baseSha: "base",
          sessionId: guardedJob.sessionId,
          artifacts: [],
        },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(guardedResult.status, 409);
    assertEquals(await problemCode(guardedResult), "STATE_CONFLICT");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, guardedJob.jobId),
      guardedBefore,
    );
    const journalWorker = await registeredWorker(fixture, {
      name: "issue39-contract-journal-events",
    });

    const journaledJob = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const journaledAssignment = await seedLegacyLeasedModelAttempt(
      fixture,
      journalWorker,
      journaledJob.jobId,
    );
    const journaledResult = await workerRequest(
      fixture,
      journalWorker.credential,
      `/v1/worker/attempts/${journaledAssignment.attemptId}/result`,
      {
        leaseToken: journaledAssignment.leaseToken,
        fence: journaledAssignment.fence,
        localSeq: "1",
        status: "completed",
        result: {
          headSha: "head",
          baseSha: "base",
          sessionId: journaledJob.sessionId,
          artifacts: [],
        },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(journaledResult.status, 200);
    const durable = await fixture.pgDatabase.query<{
      eventType: string;
      destination: string | null;
      outboxStatus: string | null;
    }>(
      `select event.event_type as "eventType",
          outbox.destination,
          outbox.status as "outboxStatus"
     from bakery.domain_events as event
     left join bakery.outbox as outbox on outbox.event_id = event.id
    where event.organization_id = $1
      and (
        event.payload->>'jobId' = $2
        or event.payload->>'stepId' = $3
        or event.payload->>'runId' = $4
      )
    order by event.organization_sequence`,
      [
        fixture.organizationId,
        journaledJob.jobId,
        journaledJob.runStepId,
        journaledJob.runId,
      ],
    );
    assertEquals(
      durable.rows.map(({ eventType, destination, outboxStatus }) => ({
        eventType,
        destination,
        outboxStatus,
      })),
      [
        { eventType: "job.updated", destination: null, outboxStatus: null },
        {
          eventType: "job.completed",
          destination: "inngest",
          outboxStatus: "pending",
        },
        { eventType: "run.updated", destination: null, outboxStatus: null },
      ],
    );
    assert(
      durable.rows.some(({ eventType }) => eventType === "job.completed"),
    );
  }));

Deno.test("mcp.discover requires connection identity and a result digest", () => {
  const assignment = contractSchemas.JobAssignment.safeParse({
    jobId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    workerHostId: crypto.randomUUID(),
    leaseToken: "worker-lease-token",
    fence: "1",
    leaseExpiresAt: "2026-09-20T00:00:45.000Z",
    action: "mcp.discover",
    requirements: {},
    input: { connectionId: crypto.randomUUID() },
    currentCheckpoints: [],
    agentConfig: {},
    skillRefs: [],
    agentVersionId: null,
    billing: null,
    installationReservationId: null,
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
    leaseDurationSeconds: 45,
    serverTime: "2026-09-20T00:00:00.000Z",
    sealedCredentialOperation: null,
  });
  assert(assignment.success);
  const invalidInput = contractSchemas.JobAssignment.safeParse({
    ...(assignment.success ? assignment.data : {}),
    input: {},
  });
  assert(!invalidInput.success);
  const output = workerActionOutputSchema("mcp.discover");
  assert(
    output.safeParse({
      snapshotId: crypto.randomUUID(),
      digest: "a".repeat(64),
    }).success,
  );
  assert(!output.safeParse({ snapshotId: crypto.randomUUID() }).success);
});
