import { assertEquals } from "@std/assert";
import {
  createAuthProvider,
} from "../../apps/server/src/modules/auth/index.ts";
import {
  createPostgresAuthPersistence,
} from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  createBrowserSessionMiddleware,
} from "../../apps/server/src/modules/auth/middleware.ts";
import {
  createExecutionControlApp,
  createExecutionWorkerCleanupApp,
} from "../../apps/server/src/modules/execution/control.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerScope,
  createWorkerScope,
  problemCode,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";

function controlAppForFixture(fixture: WorkerFixture) {
  const authStore = createPostgresAuthPersistence(
    fixture.runtimePgDatabase,
  );
  const auth = createAuthProvider({
    pgDatabase: fixture.runtimePgDatabase,
    config: fixture.config.auth!,
    persistence: authStore,
  });
  return createExecutionControlApp({
    database: fixture.runtimePgDatabase,
    browserSession: createBrowserSessionMiddleware({
      auth,
      store: authStore,
      publicBaseUrl: fixture.config.publicBaseUrl,
      trustedOrigins: [fixture.config.publicBaseUrl],
      secret: fixture.config.auth!.secret,
    }),
    publicBaseUrl: fixture.config.publicBaseUrl,
    secret: fixture.config.auth!.secret,
  });
}

Deno.test("security boundary enforces origin tenant and RFC 9457 not-found", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-security-boundary",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, job.jobId);
    const controlApp = controlAppForFixture(fixture);
    const controlUrl =
      `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`;
    const wrongOrigin = await controlApp.fetch(
      new Request(controlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://attacker.invalid",
          "Bakery-Organization-Id": fixture.organizationId,
          "Cookie": fixture.adminCookie,
          "Idempotency-Key": "issue42-security-origin",
        },
        body: JSON.stringify({ action: "pause" }),
      }),
    );
    assertEquals(wrongOrigin.status, 403);
    assertEquals(await problemCode(wrongOrigin), "AUTH_FORBIDDEN");

    const foreignScope = await createWorkerScope(
      fixture,
      "issue42-security-foreign",
      fixture,
    );
    try {
      const foreignTenant = await controlApp.fetch(
        new Request(controlUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": foreignScope.organizationId,
            "Cookie": foreignScope.adminCookie,
            "Idempotency-Key": "issue42-security-tenant",
          },
          body: JSON.stringify({ action: "pause" }),
        }),
      );
      assertEquals(foreignTenant.status, 404);
      const foreignCode = await problemCode(foreignTenant);
      assertEquals(foreignCode, "RESOURCE_NOT_FOUND");

      const missingAttemptId = crypto.randomUUID();
      const missing = await controlApp.fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/execution/attempts/${missingAttemptId}/control`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Origin": fixture.config.publicBaseUrl,
              "Bakery-Organization-Id": fixture.organizationId,
              "Cookie": fixture.adminCookie,
              "Idempotency-Key": "issue42-security-missing-attempt",
            },
            body: JSON.stringify({ action: "pause" }),
          },
        ),
      );
      assertEquals(missing.status, foreignTenant.status);
      assertEquals(await problemCode(missing), foreignCode);
    } finally {
      await closeWorkerScope(fixture, foreignScope);
    }
  }));

Deno.test("cleanup requires worker authority and bounded canonical fields", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-cleanup-boundary",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, job.jobId);
    if (
      !worker.registration.workerSessionId ||
      worker.registration.workerSessionGeneration === undefined
    ) throw new Error("WORKER_SESSION_MISSING");
    const cleanupPath = `/v1/worker/attempts/${assignment.attemptId}/cleanup`;
    const workerHeaders = {
      "Authorization": `Bearer ${worker.credential}`,
      "Content-Type": "application/json",
      "X-Bakery-Worker-Protocol-Version": "2",
    };
    const cleanupApp = createExecutionWorkerCleanupApp({
      database: fixture.runtimePgDatabase,
      publicBaseUrl: fixture.config.publicBaseUrl,
      secret: fixture.config.auth!.secret,
    });
    const validEvidence = {
      fence: assignment.fence,
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: String(
        worker.registration.workerSessionGeneration,
      ),
      observedByWorkerSessionId: worker.registration.workerSessionId,
      observedByWorkerSessionGeneration: String(
        worker.registration.workerSessionGeneration,
      ),
      exitedAt: new Date().toISOString(),
    };
    const anonymous = await cleanupApp.fetch(
      new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validEvidence),
      }),
    );
    assertEquals(anonymous.status, 401);
    assertEquals(await problemCode(anonymous), "AUTH_REQUIRED");
    const runningAttempt = await cleanupApp.fetch(
      new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify(validEvidence),
      }),
    );
    assertEquals(runningAttempt.status, 409);
    assertEquals(await problemCode(runningAttempt), "STATE_CONFLICT");
    const foreignScope = await createWorkerScope(
      fixture,
      "issue42-cleanup-foreign",
      fixture,
    );
    try {
      const foreignWorker = await registeredWorker(fixture, {
        name: "issue42-cleanup-foreign-worker",
        scope: foreignScope,
      });
      const foreignCleanup = await cleanupApp.fetch(
        new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${foreignWorker.credential}`,
            "Content-Type": "application/json",
            "X-Bakery-Worker-Protocol-Version": "2",
          },
          body: JSON.stringify({
            ...validEvidence,
            workerSessionId: foreignWorker.registration.workerSessionId,
            workerSessionGeneration: String(
              foreignWorker.registration.workerSessionGeneration,
            ),
            observedByWorkerSessionId:
              foreignWorker.registration.workerSessionId,
            observedByWorkerSessionGeneration: String(
              foreignWorker.registration.workerSessionGeneration,
            ),
          }),
        }),
      );
      assertEquals(foreignCleanup.status, 404);
      assertEquals(await problemCode(foreignCleanup), "RESOURCE_NOT_FOUND");
    } finally {
      await closeWorkerScope(fixture, foreignScope);
    }
    const malformed = await cleanupApp.fetch(
      new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify({
          fence: "01",
          workerSessionId: worker.registration.workerSessionId,
          workerSessionGeneration: String(
            worker.registration.workerSessionGeneration,
          ),
          exitedAt: new Date().toISOString(),
        }),
      }),
    );
    assertEquals(malformed.status, 422);
    assertEquals(await problemCode(malformed), "UNPROCESSABLE");
    const staleAuthority = await cleanupApp.fetch(
      new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify({
          fence: assignment.fence,
          workerSessionId: crypto.randomUUID(),
          workerSessionGeneration: String(
            worker.registration.workerSessionGeneration,
          ),
          observedByWorkerSessionId: worker.registration.workerSessionId,
          observedByWorkerSessionGeneration: String(
            worker.registration.workerSessionGeneration,
          ),
          exitedAt: new Date().toISOString(),
        }),
      }),
    );
    assertEquals(staleAuthority.status, 409);
    assertEquals(await problemCode(staleAuthority), "STATE_CONFLICT");
    const browserCleanup = await controlAppForFixture(fixture).fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/cleanup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
            "Cookie": fixture.adminCookie,
          },
          body: JSON.stringify({
            fence: assignment.fence,
            workerSessionId: worker.registration.workerSessionId,
            workerSessionGeneration: String(
              worker.registration.workerSessionGeneration,
            ),
            observedByWorkerSessionId: worker.registration.workerSessionId,
            observedByWorkerSessionGeneration: String(
              worker.registration.workerSessionGeneration,
            ),
            exitedAt: new Date().toISOString(),
          }),
        },
      ),
    );
    assertEquals(browserCleanup.status, 404);
    assertEquals(await problemCode(browserCleanup), "RESOURCE_NOT_FOUND");
  }));

Deno.test("cleanup binds observer attribution to the recorded attempt session", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "issue42-cleanup-observer",
    });
    const job = await seedFundedModelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker);
    assertEquals(assignment.jobId, job.jobId);
    if (
      !worker.registration.workerSessionId ||
      worker.registration.workerSessionGeneration === undefined
    ) throw new Error("WORKER_SESSION_MISSING");
    const workerSessionId = worker.registration.workerSessionId;
    const workerSessionGeneration = String(
      worker.registration.workerSessionGeneration,
    );
    const controlApp = controlAppForFixture(fixture);
    const cancellation = await controlApp.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/execution/attempts/${assignment.attemptId}/control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: fixture.config.publicBaseUrl,
            "Bakery-Organization-Id": fixture.organizationId,
            Cookie: fixture.adminCookie,
            "Idempotency-Key": "issue42-cleanup-observer-cancel",
          },
          body: JSON.stringify({ action: "cancel" }),
        },
      ),
    );
    assertEquals(cancellation.status, 202);

    const cleanupApp = createExecutionWorkerCleanupApp({
      database: fixture.runtimePgDatabase,
      publicBaseUrl: fixture.config.publicBaseUrl,
      secret: fixture.config.auth!.secret,
    });
    const cleanupPath = `/v1/worker/attempts/${assignment.attemptId}/cleanup`;
    const evidence = {
      fence: assignment.fence,
      workerSessionId,
      workerSessionGeneration,
      exitedAt: new Date().toISOString(),
    };

    const arbitraryObserver = await cleanupApp.fetch(
      new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.credential}`,
          "Content-Type": "application/json",
          "X-Bakery-Worker-Protocol-Version": "2",
        },
        body: JSON.stringify({
          ...evidence,
          observedByWorkerSessionId: crypto.randomUUID(),
          observedByWorkerSessionGeneration: workerSessionGeneration,
        }),
      }),
    );
    assertEquals(arbitraryObserver.status, 409);
    assertEquals(await problemCode(arbitraryObserver), "STATE_CONFLICT");
    const recordedObserver = await cleanupApp.fetch(
      new Request(`${fixture.config.publicBaseUrl}${cleanupPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.credential}`,
          "Content-Type": "application/json",
          "X-Bakery-Worker-Protocol-Version": "2",
        },
        body: JSON.stringify({
          ...evidence,
          observedByWorkerSessionId: workerSessionId,
          observedByWorkerSessionGeneration: workerSessionGeneration,
        }),
      }),
    );
    assertEquals(recordedObserver.status, 200);
    const confirmed = await recordedObserver.json() as {
      cancellation: {
        cleanupStatus: string;
        terminationStatus: string;
        processExited: boolean;
        cleanupObserver: {
          observedBy: {
            workerSessionId: string;
            workerSessionGeneration: string;
          };
        };
      };
    };
    assertEquals(confirmed.cancellation.cleanupStatus, "complete");
    assertEquals(confirmed.cancellation.terminationStatus, "confirmed");
    assertEquals(confirmed.cancellation.processExited, true);
    assertEquals(
      confirmed.cancellation.cleanupObserver.observedBy.workerSessionId,
      workerSessionId,
    );
    assertEquals(
      confirmed.cancellation.cleanupObserver.observedBy
        .workerSessionGeneration,
      workerSessionGeneration,
    );
  }));
