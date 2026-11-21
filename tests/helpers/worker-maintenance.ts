// Shared requests for the remote maintenance suites (issue #25).
import { assertEquals } from "@std/assert";
import { authTestOrigin } from "./auth.ts";
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
