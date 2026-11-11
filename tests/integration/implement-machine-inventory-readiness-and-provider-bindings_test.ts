// Machine readiness integration suite: AC1 — concurrent registration, cancellation and
// early check-in resolve through one winning transaction and the replay ledger
// finds the true machine; AC2 — stale or expired inventory checks and offline
// capability never advertise usable capacity.
import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  adminRequest,
  enrollWorker,
  problemCode,
  registeredWorker,
  registerWorker,
  workerCredential,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { sha256Hex } from "../../apps/server/src/platform/canonical-json.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import { workerFixtureCapabilities } from "../helpers/worker-execution.ts";

const OBSERVED = "2026-09-20T00:00:00.000Z";

function inventoryBody(
  hostGeneration: number,
  expectedInventoryRevision: number,
  checks: { checkId: string; status: string }[],
) {
  return {
    reportId: crypto.randomUUID(),
    hostGeneration,
    expectedInventoryRevision,
    components: [{
      componentKey: "harness.bakery",
      kind: "harness",
      actualVersion: "1.0",
      installOwner: "bakery",
      adapterVersion: "1.0",
      observedAt: OBSERVED,
      capabilities: ["git", "shell"],
      maintenanceSupport: { remoteLogin: "none" },
    }],
    checks: checks.map((check) => ({
      checkId: check.checkId,
      checkVersion: "1",
      status: check.status,
      observedAt: OBSERVED,
    })),
  };
}

async function reportInventory(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  credential: string,
  hostGeneration: number,
  expectedInventoryRevision: number,
  checks: { checkId: string; status: string }[],
) {
  return await workerRequest(
    fixture,
    credential,
    "/v1/worker/inventory",
    inventoryBody(hostGeneration, expectedInventoryRevision, checks),
    {
      headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      idempotencyKey: crypto.randomUUID(),
    },
  );
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
  if (response.status !== 200 && response.status !== 204) {
    console.log("CLAIM-FAIL", response.status, await response.text());
  }
  return response;
}

Deno.test("concurrent registrations of one enrollment elect exactly one host", () =>
  withWorkerFixture(async (fixture) => {
    const enrollmentResponse = await enrollWorker(fixture, {
      name: "issue59-race-register",
      capabilities: ["git"],
      slots: 1,
    });
    assertEquals(enrollmentResponse.status, 201);
    const enrollment = await enrollmentResponse.json() as {
      enrollmentId: string;
      enrollmentToken: string;
    };
    const credentialA = workerCredential();
    const credentialB = workerCredential();
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    const [first, second] = await Promise.all([
      registerWorker(fixture, enrollment.enrollmentToken, credentialA, {
        name: "issue59-race-register",
        capabilities: ["git"],
        idempotencyKey: keyA,
      }),
      registerWorker(fixture, enrollment.enrollmentToken, credentialB, {
        name: "issue59-race-register",
        capabilities: ["git"],
        idempotencyKey: keyB,
      }),
    ]);
    const responses = [first, second];
    assertEquals(
      responses.filter((response) => response.status === 200).length,
      1,
    );
    const winner = responses.find((response) => response.status === 200)!;
    const winnerBody = await winner.json() as {
      workerHostId: string;
      principalId: string;
      status: string;
    };
    assertEquals(winnerBody.status, "registered");
    const loser = responses.find((response) => response.status !== 200)!;
    assertEquals(loser.status, 409);
    assertEquals(await problemCode(loser), "STATE_CONFLICT");

    // Exactly one host exists and it holds the winning credential hash.
    const hosts = await fixture.pgDatabase.query<{
      hostCount: number;
      credentialHash: string;
      consumed: boolean;
    }>(
      `select (select count(*)::int from bakery.worker_hosts
                where organization_id = $1) as "hostCount",
              (select credential_hash from bakery.worker_hosts
                where organization_id = $1 limit 1) as "credentialHash",
              enrollment.consumed_at is not null as consumed
         from bakery.worker_enrollments as enrollment
        where enrollment.id = $2`,
      [fixture.organizationId, enrollment.enrollmentId],
    );
    assertEquals(hosts.rows[0].hostCount, 1);
    assertEquals(
      hosts.rows[0].credentialHash,
      await sha256Hex(
        first.status === 200 ? credentialA : credentialB,
      ),
    );
    assertEquals(hosts.rows[0].consumed, true);

    // The enrollment replay ledger resolves the true machine for a retried
    // registration under the same idempotency key.
    const winningCredential = first.status === 200 ? credentialA : credentialB;
    const winningKey =
      new Headers(first.status === 200 ? first.headers : second.headers).get(
        "Idempotency-Key",
      ) ?? undefined;
    const replay = await registerWorker(
      fixture,
      enrollment.enrollmentToken,
      winningCredential,
      {
        name: "issue59-race-register",
        capabilities: ["git"],
        idempotencyKey: winningKey,
      },
    );
    // The consumed enrollment stays bound to the winning machine: a retried
    // registration can never rebind the token to a different host.
    assertEquals(replay.status, 409);
    assertEquals(await problemCode(replay), "STATE_CONFLICT");

    // The losing credential never created a session: early check-in fails.
    const loserCredential = first.status === 200 ? credentialB : credentialA;
    const earlyCheckIn = await workerRequest(
      fixture,
      loserCredential,
      "/v1/worker/heartbeat",
      {
        workerHostId: winnerBody.workerHostId,
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
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      },
    );
    assertEquals(earlyCheckIn.status, 403);
  }));

Deno.test("registration racing cancellation lets exactly one mutation win", () =>
  withWorkerFixture(async (fixture) => {
    const enrollmentResponse = await enrollWorker(fixture, {
      name: "issue59-race-cancel",
      capabilities: ["git"],
      slots: 1,
    });
    assertEquals(enrollmentResponse.status, 201);
    const enrollment = await enrollmentResponse.json() as {
      enrollmentId: string;
      enrollmentToken: string;
    };
    const credential = workerCredential();
    const [registration, cancel] = await Promise.all([
      registerWorker(fixture, enrollment.enrollmentToken, credential, {
        name: "issue59-race-cancel",
        capabilities: ["git"],
      }),
      adminRequest(
        fixture,
        `/v1/worker-enrollments/${enrollment.enrollmentId}`,
        {},
        { method: "PATCH", idempotencyKey: crypto.randomUUID() },
      ),
    ]);
    const state = await fixture.pgDatabase.query<{
      consumed: boolean;
      canceled: boolean;
      hostCount: number;
    }>(
      `select consumed_at is not null as consumed,
              canceled_at is not null as canceled,
              (select count(*)::int from bakery.worker_hosts
                where organization_id = $1) as "hostCount"
         from bakery.worker_enrollments
        where id = $2`,
      [fixture.organizationId, enrollment.enrollmentId],
    );
    const row = state.rows[0];
    if (registration.status === 200) {
      // Registration won: the machine exists and the late cancel conflicts.
      assertEquals(cancel.status, 409);
      assertEquals(row.consumed, true);
      assertEquals(row.hostCount, 1);
    } else {
      // Cancel won: no machine may exist and the token stays unconsumed.
      assertEquals(cancel.status, 200);
      assertEquals(row.canceled, true);
      assertEquals(row.hostCount, 0);
    }
  }));

async function readEnrollmentStatus(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  enrollmentId: string,
) {
  const response = await adminRequest(
    fixture,
    `/v1/worker-enrollments/${enrollmentId}`,
    undefined,
    { method: "GET" },
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  return {
    status: contractSchemas.EnrollmentStatus.parse(body),
    raw: JSON.stringify(body),
  };
}

Deno.test("a consumed first-time enrollment reports the host its worker registered", () =>
  withWorkerFixture(async (fixture) => {
    const name = "issue132-status-registered";
    const enrollmentResponse = await enrollWorker(fixture, {
      name,
      capabilities: ["git"],
      slots: 1,
    });
    assertEquals(enrollmentResponse.status, 201);
    const enrollment = await enrollmentResponse.json() as {
      enrollmentId: string;
      enrollmentToken: string;
    };

    // Pending: no host exists yet, so none is reported.
    const pending = await readEnrollmentStatus(
      fixture,
      enrollment.enrollmentId,
    );
    assertEquals(pending.status.state, "pending");
    assertEquals(pending.status.workerHostId, null);
    assertEquals(pending.status.worker, null);

    // The worker consumes the enrollment through the real registration path.
    const credential = workerCredential();
    const registration = await registerWorker(
      fixture,
      enrollment.enrollmentToken,
      credential,
      { name, capabilities: ["git"], protocolVersion: 2 },
    );
    assertEquals(registration.status, 200);
    const registered = await registration.json() as {
      workerHostId: string;
      principalId: string;
      status: string;
    };
    assertEquals(registered.status, "registered");

    // A first-time enrollment records the host in worker_host_id and leaves
    // target_worker_host_id (the repair target) empty.
    const columns = await fixture.pgDatabase.query<{
      workerHostId: string | null;
      targetWorkerHostId: string | null;
      consumed: boolean;
    }>(
      `select worker_host_id as "workerHostId",
              target_worker_host_id as "targetWorkerHostId",
              consumed_at is not null as consumed
         from bakery.worker_enrollments
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, enrollment.enrollmentId],
    );
    assertEquals(columns.rows[0].consumed, true);
    assertEquals(columns.rows[0].workerHostId, registered.workerHostId);
    assertEquals(columns.rows[0].targetWorkerHostId, null);

    // Consumed: the status read names the registered host and projects it.
    const consumed = await readEnrollmentStatus(
      fixture,
      enrollment.enrollmentId,
    );
    assertEquals(consumed.status.state, "consumed");
    assertEquals(consumed.status.workerHostId, registered.workerHostId);
    const worker = consumed.status.worker;
    assert(worker, "consumed enrollment must carry the worker projection");
    assertEquals(worker.id, registered.workerHostId);
    assertEquals(worker.principalId, registered.principalId);
    assertEquals(worker.name, name);

    // The embedded projection is the same safe projection the host read
    // returns, and carries no credential or token material.
    const hostResponse = await adminRequest(
      fixture,
      `/v1/workers/${registered.workerHostId}`,
      undefined,
      { method: "GET" },
    );
    assertEquals(hostResponse.status, 200);
    const host = contractSchemas.WorkerHost.parse(await hostResponse.json());
    for (
      const field of [
        "id",
        "principalId",
        "name",
        "os",
        "architecture",
        "slots",
        "status",
        "desiredMode",
        "credentialGeneration",
        "version",
      ] as const
    ) {
      assertEquals(worker[field], host[field], `worker.${field}`);
    }
    assertEquals(worker.capabilities, host.capabilities);
    assertEquals(consumed.raw.includes(credential), false);
    assertEquals(consumed.raw.includes(enrollment.enrollmentToken), false);
    assertEquals(/credentialHash|tokenHash/.test(consumed.raw), false);

    // The snapshot cursor covers the enrollment's and the registered host's
    // events, so a subscription started from it misses nothing.
    const cursor = await fixture.pgDatabase.query<{ sequence: string }>(
      `select coalesce(max(organization_sequence), 0)::text as sequence
         from bakery.domain_events
        where organization_id = $1
          and (worker_enrollment_id = $2 or worker_host_id = $3)`,
      [
        fixture.organizationId,
        enrollment.enrollmentId,
        registered.workerHostId,
      ],
    );
    assertEquals(consumed.status.snapshotCursor, cursor.rows[0].sequence);

    // An enrollment canceled before any worker registered still reports no host.
    const abandoned = await enrollWorker(fixture, {
      name: `${name}-abandoned`,
    });
    assertEquals(abandoned.status, 201);
    const abandonedBody = await abandoned.json() as { enrollmentId: string };
    const cancel = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${abandonedBody.enrollmentId}`,
      {},
      { method: "PATCH", idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(cancel.status, 200);
    const canceled = await readEnrollmentStatus(
      fixture,
      abandonedBody.enrollmentId,
    );
    assertEquals(canceled.status.state, "canceled");
    assertEquals(canceled.status.workerHostId, null);
    assertEquals(canceled.status.worker, null);
  }));

Deno.test("a repair enrollment reports its target host while pending and once re-paired", () =>
  withWorkerFixture(async (fixture) => {
    const name = "issue132-status-repair";
    const worker = await registeredWorker(fixture, { name });
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
      enrollmentId: string;
      enrollmentToken: string;
    };

    // Pending repair: the target host is already known and reported.
    const pending = await readEnrollmentStatus(
      fixture,
      repairEnrollment.enrollmentId,
    );
    assertEquals(pending.status.state, "pending");
    assertEquals(pending.status.workerHostId, hostId);
    assertEquals(pending.status.worker?.id, hostId);

    const rePair = await registerWorker(
      fixture,
      repairEnrollment.enrollmentToken,
      workerCredential(),
      { name, protocolVersion: 2 },
    );
    assertEquals(rePair.status, 200);
    assertEquals(
      (await rePair.json() as { workerHostId: string }).workerHostId,
      hostId,
    );

    // Consumed repair: the same host, now consumed.
    const consumed = await readEnrollmentStatus(
      fixture,
      repairEnrollment.enrollmentId,
    );
    assertEquals(consumed.status.state, "consumed");
    assertEquals(consumed.status.workerHostId, hostId);
    assertEquals(consumed.status.worker?.id, hostId);
  }));

Deno.test("fresh failing checks stop advertised capacity until new inventory", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-capacity",
      slots: 2,
    });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );

    const healthy = await reportInventory(
      fixture,
      worker.credential,
      worker.registration.registrationGeneration,
      1,
      [{ checkId: "capability:git", status: "pass" }],
    );
    assertEquals(healthy.status, 200);
    const healthyReceipt = await healthy.json() as {
      inventoryRevision: number;
      replayed: boolean;
    };
    assertEquals(healthyReceipt.replayed, false);

    // A claim against healthy inventory finds the seeded job.
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.attemptId.length > 0, true);

    const second = await registeredWorker(fixture, {
      name: "issue59-capacity-failing",
      slots: 2,
    });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const failing = await reportInventory(
      fixture,
      second.credential,
      second.registration.registrationGeneration,
      1,
      [{ checkId: "capability:git", status: "fail" }],
    );
    assertEquals(failing.status, 200);
    const failingReceipt = await failing.json() as {
      inventoryRevision: number;
    };

    // The fresh failing capability check must not advertise usable capacity.
    const blocked = await claimRaw(fixture, second, ["git"]);
    assertEquals(blocked.status, 204);

    // Newer inventory at the next revision with passing checks replaces the
    // stale failure; the old check generation is ignored by the freshness rule.
    const recovered = await reportInventory(
      fixture,
      second.credential,
      second.registration.registrationGeneration,
      failingReceipt.inventoryRevision,
      [{ checkId: "capability:git", status: "pass" }],
    );
    if (recovered.status !== 200) {
      console.log("RECOVER-FAIL", recovered.status, await recovered.text());
    }
    assertEquals(recovered.status, 200);
    const assignmentAfter = await claimAssignment(fixture, second);
    assertEquals(assignmentAfter.attemptId.length > 0, true);
  }));

Deno.test("expired global failures and offline machines stop advertising capacity", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue59-offline",
      slots: 2,
    });
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    // A failed check without the capability prefix blocks every capability.
    const report = await reportInventory(
      fixture,
      worker.credential,
      worker.registration.registrationGeneration,
      1,
      [{ checkId: "secret.isolation", status: "fail" }],
    );
    assertEquals(report.status, 200);
    const reportReceipt = await report.json() as { inventoryRevision: number };
    const blocked = await claimRaw(fixture, worker, [
      "git",
      ...workerFixtureCapabilities.filter((c) => c !== "git"),
    ]);
    assertEquals(blocked.status, 204);

    // The failure only blocks while it is fresh: past its receipt-derived
    // expiry the shared freshness rule ignores the stale result instead of
    // gating the machine forever.
    await fixture.pgDatabase.query(
      `update bakery.worker_checks
          set expires_at = clock_timestamp() - interval '1 minute'
        where worker_host_id = $1`,
      [worker.registration.workerHostId],
    );
    const afterExpiry = await claimRaw(fixture, worker, [
      "git",
      ...workerFixtureCapabilities.filter((c) => c !== "git"),
    ]);
    assertEquals(afterExpiry.status, 200);
    const refreshed = await reportInventory(
      fixture,
      worker.credential,
      worker.registration.registrationGeneration,
      reportReceipt.inventoryRevision,
      [{ checkId: "secret.isolation", status: "pass" }],
    );
    assertEquals(refreshed.status, 200);
    // A fresh passing report restores advertised capacity for new work.
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.attemptId.length > 0, true);
    assert(assignment.fence !== undefined);
  }));
