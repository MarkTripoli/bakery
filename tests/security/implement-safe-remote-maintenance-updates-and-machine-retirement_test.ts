// Remote maintenance security suite (issue #25, slice A): another
// organization's Admin cannot see, request or cancel maintenance on a machine
// it does not own, and learns nothing about it.
import { assertEquals } from "@std/assert";
import {
  createWorkerScope,
  problemCode,
  registeredWorker,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  cancelMaintenance,
  createMaintenance,
  type MaintenanceOperation,
  readMaintenance,
  reportMaintenanceInventory,
} from "../helpers/worker-maintenance.ts";

Deno.test("another organization's Admin gets 404 on every maintenance route", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-sec" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const created = await createMaintenance(fixture, hostId, {
      verb: "update_component",
      componentKey: "harness.bakery",
      targetVersion: "1.1",
    });
    assertEquals(created.status, 201);
    const operation = await created.json() as MaintenanceOperation;

    // A second organization the same person administers: membership there
    // grants nothing over this organization's machine.
    const other = await createWorkerScope(fixture, "issue25-foreign", fixture);
    const foreignCreate = await createMaintenance(
      fixture,
      hostId,
      { verb: "refresh_inventory" },
      { scope: other },
    );
    assertEquals(foreignCreate.status, 404);
    assertEquals(await problemCode(foreignCreate), "RESOURCE_NOT_FOUND");
    const foreignList = await readMaintenance(
      fixture,
      `/v1/workers/${hostId}/maintenance`,
      other,
    );
    assertEquals(foreignList.status, 404);
    await foreignList.body?.cancel();
    const foreignGet = await readMaintenance(
      fixture,
      `/v1/workers/${hostId}/maintenance/${operation.id}`,
      other,
    );
    assertEquals(foreignGet.status, 404);
    await foreignGet.body?.cancel();
    const foreignCancel = await cancelMaintenance(
      fixture,
      hostId,
      operation.id,
      other,
    );
    assertEquals(foreignCancel.status, 404);
    await foreignCancel.body?.cancel();

    // Nothing changed: the owner's operation is still open and unique.
    const rows = await fixture.pgDatabase.query<{ phase: string }>(
      `select phase from bakery.worker_maintenance_operations
        where worker_host_id = $1`,
      [hostId],
    );
    assertEquals(rows.rows.map((row) => row.phase), ["queued"]);
  }));

Deno.test("an operation ID is only visible under its own machine", () =>
  withWorkerFixture(async (fixture) => {
    const first = await registeredWorker(fixture, { name: "issue25-sec-a" });
    const second = await registeredWorker(fixture, { name: "issue25-sec-b" });
    const created = await createMaintenance(
      fixture,
      first.registration.workerHostId,
      { verb: "refresh_inventory" },
    );
    const operation = await created.json() as MaintenanceOperation;
    const crossHost = await readMaintenance(
      fixture,
      `/v1/workers/${second.registration.workerHostId}/maintenance/${operation.id}`,
    );
    assertEquals(crossHost.status, 404);
    await crossHost.body?.cancel();
    const malformed = await readMaintenance(
      fixture,
      `/v1/workers/not-a-uuid/maintenance/${operation.id}`,
    );
    assertEquals(malformed.status, 404);
    await malformed.body?.cancel();
  }));
