import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../../apps/server/src/app.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import { inngestEventDefinition } from "../../packages/contracts/src/events.ts";
import { createReadyAuthProvider } from "../../apps/server/src/modules/auth/index.ts";
import {
  readRuntimeConfig,
  readTestDatabaseConfig,
} from "../../packages/config/src/env.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
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
} from "../../apps/server/src/platform/migrate.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  preserveProviderInvitationState,
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
import { toEngineEvent } from "../../apps/server/src/platform/outbox-events.ts";
import { OutboxEventRecordSchema } from "../../apps/server/src/platform/outbox-types.ts";
import { signSessionCookie } from "../helpers/auth.ts";

const { databaseUrl, appDatabaseUrl } = readTestDatabaseConfig();
const now = new Date("2026-09-19T00:00:00.000Z");

type Principal = {
  principalId: string;
  principalType: "human";
  displayName: string;
};

type SendOptions = {
  organizationId: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
};

async function digest(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

const organizationId = crypto.randomUUID();
const hostileOrganizationId = crypto.randomUUID();
const userId = crypto.randomUUID();
const principalId = crypto.randomUUID();
Deno.test("admit tasks and keep fixed-workflow run snapshots immutable", async () => {
  const owner = openDatabase(databaseUrl);
  const authDb = openPgDatabase(databaseUrl);
  const appPg = openPgDatabase(appDatabaseUrl);
  const appDatabase = openDatabase(appDatabaseUrl);
  try {
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

    const applicationId = crypto.randomUUID();
    const repositoryId = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    const invalidProfileConfigId = crypto.randomUUID();
    const invalidProfileDigestId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const workflowVersionId = crypto.randomUUID();
    const oversizedWorkflowVersionId = crypto.randomUUID();
    const cloudOnlyWorkflowId = crypto.randomUUID();
    const cloudOnlyWorkflowVersionId = crypto.randomUUID();
    const repositoryDependentCloudOnlyWorkflowVersionId = crypto.randomUUID();
    const malformedRepeatCloudOnlyWorkflowVersionId = crypto.randomUUID();
    const unsupportedWorkflowVersionId = crypto.randomUUID();
    const planOnlyWorkflowVersionId = crypto.randomUUID();
    const disabledWorkflowId = crypto.randomUUID();
    const disabledWorkflowVersionId = crypto.randomUUID();
    const userEmail = `issue36-${userId}@example.test`;
    const principal: Principal = {
      principalId,
      principalType: "human",
      displayName: "Issue 36 Developer",
    };

    await owner`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${userId}, 'Issue 36 Developer', ${userEmail}, true, ${now}, ${now}
      )`;
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${principalId}, ${userId}, ${principal.displayName}, 'human')`;
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationId}, 'Issue 36 Org', ${`issue-36-${organizationId}`},
        '{}'::jsonb, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${hostileOrganizationId}, 'Issue 36 Hostile Org',
        ${`issue-36-hostile-${hostileOrganizationId}`},
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
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${hostileOrganizationId}, ${principalId},
        'developer', 'active', ${now}, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${applicationId}, ${organizationId}, ${`issue-36-${applicationId}`},
        'Issue 36 App', ''
      )`;

    const profileConfig = {
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      branches: { base: "main", allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
    };
    const profileDigest = await digest(profileConfig);
    const invalidProfileSourceDigest = "0".repeat(64);
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
        ${owner.json(profileConfig)}, ${profileDigest},
        ${principalId}, 1
      )`;
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, repository_id, revision, config, digest,
        created_by, version
      ) values (
        ${invalidProfileConfigId}, ${organizationId}, ${repositoryId}, 2,
        ${owner.json({})}, ${invalidProfileSourceDigest}, ${principalId}, 1
      )`;
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, repository_id, revision, config, digest,
        created_by, version
      ) values (
        ${invalidProfileDigestId}, ${organizationId}, ${repositoryId}, 3,
        ${owner.json(profileConfig)}, ${invalidProfileSourceDigest},
        ${principalId}, 1
      )`;
    await owner`
      update bakery.repositories
         set active_profile_id = ${profileId}, version = 2
       where organization_id = ${organizationId} and id = ${repositoryId}`;
    const workflowSpec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "issue-36-fixed",
      steps: [
        {
          id: "review",
          uses: "mcp.discover",
          with: { connectionId: crypto.randomUUID() },
        },
        {
          id: "research",
          uses: "mcp.discover",
          with: { connectionId: crypto.randomUUID() },
        },
      ],
    };
    const workflowDigest = await digest(workflowSpec);
    const cloudOnlyWorkflowSpec = {
      ...workflowSpec,
      name: "issue-36-cloud-only-workflow",
    };
    const repositoryDependentCloudOnlyWorkflowSpec = {
      ...cloudOnlyWorkflowSpec,
      name: "issue-36-repository-dependent-cloud-only-workflow",
      steps: [{
        id: "parallel",
        parallel: {
          branches: [
            {
              repositoryId: "$input.repositoryId",
              steps: [{
                id: "maintenance",
                uses: "declarative.maintenance",
                requires: ["git"],
              }],
            },
            {
              steps: [{ id: "cloud_check", uses: "review.independent" }],
            },
          ],
        },
      }],
    };
    const cloudOnlyWorkflowDigest = await digest(cloudOnlyWorkflowSpec);
    const repositoryDependentCloudOnlyWorkflowDigest = await digest(
      repositoryDependentCloudOnlyWorkflowSpec,
    );
    const malformedRepeatCloudOnlyWorkflowSpec = {
      ...cloudOnlyWorkflowSpec,
      name: "issue-36-malformed-repeat-cloud-only-workflow",
      steps: [{
        id: "repeat",
        repeat: {
          seed: null,
          steps: [],
        },
      }],
    };
    const malformedRepeatCloudOnlyWorkflowDigest = await digest(
      malformedRepeatCloudOnlyWorkflowSpec,
    );
    const unsupportedWorkflowSpec = {
      ...workflowSpec,
      name: "issue-36-dynamic-workflow",
      workflow: { kind: "dynamic" },
    };
    const unsupportedWorkflowDigest = await digest(unsupportedWorkflowSpec);
    // A compiler-grammar version with a container node: it validates and
    // publishes, but the fixed executor cannot run it until plans execute.
    const planOnlyWorkflowSpec = {
      ...workflowSpec,
      name: "issue-16-plan-only-workflow",
      steps: [{
        id: "choose",
        branch: {
          when: '$input.target == "main"',
          then: [{ id: "on_main", uses: "workflow.noop", with: {} }],
          else: [{ id: "on_other", uses: "workflow.noop", with: {} }],
        },
      }],
    };
    const planOnlyWorkflowDigest = await digest(planOnlyWorkflowSpec);
    const oversizedWorkflowSpec = {
      ...workflowSpec,
      padding: "x".repeat(100_000),
    };
    const oversizedWorkflowDigest = await digest(oversizedWorkflowSpec);
    await owner`
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name, enabled, version
      ) values (
        ${workflowId}, ${organizationId}, 'issue-36-fixed',
        'Issue 36 Fixed', true, 1
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${workflowVersionId}, ${organizationId}, ${workflowId}, 1, '',
        ${owner.json(workflowSpec)}, ${workflowDigest},
        'published', ${principalId}, 1
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${oversizedWorkflowVersionId}, ${organizationId}, ${workflowId}, 2, '',
        ${owner.json(oversizedWorkflowSpec)}, ${oversizedWorkflowDigest},
        'published', ${principalId}, 1
      )`;
    await owner`
      update bakery.workflow_definitions
         set active_version_id = ${workflowVersionId}, updated_at = ${now}
       where organization_id = ${organizationId} and id = ${workflowId}`;
    await owner`
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name, enabled, version
      ) values (
        ${cloudOnlyWorkflowId}, ${organizationId}, 'issue-36-cloud-only-fixed',
        'Issue 36 Cloud-only Fixed', true, 1
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${cloudOnlyWorkflowVersionId}, ${organizationId},
        ${cloudOnlyWorkflowId}, 1, '',
        ${owner.json(cloudOnlyWorkflowSpec)}, ${cloudOnlyWorkflowDigest},
        'published', ${principalId}, 1
      )`;
    await owner`
      update bakery.workflow_definitions
         set active_version_id = ${cloudOnlyWorkflowVersionId},
             updated_at = ${now}
       where organization_id = ${organizationId}
         and id = ${cloudOnlyWorkflowId}`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${repositoryDependentCloudOnlyWorkflowVersionId}, ${organizationId},
        ${cloudOnlyWorkflowId}, 2, '',
        ${owner.json(repositoryDependentCloudOnlyWorkflowSpec)},
        ${repositoryDependentCloudOnlyWorkflowDigest}, 'published',
        ${principalId}, 1
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${malformedRepeatCloudOnlyWorkflowVersionId}, ${organizationId},
        ${cloudOnlyWorkflowId}, 3, '',
        ${owner.json(malformedRepeatCloudOnlyWorkflowSpec)},
        ${malformedRepeatCloudOnlyWorkflowDigest}, 'published',
        ${principalId}, 1
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${unsupportedWorkflowVersionId}, ${organizationId},
        ${cloudOnlyWorkflowId}, 4, '',
        ${owner.json(unsupportedWorkflowSpec)},
        ${unsupportedWorkflowDigest}, 'published', ${principalId}, 1
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${planOnlyWorkflowVersionId}, ${organizationId},
        ${cloudOnlyWorkflowId}, 5, '',
        ${owner.json(planOnlyWorkflowSpec)},
        ${planOnlyWorkflowDigest}, 'published', ${principalId}, 1
      )`;
    await owner`
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name, enabled, version
      ) values (
        ${disabledWorkflowId}, ${organizationId}, 'issue-36-disabled',
        'Issue 36 Disabled', false, 1
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${disabledWorkflowVersionId}, ${organizationId}, ${disabledWorkflowId},
        1, '', ${owner.json(workflowSpec)}, ${workflowDigest},
        'published', ${principalId}, 1
      )`;
    await owner`
      update bakery.workflow_definitions
         set active_version_id = ${disabledWorkflowVersionId}, updated_at = ${now}
       where organization_id = ${organizationId} and id = ${disabledWorkflowId}`;

    const taskIds = {
      ready: crypto.randomUUID(),
      blocked: crypto.randomUUID(),
      prerequisite: crypto.randomUUID(),
      noRepository: crypto.randomUUID(),
      cloudOnlyMaintenance: crypto.randomUUID(),
      cloudOnlyProfile: crypto.randomUUID(),
      disabledWorkflow: crypto.randomUUID(),
      unsupportedWorkflow: crypto.randomUUID(),
      planOnlyWorkflow: crypto.randomUUID(),
      cycleA: crypto.randomUUID(),
      cycleB: crypto.randomUUID(),
      cycleC: crypto.randomUUID(),
      archivedPrerequisite: crypto.randomUUID(),
      invalidProfileConfig: crypto.randomUUID(),
      invalidProfileDigest: crypto.randomUUID(),
      oversized: crypto.randomUUID(),
      tenantIsolation: crypto.randomUUID(),
    };
    const insertTask = async (
      id: string,
      title: string,
      repository = true,
      taskType = "feature",
      profileBinding: {
        id: string;
        revision: number;
        digest: string;
      } | null = repository
        ? { id: profileId, revision: 1, digest: profileDigest }
        : null,
    ) => {
      const conversationId = crypto.randomUUID();
      await owner`
        insert into bakery.conversations (
          id, organization_id, application_id, repository_id, title,
          created_by, created_at, updated_at, version
        ) values (
          ${conversationId}, ${organizationId}, ${applicationId},
          ${repository ? repositoryId : null}, ${title}, ${principalId},
          ${now}, ${now}, 1
        )`;
      await owner`
        insert into bakery.tasks (
          id, organization_id, application_id, repository_id, conversation_id,
          title, description, task_type, status, priority, created_by,
          repository_profile_id, repository_profile_revision,
          repository_profile_digest, created_at, updated_at, version
        ) values (
          ${id}, ${organizationId}, ${applicationId},
          ${repository ? repositoryId : null}, ${conversationId}, ${title}, '',
          ${taskType}, 'draft', 50, ${principalId},
          ${profileBinding?.id ?? null}, ${profileBinding?.revision ?? null},
          ${profileBinding?.digest ?? null}, ${now}, ${now}, 1
        )`;
    };
    await insertTask(taskIds.ready, "Ready task");
    await insertTask(taskIds.blocked, "Blocked task");
    await insertTask(taskIds.prerequisite, "Prerequisite task");
    await insertTask(taskIds.noRepository, "No repository task", false);
    await insertTask(
      taskIds.cloudOnlyMaintenance,
      "Cloud-only maintenance task",
      false,
      "maintenance",
    );
    await insertTask(
      taskIds.cloudOnlyProfile,
      "Cloud-only profile rejection task",
      false,
      "maintenance",
    );
    await insertTask(
      taskIds.disabledWorkflow,
      "Disabled workflow task",
    );
    await insertTask(
      taskIds.unsupportedWorkflow,
      "Unsupported workflow task",
    );
    await insertTask(taskIds.planOnlyWorkflow, "Plan-only workflow task");
    await insertTask(taskIds.cycleA, "Cycle A");
    await insertTask(taskIds.cycleB, "Cycle B");
    await insertTask(taskIds.cycleC, "Cycle C");
    await insertTask(taskIds.archivedPrerequisite, "Archived prerequisite");
    await owner`
      insert into bakery.task_dependencies (
        organization_id, task_id, depends_on_task_id, condition, version
      ) values (${organizationId}, ${taskIds.archivedPrerequisite},
        ${taskIds.cycleA}, 'completed', 1)`;
    await owner`
      update bakery.tasks
         set archived_at = ${now}, updated_at = ${now}, version = version + 1
       where organization_id = ${organizationId}
         and id = ${taskIds.archivedPrerequisite}`;
    await insertTask(
      taskIds.invalidProfileConfig,
      "Invalid profile config task",
      true,
      "feature",
      {
        id: invalidProfileConfigId,
        revision: 2,
        digest: invalidProfileSourceDigest,
      },
    );
    await insertTask(
      taskIds.invalidProfileDigest,
      "Invalid profile digest task",
      true,
      "feature",
      {
        id: invalidProfileDigestId,
        revision: 3,
        digest: invalidProfileSourceDigest,
      },
    );
    await insertTask(taskIds.oversized, "Oversized workflow task");
    await insertTask(taskIds.tenantIsolation, "Tenant isolation task");
    await owner`
      update bakery.tasks set status = 'active'
       where organization_id = ${organizationId} and id = ${taskIds.prerequisite}`;
    await owner`
      insert into bakery.task_dependencies (
        organization_id, task_id, depends_on_task_id, condition, version
      ) values (${organizationId}, ${taskIds.blocked}, ${taskIds.prerequisite},
        'completed', 1)`;
    const compositionSecret = Deno.env.get("BETTER_AUTH_SECRET") ??
      "issue-36-production-composition-test-secret-value-32-bytes";
    const compositionConfig = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: appDatabaseUrl,
      BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8788",
      BETTER_AUTH_SECRET: compositionSecret,
    });
    const compositionPersistence = createPostgresAuthPersistence(appPg);
    const compositionAuth = await createReadyAuthProvider({
      pgDatabase: appPg,
      config: compositionConfig.auth!,
      persistence: compositionPersistence,
    });
    const productionApp = createApp({
      config: compositionConfig,
      database: appDatabase,
      pgDatabase: appPg,
      auth: compositionAuth,
      authPersistence: compositionPersistence,
      taskHandlers: createWorkTaskHandlers("issue36-run-secret"),
    });
    const sessionToken = `issue36-production-session-${crypto.randomUUID()}`;
    const sessionNow = new Date();
    await owner`
      insert into public.session (
        id, token, "userId", "expiresAt", "createdAt", "updatedAt"
      ) values (
        ${crypto.randomUUID()}, ${sessionToken}, ${userId},
        ${new Date(
      sessionNow.getTime() + 3_600_000,
    )}, ${sessionNow}, ${sessionNow}
      )`;
    const productionCookie = await signSessionCookie(
      sessionToken,
      compositionConfig.auth!.secret,
    );

    const authorityRunner = new PostgresAuthorityRunner(appPg);

    const registry = createTaskActionRegistry(
      createWorkTaskHandlers("issue-36-run-secret"),
      { authorityRunner, commandRunner: createPostgresCommandRunner() },
    );
    const app = createApiRouter({
      registry,
      createContext: () => ({ principal }),
    });
    const send = async (
      method: string,
      path: string,
      options: SendOptions,
    ): Promise<Response> => {
      const headers: Record<string, string> = {
        "Bakery-Organization-Id": options.organizationId,
      };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (options.idempotencyKey !== undefined) {
        headers["Idempotency-Key"] = options.idempotencyKey;
      }
      if (options.ifMatch !== undefined) {
        headers["If-Match"] = options.ifMatch;
      }
      return await app.fetch(
        new Request(`http://test${path}`, {
          method,
          headers,
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        }),
      );
    };
    const productionHeaders = {
      cookie: productionCookie,
      origin: compositionConfig.publicBaseUrl,
      "Bakery-Organization-Id": organizationId,
    };
    const sendProduction = async (
      method: string,
      path: string,
      options: SendOptions,
    ): Promise<Response> => {
      const headers = new Headers(productionHeaders);
      if (options.body !== undefined) {
        headers.set("content-type", "application/json");
      }
      if (options.idempotencyKey !== undefined) {
        headers.set("Idempotency-Key", options.idempotencyKey);
      }
      if (options.ifMatch !== undefined) {
        headers.set("If-Match", options.ifMatch);
      }
      return await productionApp.fetch(
        new Request(`http://test${path}`, {
          method,
          headers,
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        }),
      );
    };

    const runInput = {
      workflowVersionId,
      repositoryProfileId: profileId.toUpperCase(),
      executionMode: "repository",
      budgetLimitUsd: "0.005000",
      inputs: { taskId: taskIds.ready, target: "main" },
    };
    const cloudOnlyStart = await send(
      "POST",
      `/v1/tasks/${taskIds.cloudOnlyMaintenance}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-cloud-only-maintenance-run",
        body: {
          workflowVersionId: cloudOnlyWorkflowVersionId,
          executionMode: "cloud_only",
          budgetLimitUsd: "0.005000",
          inputs: { taskId: taskIds.cloudOnlyMaintenance },
        },
      },
    );
    assertEquals(cloudOnlyStart.status, 201);
    const cloudOnlyBody = await cloudOnlyStart.json() as {
      id: string;
      status: string;
      repositoryProfileId: string | null;
    };
    assertEquals(cloudOnlyBody.status, "queued");
    assertEquals(cloudOnlyBody.repositoryProfileId, null);
    const cloudOnlyPersistence = await owner`
      select r.repository_profile_id as "repositoryProfileId",
             r.snapshot->'repositoryProfile' as "repositoryProfile",
             e.event_type as "eventType",
             count(o.id)::int as "outboxCount"
        from bakery.workflow_runs r
        join bakery.domain_events e on e.aggregate_id = r.id
        left join bakery.outbox o on o.event_id = e.id
       where r.organization_id = ${organizationId}
         and r.id = ${cloudOnlyBody.id}
       group by r.repository_profile_id, r.snapshot, e.event_type`;
    assertEquals(cloudOnlyPersistence[0], {
      repositoryProfileId: null,
      repositoryProfile: null,
      eventType: "run.requested",
      outboxCount: 1,
    });
    const cloudOnlyIdentity = await owner`
      select application_id as "applicationId",
             repository_id as "repositoryId",
             repository_profile_id as "repositoryProfileId",
             repository_profile_revision as "repositoryProfileRevision",
             repository_profile_digest as "repositoryProfileDigest",
             observation_id as "observationId",
             observation_digest as "observationDigest",
             base_sha as "baseSha"
        from bakery.workflow_runs
       where organization_id = ${organizationId}
         and id = ${cloudOnlyBody.id}`;
    assertEquals(cloudOnlyIdentity[0], {
      applicationId: null,
      repositoryId: null,
      repositoryProfileId: null,
      repositoryProfileRevision: null,
      repositoryProfileDigest: null,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    });

    const cloudOnlyFeature = await send(
      "POST",
      `/v1/tasks/${taskIds.noRepository}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-cloud-only-feature-run",
        body: {
          workflowVersionId: cloudOnlyWorkflowVersionId,
          executionMode: "cloud_only",
          budgetLimitUsd: "0.005000",
          inputs: { taskId: taskIds.noRepository },
        },
      },
    );
    assertEquals(cloudOnlyFeature.status, 409);
    assertEquals((await cloudOnlyFeature.json()).code, "STATE_CONFLICT");
    const cloudOnlyWithProfile = await send(
      "POST",
      `/v1/tasks/${taskIds.cloudOnlyProfile}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-cloud-only-profile-run",
        body: {
          workflowVersionId: cloudOnlyWorkflowVersionId,
          repositoryProfileId: profileId,
          executionMode: "cloud_only",
          budgetLimitUsd: "0.005000",
          inputs: { taskId: taskIds.cloudOnlyProfile },
        },
      },
    );
    assertEquals(cloudOnlyWithProfile.status, 422);
    assertEquals((await cloudOnlyWithProfile.json()).code, "UNPROCESSABLE");
    const auditCountBeforeRepositoryDependentCloudOnly = await owner`
      select count(*)::int as count
        from bakery.audit_events
       where organization_id = ${organizationId}
         and operation = 'runs.create'`;
    const repositoryDependentCloudOnlyStart = await sendProduction(
      "POST",
      `/v1/tasks/${taskIds.cloudOnlyProfile}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-cloud-only-repository-required",
        body: {
          workflowVersionId: repositoryDependentCloudOnlyWorkflowVersionId,
          executionMode: "cloud_only",
          budgetLimitUsd: "0.005000",
          inputs: { taskId: taskIds.cloudOnlyProfile },
        },
      },
    );
    assertEquals(repositoryDependentCloudOnlyStart.status, 409);
    assertEquals(
      (await repositoryDependentCloudOnlyStart.json()).code,
      "STATE_CONFLICT",
    );
    const repositoryDependentCloudOnlyPersistence = await owner`
      select
        t.status as task_status,
        t.current_run_id as "currentRunId",
        (select count(*)::int from bakery.workflow_runs
          where organization_id = ${organizationId}
            and task_id = ${taskIds.cloudOnlyProfile}) as run_count,
        (select count(*)::int from bakery.run_steps s
          join bakery.workflow_runs r on r.id = s.run_id
         where r.organization_id = ${organizationId}
           and r.task_id = ${taskIds.cloudOnlyProfile}) as step_count,
        (select count(*)::int from bakery.domain_events
          where organization_id = ${organizationId}
            and task_id = ${taskIds.cloudOnlyProfile}) as event_count,
        (select count(*)::int from bakery.outbox o
          join bakery.domain_events e on e.id = o.event_id
         where e.organization_id = ${organizationId}
           and e.task_id = ${taskIds.cloudOnlyProfile}) as outbox_count,
        (select count(*)::int from bakery.audit_events
          where organization_id = ${organizationId}
            and operation = 'runs.create') as audit_count,
        (select count(*)::int from bakery.idempotency_records
          where organization_id = ${organizationId}
            and principal_id = ${principalId}
            and operation = 'runs.create'
            and key = 'issue36-cloud-only-repository-required') as receipt_count
        from bakery.tasks t
       where t.organization_id = ${organizationId}
         and t.id = ${taskIds.cloudOnlyProfile}`;
    assertEquals(repositoryDependentCloudOnlyPersistence[0], {
      task_status: "draft",
      currentRunId: null,
      run_count: 0,
      step_count: 0,
      event_count: 0,
      outbox_count: 0,
      audit_count: auditCountBeforeRepositoryDependentCloudOnly[0].count,
      receipt_count: 0,
    });
    const auditCountBeforeMalformedRepeatCloudOnly = await owner`
      select count(*)::int as count
        from bakery.audit_events
       where organization_id = ${organizationId}
         and operation = 'runs.create'`;
    const malformedRepeatCloudOnlyStart = await sendProduction(
      "POST",
      `/v1/tasks/${taskIds.cloudOnlyProfile}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-cloud-only-malformed-repeat",
        body: {
          workflowVersionId: malformedRepeatCloudOnlyWorkflowVersionId,
          executionMode: "cloud_only",
          budgetLimitUsd: "0.005000",
          inputs: { taskId: taskIds.cloudOnlyProfile },
        },
      },
    );
    assertEquals(malformedRepeatCloudOnlyStart.status, 500);
    const malformedRepeatCloudOnlyBody: unknown =
      await malformedRepeatCloudOnlyStart.json();
    assert(
      malformedRepeatCloudOnlyBody !== null &&
        typeof malformedRepeatCloudOnlyBody === "object" &&
        "code" in malformedRepeatCloudOnlyBody,
    );
    assertEquals(malformedRepeatCloudOnlyBody.code, "INTERNAL");
    const malformedRepeatCloudOnlyPersistence = await owner`
      select
        t.status as task_status,
        t.current_run_id as "currentRunId",
        (select count(*)::int from bakery.workflow_runs
          where organization_id = ${organizationId}
            and task_id = ${taskIds.cloudOnlyProfile}) as run_count,
        (select count(*)::int from bakery.run_steps s
          join bakery.workflow_runs r on r.id = s.run_id
         where r.organization_id = ${organizationId}
           and r.task_id = ${taskIds.cloudOnlyProfile}) as step_count,
        (select count(*)::int from bakery.domain_events
          where organization_id = ${organizationId}
            and task_id = ${taskIds.cloudOnlyProfile}) as event_count,
        (select count(*)::int from bakery.outbox o
          join bakery.domain_events e on e.id = o.event_id
         where e.organization_id = ${organizationId}
           and e.task_id = ${taskIds.cloudOnlyProfile}) as outbox_count,
        (select count(*)::int from bakery.audit_events
          where organization_id = ${organizationId}
            and operation = 'runs.create') as audit_count,
        (select count(*)::int from bakery.idempotency_records
          where organization_id = ${organizationId}
            and principal_id = ${principalId}
            and operation = 'runs.create'
            and key = 'issue36-cloud-only-malformed-repeat') as receipt_count
        from bakery.tasks t
       where t.organization_id = ${organizationId}
         and t.id = ${taskIds.cloudOnlyProfile}`;
    assertEquals(malformedRepeatCloudOnlyPersistence[0], {
      task_status: "draft",
      currentRunId: null,
      run_count: 0,
      step_count: 0,
      event_count: 0,
      outbox_count: 0,
      audit_count: auditCountBeforeMalformedRepeatCloudOnly[0].count,
      receipt_count: 0,
    });
    await send(
      "POST",
      `/v1/tasks/${taskIds.invalidProfileConfig}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-invalid-profile-config",
        body: {
          ...runInput,
          repositoryProfileId: invalidProfileConfigId,
          inputs: { taskId: taskIds.invalidProfileConfig, target: "main" },
        },
      },
    );

    await send(
      "POST",
      `/v1/tasks/${taskIds.invalidProfileDigest}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-invalid-profile-digest",
        body: {
          ...runInput,
          repositoryProfileId: invalidProfileDigestId,
          inputs: { taskId: taskIds.invalidProfileDigest, target: "main" },
        },
      },
    );
    const invalidProfileTasks = await owner`
      select id, status, current_run_id
        from bakery.tasks
       where organization_id = ${organizationId}
         and id in (
           ${taskIds.invalidProfileConfig},
           ${taskIds.invalidProfileDigest}
         )
       order by id`;
    assertEquals(invalidProfileTasks.length, 2);
    for (const task of invalidProfileTasks) {
      assertEquals(task.status, "draft");
      assertEquals(task.current_run_id, null);
    }
    const invalidProfilePersistence = await owner`
      select
        (select count(*)::int from bakery.workflow_runs
          where organization_id = ${organizationId}
            and task_id in (
              ${taskIds.invalidProfileConfig},
              ${taskIds.invalidProfileDigest}
            )) as run_count,
        (select count(*)::int from bakery.idempotency_records
          where organization_id = ${organizationId}
            and principal_id = ${principalId}
            and operation = 'runs.create'
            and key in (
              'issue36-invalid-profile-config',
              'issue36-invalid-profile-digest'
            )) as receipt_count`;
    assertEquals(invalidProfilePersistence[0], {
      run_count: 0,
      receipt_count: 0,
    });
    const oversizedStart = await send(
      "POST",
      `/v1/tasks/${taskIds.oversized}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-oversized-workflow-run",
        body: {
          ...runInput,
          workflowVersionId: oversizedWorkflowVersionId,
          inputs: { taskId: taskIds.oversized, target: "main" },
        },
      },
    );
    assertEquals(oversizedStart.status, 500);
    const oversizedBody: unknown = await oversizedStart.json();
    assert(
      oversizedBody !== null &&
        typeof oversizedBody === "object" &&
        "code" in oversizedBody,
    );
    assertEquals(oversizedBody.code, "INTERNAL");
    const oversizedRows = await owner`
      select count(*)::int as count
        from bakery.workflow_runs
       where organization_id = ${organizationId}
         and task_id = ${taskIds.oversized}`;
    assertEquals(oversizedRows[0].count, 0);
    const unsupportedWorkflowStart = await send(
      "POST",
      `/v1/tasks/${taskIds.unsupportedWorkflow}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-unsupported-workflow",
        body: {
          ...runInput,
          workflowVersionId: unsupportedWorkflowVersionId,
          inputs: { taskId: taskIds.unsupportedWorkflow, target: "main" },
        },
      },
    );
    assertEquals(unsupportedWorkflowStart.status, 409);
    assertEquals(
      (await unsupportedWorkflowStart.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const unsupportedWorkflowPersistence = await owner`
      select
        (select count(*)::int from bakery.workflow_runs
          where organization_id = ${organizationId}
            and task_id = ${taskIds.unsupportedWorkflow}) as run_count,
        (select count(*)::int from bakery.idempotency_records
          where organization_id = ${organizationId}
            and principal_id = ${principalId}
            and operation = 'runs.create'
            and key = 'issue36-unsupported-workflow') as receipt_count`;
    assertEquals(unsupportedWorkflowPersistence[0], {
      run_count: 0,
      receipt_count: 0,
    });
    // #16: a published compiler-grammar version with a container node is a
    // compiled plan (#30 E3b-2c). This one declares no inputs, so it does not
    // compile as a plan: a typed refusal, not an unhandled 500, and no run or
    // receipt. (A plan with a wait is refused as not executable; that case is
    // in the compiled-plan admission test.)
    const planOnlyWorkflowStart = await send(
      "POST",
      `/v1/tasks/${taskIds.planOnlyWorkflow}/runs`,
      {
        organizationId,
        idempotencyKey: "issue16-plan-only-workflow",
        body: {
          ...runInput,
          workflowVersionId: planOnlyWorkflowVersionId,
          inputs: { taskId: taskIds.planOnlyWorkflow, target: "main" },
        },
      },
    );
    assertEquals(
      planOnlyWorkflowStart.status,
      409,
      await planOnlyWorkflowStart.clone().text(),
    );
    const planOnlyBody = await planOnlyWorkflowStart.json() as {
      code: string;
      reason?: string;
    };
    assertEquals(planOnlyBody.code, "STATE_CONFLICT");
    assertEquals(planOnlyBody.reason, "workflow_plan_not_compilable");
    const planOnlyPersistence = await owner`
      select
        (select count(*)::int from bakery.workflow_runs
          where organization_id = ${organizationId}
            and task_id = ${taskIds.planOnlyWorkflow}) as run_count,
        (select count(*)::int from bakery.idempotency_records
          where organization_id = ${organizationId}
            and principal_id = ${principalId}
            and operation = 'runs.create'
            and key = 'issue16-plan-only-workflow') as receipt_count`;
    assertEquals(planOnlyPersistence[0], { run_count: 0, receipt_count: 0 });
    const firstStart = await send(
      "POST",
      `/v1/tasks/${taskIds.ready}/runs`,
      { organizationId, idempotencyKey: "issue36-ready-run", body: runInput },
    );
    assertEquals(firstStart.status, 201);
    const firstBody = await firstStart.json() as Record<string, unknown>;
    assertEquals(firstBody.status, "queued");
    const runId = firstBody.id as string;
    assertEquals(firstBody.budgetLimitUsd, "0.005000");
    const expectedRunSnapshot = {
      schemaVersion: 1,
      executionMode: "repository",
      inputs: runInput.inputs,
      workflow: {
        id: workflowVersionId,
        revision: 1,
        digest: workflowDigest,
        normalizedSpec: workflowSpec,
      },
      repositoryProfile: {
        organizationId,
        applicationId,
        repositoryId,
        id: profileId,
        revision: 1,
        digest: profileDigest,
        config: profileConfig,
        observationId: null,
        observationDigest: null,
        baseSha: null,
        // No organization rules and no overrides: the pinned empty baseline.
        repositoryRules: {
          organizationRevision: 0,
          profileId,
          profileRevision: 1,
          entries: [],
          digest:
            "29b63ecc492e00756b31919bc5c780cca04a908684a519265743512a08406a1d",
        },
      },
      stepAgents: {},
      stepActions: Object.fromEntries(
        ["review", "research"].map((key) => [key, {
          action: "mcp.discover",
          registryVersion: null,
          metadata: null,
          capabilities: ["mcp.host_local"],
        }]),
      ),
      admission: {
        dependencies: [],
        status: "queued",
        reason: null,
      },
    };
    const admittedSnapshotRows = await owner`
      select snapshot from bakery.workflow_runs
       where organization_id = ${organizationId} and id = ${runId}`;
    assertEquals(admittedSnapshotRows.length, 1);
    assertEquals(admittedSnapshotRows[0].snapshot, expectedRunSnapshot);
    const admittedIdentityRows = await owner`
      select application_id as "applicationId",
             repository_id as "repositoryId",
             repository_profile_id as "repositoryProfileId",
             repository_profile_revision as "repositoryProfileRevision",
             repository_profile_digest as "repositoryProfileDigest",
             observation_id as "observationId",
             observation_digest as "observationDigest",
             base_sha as "baseSha"
        from bakery.workflow_runs
       where organization_id = ${organizationId} and id = ${runId}`;
    assertEquals(admittedIdentityRows[0], {
      applicationId,
      repositoryId,
      repositoryProfileId: profileId,
      repositoryProfileRevision: 1,
      repositoryProfileDigest: profileDigest,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    });

    const expectedBudgetSummary = {
      installation: null,
      run: {
        scope: "run",
        runId,
        periodStart: null,
        periodEnd: null,
        limitUsd: "0.005000",
        availableUsd: "0.005000",
        reservedUsd: "0",
        settledUsd: "0",
        unknownCount: 1,
      },
    };
    // A new run has completed no harness step, so no workspace base yet.
    assertEquals(firstBody.workspaceBaseSha, null);
    assertEquals(firstBody.budgetSummary, expectedBudgetSummary);
    assertEquals(firstBody.repositoryProfileId, profileId);
    const duplicateStart = await send(
      "POST",
      `/v1/tasks/${taskIds.ready}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-ready-run",
        body: {
          ...runInput,
          workflowVersionId: workflowVersionId.toUpperCase(),
          repositoryProfileId: profileId,
        },
      },
    );
    assertEquals(duplicateStart.status, 201);
    assertEquals(duplicateStart.headers.get("Idempotent-Replayed"), "true");
    assertEquals(await duplicateStart.json(), firstBody);
    const competingStart = await send(
      "POST",
      `/v1/tasks/${taskIds.ready}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-ready-run-second-key",
        body: runInput,
      },
    );
    assertEquals(competingStart.status, 409);
    assertEquals(
      (await competingStart.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const oneActiveRun = await owner`
      select
        (select count(*)::int from bakery.workflow_runs
          where organization_id = ${organizationId}
            and task_id = ${taskIds.ready}) as run_count,
        (select count(*)::int from bakery.domain_events e
          join bakery.workflow_runs r on r.id = e.aggregate_id
         where r.organization_id = ${organizationId}
           and r.task_id = ${taskIds.ready}) as event_count,
        (select count(*)::int from bakery.outbox o
          join bakery.domain_events e on e.id = o.event_id
          join bakery.workflow_runs r on r.id = e.aggregate_id
         where r.organization_id = ${organizationId}
           and r.task_id = ${taskIds.ready}) as outbox_count,
        (select count(*)::int from bakery.idempotency_records
          where organization_id = ${organizationId}
            and principal_id = ${principalId}
            and operation = 'runs.create'
            and key = 'issue36-ready-run-second-key') as receipt_count`;
    assertEquals(oneActiveRun[0], {
      run_count: 1,
      event_count: 1,
      outbox_count: 1,
      receipt_count: 0,
    });

    const durableIntent = await owner`
      select r.status as run_status, t.status as task_status,
             r.budget_limit_usd::text as budget_limit_usd,
             t.current_run_id = r.id as task_current_run_matches,
             (select count(*)::int from bakery.run_steps s where s.run_id = r.id) as step_count,
             (select count(*)::int from bakery.domain_events e where e.aggregate_id = r.id) as event_count,
             (select count(*)::int from bakery.outbox o
                join bakery.domain_events e on e.id = o.event_id
               where e.aggregate_id = r.id) as outbox_count
        from bakery.workflow_runs r
        join bakery.tasks t on t.id = r.task_id
       where r.organization_id = ${organizationId} and r.id = ${runId}`;
    assertEquals(durableIntent[0], {
      run_status: "queued",
      task_status: "queued",
      budget_limit_usd: "0.005000",
      task_current_run_matches: true,
      step_count: 2,
      event_count: 1,
      outbox_count: 1,
    });
    const runOutboxRows = await owner`
      select o.id, o.delivery_key as "deliveryKey", o.destination,
             e.id as "eventId", e.organization_id as "organizationId",
             e.organization_sequence::text as sequence,
             e.event_type as "eventType", e.schema_version as "schemaVersion",
             e.application_id as "applicationId",
             e.repository_id as "repositoryId", e.task_id as "taskId",
             e.conversation_id as "conversationId",
             e.aggregate_id as "aggregateId",
             e.aggregate_version as "aggregateVersion",
             e.payload, e.trace_id as "traceId", e.created_at as "createdAt"
        from bakery.outbox o
        join bakery.domain_events e on e.id = o.event_id
       where e.aggregate_id = ${runId}`;
    const runOutbox = OutboxEventRecordSchema.parse(runOutboxRows[0]);
    const engineEvent = toEngineEvent(runOutbox);
    assertEquals(engineEvent.name, "bakery/run.requested.v1");
    assertEquals(engineEvent.data.payload, { runId });
    const replayRecord = await owner`
      select count(*)::int as count
        from bakery.idempotency_records
       where organization_id = ${organizationId}
         and principal_id = ${principalId}
         and operation = 'runs.create'
         and key = 'issue36-ready-run'
         and status = 'completed'`;
    assertEquals(replayRecord[0].count, 1);
    const runList = await send(
      "GET",
      `/v1/tasks/${taskIds.ready}/runs`,
      { organizationId },
    );
    const runListBody = await runList.json() as {
      items: Array<{
        budgetLimitUsd: string;
        budgetSummary: {
          installation: null;
          run: {
            periodStart: string | null;
            periodEnd: string | null;
            limitUsd: string;
            availableUsd: string;
            unknownCount: number;
          };
        };
      }>;
    };
    assertEquals(runListBody.items.length, 1);
    assertEquals(runListBody.items[0].budgetLimitUsd, "0.005000");
    assertEquals(
      runListBody.items[0].budgetSummary,
      expectedBudgetSummary,
    );
    const runGet = await send("GET", `/v1/runs/${runId}`, { organizationId });
    assertEquals(runGet.status, 200);
    const runGetBody = await runGet.json() as {
      id: string;
      budgetLimitUsd: string;
      budgetSummary: {
        installation: null;
        run: {
          periodStart: string | null;
          periodEnd: string | null;
          limitUsd: string;
          availableUsd: string;
          unknownCount: number;
        };
      };
    };
    assertEquals(runGetBody.id, runId);
    assertEquals(runGetBody.budgetLimitUsd, "0.005000");
    assertEquals(runGetBody.budgetSummary, expectedBudgetSummary);

    const productionRunGet = await productionApp.fetch(
      new Request(`http://test/v1/runs/${runId}`, {
        headers: productionHeaders,
      }),
    );
    assertEquals(productionRunGet.status, 200);
    const productionRunProjection = await productionRunGet.json() as {
      id: string;
      budgetLimitUsd: string;
      budgetSummary: {
        installation: null;
        run: {
          periodStart: string | null;
          periodEnd: string | null;
          limitUsd: string;
          availableUsd: string;
          unknownCount: number;
        };
      };
    };
    assertEquals(productionRunProjection.id, runId);
    assertEquals(productionRunProjection.budgetLimitUsd, "0.005000");
    assertEquals(
      productionRunProjection.budgetSummary,
      expectedBudgetSummary,
    );
    const productionStepList = await productionApp.fetch(
      new Request(`http://test/v1/runs/${runId}/steps`, {
        headers: productionHeaders,
      }),
    );
    assertEquals(productionStepList.status, 200);
    const productionStepProjection = await productionStepList.json() as {
      items: Array<{ stepKey: string }>;
      nextCursor: string | null;
    };
    assertEquals(productionStepProjection.items.length, 2);
    assertEquals(
      productionStepProjection.items.map((step) => step.stepKey),
      ["review", "research"],
    );

    const anonymousRunGet = await productionApp.fetch(
      new Request(`http://test/v1/runs/${runId}`, {
        headers: { "Bakery-Organization-Id": organizationId },
      }),
    );
    assertEquals(anonymousRunGet.status, 401);
    assertEquals((await anonymousRunGet.text()).includes(runId), false);
    const anonymousStepList = await productionApp.fetch(
      new Request(`http://test/v1/runs/${runId}/steps`, {
        headers: { "Bakery-Organization-Id": organizationId },
      }),
    );
    assertEquals(anonymousStepList.status, 401);
    assertEquals((await anonymousStepList.text()).includes(runId), false);

    const hostileHeaders = {
      cookie: productionCookie,
      "Bakery-Organization-Id": hostileOrganizationId,
      origin: compositionConfig.publicBaseUrl,
    };
    const hostileRunGet = await productionApp.fetch(
      new Request(`http://test/v1/runs/${runId}`, {
        headers: hostileHeaders,
      }),
    );
    assertEquals(hostileRunGet.status, 404);
    assertEquals((await hostileRunGet.text()).includes(runId), false);
    const hostileStepList = await productionApp.fetch(
      new Request(`http://test/v1/runs/${runId}/steps`, {
        headers: hostileHeaders,
      }),
    );
    assertEquals(hostileStepList.status, 404);
    assertEquals((await hostileStepList.text()).includes(runId), false);
    const hostileRunKey = "issue36-hostile-foreign-task-run";
    const readTenantIsolationPersistence = () =>
      owner`
        select
          (select count(*)::int from bakery.workflow_runs
            where organization_id = ${organizationId}
              and task_id = ${taskIds.tenantIsolation}) as run_count,
          (select count(*)::int from bakery.domain_events
            where organization_id = ${organizationId}
              and task_id = ${taskIds.tenantIsolation}) as event_count,
          (select count(*)::int from bakery.idempotency_records
            where organization_id = ${hostileOrganizationId}
              and principal_id = ${principalId}
              and operation = 'runs.create'
              and key = ${hostileRunKey}) as receipt_count`;
    assertEquals((await readTenantIsolationPersistence())[0], {
      run_count: 0,
      event_count: 0,
      receipt_count: 0,
    });
    const hostileRunStart = await productionApp.fetch(
      new Request(`http://test/v1/tasks/${taskIds.tenantIsolation}/runs`, {
        method: "POST",
        headers: {
          ...hostileHeaders,
          "content-type": "application/json",
          "Idempotency-Key": hostileRunKey,
        },
        body: JSON.stringify(runInput),
      }),
    );
    assertEquals(hostileRunStart.status, 404);
    const hostileRunProblem = await hostileRunStart.json() as {
      code: string;
    };
    assertEquals(hostileRunProblem.code, "RESOURCE_NOT_FOUND");
    assertEquals(
      JSON.stringify(hostileRunProblem).includes(taskIds.tenantIsolation),
      false,
    );
    assertEquals((await readTenantIsolationPersistence())[0], {
      run_count: 0,
      event_count: 0,
      receipt_count: 0,
    });
    const hostileTaskRuns = await productionApp.fetch(
      new Request(`http://test/v1/tasks/${taskIds.tenantIsolation}/runs`, {
        headers: hostileHeaders,
      }),
    );
    assertEquals(hostileTaskRuns.status, 404);
    const hostileTaskRunsProblem = await hostileTaskRuns.json() as {
      code: string;
    };
    assertEquals(hostileTaskRunsProblem.code, "RESOURCE_NOT_FOUND");
    assertEquals(
      JSON.stringify(hostileTaskRunsProblem).includes(taskIds.tenantIsolation),
      false,
    );
    assertEquals((await readTenantIsolationPersistence())[0], {
      run_count: 0,
      event_count: 0,
      receipt_count: 0,
    });

    const stepList = await send(
      "GET",
      `/v1/runs/${runId}/steps`,
      { organizationId },
    );
    assertEquals(stepList.status, 200);
    assertEquals(
      (await stepList.json() as { items: unknown[] }).items.length,
      2,
    );
    const blockedStart = await send(
      "POST",
      `/v1/tasks/${taskIds.blocked}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-blocked-run",
        body: { ...runInput, inputs: { taskId: taskIds.blocked } },
      },
    );
    assertEquals(blockedStart.status, 201);
    const blockedBody = await blockedStart.json() as {
      id: string;
      status: string;
    };
    assertEquals(blockedBody.status, "blocked");
    const blockedEvents = await owner`
      select event_type, payload
        from bakery.domain_events
       where organization_id = ${organizationId}
         and aggregate_id in (${blockedBody.id}, ${taskIds.blocked})
       order by organization_sequence`;
    assertEquals(
      blockedEvents.map((row) => row.event_type),
      ["run.blocked", "tasks.updated"],
    );
    assertEquals(blockedEvents[0].payload, {
      resourceId: blockedBody.id,
      resourceVersion: 1,
      taskId: taskIds.blocked,
      status: "blocked",
      reason: "dependency_incomplete",
    });
    assertEquals(inngestEventDefinition("run.blocked", 1), null);
    assertEquals(blockedEvents[1].payload, {
      resourceId: taskIds.blocked,
      resourceVersion: 2,
    });
    const persistedBlocked = await owner`
      select status from bakery.workflow_runs
       where organization_id = ${organizationId} and id = ${blockedBody.id}`;
    assertEquals(persistedBlocked[0].status, "blocked");
    const requestedBlocked = await owner`
      select count(*)::int as count from bakery.domain_events
       where organization_id = ${organizationId}
         and aggregate_id = ${blockedBody.id}
         and event_type = 'run.requested'`;
    assertEquals(requestedBlocked[0].count, 0);
    const blockedOutbox = await owner`
      select count(*)::int as count
        from bakery.outbox o
        join bakery.domain_events e on e.id = o.event_id
       where e.organization_id = ${organizationId}
         and e.aggregate_id = ${blockedBody.id}`;
    assertEquals(blockedOutbox[0].count, 0);
    const blockedTaskOutboxRows = await owner`
      select o.id, o.delivery_key as "deliveryKey", o.destination,
             e.id as "eventId", e.organization_id as "organizationId",
             e.organization_sequence::text as sequence,
             e.event_type as "eventType", e.schema_version as "schemaVersion",
             e.application_id as "applicationId",
             e.repository_id as "repositoryId", e.task_id as "taskId",
             e.conversation_id as "conversationId",
             e.aggregate_id as "aggregateId",
             e.aggregate_version as "aggregateVersion",
             e.payload, e.trace_id as "traceId", e.created_at as "createdAt"
        from bakery.outbox o
        join bakery.domain_events e on e.id = o.event_id
       where e.organization_id = ${organizationId}
         and e.aggregate_id = ${taskIds.blocked}`;
    assertEquals(blockedTaskOutboxRows.length, 1);
    const blockedTaskEvent = toEngineEvent(
      OutboxEventRecordSchema.parse(blockedTaskOutboxRows[0]),
    );
    assertEquals(blockedTaskEvent.name, "bakery/tasks.updated.v1");
    assertEquals(blockedTaskEvent.data.payload, {
      resourceId: taskIds.blocked,
      resourceVersion: 2,
    });

    const disabledWorkflowRun = await send(
      "POST",
      `/v1/tasks/${taskIds.disabledWorkflow}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-disabled-workflow-run",
        body: {
          ...runInput,
          workflowVersionId: disabledWorkflowVersionId,
          inputs: { taskId: taskIds.disabledWorkflow },
        },
      },
    );
    assertEquals(disabledWorkflowRun.status, 409);
    assertEquals((await disabledWorkflowRun.json()).code, "STATE_CONFLICT");
    const disabledWorkflowRows = await owner`
      select
        (select count(*)::int from bakery.workflow_runs
          where organization_id = ${organizationId}
            and task_id = ${taskIds.disabledWorkflow}) as run_count,
        (select count(*)::int from bakery.domain_events
          where organization_id = ${organizationId}
            and task_id = ${taskIds.disabledWorkflow}) as event_count,
        (select count(*)::int from bakery.outbox o
          join bakery.domain_events e on e.id = o.event_id
          where e.organization_id = ${organizationId}
            and e.task_id = ${taskIds.disabledWorkflow}) as outbox_count`;
    assertEquals(disabledWorkflowRows[0], {
      run_count: 0,
      event_count: 0,
      outbox_count: 0,
    });

    const beforeProfileSource = await owner`
      select revision, digest, config::text as config
        from bakery.repository_profiles
       where organization_id = ${organizationId} and id = ${profileId}`;
    const beforeWorkflowSource = await owner`
      select revision, digest, normalized_spec::text as normalized_spec
        from bakery.workflow_versions
       where organization_id = ${organizationId} and id = ${workflowVersionId}`;
    // owner.begin awaits PostgreSQL COMMIT, surfacing the deferred profile
    // identity foreign-key violation instead of hiding it in autocommit.
    const profileMutationError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          update bakery.repository_profiles
             set config = '{"schemaVersion":1,"workflow":{"kind":"fixed"},"branches":{"base":"develop","allowedPatterns":["feature/*"]},"worktree":{"root":".changed"}}'::jsonb,
                 digest = ${"f".repeat(64)}
           where organization_id = ${organizationId} and id = ${profileId}`;
      })
    );
    assert(
      profileMutationError !== null &&
        typeof profileMutationError === "object",
    );
    assert("code" in profileMutationError);
    assert("constraint_name" in profileMutationError);
    assertEquals(profileMutationError.code, "23503");
    assertEquals(
      profileMutationError.constraint_name,
      "tasks_repository_profile_identity_fk",
    );
    const changedWorkflowSpec = {
      ...workflowSpec,
      steps: [...workflowSpec.steps, { id: "new", uses: "later" }],
    };
    await owner.begin(async (transaction) => {
      await transaction`
        update bakery.workflow_versions
           set normalized_spec = ${transaction.json(changedWorkflowSpec)},
               digest = ${await digest(changedWorkflowSpec)}
         where organization_id = ${organizationId} and id = ${workflowVersionId}`;
    });
    const afterProfileSource = await owner`
      select revision, digest, config::text as config
        from bakery.repository_profiles
       where organization_id = ${organizationId} and id = ${profileId}`;
    const afterWorkflowSource = await owner`
      select revision, digest, normalized_spec::text as normalized_spec
        from bakery.workflow_versions
       where organization_id = ${organizationId} and id = ${workflowVersionId}`;
    assertEquals(afterProfileSource[0], beforeProfileSource[0]);
    const workflowSourceChanged =
      beforeWorkflowSource[0].revision !== afterWorkflowSource[0].revision ||
      beforeWorkflowSource[0].digest !== afterWorkflowSource[0].digest ||
      beforeWorkflowSource[0].normalized_spec !==
        afterWorkflowSource[0].normalized_spec;
    assert(workflowSourceChanged);
    const afterSnapshotRows = await owner`
      select snapshot from bakery.workflow_runs
       where organization_id = ${organizationId} and id = ${runId}`;
    assertEquals(afterSnapshotRows.length, 1);
    assertEquals(afterSnapshotRows[0].snapshot, expectedRunSnapshot);
    const editedWorkflowSource = await owner`
      select jsonb_array_length(normalized_spec->'steps')::int as step_count
        from bakery.workflow_versions
       where organization_id = ${organizationId} and id = ${workflowVersionId}`;
    assertEquals(editedWorkflowSource[0].step_count, 3);
    const activeRunSteps = await owner`
      select s.step_key as "stepKey"
        from bakery.run_steps s
        join bakery.workflow_runs r
          on r.id = s.run_id and r.organization_id = s.organization_id
        join bakery.tasks t
          on t.current_run_id = r.id and t.organization_id = r.organization_id
       where t.organization_id = ${organizationId}
         and t.id = ${taskIds.ready}
         and r.id = ${runId}
       order by s.position, s.iteration`;
    assertEquals(activeRunSteps.length, 2);
    assertEquals(
      activeRunSteps.map((step) => step.stepKey),
      ["review", "research"],
    );
    const productionRunAfterEdits = await productionApp.fetch(
      new Request(`http://test/v1/runs/${runId}`, {
        headers: productionHeaders,
      }),
    );
    assertEquals(productionRunAfterEdits.status, 200);
    const productionStepsAfterEdits = await productionApp.fetch(
      new Request(`http://test/v1/runs/${runId}/steps`, {
        headers: productionHeaders,
      }),
    );
    assertEquals(productionStepsAfterEdits.status, 200);
    const editedStepProjection = await productionStepsAfterEdits.json() as {
      items: Array<{ stepKey: string }>;
    };
    assertEquals(editedStepProjection.items.length, 2);
    assertEquals(
      editedStepProjection.items.map((step) => step.stepKey),
      ["review", "research"],
    );

    const missingRepository = await send(
      "POST",
      `/v1/tasks/${taskIds.noRepository}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-missing-repository",
        body: runInput,
      },
    );
    assertEquals(missingRepository.status, 409);
    assertEquals((await missingRepository.json()).code, "STATE_CONFLICT");
    const missingRows = await owner`
      select count(*)::int as count from bakery.workflow_runs
       where organization_id = ${organizationId} and task_id = ${taskIds.noRepository}`;
    assertEquals(missingRows[0].count, 0);
    await owner`
      update bakery.workflow_runs
         set status = 'completed', updated_at = ${now}, version = version + 1
       where organization_id = ${organizationId} and id = ${runId}`;
    await owner`
      update bakery.tasks
         set status = 'draft', current_run_id = null, updated_at = ${now},
             version = version + 1
       where organization_id = ${organizationId} and id = ${taskIds.ready}`;
    await owner`
      update bakery.workflow_versions
         set normalized_spec = ${
      owner.json(workflowSpec)
    }, digest = ${workflowDigest}
       where organization_id = ${organizationId} and id = ${workflowVersionId}`;
    const secondStart = await send(
      "POST",
      `/v1/tasks/${taskIds.ready}/runs`,
      {
        organizationId,
        idempotencyKey: "issue36-ready-run-repeat",
        body: runInput,
      },
    );
    assertEquals(secondStart.status, 201);
    const secondRunId = (await secondStart.json() as { id: string }).id;
    const secondStepPageOne = await productionApp.fetch(
      new Request(
        `http://test/v1/runs/${secondRunId}/steps?limit=1`,
        { headers: productionHeaders },
      ),
    );
    assertEquals(secondStepPageOne.status, 200);
    const secondPageOne = await secondStepPageOne.json() as {
      items: Array<{ stepKey: string }>;
      nextCursor: string | null;
    };
    assertEquals(secondPageOne.items.map((step) => step.stepKey), ["review"]);
    assertEquals(typeof secondPageOne.nextCursor, "string");
    const secondStepPageTwo = await productionApp.fetch(
      new Request(
        `http://test/v1/runs/${secondRunId}/steps?limit=1&cursor=${
          encodeURIComponent(secondPageOne.nextCursor!)
        }`,
        { headers: productionHeaders },
      ),
    );
    assertEquals(secondStepPageTwo.status, 200);
    const secondPageTwo = await secondStepPageTwo.json() as {
      items: Array<{ stepKey: string }>;
      nextCursor: string | null;
    };
    assertEquals(secondPageTwo.items.map((step) => step.stepKey), ["research"]);
    assertEquals(secondPageTwo.nextCursor, null);

    const dependencyEdge = await send(
      "POST",
      `/v1/tasks/${taskIds.cycleA}/dependencies`,
      {
        organizationId,
        idempotencyKey: "issue36-cycle-edge-a",
        body: { dependsOnTaskId: taskIds.cycleB, condition: "completed" },
      },
    );
    assertEquals(dependencyEdge.status, 201);
    const replayedDependencyEdge = await send(
      "POST",
      `/v1/tasks/${taskIds.cycleA}/dependencies`,
      {
        organizationId,
        idempotencyKey: "issue36-cycle-edge-a",
        body: {
          dependsOnTaskId: taskIds.cycleB.toUpperCase(),
          condition: "completed",
        },
      },
    );
    assertEquals(replayedDependencyEdge.status, 201);
    assertEquals(
      replayedDependencyEdge.headers.get("Idempotent-Replayed"),
      "true",
    );
    const replayedDependencyBody = await replayedDependencyEdge.json();
    const secondDependencyEdge = await send(
      "POST",
      `/v1/tasks/${taskIds.cycleB}/dependencies`,
      {
        organizationId,
        idempotencyKey: "issue36-cycle-edge-b",
        body: { dependsOnTaskId: taskIds.cycleC, condition: "completed" },
      },
    );
    assertEquals(secondDependencyEdge.status, 201);
    const cycleRejected = await send(
      "POST",
      `/v1/tasks/${taskIds.cycleC}/dependencies`,
      {
        organizationId,
        idempotencyKey: "issue36-cycle-edge-c",
        body: { dependsOnTaskId: taskIds.cycleA, condition: "completed" },
      },
    );
    assertEquals(cycleRejected.status, 422);
    const cycleRejectedBody = await cycleRejected.json() as {
      code: string;
      issues?: Array<{ code: string }>;
    };
    assertEquals(cycleRejectedBody.code, "UNPROCESSABLE");
    assertEquals(cycleRejectedBody.issues?.[0]?.code, "dependency_cycle");
    const selfDependencyRejected = await send(
      "POST",
      `/v1/tasks/${taskIds.cycleA}/dependencies`,
      {
        organizationId,
        idempotencyKey: "issue36-self-dependency",
        body: {
          dependsOnTaskId: taskIds.cycleA.toUpperCase(),
          condition: "completed",
        },
      },
    );
    assertEquals(selfDependencyRejected.status, 422);
    const selfDependencyBody = await selfDependencyRejected.json() as {
      code: string;
      issues?: Array<{ code: string }>;
    };
    assertEquals(selfDependencyBody.code, "UNPROCESSABLE");
    assertEquals(selfDependencyBody.issues?.[0]?.code, "self_dependency");
    const dependencyBody = await dependencyEdge.json() as { id: string };
    assertEquals(replayedDependencyBody, dependencyBody);
    const secondDependencyBody = await secondDependencyEdge.json() as {
      id: string;
    };
    const dependencyEvents = await owner`
      select e.id, e.aggregate_id as "aggregateId"
        from bakery.domain_events e
       where e.organization_id = ${organizationId}
         and e.event_type = 'task.dependencies_changed'
         and e.aggregate_id in (${dependencyBody.id}, ${secondDependencyBody.id})
       order by e.aggregate_id`;
    assertEquals(dependencyEvents.length, 2);
    assertEquals(
      dependencyEvents.map((event) => event.aggregateId).sort(),
      [dependencyBody.id, secondDependencyBody.id].sort(),
    );
    for (const event of dependencyEvents) {
      const exactEventOutbox = await owner`
        select count(*)::int as count
          from bakery.outbox
         where event_id = ${event.id}`;
      assertEquals(exactEventOutbox[0].count, 0);
    }
    const staleDependencyDelete = await send(
      "DELETE",
      `/v1/tasks/${taskIds.cycleA}/dependencies/${dependencyBody.id}`,
      { organizationId, ifMatch: '"999"' },
    );
    assertEquals(staleDependencyDelete.status, 412);
    const retainedDependency = await owner`
      select count(*)::int as count
        from bakery.task_dependencies
       where organization_id = ${organizationId}
         and id = ${dependencyBody.id}`;
    assertEquals(retainedDependency[0].count, 1);
    const dependencyDeleted = await send(
      "DELETE",
      `/v1/tasks/${taskIds.cycleA}/dependencies/${dependencyBody.id}`,
      { organizationId },
    );
    assertEquals(dependencyDeleted.status, 204);
    const replayedDependencyDelete = await send(
      "DELETE",
      `/v1/tasks/${taskIds.cycleA}/dependencies/${dependencyBody.id}`,
      { organizationId },
    );
    assertEquals(replayedDependencyDelete.status, 204);
    assertEquals(
      replayedDependencyDelete.headers.get("Idempotent-Replayed"),
      "true",
    );
    const mismatchedNaturalDelete = await send(
      "DELETE",
      `/v1/tasks/${taskIds.cycleA}/dependencies/${dependencyBody.id}`,
      { organizationId, ifMatch: '"1"' },
    );
    assertEquals(mismatchedNaturalDelete.status, 422);
    assertEquals(
      (await mismatchedNaturalDelete.json() as { code: string }).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const deletedDependency = await owner`
      select count(*)::int as count
        from bakery.task_dependencies
       where organization_id = ${organizationId}
         and id = ${dependencyBody.id}`;
    assertEquals(deletedDependency[0].count, 0);
    const blockedDependency = await owner`
      select id, version
        from bakery.task_dependencies
       where organization_id = ${organizationId}
         and task_id = ${taskIds.blocked}`;
    assertEquals(blockedDependency.length, 1);
    const dependencyCreateAfterAdmission = await send(
      "POST",
      `/v1/tasks/${taskIds.blocked}/dependencies`,
      {
        organizationId,
        idempotencyKey: "issue36-admitted-dependency-create",
        body: {
          dependsOnTaskId: taskIds.cycleA,
          condition: "completed",
        },
      },
    );
    assertEquals(dependencyCreateAfterAdmission.status, 409);
    assertEquals(
      (await dependencyCreateAfterAdmission.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const dependencyDeleteAfterAdmission = await send(
      "DELETE",
      `/v1/tasks/${taskIds.blocked}/dependencies/${blockedDependency[0].id}`,
      {
        organizationId,
        ifMatch: `"${blockedDependency[0].version}"`,
      },
    );
    assertEquals(dependencyDeleteAfterAdmission.status, 409);
    assertEquals(
      (await dependencyDeleteAfterAdmission.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const archivedPrerequisiteRejected = await send(
      "POST",
      `/v1/tasks/${taskIds.cycleC}/dependencies`,
      {
        organizationId,
        idempotencyKey: "issue36-archived-prerequisite",
        body: {
          dependsOnTaskId: taskIds.archivedPrerequisite,
          condition: "completed",
        },
      },
    );
    assertEquals(archivedPrerequisiteRejected.status, 409);
    assertEquals(
      (await archivedPrerequisiteRejected.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const archivedOwnerDependency = await owner`
      select id, version
        from bakery.task_dependencies
       where organization_id = ${organizationId}
         and task_id = ${taskIds.archivedPrerequisite}`;
    assertEquals(archivedOwnerDependency.length, 1);
    const archivedOwnerCreateRejected = await send(
      "POST",
      `/v1/tasks/${taskIds.archivedPrerequisite}/dependencies`,
      {
        organizationId,
        idempotencyKey: "issue36-archived-owner-create",
        body: {
          dependsOnTaskId: taskIds.cycleB,
          condition: "completed",
        },
      },
    );
    assertEquals(archivedOwnerCreateRejected.status, 409);
    assertEquals(
      (await archivedOwnerCreateRejected.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const archivedOwnerDeleteRejected = await send(
      "DELETE",
      `/v1/tasks/${taskIds.archivedPrerequisite}/dependencies/${
        archivedOwnerDependency[0].id
      }`,
      {
        organizationId,
        ifMatch: `"${archivedOwnerDependency[0].version}"`,
      },
    );
    assertEquals(archivedOwnerDeleteRejected.status, 409);
    assertEquals(
      (await archivedOwnerDeleteRejected.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const rejectedDependencyState = await owner`
      select
        (select count(*)::int
           from bakery.task_dependencies
          where organization_id = ${organizationId}
            and task_id = ${taskIds.blocked}) as blocked_count,
        (select count(*)::int
           from bakery.task_dependencies
          where organization_id = ${organizationId}
            and task_id = ${taskIds.cycleC}
            and depends_on_task_id = ${taskIds.archivedPrerequisite})
          as archived_count,
        (select count(*)::int
           from bakery.task_dependencies
          where organization_id = ${organizationId}
            and task_id = ${taskIds.archivedPrerequisite})
          as archived_owner_count`;
    assertEquals(rejectedDependencyState[0], {
      blocked_count: 1,
      archived_count: 0,
      archived_owner_count: 1,
    });
  } finally {
    await owner`
      delete from bakery.organizations
       where id = ${organizationId}
          or id = ${hostileOrganizationId}`;
    await owner`
      delete from bakery.principals
       where id = ${principalId}`;
    await owner`
      delete from public."user"
       where id = ${userId}`;
    await closePgDatabase(appPg);
    await closePgDatabase(authDb);
    await closeDatabase(appDatabase);
    await closeDatabase(owner);
  }
});
