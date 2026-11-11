// Machine readiness recovery suite: replay ledgers make retried enrollment mutations,
// inventory reports and provider auth reports idempotent; re-pairing
// invalidates the old host generation; terminal-only fallback stays explicit.
import { assert, assertEquals } from "@std/assert";
import {
  adminRequest,
  enrollWorker,
  problemCode,
  registeredWorker,
  registerWorker,
  workerCredential,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

const OBSERVED = "2026-09-20T00:00:00.000Z";
const PROTOCOL = { "X-Bakery-Worker-Protocol-Version": "2" };

function inventoryBody(
  hostGeneration: number,
  expectedInventoryRevision: number,
  reportId: string,
  remoteLogin = "none",
) {
  return {
    reportId,
    hostGeneration,
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
    checks: [{
      checkId: "capability:git",
      checkVersion: "1",
      status: "pass",
      observedAt: OBSERVED,
    }],
  };
}

async function reportInventory(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  credential: string,
  hostGeneration: number,
  expectedInventoryRevision: number,
  reportId = crypto.randomUUID(),
  remoteLogin = "none",
) {
  return await workerRequest(
    fixture,
    credential,
    "/v1/worker/inventory",
    inventoryBody(
      hostGeneration,
      expectedInventoryRevision,
      reportId,
      remoteLogin,
    ),
    { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
  );
}

Deno.test("inventory report replays return the original receipt without mutating state", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-rec-inventory",
    });
    const reportId = crypto.randomUUID();
    const first = await reportInventory(
      fixture,
      worker.credential,
      worker.registration.registrationGeneration,
      1,
      reportId,
    );
    assertEquals(first.status, 200);
    const firstReceipt = await first.json() as {
      inventoryRevision: number;
      replayed: boolean;
    };
    assertEquals(firstReceipt.replayed, false);
    assertEquals(first.headers.get("Idempotent-Replayed"), null);

    const retry = await reportInventory(
      fixture,
      worker.credential,
      worker.registration.registrationGeneration,
      1,
      reportId,
    );
    assertEquals(retry.status, 200);
    assertEquals(retry.headers.get("Idempotent-Replayed"), "true");
    const retryReceipt = await retry.json() as {
      inventoryRevision: number;
      replayed: boolean;
    };
    // The replay marker lives on the response envelope; the stored receipt
    // body is returned verbatim.
    assertEquals(retryReceipt.replayed, false);
    assertEquals(
      retryReceipt.inventoryRevision,
      firstReceipt.inventoryRevision,
    );
  }));

Deno.test("enrollment mutation replays return the stored response", () =>
  withWorkerFixture(async (fixture) => {
    const enrollmentResponse = await enrollWorker(fixture, {
      name: "issue59-rec-enrollment",
      capabilities: ["git"],
    });
    assertEquals(enrollmentResponse.status, 201);
    const enrollment = await enrollmentResponse.json() as {
      enrollmentId: string;
    };
    const cancelKey = crypto.randomUUID();
    const cancel = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${enrollment.enrollmentId}`,
      {},
      { method: "PATCH", idempotencyKey: cancelKey },
    );
    assertEquals(cancel.status, 200);
    const cancelBody = await cancel.json() as { state: string };
    assertEquals(cancelBody.state, "canceled");

    const cancelReplay = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${enrollment.enrollmentId}`,
      {},
      { method: "PATCH", idempotencyKey: cancelKey },
    );
    assertEquals(cancelReplay.status, 200);
    assertEquals(cancelReplay.headers.get("Idempotent-Replayed"), "true");

    // Replacement under one key always resolves to the same successor.
    const pendingResponse = await enrollWorker(fixture, {
      name: "issue59-rec-enrollment",
      capabilities: ["git"],
    });
    assertEquals(pendingResponse.status, 201);
    const pending = await pendingResponse.json() as {
      enrollmentId: string;
    };
    const replaceKey = crypto.randomUUID();
    const replace = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${pending.enrollmentId}/replacements`,
      {},
      { method: "POST", idempotencyKey: replaceKey },
    );
    assertEquals(replace.status, 201);
    const replaceBody = await replace.json() as { enrollmentId: string };
    const replaceReplay = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${pending.enrollmentId}/replacements`,
      {},
      { method: "POST", idempotencyKey: replaceKey },
    );
    assertEquals(replaceReplay.status, 201);
    assertEquals(replaceReplay.headers.get("Idempotent-Replayed"), "true");
    const replaceReplayBody = await replaceReplay.json() as {
      enrollmentId: string;
    };
    assertEquals(replaceReplayBody.enrollmentId, replaceBody.enrollmentId);
    // A superseded (replaced) predecessor cannot be replaced again.
    const superseded = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${pending.enrollmentId}/replacements`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(superseded.status, 409);
    assertEquals(await problemCode(superseded), "STATE_CONFLICT");
  }));

Deno.test("provider auth report replays re-deliver the active challenge and store no nonce", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-rec-auth",
    });
    const inventory = await reportInventory(
      fixture,
      worker.credential,
      worker.registration.registrationGeneration,
      1,
      crypto.randomUUID(),
      "device",
    );
    assertEquals(inventory.status, 200);
    const binding = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings`,
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
    const bindingBody = await binding.json() as { id: string };
    const attempt = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings/${bindingBody.id}/auth-attempts`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(attempt.status, 201);
    const attemptBody = await attempt.json() as { authAttemptId: string };

    const reportId = crypto.randomUUID();
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attemptBody.authAttemptId}/reports`,
      { reportId, phase: "challenge_requested" },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(first.status, 200);
    const firstBody = await first.json() as {
      challenge: { nonce: string; issuedAt: string };
    };
    const replay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attemptBody.authAttemptId}/reports`,
      { reportId, phase: "challenge_requested" },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replay.status, 200);
    const replayBody = await replay.json() as {
      challenge: { nonce: string } | null;
    };
    // The attempt is still active, so the retry re-delivers the SAME nonce
    // from the attempt's encrypted protected_state.
    assert(replayBody.challenge !== null);
    assertEquals(replayBody.challenge.nonce, firstBody.challenge.nonce);
    // The report ledger stores the challenge response WITHOUT the raw nonce
    // (only the attempt's encrypted protected_state holds it), keyed by the
    // report id, so a retried report can never mint a second binding
    // identity out of the same attempt.
    const ledger = await fixture.pgDatabase.query<{ response: unknown }>(
      `select response from bakery.worker_provider_auth_reports
        where worker_provider_auth_attempt_id = $1 and report_id = $2`,
      [attemptBody.authAttemptId, reportId],
    );
    assertEquals(ledger.rows.length, 1);
    const ledgerResponse = ledger.rows[0].response as {
      challenge: { nonce: string } | null;
    };
    assertEquals(ledgerResponse.challenge ?? null, null);
  }));

Deno.test("unchanged inventory reports neither bump revisions nor emit events", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-rec-noop",
    });
    const body = inventoryBody(
      worker.registration.registrationGeneration,
      1,
      crypto.randomUUID(),
    );
    const first = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      body,
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(first.status, 200);
    const firstReceipt = await first.json() as {
      inventoryRevision: number;
      readinessRevision: number;
    };
    // The first report changes the host from an empty inventory, so both
    // revisions move once.
    assertEquals(firstReceipt.inventoryRevision, 2);
    assertEquals(firstReceipt.readinessRevision, 2);

    // An identical re-report (new report id) is a no-op: the canonical
    // fingerprint matches, so the inventory revision holds and no
    // inventory_changed event is minted; only the check freshness refreshes.
    const identical = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      inventoryBody(
        worker.registration.registrationGeneration,
        firstReceipt.inventoryRevision,
        crypto.randomUUID(),
      ),
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(identical.status, 200);
    const identicalReceipt = await identical.json() as {
      inventoryRevision: number;
      readinessRevision: number;
    };
    assertEquals(
      identicalReceipt.inventoryRevision,
      firstReceipt.inventoryRevision,
    );
    assertEquals(
      identicalReceipt.readinessRevision,
      firstReceipt.readinessRevision + 1,
    );

    // A fully empty report with the same components changes nothing at all.
    const noop = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/inventory",
      {
        reportId: crypto.randomUUID(),
        hostGeneration: worker.registration.registrationGeneration,
        expectedInventoryRevision: identicalReceipt.inventoryRevision,
        components: body.components,
        checks: [],
      },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(noop.status, 200);
    const noopReceipt = await noop.json() as {
      inventoryRevision: number;
      readinessRevision: number;
    };
    assertEquals(
      noopReceipt.inventoryRevision,
      identicalReceipt.inventoryRevision,
    );
    assertEquals(
      noopReceipt.readinessRevision,
      identicalReceipt.readinessRevision,
    );
    const events = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*) as count from bakery.domain_events
        where worker_host_id = $1
          and event_type = 'worker.inventory_changed'`,
      [worker.registration.workerHostId],
    );
    assertEquals(events.rows[0].count, "1");
  }));

Deno.test("challenge replay after a terminal state returns the attempt without a nonce", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-rec-terminal-replay",
    });
    const inventory = await reportInventory(
      fixture,
      worker.credential,
      worker.registration.registrationGeneration,
      1,
      crypto.randomUUID(),
      "device",
    );
    assertEquals(inventory.status, 200);
    const binding = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings`,
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
    const bindingBody = await binding.json() as { id: string };
    const attempt = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings/${bindingBody.id}/auth-attempts`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(attempt.status, 201);
    const attemptBody = await attempt.json() as { authAttemptId: string };

    const reportId = crypto.randomUUID();
    const first = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attemptBody.authAttemptId}/reports`,
      { reportId, phase: "challenge_requested" },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(first.status, 200);
    const firstBody = await first.json() as {
      challenge: { nonce: string };
    };
    const nonce = firstBody.challenge.nonce;

    const completion = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attemptBody.authAttemptId}/reports`,
      {
        reportId: crypto.randomUUID(),
        phase: "completion",
        result: {
          billingIdentity: "acct_terminal_replay",
          displayIdentity: "Terminal Replay",
        },
      },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(completion.status, 200);

    // Replaying the challenge report once the attempt has completed must
    // never re-deliver (or keep, in plaintext) the nonce.
    const replay = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attemptBody.authAttemptId}/reports`,
      { reportId, phase: "challenge_requested" },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replay.status, 200);
    const replayBody = await replay.json() as {
      state: string;
      challenge: { nonce: string } | null;
    };
    assertEquals(replayBody.state, "completed");
    assertEquals(replayBody.challenge ?? null, null);
    assert(!JSON.stringify(replayBody).includes(nonce));
  }));

Deno.test("repair enrollment replays the original outcome for a retried key", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-rec-repair-retry",
    });
    const hostId = worker.registration.workerHostId;
    const revoked = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/revocations`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(revoked.status, 200);

    const repairKey = crypto.randomUUID();
    const repair = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/enrollments`,
      {},
      { method: "POST", idempotencyKey: repairKey },
    );
    assertEquals(repair.status, 201);
    const repairBody = await repair.json() as { enrollmentId: string };

    // The retry with the same key replays the original enrollment instead of
    // hitting the pending-repair unique index.
    const retry = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/enrollments`,
      {},
      { method: "POST", idempotencyKey: repairKey },
    );
    assertEquals(retry.status, 201);
    assertEquals(retry.headers.get("Idempotent-Replayed"), "true");
    const retryBody = await retry.json() as { enrollmentId: string };
    assertEquals(retryBody.enrollmentId, repairBody.enrollmentId);

    // A different key while the pending repair still owns the host's single
    // pending-repair slot is a conflict, not a raw 23505.
    const otherKey = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/enrollments`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(otherKey.status, 409);
    assertEquals(await problemCode(otherKey), "STATE_CONFLICT");
  }));

Deno.test("re-pairing invalidates the old host generation and credential", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-rec-repair",
    });
    const hostId = worker.registration.workerHostId;
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
    const repairEnrollment = await repair.json() as {
      enrollmentToken: string;
    };
    const newCredential = workerCredential();
    const rePair = await registerWorker(
      fixture,
      repairEnrollment.enrollmentToken,
      newCredential,
      {
        name: "issue59-rec-repair",
        protocolVersion: 2,
      },
    );
    assertEquals(rePair.status, 200);
    const rePairBody = await rePair.json() as {
      workerHostId: string;
      registrationGeneration: number;
      status: string;
    };
    assertEquals(rePairBody.workerHostId, hostId);
    assertEquals(rePairBody.status, "updated");

    // The superseded credential can no longer check in.
    const oldHeartbeat = await workerRequest(
      fixture,
      worker.credential,
      "/v1/worker/heartbeat",
      {
        workerHostId: hostId,
        observedAt: OBSERVED,
        load: 0,
        activeAttemptIds: [],
        ackCommandIds: [],
        rejectedCommandIds: [],
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "0",
      },
      {
        idempotencyKey: crypto.randomUUID(),
        includeWorkerSession: false,
        headers: { ...PROTOCOL },
      },
    );
    assertEquals(oldHeartbeat.status, 403);

    // The superseded credential cannot report inventory at any generation.
    const staleGeneration = await reportInventory(
      fixture,
      worker.credential,
      rePairBody.registrationGeneration,
      1,
    );
    assertEquals(staleGeneration.status, 403);
    assertEquals(await problemCode(staleGeneration), "AUTH_FORBIDDEN");
    const revisionRow = await fixture.pgDatabase.query<{ revision: number }>(
      `select inventory_revision as revision from bakery.worker_hosts where id = $1`,
      [hostId],
    );
    const currentGeneration = await reportInventory(
      fixture,
      newCredential,
      rePairBody.registrationGeneration,
      revisionRow.rows[0].revision,
    );
    assertEquals(currentGeneration.status, 200);
  }));

Deno.test("terminal-only fallback records an explicit handoff and never fabricates a challenge", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-rec-terminal",
    });
    const inventory = await reportInventory(
      fixture,
      worker.credential,
      worker.registration.registrationGeneration,
      1,
    );
    assertEquals(inventory.status, 200);
    const binding = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings`,
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
    const bindingBody = await binding.json() as { id: string };
    const attempt = await adminRequest(
      fixture,
      `/v1/workers/${worker.registration.workerHostId}/provider-bindings/${bindingBody.id}/auth-attempts`,
      {},
      { method: "POST", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(attempt.status, 201);
    const attemptBody = await attempt.json() as {
      authAttemptId: string;
      flow: string;
      state: string;
      challenge: unknown;
      instructions: string | null;
    };
    assertEquals(attemptBody.flow, "terminal");
    assertEquals(attemptBody.state, "terminal");
    assertEquals(attemptBody.challenge, null);
    assert(attemptBody.instructions !== null);
    // A terminal attempt is terminal: no challenge phase can be manufactured.
    const report = await workerRequest(
      fixture,
      worker.credential,
      `/v1/worker/provider-auth-attempts/${attemptBody.authAttemptId}/reports`,
      { reportId: crypto.randomUUID(), phase: "challenge_requested" },
      { headers: { ...PROTOCOL }, idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(report.status, 409);
    assertEquals(await problemCode(report), "STATE_CONFLICT");
  }));
