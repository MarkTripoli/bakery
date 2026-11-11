import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  contractSchemas,
  workerActionCapabilities,
} from "../../packages/contracts/src/contracts.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  createWorkerScope,
  type JobSeed,
  readExecutionState,
  registeredWorker,
  seedEligibleJob,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

type StoredAssignmentFields = {
  action: string;
  requirements: unknown;
  input: unknown;
  currentCheckpoints: unknown;
  agentConfig: unknown;
  skillRefs: unknown;
  agentVersionId: string | null;
  billing: unknown;
  installationReservationId: string | null;
};

type ProblemBody = {
  status?: number;
  code?: string;
  issues?: Array<{ path?: Array<string | number>; code?: string }>;
};

async function storedAssignmentFields(
  database: Parameters<typeof readExecutionState>[0],
  jobId: string,
): Promise<StoredAssignmentFields> {
  const result = await database.query<StoredAssignmentFields>(
    `select action, requirements, input,
            current_checkpoints as "currentCheckpoints",
            agent_config as "agentConfig", skill_refs as "skillRefs",
            agent_version_id as "agentVersionId", billing,
            installation_reservation_id as "installationReservationId"
       from bakery.jobs where id = $1`,
    [jobId],
  );
  assertEquals(result.rows.length, 1);
  return structuredClone(result.rows[0]);
}

function assignmentCandidate(
  row: StoredAssignmentFields,
  jobId: string,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
) {
  return {
    jobId,
    attemptId: crypto.randomUUID(),
    workerHostId: worker.registration.workerHostId,
    leaseToken: "candidate-lease-token",
    fence: "1",
    leaseExpiresAt: "2026-09-20T00:00:45.000Z",
    ...row,
    workerSessionId: worker.registration.workerSessionId,
    workerSessionGeneration: worker.registration.workerSessionGeneration,
    leaseDurationSeconds: 45,
    serverTime: "2026-09-20T00:00:00.000Z",
    sealedCredentialOperation: null,
  };
}

function validationPaths(candidate: unknown): string[] {
  const parsed = contractSchemas.JobAssignment.safeParse(candidate);
  assert(!parsed.success, "assignment candidate must fail validation");
  return parsed.error.issues.map((issue) => issue.path.join("."));
}

Deno.test("real authenticated quality.check claim leases NULL-billing work with an immutable payload", () =>
  withWorkerFixture(async (fixture) => {
    const capabilities = [...workerFixtureCapabilities];
    const worker = await registeredWorker(fixture, {
      name: "issue51-real-quality-check-claim",
      capabilities,
    });
    const expectedInput = {
      repositoryId: crypto.randomUUID(),
      revision: "HEAD",
      checks: ["fmt"],
    };
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        priority: 50,
        input: expectedInput,
      },
    );
    const stored = await storedAssignmentFields(fixture.pgDatabase, job.jobId);
    assertEquals(stored.action, "quality.check");
    assertEquals(stored.billing, null);
    assertEquals(stored.installationReservationId, null);
    assertEquals(stored.agentVersionId, null);
    assertEquals(
      contractSchemas.JobAssignment.safeParse(
        assignmentCandidate(stored, job.jobId, worker),
      ).success,
      true,
      "the complete queued quality.check payload must satisfy JobAssignment before claim",
    );

    const claimKey = crypto.randomUUID();
    const response = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities,
        supportedActions: ["quality.check"],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(response.status, 200);
    const assignment = await response.json() as Record<string, unknown>;
    assertEquals(
      contractSchemas.JobAssignment.safeParse(assignment).success,
      true,
    );
    assertMatch(String(assignment.attemptId), /^[0-9a-f-]{36}$/);
    assert(typeof assignment.leaseToken === "string");
    assert((assignment.leaseToken as string).length > 0);
    assertMatch(String(assignment.leaseExpiresAt), /^\d{4}-\d{2}-\d{2}T/);
    assertMatch(String(assignment.serverTime), /^\d{4}-\d{2}-\d{2}T/);
    assertEquals(assignment, {
      jobId: job.jobId,
      attemptId: assignment.attemptId,
      workerHostId: worker.registration.workerHostId,
      leaseToken: assignment.leaseToken,
      fence: "1",
      leaseExpiresAt: assignment.leaseExpiresAt,
      action: "quality.check",
      requirements: stored.requirements,
      input: stored.input,
      currentCheckpoints: stored.currentCheckpoints,
      agentConfig: stored.agentConfig,
      skillRefs: stored.skillRefs,
      agentVersionId: null,
      billing: null,
      installationReservationId: null,
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: worker.registration.workerSessionGeneration,
      leaseDurationSeconds: 45,
      serverTime: assignment.serverTime,
      sealedCredentialOperation: null,
    });

    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.job.status, "leased");
    assertEquals(state.job.currentFence, "1");
    assertEquals(state.attempts.length, 1);
    assertEquals(state.attempts[0]?.id, assignment.attemptId);
    assertEquals(
      state.attempts[0]?.workerHostId,
      worker.registration.workerHostId,
    );
    assertEquals(state.attempts[0]?.status, "leased");
  }));

Deno.test("real claim durably rejects malformed work and reaches valid quality.check", () =>
  withWorkerFixture(async (fixture) => {
    const capabilities = [
      ...new Set([
        ...workerFixtureCapabilities,
        ...workerActionCapabilities("rpi.design"),
      ]),
    ];
    const worker = await registeredWorker(fixture, {
      name: "issue51-transactional-claim-regression",
      capabilities,
    });
    const malformed = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "rpi.design",
        priority: 2,
        input: { researchArtifact: crypto.randomUUID() },
      },
    );
    const valid = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        priority: 1,
        input: {
          repositoryId: crypto.randomUUID(),
          revision: "HEAD",
          checks: ["fmt"],
        },
      },
    );
    const [malformedRow, validRow] = await Promise.all([
      storedAssignmentFields(fixture.pgDatabase, malformed.jobId),
      storedAssignmentFields(fixture.pgDatabase, valid.jobId),
    ]);
    assertEquals(
      contractSchemas.JobAssignment.safeParse(
        assignmentCandidate(validRow, valid.jobId, worker),
      ).success,
      true,
      "the lower-priority valid counterpart must be complete before diagnosing starvation",
    );
    assertEquals(
      validationPaths(
        assignmentCandidate(malformedRow, malformed.jobId, worker),
      ),
      ["agentVersionId", "billing", "installationReservationId"],
    );

    const claim = async (claimKey = crypto.randomUUID()) =>
      await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities,
          supportedActions: ["rpi.design", "quality.check"],
        },
        { idempotencyKey: claimKey },
      );

    const claimKey = crypto.randomUUID();
    const first = await claim(claimKey);
    assertEquals(first.status, 200);
    const assignment = await first.json() as Record<string, unknown>;
    assertEquals(assignment.action, "quality.check");
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, valid.jobId)).job.status,
      "leased",
    );
    const malformedState = await readExecutionState(
      fixture.pgDatabase,
      malformed.jobId,
    );
    assertEquals(malformedState.job.status, "failed");
    assertEquals(malformedState.job.currentFence, "1");
    assertEquals(malformedState.attempts, []);
    assertEquals(malformedState.step.error, {
      code: "INVALID_ASSIGNMENT_PAYLOAD",
      message: "Queued assignment payload is invalid.",
    });

    const audit = await fixture.pgDatabase.query<{
      outcome: string;
      details: Record<string, unknown>;
    }>(
      `select outcome, details from bakery.audit_events
        where organization_id = $1 and resource_id = $2`,
      [fixture.organizationId, malformed.jobId],
    );
    assertEquals(audit.rows.length, 1);
    assertEquals(audit.rows[0]?.outcome, "denied");
    assertEquals(audit.rows[0]?.details.code, "INVALID_ASSIGNMENT_PAYLOAD");
    const domainEvents = await fixture.pgDatabase.query<{ eventType: string }>(
      `select event_type as "eventType" from bakery.domain_events
        where organization_id = $1 order by organization_sequence`,
      [fixture.organizationId],
    );
    assert(
      domainEvents.rows.some((event) => event.eventType === "run.updated"),
    );
    assert(
      domainEvents.rows.some((event) => event.eventType === "tasks.updated"),
    );

    const replay = await claim(claimKey);
    assertEquals(replay.status, 200);
    assertEquals(
      (await replay.json() as Record<string, unknown>).attemptId,
      assignment.attemptId,
    );

    const later = await claim();
    assertEquals(later.status, 204);
    const attempts = await fixture.pgDatabase.query<{ jobId: string }>(
      `select job_id as "jobId" from bakery.job_attempts
         where organization_id = $1 order by created_at, id`,
      [fixture.organizationId],
    );
    assertEquals(attempts.rows.map((row) => row.jobId), [valid.jobId]);
  }));

Deno.test("authenticated claim disposes legacy agent-policy and wrong-input jobs before valid work", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue51-legacy-policy-claim",
    });
    const restricted = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        priority: 3,
        input: {
          repositoryId: crypto.randomUUID(),
          revision: "HEAD",
          checks: ["fmt"],
        },
        agentConfig: {
          harness: "pi",
          skillBindings: {},
          allowedCapabilities: ["git"],
        },
      },
    );
    const wrongInput = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        priority: 2,
        input: { researchArtifact: crypto.randomUUID() },
      },
    );
    const valid = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        priority: 1,
        input: {
          repositoryId: crypto.randomUUID(),
          revision: "HEAD",
          checks: ["fmt"],
        },
      },
    );
    assertEquals(
      contractSchemas.JobAssignment.safeParse(
        assignmentCandidate(
          await storedAssignmentFields(fixture.pgDatabase, restricted.jobId),
          restricted.jobId,
          worker,
        ),
      ).success,
      true,
      "the restricted immutable agent is structurally valid, not a malformed assignment",
    );
    const claimKey = crypto.randomUUID();
    const claimBody = {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
      supportedActions: ["quality.check"],
    };
    const first = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      claimBody,
      { idempotencyKey: claimKey },
    );
    assertEquals(first.status, 200, await first.clone().text());
    const assignment = await first.json() as {
      jobId: string;
      attemptId: string;
    };
    assertEquals(assignment.jobId, valid.jobId);
    const replay = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      claimBody,
      { idempotencyKey: claimKey },
    );
    assertEquals(replay.status, 200);
    assertEquals(
      (await replay.json() as { attemptId: string }).attemptId,
      assignment.attemptId,
    );
    for (const rejected of [restricted, wrongInput]) {
      const state = await readExecutionState(
        fixture.pgDatabase,
        rejected.jobId,
      );
      assertEquals(state.job.status, "failed");
      assertEquals(state.job.currentFence, "1");
      assertEquals(state.attempts, []);
      assertEquals(state.step.error, {
        code: "INVALID_ASSIGNMENT_PAYLOAD",
        message: "Queued assignment payload is invalid.",
      });
      const audit = await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count from bakery.audit_events
          where organization_id = $1 and resource_id = $2
            and details->>'code' = 'INVALID_ASSIGNMENT_PAYLOAD'`,
        [fixture.organizationId, rejected.jobId],
      );
      assertEquals(audit.rows[0]?.count, "1");
    }
  }));

Deno.test("claim replay and pending-claim heartbeat reject a canonically restricted legacy agent", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue51-legacy-policy-rebind",
    });
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        input: {
          repositoryId: crypto.randomUUID(),
          revision: "HEAD",
          checks: ["fmt"],
        },
        agentConfig: {
          harness: "pi",
          skillBindings: {},
          allowedCapabilities: [...workerActionCapabilities("quality.check")],
        },
      },
    );
    const claimKey = crypto.randomUUID();
    const claimBody = {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: workerFixtureCapabilities,
      supportedActions: ["quality.check"],
    };
    const first = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      claimBody,
      { idempotencyKey: claimKey },
    );
    assertEquals(first.status, 200, await first.clone().text());
    await first.arrayBuffer();

    // Model a pre-upgrade leased row. All immutable projections and digests
    // agree; only the explicit agent capability policy denies this action.
    const restricted = {
      harness: "pi",
      skillBindings: {},
      allowedCapabilities: ["git"],
    };
    const digest = await sha256Hex(canonicalJson(restricted));
    const agentVersionId =
      (await storedAssignmentFields(fixture.pgDatabase, job.jobId))
        .agentVersionId;
    assert(agentVersionId !== null);
    await fixture.pgDatabase.query(
      `update bakery.agent_versions set config = $3::jsonb, digest = $4
        where organization_id = $1 and id = $2`,
      [
        fixture.organizationId,
        agentVersionId,
        JSON.stringify(restricted),
        digest,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = jsonb_set(
            jsonb_set(snapshot, '{stepAgents,worker,config}', $3::jsonb),
            '{stepAgents,worker,digest}', to_jsonb($4::text))
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.runId, JSON.stringify(restricted), digest],
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs set agent_config = $3::jsonb
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, job.jobId, JSON.stringify(restricted)],
    );
    const before = await readExecutionState(fixture.pgDatabase, job.jobId);
    const replay = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      claimBody,
      { idempotencyKey: claimKey },
    );
    assertEquals(replay.status, 409, await replay.clone().text());
    assertEquals((await replay.json() as ProblemBody).code, "STATE_CONFLICT");
    const heartbeat = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        observedAt: new Date().toISOString(),
        load: 0,
        activeAttemptIds: [],
        ackCommandIds: [],
        rejectedCommandIds: [],
        pendingClaimKey: claimKey,
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: worker.registration.workerSessionGeneration,
      },
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(heartbeat.status, 409, await heartbeat.clone().text());
    assertEquals(
      (await heartbeat.json() as ProblemBody).code,
      "STATE_CONFLICT",
    );
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, job.jobId)).attempts,
      before.attempts,
    );
    const host = await fixture.pgDatabase.query<{
      session: string;
      generation: string;
    }>(
      `select worker_session_id as session, worker_session_generation::text as generation
         from bakery.worker_hosts where organization_id = $1 and id = $2`,
      [fixture.organizationId, worker.registration.workerHostId],
    );
    assertEquals(host.rows[0], {
      session: worker.registration.workerSessionId,
      generation: String(worker.registration.workerSessionGeneration),
    });
  }));

Deno.test("invalid-only claim durably fails, replays, and stays attempt-free", () =>
  withWorkerFixture(async (fixture) => {
    const capabilities = [
      ...new Set([
        ...workerFixtureCapabilities,
        ...workerActionCapabilities("rpi.design"),
      ]),
    ];
    const worker = await registeredWorker(fixture, {
      name: "issue51-invalid-only-claim-replay",
      capabilities,
    });
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "rpi.design",
        priority: 50,
        input: { researchArtifact: crypto.randomUUID() },
      },
    );
    const stored = await storedAssignmentFields(fixture.pgDatabase, job.jobId);
    assertEquals(
      validationPaths(assignmentCandidate(stored, job.jobId, worker)),
      ["agentVersionId", "billing", "installationReservationId"],
    );

    const claim = async (claimKey: string) =>
      await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities,
          supportedActions: ["rpi.design"],
        },
        { idempotencyKey: claimKey },
      );
    const first = await claim(crypto.randomUUID());
    assertEquals(first.status, 204);
    const afterFirst = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(afterFirst.job, {
      status: "failed",
      currentFence: "1",
      cancelRequestedAt: null,
    });
    assertEquals(afterFirst.run.status, "failed");
    assertEquals(afterFirst.step.status, "failed");
    assertEquals(afterFirst.step.error, {
      code: "INVALID_ASSIGNMENT_PAYLOAD",
      message: "Queued assignment payload is invalid.",
    });
    assertEquals(afterFirst.attempts, []);

    const audit = await fixture.pgDatabase.query<{
      operation: string;
      resourceType: string;
      outcome: string;
      details: Record<string, unknown>;
    }>(
      `select operation, resource_type as "resourceType", outcome, details
         from bakery.audit_events
        where organization_id = $1 and resource_id = $2`,
      [fixture.organizationId, job.jobId],
    );
    assertEquals(audit.rows.length, 1);
    const { details, ...auditRecord } = audit.rows[0]!;
    assertEquals(auditRecord, {
      operation: "workers.claim.assignment_payload_rejected",
      resourceType: "job",
      outcome: "denied",
    });
    assertEquals(Object.keys(details).sort(), [
      "code",
      "invalidFields",
      "version",
    ]);
    assertEquals(details.code, "INVALID_ASSIGNMENT_PAYLOAD");
    // Authorization and structural validation may reject first; neither may
    // persist raw payload values or arbitrary error text in the audit details.
    assert(Array.isArray(details.invalidFields));
    assert(
      details.invalidFields.every((field) =>
        [
          "agentConfig",
          "agentVersionId",
          "billing",
          "installationReservationId",
        ]
          .includes(field)
      ),
    );
    const events = await fixture.pgDatabase.query<{
      eventType: string;
      aggregateId: string;
      aggregateVersion: number;
      payload: Record<string, unknown>;
    }>(
      `select event_type as "eventType", aggregate_id as "aggregateId",
              aggregate_version as "aggregateVersion", payload
         from bakery.domain_events
        where organization_id = $1 and aggregate_id in ($2, $3, $4)
        order by organization_sequence`,
      [fixture.organizationId, job.runId, job.taskId, job.jobId],
    );
    assertEquals(events.rows.length, 2);
    assertEquals(events.rows.map((event) => event.eventType), [
      "run.updated",
      "tasks.updated",
    ]);
    assertEquals(events.rows.map((event) => event.aggregateId), [
      job.runId,
      job.taskId,
    ]);
    assertEquals(events.rows[0]?.aggregateVersion, 2);
    assertEquals(events.rows[0]?.payload.version, 2);
    assertEquals(events.rows[1]?.aggregateVersion, 2);
    assertEquals(events.rows[1]?.payload.resourceVersion, 2);

    const sameKey = await fixture.pgDatabase.query<{ claimKey: string }>(
      `select claim_key as "claimKey" from bakery.worker_claim_replays
        where worker_host_id = $1`,
      [worker.registration.workerHostId],
    );
    assertEquals(sameKey.rows.length, 1);
    const replay = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey: sameKey.rows[0]!.claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities,
        supportedActions: ["rpi.design"],
      },
      { idempotencyKey: sameKey.rows[0]!.claimKey },
    );
    assertEquals(replay.status, 204);
    const newKey = crypto.randomUUID();
    const second = await claim(newKey);
    assertEquals(second.status, 204);
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      afterFirst,
    );
    const replayCount = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.worker_claim_replays
        where worker_host_id = $1`,
      [worker.registration.workerHostId],
    );
    assertEquals(replayCount.rows[0]?.count, "2");
  }));

Deno.test("invalid queued retry emits job.updated for the latest terminal attempt", () =>
  withWorkerFixture(async (fixture) => {
    const capabilities = [
      ...new Set([
        ...workerFixtureCapabilities,
        ...workerActionCapabilities("rpi.design"),
      ]),
    ];
    const worker = await registeredWorker(fixture, {
      name: "issue51-invalid-retry-job-event",
      capabilities,
    });
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "rpi.design",
        input: { researchArtifact: crypto.randomUUID() },
      },
    );
    const terminalAttemptId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.job_attempts (
         id, organization_id, job_id, worker_host_id, worker_session_id,
         worker_session_generation, attempt_no, fence, lease_token_hash,
         lease_expires_at, status, ended_at
       ) values ($1, $2, $3, $4, $5, $6, 1, 1, $7,
                 now() - interval '1 minute', 'lost', now())`,
      [
        terminalAttemptId,
        fixture.organizationId,
        job.jobId,
        worker.registration.workerHostId,
        worker.registration.workerSessionId,
        worker.registration.workerSessionGeneration,
        "issue51-terminal-attempt-hash",
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.jobs set current_fence = 1 where id = $1`,
      [job.jobId],
    );

    const claimKey = crypto.randomUUID();
    const response = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities,
        supportedActions: ["rpi.design"],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(response.status, 204);
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.job.status, "failed");
    assertEquals(state.attempts.length, 1);
    assertEquals(state.attempts[0]?.id, terminalAttemptId);

    const jobVersion = await fixture.pgDatabase.query<{ version: number }>(
      `select version from bakery.jobs where id = $1`,
      [job.jobId],
    );
    const events = await fixture.pgDatabase.query<{
      eventType: string;
      aggregateId: string;
      aggregateVersion: number;
      payload: Record<string, unknown>;
    }>(
      `select event_type as "eventType", aggregate_id as "aggregateId",
              aggregate_version as "aggregateVersion", payload
         from bakery.domain_events
        where organization_id = $1
          and aggregate_id in ($2, $3, $4)
        order by organization_sequence`,
      [fixture.organizationId, job.jobId, job.runId, job.taskId],
    );
    assertEquals(events.rows.map((event) => event.eventType), [
      "job.updated",
      "run.updated",
      "tasks.updated",
    ]);
    assertEquals(events.rows[0]?.aggregateId, job.jobId);
    assertEquals(events.rows[0]?.aggregateVersion, jobVersion.rows[0]?.version);
    assertEquals(events.rows[0]?.payload, {
      jobId: job.jobId,
      attemptId: terminalAttemptId,
      version: jobVersion.rows[0]?.version,
    });
  }));

Deno.test("invalid queue disposition is bounded and fresh claims reach valid work", () =>
  withWorkerFixture(async (fixture) => {
    const capabilities = [
      ...new Set([
        ...workerFixtureCapabilities,
        ...workerActionCapabilities("rpi.design"),
      ]),
    ];
    const worker = await registeredWorker(fixture, {
      name: "issue51-forward-cursor-invalid-prefix",
      capabilities,
    });
    const malformedJobs: JobSeed[] = [];
    for (let index = 0; index < 65; index++) {
      malformedJobs.push(
        await seedEligibleJob(
          fixture.pgDatabase,
          fixture.organizationId,
          fixture.principalId,
          {
            action: index % 2 === 0 ? "rpi.design" : "quality.check",
            priority: 1000 - index,
            input: { researchArtifact: crypto.randomUUID() },
          },
        ),
      );
    }
    const valid = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        priority: 1,
        input: {
          repositoryId: crypto.randomUUID(),
          revision: "HEAD",
          checks: ["fmt"],
        },
      },
    );
    const readMalformedState = () =>
      fixture.pgDatabase.query<{
        id: string;
        status: string;
        attempts: string;
        audits: string;
      }>(
        `select job.id, job.status,
                (select count(*)::text from bakery.job_attempts attempt
                  where attempt.organization_id = job.organization_id
                    and attempt.job_id = job.id) as attempts,
                (select count(*)::text from bakery.audit_events audit
                  where audit.organization_id = job.organization_id
                    and audit.resource_id = job.id::text
                    and audit.operation = 'workers.claim.assignment_payload_rejected') as audits
           from bakery.jobs job
          where job.organization_id = $1 and job.id = any($2::uuid[])
          order by job.priority desc`,
        [fixture.organizationId, malformedJobs.map((job) => job.jobId)],
      );
    const claim = (claimKey: string) =>
      workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities,
          supportedActions: ["rpi.design", "quality.check"],
        },
        { idempotencyKey: claimKey },
      );
    const claimKey = crypto.randomUUID();
    assertEquals((await claim(claimKey)).status, 204);
    const failedState = malformedJobs.map((job) => ({
      id: job.jobId,
      status: "failed",
      attempts: "0",
      audits: "1",
    }));
    const firstState = (await readMalformedState()).rows;
    assertEquals(
      firstState,
      failedState.map((row, index) =>
        index < 64 ? row : { ...row, status: "queued", audits: "0" }
      ),
    );
    assertEquals((await claim(claimKey)).status, 204);
    assertEquals((await readMalformedState()).rows, firstState);

    const response = await claim(crypto.randomUUID());
    assertEquals(response.status, 200);
    assertEquals(
      (await response.json() as Record<string, unknown>).action,
      "quality.check",
    );
    assertEquals((await readMalformedState()).rows, failedState);
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, valid.jobId)).job.status,
      "leased",
    );
  }));

Deno.test("database audit failure returns 500 and rolls back the whole rejection", () =>
  withWorkerFixture(async (fixture) => {
    const capabilities = [
      ...new Set([
        ...workerFixtureCapabilities,
        ...workerActionCapabilities("rpi.design"),
      ]),
    ];
    const worker = await registeredWorker(fixture, {
      name: "issue51-claim-audit-rollback",
      capabilities,
    });
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "rpi.design",
        input: { researchArtifact: crypto.randomUUID() },
      },
    );
    const triggerName = `issue51_raise_audit_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    const functionName = `${triggerName}_fn`;
    await fixture.pgDatabase.query(`
      create function bakery.${functionName}() returns trigger
      language plpgsql as $$ begin
        raise exception 'ISSUE51_INJECTED_AUDIT_FAILURE';
      end; $$;
      create trigger ${triggerName}
      before insert on bakery.audit_events
      for each row execute function bakery.${functionName}();
    `);
    try {
      const before = await fixture.pgDatabase.query(
        `select
           (select status from bakery.jobs where id = $1) as job_status,
           (select version from bakery.jobs where id = $1) as job_version,
           (select current_fence from bakery.jobs where id = $1) as job_fence,
           (select status from bakery.run_steps where id = $2) as step_status,
           (select version from bakery.run_steps where id = $2) as step_version,
           (select status from bakery.workflow_runs where id = $3) as run_status,
           (select version from bakery.workflow_runs where id = $3) as run_version,
           (select status from bakery.tasks where id = $4) as task_status,
           (select version from bakery.tasks where id = $4) as task_version,
           (select count(*) from bakery.audit_events where organization_id = $5) as audit_count,
           (select count(*) from bakery.domain_events where organization_id = $5) as event_count,
           (select count(*) from bakery.worker_claim_replays where worker_host_id = $6) as replay_count,
           (select count(*) from bakery.job_attempts where job_id = $1) as attempt_count`,
        [
          job.jobId,
          job.runStepId,
          job.runId,
          job.taskId,
          fixture.organizationId,
          worker.registration.workerHostId,
        ],
      );
      const claimKey = crypto.randomUUID();
      const response = await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities,
          supportedActions: ["rpi.design"],
        },
        { idempotencyKey: claimKey },
      );
      assertEquals(response.status, 500);
      const after = await fixture.pgDatabase.query(
        `select
           (select status from bakery.jobs where id = $1) as job_status,
           (select version from bakery.jobs where id = $1) as job_version,
           (select current_fence from bakery.jobs where id = $1) as job_fence,
           (select status from bakery.run_steps where id = $2) as step_status,
           (select version from bakery.run_steps where id = $2) as step_version,
           (select status from bakery.workflow_runs where id = $3) as run_status,
           (select version from bakery.workflow_runs where id = $3) as run_version,
           (select status from bakery.tasks where id = $4) as task_status,
           (select version from bakery.tasks where id = $4) as task_version,
           (select count(*) from bakery.audit_events where organization_id = $5) as audit_count,
           (select count(*) from bakery.domain_events where organization_id = $5) as event_count,
           (select count(*) from bakery.worker_claim_replays where worker_host_id = $6) as replay_count,
           (select count(*) from bakery.job_attempts where job_id = $1) as attempt_count`,
        [
          job.jobId,
          job.runStepId,
          job.runId,
          job.taskId,
          fixture.organizationId,
          worker.registration.workerHostId,
        ],
      );
      assertEquals(after.rows, before.rows);
      assertEquals(after.rows[0]?.job_status, "queued");
    } finally {
      await fixture.pgDatabase.query(
        `drop trigger ${triggerName} on bakery.audit_events;
         drop function bakery.${functionName}();`,
      );
    }
  }));

Deno.test("foreign tenant worker cannot dispose another tenant's malformed job", () =>
  withWorkerFixture(async (fixture) => {
    const capabilities = [
      ...new Set([
        ...workerFixtureCapabilities,
        ...workerActionCapabilities("rpi.design"),
      ]),
    ];
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "rpi.design",
        input: { researchArtifact: crypto.randomUUID() },
      },
    );
    const foreignScope = await createWorkerScope(fixture, "issue51-foreign", {
      email: fixture.email,
      principalId: fixture.principalId,
      adminCookie: fixture.adminCookie,
    });
    try {
      const worker = await registeredWorker(fixture, {
        name: "issue51-foreign-tenant-worker",
        capabilities,
        scope: foreignScope,
      });
      const claimKey = crypto.randomUUID();
      const response = await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/claims",
        {
          claimKey,
          workerHostId: worker.registration.workerHostId,
          capabilities,
          supportedActions: ["rpi.design"],
        },
        { idempotencyKey: claimKey },
      );
      assertEquals(response.status, 204);
      const state = await readExecutionState(fixture.pgDatabase, job.jobId);
      assertEquals(state.job.status, "queued");
      assertEquals(state.attempts, []);
      const audit = await fixture.pgDatabase.query(
        `select count(*) from bakery.audit_events
          where organization_id = $1 and resource_id = $2`,
        [fixture.organizationId, job.jobId],
      );
      assertEquals(audit.rows[0]?.count, "0");
    } finally {
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id = $1`,
        [foreignScope.organizationId],
      );
    }
  }));

Deno.test("claim skips live attempts and terminal or superseded workflow work", () =>
  withWorkerFixture(async (fixture) => {
    const capabilities = [...workerFixtureCapabilities];
    const worker = await registeredWorker(fixture, {
      name: "issue51-claim-lifecycle-fences",
      capabilities,
    });
    const live = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "rpi.design",
        input: { researchArtifact: crypto.randomUUID() },
      },
    );
    await fixture.pgDatabase.query(
      `insert into bakery.job_attempts (
         id, organization_id, job_id, worker_host_id, worker_session_id,
         worker_session_generation, attempt_no, fence, lease_token_hash,
         lease_expires_at, status
       ) values ($1, $2, $3, $4, $5, $6, 1, 1, $7, now() + interval '5 minutes', 'leased')`,
      [
        crypto.randomUUID(),
        fixture.organizationId,
        live.jobId,
        worker.registration.workerHostId,
        worker.registration.workerSessionId,
        worker.registration.workerSessionGeneration,
        "synthetic-live-attempt-hash",
      ],
    );
    const terminal = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        input: {
          repositoryId: crypto.randomUUID(),
          revision: "HEAD",
          checks: ["fmt"],
        },
      },
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set status = 'failed', finished_at = now()
        where id = $1`,
      [terminal.runId],
    );
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set status = 'failed', finished_at = now()
        where id = $1`,
      [terminal.runStepId],
    );
    await fixture.pgDatabase.query(
      `update bakery.tasks set status = 'failed' where id = $1`,
      [terminal.taskId],
    );
    const superseded = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "quality.check",
        input: {
          repositoryId: crypto.randomUUID(),
          revision: "HEAD",
          checks: ["fmt"],
        },
      },
    );
    await fixture.pgDatabase.query(
      `update bakery.tasks set current_run_id = $2 where id = $1`,
      [superseded.taskId, terminal.runId],
    );

    const claimKey = crypto.randomUUID();
    const response = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities,
        supportedActions: ["rpi.design", "quality.check"],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(response.status, 204);
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, live.jobId)).job.status,
      "queued",
    );
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, terminal.jobId)).job.status,
      "queued",
    );
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, superseded.jobId)).job
        .status,
      "queued",
    );
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, live.jobId)).attempts
        .length,
      1,
    );
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, terminal.jobId)).attempts,
      [],
    );
    assertEquals(
      (await readExecutionState(fixture.pgDatabase, superseded.jobId)).attempts,
      [],
    );
  }));
