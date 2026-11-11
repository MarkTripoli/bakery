import { assert, assertEquals } from "@std/assert";
import {
  problemCode,
  readExecutionState,
  registeredWorker,
  seedEligibleJob,
  workerFixtureCapabilities,
  workerRequest,
} from "../worker-execution.ts";
import {
  claimAssignment,
  eventBody,
  resultBody,
  withWorkerFixture,
} from "./scenarios.ts";
import { reclaimExpiredAttempts } from "../../../apps/server/src/modules/execution/index.ts";
import { withPgTransaction } from "../../../apps/server/src/platform/database.ts";
import { seedEligibleNonmodelJob } from "./nonmodel-job.ts";
import { seedLegacyLeasedModelAttempt } from "./legacy-attempt.ts";
Deno.test("claims honor the supported-action allowlist and return server lease timing", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-supported-actions",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        input: {
          repositoryId: crypto.randomUUID(),
          revision: "HEAD",
          checks: ["required"],
        },
      },
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, {
      claimKey,
      supportedActions: ["quality.check"],
    });
    assertEquals(assignment.jobId, job.jobId);
    assertEquals(assignment.action, "quality.check");
    assertEquals(assignment.leaseDurationSeconds, 45);
    assert(Number.isFinite(Date.parse(assignment.serverTime)));
  }));

Deno.test("a replacement worker session gets a monotonic fence and stale sessions cannot reconcile", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-session-fence",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const claimRequest = {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: [...workerFixtureCapabilities],
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: String(
        worker.registration.workerSessionGeneration,
      ),
    };
    const claim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      claimRequest,
      { idempotencyKey: claimKey },
    );
    assertEquals(claim.status, 200);
    const assignment = await claim.json() as { attemptId: string };
    const oldSessionId = worker.registration.workerSessionId;
    const oldGeneration = String(worker.registration.workerSessionGeneration);
    const replacementSessionId = crypto.randomUUID();
    const replacement = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        workerSessionId: replacementSessionId,
        workerSessionGeneration: oldGeneration,
        observedAt: "2026-09-20T00:00:00.000Z",
        load: 0,
        activeAttemptIds: [assignment.attemptId],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replacement.status, 200);
    const replacementBody = await replacement.json() as {
      workerSessionId: string;
      workerSessionGeneration: string;
    };
    assert(replacementBody.workerSessionId !== oldSessionId);
    assert(
      BigInt(replacementBody.workerSessionGeneration) >
        BigInt(oldGeneration),
    );
    const replacementClaimRequest = {
      ...claimRequest,
      workerSessionId: replacementSessionId,
      workerSessionGeneration: replacementBody.workerSessionGeneration,
    };
    const exactReplay = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      replacementClaimRequest,
      { idempotencyKey: claimKey },
    );
    assertEquals(exactReplay.status, 200);
    const changedReplay = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      { ...replacementClaimRequest, supportedActions: ["harness.implement"] },
      { idempotencyKey: claimKey },
    );
    assertEquals(changedReplay.status, 422);
    assertEquals(
      await problemCode(changedReplay),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const stale = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        workerSessionId: oldSessionId,
        workerSessionGeneration: oldGeneration,
        observedAt: "2026-09-20T00:00:01.000Z",
        load: 0,
        activeAttemptIds: [assignment.attemptId],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(stale.status, 409);
    assertEquals(await problemCode(stale), "LEASE_FENCED");
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, job.jobId)).attempts[0]
        .workerHostId,
      worker.registration.workerHostId,
    );
  }));

Deno.test("quarantined attempts advance the locked fence before sweep requeues them", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-quarantine-reclaim",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    const missingSession = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        leaseSeconds: 30,
      },
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
      },
    );
    assertEquals(missingSession.status, 400);
    assertEquals(await problemCode(missingSession), "MALFORMED_REQUEST");
    const reconciled = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        workerSessionId: worker.registration.workerSessionId,
        workerSessionGeneration: String(
          worker.registration.workerSessionGeneration,
        ),
        observedAt: "2026-09-20T00:00:00.000Z",
        activeAttemptIds: [assignment.attemptId],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(reconciled.status, 200);
    const replacement = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: String(
          worker.registration.workerSessionGeneration,
        ),
        observedAt: "2026-09-20T00:00:01.000Z",
        activeAttemptIds: [],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replacement.status, 200);
    const quarantined = await readExecutionState(
      fixture.pgDatabase,
      job.jobId,
    );
    assertEquals(quarantined.job.status, "awaiting_reconciliation");
    assertEquals(quarantined.job.currentFence, "2");
    assertEquals(quarantined.attempts[0].status, "quarantined");

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
    const reclaimed = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(reclaimed.job.status, "queued");
    assertEquals(reclaimed.job.currentFence, "3");
    assertEquals(reclaimed.attempts[0].status, "lost");
  }));

Deno.test("expiry reclaim and legacy already-leased result publication race without deadlock", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue40-expiry-publication-race",
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
    const acceptedEventId = crypto.randomUUID();
    const accepted = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, acceptedEventId, "1"),
      { idempotencyKey: acceptedEventId },
    );
    assertEquals(accepted.status, 200);
    await fixture.pgDatabase.query(
      `update bakery.job_attempts
          set lease_expires_at = clock_timestamp() - interval '1 second'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, assignment.attemptId],
    );

    const operations = Promise.all([
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          reclaimExpiredAttempts(
            transaction,
            fixture.organizationId,
            undefined,
            null,
          ),
      ),
      workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/result`,
        resultBody(assignment, {
          localSeq: "2",
          result: {
            headSha: "head",
            baseSha: "base",
            sessionId: job.sessionId,
            artifacts: [],
          },
        }),
        { idempotencyKey: crypto.randomUUID() },
      ),
    ]);
    let raceTimeout: ReturnType<typeof setTimeout> | undefined;
    let result!: Response;
    try {
      [, result] = await Promise.race([
        operations,
        new Promise<never>((_, reject) => {
          raceTimeout = setTimeout(
            () => reject(new Error("EXPIRY_PUBLICATION_RACE_TIMEOUT")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(raceTimeout);
    }
    assert([200, 409].includes(result.status));
    const finalState = await readExecutionState(fixture.pgDatabase, job.jobId);
    if (result.status === 200) {
      assertEquals(finalState.job.status, "completed");
      assertEquals(finalState.attempts[0].status, "completed");
    } else {
      assert(
        ["LEASE_EXPIRED", "LEASE_FENCED"].includes(await problemCode(result)),
      );
      assert(["queued", "completed"].includes(finalState.job.status));
      assert(["lost", "completed"].includes(finalState.attempts[0].status));
    }
  }));

Deno.test("reclaim exhausts the attempt budget into one durable terminal failure", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue40-attempt-budget",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs
          set max_attempts = 1
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.jobId],
    );
    const assignment = await claimAssignment(fixture, worker, {
      claimKey: crypto.randomUUID(),
    });
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

    const finalState = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(finalState.job.status, "failed");
    assertEquals(finalState.run.status, "failed");
    assertEquals(finalState.step.status, "failed");
    assertEquals(finalState.attempts.map((attempt) => attempt.status), [
      "lost",
    ]);
    const failureDetails = await fixture.pgDatabase.query<{
      error: { code?: string; message?: string } | null;
    }>(
      `select step.error
         from bakery.run_steps step
        where step.organization_id = $1 and step.run_id = $2`,
      [fixture.organizationId, job.runId],
    );
    assertEquals(failureDetails.rows[0]?.error, {
      code: "ATTEMPT_BUDGET_EXHAUSTED",
      message: "The attempt budget is exhausted.",
    });
    const lifecycle = await fixture.pgDatabase.query<{ eventType: string }>(
      `select event_type as "eventType"
         from bakery.domain_events
        where organization_id = $1
          and aggregate_id in ($2::uuid, $3::uuid, $4::uuid)
        order by organization_sequence`,
      [fixture.organizationId, job.jobId, job.runId, job.taskId],
    );
    assertEquals(
      lifecycle.rows.map((event) => event.eventType),
      ["job.updated", "job.updated", "run.updated", "tasks.updated"],
    );
  }));
