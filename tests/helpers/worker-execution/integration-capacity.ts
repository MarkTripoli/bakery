import { assert, assertEquals } from "@std/assert";
import {
  problemCode,
  readExecutionState,
  registeredWorker,
  setAttemptExpiryAfter,
  updateAttemptExpiry,
  waitForWorkerHostLockWait,
  withWorkerHostLock,
  workerFixtureCapabilities,
  workerRequest,
} from "../worker-execution.ts";
import { withWorkerFixture } from "./scenarios.ts";
import { seedEligibleNonmodelJob } from "./nonmodel-job.ts";

Deno.test("lease authority uses real time after a worker-host lock wait", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-clock-authority",
      slots: 4,
    });
    const sleep = (milliseconds: number): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, milliseconds);
      return promise;
    };
    const claimAttempt = async () => {
      const job = await seedEligibleNonmodelJob(
        fixture.pgDatabase,
        fixture.organizationId,
        fixture.principalId,
      );
      const claimKey = crypto.randomUUID();
      const response = await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities: [...workerFixtureCapabilities],
        },
        { idempotencyKey: claimKey },
      );
      assertEquals(response.status, 200);
      const assignment = await response.json() as {
        attemptId: string;
        leaseToken: string;
        fence: string;
      };
      return { job, claimKey, assignment };
    };
    const requestAfterExpiry = async <T>(
      attemptId: string,
      request: () => Promise<T>,
    ): Promise<T> => {
      return await withWorkerHostLock(
        fixture.runtimePgDatabase,
        worker.registration.workerHostId,
        async (release) => {
          await setAttemptExpiryAfter(
            fixture.pgDatabase,
            attemptId,
            100,
          );
          const pending = request();
          await waitForWorkerHostLockWait(fixture.runtimePgDatabase);
          await sleep(250);
          await release();
          return await pending;
        },
      );
    };

    const eventAttempt = await claimAttempt();
    const eventId = crypto.randomUUID();
    const event = await requestAfterExpiry(
      eventAttempt.assignment.attemptId,
      () =>
        workerRequest(
          fixture,
          worker.credential,
          `/v1/worker/attempts/${eventAttempt.assignment.attemptId}/events`,
          {
            leaseToken: eventAttempt.assignment.leaseToken,
            fence: eventAttempt.assignment.fence,
            events: [{
              eventId,
              localSeq: "1",
              eventType: "job.accepted",
              payload: { acceptedAt: "2026-09-20T00:00:01.000Z" },
            }],
          },
          { idempotencyKey: eventId },
        ),
    );
    assertEquals(event.status, 409);
    assertEquals(await problemCode(event), "LEASE_EXPIRED");
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, eventAttempt.job.jobId))
        .events,
      [],
    );

    const renewalAttempt = await claimAttempt();
    const renewal = await requestAfterExpiry(
      renewalAttempt.assignment.attemptId,
      () =>
        workerRequest(
          fixture,
          worker.credential,
          `/v1/worker/attempts/${renewalAttempt.assignment.attemptId}/lease-renewals`,
          {
            leaseToken: renewalAttempt.assignment.leaseToken,
            fence: renewalAttempt.assignment.fence,
            leaseSeconds: 10,
          },
          { idempotencyKey: crypto.randomUUID() },
        ),
    );
    assertEquals(renewal.status, 409);
    assertEquals(await problemCode(renewal), "LEASE_EXPIRED");

    const resultAttempt = await claimAttempt();
    const result = await requestAfterExpiry(
      resultAttempt.assignment.attemptId,
      () =>
        workerRequest(
          fixture,
          worker.credential,
          `/v1/worker/attempts/${resultAttempt.assignment.attemptId}/result`,
          {
            leaseToken: resultAttempt.assignment.leaseToken,
            fence: resultAttempt.assignment.fence,
            localSeq: "1",
            status: "canceled",
            cancellation: {
              processExited: true,
              exitedAt: "2026-09-20T00:00:01.000Z",
              cleanupStatus: "complete",
            },
          },
          { idempotencyKey: crypto.randomUUID() },
        ),
    );
    assertEquals(result.status, 409);
    assertEquals(await problemCode(result), "LEASE_EXPIRED");
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, resultAttempt.job.jobId))
        .events,
      [],
    );

    const rebindAttempt = await claimAttempt();
    const beforeRebind = await fixture.pgDatabase.query<{
      workerSessionId: string;
      workerSessionGeneration: string;
    }>(
      `select worker_session_id as "workerSessionId",
          worker_session_generation::text as "workerSessionGeneration"
     from bakery.job_attempts
    where organization_id = $1 and id = $2`,
      [fixture.organizationId, rebindAttempt.assignment.attemptId],
    );
    const replacementSessionId = crypto.randomUUID();
    const rebind = await requestAfterExpiry(
      rebindAttempt.assignment.attemptId,
      () =>
        workerRequest(
          fixture,
          worker.credential,
          "/v1/worker/heartbeat",
          {
            workerHostId: worker.registration.workerHostId,
            observedAt: "2026-09-20T00:00:00.000Z",
            load: 0,
            activeAttemptIds: [],
            ackCommandIds: [],
            rejectedCommandIds: [],
            pendingClaimKey: rebindAttempt.claimKey,
            workerSessionId: replacementSessionId,
            workerSessionGeneration:
              worker.registration.workerSessionGeneration,
          },
          {
            idempotencyKey: crypto.randomUUID(),
            includeWorkerSession: false,
            headers: { "X-Bakery-Worker-Protocol-Version": "2" },
          },
        ),
    );
    assertEquals(rebind.status, 200);
    const rebindBody = await rebind.json() as {
      reconciledAttemptIds: string[];
    };
    assertEquals(rebindBody.reconciledAttemptIds, []);
    const afterRebind = await fixture.pgDatabase.query<{
      workerSessionId: string;
      workerSessionGeneration: string;
    }>(
      `select worker_session_id as "workerSessionId",
          worker_session_generation::text as "workerSessionGeneration"
     from bakery.job_attempts
    where organization_id = $1 and id = $2`,
      [fixture.organizationId, rebindAttempt.assignment.attemptId],
    );
    assertEquals(afterRebind.rows[0], beforeRebind.rows[0]);
  }));

Deno.test("concurrent workers produce one assignment and stable claim replay semantics", () =>
  withWorkerFixture(async (fixture) => {
    const first = await registeredWorker(fixture, { name: "issue39-claim-a" });
    const second = await registeredWorker(fixture, { name: "issue39-claim-b" });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claim = (worker: typeof first, claimKey: string) => {
      const body = {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
      };
      return workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        body,
        {
          idempotencyKey: claimKey,
        },
      ).then(async (response) => ({
        body,
        response,
        raw: new Uint8Array(await response.arrayBuffer()),
      }));
    };
    const firstKey = crypto.randomUUID();
    const secondKey = crypto.randomUUID();
    const results = await Promise.all([
      claim(first, firstKey),
      claim(second, secondKey),
    ]);
    assertEquals(results.map(({ response }) => response.status).sort(), [
      200,
      204,
    ]);
    const winner = results.find(({ response }) => response.status === 200);
    const loser = results.find(({ response }) => response.status === 204);
    if (!winner || !loser) throw new Error("CLAIM_RACE_SHAPE_INVALID");
    const assignment = JSON.parse(new TextDecoder().decode(winner.raw)) as {
      jobId: string;
      attemptId: string;
      workerHostId: string;
      fence: string;
      leaseToken: string;
    };
    assertEquals(assignment.jobId, job.jobId);
    assertEquals(assignment.workerHostId, winner.body.workerHostId);

    const exactReplay = await workerRequest(
      fixture,
      winner === results[0] ? first.credential : second.credential,
      "/v1/worker/claims",
      winner.body,
      { idempotencyKey: winner.body.claimKey },
    );
    assertEquals(exactReplay.status, 200);
    assertEquals(new Uint8Array(await exactReplay.arrayBuffer()), winner.raw);

    const secondJob = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const loserCredential = loser === results[0]
      ? first.credential
      : second.credential;
    const loserReplay = await workerRequest(
      fixture,
      loserCredential,
      "/v1/worker/claims",
      loser.body,
      { idempotencyKey: loser.body.claimKey },
    );
    assertEquals(loserReplay.status, 204);
    assertEquals(await loserReplay.text(), "");

    const laterKey = crypto.randomUUID();
    const laterClaim = await workerRequest(
      fixture,
      loserCredential,
      "/v1/worker/claims",
      { ...loser.body, claimKey: laterKey },
      { idempotencyKey: laterKey },
    );
    assertEquals(laterClaim.status, 200);
    assertEquals((await laterClaim.json()).jobId, secondJob.jobId);

    const attempts = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.job_attempts where job_id = $1`,
      [job.jobId],
    );
    assertEquals(attempts.rows[0].count, 1);
  }));

Deno.test("server-counted live attempts enforce capacity despite a free client load claim", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-capacity",
      slots: 1,
    });
    const firstJob = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const secondJob = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const heartbeat = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        observedAt: "2026-09-20T00:00:00.000Z",
        load: 0,
        activeAttemptIds: [],
        ackCommandIds: [],
        rejectedCommandIds: [],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(heartbeat.status, 200);

    const firstKey = crypto.randomUUID();
    const firstClaim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey: firstKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
        supportedActions: ["quality.check"],
      },
      { idempotencyKey: firstKey },
    );
    assertEquals(firstClaim.status, 200);
    const assignment = await firstClaim.json() as {
      attemptId: string;
      fence: string;
      leaseToken: string;
    };
    const blockedKey = crypto.randomUUID();
    const blockedClaim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey: blockedKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
        supportedActions: ["quality.check"],
      },
      { idempotencyKey: blockedKey },
    );
    assertEquals(blockedClaim.status, 204);

    const cancellation = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        localSeq: "1",
        status: "canceled",
        cancellation: {
          processExited: true,
          exitedAt: "2026-09-20T00:00:00.000Z",
          cleanupStatus: "complete",
        },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(cancellation.status, 200);
    const nextKey = crypto.randomUUID();
    const nextClaim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey: nextKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: [...workerFixtureCapabilities],
        supportedActions: ["quality.check"],
      },
      { idempotencyKey: nextKey },
    );
    assertEquals(nextClaim.status, 200);
    assertEquals((await nextClaim.json()).jobId, secondJob.jobId);

    const state = await readExecutionState(fixture.pgDatabase, firstJob.jobId);
    assertEquals(state.attempts.length, 1);
    assertEquals(state.attempts[0].status, "canceled");
  }));

Deno.test("expired leases are reclaimed and expired claim replays do not pin work", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-reclaim",
      slots: 1,
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const request = {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: [...workerFixtureCapabilities],
    };
    const firstClaim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      request,
      { idempotencyKey: claimKey },
    );
    assertEquals(firstClaim.status, 200);
    const first = await firstClaim.json() as {
      attemptId: string;
      fence: string;
    };
    await updateAttemptExpiry(fixture.pgDatabase, first.attemptId);
    await fixture.pgDatabase.query(
      `update bakery.worker_claim_replays
      set expires_at = current_timestamp - interval '1 minute'
    where worker_host_id = $1 and claim_key = $2`,
      [worker.registration.workerHostId, claimKey],
    );

    const reclaimedClaim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      request,
      { idempotencyKey: claimKey },
    );
    assertEquals(reclaimedClaim.status, 200);
    const reclaimed = await reclaimedClaim.json() as {
      attemptId: string;
      fence: string;
      jobId: string;
    };
    assertEquals(reclaimed.jobId, job.jobId);
    assert(reclaimed.attemptId !== first.attemptId);
    assert(BigInt(reclaimed.fence) > BigInt(first.fence));

    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.attempts.map(({ status }) => status), [
      "lost",
      "leased",
    ]);
    const journal = await fixture.pgDatabase.query<{
      eventType: string;
      aggregateVersion: number;
      attemptId: string | null;
    }>(
      `select event_type as "eventType",
          aggregate_version as "aggregateVersion",
          payload->>'attemptId' as "attemptId"
     from bakery.domain_events
    where organization_id = $1
      and aggregate_id = $2
    order by organization_sequence`,
      [fixture.organizationId, job.jobId],
    );
    assertEquals(journal.rows, [{
      eventType: "job.updated",
      aggregateVersion: 2,
      attemptId: first.attemptId,
    }, {
      eventType: "job.updated",
      aggregateVersion: 3,
      attemptId: first.attemptId,
    }, {
      eventType: "job.updated",
      aggregateVersion: 4,
      attemptId: reclaimed.attemptId,
    }]);
  }));
