import { assert, assertEquals } from "@std/assert";
import { openSecretsFixture } from "../helpers/secrets.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerRequest,
} from "../helpers/worker-execution.ts";

function workerFixture(
  f: Awaited<ReturnType<typeof openSecretsFixture>>,
): WorkerFixture {
  return {
    app: f.fixture.app,
    pgDatabase: f.fixture.pgDatabase,
    runtimePgDatabase: f.fixture.pgDatabase,
    config: f.fixture.config,
    email: "fixture-owned-by-secrets-helper@example.test",
    organizationId: f.organizationId,
    principalId: f.principalId,
    adminCookie: f.adminCookie,
    ownsAuthIdentity: false,
    workerHostIds: [],
    close: () => Promise.resolve(),
    releaseFixture: () => {},
  };
}

Deno.test("prepared secret route authenticates W and rejects caller-controlled selector fields without I/O", async () => {
  const f = await openSecretsFixture();
  try {
    const fixture = workerFixture(f);
    const attemptId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const path = `/v1/worker/attempts/${attemptId}/tools/secrets`;
    const noAuth = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": operationId,
            "X-Bakery-Worker-Protocol-Version": "2",
            "X-Worker-Session-Id": crypto.randomUUID(),
            "X-Worker-Session-Generation": "1",
            "X-Worker-Lease-Token": "l".repeat(43),
            "X-Worker-Fence": "1",
          },
          body: JSON.stringify({ preparedOperationId: operationId }),
        },
      ),
    );
    assertEquals(noAuth.status, 401);
    assertEquals((await noAuth.json()).code, "AUTH_REQUIRED");

    const worker = await registeredWorker(fixture, {
      capabilities: ["secret.identity"],
    });
    const before = f.calls();
    const malicious = await workerRequest(
      fixture,
      worker.credential,
      path,
      {
        preparedOperationId: operationId,
        provider: "must-not-echo",
      },
      {
        idempotencyKey: operationId,
        includeWorkerSession: false,
        headers: {
          "X-Worker-Session-Id": worker.registration.workerSessionId,
          "X-Worker-Session-Generation": worker.registration
            .workerSessionGeneration,
          "X-Worker-Lease-Token": "l".repeat(43),
          "X-Worker-Fence": "1",
          "X-Bakery-Worker-Protocol-Version": "2",
        },
      },
    );
    assertEquals(malicious.status, 422);
    const body = await malicious.text();
    assert(body.includes("UNPROCESSABLE"), body);
    assert(!body.includes("must-not-echo"));
    assertEquals(f.calls(), before);
  } finally {
    await f.cleanup();
  }
});
