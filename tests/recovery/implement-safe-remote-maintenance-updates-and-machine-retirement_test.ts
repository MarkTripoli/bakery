// Remote maintenance recovery suite (issue #25, slice B1). A lost
// acknowledgement or a crash around the binary switch never fails or retries
// an update blindly: the operation reconciles, and only the digest the host
// reports as installed decides whether it succeeded.
import { assert, assertEquals } from "@std/assert";
import { problemCode, registeredWorker } from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  createMaintenance,
  expireMaintenanceClock,
  heartbeatAssignments,
  type MaintenanceAssignment,
  type MaintenanceOperation,
  maintenancePhase,
  reportMaintenanceInventory,
  sendMaintenanceReport,
} from "../helpers/worker-maintenance.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

const TARGET_DIGEST = "b".repeat(64);
const OLD_DIGEST = "c".repeat(64);

/** Queues an update, assigns it and reports applying (sequence 1). */
async function applyingUpdate(fixture: Fixture, name: string) {
  const worker = await registeredWorker(fixture, { name });
  const hostId = worker.registration.workerHostId;
  await reportMaintenanceInventory(fixture, worker);
  const created = await createMaintenance(fixture, hostId, {
    verb: "update_component",
    componentKey: "harness.bakery",
    targetVersion: "1.1",
    targetDigest: TARGET_DIGEST,
  });
  assertEquals(created.status, 201);
  const operation = await created.json() as MaintenanceOperation;
  const [assignment] = await heartbeatAssignments(fixture, worker);
  assertEquals(assignment?.operationId, operation.id);
  const applying = await sendMaintenanceReport(fixture, worker, operation.id, {
    fence: assignment!.fence,
    sequence: 1,
    phase: "applying",
  });
  assertEquals(applying.status, 200);
  await applying.body?.cancel();
  return { worker, operation, assignment: assignment! };
}

/** The acknowledgement was lost: the deadline passes with no final report. */
async function loseAcknowledgement(
  fixture: Fixture,
  worker: Awaited<ReturnType<typeof applyingUpdate>>["worker"],
  operation: MaintenanceOperation,
): Promise<MaintenanceAssignment[]> {
  await expireMaintenanceClock(fixture, operation.id);
  const assignments = await heartbeatAssignments(fixture, worker);
  assertEquals(
    (await maintenancePhase(fixture, operation.id)).phase,
    "reconciling",
  );
  return assignments;
}

Deno.test("a lost acknowledgement reconciles instead of failing or retrying", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, operation, assignment } = await applyingUpdate(
      fixture,
      "issue25-rec-lost",
    );
    const assignments = await loseAcknowledgement(fixture, worker, operation);
    // The host keeps the same fence and is asked to reconcile, not to rerun.
    assertEquals(assignments.map((item) => item.operationId), [operation.id]);
    assertEquals(assignments[0]?.fence, assignment.fence);
    const count = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.worker_maintenance_operations
        where worker_host_id = $1`,
      [worker.registration.workerHostId],
    );
    assertEquals(count.rows[0]?.count, "1");
    // Without the installed digest a reconciling operation is not decided.
    const undecided = await sendMaintenanceReport(
      fixture,
      worker,
      operation.id,
      { fence: assignment.fence, sequence: 2, phase: "succeeded" },
    );
    assertEquals(undecided.status, 422);
    assertEquals(await problemCode(undecided), "UNPROCESSABLE");
    assertEquals(
      (await maintenancePhase(fixture, operation.id)).phase,
      "reconciling",
    );
  }));

Deno.test("a reconciling operation succeeds when the installed digest matches", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, operation, assignment } = await applyingUpdate(
      fixture,
      "issue25-rec-match",
    );
    await loseAcknowledgement(fixture, worker, operation);
    // Even a reported failure is decided by what is installed.
    const report = await sendMaintenanceReport(fixture, worker, operation.id, {
      fence: assignment.fence,
      sequence: 2,
      phase: "failed",
      installedDigest: TARGET_DIGEST,
      installedVersion: "1.1",
    });
    assertEquals(report.status, 200);
    assertEquals(
      (await report.json() as MaintenanceOperation).phase,
      "succeeded",
    );
  }));

Deno.test("a reconciling operation fails when the installed digest differs", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, operation, assignment } = await applyingUpdate(
      fixture,
      "issue25-rec-mismatch",
    );
    await loseAcknowledgement(fixture, worker, operation);
    const report = await sendMaintenanceReport(fixture, worker, operation.id, {
      fence: assignment.fence,
      sequence: 2,
      phase: "succeeded",
      installedDigest: "d".repeat(64),
    });
    assertEquals(report.status, 200);
    const body = await report.json() as MaintenanceOperation & {
      result: { reason: string };
    };
    assertEquals(body.phase, "failed");
    assertEquals(body.result.reason, "installed_digest_mismatch");
  }));

Deno.test("a crash before the switch reconciles to failed and reopens claims", () =>
  withWorkerFixture(async (fixture) => {
    const { worker, operation, assignment } = await applyingUpdate(
      fixture,
      "issue25-rec-crash",
    );
    // The worker crashed after applying and before switching the binary.
    await loseAcknowledgement(fixture, worker, operation);
    // After restart the old release is still installed.
    const report = await sendMaintenanceReport(fixture, worker, operation.id, {
      fence: assignment.fence,
      sequence: 2,
      phase: "reconciling",
    });
    assertEquals(report.status, 200);
    await report.body?.cancel();
    const decided = await sendMaintenanceReport(fixture, worker, operation.id, {
      fence: assignment.fence,
      sequence: 3,
      phase: "failed",
      installedDigest: OLD_DIGEST,
      installedVersion: "1.0",
      reason: "switch_not_reached",
      diagnostic: "restart found old release; token=sk-live-abcdefghijklmnop",
    });
    assertEquals(decided.status, 200);
    const body = await decided.json() as MaintenanceOperation & {
      result: { reason: string; installedDigest: string; diagnostic: string };
    };
    assertEquals(body.phase, "failed");
    assertEquals(body.result.installedDigest, OLD_DIGEST);
    assert(!body.result.diagnostic.includes("sk-live-abcdefghijklmnop"));
    // Nothing is left to deliver and the claim gate is open again.
    assertEquals(await heartbeatAssignments(fixture, worker), []);
    await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const claimed = await claimAssignment(fixture, worker);
    assert(claimed.attemptId.length > 0);
  }));
