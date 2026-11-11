import { assertEquals } from "@std/assert";
import { createApp } from "../../apps/server/src/app.ts";
import { createReadyAuthProvider } from "../../apps/server/src/modules/auth/index.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  readRuntimeConfig,
  readTestDatabaseConfig,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  HUMAN_APPROVAL,
  openApprovalFixture,
  PLAN_EFFECT,
} from "../helpers/scoped-approvals.ts";

/** A second server process: fresh pools, fresh app, same database. */
async function restartedApp(secret: string) {
  const { appDatabaseUrl } = readTestDatabaseConfig();
  const appPg = openPgDatabase(appDatabaseUrl);
  const appDatabase = openDatabase(appDatabaseUrl);
  const config = readRuntimeConfig({
    BAKERY_ENV: "test",
    BAKERY_APP_DATABASE_URL: appDatabaseUrl,
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8788",
    BETTER_AUTH_SECRET: secret,
  });
  const persistence = createPostgresAuthPersistence(appPg);
  const auth = await createReadyAuthProvider({
    pgDatabase: appPg,
    config: config.auth!,
    persistence,
  });
  const app = createApp({
    config,
    database: appDatabase,
    pgDatabase: appPg,
    auth,
    authPersistence: persistence,
  });
  return {
    app,
    close: async () => {
      await closePgDatabase(appPg);
      await closeDatabase(appDatabase);
    },
  };
}

Deno.test("a pending and an approved approval survive a server restart and still gate exactly one run", async () => {
  const f = await openApprovalFixture();
  try {
    const pendingTask = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(pendingTask, [PLAN_EFFECT("Pending")]);
    const [pending] = await f.approvalsFor(pendingTask.taskId);
    const approvedTask = await f.newTask({ policy: HUMAN_APPROVAL });
    const approved = await f.approvedPlan(approvedTask);
    const cookie = await f.as(f.fx.developer);

    // Restart: the original app is unused from here on.
    const restarted = await restartedApp(
      "coordination-production-secret-value-32-bytes",
    );
    try {
      const call = (
        method: string,
        path: string,
        body?: unknown,
      ) =>
        restarted.app.fetch(
          new Request(`http://127.0.0.1:8788${path}`, {
            method,
            headers: {
              cookie: cookie.cookie,
              origin: "http://127.0.0.1:8788",
              "Bakery-Organization-Id": f.fx.organizationId,
              "Idempotency-Key": crypto.randomUUID(),
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
      const read = await call("GET", `/v1/approvals/${pending.id}`);
      assertEquals(read.status, 200);
      assertEquals((await read.json()).status, "open");
      // The pending approval is still decidable after the restart.
      const decided = await call(
        "POST",
        `/v1/approvals/${pending.id}/decision`,
        { decision: "approve", expectedVersion: pending.version },
      );
      assertEquals(decided.status, 200);
      // The approved one admits exactly one run across the restart.
      const pinned = await f.fx.owner`
        select repository_profile_id as id from bakery.tasks
         where id = ${approvedTask.taskId}`;
      const start = () =>
        call("POST", `/v1/tasks/${approvedTask.taskId}/runs`, {
          workflowVersionId: f.fx.workflowVersionId,
          repositoryProfileId: pinned[0].id,
          executionMode: "repository",
          budgetLimitUsd: "0.005000",
          inputs: { taskId: approvedTask.taskId },
          approvalId: approved.id,
        });
      assertEquals((await start()).status, 201);
      assertEquals((await start()).status, 409);
      assertEquals(await f.runCount(approvedTask.taskId), 1);
    } finally {
      await restarted.close();
    }
  } finally {
    await f.close();
  }
});
