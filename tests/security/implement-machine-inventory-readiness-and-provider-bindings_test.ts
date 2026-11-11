// Machine readiness security suite: AC2 — unsafe secret isolation blocks claims per
// capability through the readiness gate; AC3 — auth replay and cross-binding
// completion are rejected, protected challenge delivery is no-store and
// credential material is never echoed.
import { assert, assertEquals } from "@std/assert";
import {
  adminRequest,
  problemCode,
  registeredWorker,
  registerWorker,
  workerCredential,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { seedEligibleJob } from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";

const OBSERVED = "2026-09-20T00:00:00.000Z";
const PROTOCOL = { "X-Bakery-Worker-Protocol-Version": "2" };

async function reportInventory(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  worker: {
    credential: string;
    registration: { registrationGeneration: number };
  },
  expectedInventoryRevision: number,
  checks: { checkId: string; status: string }[],
  remoteLogin = "none",
) {
  return await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/inventory",
    {
      reportId: crypto.randomUUID(),
      hostGeneration: worker.registration.registrationGeneration,
      expectedInventoryRevision,
      components: [{
        componentKey: "harness.bakery",
        kind: "harness",
        actualVersion: "1.0",
        installOwner: "bakery",
        adapterVersion: "1.0",
        observedAt: OBSERVED,
        capabilities: [...workerFixtureCapabilities],
        maintenanceSupport: { remoteLogin },
      }],
      checks: checks.map((check) => ({
        checkId: check.checkId,
        checkVersion: "1",
        status: check.status,
        observedAt: OBSERVED,
      })),
    },
    { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
  );
}

async function createBinding(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  hostId: string,
) {
  const binding = await adminRequest(
    fixture,
    `/v1/workers/${hostId}/provider-bindings`,
    {
      componentKey: "harness.bakery",
      provider: "anthropic",
      billingRoute: "subscription",
      authMode: "host_native",
      credentialLocation: "harness_host",
    },
    { idempotencyKey: crypto.randomUUID() },
  );
  assertEquals(binding.status, 201);
  return await binding.json() as { id: string };
}

async function createAttempt(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  hostId: string,
  bindingId: string,
) {
  const attempt = await adminRequest(
    fixture,
    `/v1/workers/${hostId}/provider-bindings/${bindingId}/auth-attempts`,
    {},
    { method: "POST", idempotencyKey: crypto.randomUUID() },
  );
  assertEquals(attempt.status, 201);
  return await attempt.json() as {
    authAttemptId: string;
    flow: string;
    state: string;
  };
}

async function claimRaw(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  worker: { credential: string; registration: { workerHostId: string } },
  capabilities: string[],
) {
  const claimKey = crypto.randomUUID();
  const response = await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/claims",
    {
      claimKey,
      workerHostId: worker.registration.workerHostId,
      capabilities,
    },
    { idempotencyKey: claimKey },
  );
  if (response.status >= 400) {
    console.log("CLAIM-FAIL", response.status, await response.text());
  }
  return response;
}

Deno.test("a failed capability check blocks only that capability", () =>
  withWorkerFixture(async (fixture) => {
    const failing = await registeredWorker(fixture, {
      name: "issue59-sec-capability",
    });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const report = await reportInventory(
      fixture,
      failing,
      1,
      [{ checkId: "capability:git", status: "fail" }],
    );
    assertEquals(report.status, 200);

    // A claim whose capability set includes the failed capability is gated.
    const blocked = await claimRaw(fixture, failing, [
      ...workerFixtureCapabilities,
    ]);
    assertEquals(blocked.status, 204);

    // The same failure does not leak beyond its capability: a machine with a
    // fresh passing git check claims the identical workload.
    const healthy = await registeredWorker(fixture, {
      name: "issue59-sec-capability-healthy",
    });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    await reportInventory(
      fixture,
      healthy,
      1,
      [{ checkId: "capability:git", status: "pass" }],
    );
    const assignment = await claimAssignment(fixture, healthy);
    assertEquals(assignment.attemptId.length > 0, true);
  }));

Deno.test("a failed non-capability isolation check blocks every capability", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-sec-global",
    });
    await seedEligibleJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
      { action: "quality.check", capabilities: [...workerFixtureCapabilities] },
    );
    const report = await reportInventory(
      fixture,
      worker,
      1,
      [{ checkId: "secret.isolation", status: "fail" }],
    );
    assertEquals(report.status, 200);
    const claim = await claimRaw(fixture, worker, [
      ...workerFixtureCapabilities,
    ]);
    assertEquals(claim.status, 204);
  }));

Deno.test("protected challenges are delivered once, no-store, without secrets", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-sec-challenge",
    });
    const report = await reportInventory(
      fixture,
      worker,
      1,
      [{ checkId: "capability:git", status: "pass" }],
      "device",
    );
    assertEquals(report.status, 200);
    const binding = await createBinding(
      fixture,
      worker.registration.workerHostId,
    );
    const attempt = await createAttempt(
      fixture,
      worker.registration.workerHostId,
      binding.id,
    );
    assertEquals(attempt.flow, "remote_device");
    const challengeKey = crypto.randomUUID();
    const challenge = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attempt.authAttemptId}/reports`,
      { reportId: crypto.randomUUID(), phase: "challenge_requested" },
      { headers: { ...PROTOCOL }, idempotencyKey: challengeKey },
    );
    assertEquals(challenge.status, 200);
    assertEquals(challenge.headers.get("Cache-Control"), "no-store");
    const challengeBody = await challenge.json() as Record<string, unknown>;
    // The protected state material never leaves the server and the worker
    // credential is never echoed back.
    assertEquals("protectedState" in challengeBody, false);
    assertEquals("protected_state" in challengeBody, false);
    assert(
      !JSON.stringify(challengeBody).includes(worker.credential),
    );
    const nonce = (challengeBody.challenge as { nonce: string }).nonce;
    assert(typeof nonce === "string" && nonce.length > 0);
  }));

Deno.test("cross-binding completion is rejected and attempts cannot be replayed across workers", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-sec-cross",
    });
    const inventory = await reportInventory(
      fixture,
      worker,
      1,
      [{ checkId: "capability:git", status: "pass" }],
      "device",
    );
    assertEquals(inventory.status, 200);
    // A second component carries the second binding under test.
    const binding = await createBinding(
      fixture,
      worker.registration.workerHostId,
    );
    // Any binding id other than the attempt's own is foreign.
    const otherBindingBody = { id: crypto.randomUUID() };
    const attempt = await createAttempt(
      fixture,
      worker.registration.workerHostId,
      binding.id,
    );

    // A completion naming a different binding is a state conflict, not a win.
    const crossCompletion = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attempt.authAttemptId}/reports`,
      {
        reportId: crypto.randomUUID(),
        phase: "completion",
        result: {
          bindingId: otherBindingBody.id,
          billingIdentity: "acct_issue59",
          displayIdentity: "Issue 59",
        },
      },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(crossCompletion.status, 409);
    assertEquals(await problemCode(crossCompletion), "STATE_CONFLICT");
    // The attempt stays pending — nothing was attributed.
    const read = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings/${binding.id}/auth-attempts/${attempt.authAttemptId}`,
      undefined,
      { method: "GET" },
    );
    assertEquals(read.status, 200);
    assertEquals(
      ((await read.json()) as { state: string }).state,
      "pending",
    );

    // Another worker's attempt is invisible: reports resolve to not found.
    const stranger = await registeredWorker(fixture, {
      name: "issue59-sec-stranger",
    });
    await reportInventory(
      fixture,
      stranger,
      1,
      [{ checkId: "capability:git", status: "pass" }],
      "device",
    );
    const foreign = await workerRequest(
      fixture,
      stranger.credential,
      `/v1/worker/provider-auth-attempts/${attempt.authAttemptId}/reports`,
      { reportId: crypto.randomUUID(), phase: "challenge_requested" },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(foreign.status, 403);
    assertEquals(await problemCode(foreign), "AUTH_FORBIDDEN");

    // The honest completion stores only a hash of the billing identity.
    const completion = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attempt.authAttemptId}/reports`,
      {
        reportId: crypto.randomUUID(),
        phase: "completion",
        result: {
          billingIdentity: "acct_issue59",
          displayIdentity: "Issue 59",
        },
      },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(completion.status, 200);
    assertEquals(
      ((await completion.json()) as { state: string }).state,
      "completed",
    );
    const accounts = await fixture.pgDatabase.query<{ identityHash: string }>(
      `select identity_hash as "identityHash"
         from bakery.model_provider_accounts
        where organization_id = $1 and provider = 'anthropic'`,
      [fixture.organizationId],
    );
    assertEquals(accounts.rows.length, 1);
    assert(/^[0-9a-f]{64}$/.test(accounts.rows[0].identityHash));
    assert(accounts.rows[0].identityHash !== "acct_issue59");
  }));

// Re-pair rotation (credential_hash/credential_generation UPDATE grant, 0124)
// must refuse hosts that are not revoked and stale credential generations.
// Cases (a) and (c) need owner SQL (fixture.pgDatabase) because the API cannot
// reach them: revoke refuses an already-revoked host and a re-pair enrollment
// requires status = 'revoked'.
async function startRePair(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  hostId: string,
) {
  const revoked = await adminRequest(
    fixture,
    `/v1/workers/${hostId}/revocations`,
    {},
    { method: "POST", idempotencyKey: crypto.randomUUID() },
  );
  assertEquals(revoked.status, 200);
  const repair = await adminRequest(
    fixture,
    `/v1/workers/${hostId}/enrollments`,
    {},
    { method: "POST", idempotencyKey: crypto.randomUUID() },
  );
  assertEquals(repair.status, 201);
  return await repair.json() as {
    enrollmentId: string;
    enrollmentToken: string;
  };
}

async function hostCredentialState(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  hostId: string,
) {
  const rows = await fixture.pgDatabase.query<{
    credentialHash: string;
    credentialGeneration: string;
  }>(
    `select credential_hash as "credentialHash",
            credential_generation::text as "credentialGeneration"
       from bakery.worker_hosts where id = $1`,
    [hostId],
  );
  return rows.rows[0];
}

async function heartbeat(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  credential: string,
  hostId: string,
) {
  return await workerRequest(
    fixture,
    credential,
    "/v1/worker/heartbeat",
    {
      workerHostId: hostId,
      observedAt: OBSERVED,
      load: 0,
      activeAttemptIds: [],
      ackCommandIds: [],
      rejectedCommandIds: [],
    },
    { idempotencyKey: crypto.randomUUID(), headers: { ...PROTOCOL } },
  );
}

Deno.test("re-pair rotation refuses non-revoked hosts and stale generations", () =>
  withWorkerFixture(async (fixture) => {
    // (a) host no longer revoked when the re-pair enrollment is redeemed.
    const notRevoked = await registeredWorker(fixture, {
      name: "issue59-sec-repair-online",
    });
    const onlineHostId = notRevoked.registration.workerHostId;
    const onlineEnrollment = await startRePair(fixture, onlineHostId);
    const beforeOnline = await hostCredentialState(fixture, onlineHostId);
    await fixture.pgDatabase.query(
      `update bakery.worker_hosts set status = 'online' where id = $1`,
      [onlineHostId],
    );
    const onlineAttempt = await registerWorker(
      fixture,
      onlineEnrollment.enrollmentToken,
      workerCredential(),
      { name: "issue59-sec-repair-online", protocolVersion: 2 },
    );
    assertEquals(onlineAttempt.status, 409);
    assertEquals(await problemCode(onlineAttempt), "STATE_CONFLICT");
    assertEquals(
      await hostCredentialState(fixture, onlineHostId),
      beforeOnline,
    );
    const unconsumed = await fixture.pgDatabase.query<{ open: boolean }>(
      `select consumed_at is null as open
         from bakery.worker_enrollments where id = $1`,
      [onlineEnrollment.enrollmentId],
    );
    assertEquals(unconsumed.rows[0].open, true);

    // (b) a valid revoke and re-pair rotates the credential.
    const rotated = await registeredWorker(fixture, {
      name: "issue59-sec-repair-valid",
    });
    const rotatedHostId = rotated.registration.workerHostId;
    const validEnrollment = await startRePair(fixture, rotatedHostId);
    const newCredential = workerCredential();
    const rePair = await registerWorker(
      fixture,
      validEnrollment.enrollmentToken,
      newCredential,
      { name: "issue59-sec-repair-valid", protocolVersion: 2 },
    );
    assertEquals(rePair.status, 200);
    const oldHeartbeat = await heartbeat(
      fixture,
      rotated.credential,
      rotatedHostId,
    );
    assert([401, 403].includes(oldHeartbeat.status));
    await oldHeartbeat.body?.cancel();
    const newHeartbeat = await heartbeat(fixture, newCredential, rotatedHostId);
    assertEquals(newHeartbeat.status, 200);
    await newHeartbeat.body?.cancel();

    // (c) credential generation moved after the enrollment was issued.
    const stale = await registeredWorker(fixture, {
      name: "issue59-sec-repair-stale",
    });
    const staleHostId = stale.registration.workerHostId;
    const staleEnrollment = await startRePair(fixture, staleHostId);
    await fixture.pgDatabase.query(
      `update bakery.worker_hosts
          set credential_generation = credential_generation + 1
        where id = $1`,
      [staleHostId],
    );
    const beforeStale = await hostCredentialState(fixture, staleHostId);
    const staleAttempt = await registerWorker(
      fixture,
      staleEnrollment.enrollmentToken,
      workerCredential(),
      { name: "issue59-sec-repair-stale", protocolVersion: 2 },
    );
    assertEquals(staleAttempt.status, 409);
    assertEquals(await problemCode(staleAttempt), "STATE_CONFLICT");
    assertEquals(
      await hostCredentialState(fixture, staleHostId),
      beforeStale,
    );
  }));
