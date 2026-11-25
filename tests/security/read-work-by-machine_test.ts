import { assertEquals } from "@std/assert";
import {
  adminRequest,
  closeWorkerScope,
  createWorkerScope,
  registeredWorker,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

Deno.test("a machine's work is readable only with worker:read in its own organization (#70)", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "work-read-security-worker",
      capabilities: ["git"],
    });
    const path =
      `/v1/workers/${worker.registration.workerHostId}/attempts?state=now`;
    const get = (target = path, headers?: HeadersInit) =>
      adminRequest(fixture, target, undefined, {
        method: "GET",
        ...(headers === undefined ? {} : { headers }),
      });
    const role = (value: string) =>
      fixture.pgDatabase.query(
        `update bakery.organization_memberships set role = $3
          where organization_id = $1 and principal_id = $2`,
        [fixture.organizationId, fixture.principalId, value],
      );

    assertEquals((await get(path, { cookie: "" })).status, 401);
    const allowed = await get();
    assertEquals(allowed.status, 200, await allowed.clone().text());
    assertEquals(await allowed.json(), { items: [], nextCursor: null });

    await role("developer");
    assertEquals((await get()).status, 200, "a Developer holds worker:read");
    await role("viewer");
    assertEquals((await get()).status, 404, "no worker:read, no machine");
    await role("admin");
    assertEquals((await get()).status, 200, "restoring the grant restores it");

    const foreignScope = await createWorkerScope(
      fixture,
      "work-read-foreign",
      fixture,
    );
    try {
      const foreign = await registeredWorker(fixture, {
        name: "work-read-foreign-worker",
        capabilities: ["git"],
        scope: foreignScope,
      });
      const response = await get(
        `/v1/workers/${foreign.registration.workerHostId}/attempts?state=now`,
      );
      assertEquals(response.status, 404);
      const text = await response.text();
      assertEquals(text.includes(foreign.registration.workerHostId), false);
    } finally {
      await closeWorkerScope(fixture, foreignScope);
    }
  }));
