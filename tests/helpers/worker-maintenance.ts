// Shared requests for the remote maintenance suites (issue #25).
import { assertEquals } from "@std/assert";
import { authTestOrigin } from "./auth.ts";
import {
  heartbeatRequest,
  type RegisteredWorker,
} from "./worker-execution/scenarios.ts";
import {
  adminRequest,
  type WorkerFixture,
  workerRequest,
  type WorkerScope,
} from "./worker-execution.ts";

export const OBSERVED = "2026-09-20T00:00:00.000Z";

/** Reports one Bakery-managed and one externally managed component. */
export async function reportMaintenanceInventory(
  fixture: WorkerFixture,
  worker: {
    credential: string;
    registration: { registrationGeneration: number };
  },
  expectedInventoryRevision = 1,
): Promise<void> {
  const component = (componentKey: string, installOwner: string) => ({
    componentKey,
    kind: "harness",
    actualVersion: "1.0",
    installOwner,
    adapterVersion: "1.0",
    observedAt: OBSERVED,
    capabilities: ["git", "shell"],
    maintenanceSupport: { remoteLogin: "none" },
  });
  const response = await workerRequest(
    fixture,
    worker.credential,
    "/v1/worker/inventory",
    {
      reportId: crypto.randomUUID(),
      hostGeneration: worker.registration.registrationGeneration,
      expectedInventoryRevision,
      components: [
        component("harness.bakery", "bakery"),
        component("harness.external", "external"),
      ],
      checks: [{
        checkId: "capability:git",
        checkVersion: "1",
        status: "pass",
        observedAt: OBSERVED,
      }],
    },
    {
      headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
}

export async function createMaintenance(
  fixture: WorkerFixture,
  hostId: string,
  body: Record<string, unknown>,
  options: { idempotencyKey?: string; scope?: WorkerScope } = {},
): Promise<Response> {
  return await adminRequest(
    fixture,
    `/v1/workers/${hostId}/maintenance`,
    body,
    {
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      scope: options.scope,
    },
  );
}

export async function cancelMaintenance(
  fixture: WorkerFixture,
  hostId: string,
  operationId: string,
  scope?: WorkerScope,
): Promise<Response> {
  return await adminRequest(
    fixture,
    `/v1/workers/${hostId}/maintenance/${operationId}/cancellations`,
    {},
    { idempotencyKey: crypto.randomUUID(), scope },
  );
}

/** A browser GET with the scope's session and organization header. */
export async function readMaintenance(
  fixture: WorkerFixture,
  path: string,
  scope: WorkerScope = fixture,
): Promise<Response> {
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: "GET",
      headers: {
        cookie: scope.adminCookie,
        origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": scope.organizationId,
      },
    }),
  );
}

/** Switches the fixture principal's membership role in its organization. */
export async function setFixtureRole(
  fixture: WorkerFixture,
  role: "admin" | "developer",
): Promise<void> {
  await fixture.pgDatabase.query(
    `update bakery.organization_memberships set role = $3
      where organization_id = $1 and principal_id = $2`,
    [fixture.organizationId, fixture.principalId, role],
  );
}

export type MaintenanceOperation = {
  id: string;
  workerHostId: string;
  verb: string;
  phase: string;
  version: number;
  componentKey: string | null;
};

export type MaintenanceAssignment = {
  operationId: string;
  workerHostId: string;
  credentialGeneration: number;
  verb: string;
  fence: string;
  deadlineAt: string;
  targetDigest: string | null;
};

type MaintenanceWorker = {
  credential: string;
  registration: { workerHostId: string };
};

/** One heartbeat; returns the maintenance assignments it carried. */
export async function heartbeatAssignments(
  fixture: WorkerFixture,
  worker: RegisteredWorker,
  idempotencyKey: string = crypto.randomUUID(),
  activeAttemptIds: string[] = [],
): Promise<MaintenanceAssignment[]> {
  const response = await heartbeatRequest(fixture, worker, {
    idempotencyKey,
    activeAttemptIds,
  });
  assertEquals(response.status, 200, await response.clone().text());
  const body = await response.json() as {
    maintenanceAssignments?: MaintenanceAssignment[];
  };
  return body.maintenanceAssignments ?? [];
}

/** POST /v1/worker/maintenance/{operationId}/reports. */
export async function sendMaintenanceReport(
  fixture: WorkerFixture,
  worker: MaintenanceWorker,
  operationId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await workerRequest(
    fixture,
    worker.credential,
    `/v1/worker/maintenance/${operationId}/reports`,
    body,
    {
      headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      idempotencyKey: crypto.randomUUID(),
    },
  );
}

/** Moves an operation's deadline (and optionally expiry) into the past. */
export async function expireMaintenanceClock(
  fixture: WorkerFixture,
  operationId: string,
  column: "deadline_at" | "expires_at" = "deadline_at",
): Promise<void> {
  await fixture.pgDatabase.query(
    `update bakery.worker_maintenance_operations
        set ${column} = clock_timestamp() - interval '1 minute'
      where id = $1`,
    [operationId],
  );
}

export async function maintenancePhase(
  fixture: WorkerFixture,
  operationId: string,
): Promise<{ phase: string; result: unknown }> {
  const rows = await fixture.pgDatabase.query<
    { phase: string; result: unknown }
  >(
    `select phase, result from bakery.worker_maintenance_operations
      where id = $1`,
    [operationId],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("maintenance operation missing");
  return row;
}
