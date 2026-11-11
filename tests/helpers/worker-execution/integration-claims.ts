import { assert, assertEquals } from "@std/assert";
import {
  problemCode,
  readExecutionState,
  registeredWorker,
  seedEligibleJob,
  waitForWorkerHostLockWait,
  withWorkerHostLock,
  type WorkerFixture,
  workerFixtureCapabilities,
  workerRequest,
} from "../worker-execution.ts";
import { withWorkerFixture } from "./scenarios.ts";
import { claimAssignment } from "./scenarios.ts";
import { openRepositoryInspectionHarness } from "../repository-inspection.ts";
import { seedEligibleNonmodelJob } from "./nonmodel-job.ts";

type RejectedClaimPrefix = {
  jobIds: string[];
  before: { job: unknown }[];
};

async function seedRejectedClaimPrefix(
  fixture: WorkerFixture,
  count: number,
): Promise<RejectedClaimPrefix> {
  const jobIds: string[] = [];
  const applicationIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      { priority: 100 },
    );
    jobIds.push(job.jobId);
    applicationIds.push(job.applicationId);
  }
  // The default fixtures carry admitted strict-v1 execution context. Archiving
  // their own repositories makes lifecycle denial—not missing pins—the prefix.
  await fixture.pgDatabase.query(
    `update bakery.repositories set archived_at = clock_timestamp()
      where organization_id = $1 and application_id = any($2::uuid[])`,
    [fixture.organizationId, applicationIds],
  );
  const before = await fixture.pgDatabase.query<{ job: unknown }>(
    `select to_jsonb(job) as job from bakery.jobs job
      where organization_id = $1 and id = any($2::uuid[]) order by id`,
    [fixture.organizationId, jobIds],
  );
  return { jobIds, before: before.rows };
}

async function assertRejectedClaimPrefixUnchanged(
  fixture: WorkerFixture,
  prefix: RejectedClaimPrefix,
) {
  const after = await fixture.pgDatabase.query(
    `select to_jsonb(job) as job from bakery.jobs job
      where organization_id = $1 and id = any($2::uuid[]) order by id`,
    [fixture.organizationId, prefix.jobIds],
  );
  assertEquals(after.rows, prefix.before);
  const attempts = await fixture.pgDatabase.query(
    `select id from bakery.job_attempts
      where organization_id = $1 and job_id = any($2::uuid[])`,
    [fixture.organizationId, prefix.jobIds],
  );
  assertEquals(attempts.rows, []);
}

Deno.test("claim scanning leases a successor beyond the invalid-disposition budget", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue46-claim-progress",
    });
    const prefix = await seedRejectedClaimPrefix(fixture, 65);
    const harness = await openRepositoryInspectionHarness(
      { authDb: fixture.pgDatabase, appPg: fixture.runtimePgDatabase },
      fixture,
    );
    try {
      const repository = await harness.createRepository();
      const onboarding = await harness.onboard(repository.repositoryId);
      await fixture.pgDatabase.query(
        `update bakery.jobs set priority = 0
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, onboarding.jobId],
      );
      const assignment = await claimAssignment(fixture, worker);
      assertEquals(assignment.jobId, onboarding.jobId);
      assertEquals(assignment.action, "repository.inspect");
      const lease = await fixture.pgDatabase.query(
        `select job.status as job_status, attempt.status as attempt_status,
                attempt.worker_host_id::text as worker_host_id,
                attempt.fence::text, job.current_fence::text as current_fence
           from bakery.jobs job
           join bakery.job_attempts attempt on attempt.job_id = job.id
            and attempt.organization_id = job.organization_id
          where job.organization_id = $1 and job.id = $2`,
        [fixture.organizationId, onboarding.jobId],
      );
      assertEquals(lease.rows, [{
        job_status: "leased",
        attempt_status: "leased",
        worker_host_id: worker.registration.workerHostId,
        fence: "1",
        current_fence: "1",
      }]);
      await assertRejectedClaimPrefixUnchanged(fixture, prefix);
    } finally {
      await harness.close();
    }
  }));

Deno.test("claim scanning terminates at an all-rejected exact batch boundary", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue46-claim-progress-empty",
    });
    const prefix = await seedRejectedClaimPrefix(fixture, 64);
    for (let index = 0; index < 2; index++) {
      const claimKey = crypto.randomUUID();
      const response = await workerRequest(
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
      assertEquals(response.status, 204);
      assertEquals(await response.text(), "");
    }
    await assertRejectedClaimPrefixUnchanged(fixture, prefix);
  }));

Deno.test("concurrent claimers past a rejected prefix lease a successor only once", () =>
  withWorkerFixture(async (fixture) => {
    const workers = await Promise.all([
      registeredWorker(fixture, { name: "issue46-claim-progress-race-a" }),
      registeredWorker(fixture, { name: "issue46-claim-progress-race-b" }),
    ]);
    const prefix = await seedRejectedClaimPrefix(fixture, 32);
    const harness = await openRepositoryInspectionHarness(
      { authDb: fixture.pgDatabase, appPg: fixture.runtimePgDatabase },
      fixture,
    );
    try {
      const repository = await harness.createRepository();
      const onboarding = await harness.onboard(repository.repositoryId);
      await fixture.pgDatabase.query(
        `update bakery.jobs set priority = 0
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, onboarding.jobId],
      );
      const results = await Promise.all(workers.map(async (worker) => {
        const claimKey = crypto.randomUUID();
        const body = {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities: workerFixtureCapabilities,
        };
        const response = await workerRequest(
          fixture,
          worker.credential,
          "/v1/worker/claims",
          body,
          { idempotencyKey: claimKey },
        );
        return {
          worker,
          body,
          status: response.status,
          raw: new Uint8Array(await response.arrayBuffer()),
        };
      }));
      assertEquals(results.map(({ status }) => status).sort(), [200, 204]);
      const winner = results.find(({ status }) => status === 200);
      assert(winner);
      const assignment = JSON.parse(new TextDecoder().decode(winner.raw));
      assertEquals(assignment.jobId, onboarding.jobId);
      const attempts = await fixture.pgDatabase.query(
        `select worker_host_id::text as worker_host_id, status, fence::text
           from bakery.job_attempts where organization_id = $1 and job_id = $2`,
        [fixture.organizationId, onboarding.jobId],
      );
      assertEquals(attempts.rows, [{
        worker_host_id: winner.worker.registration.workerHostId,
        status: "leased",
        fence: "1",
      }]);
      const replay = await workerRequest(
        fixture,
        winner.worker.credential,
        "/v1/worker/claims",
        winner.body,
        { idempotencyKey: winner.body.claimKey },
      );
      assertEquals(replay.status, 200);
      assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
      assertEquals(new Uint8Array(await replay.arrayBuffer()), winner.raw);
      await assertRejectedClaimPrefixUnchanged(fixture, prefix);
    } finally {
      await harness.close();
    }
  }));

Deno.test("heartbeat takeovers are ordered and exact retries replay the saved bytes", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-heartbeat-takeover",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    const replacementSessionId = crypto.randomUUID();
    const takeoverBody = {
      workerHostId: worker.registration.workerHostId,
      observedAt: "2026-09-20T00:00:00.000Z",
      load: 0,
      activeAttemptIds: [assignment.attemptId],
      ackCommandIds: [],
      rejectedCommandIds: [],
      workerSessionId: replacementSessionId,
      workerSessionGeneration: worker.registration.workerSessionGeneration,
    };
    const takeoverKey = crypto.randomUUID();
    const takeover = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      takeoverBody,
      {
        idempotencyKey: takeoverKey,
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(takeover.status, 200);
    const takeoverRaw = new Uint8Array(await takeover.arrayBuffer());
    const takeoverResult = JSON.parse(
      new TextDecoder().decode(takeoverRaw),
    ) as {
      workerSessionGeneration: string;
      reconciledAttemptIds: string[];
    };
    assertEquals(takeoverResult.reconciledAttemptIds, [assignment.attemptId]);
    const delayedOld = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        ...takeoverBody,
        workerSessionId: worker.registration.workerSessionId,
        workerSessionGeneration: worker.registration.workerSessionGeneration,
      },
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(delayedOld.status, 409);
    assertEquals(await problemCode(delayedOld), "LEASE_FENCED");
    const exactRetry = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      takeoverBody,
      {
        idempotencyKey: takeoverKey,
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(exactRetry.status, 200);
    assertEquals(exactRetry.headers.get("Idempotent-Replayed"), "true");
    assertEquals(new Uint8Array(await exactRetry.arrayBuffer()), takeoverRaw);
    const eventId = crypto.randomUUID();
    const event = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        workerSessionId: replacementSessionId,
        workerSessionGeneration: takeoverResult.workerSessionGeneration,
        events: [{
          eventId,
          localSeq: "1",
          eventType: "job.accepted",
          payload: { acceptedAt: "2026-09-20T00:00:01.000Z" },
        }],
      },
      {
        idempotencyKey: eventId,
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(event.status, 200);
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(
      state.attempts[0].workerHostId,
      worker.registration.workerHostId,
    );
  }));

Deno.test("lost claim replay rebinds the live attempt before the replacement heartbeat reconciles", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-lost-claim",
    });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const claimBody = {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
    };
    const firstClaim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      claimBody,
      { idempotencyKey: claimKey },
    );
    assertEquals(firstClaim.status, 200);
    const firstClaimRaw = new Uint8Array(await firstClaim.arrayBuffer());
    const assignment = JSON.parse(new TextDecoder().decode(firstClaimRaw)) as {
      attemptId: string;
      leaseToken: string;
      fence: string;
    };
    const replacementSessionId = crypto.randomUUID();
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
        pendingClaimKey: claimKey,
        workerSessionId: replacementSessionId,
        workerSessionGeneration: worker.registration.workerSessionGeneration,
      },
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(heartbeat.status, 200);
    const heartbeatBody = await heartbeat.json() as {
      workerSessionGeneration: string;
      reconciledAttemptIds: string[];
    };
    assertEquals(heartbeatBody.reconciledAttemptIds, [assignment.attemptId]);
    const replay = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        ...claimBody,
        workerSessionId: replacementSessionId,
        workerSessionGeneration: heartbeatBody.workerSessionGeneration,
      },
      {
        idempotencyKey: claimKey,
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(replay.status, 200);
    assertEquals(new Uint8Array(await replay.arrayBuffer()), firstClaimRaw);
    const eventId = crypto.randomUUID();
    const event = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        workerSessionId: replacementSessionId,
        workerSessionGeneration: heartbeatBody.workerSessionGeneration,
        events: [{
          eventId,
          localSeq: "1",
          eventType: "job.accepted",
          payload: { acceptedAt: "2026-09-20T00:00:01.000Z" },
        }],
      },
      {
        idempotencyKey: eventId,
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(event.status, 200);
    const attempt = await fixture.pgDatabase.query<{
      workerSessionId: string;
      workerSessionGeneration: string;
    }>(
      `select worker_session_id as "workerSessionId",
          worker_session_generation::text as "workerSessionGeneration"
     from bakery.job_attempts
    where organization_id = $1 and id = $2`,
      [fixture.organizationId, assignment.attemptId],
    );
    assertEquals(attempt.rows[0], {
      workerSessionId: replacementSessionId,
      workerSessionGeneration: heartbeatBody.workerSessionGeneration,
    });
  }));
Deno.test("gapped event batches roll back lifecycle and journal mutation before recovery", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-integration-atomic-event-batch",
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    const firstEventId = crypto.randomUUID();
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        events: [{
          eventId: firstEventId,
          localSeq: "1",
          eventType: "job.accepted",
          payload: { acceptedAt: "2026-09-20T00:00:01.000Z" },
        }],
      },
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
    const validAck = await validReplay.json() as {
      lastEventSeq: string;
    };
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

Deno.test("lease renewal idempotency replays the exact response without extending twice", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-renewal-replay",
    });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    const idempotencyKey = crypto.randomUUID();
    const body = {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      leaseSeconds: 30,
    };
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
      body,
      { idempotencyKey },
    );
    const firstRaw = new Uint8Array(await first.arrayBuffer());
    assertEquals(first.status, 200);
    const firstVersion = await fixture.pgDatabase.query<{ version: number }>(
      `select version from bakery.job_attempts where organization_id = $1 and id = $2`,
      [fixture.organizationId, assignment.attemptId],
    );
    const replay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
      body,
      { idempotencyKey },
    );
    assertEquals(replay.status, 200);
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(new Uint8Array(await replay.arrayBuffer()), firstRaw);
    const replayVersion = await fixture.pgDatabase.query<{ version: number }>(
      `select version from bakery.job_attempts where organization_id = $1 and id = $2`,
      [fixture.organizationId, assignment.attemptId],
    );
    assertEquals(replayVersion.rows[0].version, firstVersion.rows[0].version);
    const changed = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
      { ...body, leaseSeconds: 31 },
      { idempotencyKey },
    );
    assertEquals(changed.status, 422);
    assertEquals(await problemCode(changed), "IDEMPOTENCY_PAYLOAD_MISMATCH");

    const concurrentKey = crypto.randomUUID();
    const concurrent = await Promise.all([
      workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
        body,
        { idempotencyKey: concurrentKey },
      ),
      workerRequest(
        fixture,
        worker.credential,
        `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
        body,
        { idempotencyKey: concurrentKey },
      ),
    ]);
    assertEquals(concurrent.map((response) => response.status), [200, 200]);
    assertEquals(
      concurrent.filter((response) =>
        response.headers.get("Idempotent-Replayed") === "true"
      ).length,
      1,
    );
    const concurrentRaw = await Promise.all(
      concurrent.map((response) => response.arrayBuffer()),
    );
    assertEquals(
      new Uint8Array(concurrentRaw[0]),
      new Uint8Array(concurrentRaw[1]),
    );
    const concurrentVersion = await fixture.pgDatabase.query<{
      version: number;
    }>(
      `select version from bakery.job_attempts where organization_id = $1 and id = $2`,
      [fixture.organizationId, assignment.attemptId],
    );
    assertEquals(
      concurrentVersion.rows[0].version,
      firstVersion.rows[0].version + 1,
    );
  }));

Deno.test("heartbeat authority is sampled after the worker-host lock wait", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-heartbeat-clock-authority",
    });
    const sleep = (milliseconds: number): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, milliseconds);
      return promise;
    };
    await withWorkerHostLock(
      fixture.runtimePgDatabase,
      worker.registration.workerHostId,
      async (release) => {
        const lockClock = await fixture.runtimePgDatabase.query<{
          now: Date;
        }>("select clock_timestamp() as now");
        const lockHeldAt = lockClock.rows[0]?.now;
        if (!lockHeldAt) throw new Error("WORKER_HOST_LOCK_TIME_MISSING");
        const heartbeat = workerRequest(
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
        await waitForWorkerHostLockWait(fixture.runtimePgDatabase);
        await sleep(250);
        await release();
        const response = await heartbeat;
        assertEquals(response.status, 200);
        const body = await response.json() as {
          receivedAt: string;
          serverTime: string;
        };
        assertEquals(body.receivedAt, body.serverTime);
        const serverTime = Date.parse(body.serverTime);
        assert(
          serverTime >= new Date(lockHeldAt).getTime() + 100,
          "heartbeat serverTime must follow the held host-lock interval",
        );
        const persisted = await fixture.pgDatabase.query<{
          lastHeartbeatAt: Date;
        }>(
          `select last_heartbeat_at as "lastHeartbeatAt"
         from bakery.worker_hosts
        where id = $1`,
          [worker.registration.workerHostId],
        );
        const lastHeartbeatAt = persisted.rows[0]?.lastHeartbeatAt;
        if (!lastHeartbeatAt) {
          throw new Error("WORKER_HEARTBEAT_TIME_NOT_PERSISTED");
        }
        assertEquals(
          new Date(lastHeartbeatAt).getTime(),
          serverTime,
        );
      },
    );
  }));
