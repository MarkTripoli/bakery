// Remote maintenance integration suite (issue #25, slice A). AC1: given busy
// hosts, duplicate requests or concurrent Admin intent, requesting maintenance
// never silently kills an active job or applies a conflicting update.
import { assert, assertEquals } from "@std/assert";
import {
  problemCode,
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  cancelMaintenance,
  createMaintenance,
  type MaintenanceOperation,
  readMaintenance,
  reportMaintenanceInventory,
  setFixtureRole,
} from "../helpers/worker-maintenance.ts";

async function claimStatus(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  worker: { credential: string; registration: { workerHostId: string } },
): Promise<number> {
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
  await response.body?.cancel();
  return response.status;
}

Deno.test("an Admin update on an idle machine is queued and closes the claim gate", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-idle" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);

    const created = await createMaintenance(fixture, hostId, {
      verb: "update_component",
      componentKey: "harness.bakery",
      targetVersion: "1.1",
      targetDigest: "a".repeat(64),
    });
    assertEquals(created.status, 201);
    const operation = await created.json() as MaintenanceOperation;
    assertEquals(operation.phase, "queued");
    assertEquals(operation.workerHostId, hostId);
    assertEquals(operation.version, 1);

    // The claim gate is closed while the mutating operation is open.
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    assertEquals(await claimStatus(fixture, worker), 204);

    const event = await fixture.pgDatabase.query<{ payload: unknown }>(
      `select payload from bakery.domain_events
        where organization_id = $1 and event_type = 'worker.maintenance_updated'
          and aggregate_id = $2`,
      [fixture.organizationId, operation.id],
    );
    assertEquals(event.rows.map((row) => row.payload), [
      { resourceId: operation.id, resourceVersion: 1 },
    ]);
    const audit = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.audit_events
        where organization_id = $1 and operation = 'workerMaintenance.create'
          and resource_id = $2::text`,
      [fixture.organizationId, operation.id],
    );
    assertEquals(audit.rows[0]?.count, "1");

    // Canceling reopens the gate and the seeded job is claimed.
    const canceled = await cancelMaintenance(fixture, hostId, operation.id);
    assertEquals(canceled.status, 200);
    assertEquals(
      (await canceled.json() as MaintenanceOperation).phase,
      "canceled",
    );
    const assignment = await claimAssignment(fixture, worker);
    assert(assignment.attemptId.length > 0);
  }));

Deno.test("a busy machine waits for idle and its running attempt is untouched", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue25-busy",
      slots: 2,
    });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const before = await fixture.pgDatabase.query<Record<string, unknown>>(
      `select status, fence::text, lease_expires_at from bakery.job_attempts
        where id = $1`,
      [assignment.attemptId],
    );

    const created = await createMaintenance(fixture, hostId, {
      verb: "update_component",
      componentKey: "harness.bakery",
      targetVersion: "1.1",
    });
    assertEquals(created.status, 201);
    assertEquals(
      (await created.json() as MaintenanceOperation).phase,
      "waiting_for_idle",
    );
    const after = await fixture.pgDatabase.query<Record<string, unknown>>(
      `select status, fence::text, lease_expires_at from bakery.job_attempts
        where id = $1`,
      [assignment.attemptId],
    );
    assertEquals(after.rows, before.rows);
    // The free second slot is not used while maintenance waits.
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    assertEquals(await claimStatus(fixture, worker), 204);
  }));

Deno.test("a second mutating request conflicts while read-only verbs still queue", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-serial" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const first = await createMaintenance(fixture, hostId, {
      verb: "remove_component",
      componentKey: "harness.bakery",
    });
    assertEquals(first.status, 201);
    const second = await createMaintenance(fixture, hostId, {
      verb: "update_component",
      componentKey: "harness.bakery",
      targetVersion: "2.0",
    });
    assertEquals(second.status, 409);
    const problem = await second.json() as { code: string; reason?: string };
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals(problem.reason, "maintenance_in_progress");
    const refresh = await createMaintenance(fixture, hostId, {
      verb: "refresh_inventory",
    });
    assertEquals(refresh.status, 201);
  }));

Deno.test("the same key replays the original and a changed body is a mismatch", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-replay" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const idempotencyKey = crypto.randomUUID();
    const body = {
      verb: "update_component",
      componentKey: "harness.bakery",
      targetVersion: "1.1",
    };
    const first = await createMaintenance(fixture, hostId, body, {
      idempotencyKey,
    });
    assertEquals(first.status, 201);
    const original = await first.json() as MaintenanceOperation;
    const replay = await createMaintenance(fixture, hostId, body, {
      idempotencyKey,
    });
    assertEquals(replay.status, 201);
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(await replay.json(), original);
    const mismatch = await createMaintenance(
      fixture,
      hostId,
      { ...body, targetVersion: "9.9" },
      { idempotencyKey },
    );
    assertEquals(mismatch.status, 422);
    assertEquals(await problemCode(mismatch), "IDEMPOTENCY_PAYLOAD_MISMATCH");
    const count = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.worker_maintenance_operations
        where worker_host_id = $1`,
      [hostId],
    );
    assertEquals(count.rows[0]?.count, "1");
  }));

Deno.test("externally managed and unknown components are refused", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue25-external",
    });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const external = await createMaintenance(fixture, hostId, {
      verb: "update_component",
      componentKey: "harness.external",
      targetVersion: "1.1",
    });
    assertEquals(external.status, 422);
    const problem = await external.json() as {
      code: string;
      issues?: { path?: string[]; code: string }[];
    };
    assertEquals(problem.code, "UNPROCESSABLE");
    assertEquals(problem.issues?.[0]?.path, ["componentKey"]);
    assertEquals(problem.issues?.[0]?.code, "externally_managed");
    const unknown = await createMaintenance(fixture, hostId, {
      verb: "remove_component",
      componentKey: "harness.missing",
    });
    assertEquals(unknown.status, 422);
    const missingVersion = await createMaintenance(fixture, hostId, {
      verb: "update_component",
      componentKey: "harness.bakery",
    });
    assertEquals(missingVersion.status, 422);
  }));

Deno.test("a Developer reads maintenance but cannot request or cancel it", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-dev" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const created = await createMaintenance(fixture, hostId, {
      verb: "verify",
    });
    assertEquals(created.status, 201);
    const operation = await created.json() as MaintenanceOperation;
    await setFixtureRole(fixture, "developer");
    try {
      const denied = await createMaintenance(fixture, hostId, {
        verb: "refresh_inventory",
      });
      assertEquals(denied.status, 403);
      assertEquals(await problemCode(denied), "AUTH_FORBIDDEN");
      const deniedCancel = await cancelMaintenance(
        fixture,
        hostId,
        operation.id,
      );
      assertEquals(deniedCancel.status, 403);
      await deniedCancel.body?.cancel();
      const list = await readMaintenance(
        fixture,
        `/v1/workers/${hostId}/maintenance`,
      );
      assertEquals(list.status, 200);
      const page = await list.json() as {
        items: MaintenanceOperation[];
        nextCursor: string | null;
      };
      assertEquals(page.items.map((item) => item.id), [operation.id]);
      assertEquals(page.nextCursor, null);
      const got = await readMaintenance(
        fixture,
        `/v1/workers/${hostId}/maintenance/${operation.id}`,
      );
      assertEquals(got.status, 200);
      assertEquals((await got.json() as MaintenanceOperation).id, operation.id);
    } finally {
      await setFixtureRole(fixture, "admin");
    }
  }));

Deno.test("the list pages newest first with a cursor", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-page" });
    const hostId = worker.registration.workerHostId;
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const created = await createMaintenance(fixture, hostId, {
        verb: "refresh_inventory",
      });
      assertEquals(created.status, 201);
      ids.push((await created.json() as MaintenanceOperation).id);
    }
    const first = await readMaintenance(
      fixture,
      `/v1/workers/${hostId}/maintenance?limit=2`,
    );
    assertEquals(first.status, 200);
    const page1 = await first.json() as {
      items: MaintenanceOperation[];
      nextCursor: string | null;
    };
    assertEquals(page1.items.map((item) => item.id), [ids[2], ids[1]]);
    assert(page1.nextCursor);
    const second = await readMaintenance(
      fixture,
      `/v1/workers/${hostId}/maintenance?limit=2&cursor=${
        encodeURIComponent(page1.nextCursor)
      }`,
    );
    const page2 = await second.json() as {
      items: MaintenanceOperation[];
      nextCursor: string | null;
    };
    assertEquals(page2.items.map((item) => item.id), [ids[0]]);
    assertEquals(page2.nextCursor, null);
  }));

Deno.test("cancel is refused once the machine is applying", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-cancel" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const created = await createMaintenance(fixture, hostId, {
      verb: "update_component",
      componentKey: "harness.bakery",
      targetVersion: "1.1",
    });
    const operation = await created.json() as MaintenanceOperation;
    // The worker report route lands in a later slice; stand in for it.
    for (const phase of ["applying", "reconciling"]) {
      await fixture.pgDatabase.query(
        `update bakery.worker_maintenance_operations set phase = $2
          where id = $1`,
        [operation.id, phase],
      );
      const refused = await cancelMaintenance(fixture, hostId, operation.id);
      assertEquals(refused.status, 409);
      assertEquals(await problemCode(refused), "STATE_CONFLICT");
    }
    await fixture.pgDatabase.query(
      `update bakery.worker_maintenance_operations set phase = 'assigned'
        where id = $1`,
      [operation.id],
    );
    const canceled = await cancelMaintenance(fixture, hostId, operation.id);
    assertEquals(canceled.status, 200);
    const body = await canceled.json() as MaintenanceOperation;
    assertEquals(body.phase, "canceled");
    assertEquals(body.version, 2);
    // Canceling again returns the canceled operation unchanged.
    const again = await cancelMaintenance(fixture, hostId, operation.id);
    assertEquals(again.status, 200);
    assertEquals((await again.json() as MaintenanceOperation).version, 2);
  }));

Deno.test("a revoked machine refuses maintenance", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-revoked" });
    const hostId = worker.registration.workerHostId;
    const revoked = await createMaintenance(fixture, hostId, {
      verb: "refresh_inventory",
    });
    assertEquals(revoked.status, 201);
    await revoked.body?.cancel();
    const revoke = await fixture.app.fetch(
      new Request(`http://127.0.0.1:8788/v1/workers/${hostId}/revocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: fixture.adminCookie,
          origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: "{}",
      }),
    );
    assertEquals(revoke.status, 200);
    await revoke.body?.cancel();
    const refused = await createMaintenance(fixture, hostId, {
      verb: "refresh_inventory",
    });
    assertEquals(refused.status, 409);
    assertEquals(await problemCode(refused), "STATE_CONFLICT");
  }));
