import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { SecretIdentityToolResultSchema } from "../../packages/contracts/src/secret-identity.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
} from "../../apps/server/src/platform/migrate.ts";
import {
  agentsBakeryMigrationSource,
} from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import {
  authBakeryMigrationSource,
} from "../../apps/server/src/modules/auth/migrations.ts";
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import {
  projectsBakeryMigrationSource,
} from "../../apps/server/src/modules/projects/migrations.ts";
import { openSecretsFixture } from "../helpers/secrets.ts";
import {
  registeredWorker,
  seedEligibleJob,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  postWorkerResult,
  resultBody,
  type WorkerAssignment,
} from "../helpers/worker-execution/scenarios.ts";

function asWorkerFixture(
  f: Awaited<ReturnType<typeof openSecretsFixture>>,
): WorkerFixture {
  return {
    app: f.fixture.app,
    pgDatabase: f.fixture.pgDatabase,
    runtimePgDatabase: f.fixture.pgDatabase,
    config: f.fixture.config,
    email: "fixture-owned-by-secrets-helper@example.test",
    organizationId: f.organizationId,
    principalId: f.principalId,
    adminCookie: f.adminCookie,
    ownsAuthIdentity: false,
    workerHostIds: [],
    close: () => Promise.resolve(),
    releaseFixture: () => {},
  };
}

async function createIdentityJob(
  f: Awaited<ReturnType<typeof openSecretsFixture>>,
  fixture: WorkerFixture,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
  options: {
    allowedPrincipalIds?: string[];
    allowedActions?: string[];
    value?: string;
    beforeClaim?: (secret: {
      id: string;
      applicationId: string;
    }) => Promise<void>;
  } = {},
): Promise<{
  assignment: WorkerAssignment;
  secretId: string;
  jobId: string;
  applicationId: string;
}> {
  const placeholder = crypto.randomUUID();
  const job = await seedEligibleJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    {
      action: "secret.identity.read",
      input: { secretRef: placeholder },
    },
  );
  const created = await f.request("/v1/secrets", {
    applicationId: job.applicationId,
    name: `Identity fixture ${job.jobId.slice(0, 8)}`,
    provider: "github",
    value: options.value ??
      `controlled-fixture-token-${crypto.randomUUID()}`,
    allowedPrincipalIds: options.allowedPrincipalIds ?? [fixture.principalId],
    allowedActions: options.allowedActions ?? ["identity.read"],
  }, crypto.randomUUID());
  assertEquals(created.status, 201, await created.clone().text());
  const secret = await created.json() as { id: string };
  await fixture.pgDatabase.query(
    `update bakery.jobs
        set input = jsonb_set(input, '{secretRef}', to_jsonb($2::text), true)
      where organization_id = $1 and id = $3`,
    [fixture.organizationId, secret.id, job.jobId],
  );
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs
        set snapshot = jsonb_set(
          snapshot,
          '{workflow,normalizedSpec,steps,0,with,secretRef}',
          to_jsonb($2::text),
          true
        )
      where organization_id = $1 and id = $3`,
    [fixture.organizationId, secret.id, job.runId],
  );
  await options.beforeClaim?.({
    id: secret.id,
    applicationId: job.applicationId,
  });
  const claimKey = crypto.randomUUID();
  const claimResponse = await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities: ["secret.identity"],
      supportedActions: ["secret.identity.read"],
    },
    { idempotencyKey: claimKey },
  );
  if (claimResponse.status !== 200) {
    const state = await fixture.pgDatabase.query(
      `select job.status, job.action, job.requirements, host.status as host_status,
              host.capabilities, host.desired_mode, host.worker_session_id
         from bakery.jobs job
         cross join bakery.worker_hosts host
        where job.organization_id=$1 and job.id=$2 and host.id=$3`,
      [fixture.organizationId, job.jobId, worker.registration.workerHostId],
    );
    throw new Error(
      `CLAIM_FAILED:${claimResponse.status}:${JSON.stringify(state.rows[0])}`,
    );
  }
  const assignment = await claimResponse.json() as WorkerAssignment;
  assertEquals(assignment.jobId, job.jobId);
  return {
    assignment,
    secretId: secret.id,
    jobId: job.jobId,
    applicationId: job.applicationId,
  };
}

function invokeIdentity(
  fixture: WorkerFixture,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
  assignment: WorkerAssignment,
  sessionId = worker.registration.workerSessionId,
  signal?: AbortSignal,
): Promise<Response> {
  const sealed = assignment.sealedCredentialOperation as {
    preparedOperationId: string;
  };
  const path = `/v1/worker/attempts/${assignment.attemptId}/tools/secrets`;
  const headers = {
    "Idempotency-Key": sealed.preparedOperationId,
    "X-Worker-Session-Id": sessionId,
    "X-Worker-Session-Generation": worker.registration.workerSessionGeneration,
    "X-Worker-Lease-Token": assignment.leaseToken,
    "X-Worker-Fence": assignment.fence,
    "X-Bakery-Worker-Protocol-Version": "2",
  };
  if (!signal) {
    return workerRequest(
      fixture,
      worker.credential,
      path,
      { preparedOperationId: sealed.preparedOperationId },
      {
        idempotencyKey: sealed.preparedOperationId,
        includeWorkerSession: false,
        headers,
      },
    );
  }
  return Promise.resolve(fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}${path}`, {
      method: "POST",
      headers: {
        ...headers,
        authorization: `Bearer ${worker.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ preparedOperationId: sealed.preparedOperationId }),
      signal,
    }),
  ));
}

type IdentityInvocationSettlement =
  | { kind: "resolved"; response: Response }
  | { kind: "rejected"; error: unknown };

function observeIdentityInvocation(
  invoking: Promise<Response>,
): Promise<IdentityInvocationSettlement> {
  return invoking.then(
    (response) => ({ kind: "resolved", response }),
    (error) => ({ kind: "rejected", error }),
  );
}

async function waitForIdentityProviderReady(
  ready: Promise<void>,
  invocation: Promise<IdentityInvocationSettlement>,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    ready.then(() => ({ kind: "ready" }) as const),
    invocation.then((settlement) => ({ kind: "settled", settlement }) as const),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "timeout" }),
        timeoutMilliseconds,
      );
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind === "ready") return;
  if (outcome.kind === "timeout") {
    throw new Error(
      `IDENTITY_PROVIDER_READY_TIMEOUT: provider callback not reached within ${timeoutMilliseconds}ms`,
    );
  }
  if (outcome.settlement.kind === "rejected") {
    const detail = outcome.settlement.error instanceof Error
      ? outcome.settlement.error.message
      : String(outcome.settlement.error);
    throw new Error(
      `IDENTITY_INVOCATION_REJECTED_BEFORE_PROVIDER_READY: ${detail}`,
      { cause: outcome.settlement.error },
    );
  }
  const response = outcome.settlement.response;
  throw new Error(
    `IDENTITY_INVOCATION_RESOLVED_BEFORE_PROVIDER_READY: status=${response.status} body=${await response
      .clone().text()}`,
  );
}

Deno.test("identity overlap readiness reports startup rejection", async () => {
  const ready = Promise.withResolvers<void>();
  const invocation = observeIdentityInvocation(
    Promise.reject(new Error("STARTUP_REJECTED_FOR_TEST")),
  );
  await assertRejects(
    () => waitForIdentityProviderReady(ready.promise, invocation, 50),
    Error,
    "IDENTITY_INVOCATION_REJECTED_BEFORE_PROVIDER_READY: STARTUP_REJECTED_FOR_TEST",
  );
  assertEquals((await invocation).kind, "rejected");
});

Deno.test("fixed secret identity claim seals U-bound authority and route performs one durable provider call", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      capabilities: ["secret.identity"],
    });
    assertNotEquals(worker.registration.principalId, fixture.principalId);
    const { assignment, jobId } = await createIdentityJob(f, fixture, worker);
    assertEquals(assignment.action, "secret.identity.read");
    assert(assignment.sealedCredentialOperation !== null);
    const sealed = assignment.sealedCredentialOperation as {
      preparedOperationId: string;
      expiresAt: string;
    };
    assert(
      new Date(sealed.expiresAt).getTime() <=
        new Date(assignment.leaseExpiresAt as string).getTime(),
    );
    const row = await fixture.pgDatabase.query<{
      requester_id: string;
      assigned_worker_principal_id: string;
      status: string;
    }>(
      `select operation.requester_id,
              host.principal_id as assigned_worker_principal_id,
              operation.status
         from bakery.prepared_operations operation
         join bakery.worker_hosts host
           on host.organization_id = operation.organization_id
          and host.id = operation.worker_host_id
        where operation.id = $1`,
      [sealed.preparedOperationId],
    );
    assertEquals(row.rows[0].requester_id, fixture.principalId);
    assertEquals(
      row.rows[0].assigned_worker_principal_id,
      worker.registration.principalId,
    );
    assertEquals(row.rows[0].status, "prepared");
    const retryBudget = await fixture.pgDatabase.query<{
      max_attempts: number;
    }>(
      "select max_attempts from bakery.jobs where organization_id=$1 and id=$2",
      [fixture.organizationId, jobId],
    );
    assertEquals(retryBudget.rows[0].max_attempts, 1);

    const before = f.calls();
    const response = await invokeIdentity(fixture, worker, assignment);
    assertEquals(response.status, 200);
    assertEquals(SecretIdentityToolResultSchema.parse(await response.json()), {
      status: "completed",
      accountId: "12345",
      login: "fixture-user",
    });
    assertEquals(f.calls(), before + 1);

    const replay = await invokeIdentity(fixture, worker, assignment);
    assertEquals(replay.status, 200);
    assertEquals((await replay.json()).status, "completed");
    assertEquals(f.calls(), before + 1);

    const wrongSession = await invokeIdentity(
      fixture,
      worker,
      assignment,
      crypto.randomUUID(),
    );
    assertEquals(wrongSession.status, 422);
    assertEquals(
      (await wrongSession.json()).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    assertEquals(f.calls(), before + 1);
  } finally {
    await f.cleanup();
  }
});

Deno.test("provider and live account-pin mismatches become uncertain before publication", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      capabilities: ["secret.identity"],
    });

    const providerMismatch = await createIdentityJob(f, fixture, worker);
    f.setProvider(() =>
      Promise.resolve(Response.json({ id: 67890, login: "wrong-account" }))
    );
    const beforeMismatch = f.calls();
    const mismatchResponse = await invokeIdentity(
      fixture,
      worker,
      providerMismatch.assignment,
    );
    assertEquals(mismatchResponse.status, 200);
    const mismatchResult = await mismatchResponse.json();
    assertEquals(mismatchResult, {
      status: "uncertain",
      code: "COMPLETION_AUTHORITY_LOST",
    });
    assertEquals(f.calls(), beforeMismatch + 1);
    assertEquals(
      (await postWorkerResult(
        fixture,
        worker,
        providerMismatch.assignment,
        resultBody(providerMismatch.assignment, { result: mismatchResult }),
        crypto.randomUUID(),
      )).status,
      200,
    );
    const mismatchRow = await fixture.pgDatabase.query<{
      verified_provider_account_id: string;
      status: string;
      safe_result: Record<string, unknown>;
    }>(
      `select verified_provider_account_id, status, safe_result
         from bakery.prepared_operations where job_id = $1`,
      [providerMismatch.jobId],
    );
    assertEquals(mismatchRow.rows[0], {
      verified_provider_account_id: "12345",
      status: "uncertain",
      safe_result: {
        status: "uncertain",
        code: "COMPLETION_AUTHORITY_LOST",
      },
    });

    f.setProvider(() =>
      Promise.resolve(Response.json({ id: 12345, login: "fixture-user" }))
    );
    const changedPin = await createIdentityJob(f, fixture, worker);
    let releasePin!: () => void;
    const pinGate = new Promise<void>((resolve) => releasePin = resolve);
    f.setProvider(async () => {
      await pinGate;
      return Response.json({ id: 12345, login: "fixture-user" });
    });
    const beforePin = f.calls();
    const invokingChangedPin = invokeIdentity(
      fixture,
      worker,
      changedPin.assignment,
    );
    for (let index = 0; index < 100 && f.calls() === beforePin; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(f.calls(), beforePin + 1);
    await fixture.pgDatabase.query(
      `update bakery.secrets set verified_provider_account_id = '99999'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, changedPin.secretId],
    );
    releasePin();
    const changedPinResponse = await invokingChangedPin;
    assertEquals(changedPinResponse.status, 200);
    assertEquals(await changedPinResponse.json(), {
      status: "uncertain",
      code: "COMPLETION_AUTHORITY_LOST",
    });
    assertEquals(f.calls(), beforePin + 1);
    const changedPinRow = await fixture.pgDatabase.query<{
      verified_provider_account_id: string;
      status: string;
    }>(
      `select verified_provider_account_id, status
         from bakery.prepared_operations where job_id = $1`,
      [changedPin.jobId],
    );
    assertEquals(changedPinRow.rows[0], {
      verified_provider_account_id: "12345",
      status: "uncertain",
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("concurrent invoke is single-I/O and live completion fails closed after revocation", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      capabilities: ["secret.identity"],
    });
    const { assignment, jobId } = await createIdentityJob(
      f,
      fixture,
      worker,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    f.setProvider(async () => {
      await gate;
      return Response.json({ id: 888, login: "race-fixture" });
    });
    const before = f.calls();
    const first = invokeIdentity(fixture, worker, assignment);
    const second = invokeIdentity(fixture, worker, assignment);
    for (let index = 0; index < 100 && f.calls() === before; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(f.calls(), before + 1);
    // The second invoke must persist the in-flight row as terminal uncertain
    // before the provider answers; otherwise the first completes (account
    // mismatch) and the second replays COMPLETION_AUTHORITY_LOST.
    let uncertain = false;
    for (let index = 0; index < 500 && !uncertain; index++) {
      uncertain = (await fixture.pgDatabase.query(
        `select 1 from bakery.prepared_operations
          where job_id = $1 and status = 'uncertain'`,
        [jobId],
      )).rows.length > 0;
      if (!uncertain) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(uncertain, true);
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assertEquals(firstResponse.status, 200);
    assertEquals(secondResponse.status, 200);
    const firstResult = await firstResponse.json();
    assertEquals(firstResult, {
      status: "uncertain",
      code: "OPERATION_RECOVERY_UNCERTAIN",
    });
    assertEquals(firstResult, await secondResponse.json());
    assertEquals(f.calls(), before + 1);
    assertEquals(
      (await postWorkerResult(
        fixture,
        worker,
        assignment,
        resultBody(assignment, { result: firstResult }),
        crypto.randomUUID(),
      )).status,
      200,
    );
    const firstJob = await fixture.pgDatabase.query<{ status: string }>(
      "select status from bakery.jobs where organization_id=$1 and id=$2",
      [fixture.organizationId, jobId],
    );
    assertEquals(firstJob.rows[0].status, "completed");

    const revoked = await createIdentityJob(f, fixture, worker);
    let releaseRevoked!: () => void;
    const revokedGate = new Promise<void>((resolve) =>
      releaseRevoked = resolve
    );
    f.setProvider(async () => {
      await revokedGate;
      return Response.json({ id: 999, login: "revoked-fixture" });
    });
    const beforeRevoked = f.calls();
    const invokingRevoked = invokeIdentity(
      fixture,
      worker,
      revoked.assignment,
    );
    for (
      let index = 0;
      index < 100 && f.calls() === beforeRevoked;
      index++
    ) await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(f.calls(), beforeRevoked + 1);
    await fixture.pgDatabase.query(
      `update bakery.secrets
          set revoked_at = now(), invalidation_generation = invalidation_generation + 1,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, revoked.secretId],
    );
    releaseRevoked();
    const revokedResponse = await invokingRevoked;
    assertEquals(revokedResponse.status, 200);
    const revokedResult = await revokedResponse.json();
    assertEquals(revokedResult, {
      status: "uncertain",
      code: "COMPLETION_AUTHORITY_LOST",
    });
    assertEquals(f.calls(), beforeRevoked + 1);
    assertEquals(
      (await postWorkerResult(
        fixture,
        worker,
        revoked.assignment,
        resultBody(revoked.assignment, { result: revokedResult }),
        crypto.randomUUID(),
      )).status,
      200,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("policy and lease races deny before provider I/O", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      capabilities: ["secret.identity"],
    });
    const policyRace = await createIdentityJob(f, fixture, worker);
    const beforePolicy = f.calls();
    await fixture.pgDatabase.query(
      `update bakery.secrets
          set allowed_actions = '[]'::jsonb,
              policy_revision = policy_revision + 1,
              invalidation_generation = invalidation_generation + 1,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, policyRace.secretId],
    );
    const denied = await invokeIdentity(fixture, worker, policyRace.assignment);
    assertEquals(denied.status, 200);
    const deniedResult = await denied.json();
    assertEquals(deniedResult, {
      status: "denied",
      code: "SECRET_GENERATION_STALE",
    });
    assertEquals(f.calls(), beforePolicy);
    assertEquals(
      (await postWorkerResult(
        fixture,
        worker,
        policyRace.assignment,
        resultBody(policyRace.assignment, { result: deniedResult }),
        crypto.randomUUID(),
      )).status,
      200,
    );

    const leaseRace = await createIdentityJob(f, fixture, worker);
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set lease_expires_at = clock_timestamp() - interval '1 second'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, leaseRace.assignment.attemptId],
    );
    const beforeLease = f.calls();
    const fenced = await invokeIdentity(fixture, worker, leaseRace.assignment);
    assertEquals(fenced.status, 200);
    assertEquals(await fenced.json(), {
      status: "denied",
      code: "LEASE_FENCED",
    });
    assertEquals(f.calls(), beforeLease);
  } finally {
    await f.cleanup();
  }
});

Deno.test("authenticated lifecycle routes fence prepared identity generations without mixed credentials", async (test) => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      capabilities: ["secret.identity"],
    });
    const operationId = (assignment: WorkerAssignment) =>
      (assignment.sealedCredentialOperation as {
        preparedOperationId: string;
      }).preparedOperationId;
    const operationState = (assignment: WorkerAssignment) =>
      fixture.pgDatabase.query<{
        status: string;
        io_attempt: number;
        secret_generation: string;
      }>(
        `select status, io_attempt, secret_generation::text
           from bakery.prepared_operations where id = $1`,
        [operationId(assignment)],
      );
    const publish = async (
      assignment: WorkerAssignment,
      result: Record<string, unknown>,
    ) => {
      const response = await postWorkerResult(
        fixture,
        worker,
        assignment,
        resultBody(assignment, { result }),
        crypto.randomUUID(),
      );
      assertEquals(response.status, 200, await response.clone().text());
    };
    const expectProvider = (...credentials: string[]) => {
      const expected = new Set(credentials.map((value) => `Bearer ${value}`));
      f.setProvider((authorization) => {
        if (!expected.has(authorization)) {
          throw new Error("UNEXPECTED_CONTROLLED_PROVIDER_CREDENTIAL");
        }
        return Promise.resolve(
          Response.json({ id: 12345, login: "fixture-user" }),
        );
      });
    };

    await test.step("rotation denies the old prepared generation before I/O", async () => {
      const oldCredential = `rotate-old-${crypto.randomUUID()}`;
      const freshCredential = `rotate-fresh-${crypto.randomUUID()}`;
      expectProvider(oldCredential, freshCredential);
      const prepared = await createIdentityJob(f, fixture, worker, {
        value: oldCredential,
      });
      const beforeRotation = f.providerAuthorizations().length;
      const rotated = await f.request(
        `/v1/secrets/${prepared.secretId}/versions`,
        {
          applicationId: prepared.applicationId,
          value: freshCredential,
        },
        crypto.randomUUID(),
        f.organizationId,
        { ifMatch: '"v1"' },
      );
      assertEquals(rotated.status, 201, await rotated.clone().text());
      assertEquals(
        f.providerAuthorizations().slice(beforeRotation),
        [`Bearer ${freshCredential}`],
      );

      const beforeInvocation = f.providerAuthorizations().length;
      const response = await invokeIdentity(
        fixture,
        worker,
        prepared.assignment,
      );
      assertEquals(response.status, 200);
      const result = await response.json();
      assertEquals(result, {
        status: "denied",
        code: "SECRET_GENERATION_STALE",
      });
      assertEquals(f.providerAuthorizations().length, beforeInvocation);
      assertEquals((await operationState(prepared.assignment)).rows[0], {
        status: "denied",
        io_attempt: 0,
        secret_generation: "1",
      });
      await publish(prepared.assignment, result);
    });

    await test.step("a generation prepared after rotation invokes only the fresh credential", async () => {
      const initialCredential = `fresh-control-old-${crypto.randomUUID()}`;
      const freshCredential = `fresh-control-new-${crypto.randomUUID()}`;
      expectProvider(initialCredential, freshCredential);
      let rotationCalls: string[] = [];
      const prepared = await createIdentityJob(f, fixture, worker, {
        value: initialCredential,
        beforeClaim: async (secret) => {
          const before = f.providerAuthorizations().length;
          const rotated = await f.request(
            `/v1/secrets/${secret.id}/versions`,
            {
              applicationId: secret.applicationId,
              value: freshCredential,
            },
            crypto.randomUUID(),
            f.organizationId,
            { ifMatch: '"v1"' },
          );
          assertEquals(rotated.status, 201, await rotated.clone().text());
          rotationCalls = f.providerAuthorizations().slice(before);
        },
      });
      assertEquals(rotationCalls, [`Bearer ${freshCredential}`]);
      assertEquals((await operationState(prepared.assignment)).rows[0], {
        status: "prepared",
        io_attempt: 0,
        secret_generation: "2",
      });

      const beforeInvocation = f.providerAuthorizations().length;
      const response = await invokeIdentity(
        fixture,
        worker,
        prepared.assignment,
      );
      assertEquals(response.status, 200);
      const result = await response.json();
      assertEquals(result, {
        status: "completed",
        accountId: "12345",
        login: "fixture-user",
      });
      assertEquals(
        f.providerAuthorizations().slice(beforeInvocation),
        [`Bearer ${freshCredential}`],
      );
      assertEquals((await operationState(prepared.assignment)).rows[0], {
        status: "completed",
        io_attempt: 1,
        secret_generation: "2",
      });
      await publish(prepared.assignment, result);
    });

    await test.step("revocation denies a prepared invocation before I/O", async () => {
      const credential = `revoke-${crypto.randomUUID()}`;
      expectProvider(credential);
      const prepared = await createIdentityJob(f, fixture, worker, {
        value: credential,
      });
      const beforeLifecycle = f.providerAuthorizations().length;
      const revoked = await f.request(
        `/v1/secrets/${prepared.secretId}`,
        { applicationId: prepared.applicationId },
        crypto.randomUUID(),
        f.organizationId,
        { method: "DELETE", ifMatch: '"v1"' },
      );
      assertEquals(revoked.status, 204, await revoked.clone().text());
      assertEquals(f.providerAuthorizations().length, beforeLifecycle);

      const response = await invokeIdentity(
        fixture,
        worker,
        prepared.assignment,
      );
      assertEquals(response.status, 200);
      const result = await response.json();
      assertEquals(result, {
        status: "denied",
        code: "SECRET_REVOKED",
      });
      assertEquals(f.providerAuthorizations().length, beforeLifecycle);
      assertEquals((await operationState(prepared.assignment)).rows[0], {
        status: "denied",
        io_attempt: 0,
        secret_generation: "1",
      });
      await publish(prepared.assignment, result);
    });

    await test.step("policy replacement invalidates prepared authority before I/O", async () => {
      const credential = `policy-${crypto.randomUUID()}`;
      expectProvider(credential);
      const prepared = await createIdentityJob(f, fixture, worker, {
        value: credential,
      });
      const beforeLifecycle = f.providerAuthorizations().length;
      const updated = await f.request(
        `/v1/secrets/${prepared.secretId}`,
        {
          applicationId: prepared.applicationId,
          allowedPrincipalIds: [],
          allowedActions: [],
        },
        crypto.randomUUID(),
        f.organizationId,
        { method: "PATCH", ifMatch: '"v1"' },
      );
      assertEquals(updated.status, 200, await updated.clone().text());
      const metadata = await updated.json();
      assertEquals(metadata.policyRevision, 2);
      assertEquals(metadata.invalidationGeneration, 2);
      assertEquals(metadata.allowedPrincipals, []);
      assertEquals(metadata.allowedActions, []);
      assertEquals(f.providerAuthorizations().length, beforeLifecycle);

      const response = await invokeIdentity(
        fixture,
        worker,
        prepared.assignment,
      );
      assertEquals(response.status, 200);
      const result = await response.json();
      assertEquals(result, {
        status: "denied",
        code: "SECRET_GENERATION_STALE",
      });
      assertEquals(f.providerAuthorizations().length, beforeLifecycle);
      assertEquals((await operationState(prepared.assignment)).rows[0], {
        status: "denied",
        io_attempt: 0,
        secret_generation: "1",
      });
      await publish(prepared.assignment, result);
    });

    await test.step("rotation after I/O admission preserves one whole pinned generation", async () => {
      const oldCredential = `overlap-old-${crypto.randomUUID()}`;
      const freshCredential = `overlap-fresh-${crypto.randomUUID()}`;
      expectProvider(oldCredential);
      const prepared = await createIdentityJob(f, fixture, worker, {
        value: oldCredential,
      });
      const identityReady = Promise.withResolvers<void>();
      const identityRelease = Promise.withResolvers<void>();
      f.setProvider(async (authorization) => {
        if (authorization === `Bearer ${oldCredential}`) {
          identityReady.resolve();
          await identityRelease.promise;
        } else if (authorization !== `Bearer ${freshCredential}`) {
          throw new Error("UNEXPECTED_CONTROLLED_PROVIDER_CREDENTIAL");
        }
        return Response.json({ id: 12345, login: "fixture-user" });
      });

      const beforeOverlap = f.providerAuthorizations().length;
      const invocationAbort = new AbortController();
      const invoking = invokeIdentity(
        fixture,
        worker,
        prepared.assignment,
        worker.registration.workerSessionId,
        invocationAbort.signal,
      );
      const invocationSettled = observeIdentityInvocation(invoking);
      let providerReady = false;
      try {
        await waitForIdentityProviderReady(
          identityReady.promise,
          invocationSettled,
        );
        providerReady = true;
        assertEquals(
          f.providerAuthorizations().slice(beforeOverlap),
          [`Bearer ${oldCredential}`],
        );
        assertEquals((await operationState(prepared.assignment)).rows[0], {
          status: "in_flight",
          io_attempt: 1,
          secret_generation: "1",
        });

        const rotated = await f.request(
          `/v1/secrets/${prepared.secretId}/versions`,
          { applicationId: prepared.applicationId, value: freshCredential },
          crypto.randomUUID(),
          f.organizationId,
          { ifMatch: '"v1"' },
        );
        identityRelease.resolve();
        const settlement = await invocationSettled;
        if (settlement.kind === "rejected") throw settlement.error;
        const invocation = settlement.response;
        assertEquals(rotated.status, 201, await rotated.clone().text());
        assertEquals(invocation.status, 200);
        const result = await invocation.json();
        assertEquals(result, {
          status: "uncertain",
          code: "COMPLETION_AUTHORITY_LOST",
        });
        assertEquals(
          f.providerAuthorizations().slice(beforeOverlap),
          [`Bearer ${oldCredential}`, `Bearer ${freshCredential}`],
        );
        assertEquals((await operationState(prepared.assignment)).rows[0], {
          status: "uncertain",
          io_attempt: 1,
          secret_generation: "1",
        });
        await publish(prepared.assignment, result);
      } finally {
        identityRelease.resolve();
        if (!providerReady) invocationAbort.abort();
        await invocationSettled;
      }
    });
  } finally {
    await f.cleanup();
  }
});

Deno.test("malformed prepared operation storage fails closed before provider I/O", async (test) => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      capabilities: ["secret.identity"],
    });
    const { assignment } = await createIdentityJob(f, fixture, worker);
    const operationId = (assignment.sealedCredentialOperation as {
      preparedOperationId: string;
    }).preparedOperationId;
    const original = await f.adminPgDatabase.query<{
      provider: string;
      verified_provider_account_id: string;
      status: string;
      io_attempt: number;
      input_digest: string;
      expires_at: Date;
    }>(
      `select provider, verified_provider_account_id, status, io_attempt,
              input_digest, expires_at
         from bakery.prepared_operations where id = $1`,
      [operationId],
    );
    const stored = original.rows[0];
    assert(stored);
    const restore = () =>
      f.adminPgDatabase.query(
        `update bakery.prepared_operations
            set provider = $2, verified_provider_account_id = $3,
                status = $4, io_attempt = $5, input_digest = $6,
                expires_at = $7, request_digest = null, safe_result = null,
                safe_code = null, result_digest = null, completed_at = null
          where id = $1`,
        [
          operationId,
          stored.provider,
          stored.verified_provider_account_id,
          stored.status,
          stored.io_attempt,
          stored.input_digest,
          stored.expires_at,
        ],
      );
    const cases = [
      {
        name: "fixed provider",
        mutate: () =>
          f.adminPgDatabase.query(
            "update bakery.prepared_operations set provider = 'gitlab' where id = $1",
            [operationId],
          ),
      },
      {
        name: "positive provider account",
        mutate: () =>
          f.adminPgDatabase.query(
            "update bakery.prepared_operations set verified_provider_account_id = '0' where id = $1",
            [operationId],
          ),
      },
      {
        name: "bounded provider account",
        mutate: () =>
          f.adminPgDatabase.query(
            "update bakery.prepared_operations set verified_provider_account_id = '12345678901234567' where id = $1",
            [operationId],
          ),
      },
      {
        name: "state and I/O attempt",
        mutate: () =>
          f.adminPgDatabase.query(
            "update bakery.prepared_operations set io_attempt = 2 where id = $1",
            [operationId],
          ),
      },
      {
        name: "input digest",
        mutate: () =>
          f.adminPgDatabase.query(
            "update bakery.prepared_operations set input_digest = 'invalid' where id = $1",
            [operationId],
          ),
      },
      {
        name: "bounded expiry",
        mutate: () =>
          f.adminPgDatabase.query(
            "update bakery.prepared_operations set expires_at = created_at + interval '31 seconds' where id = $1",
            [operationId],
          ),
      },
      {
        name: "terminal result shape",
        mutate: () =>
          f.adminPgDatabase.query(
            `update bakery.prepared_operations
                set status = 'completed', io_attempt = 1,
                    request_digest = repeat('a', 64),
                    safe_result = '{"status":"completed","accountId":"12345","login":""}'::jsonb,
                    result_digest = repeat('b', 64), completed_at = now()
              where id = $1`,
            [operationId],
          ),
      },
    ];
    for (const malformed of cases) {
      await test.step(malformed.name, async () => {
        await malformed.mutate();
        try {
          const before = f.calls();
          const response = await invokeIdentity(fixture, worker, assignment);
          assertEquals(response.status, 500);
          assertEquals((await response.json()).code, "INTERNAL");
          assertEquals(f.calls(), before);
        } finally {
          await restore();
        }
      });
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("prepared operation migration is ordered, relational, and idempotent", async () => {
  const f = await openSecretsFixture();
  const owner = openDatabase(f.ownerDatabaseUrl, 1);
  try {
    const migrations = [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ];
    const before = await f.fixture.pgDatabase.query<{
      version: string;
      applied_at: Date;
    }>(
      `select version, applied_at from bakery.schema_migrations
        where version in (
          '0053_output_reader', '0056_agent_definitions',
          '0057_issue286_prepared_operations'
        ) order by version`,
    );
    assertEquals(before.rows.map(({ version }) => version), [
      "0053_output_reader",
      "0056_agent_definitions",
      "0057_issue286_prepared_operations",
    ]);
    const constraintRows = await f.fixture.pgDatabase.query<{
      name: string;
      type: string;
      definition: string;
    }>(
      `select conname as name, contype as type,
              pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'bakery.prepared_operations'::regclass
        order by conname`,
    );
    assertEquals(
      constraintRows.rows.filter(({ type }) => type === "c"),
      [],
      "domain validation must not use PostgreSQL CHECK constraints",
    );
    const uniqueDefinitions = new Set(
      constraintRows.rows.filter(({ type }) => type === "u").map((row) =>
        row.definition
      ),
    );
    for (
      const required of [
        "UNIQUE (organization_id, id)",
        "UNIQUE (organization_id, attempt_id)",
        "UNIQUE (organization_id, job_id, attempt_id)",
      ]
    ) assert(uniqueDefinitions.has(required), `missing ${required}`);
    const foreignDefinitions = constraintRows.rows
      .filter(({ type }) => type === "f")
      .map(({ definition }) => definition);
    assertEquals(foreignDefinitions.length, 11);
    for (
      const pin of [
        "repository_profile_id, repository_profile_revision, repository_profile_digest",
        "job_id, attempt_id, worker_host_id, worker_session_id, worker_session_generation, fence, lease_token_hash",
        "secret_id, secret_version_id",
      ]
    ) {
      assert(
        foreignDefinitions.some((definition) => definition.includes(pin)),
        `missing relational pin ${pin}`,
      );
    }
    const scopeConstraints = await f.fixture.pgDatabase.query<{ name: string }>(
      `select conname as name from pg_constraint
        where conname = any($1::text[]) order by conname`,
      [[
        "job_attempts_prepared_operation_scope_unique",
        "jobs_prepared_operation_scope_unique",
        "run_steps_prepared_operation_scope_unique",
      ]],
    );
    assertEquals(scopeConstraints.rows.map(({ name }) => name), [
      "job_attempts_prepared_operation_scope_unique",
      "jobs_prepared_operation_scope_unique",
      "run_steps_prepared_operation_scope_unique",
    ]);
    await migrate(owner, migrations);
    await migrate(owner, migrations);
    const after = await f.fixture.pgDatabase.query<{
      version: string;
      applied_at: Date;
    }>(
      `select version, applied_at from bakery.schema_migrations
        where version in (
          '0053_output_reader', '0056_agent_definitions',
          '0057_issue286_prepared_operations'
        ) order by version`,
    );
    assertEquals(after.rows, before.rows);
  } finally {
    await closeDatabase(owner);
    await f.cleanup();
  }
});

Deno.test("cloud-only identity work is skipped before attempt, preparation, or provider I/O", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = asWorkerFixture(f);
    const worker = await registeredWorker(fixture, {
      capabilities: ["secret.identity"],
    });
    const job = await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      {
        action: "secret.identity.read",
        input: { secretRef: crypto.randomUUID() },
        capabilities: ["secret.identity"],
        legacy: true,
      },
    );
    const before = f.calls();
    const claimKey = crypto.randomUUID();
    const claim = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/claims",
      {
        claimKey,
        workerHostId: worker.registration.workerHostId,
        capabilities: ["secret.identity"],
        supportedActions: ["secret.identity.read"],
      },
      { idempotencyKey: claimKey },
    );
    assertEquals(claim.status, 204);
    const sideEffects = await fixture.pgDatabase.query<{
      attempts: string;
      prepared: string;
    }>(
      `select
         (select count(*)::text from bakery.job_attempts where job_id=$1) as attempts,
         (select count(*)::text from bakery.prepared_operations where job_id=$1) as prepared`,
      [job.jobId],
    );
    assertEquals(sideEffects.rows[0], { attempts: "0", prepared: "0" });
    assertEquals(f.calls(), before);
  } finally {
    await f.cleanup();
  }
});
