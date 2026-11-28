import { assertEquals } from "@std/assert";
import { adminRequest, registeredWorker } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

const GOOD = "00000000-0000-4000-8000-000000000001";

const MALFORMED: readonly (readonly [string, string, string])[] = [
  ["GET", "/v1/workers/not-a-uuid", "id"],
  ["PATCH", "/v1/workers/not-a-uuid", "id"],
  ["GET", "/v1/workers/not-a-uuid/attempts", "id"],
  ["GET", "/v1/workers/not-a-uuid/models", "id"],
  ["GET", "/v1/workers/not-a-uuid/dispatch-blockers", "id"],
  ["POST", "/v1/workers/not-a-uuid/revocations", "id"],
  ["POST", "/v1/workers/not-a-uuid/archives", "id"],
  ["GET", "/v1/workers/not-a-uuid/maintenance", "id"],
  ["POST", "/v1/workers/not-a-uuid/maintenance", "id"],
  [
    "GET",
    `/v1/workers/${GOOD}/maintenance/not-a-uuid`,
    "operationId",
  ],
  [
    "POST",
    `/v1/workers/${GOOD}/maintenance/not-a-uuid/cancellations`,
    "operationId",
  ],
  ["POST", "/v1/workers/not-a-uuid/enrollments", "id"],
  ["GET", "/v1/workers/not-a-uuid/components", "id"],
  ["GET", "/v1/workers/not-a-uuid/provider-bindings", "id"],
  ["POST", "/v1/workers/not-a-uuid/provider-bindings", "id"],
  [
    "PATCH",
    `/v1/workers/${GOOD}/provider-bindings/not-a-uuid`,
    "bindingId",
  ],
  [
    "POST",
    `/v1/workers/${GOOD}/provider-bindings/not-a-uuid/auth-attempts`,
    "bindingId",
  ],
  [
    "GET",
    `/v1/workers/${GOOD}/provider-bindings/${GOOD}/auth-attempts/not-a-uuid`,
    "authAttemptId",
  ],
  [
    "DELETE",
    `/v1/workers/${GOOD}/provider-bindings/${GOOD}/auth-attempts/not-a-uuid`,
    "authAttemptId",
  ],
  ["DELETE", "/v1/worker-enrollments/not-a-uuid", "id"],
  [
    "POST",
    "/v1/worker-enrollments/not-a-uuid/replacements",
    "id",
  ],
];

Deno.test("every machine route answers a malformed id with a named 400, never a 500", () =>
  withWorkerFixture(async (fixture) => {
    for (const [method, path, param] of MALFORMED) {
      const response = await adminRequest(
        fixture,
        path,
        method === "GET" ? undefined : {},
        {
          method,
          idempotencyKey: crypto.randomUUID(),
          headers: { "If-Match": '"1"' },
        },
      );
      const body = await response.json() as {
        code: string;
        issues?: { path: (string | number)[] }[];
      };
      assertEquals(
        [response.status, body.code, body.issues?.map((issue) => issue.path)],
        [400, "MALFORMED_REQUEST", [[param]]],
        `${method} ${path}`,
      );
    }
  }));

Deno.test("replacing a repair code keeps the machine it repairs", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, { name: "issue70-replace" });
    const hostId = worker.registration.workerHostId;
    const revoked = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/revocations`,
      {},
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(revoked.status, 200, await revoked.clone().text());
    await revoked.body?.cancel();
    const repair = await adminRequest(
      fixture,
      `/v1/workers/${hostId}/enrollments`,
      {},
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(repair.status, 201, await repair.clone().text());
    const repaired = await repair.json() as { enrollmentId: string };
    const replaced = await adminRequest(
      fixture,
      `/v1/worker-enrollments/${repaired.enrollmentId}/replacements`,
      {},
      { idempotencyKey: crypto.randomUUID() },
    );
    assertEquals(replaced.status, 201, await replaced.clone().text());
    const successor = await replaced.json() as { enrollmentId: string };
    const rows = await fixture.pgDatabase.query<{
      id: string;
      target_worker_host_id: string | null;
      expected_credential_generation: number | null;
    }>(
      `select id, target_worker_host_id, expected_credential_generation
         from bakery.worker_enrollments where id = any($1::uuid[])`,
      [[repaired.enrollmentId, successor.enrollmentId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    const before = byId.get(repaired.enrollmentId)!;
    const after = byId.get(successor.enrollmentId)!;
    assertEquals(before.target_worker_host_id, hostId);
    assertEquals(after.target_worker_host_id, hostId);
    assertEquals(
      after.expected_credential_generation,
      before.expected_credential_generation,
    );
  }));
