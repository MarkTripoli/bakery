// Issue #25 slice B2: the supervisor hands heartbeat maintenance assignments
// to the executor only for an accepted, fresh heartbeat, and the claim loop
// stays closed while the executor says maintenance is unfinished.
import { assert, assertEquals } from "@std/assert";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { WorkerSupervisor } from "../../apps/worker/src/supervisor.ts";
import type { SupervisorMaintenance } from "../../apps/worker/src/supervisor-state.ts";
import type { WorkerMaintenanceAssignment } from "../../apps/worker/src/types.ts";
import {
  createDeterministicExecutor,
  fastSleep,
  protocolEmptyResponse,
  protocolResponse,
  supervisorConfig,
} from "../helpers/worker-execution/recovery-support.ts";

const NO_SANITIZE = { sanitizeResources: false, sanitizeOps: false } as const;

function maintenanceAssignment(
  workerHostId: string,
  fence: string,
): WorkerMaintenanceAssignment {
  return {
    operationId: crypto.randomUUID(),
    workerHostId,
    credentialGeneration: 1,
    verb: "refresh_inventory",
    componentKey: null,
    targetVersion: null,
    targetDigest: null,
    expectedInventoryRevision: 1,
    fence,
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
  } as WorkerMaintenanceAssignment;
}

function heartbeat(
  workerHostId: string,
  assignments: WorkerMaintenanceAssignment[],
  replayed = false,
): Response {
  return protocolResponse({
    workerHostId,
    status: "accepted",
    receivedAt: new Date().toISOString(),
    pendingCommands: [],
    commandAcks: [],
    workerSessionId: workerHostId,
    workerSessionGeneration: "1",
    reconciledAttemptIds: [],
    serverTime: new Date().toISOString(),
    inventoryRevision: 1,
    maintenanceAssignments: assignments,
  }, replayed ? { headers: { "Idempotent-Replayed": "true" } } : {});
}

async function supervisorWith(
  directory: string,
  workerHostId: string,
  maintenance: SupervisorMaintenance,
  fetcher: (path: string) => Response,
): Promise<WorkerSupervisor> {
  const store = new RegistrationStore(`${directory}/registration.json`);
  await store.saveRegistered("credential", {
    workerHostId,
    principalId: crypto.randomUUID(),
    status: "registered",
    registrationGeneration: 1,
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
  });
  return new WorkerSupervisor({
    config: supervisorConfig(directory),
    client: new WorkerApiClient({
      baseUrl: "http://127.0.0.1:8788",
      credential: "credential",
      fetcher: (input) =>
        Promise.resolve(fetcher(new URL(String(input)).pathname)),
    }),
    registrationStore: store,
    spool: await EventSpool.open({
      path: `${directory}/spool.json`,
      maxRecords: 20,
      maxBytes: 20_000,
    }),
    executor: createDeterministicExecutor(),
    maintenance,
    sleep: fastSleep,
  });
}

async function withDirectory(work: (directory: string) => Promise<void>) {
  const directory = await Deno.makeTempDir({ prefix: "bakery-sup-maint-" });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    await work(directory);
  } finally {
    console.warn = warn;
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

Deno.test({
  name: "only an accepted, fresh heartbeat hands assignments to the executor",
  ...NO_SANITIZE,
  fn: () =>
    withDirectory(async (directory) => {
      const workerHostId = crypto.randomUUID();
      const replayedOnly = maintenanceAssignment(workerHostId, "1");
      const fresh = maintenanceAssignment(workerHostId, "2");
      const received: string[][] = [];
      let heartbeats = 0;
      const ref: { current?: WorkerSupervisor } = {};
      const supervisor = await supervisorWith(directory, workerHostId, {
        accept: (assignments) => {
          received.push(assignments.map((item) => item.operationId));
          if (received.length >= 2) {
            queueMicrotask(() => ref.current?.requestStop("TEST_COMPLETE"));
          }
          return Promise.resolve();
        },
        claimsClosed: () => true,
      }, (path) => {
        if (path.endsWith("/heartbeat")) {
          heartbeats += 1;
          // A bounded run: without the wiring the test fails, never hangs.
          if (heartbeats >= 6) {
            queueMicrotask(() => ref.current?.requestStop("TEST_COMPLETE"));
          }
          // The first answer is a replay: its assignments must not run.
          return heartbeats === 1
            ? heartbeat(workerHostId, [replayedOnly], true)
            : heartbeat(workerHostId, [fresh]);
        }
        if (path.endsWith("/claims")) {
          return protocolEmptyResponse({ status: 204 });
        }
        throw new Error(`UNEXPECTED_WORKER_PATH:${path}`);
      });
      ref.current = supervisor;
      await supervisor.run();
      assert(received.length >= 1);
      for (const batch of received) {
        assertEquals(batch, [fresh.operationId]);
      }
    }),
});

Deno.test({
  name: "the claim loop makes no claim while maintenance holds claims closed",
  ...NO_SANITIZE,
  fn: () =>
    withDirectory(async (directory) => {
      const workerHostId = crypto.randomUUID();
      let closed = true;
      let heartbeats = 0;
      let claimsWhileClosed = 0;
      let claimsAfterOpen = 0;
      const ref: { current?: WorkerSupervisor } = {};
      const supervisor = await supervisorWith(directory, workerHostId, {
        accept: () => Promise.resolve(),
        claimsClosed: () => closed,
      }, (path) => {
        if (path.endsWith("/heartbeat")) {
          heartbeats += 1;
          if (heartbeats === 6) closed = false;
          return heartbeat(workerHostId, []);
        }
        if (path.endsWith("/claims")) {
          if (closed) claimsWhileClosed += 1;
          else {
            claimsAfterOpen += 1;
            queueMicrotask(() => ref.current?.requestStop("TEST_COMPLETE"));
          }
          return protocolEmptyResponse({ status: 204 });
        }
        throw new Error(`UNEXPECTED_WORKER_PATH:${path}`);
      });
      ref.current = supervisor;
      await supervisor.run();
      assert(heartbeats >= 6);
      assertEquals(claimsWhileClosed, 0);
      assert(claimsAfterOpen >= 1);
    }),
});
