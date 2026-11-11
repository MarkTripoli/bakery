import { assertEquals } from "@std/assert";
import {
  adminRequest,
  closeWorkerScope,
  createWorkerScope,
  registeredWorker,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

Deno.test("F7.01 projections are permission bounded and organization scoped", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "f701-security-worker",
      capabilities: ["git"],
    });

    const listPath = "/v1/worker-enrollments?limit=100";
    const blockersPath =
      `/v1/workers/${worker.registration.workerHostId}/dispatch-blockers`;
    assertEquals(
      (await adminRequest(fixture, listPath, undefined, { method: "GET" }))
        .status,
      200,
    );
    const projected = await adminRequest(fixture, blockersPath, undefined, {
      method: "GET",
    });
    assertEquals(projected.status, 200);
    // The projection exposes only server-derived enums and counters: no
    // credential, path or token material rides along with the new reason.
    assertEquals(Object.keys(await projected.json()).sort(), [
      "allBlocked",
      "blockedCapabilities",
      "connectivity",
      "credentialGeneration",
      "failedChecks",
      "inventoryRevision",
      "reason",
      "workerHostId",
    ]);

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships
          set role = 'developer'
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, fixture.principalId],
    );
    assertEquals(
      (await adminRequest(fixture, listPath, undefined, { method: "GET" }))
        .status,
      200,
    );
    assertEquals(
      (await adminRequest(fixture, blockersPath, undefined, { method: "GET" }))
        .status,
      200,
    );
    assertEquals(
      (await adminRequest(
        fixture,
        `/v1/worker-enrollments/${worker.enrollment.enrollmentId}`,
        undefined,
        { method: "GET" },
      )).status,
      403,
    );

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships
          set role = 'viewer'
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, fixture.principalId],
    );
    assertEquals(
      (await adminRequest(fixture, listPath, undefined, { method: "GET" }))
        .status,
      404,
    );
    assertEquals(
      (await adminRequest(fixture, blockersPath, undefined, { method: "GET" }))
        .status,
      404,
    );

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships
          set role = 'admin'
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, fixture.principalId],
    );

    const foreignScope = await createWorkerScope(
      fixture,
      "f701-foreign",
      fixture,
    );
    try {
      const foreignWorker = await registeredWorker(fixture, {
        name: "f701-foreign-worker",
        capabilities: ["git"],
        scope: foreignScope,
      });
      const foreignList = await adminRequest(
        fixture,
        listPath,
        undefined,
        { method: "GET" },
      );
      const foreignBlockers = await adminRequest(
        fixture,
        `/v1/workers/${foreignWorker.registration.workerHostId}/dispatch-blockers`,
        undefined,
        { method: "GET" },
      );
      assertEquals(foreignList.status, 200);
      assertEquals(foreignBlockers.status, 404);
      assertEquals(
        (await foreignList.text()).includes(
          foreignWorker.enrollment.enrollmentId,
        ),
        false,
      );
    } finally {
      await closeWorkerScope(fixture, foreignScope);
    }
  }));
