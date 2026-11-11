import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assertEquals } from "@std/assert";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
  resetTestDatabase,
} from "../../apps/server/src/platform/migrate.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  preserveProviderInvitationState,
} from "../../apps/server/src/modules/auth/migrations.ts";
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";

const { databaseUrl, appDatabaseUrl } = readTestDatabaseConfig();
const fixturePath = new URL(
  "./fixtures/task-command-server.ts",
  import.meta.url,
).pathname;

async function startFixture(environment: Record<string, string>): Promise<{
  child: Deno.ChildProcess;
  port: number;
}> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-net",
      "--allow-run",
      fixturePath,
    ],
    env: { ...Deno.env.toObject(), ...environment },
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = /FIXTURE_PORT=(\d+)/.exec(buffer);
    if (match) {
      void (async () => {
        try {
          while (!(await reader.read()).done) { /* drain */ }
        } catch { /* pipe closed */ }
      })();
      return { child, port: Number(match[1]) };
    }
  }
  child.kill();
  throw new Error("FIXTURE_START_FAILED");
}

Deno.test("a fresh process replays a response committed before response loss", async () => {
  const owner = openDatabase(databaseUrl);
  const authDb = openPgDatabase(databaseUrl);
  const providerUserId = crypto.randomUUID();
  const email = `restart-${providerUserId}@example.test`;
  try {
    await resetTestDatabase(owner, {
      targetUrl: databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
    await migrateProvider(
      authDb,
      await loadMigrations(betterAuthMigrationSource),
      { beforeApply: preserveProviderInvitationState },
    );
    await migrate(owner, [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ]);
    await migrateData(owner, bakeryDataMigrations);

    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const applicationId = crypto.randomUUID();
    const now = new Date("2026-09-12T00:00:00.000Z");
    await owner`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${providerUserId}, 'Restart Tester',
        ${email}, true, ${now}, ${now}
      )`;
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${principalId}, ${providerUserId}, 'Restart Tester', 'human')`;
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationId}, 'Restart Org', ${`org-${organizationId}`},
        '{}'::jsonb, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${organizationId}, ${principalId},
        'developer', 'active', ${now}, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${applicationId}, ${organizationId}, ${`app-${applicationId}`},
        'Restart App', ''
      )`;

    const commonEnv = {
      FIXTURE_APP_DATABASE_URL: appDatabaseUrl,
      FIXTURE_PRINCIPAL_ID: principalId,
      FIXTURE_DISPLAY_NAME: "Restart Tester",
    };
    const createBody = JSON.stringify({
      applicationId,
      taskType: "feature",
      title: "Committed before loss",
    });
    const requestHeaders = {
      "content-type": "application/json",
      "Bakery-Organization-Id": organizationId,
      "Idempotency-Key": "restart-key-1",
    };

    const first = await startFixture({
      ...commonEnv,
      FIXTURE_DROP_KEY: "restart-key-1",
    });
    let dropped = false;
    try {
      await fetch(`http://127.0.0.1:${first.port}/v1/tasks`, {
        method: "POST",
        headers: requestHeaders,
        body: createBody,
      });
    } catch {
      dropped = true;
    }
    assertEquals(dropped, true);
    await first.child.status;

    const committed = await owner`
      select t.id, r.status, r.response_status
      from bakery.idempotency_records as r
      join bakery.tasks as t
        on t.organization_id = r.organization_id
      where r.organization_id = ${organizationId}
        and r.operation = 'tasks.create' and r.key = 'restart-key-1'`;
    assertEquals(committed.length, 1);
    assertEquals(committed[0].status, "completed");
    assertEquals(committed[0].response_status, 201);
    const committedTaskId = committed[0].id as string;

    const second = await startFixture(commonEnv);
    try {
      const replay = await fetch(
        `http://127.0.0.1:${second.port}/v1/tasks`,
        {
          method: "POST",
          headers: requestHeaders,
          body: createBody,
        },
      );
      assertEquals(replay.status, 201);
      assertEquals(replay.headers.get("idempotent-replayed"), "true");
      const replayed = await replay.json();
      assertEquals(replayed.id, committedTaskId);
    } finally {
      second.child.kill();
      await second.child.status;
    }

    const counts = await owner`
      select
        (select count(*)::int from bakery.tasks) as tasks,
        (select count(*)::int from bakery.conversations) as conversations,
        (select count(*)::int from bakery.domain_events) as events,
        (select count(*)::int from bakery.outbox) as outbox,
        (select count(*)::int from bakery.audit_events) as audits`;
    assertEquals(counts[0], {
      tasks: 1,
      conversations: 1,
      events: 1,
      outbox: 1,
      audits: 1,
    });
  } finally {
    await cleanupAuthFixture(authDb, [email]);
    await closePgDatabase(authDb);
    await closeDatabase(owner);
  }
});
