import { assert, assertEquals } from "@std/assert";
import {
  closeWorkerFixture,
  closeWorkerScope,
  createWorkerScope,
  expireAndSupersedeAttempt,
  openWorkerFixture,
  problemCode,
  readExecutionState,
  registeredWorker,
  seedFundedModelJob,
  updateAttemptExpiry,
  workerCredential,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  eventBody,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import type { WorkerScope } from "../helpers/worker-execution.ts";
import type { AttemptRow } from "../../packages/persistence/src/types.ts";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import { validateWorkerReferences } from "../../packages/persistence/src/event-journal.ts";

Deno.test("execution grants match the worker SQL operations", () =>
  withWorkerFixture(async (fixture) => {
    const privileges = await fixture.pgDatabase.query<{
      jobsSelect: boolean;
      jobsInsert: boolean;
      jobsUpdate: boolean;
      jobsDelete: boolean;
      renewalSelect: boolean;
      renewalInsert: boolean;
      renewalUpdate: boolean;
      renewalDelete: boolean;
      sessionsSelect: boolean;
      sessionsInsert: boolean;
      sessionsUpdate: boolean;
      sessionsDelete: boolean;
      commandAckTombstoneDelete: boolean;
    }>(
      `select
     has_table_privilege('bakery_app', 'bakery.jobs', 'SELECT') as "jobsSelect",
     has_table_privilege('bakery_app', 'bakery.jobs', 'INSERT') as "jobsInsert",
     has_table_privilege('bakery_app', 'bakery.jobs', 'UPDATE') as "jobsUpdate",
     has_table_privilege('bakery_app', 'bakery.jobs', 'DELETE') as "jobsDelete",
     has_table_privilege(
       'bakery_app', 'bakery.worker_lease_renewal_replays', 'SELECT'
     ) as "renewalSelect",
     has_table_privilege(
       'bakery_app', 'bakery.worker_lease_renewal_replays', 'INSERT'
     ) as "renewalInsert",
     has_table_privilege(
       'bakery_app', 'bakery.worker_lease_renewal_replays', 'UPDATE'
     ) as "renewalUpdate",
     has_table_privilege(
       'bakery_app', 'bakery.worker_lease_renewal_replays', 'DELETE'
     ) as "renewalDelete",
     has_table_privilege(
       'bakery_app', 'bakery.agent_sessions', 'SELECT'
     ) as "sessionsSelect",
     has_table_privilege(
       'bakery_app', 'bakery.agent_sessions', 'INSERT'
     ) as "sessionsInsert",
     has_table_privilege(
       'bakery_app', 'bakery.agent_sessions', 'UPDATE'
     ) as "sessionsUpdate",
     has_table_privilege(
       'bakery_app', 'bakery.agent_sessions', 'DELETE'
     ) as "sessionsDelete",
     has_table_privilege(
       'bakery_app', 'bakery.worker_command_ack_tombstones', 'DELETE'
     ) as "commandAckTombstoneDelete"`,
    );
    assertEquals(privileges.rows[0], {
      jobsSelect: true,
      jobsInsert: false,
      jobsUpdate: false,
      jobsDelete: false,
      renewalSelect: true,
      renewalInsert: false,
      renewalUpdate: false,
      renewalDelete: true,
      sessionsSelect: true,
      sessionsInsert: false,
      sessionsUpdate: false,
      sessionsDelete: false,
      commandAckTombstoneDelete: true,
    });

    const broadMutationPrivileges = await fixture.pgDatabase.query<{
      broad: string[];
    }>(
      `with mutation_privileges(table_name, privilege) as (
     values
       ('bakery.worker_enrollments'::text, 'INSERT'::text),
       ('bakery.worker_enrollments', 'UPDATE'),
       ('bakery.worker_enrollment_replays', 'INSERT'),
       ('bakery.worker_enrollment_replays', 'UPDATE'),
       ('bakery.worker_hosts', 'INSERT'),
       ('bakery.worker_hosts', 'UPDATE'),
       ('bakery.worker_registration_replays', 'INSERT'),
       ('bakery.worker_registration_replays', 'UPDATE'),
       ('bakery.agent_sessions', 'INSERT'),
       ('bakery.agent_sessions', 'UPDATE'),
       ('bakery.jobs', 'INSERT'),
       ('bakery.jobs', 'UPDATE'),
       ('bakery.job_attempts', 'INSERT'),
       ('bakery.job_attempts', 'UPDATE'),
       ('bakery.attempt_events', 'INSERT'),
       ('bakery.attempt_events', 'UPDATE'),
       ('bakery.worker_claim_replays', 'INSERT'),
       ('bakery.worker_claim_replays', 'UPDATE'),
       ('bakery.worker_lease_renewal_replays', 'INSERT'),
       ('bakery.worker_lease_renewal_replays', 'UPDATE'),
       ('bakery.worker_heartbeat_replays', 'INSERT'),
       ('bakery.worker_heartbeat_replays', 'UPDATE'),
       ('bakery.worker_commands', 'INSERT'),
       ('bakery.worker_commands', 'UPDATE'),
       ('bakery.worker_command_ack_tombstones', 'INSERT'),
       ('bakery.worker_command_ack_tombstones', 'UPDATE')
   )
   select coalesce(
     array_agg(table_name || ':' || privilege order by table_name, privilege),
     '{}'::text[]
   ) as broad
   from mutation_privileges
   where has_table_privilege('bakery_app', table_name, privilege)`,
    );
    assertEquals(broadMutationPrivileges.rows[0].broad, []);

    const expectedColumns = await fixture.pgDatabase.query<{
      missing: string[];
    }>(
      `with expected(table_name, column_name, privilege) as (
     values
       ('bakery.worker_enrollments', 'organization_id', 'INSERT'),
       ('bakery.worker_enrollments', 'principal_id', 'INSERT'),
       ('bakery.worker_enrollments', 'name', 'INSERT'),
       ('bakery.worker_enrollments', 'os', 'INSERT'),
       ('bakery.worker_enrollments', 'architecture', 'INSERT'),
       ('bakery.worker_enrollments', 'allowed_capabilities', 'INSERT'),
       ('bakery.worker_enrollments', 'slots', 'INSERT'),
       ('bakery.worker_enrollments', 'token_hash', 'INSERT'),
       ('bakery.worker_enrollments', 'expires_at', 'INSERT'),
       ('bakery.worker_enrollments', 'consumed_at', 'UPDATE'),
       ('bakery.worker_enrollments', 'worker_host_id', 'UPDATE'),
       ('bakery.worker_enrollments', 'updated_at', 'UPDATE'),
       ('bakery.worker_enrollments', 'version', 'UPDATE'),
       ('bakery.worker_enrollment_replays', 'organization_id', 'INSERT'),
       ('bakery.worker_enrollment_replays', 'principal_id', 'INSERT'),
       ('bakery.worker_enrollment_replays', 'idempotency_key', 'INSERT'),
       ('bakery.worker_enrollment_replays', 'request_digest', 'INSERT'),
       ('bakery.worker_enrollment_replays', 'response_ciphertext', 'INSERT'),
       ('bakery.worker_enrollment_replays', 'expires_at', 'INSERT'),
       ('bakery.worker_hosts', 'organization_id', 'INSERT'),
       ('bakery.worker_hosts', 'principal_id', 'INSERT'),
       ('bakery.worker_hosts', 'name', 'INSERT'),
       ('bakery.worker_hosts', 'os', 'INSERT'),
       ('bakery.worker_hosts', 'architecture', 'INSERT'),
       ('bakery.worker_hosts', 'capabilities', 'INSERT'),
       ('bakery.worker_hosts', 'toolchain_versions', 'INSERT'),
       ('bakery.worker_hosts', 'slots', 'INSERT'),
       ('bakery.worker_hosts', 'credential_hash', 'INSERT'),
       ('bakery.worker_hosts', 'credential_generation', 'INSERT'),
       ('bakery.worker_hosts', 'protocol_version', 'INSERT'),
       ('bakery.worker_hosts', 'worker_session_id', 'INSERT'),
       ('bakery.worker_hosts', 'worker_session_generation', 'INSERT'),
       ('bakery.worker_hosts', 'worker_session_id', 'UPDATE'),
       ('bakery.worker_hosts', 'worker_session_generation', 'UPDATE'),
       ('bakery.worker_hosts', 'last_heartbeat_at', 'UPDATE'),
       ('bakery.worker_hosts', 'status', 'UPDATE'),
       ('bakery.worker_hosts', 'updated_at', 'UPDATE'),
       ('bakery.worker_hosts', 'version', 'UPDATE'),
       ('bakery.worker_hosts', 'desired_mode', 'UPDATE'),
       ('bakery.worker_hosts', 'inventory_revision', 'UPDATE'),
       ('bakery.worker_hosts', 'readiness_revision', 'UPDATE'),
       ('bakery.worker_hosts', 'credential_hash', 'UPDATE'),
       ('bakery.worker_hosts', 'credential_generation', 'UPDATE'),
       ('bakery.worker_registration_replays', 'enrollment_id', 'INSERT'),
       ('bakery.worker_registration_replays', 'idempotency_key', 'INSERT'),
       ('bakery.worker_registration_replays', 'request_digest', 'INSERT'),
       ('bakery.worker_registration_replays', 'worker_host_id', 'INSERT'),
       ('bakery.worker_registration_replays', 'principal_id', 'INSERT'),
       ('bakery.worker_registration_replays', 'registration_generation', 'INSERT'),
       ('bakery.worker_registration_replays', 'response', 'INSERT'),
       ('bakery.worker_registration_replays', 'expires_at', 'INSERT'),
       ('bakery.agent_sessions', 'organization_id', 'INSERT'),
       ('bakery.agent_sessions', 'run_step_id', 'INSERT'),
       ('bakery.agent_sessions', 'conversation_id', 'INSERT'),
       ('bakery.agent_sessions', 'agent_version_id', 'INSERT'),
       ('bakery.agent_sessions', 'harness', 'INSERT'),
       ('bakery.agent_sessions', 'status', 'INSERT'),
       ('bakery.jobs', 'agent_version_id', 'INSERT'),
       ('bakery.jobs', 'agent_config', 'INSERT'),
       ('bakery.jobs', 'skill_refs', 'INSERT'),
       ('bakery.jobs', 'billing', 'INSERT'),
       ('bakery.jobs', 'installation_reservation_id', 'INSERT'),
       ('bakery.jobs', 'status', 'UPDATE'),
       ('bakery.jobs', 'current_fence', 'UPDATE'),
       ('bakery.jobs', 'updated_at', 'UPDATE'),
       ('bakery.jobs', 'version', 'UPDATE'),
       ('bakery.job_attempts', 'organization_id', 'INSERT'),
       ('bakery.job_attempts', 'job_id', 'INSERT'),
       ('bakery.job_attempts', 'worker_host_id', 'INSERT'),
       ('bakery.job_attempts', 'worker_session_id', 'INSERT'),
       ('bakery.job_attempts', 'worker_session_generation', 'INSERT'),
       ('bakery.job_attempts', 'attempt_no', 'INSERT'),
       ('bakery.job_attempts', 'fence', 'INSERT'),
       ('bakery.job_attempts', 'lease_token_hash', 'INSERT'),
       ('bakery.job_attempts', 'lease_expires_at', 'INSERT'),
       ('bakery.job_attempts', 'status', 'INSERT'),
       ('bakery.job_attempts', 'worker_session_id', 'UPDATE'),
       ('bakery.job_attempts', 'worker_session_generation', 'UPDATE'),
       ('bakery.job_attempts', 'status', 'UPDATE'),
       ('bakery.job_attempts', 'started_at', 'UPDATE'),
       ('bakery.job_attempts', 'last_event_seq', 'UPDATE'),
       ('bakery.job_attempts', 'lease_expires_at', 'UPDATE'),
       ('bakery.job_attempts', 'result', 'UPDATE'),
       ('bakery.job_attempts', 'ended_at', 'UPDATE'),
       ('bakery.job_attempts', 'updated_at', 'UPDATE'),
       ('bakery.job_attempts', 'version', 'UPDATE'),
       ('bakery.attempt_events', 'organization_id', 'INSERT'),
       ('bakery.attempt_events', 'attempt_id', 'INSERT'),
       ('bakery.attempt_events', 'local_seq', 'INSERT'),
       ('bakery.attempt_events', 'event_id', 'INSERT'),
       ('bakery.attempt_events', 'event_type', 'INSERT'),
       ('bakery.attempt_events', 'payload', 'INSERT'),
       ('bakery.attempt_events', 'payload_digest', 'INSERT'),
       ('bakery.attempt_events', 'saved_ack', 'INSERT'),
       ('bakery.worker_claim_replays', 'organization_id', 'INSERT'),
       ('bakery.worker_claim_replays', 'worker_host_id', 'INSERT'),
       ('bakery.worker_claim_replays', 'claim_key', 'INSERT'),
       ('bakery.worker_claim_replays', 'request_digest', 'INSERT'),
       ('bakery.worker_claim_replays', 'response_status', 'INSERT'),
       ('bakery.worker_claim_replays', 'response_ciphertext', 'INSERT'),
       ('bakery.worker_claim_replays', 'attempt_id', 'INSERT'),
       ('bakery.worker_claim_replays', 'expires_at', 'INSERT'),
       ('bakery.worker_lease_renewal_replays', 'organization_id', 'INSERT'),
       ('bakery.worker_lease_renewal_replays', 'attempt_id', 'INSERT'),
       ('bakery.worker_lease_renewal_replays', 'worker_host_id', 'INSERT'),
       ('bakery.worker_lease_renewal_replays', 'idempotency_key', 'INSERT'),
       ('bakery.worker_lease_renewal_replays', 'request_digest', 'INSERT'),
       ('bakery.worker_lease_renewal_replays', 'response', 'INSERT'),
       ('bakery.worker_lease_renewal_replays', 'expires_at', 'INSERT'),
       ('bakery.worker_heartbeat_replays', 'organization_id', 'INSERT'),
       ('bakery.worker_heartbeat_replays', 'worker_host_id', 'INSERT'),
       ('bakery.worker_heartbeat_replays', 'idempotency_key', 'INSERT'),
       ('bakery.worker_heartbeat_replays', 'request_digest', 'INSERT'),
       ('bakery.worker_heartbeat_replays', 'response_status', 'INSERT'),
       ('bakery.worker_heartbeat_replays', 'response_body', 'INSERT'),
       ('bakery.worker_heartbeat_replays', 'expires_at', 'INSERT'),
       ('bakery.worker_commands', 'status', 'UPDATE'),
       ('bakery.worker_commands', 'acknowledged_at', 'UPDATE'),
       ('bakery.worker_command_ack_tombstones', 'command_id', 'INSERT'),
       ('bakery.worker_command_ack_tombstones', 'organization_id', 'INSERT'),
       ('bakery.worker_command_ack_tombstones', 'worker_host_id', 'INSERT'),
       ('bakery.worker_command_ack_tombstones', 'status', 'INSERT'),
       ('bakery.worker_command_ack_tombstones', 'acknowledged_at', 'INSERT'),
       ('bakery.worker_command_ack_tombstones', 'expires_at', 'INSERT')
   )
   select coalesce(
     array_agg(
       format('%s.%s:%s', table_name, column_name, privilege)
       order by table_name, column_name, privilege
     ) filter (
       where not has_column_privilege(
         'bakery_app', table_name, column_name, privilege
       )
     ),
     '{}'::text[]
   ) as missing
   from expected`,
    );
    assertEquals(expectedColumns.rows[0].missing, []);

    const forbiddenColumns = await fixture.pgDatabase.query<{
      granted: string[];
    }>(
      `with forbidden(table_name, column_name, privilege) as (
     values
       ('bakery.worker_enrollments', 'organization_id', 'UPDATE'),
       ('bakery.worker_enrollments', 'allowed_capabilities', 'UPDATE'),
       ('bakery.worker_enrollments', 'token_hash', 'UPDATE'),
       ('bakery.worker_hosts', 'organization_id', 'UPDATE'),
       -- credential_hash UPDATE is granted for re-pair rotation
       -- (packages/persistence/src/worker-session.ts re-pair branch, 0124).
       ('bakery.worker_hosts', 'capabilities', 'UPDATE'),
       ('bakery.jobs', 'organization_id', 'UPDATE'),
       ('bakery.jobs', 'input', 'UPDATE'),
       ('bakery.jobs', 'requirements', 'UPDATE'),
       ('bakery.jobs', 'billing', 'UPDATE'),
       ('bakery.jobs', 'installation_reservation_id', 'UPDATE'),
       ('bakery.job_attempts', 'organization_id', 'UPDATE'),
       ('bakery.job_attempts', 'job_id', 'UPDATE'),
       ('bakery.job_attempts', 'lease_token_hash', 'UPDATE'),
       ('bakery.worker_commands', 'organization_id', 'UPDATE'),
       ('bakery.worker_commands', 'attempt_id', 'UPDATE'),
       ('bakery.worker_commands', 'payload', 'UPDATE'),
       ('bakery.attempt_events', 'occurred_at', 'INSERT'),
       ('bakery.agent_sessions', 'id', 'INSERT'),
       ('bakery.worker_command_ack_tombstones', 'created_at', 'INSERT')
   )
   select coalesce(
     array_agg(
       format('%s.%s:%s', table_name, column_name, privilege)
       order by table_name, column_name, privilege
     ) filter (
       where has_column_privilege(
         'bakery_app', table_name, column_name, privilege
       )
     ),
     '{}'::text[]
   ) as granted
   from forbidden`,
    );
    assertEquals(forbiddenColumns.rows[0].granted, []);

    const runtimeUser = await fixture.runtimePgDatabase.query<{
      currentUser: string;
    }>('select current_user as "currentUser"');
    assertEquals(runtimeUser.rows[0].currentUser, "bakery_app");
  }));

Deno.test("wrong worker credentials, host, lease token, and fence cannot mutate an attempt", () =>
  withWorkerFixture(async (fixture) => {
    const owner = await registeredWorker(fixture, {
      name: "issue39-security-owner",
    });
    const foreign = await registeredWorker(fixture, {
      name: "issue39-security-foreign",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, owner, { claimKey });
    const baseline = await readExecutionState(fixture.pgDatabase, job.jobId);

    const wrongCredentialEventId = crypto.randomUUID();
    const wrongCredential = await workerRequest(
      fixture,
      workerCredential(),
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, wrongCredentialEventId),
      { idempotencyKey: wrongCredentialEventId },
    );
    assert([401, 403].includes(wrongCredential.status));
    assert(
      ["AUTH_REQUIRED", "AUTH_FORBIDDEN"].includes(
        await problemCode(wrongCredential),
      ),
    );
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      baseline,
    );

    const wrongHostEventId = crypto.randomUUID();
    const wrongHost = await workerRequest(
      fixture,
      foreign.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, wrongHostEventId),
      { idempotencyKey: wrongHostEventId },
    );
    assert(wrongHost.status >= 400 && wrongHost.status < 500);
    assert(
      ["AUTH_FORBIDDEN", "LEASE_FENCED", "RESOURCE_NOT_FOUND"].includes(
        await problemCode(wrongHost),
      ),
    );
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      baseline,
    );

    const wrongTokenEventId = crypto.randomUUID();
    const wrongToken = await workerRequest(
      fixture,
      owner.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        ...eventBody(assignment, wrongTokenEventId),
        leaseToken: "wrong-lease-token",
      },
      { idempotencyKey: wrongTokenEventId },
    );
    assertEquals(wrongToken.status, 409);
    assertEquals(await problemCode(wrongToken), "LEASE_FENCED");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      baseline,
    );

    const wrongFenceEventId = crypto.randomUUID();
    const wrongFence = await workerRequest(
      fixture,
      owner.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        ...eventBody(assignment, wrongFenceEventId),
        fence: (BigInt(assignment.fence) + 1n).toString(),
      },
      { idempotencyKey: wrongFenceEventId },
    );
    assertEquals(wrongFence.status, 409);
    assertEquals(await problemCode(wrongFence), "LEASE_FENCED");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      baseline,
    );
  }));

Deno.test("delayed old worker sessions cannot reclaim a newer heartbeat takeover", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-security-session-order",
    });
    const replacementSessionId = crypto.randomUUID();
    const replacementBody = {
      workerHostId: worker.registration.workerHostId,
      observedAt: "2026-09-20T00:00:00.000Z",
      load: 0,
      activeAttemptIds: [],
      ackCommandIds: [],
      rejectedCommandIds: [],
      workerSessionId: replacementSessionId,
      workerSessionGeneration: worker.registration.workerSessionGeneration,
    };
    const replacement = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      replacementBody,
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(replacement.status, 200);
    const replacementResult = await replacement.json() as {
      workerSessionGeneration: string;
    };
    const delayed = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        ...replacementBody,
        workerSessionId: worker.registration.workerSessionId,
        workerSessionGeneration: worker.registration.workerSessionGeneration,
      },
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(delayed.status, 409);
    assertEquals(await problemCode(delayed), "LEASE_FENCED");
    const host = await fixture.pgDatabase.query<{
      workerSessionId: string;
      workerSessionGeneration: string;
    }>(
      `select worker_session_id as "workerSessionId",
          worker_session_generation::text as "workerSessionGeneration"
     from bakery.worker_hosts
    where id = $1`,
      [worker.registration.workerHostId],
    );
    assertEquals(host.rows[0], {
      workerSessionId: replacementSessionId,
      workerSessionGeneration: replacementResult.workerSessionGeneration,
    });
  }));

Deno.test("renewal replays require the current session and binding after takeover", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-security-renewal-session",
    });
    await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    const renewalKey = crypto.randomUUID();
    const renewalBody = {
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
      leaseSeconds: 30,
    };
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
      renewalBody,
      { idempotencyKey: renewalKey },
    );
    assertEquals(first.status, 200);
    const firstRaw = new Uint8Array(await first.arrayBuffer());
    const replacementSessionId = crypto.randomUUID();
    const replacement = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: worker.registration.workerHostId,
        observedAt: "2026-09-20T00:00:00.000Z",
        load: 0,
        activeAttemptIds: [assignment.attemptId],
        ackCommandIds: [],
        rejectedCommandIds: [],
        workerSessionId: replacementSessionId,
        workerSessionGeneration: worker.registration.workerSessionGeneration,
      },
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(replacement.status, 200);
    const replacementBody = await replacement.json() as {
      workerSessionGeneration: string;
      reconciledAttemptIds: string[];
    };
    assertEquals(replacementBody.reconciledAttemptIds, [
      assignment.attemptId,
    ]);
    await updateAttemptExpiry(fixture.pgDatabase, assignment.attemptId);
    const oldReplay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
      {
        ...renewalBody,
        workerSessionId: worker.registration.workerSessionId,
        workerSessionGeneration: worker.registration.workerSessionGeneration,
      },
      {
        idempotencyKey: renewalKey,
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(oldReplay.status, 409);
    assertEquals(await problemCode(oldReplay), "LEASE_FENCED");
    const currentReplay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
      {
        ...renewalBody,
        workerSessionId: replacementSessionId,
        workerSessionGeneration: replacementBody.workerSessionGeneration,
      },
      {
        idempotencyKey: renewalKey,
        includeWorkerSession: false,
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(currentReplay.status, 200);
    assertEquals(currentReplay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(new Uint8Array(await currentReplay.arrayBuffer()), firstRaw);
  }));
Deno.test("an expired or superseded unseen result is rejected without journal or lifecycle transitions", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-security-stale",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    await expireAndSupersedeAttempt(fixture.pgDatabase, job.jobId);
    const superseded = await readExecutionState(fixture.pgDatabase, job.jobId);
    const result = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      {
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
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(result.status, 409);
    assert(
      ["LEASE_FENCED", "LEASE_EXPIRED"].includes(await problemCode(result)),
    );
    assertEquals(
      await readExecutionState(fixture.pgDatabase, job.jobId),
      superseded,
    );
    assertEquals(superseded.events, []);
    assertEquals(superseded.attempts.length, 1);
    assertEquals(superseded.attempts[0].lastEventSeq, "0");
  }));

Deno.test("worker attempts, hosts, and lease renewals cannot cross organization boundaries", async () => {
  const fixture = await openWorkerFixture();
  let foreignScope: WorkerScope | undefined;
  try {
    foreignScope = await createWorkerScope(
      fixture,
      "issue39-foreign",
      fixture,
    );
    const owner = await registeredWorker(fixture, {
      name: "issue39-security-org-owner",
    });
    const foreign = await registeredWorker(fixture, {
      name: "issue39-security-org-foreign",
      scope: foreignScope,
    });
    const foreignJob = await seedFundedModelJob(
      fixture.pgDatabase,
      foreignScope.organizationId,
      foreignScope.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, foreign, { claimKey });
    const baseline = await readExecutionState(
      fixture.pgDatabase,
      foreignJob.jobId,
    );

    const hostClaimKey = crypto.randomUUID();
    const hostMismatch = await workerRequest(
      fixture,
      owner.credential,
      "/v1/worker/claims",
      {
        claimKey: hostClaimKey,
        workerHostId: foreign.registration.workerHostId,
        capabilities: ["git"],
      },
      { idempotencyKey: hostClaimKey },
    );
    assertEquals(hostMismatch.status, 403);
    assertEquals(await problemCode(hostMismatch), "AUTH_FORBIDDEN");

    const foreignEventId = crypto.randomUUID();
    const event = await workerRequest(
      fixture,
      owner.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, foreignEventId),
      { idempotencyKey: foreignEventId },
    );
    assertEquals(event.status, 404);
    assertEquals(await problemCode(event), "RESOURCE_NOT_FOUND");

    const renewal = await workerRequest(
      fixture,
      owner.credential,
      `/v1/worker/attempts/${assignment.attemptId}/lease-renewals`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        leaseSeconds: 10,
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(renewal.status, 404);
    assertEquals(await problemCode(renewal), "RESOURCE_NOT_FOUND");

    const result = await workerRequest(
      fixture,
      owner.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      {
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
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(result.status, 404);
    assertEquals(await problemCode(result), "RESOURCE_NOT_FOUND");
    assertEquals(
      await readExecutionState(fixture.pgDatabase, foreignJob.jobId),
      baseline,
    );
  } finally {
    if (foreignScope) {
      await closeWorkerScope(fixture, foreignScope);
    }
    await closeWorkerFixture(fixture);
  }
});

Deno.test("duplicate event UUIDs are rejected before sequence or journal mutation", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-security-event-id",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    const eventId = crypto.randomUUID();
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      eventBody(assignment, eventId),
      { idempotencyKey: eventId },
    );
    assertEquals(first.status, 200);
    const duplicate = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/events`,
      {
        ...eventBody(assignment, eventId),
        events: [{
          eventId,
          localSeq: "2",
          eventType: "job.accepted",
          payload: { acceptedAt: "2026-09-20T00:00:02.000Z" },
        }],
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(duplicate.status, 422);
    assertEquals(
      await problemCode(duplicate),
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.attempts[0].lastEventSeq, "1");
    assertEquals(state.events.length, 1);
  }));

Deno.test("completed results reject session references outside the run step", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue39-security-result-reference",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimKey = crypto.randomUUID();
    const assignment = await claimAssignment(fixture, worker, { claimKey });
    const result = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/attempts/${assignment.attemptId}/result`,
      {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        localSeq: "1",
        status: "completed",
        result: {
          headSha: `head-${job.jobId}`,
          baseSha: `base-${job.jobId}`,
          sessionId: crypto.randomUUID(),
          artifacts: [],
        },
      },
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(result.status, 404);
    assertEquals(await problemCode(result), "RESOURCE_NOT_FOUND");
    const state = await readExecutionState(fixture.pgDatabase, job.jobId);
    assertEquals(state.attempts[0].lastEventSeq, "0");
    assertEquals(state.events, []);
  }));

Deno.test("free-form result objects do not become artifact references", async () => {
  const organizationId = crypto.randomUUID();
  const runStepId = crypto.randomUUID();
  const queries: string[] = [];
  const transaction = {
    query: (text: string) => {
      queries.push(text);
      if (text.includes("from bakery.jobs job")) {
        return {
          rows: [{
            runId: crypto.randomUUID(),
            runStepId,
            taskId: crypto.randomUUID(),
            jobInput: {},
          }],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as PgTransactionClient;
  const attempt: AttemptRow = {
    id: crypto.randomUUID(),
    organizationId,
    jobId: crypto.randomUUID(),
    workerHostId: crypto.randomUUID(),
    workerSessionId: null,
    workerSessionGeneration: "1",
    fence: "1",
    leaseTokenHash: "a".repeat(64),
    leaseExpiresAt: new Date(),
    leaseExpired: false,
    jobCurrentFence: "1",
    status: "running",
    lastEventSeq: "0",
  };

  await validateWorkerReferences(
    transaction,
    attempt,
    "job.succeeded",
    {
      result: {
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: "not-a-digest",
      },
    },
  );
  assertEquals(queries.length, 1);

  let malformedTerminal: unknown;
  try {
    await validateWorkerReferences(
      transaction,
      attempt,
      "job.succeeded",
      {
        result: {
          artifacts: [{
            artifactId: crypto.randomUUID(),
            versionId: crypto.randomUUID(),
            sha256: "not-a-digest",
          }],
        },
      },
    );
  } catch (error) {
    malformedTerminal = error;
  }
  const malformedTerminalCode = malformedTerminal &&
      typeof malformedTerminal === "object" && "code" in malformedTerminal
    ? malformedTerminal.code
    : undefined;
  assertEquals(malformedTerminalCode, "UNPROCESSABLE");
  assertEquals(queries.length, 1);
  let malformedSingularTerminal: unknown;
  try {
    await validateWorkerReferences(
      transaction,
      attempt,
      "job.succeeded",
      {
        result: {
          artifact: {
            artifactId: crypto.randomUUID(),
            versionId: crypto.randomUUID(),
            sha256: "not-a-digest",
          },
        },
      },
    );
  } catch (error) {
    malformedSingularTerminal = error;
  }
  const malformedSingularTerminalCode = malformedSingularTerminal &&
      typeof malformedSingularTerminal === "object" &&
      "code" in malformedSingularTerminal
    ? malformedSingularTerminal.code
    : undefined;
  assertEquals(malformedSingularTerminalCode, "UNPROCESSABLE");
  assertEquals(queries.length, 1);

  let malformed: unknown;
  try {
    await validateWorkerReferences(
      transaction,
      attempt,
      "job.artifact",
      {
        artifact: {
          artifactId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          sha256: "not-a-digest",
        },
      },
    );
  } catch (error) {
    malformed = error;
  }
  const malformedCode = malformed && typeof malformed === "object" &&
      "code" in malformed
    ? malformed.code
    : undefined;
  assertEquals(malformedCode, "UNPROCESSABLE");
  assertEquals(queries.length, 1);
});
