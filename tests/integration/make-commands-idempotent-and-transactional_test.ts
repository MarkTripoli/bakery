import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assertEquals } from "@std/assert";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
  type PgTransactionClient,
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
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import {
  createPostgresAuthPersistence,
} from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  createAuthV1Routes,
} from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import {
  createPostgresCommandRunner,
  idempotencyLockKey,
} from "../../apps/server/src/platform/command-replay.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";

const { databaseUrl, appDatabaseUrl } = readTestDatabaseConfig();
const { adminDatabaseUrl } = readTestDatabaseConfig(Deno.env.toObject(), {
  requireAdmin: true,
});
Deno.test("task commands replay exactly once through one tenant transaction", async (test) => {
  const owner = openDatabase(databaseUrl);
  const authDb = openPgDatabase(databaseUrl);
  const appPg = openPgDatabase(appDatabaseUrl);
  const admin = openPgDatabase(adminDatabaseUrl, 1);
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
    const providerUserId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const applicationId = crypto.randomUUID();
    const secondApplicationId = crypto.randomUUID();
    const now = new Date("2026-09-12T00:00:00.000Z");
    await owner`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${providerUserId}, 'Task Tester',
        ${`tester-${providerUserId}@example.test`}, true, ${now}, ${now}
      )`;
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${principalId}, ${providerUserId}, 'Task Tester', 'human')`;
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationId}, 'Test Org', ${`org-${organizationId}`},
        '{}'::jsonb, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${membershipId}, ${organizationId}, ${principalId}, 'developer',
        'active', ${now}, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${applicationId}, ${organizationId}, ${`app-${applicationId}`},
        'Test App', ''
      )`;
    await owner`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${secondApplicationId}, ${organizationId},
        ${`second-app-${secondApplicationId}`}, 'Second App', ''
      )`;

    const principal = {
      principalId,
      principalType: "human" as const,
      displayName: "Task Tester",
    };
    const handlers = createWorkTaskHandlers("issue-29-command-sync-secret");
    const failingRegistry = createTaskActionRegistry({
      ...handlers,
      create: async (context, input) => {
        await handlers.create(context, input);
        throw new Error("INJECTED_AFTER_TASK_COMMAND");
      },
    }, {
      authorityRunner: new PostgresAuthorityRunner(appPg),
      commandRunner: createPostgresCommandRunner(),
    });
    const failingApp = createApiRouter({
      registry: failingRegistry,
      createContext: () => ({ principal }),
    });
    const rollbackKey = "create-key-rollback";
    const rollbackBody = JSON.stringify({
      applicationId,
      taskType: "feature",
      title: "Rollback task",
    });
    const failed = await failingApp.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": rollbackKey,
        },
        body: rollbackBody,
      }),
    );
    assertEquals(failed.status, 500);
    assertEquals((await failed.json()).code, "INTERNAL");
    const rollbackCounts = await owner`
      select
        (select count(*)::int from bakery.tasks) as tasks,
        (select count(*)::int from bakery.conversations) as conversations,
        (select count(*)::int from bakery.audit_events) as audits,
        (select count(*)::int from bakery.domain_events) as events,
        (select count(*)::int from bakery.outbox) as outbox,
        (select count(*)::int from bakery.idempotency_records
          where operation = 'tasks.create' and key = ${rollbackKey}) as records
    `;
    assertEquals(rollbackCounts[0], {
      tasks: 0,
      conversations: 0,
      audits: 0,
      events: 0,
      outbox: 0,
      records: 0,
    });

    const registry = createTaskActionRegistry(handlers, {
      authorityRunner: new PostgresAuthorityRunner(appPg),
      commandRunner: createPostgresCommandRunner(),
    });
    const app = createApiRouter({
      registry,
      createContext: () => ({ principal }),
    });
    const baseHeaders = {
      "content-type": "application/json",
      "Bakery-Organization-Id": organizationId,
      "Idempotency-Key": rollbackKey,
    };
    const createBody = JSON.stringify({
      applicationId,
      taskType: "feature",
      title: "First task",
    });
    const created = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: baseHeaders,
        body: createBody,
      }),
    );
    assertEquals(created.status, 201);
    const task = await created.json() as Record<string, unknown>;
    assertEquals(task.version, 1);
    assertEquals(task.status, "draft");
    assertEquals(task.applicationId, applicationId);
    assertEquals(typeof task.conversationId, "string");
    assertEquals(created.headers.get("idempotent-replayed"), null);
    assertEquals(
      (await owner`
        select event_type as "eventType", payload
        from bakery.domain_events
        where aggregate_id = ${task.id as string} and aggregate_version = 1
      `)[0],
      {
        eventType: "tasks.created",
        payload: { resourceId: task.id, resourceVersion: 1 },
      },
    );

    const replayed = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: baseHeaders,
        body: createBody,
      }),
    );
    assertEquals(replayed.status, 201);
    assertEquals(replayed.headers.get("idempotent-replayed"), "true");
    const replayedTask = await replayed.json() as Record<string, unknown>;
    assertEquals(replayedTask.id, task.id);
    assertEquals(replayedTask.conversationId, task.conversationId);

    await owner`
      update bakery.idempotency_records
         set expires_at = current_timestamp - interval '1 second'
       where organization_id = ${organizationId}
         and principal_id = ${principalId}
         and operation = 'tasks.create'
         and key = ${rollbackKey}`;
    const expiredReplay = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: baseHeaders,
        body: createBody,
      }),
    );
    assertEquals(expiredReplay.status, 201);
    assertEquals(expiredReplay.headers.get("idempotent-replayed"), null);
    const expiredTask = await expiredReplay.json() as Record<string, unknown>;
    assertEquals(expiredTask.id === task.id, false);
    const refreshedReceipt = await owner`
      select status, response_body, expires_at > current_timestamp as live
        from bakery.idempotency_records
       where organization_id = ${organizationId}
         and principal_id = ${principalId}
         and operation = 'tasks.create'
         and key = ${rollbackKey}`;
    assertEquals(refreshedReceipt.length, 1);
    assertEquals(refreshedReceipt[0], {
      status: "completed",
      response_body: JSON.stringify(expiredTask),
      live: true,
    });

    const blankCreateKey = "create-key-blank-title";
    const blankCreate = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: { ...baseHeaders, "Idempotency-Key": blankCreateKey },
        body: JSON.stringify({
          applicationId,
          taskType: "feature",
          title: " ",
        }),
      }),
    );
    assertEquals(blankCreate.status, 400);
    assertEquals((await blankCreate.json()).code, "MALFORMED_REQUEST");
    assertEquals(
      (await owner`
        select count(*)::int as count from bakery.idempotency_records
        where operation = 'tasks.create' and key = ${blankCreateKey}
      `)[0].count,
      0,
    );

    const mismatched = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          applicationId,
          taskType: "bug",
          title: "Changed payload",
        }),
      }),
    );
    assertEquals(mismatched.status, 422);
    assertEquals(
      (await mismatched.json()).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );

    const taskId = task.id as string;
    const updateHeaders = {
      "content-type": "application/json",
      "Bakery-Organization-Id": organizationId,
      "Idempotency-Key": "update-key-1",
      "If-Match": '"1"',
    };
    const updated = await app.fetch(
      new Request(`http://test/v1/tasks/${taskId}`, {
        method: "PATCH",
        headers: updateHeaders,
        body: JSON.stringify({ title: "Renamed task" }),
      }),
    );
    assertEquals(updated.status, 200);
    const updatedTask = await updated.json() as Record<string, unknown>;
    assertEquals(updatedTask.version, 2);
    assertEquals(updatedTask.title, "Renamed task");
    assertEquals(
      (await owner`
        select event_type as "eventType", payload
        from bakery.domain_events
        where aggregate_id = ${taskId} and aggregate_version = 2
      `)[0],
      {
        eventType: "tasks.updated",
        payload: { resourceId: taskId, resourceVersion: 2 },
      },
    );

    const blankUpdateKey = "update-key-blank-title";
    const blankUpdate = await app.fetch(
      new Request(`http://test/v1/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          ...updateHeaders,
          "Idempotency-Key": blankUpdateKey,
        },
        body: JSON.stringify({ title: "" }),
      }),
    );
    assertEquals(blankUpdate.status, 400);
    assertEquals((await blankUpdate.json()).code, "MALFORMED_REQUEST");
    const afterBlankUpdate = await owner`
      select title, version from bakery.tasks where id = ${taskId}
    `;
    assertEquals(afterBlankUpdate[0], { title: "Renamed task", version: 2 });
    assertEquals(
      (await owner`
        select count(*)::int as count from bakery.idempotency_records
        where operation = 'tasks.update' and key = ${blankUpdateKey}
      `)[0].count,
      0,
    );

    const largeVersion = await app.fetch(
      new Request(`http://test/v1/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          ...updateHeaders,
          "Idempotency-Key": "update-key-large-version",
          "If-Match": '"2147483648"',
        },
        body: JSON.stringify({ title: "Unsupported version" }),
      }),
    );
    assertEquals(largeVersion.status, 428);
    assertEquals((await largeVersion.json()).code, "PRECONDITION_REQUIRED");

    const stale = await app.fetch(
      new Request(`http://test/v1/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          ...updateHeaders,
          "Idempotency-Key": "update-key-2",
          "If-Match": '"1"',
        },
        body: JSON.stringify({ title: "Stale write" }),
      }),
    );
    assertEquals(stale.status, 412);
    assertEquals((await stale.json()).code, "PRECONDITION_FAILED");

    const parent = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: { ...baseHeaders, "Idempotency-Key": "parent-valid" },
        body: JSON.stringify({
          applicationId,
          taskType: "feature",
          title: "Child task",
          parentId: taskId,
        }),
      }),
    );
    assertEquals(parent.status, 201);
    assertEquals((await parent.json()).parentTaskId, taskId);

    const crossApplicationParent = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: {
          ...baseHeaders,
          "Idempotency-Key": "parent-cross-application",
        },
        body: JSON.stringify({
          applicationId: secondApplicationId,
          taskType: "feature",
          title: "Invalid child task",
          parentId: taskId,
        }),
      }),
    );
    assertEquals(crossApplicationParent.status, 404);
    assertEquals(
      (await crossApplicationParent.json()).code,
      "RESOURCE_NOT_FOUND",
    );

    const unknownParent = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: { ...baseHeaders, "Idempotency-Key": "parent-unknown" },
        body: JSON.stringify({
          applicationId,
          taskType: "feature",
          title: "Invalid child task",
          parentId: crypto.randomUUID(),
        }),
      }),
    );
    assertEquals(unknownParent.status, 404);
    assertEquals((await unknownParent.json()).code, "RESOURCE_NOT_FOUND");

    const beforeRace = await owner`
      select
        (select count(*)::int from bakery.audit_events) as audits,
        (select count(*)::int from bakery.domain_events) as events,
        (select count(*)::int from bakery.outbox) as outbox
    `;
    const raceResponses = await Promise.all([
      app.fetch(
        new Request(`http://test/v1/tasks/${taskId}`, {
          method: "PATCH",
          headers: {
            ...updateHeaders,
            "Idempotency-Key": "update-race-1",
            "If-Match": '"2"',
          },
          body: JSON.stringify({ title: "Racing update one" }),
        }),
      ),
      app.fetch(
        new Request(`http://test/v1/tasks/${taskId}`, {
          method: "PATCH",
          headers: {
            ...updateHeaders,
            "Idempotency-Key": "update-race-2",
            "If-Match": '"2"',
          },
          body: JSON.stringify({ title: "Racing update two" }),
        }),
      ),
    ]);
    assertEquals(
      raceResponses.map((response) => response.status).sort(),
      [200, 412],
    );
    const winningResponse = raceResponses[0].status === 200
      ? raceResponses[0]
      : raceResponses[1];
    assertEquals((await winningResponse.json()).version, 3);
    const losingResponse = raceResponses[0].status === 412
      ? raceResponses[0]
      : raceResponses[1];
    assertEquals((await losingResponse.json()).code, "PRECONDITION_FAILED");
    const afterRace = await owner`
      select
        (select count(*)::int from bakery.audit_events) as audits,
        (select count(*)::int from bakery.domain_events) as events,
        (select count(*)::int from bakery.outbox) as outbox
    `;
    assertEquals(afterRace[0].audits - beforeRace[0].audits, 1);
    assertEquals(afterRace[0].events - beforeRace[0].events, 1);
    assertEquals(afterRace[0].outbox - beforeRace[0].outbox, 1);

    const counts = await owner`
      select
        (select count(*)::int from bakery.tasks) as tasks,
        (select count(*)::int from bakery.conversations) as conversations,
        (select count(*)::int from bakery.domain_events) as events,
        (select count(*)::int from bakery.outbox) as outbox,
        (select count(*)::int from bakery.audit_events) as audits,
        (select count(*)::int from bakery.idempotency_records) as records
    `;
    assertEquals(counts[0], {
      tasks: 3,
      conversations: 3,
      events: 5,
      outbox: 5,
      audits: 5,
      records: 4,
    });

    await test.step("concurrent writes allocate consecutive tenant events", async () => {
      const beforeConcurrentClock = await owner`
      select (next_seq - 1)::text as highwater
      from bakery.event_clock
      where organization_id = ${organizationId}
        and stream = 'domain_events'
    `;
      const concurrentCreateResponses = await Promise.all(
        ["concurrent-create-1", "concurrent-create-2"].map((key) =>
          app.fetch(
            new Request("http://test/v1/tasks", {
              method: "POST",
              headers: { ...baseHeaders, "Idempotency-Key": key },
              body: createBody,
            }),
          )
        ),
      );
      assertEquals(
        concurrentCreateResponses.map(({ status }) => status),
        [201, 201],
      );
      const concurrentTasks = await Promise.all(
        concurrentCreateResponses.map((response) =>
          response.json() as Promise<{ id: string }>
        ),
      );
      const concurrentSequences = await owner`
      select organization_sequence::text as sequence
      from bakery.domain_events
      where organization_id = ${organizationId}
        and aggregate_id in (
          ${concurrentTasks[0].id},
          ${concurrentTasks[1].id}
        )
      order by organization_sequence
    `;
      const firstConcurrentSequence =
        (BigInt(beforeConcurrentClock[0].highwater) + 1n).toString();
      const secondConcurrentSequence =
        (BigInt(beforeConcurrentClock[0].highwater) + 2n).toString();
      assertEquals([...concurrentSequences], [
        { sequence: firstConcurrentSequence },
        { sequence: secondConcurrentSequence },
      ]);
      const synchronized = await app.fetch(
        new Request(
          `http://test/v1/sync?scopeType=application&scopeId=${applicationId}`,
          { headers: { "Bakery-Organization-Id": organizationId } },
        ),
      );
      assertEquals(synchronized.status, 200, await synchronized.clone().text());
      assertEquals(
        (await synchronized.json() as { highwater: string }).highwater,
        secondConcurrentSequence,
      );
    });

    const holder = await appPg.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [idempotencyLockKey({
          scope: "organization",
          organizationId,
          principalId,
          operation: "tasks.create",
          key: "create-key-inflight",
        })],
      );
      const inFlight = await app.fetch(
        new Request("http://test/v1/tasks", {
          method: "POST",
          headers: { ...baseHeaders, "Idempotency-Key": "create-key-inflight" },
          body: createBody,
        }),
      );
      assertEquals(inFlight.status, 409);
      assertEquals((await inFlight.json()).code, "IDEMPOTENCY_IN_FLIGHT");
    } finally {
      await holder.query("rollback");
      holder.release();
    }

    const deadlineApp = createApiRouter({
      registry,
      createContext: () => ({ principal }),
      deadlineMs: 100,
    });
    const deadlineHolder = await authDb.connect();
    const deadlineKey = "update-key-deadline";
    try {
      await deadlineHolder.query("begin");
      await deadlineHolder.query(
        "select id from bakery.tasks where id = $1 for update",
        [taskId],
      );
      const timedOut = await deadlineApp.fetch(
        new Request(`http://test/v1/tasks/${taskId}`, {
          method: "PATCH",
          headers: {
            ...updateHeaders,
            "Idempotency-Key": deadlineKey,
            "If-Match": '"3"',
          },
          body: JSON.stringify({ title: "Timed out update" }),
        }),
      );
      assertEquals(timedOut.status, 504);

      let activeTransactions = 1;
      for (
        let attempt = 0;
        attempt < 40 && activeTransactions !== 0;
        attempt++
      ) {
        const activity = await admin.query<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
           where usename = 'bakery_app' and state <> 'idle'`,
        );
        activeTransactions = activity.rows[0]?.count ?? 0;
        if (activeTransactions !== 0) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assertEquals(activeTransactions, 0);
    } finally {
      await deadlineHolder.query("rollback");
      deadlineHolder.release();
    }
    const recovered = await app.fetch(
      new Request(`http://test/v1/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          ...updateHeaders,
          "Idempotency-Key": deadlineKey,
          "If-Match": '"3"',
        },
        body: JSON.stringify({ title: "Timed out update" }),
      }),
    );
    assertEquals(recovered.status, 200);
    assertEquals((await recovered.json()).version, 4);

    const otherOrganizationId = crypto.randomUUID();
    const otherApplicationId = crypto.randomUUID();
    const otherSlug = `org-other-${otherOrganizationId}`;
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${otherOrganizationId}, 'Other Org', ${otherSlug}, '{}'::jsonb,
        ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${otherOrganizationId}, ${principalId},
        'developer', 'active', ${now}, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${otherApplicationId}, ${otherOrganizationId},
        ${`app-other-${otherApplicationId}`}, 'Other App', ''
      )`;

    const servicePrincipalId = crypto.randomUUID();
    const wrongGrantPrincipalId = crypto.randomUUID();
    const expiredGrantPrincipalId = crypto.randomUUID();
    const revokedGrantPrincipalId = crypto.randomUUID();
    const foreignGrantPrincipalId = crypto.randomUUID();
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values
        (${servicePrincipalId}, null, 'Task Service', 'service'),
        (${wrongGrantPrincipalId}, null, 'Wrong Grant Service', 'service'),
        (${expiredGrantPrincipalId}, null, 'Expired Grant Service', 'service'),
        (${revokedGrantPrincipalId}, null, 'Revoked Grant Service', 'service'),
        (${foreignGrantPrincipalId}, null, 'Foreign Grant Service', 'service')
    `;
    await admin.query(
      `insert into bakery.permission_grants (
        organization_id, principal_id, capability, expires_at, revoked_at,
        granted_by_principal_id
      ) values
        ($1, $2, 'tasks.create', null, null, $7),
        ($1, $2, 'tasks.update', null, null, $7),
        ($1, $3, 'tasks.update', null, null, $7),
        ($1, $4, 'tasks.create', now() - interval '1 minute', null, $7),
        ($1, $5, 'tasks.create', null, now(), $7),
        ($6, $8, 'tasks.create', null, null, $7)`,
      [
        organizationId,
        servicePrincipalId,
        wrongGrantPrincipalId,
        expiredGrantPrincipalId,
        revokedGrantPrincipalId,
        otherOrganizationId,
        principalId,
        foreignGrantPrincipalId,
      ],
    );
    const servicePrincipal = {
      principalId: servicePrincipalId,
      principalType: "service" as const,
      displayName: "Task Service",
    };
    const serviceApp = createApiRouter({
      registry,
      createContext: () => ({ principal: servicePrincipal }),
    });
    const serviceCreated = await serviceApp.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: { ...baseHeaders, "Idempotency-Key": "service-create" },
        body: createBody,
      }),
    );
    assertEquals(serviceCreated.status, 201);
    const serviceTask = await serviceCreated.json() as Record<string, unknown>;
    const serviceReplayed = await serviceApp.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: { ...baseHeaders, "Idempotency-Key": "service-create" },
        body: createBody,
      }),
    );
    assertEquals(serviceReplayed.status, 201);
    assertEquals(serviceReplayed.headers.get("idempotent-replayed"), "true");
    assertEquals((await serviceReplayed.json()).id, serviceTask.id);
    const serviceUpdated = await serviceApp.fetch(
      new Request(`http://test/v1/tasks/${serviceTask.id}`, {
        method: "PATCH",
        headers: {
          ...updateHeaders,
          "Idempotency-Key": "service-update",
          "If-Match": '"1"',
        },
        body: JSON.stringify({ title: "Service renamed" }),
      }),
    );
    assertEquals(serviceUpdated.status, 200);
    assertEquals((await serviceUpdated.json()).version, 2);
    const serviceUpdateReplay = await serviceApp.fetch(
      new Request(`http://test/v1/tasks/${serviceTask.id}`, {
        method: "PATCH",
        headers: {
          ...updateHeaders,
          "Idempotency-Key": "service-update",
          "If-Match": '"1"',
        },
        body: JSON.stringify({ title: "Service renamed" }),
      }),
    );
    assertEquals(serviceUpdateReplay.status, 200);
    assertEquals(
      serviceUpdateReplay.headers.get("idempotent-replayed"),
      "true",
    );
    assertEquals((await serviceUpdateReplay.json()).version, 2);

    const negativeGrantRequests = [
      [wrongGrantPrincipalId, "wrong-operation", 403, "AUTH_FORBIDDEN"],
      [expiredGrantPrincipalId, "expired", 404, "RESOURCE_NOT_FOUND"],
      [revokedGrantPrincipalId, "revoked", 404, "RESOURCE_NOT_FOUND"],
      [
        foreignGrantPrincipalId,
        "foreign-organization",
        404,
        "RESOURCE_NOT_FOUND",
      ],
    ] as const;
    for (
      const [negativePrincipalId, key, status, code] of negativeGrantRequests
    ) {
      const negativeApp = createApiRouter({
        registry,
        createContext: () => ({
          principal: {
            principalId: negativePrincipalId,
            principalType: "service" as const,
            displayName: "Negative Grant Service",
          },
        }),
      });
      const response = await negativeApp.fetch(
        new Request("http://test/v1/tasks", {
          method: "POST",
          headers: { ...baseHeaders, "Idempotency-Key": `negative-${key}` },
          body: createBody,
        }),
      );
      assertEquals(response.status, status);
      assertEquals((await response.json()).code, code);
    }

    const crossTenant = await app.fetch(
      new Request(`http://test/v1/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "Bakery-Organization-Id": otherOrganizationId,
          "Idempotency-Key": "cross-tenant-1",
          "If-Match": '"1"',
        },
        body: JSON.stringify({ title: "Hijack" }),
      }),
    );
    assertEquals(crossTenant.status, 404);
    assertEquals((await crossTenant.json()).code, "RESOURCE_NOT_FOUND");

    await owner`
      update bakery.principals set disabled_at = now()
      where id = ${principalId}`;
    const revoked = await app.fetch(
      new Request("http://test/v1/tasks", {
        method: "POST",
        headers: baseHeaders,
        body: createBody,
      }),
    );
    assertEquals(revoked.status, 403);
    const revokedBody = await revoked.json();
    assertEquals(revokedBody.code, "AUTH_FORBIDDEN");
    assertEquals(revokedBody.detail !== task.id, true);
    const completed = await owner`
      select status, response_body from bakery.idempotency_records
      where organization_id = ${organizationId}
        and operation = 'tasks.create' and key = ${rollbackKey}`;
    assertEquals(completed.length, 1);
    assertEquals(completed[0].status, "completed");
    assertEquals(JSON.parse(completed[0].response_body).id, expiredTask.id);
  } finally {
    await closePgDatabase(admin);
    await closePgDatabase(appPg);

    await closePgDatabase(authDb);
    await closeDatabase(owner);
  }
});
Deno.test(
  "invitation command preserves organization-first lock ordering",
  async () => {
    const resetOwner = openDatabase(databaseUrl);
    try {
      await resetTestDatabase(resetOwner, {
        targetUrl: databaseUrl,
        ...readTestDatabaseResetOptions(),
      });
    } finally {
      await closeDatabase(resetOwner);
    }

    const fixture = await openAuthFixture();
    const providerUserId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const adminPool = openPgDatabase(adminDatabaseUrl, 1);
    const admin = await adminPool.connect();
    const invitationId = `aaaaaaaa-aaaa-4aaa-8aaa-${
      crypto.randomUUID().slice(-12)
    }`;
    const sessionToken = `issue36-invitation-session-${crypto.randomUUID()}`;
    const email = `concurrent-${providerUserId}@example.test`;
    let competitor: (PgTransactionClient & { release(): void }) | undefined;
    let competitorTransactionOpen = false;
    let routePromise: Promise<Response> | undefined;
    try {
      const now = new Date();
      await fixture.pgDatabase.query(
        `insert into public."user" (
           id, name, email, "emailVerified", "createdAt", "updatedAt"
         ) values ($1, $2, $3, true, $4, $4)`,
        [providerUserId, "Concurrent Auth Tester", email, now],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.principals (
           id, provider_user_id, display_name, principal_type
         ) values ($1, $2, $3, 'human')`,
        [principalId, providerUserId, "Concurrent Auth Tester"],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.organizations (
           id, name, slug, metadata, created_at, updated_at, version
         ) values ($1, $2, $3, '{}'::jsonb, $4, $4, 1)`,
        [
          organizationId,
          "Concurrent Invitation Organization",
          `concurrent-${organizationId}`,
          now,
        ],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.organization_invitations (
           id, organization_id, email, role, status, expires_at,
           inviter_principal_id, inviter_membership_id,
           created_at, updated_at, version
         ) values ($1, $2, $3, 'developer', 'pending', $4, null, null, $5, $5, 1)`,
        [
          invitationId,
          organizationId,
          email,
          new Date(now.getTime() + 3_600_000),
          now,
        ],
      );
      await fixture.pgDatabase.query(
        `insert into public.session (
           id, token, "userId", "expiresAt", "createdAt", "updatedAt"
         ) values ($1, $2, $3, $4, $5, $5)`,
        [
          crypto.randomUUID(),
          sessionToken,
          providerUserId,
          new Date(now.getTime() + 3_600_000),
          now,
        ],
      );
      const cookie = await signSessionCookie(
        sessionToken,
        fixture.config.auth!.secret,
      );
      const routes = createAuthV1Routes({
        auth: fixture.auth,
        database: fixture.runtimePgDatabase,
        store: createPostgresAuthPersistence(fixture.runtimePgDatabase),
        publicBaseUrl: authTestOrigin,
        trustedOrigins: [authTestOrigin],
        secret: fixture.config.auth!.secret,
      });

      competitor = await fixture.runtimePgDatabase.connect();
      const competitorBackend = await competitor.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const competitorPid = competitorBackend.rows[0]?.pid;
      if (typeof competitorPid !== "number") {
        throw new Error("COMPETITOR_BACKEND_PID_MISSING");
      }
      await competitor.query("begin");
      competitorTransactionOpen = true;
      await competitor.query(
        "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [`bakery:organization:${organizationId}`],
      );

      const requestPromise = Promise.resolve(
        routes.fetch(
          new Request(
            `${authTestOrigin}/api/auth/organization/accept-invitation`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                cookie,
                origin: authTestOrigin,
              },
              body: JSON.stringify({ invitationId }),
            },
          ),
        ),
      );
      routePromise = requestPromise;
      const waiterDeadline = performance.now() + 10_000;
      let routeWaitingOnOrganizationLock = false;
      while (performance.now() < waiterDeadline) {
        const waiter = await admin.query(
          `select pid
             from pg_stat_activity
            where datname = current_database()
              and wait_event_type = 'Lock'
              and $1 = any(pg_blocking_pids(pid))
            limit 1`,
          [competitorPid],
        );
        if (waiter.rows.length === 1) {
          routeWaitingOnOrganizationLock = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      if (!routeWaitingOnOrganizationLock) {
        const activity = await admin.query(
          `select pid, usename, state, wait_event_type, wait_event, query
             from pg_stat_activity
            where datname = current_database()
              and state <> 'idle'
            order by pid`,
        );
        const routeState = await Promise.race([
          requestPromise.then(async (response) =>
            `status=${response.status};body=${await response.text()}`
          ),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("pending"), 100)
          ),
        ]);
        throw new Error(
          `ORGANIZATION_LOCK_WAITER_NOT_OBSERVED:${routeState};` +
            JSON.stringify(activity.rows),
        );
      }
      try {
        await competitor.query("set local lock_timeout = '5s'");
        await competitor.query(
          `select id
             from bakery.principals
            where id = $1
            for update`,
          [principalId],
        );
      } catch (error) {
        throw new Error(
          "PRINCIPAL_LOCK_ACQUISITION_FAILED_AFTER_ORGANIZATION_LOCK",
          { cause: error },
        );
      }
      await competitor.query("commit");
      competitorTransactionOpen = false;
      const accepted = await requestPromise;
      assertEquals(accepted.status, 200, await accepted.clone().text());
      const acceptedBody = await accepted.json() as {
        invitation: { status: string };
      };
      assertEquals(acceptedBody.invitation.status, "accepted");
      const replayed = await routes.fetch(
        new Request(
          `${authTestOrigin}/api/auth/organization/accept-invitation`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie,
              origin: authTestOrigin,
            },
            body: JSON.stringify({
              invitationId: invitationId.toUpperCase(),
            }),
          },
        ),
      );
      assertEquals(replayed.status, 200, await replayed.clone().text());
      assertEquals(replayed.headers.get("Idempotent-Replayed"), "true");
      assertEquals(await replayed.json(), acceptedBody);
      const persisted = await fixture.pgDatabase.query(
        `select status
           from bakery.organization_invitations
          where id = $1`,
        [invitationId],
      );
      assertEquals(persisted.rows, [{ status: "accepted" }]);
    } finally {
      if (competitor) {
        if (competitorTransactionOpen) {
          await competitor.query("rollback").catch(() => undefined);
        }
        competitor.release();
      }
      if (routePromise) await routePromise.catch(() => undefined);
      await fixture.pgDatabase.query(
        `delete from bakery.organization_invitations where organization_id = $1`,
        [organizationId],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.idempotency_records where principal_id = $1`,
        [principalId],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id = $1`,
        [organizationId],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.principals where id = $1`,
        [principalId],
      );
      await fixture.pgDatabase.query(
        `delete from public.session where token = $1`,
        [sessionToken],
      );
      await fixture.pgDatabase.query(
        `delete from public."user" where id = $1`,
        [providerUserId],
      );
      admin.release();
      await closePgDatabase(adminPool);
      await fixture.close();
    }
  },
);
