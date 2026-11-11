import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assert, assertEquals } from "@std/assert";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
} from "../../apps/server/src/platform/migrate.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
} from "../../apps/server/src/modules/auth/migrations.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import { createPostgresCommandRunner } from "../../apps/server/src/platform/command-replay.ts";
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
type ArchiveClient = {
  query: (queryText: string, values?: unknown[]) => Promise<unknown>;
  release: (error?: Error) => void;
};
const { databaseUrl, appDatabaseUrl, adminDatabaseUrl } =
  readTestDatabaseConfig(
    Deno.env.toObject(),
    { requireAdmin: true },
  );

async function digest(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

type LockWaitRow = {
  admissionPid: number;
  blockingPids: readonly number[];
  query: string;
  waitEventType: string | null;
  waitEvent: string | null;
  state: string | null;
};

async function waitForRepositoryShareWaiter(
  database: PgDatabase,
  admissionPid: number,
  applicationName: string,
  archivePid: number,
): Promise<LockWaitRow> {
  const waiterQuery = `
    select a.pid as "admissionPid",
           pg_blocking_pids(a.pid) as "blockingPids",
           left(a.query, 240) as query,
           a.wait_event_type as "waitEventType",
           a.wait_event as "waitEvent",
           a.state
      from pg_stat_activity a
     where a.datname = current_database()
       and a.pid = $1
       and a.application_name = $2
       and a.backend_type = 'client backend'
       and a.wait_event_type = 'Lock'
       and $3 = any(pg_blocking_pids(a.pid))
     limit 1
  `;
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const waiting = await database.query<LockWaitRow>(
      waiterQuery,
      [admissionPid, applicationName, archivePid],
    );
    const observed = waiting.rows[0];
    if (observed !== undefined) return observed;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(50, remaining))
    );
  }
  const diagnostics = await database.query<LockWaitRow>(
    `select a.pid as "admissionPid",
            pg_blocking_pids(a.pid) as "blockingPids",
            left(a.query, 240) as query,
            a.wait_event_type as "waitEventType",
            a.wait_event as "waitEvent",
            a.state
       from pg_stat_activity a
      where a.datname = current_database()
        and a.pid = $1
        and a.application_name = $2
        and a.backend_type = 'client backend'
      order by a.pid
      limit 3`,
    [admissionPid, applicationName],
  );
  throw new Error(
    `REPOSITORY_SHARE_LOCK_WAITER_NOT_OBSERVED:database=current_database;` +
      `application=${applicationName};archivePid=${archivePid};` +
      `diagnostics=${JSON.stringify(diagnostics.rows)}`,
  );
}

async function drainAdmission(
  admission: Response | Promise<Response>,
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 5_000);
  await Promise.race([
    Promise.resolve(admission).then(() => undefined, () => undefined),
    promise,
  ]);
}

Deno.test("repository archive serializes against run admission", async () => {
  const owner = openDatabase(databaseUrl);
  const ownerPg = openPgDatabase(databaseUrl, 4);
  const adminPg = openPgDatabase(adminDatabaseUrl, 1);
  const admissionApplicationName =
    `issue36-archive-race-${crypto.randomUUID()}`;
  const admissionDatabaseUrl = new URL(appDatabaseUrl);
  admissionDatabaseUrl.searchParams.set(
    "application_name",
    admissionApplicationName,
  );
  const appPg = openPgDatabase(admissionDatabaseUrl.toString(), 1);
  const now = new Date("2026-09-20T00:00:00.000Z");
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const email = `issue36-archive-race-${crypto.randomUUID()}@example.test`;
  const workflowSpec = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "issue-36-archive-race",
    steps: [{ id: "review", uses: "review.independent" }],
  };
  const profileConfig = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  const profileDigest = await digest(profileConfig);
  const workflowDigest = await digest(workflowSpec);
  let archiveClient: ArchiveClient | undefined;
  let archiveTransactionOpen = false;
  let cleanupError: unknown;
  try {
    await migrateProvider(
      ownerPg,
      await loadMigrations(betterAuthMigrationSource),
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

    await owner`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${userId}, 'Issue 36 Archive Race', ${email}, true, ${now}, ${now}
      )`;
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${principalId}, ${userId}, 'Issue 36 Archive Race', 'human')`;
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationId}, 'Issue 36 Archive Race', ${`issue-36-${organizationId}`},
        '{}'::jsonb, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${organizationId}, ${principalId}, 'developer',
        'active', ${now}, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${applicationId}, ${organizationId}, ${`issue-36-${applicationId}`},
        'Issue 36 Archive Race', ''
      )`;
    await owner`
      insert into bakery.repositories (
        id, organization_id, application_id, integration_connection_id,
        provider_repo_id, owner, name, default_branch, version
      ) values (
        ${repositoryId}, ${organizationId}, ${applicationId},
        ${crypto.randomUUID()}, 'owner/issue-36', 'bakery-owner',
        'issue-36', 'main', 1
      )`;
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, repository_id, revision, config, digest,
        created_by, version
      ) values (
        ${profileId}, ${organizationId}, ${repositoryId}, 1,
        ${owner.json(profileConfig)}, ${profileDigest}, ${principalId}, 1
      )`;
    await owner`
      update bakery.repositories
         set active_profile_id = ${profileId}, version = 2
       where organization_id = ${organizationId} and id = ${repositoryId}`;
    await owner`
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name, enabled, version
      ) values (
        ${workflowId}, ${organizationId}, 'issue-36-archive-race',
        'Issue 36 Archive Race', true, 1
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${workflowVersionId}, ${organizationId}, ${workflowId}, 1, '',
        ${owner.json(workflowSpec)}, ${workflowDigest}, 'published',
        ${principalId}, 1
      )`;
    await owner`
      update bakery.workflow_definitions
         set active_version_id = ${workflowVersionId}, updated_at = ${now}
       where organization_id = ${organizationId} and id = ${workflowId}`;
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, repository_id, title,
        created_by, created_at, updated_at, version
      ) values (
        ${conversationId}, ${organizationId}, ${applicationId}, ${repositoryId},
        'Issue 36 Archive Race', ${principalId}, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, repository_id, conversation_id,
        title, description, task_type, status, priority, created_by,
        repository_profile_id, repository_profile_revision,
        repository_profile_digest, created_at, updated_at, version
      ) values (
        ${taskId}, ${organizationId}, ${applicationId}, ${repositoryId},
        ${conversationId}, 'Issue 36 Archive Race', '', 'feature', 'draft',
        50, ${principalId}, ${profileId}, 1, ${profileDigest}, ${now}, ${now}, 1
      )`;

    const authorityRunner = new PostgresAuthorityRunner(appPg);
    const registry = createTaskActionRegistry(
      createWorkTaskHandlers("issue36-archive-race-secret"),
      { authorityRunner, commandRunner: createPostgresCommandRunner() },
    );
    const app = createApiRouter({
      registry,
      createContext: () => ({
        principal: {
          principalId,
          principalType: "human" as const,
          displayName: "Issue 36 Archive Race",
        },
      }),
    });
    const admit = () =>
      app.fetch(
        new Request(
          `http://test/v1/tasks/${taskId}/runs`,
          {
            method: "POST",
            headers: {
              "Bakery-Organization-Id": organizationId,
              "content-type": "application/json",
              "Idempotency-Key": "issue36-archive-race",
            },
            body: JSON.stringify({
              workflowVersionId,
              repositoryProfileId: profileId,
              executionMode: "repository",
              budgetLimitUsd: "0.005000",
              inputs: { taskId },
            }),
          },
        ),
      );
    const admissionPidResult = await appPg.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    const admissionPid = admissionPidResult.rows[0]?.pid;
    if (typeof admissionPid !== "number" || !Number.isInteger(admissionPid)) {
      throw new Error("ADMISSION_BACKEND_PID_NOT_OBSERVED");
    }

    const client = await ownerPg.connect();
    archiveClient = client;
    const archivePidResult = await client.query(
      "select pg_backend_pid() as pid",
    );
    const archivePid = (archivePidResult as {
      rows: Array<{ pid: number }>;
    }).rows[0]?.pid;
    if (typeof archivePid !== "number" || !Number.isInteger(archivePid)) {
      throw new Error("ARCHIVE_BACKEND_PID_NOT_OBSERVED");
    }
    await client.query("begin");
    archiveTransactionOpen = true;
    await client.query(
      `update bakery.repositories
          set archived_at = $3, updated_at = $3, version = version + 1
        where organization_id = $1 and id = $2`,
      [organizationId, repositoryId, now],
    );
    const admission = admit();
    try {
      await waitForRepositoryShareWaiter(
        adminPg,
        admissionPid,
        admissionApplicationName,
        archivePid,
      );
    } catch (error) {
      if (archiveTransactionOpen) {
        try {
          await client.query("rollback");
          archiveTransactionOpen = false;
        } catch (rollbackError) {
          archiveTransactionOpen = false;
          try {
            client.release(
              rollbackError instanceof Error
                ? rollbackError
                : new Error(String(rollbackError)),
            );
            archiveClient = undefined;
          } catch (releaseError) {
            cleanupError ??= releaseError;
          }
        }
      }
      await drainAdmission(admission);
      throw error;
    }
    await client.query("commit");
    archiveTransactionOpen = false;
    const response = await admission;
    assertEquals(response.status, 409);
    assertEquals(
      (await response.json() as { code: string }).code,
      "STATE_CONFLICT",
    );

    const durableRows = await owner`
      select
        (select count(*)::int from bakery.workflow_runs
          where organization_id = ${organizationId} and task_id = ${taskId}) as run_count,
        (select count(*)::int from bakery.domain_events
          where organization_id = ${organizationId} and task_id = ${taskId}) as event_count,
        (select count(*)::int from bakery.outbox o
          join bakery.domain_events e on e.id = o.event_id
          where e.organization_id = ${organizationId} and e.task_id = ${taskId}) as outbox_count`;
    assertEquals(durableRows[0], {
      run_count: 0,
      event_count: 0,
      outbox_count: 0,
    });
    const archived = await owner`
      select archived_at from bakery.repositories
       where organization_id = ${organizationId} and id = ${repositoryId}`;
    assertEquals(archived.length, 1);
    assert(archived[0].archived_at !== null);
  } finally {
    if (archiveClient) {
      try {
        if (archiveTransactionOpen) {
          await archiveClient.query("rollback");
          archiveTransactionOpen = false;
        }
      } catch (error) {
        cleanupError = error;
      } finally {
        archiveClient.release();
      }
    }
    try {
      await owner`
        delete from bakery.installation_administrators
         where principal_id = ${principalId}
            or granted_by_principal_id = ${principalId}`;
      await owner`
        delete from bakery.permission_grants
         where principal_id = ${principalId}
            or granted_by_principal_id = ${principalId}`;
      await owner`
        delete from bakery.outbox o
         using bakery.domain_events e
         where o.event_id = e.id and e.organization_id = ${organizationId}`;
      await owner`
        delete from bakery.domain_events
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.audit_events
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.idempotency_records
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.task_dependencies
         where organization_id = ${organizationId}`;
      await owner`
        update bakery.repositories
           set active_profile_id = null
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.run_steps
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.workflow_runs
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.tasks
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.conversations
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.repository_profiles
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.workflow_versions
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.workflow_definitions
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.repositories
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.applications
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.organization_memberships
         where organization_id = ${organizationId}`;
      await owner`
        delete from bakery.organizations
         where id = ${organizationId}`;
      await owner`
        delete from bakery.principals
         where id = ${principalId}`;
      await owner`
        delete from public."user"
         where id = ${userId}`;
    } catch (error) {
      cleanupError ??= error;
    } finally {
      await closePgDatabase(adminPg);
      await closePgDatabase(appPg);
      await closePgDatabase(ownerPg);
      await closeDatabase(owner);
    }
  }
  if (cleanupError) throw cleanupError;
});
