// Remote maintenance integration suite (issue #25, slice A). AC1: given busy
// hosts, duplicate requests or concurrent Admin intent, requesting maintenance
// never silently kills an active job or applies a conflicting update.
// Slice B1 adds delivery: heartbeat assignments under a per-host fence and
// the fenced, sequenced worker report route.
import { assert, assertEquals } from "@std/assert";
import {
  problemCode,
  registeredWorker,
  workerFixtureCapabilities,
  workerRequest,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  heartbeatRequest,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  archiveHost,
  cancelMaintenance,
  createMaintenance,
  expireMaintenanceClock,
  heartbeatAssignments,
  type MaintenanceOperation,
  maintenancePhase,
  readMaintenance,
  reportMaintenanceInventory,
  type RetiredHost,
  revokeHost,
  sendMaintenanceReport,
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

const TARGET_DIGEST = "a".repeat(64);

async function queuedUpdate(
  fixture: Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  hostId: string,
): Promise<MaintenanceOperation> {
  const created = await createMaintenance(fixture, hostId, {
    verb: "update_component",
    componentKey: "harness.bakery",
    targetVersion: "1.1",
    targetDigest: TARGET_DIGEST,
  });
  assertEquals(created.status, 201);
  return await created.json() as MaintenanceOperation;
}

Deno.test("a heartbeat hands the queued operation to the idle machine under a fence", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-assign" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const operation = await queuedUpdate(fixture, hostId);

    const key = crypto.randomUUID();
    const assignments = await heartbeatAssignments(fixture, worker, key);
    assertEquals(assignments.length, 1);
    const assignment = assignments[0]!;
    assertEquals(assignment.operationId, operation.id);
    assertEquals(assignment.workerHostId, hostId);
    assertEquals(assignment.verb, "update_component");
    assertEquals(assignment.targetDigest, TARGET_DIGEST);
    assertEquals(assignment.fence, "1");
    assert(Date.parse(assignment.deadlineAt) > Date.now());
    assertEquals(
      (await maintenancePhase(fixture, operation.id)).phase,
      "assigned",
    );

    // A duplicate delivery replays the same assignment; it is not reissued.
    assertEquals(await heartbeatAssignments(fixture, worker, key), assignments);
    // A later heartbeat keeps reporting the same fence until it finishes.
    const again = await heartbeatAssignments(fixture, worker);
    assertEquals(again.map((item) => item.fence), ["1"]);
    const events = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.domain_events
        where event_type = 'worker.maintenance_updated' and aggregate_id = $1`,
      [operation.id],
    );
    assertEquals(events.rows[0]?.count, "2");
  }));

Deno.test("a busy machine is not assigned maintenance until it is idle", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue25-idlewait",
    });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const attempt = await claimAssignment(fixture, worker);
    const operation = await queuedUpdate(fixture, hostId);
    assertEquals(operation.phase, "waiting_for_idle");
    assertEquals(
      await heartbeatAssignments(fixture, worker, crypto.randomUUID(), [
        attempt.attemptId,
      ]),
      [],
    );
    assertEquals(
      (await maintenancePhase(fixture, operation.id)).phase,
      "waiting_for_idle",
    );
    // The attempt finishes; the next heartbeat assigns the operation.
    await fixture.pgDatabase.query(
      `update bakery.job_attempts set status = 'completed',
         ended_at = clock_timestamp() where id = $1`,
      [attempt.attemptId],
    );
    const assignments = await heartbeatAssignments(fixture, worker);
    assertEquals(assignments.map((item) => item.operationId), [operation.id]);
  }));

Deno.test("waiting past the idle deadline needs attention and leaves work alone", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-attn" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const attempt = await claimAssignment(fixture, worker);
    const operation = await queuedUpdate(fixture, hostId);
    await expireMaintenanceClock(fixture, operation.id);
    assertEquals(
      await heartbeatAssignments(fixture, worker, crypto.randomUUID(), [
        attempt.attemptId,
      ]),
      [],
    );
    assertEquals(
      (await maintenancePhase(fixture, operation.id)).phase,
      "needs_attention",
    );
    const status = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.job_attempts where id = $1`,
      [attempt.attemptId],
    );
    assert(["leased", "running"].includes(status.rows[0]?.status ?? ""));
  }));

Deno.test("each new operation gets a strictly greater fence on the machine", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-fence" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const first = await queuedUpdate(fixture, hostId);
    const [one] = await heartbeatAssignments(fixture, worker);
    assertEquals(one?.operationId, first.id);
    const done = await sendMaintenanceReport(fixture, worker, first.id, {
      fence: one!.fence,
      sequence: 1,
      phase: "succeeded",
      installedDigest: TARGET_DIGEST,
      installedVersion: "1.1",
    });
    assertEquals(done.status, 200);
    assertEquals(
      (await done.json() as MaintenanceOperation).phase,
      "succeeded",
    );
    const second = await queuedUpdate(fixture, hostId);
    const verify = await createMaintenance(fixture, hostId, { verb: "verify" });
    assertEquals(verify.status, 201);
    await verify.body?.cancel();
    const next = await heartbeatAssignments(fixture, worker);
    assertEquals(next.length, 2);
    assertEquals(next[0]?.operationId, second.id);
    const fences = next.map((item) => BigInt(item.fence));
    assert(fences.every((fence) => fence > BigInt(one!.fence)));
    assert(fences[1]! > fences[0]!);

    // A report carrying the earlier operation's fence is refused.
    const stale = await sendMaintenanceReport(fixture, worker, second.id, {
      fence: one!.fence,
      sequence: 1,
      phase: "applying",
    });
    assertEquals(stale.status, 403);
    assertEquals(await problemCode(stale), "AUTH_FORBIDDEN");
  }));

Deno.test("reports replay exactly, refuse changed duplicates and sequence gaps", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-seq" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const operation = await queuedUpdate(fixture, hostId);
    const [assignment] = await heartbeatAssignments(fixture, worker);
    const applying = {
      fence: assignment!.fence,
      sequence: 1,
      phase: "applying",
    };
    const first = await sendMaintenanceReport(
      fixture,
      worker,
      operation.id,
      applying,
    );
    assertEquals(first.status, 200);
    const original = await first.json() as MaintenanceOperation;
    assertEquals(original.phase, "applying");

    const replay = await sendMaintenanceReport(
      fixture,
      worker,
      operation.id,
      applying,
    );
    assertEquals(replay.status, 200);
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(await replay.json(), original);

    const changed = await sendMaintenanceReport(fixture, worker, operation.id, {
      ...applying,
      phase: "reconciling",
    });
    assertEquals(changed.status, 422);
    assertEquals(await problemCode(changed), "IDEMPOTENCY_PAYLOAD_MISMATCH");

    const gap = await sendMaintenanceReport(fixture, worker, operation.id, {
      fence: assignment!.fence,
      sequence: 3,
      phase: "succeeded",
      installedDigest: TARGET_DIGEST,
    });
    assertEquals(gap.status, 409);
    assertEquals(await problemCode(gap), "STATE_CONFLICT");

    const done = await sendMaintenanceReport(fixture, worker, operation.id, {
      fence: assignment!.fence,
      sequence: 2,
      phase: "succeeded",
      installedDigest: TARGET_DIGEST,
    });
    assertEquals(done.status, 200);
    // A finished operation refuses anything but exact replays.
    const late = await sendMaintenanceReport(fixture, worker, operation.id, {
      fence: assignment!.fence,
      sequence: 3,
      phase: "failed",
    });
    assertEquals(late.status, 409);
    assertEquals(await problemCode(late), "STATE_CONFLICT");
    const receipts = await fixture.pgDatabase.query<{ sequence: number }>(
      `select sequence from bakery.worker_maintenance_receipts
        where operation_id = $1 order by sequence`,
      [operation.id],
    );
    assertEquals(receipts.rows.map((row) => row.sequence), [1, 2]);
    // The claim gate reopened with the operation finished.
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimed = await claimAssignment(fixture, worker);
    assert(claimed.attemptId.length > 0);
  }));

Deno.test("an offline request that expired is never assigned", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-expired" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const operation = await queuedUpdate(fixture, hostId);
    await expireMaintenanceClock(fixture, operation.id, "expires_at");
    assertEquals(await heartbeatAssignments(fixture, worker), []);
    assertEquals(
      (await maintenancePhase(fixture, operation.id)).phase,
      "expired",
    );
    assertEquals(await claimStatus(fixture, worker), 204);
  }));

Deno.test("a requester who is no longer an Admin fails the operation unassigned", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-authz" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const operation = await queuedUpdate(fixture, hostId);
    await setFixtureRole(fixture, "developer");
    try {
      assertEquals(await heartbeatAssignments(fixture, worker), []);
    } finally {
      await setFixtureRole(fixture, "admin");
    }
    const after = await maintenancePhase(fixture, operation.id);
    assertEquals(after.phase, "failed");
    assertEquals(after.result, { reason: "authority_revoked" });
  }));

// Slice C (AC3): offline revocation or archive revokes authority at once and
// leaves host erasure explicitly unconfirmed.
Deno.test("an offline revoke stops authority now and leaves cleanup unconfirmed", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-retire" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const operation = await queuedUpdate(fixture, hostId);
    // The host went quiet long ago: it is offline at revocation.
    await fixture.pgDatabase.query(
      `update bakery.worker_hosts
          set last_heartbeat_at = clock_timestamp() - interval '10 minutes'
        where id = $1`,
      [hostId],
    );
    const before = await readMaintenance(fixture, `/v1/workers/${hostId}`);
    const fresh = await before.json() as RetiredHost & { connectivity: string };
    assertEquals(fresh.connectivity, "offline");
    assertEquals(fresh.cleanup, {
      state: "not_requested",
      requestedAt: null,
      confirmedAt: null,
    });

    const revoked = await revokeHost(fixture, hostId);
    assertEquals(revoked.status, 200);
    const host = await revoked.json() as RetiredHost;
    assertEquals(host.status, "revoked");
    assertEquals(host.archivedAt, null);
    assertEquals(host.cleanup.state, "unconfirmed");
    assert(host.cleanup.requestedAt !== null);
    assertEquals(host.cleanup.confirmedAt, null);

    // The old credential is refused at once for claims and heartbeats.
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    assertEquals(await claimStatus(fixture, worker), 403);
    const heartbeat = await heartbeatRequest(fixture, worker);
    assertEquals(heartbeat.status, 403);
    await heartbeat.body?.cancel();

    // The open maintenance operation is terminal, not left hanging.
    const row = await maintenancePhase(fixture, operation.id);
    assertEquals(row.phase, "canceled");
    const result = await fixture.pgDatabase.query<{ result: unknown }>(
      `select result from bakery.worker_maintenance_operations where id = $1`,
      [operation.id],
    );
    assertEquals(result.rows[0]?.result, { reason: "host_revoked" });
  }));

Deno.test("archive needs a revoked host, is idempotent and keeps history", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-archive" });
    const other = await registeredWorker(fixture, { name: "issue25-keep" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    const operation = await createMaintenance(fixture, hostId, {
      verb: "verify",
    });
    const operationId = (await operation.json() as MaintenanceOperation).id;

    const early = await archiveHost(fixture, hostId);
    assertEquals(early.status, 409);
    const problem = await early.json() as { code: string; reason?: string };
    assertEquals(problem.code, "STATE_CONFLICT");
    assertEquals(problem.reason, "not_revoked");

    assertEquals((await revokeHost(fixture, hostId)).status, 200);
    const archived = await archiveHost(fixture, hostId);
    assertEquals(archived.status, 200);
    const host = await archived.json() as RetiredHost & { version: number };
    assert(host.archivedAt !== null);
    assertEquals(host.cleanup.state, "unconfirmed");
    const again = await archiveHost(fixture, hostId);
    assertEquals(again.status, 200);
    const replay = await again.json() as RetiredHost & { version: number };
    assertEquals(replay.archivedAt, host.archivedAt);
    assertEquals(replay.version, host.version);
    const audits = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.audit_events
        where operation = 'workers.archive' and resource_id = $1::text`,
      [hostId],
    );
    assertEquals(audits.rows[0]?.count, "1");

    // Hidden from the default list, present with the flag, readable by ID.
    const listed = async (query: string) => {
      const response = await readMaintenance(fixture, `/v1/workers${query}`);
      assertEquals(response.status, 200);
      const page = await response.json() as { items: { id: string }[] };
      return page.items.map((item) => item.id);
    };
    const defaults = await listed("");
    assert(!defaults.includes(hostId));
    assert(defaults.includes(other.registration.workerHostId));
    assert((await listed("?includeArchived=true")).includes(hostId));
    assert(!(await listed("?includeArchived=false")).includes(hostId));
    const malformed = await readMaintenance(
      fixture,
      "/v1/workers?includeArchived=yes",
    );
    assertEquals(malformed.status, 400);
    await malformed.body?.cancel();
    const got = await readMaintenance(fixture, `/v1/workers/${hostId}`);
    assertEquals(got.status, 200);
    assertEquals((await got.json() as RetiredHost).archivedAt, host.archivedAt);

    // Every historical reference still points at the same host row.
    const attempt = await fixture.pgDatabase.query<{ worker_host_id: string }>(
      `select worker_host_id from bakery.job_attempts where id = $1`,
      [assignment.attemptId],
    );
    assertEquals(attempt.rows[0]?.worker_host_id, hostId);
    const history = await readMaintenance(
      fixture,
      `/v1/workers/${hostId}/maintenance/${operationId}`,
    );
    assertEquals(history.status, 200);
    await history.body?.cancel();
  }));

Deno.test("the list cursor is bound to the includeArchived choice", () =>
  withWorkerFixture(async (fixture) => {
    for (const name of ["issue25-page-a", "issue25-page-b"]) {
      await registeredWorker(fixture, { name });
    }
    const first = await readMaintenance(
      fixture,
      "/v1/workers?limit=1&includeArchived=true",
    );
    const page = await first.json() as { nextCursor: string | null };
    assert(page.nextCursor !== null);
    const switched = await readMaintenance(
      fixture,
      `/v1/workers?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
    );
    assertEquals(switched.status, 400);
    assertEquals(await problemCode(switched), "INVALID_CURSOR");
  }));
