// Remote maintenance recovery suite (issue #25, slice B1). A lost
// acknowledgement or a crash around the binary switch never fails or retries
// an update blindly: the operation reconciles, and only the digest the host
// reports as installed decides whether it succeeded.
import { assert, assertEquals } from "@std/assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MaintenanceExecutor,
  MaintenanceJournalStore,
} from "../../apps/worker/src/maintenance.ts";
import {
  createReleaseDirectoryAdapter,
  WORKER_COMPONENT_KEY,
  workerMaintenanceAdapters,
} from "../../apps/worker/src/maintenance-release.ts";
import {
  problemCode,
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
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

// Slice B2 end to end: the worker executor switches a real release directory
// and the server records the outcome. The switch swaps a symlink, and Deno
// refuses symlink() under a path-scoped --allow-write, so these run in the
// recovery lane (unscoped write) rather than the integration lane.
Deno.test("the worker executor applies an assigned update and the server records success", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-b2-e2e" });
    const hostId = worker.registration.workerHostId;
    await reportMaintenanceInventory(fixture, worker);
    const bytes = (text: string) => new TextEncoder().encode(text);
    const oldRelease = {
      bytes: bytes("bakery 1.0"),
      version: "1.0",
      stateFormat: 1,
    };
    const newRelease = {
      bytes: bytes("bakery 1.1"),
      version: "1.1",
      stateFormat: 1,
    };
    const targetDigest = createHash("sha256").update(newRelease.bytes)
      .digest("hex");
    const base = await mkdtemp(join(tmpdir(), "bakery-maintenance-e2e-"));
    try {
      const adapter = createReleaseDirectoryAdapter({
        componentKey: "harness.bakery",
        root: join(base, "component"),
        fetchArtifact: (target) =>
          Promise.resolve(
            target.digest === targetDigest ? newRelease : oldRelease,
          ),
        health: () => Promise.resolve(true),
      });
      await adapter.switchTo(
        await adapter.stage({
          digest: createHash("sha256").update(oldRelease.bytes).digest("hex"),
          version: "1.0",
        }),
      );
      const created = await createMaintenance(fixture, hostId, {
        verb: "update_component",
        componentKey: "harness.bakery",
        targetVersion: "1.1",
        targetDigest,
      });
      assertEquals(created.status, 201);
      const operation = await created.json() as MaintenanceOperation;
      const assignments = await heartbeatAssignments(fixture, worker);
      assertEquals(assignments.map((item) => item.operationId), [operation.id]);
      const statuses: number[] = [];
      const executor = new MaintenanceExecutor({
        journal: await MaintenanceJournalStore.open(join(base, "state")),
        adapters: [adapter],
        log: () => undefined,
        report: async (operationId, body) => {
          const response = await sendMaintenanceReport(
            fixture,
            worker,
            operationId,
            body,
          );
          statuses.push(response.status);
          await response.body?.cancel();
          if (response.status !== 200) {
            throw { status: response.status, retryable: false };
          }
        },
      });
      await executor.accept(
        assignments as unknown as Parameters<typeof executor.accept>[0],
      );
      assertEquals(statuses, [200, 200]);
      const finished = await maintenancePhase(fixture, operation.id);
      assertEquals(finished.phase, "succeeded");
      assertEquals(
        (finished.result as { installedDigest?: string }).installedDigest,
        targetDigest,
      );
      assertEquals((await adapter.installed())?.digest, targetDigest);
      // A duplicate delivery replays the stored answer; nothing runs again.
      await executor.accept(
        assignments as unknown as Parameters<typeof executor.accept>[0],
      );
      assertEquals(statuses, [200, 200, 200]);
      assertEquals(await heartbeatAssignments(fixture, worker), []);
      assert(!executor.claimsClosed());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }));

Deno.test("the worker's reported own release can be targeted by an Admin update", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue25-b2-own" });
    const hostId = worker.registration.workerHostId;
    const base = await mkdtemp(join(tmpdir(), "bakery-maintenance-own-"));
    try {
      const bytes = new TextEncoder().encode("bakery worker 1.0.0");
      const digest = createHash("sha256").update(bytes).digest("hex");
      await mkdir(join(base, "source", digest), { recursive: true });
      await writeFile(join(base, "source", digest, "artifact"), bytes);
      await writeFile(
        join(base, "source", digest, "release.json"),
        JSON.stringify({ version: "1.0.0", stateFormat: 1 }),
      );
      const adapters = workerMaintenanceAdapters({
        maintenanceRelease: {
          root: join(base, "release"),
          sourceDir: join(base, "source"),
        },
      });
      await adapters[0]!.switchTo(
        await adapters[0]!.stage({ digest, version: null }),
      );
      const executor = new MaintenanceExecutor({
        journal: await MaintenanceJournalStore.open(join(base, "state")),
        adapters,
        report: () => Promise.resolve(),
        log: () => undefined,
      });
      const components = await executor.inventoryComponents(
        new Date().toISOString(),
      );
      const reported = await workerRequest(
        fixture,
        worker.credential,
        "/v1/worker/inventory",
        {
          reportId: crypto.randomUUID(),
          hostGeneration: worker.registration.registrationGeneration,
          expectedInventoryRevision: 1,
          components,
          checks: [],
        },
        {
          headers: { "X-Bakery-Worker-Protocol-Version": "2" },
          idempotencyKey: crypto.randomUUID(),
        },
      );
      assertEquals(reported.status, 200, await reported.clone().text());
      await reported.body?.cancel();
      const stored = await fixture.pgDatabase.query<{
        install_owner: string;
      }>(
        `select install_owner from bakery.worker_components
          where worker_host_id = $1 and component_key = $2`,
        [hostId, WORKER_COMPONENT_KEY],
      );
      assertEquals(stored.rows[0]?.install_owner, "bakery");
      const created = await createMaintenance(fixture, hostId, {
        verb: "update_component",
        componentKey: WORKER_COMPONENT_KEY,
        targetVersion: "1.1.0",
        targetDigest: "a".repeat(64),
      });
      assertEquals(created.status, 201, await created.clone().text());
      await created.body?.cancel();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }));
