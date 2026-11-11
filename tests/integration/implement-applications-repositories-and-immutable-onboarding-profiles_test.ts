import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import type { Hono } from "hono";
import { assertEquals, assertRejects } from "@std/assert";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  closePgDatabase,
  type Database,
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
  preserveProviderInvitationState,
} from "../../apps/server/src/modules/auth/migrations.ts";
import {
  EVENT_CLOCK_DATA_BOUNDARY,
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { resolveRepositoryBinding } from "../../apps/server/src/modules/projects/binding.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../apps/server/src/platform/command-replay.ts";
import {
  createProjectsActionRegistry,
  createProjectsHandlers,
} from "../../apps/server/src/modules/projects/index.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import {
  createBakeryPostgresWorkflowRepository,
} from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import type {
  LogicalInvocationKey,
} from "../../apps/server/src/modules/workflow-adapter/invocation-contract.ts";
import { appendDomainEvent, withPgTransaction } from "@bakery/persistence";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { WORKFLOW_ACTION_METADATA } from "../../packages/contracts/src/workflow-action-registry.ts";
import {
  RepositoryInspectionJobInputSchema,
  RepositoryInspectionReportSchema,
  RepositoryProfileObservationPayloadSchema,
} from "../../packages/contracts/src/repository-inspection.ts";
import { settled } from "../helpers/lock-race.ts";
import { recordPgFaults } from "../helpers/pg-faults.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
  receiveInspectionSource,
} from "../helpers/repository-inspection.ts";
import {
  markJobAttemptBudgetExhausted,
  reclaimExpiredAttempts,
} from "../../packages/persistence/src/attempts.ts";
import { admitRepositoryExecutionJob } from "../../packages/persistence/src/repository-admission.ts";
import { frozenExecutionContextBackfill } from "../../apps/server/src/modules/work/migrations/data/0049_issue46_frozen_execution_context.ts";
import { protect } from "../../apps/server/src/modules/execution/shared.ts";

const { databaseUrl, appDatabaseUrl, adminDatabaseUrl } =
  readTestDatabaseConfig(Deno.env.toObject(), { requireAdmin: true });

const profileConfig = {
  schemaVersion: 1 as const,
  workflow: { kind: "fixed" as const },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};
const fixedPolicyDraft = {
  schemaVersion: 1 as const,
  commands: [
    { id: "format.guide", argv: ["pnpm", "fmt"] },
    { id: "lint.warn", argv: ["pnpm", "lint"] },
    { id: "test.required", argv: ["pnpm", "test", "--filter", "policy"] },
  ],
  allowedEffects: [
    "artifact_only",
    "repository_revision",
    "evidence_only",
    "projection_only",
  ] as const,
  lockedConfiguration: { branches: true, worktree: true, checker: true },
  decisions: [
    { commandId: "format.guide", mode: "guide" as const },
    { commandId: "lint.warn", mode: "warn" as const },
    { commandId: "test.required", mode: "require" as const },
  ],
};
const fixedPolicyProfileConfig = {
  ...profileConfig,
  fixedPolicy: fixedPolicyDraft,
};
const projectsMigration0046 = "0046_issue46_repository_onboarding";
const projectsMigration0047 = "0047_issue46_repository_slug_uniqueness";

async function digestFor(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

function errorConstraintName(error: unknown): string | undefined {
  if (
    typeof error === "object" && error !== null &&
    "constraint_name" in error &&
    typeof error.constraint_name === "string"
  ) {
    return error.constraint_name;
  }
  return undefined;
}

type LegacyIdentityMode = "valid" | "wrong-repository";

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
function errorMessage(error: unknown): string | undefined {
  if (
    typeof error === "object" && error !== null && "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
}

type LegacyJob = {
  applicationId: string;
  organizationId: string;
  principalId: string;
  profileId: string;
  jobId: string;
  repositoryId: string;
  runId: string;
  taskId: string;
};

type IntegrationDatabaseFixture = {
  owner: Database;
  authDb: PgDatabase;
  appPg: PgDatabase;
  legacyJob: LegacyJob;
  migrateThrough: (version: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

async function migrateTestDatabase(
  options: {
    legacyIdentity?: LegacyIdentityMode;
    through?: string;
    throughData?: string;
  } = {},
): Promise<IntegrationDatabaseFixture> {
  const admin = openDatabase(adminDatabaseUrl, 1);
  const databaseName = `bakery_integration_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  const databaseIdentifier = `"${databaseName}"`;
  const isolatedOwnerUrl = new URL(databaseUrl);
  isolatedOwnerUrl.pathname = `/${databaseName}`;
  const isolatedAppUrl = new URL(appDatabaseUrl);
  isolatedAppUrl.pathname = `/${databaseName}`;
  let owner: Database | undefined;
  let authDb: PgDatabase | undefined;
  let appPg: PgDatabase | undefined;
  let databaseCreated = false;
  const closeConnections = async () => {
    await Promise.all([
      ...(owner === undefined ? [] : [closeDatabase(owner)]),
      ...(authDb === undefined ? [] : [closePgDatabase(authDb)]),
      ...(appPg === undefined ? [] : [closePgDatabase(appPg)]),
    ]);
  };
  try {
    const target = new URL(databaseUrl);
    const adminTarget = new URL(adminDatabaseUrl);
    const { allowRemote } = readTestDatabaseResetOptions();
    const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
    // Docker's server-side bridge address can differ from the published
    // loopback address; validate both URLs and only create/drop this UUID-named
    // scratch database.
    if (
      (!loopbackHosts.includes(target.hostname) ||
        !loopbackHosts.includes(adminTarget.hostname)) &&
      !allowRemote
    ) {
      throw new Error("DESTRUCTIVE_RESET_REQUIRES_LOOPBACK");
    }
    const ownerName = decodeURIComponent(target.username);
    if (ownerName === "") {
      throw new Error("DATABASE_URL_REQUIRES_OWNER_ROLE");
    }
    const ownerRole = `"${ownerName.replaceAll('"', '""')}"`;
    await admin.unsafe(
      `create database ${databaseIdentifier} owner ${ownerRole}`,
    );
    databaseCreated = true;
    owner = openDatabase(isolatedOwnerUrl.toString(), 1);
    authDb = openPgDatabase(isolatedOwnerUrl.toString(), 1);
    appPg = openPgDatabase(isolatedAppUrl.toString(), 1);
    await migrateProvider(
      authDb,
      await loadMigrations(betterAuthMigrationSource),
      { beforeApply: preserveProviderInvitationState },
    );
    const allMigrations = [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ];
    await migrate(owner, allMigrations, {
      through: "0031_issue42_execution_control_replay",
    });
    await migrateData(owner, bakeryDataMigrations, {
      through: EVENT_CLOCK_DATA_BOUNDARY,
    });
    const legacyJob = await seedLegacyJob(
      owner,
      options.legacyIdentity ?? "valid",
    );
    await migrate(
      owner,
      allMigrations,
      options.through === undefined ? {} : { through: options.through },
    );
    await migrateData(owner, bakeryDataMigrations, {
      // A schema stopped early predates the migration that relaxes
      // organizations.default_locale, so data migration 0071 cannot run yet.
      through: options.throughData ??
        (options.through === undefined
          ? undefined
          : "0049_issue46_frozen_execution_context"),
      untilComplete: true,
    });
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        await closeConnections();
      } finally {
        try {
          await admin.unsafe(`drop database if exists ${databaseIdentifier}`);
        } finally {
          await closeDatabase(admin);
        }
      }
    };
    const migrateThrough = async (through: string): Promise<void> => {
      await migrate(owner!, allMigrations, { through });
      // The authority runner needs a fully migrated auth schema
      // (organisation_roles, migration 0100). Apply every auth
      // migration to head so that loadMembership's LEFT JOIN never
      // hits an undefined-table error, regardless of the projects
      // boundary the caller requested.
      const authMigrations = await loadMigrations(authBakeryMigrationSource);
      const isAuthMigration: Record<string, true> = {};
      for (const migration of authMigrations) {
        isAuthMigration[migration.version] = true;
      }
      await migrate(
        owner!,
        allMigrations.filter(
          (m) =>
            isAuthMigration[m.version] === true ||
            m.version <= through,
        ),
      );
    };
    return {
      owner: owner!,
      authDb: authDb!,
      appPg: appPg!,
      migrateThrough,
      legacyJob,
      cleanup,
    };
  } catch (error) {
    try {
      await closeConnections();
    } finally {
      try {
        if (databaseCreated) {
          await admin.unsafe(`drop database if exists ${databaseIdentifier}`);
        }
      } finally {
        await closeDatabase(admin);
      }
    }
    throw error;
  }
}

async function seedLegacyJob(
  owner: Database,
  legacyIdentity: LegacyIdentityMode = "valid",
): Promise<LegacyJob> {
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const runStepId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await seedOrganization(
    owner,
    organizationId,
    principalId,
    userId,
    "Legacy Job",
  );
  await owner`
    insert into bakery.applications (
      id, organization_id, slug, name, description
    ) values (
      ${applicationId}, ${organizationId}, 'legacy', 'Legacy', ''
    )`;
  await owner`
    insert into bakery.repositories (
      id, organization_id, application_id, integration_connection_id,
      provider_repo_id, owner, name, default_branch
    ) values (
      ${repositoryId}, ${organizationId}, ${applicationId},
      ${crypto.randomUUID()}, 'legacy/repository', 'legacy-owner',
      'legacy-repository', 'main'
    )`;
  const profileDigest = await digestFor(profileConfig);
  const pinnedProfileId = profileId;
  const pinnedProfileDigest = profileDigest;
  let runProfileId = profileId;
  if (legacyIdentity === "wrong-repository") {
    const wrongRepositoryId = crypto.randomUUID();
    runProfileId = crypto.randomUUID();
    await owner`
      insert into bakery.repositories (
        id, organization_id, application_id, integration_connection_id,
        provider_repo_id, owner, name, default_branch
      ) values (
        ${wrongRepositoryId}, ${organizationId}, ${applicationId},
        ${crypto.randomUUID()}, 'legacy/wrong-repository', 'legacy-owner',
        'wrong-repository', 'main'
      )`;
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, repository_id, revision, config, digest, created_by
      ) values (
        ${runProfileId}, ${organizationId}, ${wrongRepositoryId}, 1,
        ${owner.json(profileConfig)}, ${profileDigest}, ${principalId}
      )`;
  }
  await owner`
    insert into bakery.repository_profiles (
      id, organization_id, repository_id, revision, config, digest, created_by
    ) values (
      ${profileId}, ${organizationId}, ${repositoryId}, 1,
      ${owner.json(profileConfig)}, ${profileDigest}, ${principalId}
    )`;
  await owner`
    update bakery.repositories
       set active_profile_id = ${profileId}
     where organization_id = ${organizationId} and id = ${repositoryId}`;
  await owner`
    insert into bakery.conversations (
      id, organization_id, application_id, repository_id, title, created_by
    ) values (
      ${conversationId}, ${organizationId}, ${applicationId}, ${repositoryId},
      'Legacy task', ${principalId}
    )`;
  await owner`
    insert into bakery.tasks (
      id, organization_id, application_id, repository_id, conversation_id,
      title, description, task_type, status, priority, created_by,
      repository_profile_id, repository_profile_revision,
      repository_profile_digest
    ) values (
      ${taskId}, ${organizationId}, ${applicationId}, ${repositoryId},
      ${conversationId}, 'Legacy task', '', 'feature', 'draft', 50,
      ${principalId}, ${pinnedProfileId}, 1, ${pinnedProfileDigest}
    )`;
  await owner`
    insert into bakery.workflow_definitions (
      id, organization_id, slug, name, description
    ) values (
      ${workflowId}, ${organizationId}, 'legacy', 'Legacy', ''
    )`;
  await owner`
    insert into bakery.workflow_versions (
      id, organization_id, workflow_id, revision, source_yaml,
      normalized_spec, digest, status, created_by
    ) values (
      ${workflowVersionId}, ${organizationId}, ${workflowId}, 1, 'steps: []',
      ${owner.json({ steps: [] })}, ${"b".repeat(64)}, 'published',
      ${principalId}
    )`;
  await owner`
    insert into bakery.workflow_runs (
      id, organization_id, task_id, workflow_version_id,
      repository_profile_id, requested_by, status, snapshot, budget_limit_usd
    ) values (
      ${runId}, ${organizationId}, ${taskId}, ${workflowVersionId},
      ${runProfileId}, ${principalId}, 'queued', ${owner.json({})}, 0
    )`;
  await owner`
    insert into bakery.run_steps (
      id, organization_id, run_id, step_key, position, input
    ) values (
      ${runStepId}, ${organizationId}, ${runId}, 'legacy', 0,
      ${owner.json({})}
    )`;
  await owner`
    insert into bakery.jobs (
      id, organization_id, run_step_id, repository_id, action
    ) values (
      ${jobId}, ${organizationId}, ${runStepId}, ${repositoryId}, 'legacy'
    )`;
  return {
    applicationId,
    organizationId,
    principalId,
    profileId,
    jobId,
    repositoryId,
    runId,
    taskId,
  };
}

async function seedOrganization(
  owner: Database,
  organizationId: string,
  principalId: string,
  userId: string,
  label: string,
): Promise<void> {
  const now = new Date("2026-09-27T00:00:00.000Z");
  const slug = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  await owner`
    insert into public."user" (
      id, name, email, "emailVerified", "createdAt", "updatedAt"
    ) values (
      ${userId}, ${label}, ${`${slug}@example.test`}, true,
      ${now}, ${now}
    )`;
  await owner`
    insert into bakery.principals (
      id, provider_user_id, display_name, principal_type
    ) values (${principalId}, ${userId}, ${label}, 'human')`;
  await owner`
    insert into bakery.organizations (
      id, name, slug, metadata, created_at, updated_at, version
    ) values (
      ${organizationId}, ${label}, ${`${slug}-${organizationId}`},
      '{}'::jsonb, ${now}, ${now}, 1
    )`;
  await owner`
    insert into bakery.organization_memberships (
      id, organization_id, principal_id, role, status, joined_at,
      created_at, updated_at, version
    ) values (
      ${crypto.randomUUID()}, ${organizationId}, ${principalId}, 'admin',
      'active', ${now}, ${now}, ${now}, 1
    )`;
}

Deno.test("Projects migration fails closed for wrong-repository legacy pins", async () => {
  const migrationError = await assertRejects(() =>
    migrateTestDatabase({ legacyIdentity: "wrong-repository" })
  );
  assertEquals(errorCode(migrationError), "23503");
  assertEquals(
    errorMessage(migrationError),
    "PROJECTS_MIGRATION_WORKFLOW_RUN_REPOSITORY_PROFILE_IDENTITY_MISMATCH",
  );
});

Deno.test("Projects Phase 1 persists tenant-safe identity and rejects manual observed activation", async () => {
  const fixture = await migrateTestDatabase();
  const { owner, appPg, legacyJob } = fixture;
  try {
    const legacyJobRows = await owner`
      select repository_id, observation_id, observation_digest, base_sha
        from bakery.jobs
       where id = ${legacyJob.jobId}`;
    assertEquals(legacyJobRows[0]?.repository_id, legacyJob.repositoryId);
    assertEquals(legacyJobRows[0]?.observation_id, null);
    assertEquals(legacyJobRows[0]?.observation_digest, null);
    assertEquals(legacyJobRows[0]?.base_sha, null);
    const legacyProfileRows = await owner`
      select p.application_id, p.config, p.digest, p.revision,
             r.active_profile_id
        from bakery.repository_profiles p
        join bakery.repositories r
          on r.organization_id = p.organization_id and r.id = p.repository_id
       where p.organization_id = ${legacyJob.organizationId}
         and p.id = ${legacyJob.profileId}`;
    assertEquals(legacyProfileRows[0]?.application_id, legacyJob.applicationId);
    assertEquals(legacyProfileRows[0]?.config, profileConfig);
    assertEquals(legacyProfileRows[0]?.digest, await digestFor(profileConfig));
    assertEquals(legacyProfileRows[0]?.revision, 1);
    assertEquals(legacyProfileRows[0]?.active_profile_id, legacyJob.profileId);
    const legacyIdentityRows = await owner`
      select
        task.repository_profile_id as task_profile_id,
        task.repository_profile_revision as task_profile_revision,
        task.repository_profile_digest as task_profile_digest,
        run.application_id as run_application_id,
        run.repository_id as run_repository_id,
        run.repository_profile_id as run_profile_id,
        run.repository_profile_revision as run_profile_revision,
        run.repository_profile_digest as run_profile_digest
        from bakery.tasks task
        join bakery.workflow_runs run
          on run.organization_id = task.organization_id
         and run.task_id = task.id
       where task.id = ${legacyJob.taskId}
         and run.id = ${legacyJob.runId}`;
    assertEquals(legacyIdentityRows[0], {
      task_profile_id: legacyJob.profileId,
      task_profile_revision: 1,
      task_profile_digest: await digestFor(profileConfig),
      run_application_id: legacyJob.applicationId,
      run_repository_id: legacyJob.repositoryId,
      run_profile_id: legacyJob.profileId,
      run_profile_revision: 1,
      run_profile_digest: await digestFor(profileConfig),
    });
    const identityConstraintRows = await owner`
      select c.conname, c.convalidated
        from pg_constraint c
        join pg_class r on r.oid = c.conrelid
        join pg_namespace n on n.oid = r.relnamespace
       where n.nspname = 'bakery'
         and c.conname in (
           'tasks_repository_profile_identity_fk',
           'workflow_runs_repository_profile_identity_fk',
           'jobs_repository_profile_identity_fk'
         )
       order by c.conname`;
    assertEquals([...identityConstraintRows], [
      { conname: "jobs_repository_profile_identity_fk", convalidated: true },
      {
        conname: "tasks_repository_profile_identity_fk",
        convalidated: true,
      },
      {
        conname: "workflow_runs_repository_profile_identity_fk",
        convalidated: true,
      },
    ]);
    const migratedLegacyConversationId = crypto.randomUUID();
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, repository_id, title, created_by
      ) values (
        ${migratedLegacyConversationId}, ${legacyJob.organizationId},
        ${legacyJob.applicationId}, ${legacyJob.repositoryId},
        'Migrated legacy profile task', ${legacyJob.principalId}
      )`;
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, repository_id, conversation_id,
        title, description, task_type, status, priority, created_by,
        repository_profile_id, repository_profile_revision,
        repository_profile_digest
      ) values (
        ${crypto.randomUUID()}, ${legacyJob.organizationId},
        ${legacyJob.applicationId}, ${legacyJob.repositoryId},
        ${migratedLegacyConversationId}, 'Migrated legacy profile task',
        '', 'feature', 'draft', 50, ${legacyJob.principalId},
        ${legacyJob.profileId}, 1, ${await digestFor(profileConfig)}
      )`;
    await owner.begin(async (transaction) => {
      await transaction`
        delete from bakery.organizations
         where id = ${legacyJob.organizationId}`;
    });
    const legacyCascadeRows = await owner`
      select
        exists (
          select 1 from bakery.organizations
           where id = ${legacyJob.organizationId}
        ) as organization_exists,
        exists (
          select 1 from bakery.applications
           where organization_id = ${legacyJob.organizationId}
        ) as application_exists,
        exists (
          select 1 from bakery.repositories
           where organization_id = ${legacyJob.organizationId}
        ) as repository_exists,
        exists (
          select 1 from bakery.repository_profiles
           where organization_id = ${legacyJob.organizationId}
        ) as profile_exists,
        exists (
          select 1 from bakery.tasks
           where organization_id = ${legacyJob.organizationId}
        ) as task_exists,
        exists (
          select 1 from bakery.jobs
           where organization_id = ${legacyJob.organizationId}
        ) as job_exists`;
    assertEquals(legacyCascadeRows[0]?.organization_exists, false);
    assertEquals(legacyCascadeRows[0]?.application_exists, false);
    assertEquals(legacyCascadeRows[0]?.repository_exists, false);
    assertEquals(legacyCascadeRows[0]?.profile_exists, false);
    assertEquals(legacyCascadeRows[0]?.task_exists, false);
    assertEquals(legacyCascadeRows[0]?.job_exists, false);

    const organizationAId = crypto.randomUUID();
    const organizationBId = crypto.randomUUID();
    const principalAId = crypto.randomUUID();
    const principalBId = crypto.randomUUID();
    const userAId = crypto.randomUUID();
    const userBId = crypto.randomUUID();
    await seedOrganization(
      owner,
      organizationAId,
      principalAId,
      userAId,
      "Org A",
    );
    await seedOrganization(
      owner,
      organizationBId,
      principalBId,
      userBId,
      "Org B",
    );

    const principalA = {
      principalId: principalAId,
      principalType: "human" as const,
      displayName: "Org A",
    };
    const principalB = {
      principalId: principalBId,
      principalType: "human" as const,
      displayName: "Org B",
    };
    let principal = principalA;
    const projectsRegistry = createProjectsActionRegistry(
      createProjectsHandlers("issue-46-integration-secret"),
      {
        authorityRunner: new PostgresAuthorityRunner(appPg),
        commandRunner: createPostgresCommandRunner(),
      },
    );
    const app = createApiRouter({
      registry: projectsRegistry,
      createContext: () => ({ principal }),
    });
    let commandNumber = 0;
    const send = async (
      method: string,
      path: string,
      organizationId: string,
      body?: unknown,
      ifMatch?: string,
    ): Promise<Response> => {
      const headers: Record<string, string> = {
        "Bakery-Organization-Id": organizationId,
      };
      if (method !== "GET") {
        headers["Idempotency-Key"] = `phase1-${commandNumber++}`;
      }
      if (body !== undefined) headers["content-type"] = "application/json";
      if (ifMatch !== undefined) headers["If-Match"] = ifMatch;
      return await app.fetch(
        new Request(`http://projects.test${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    };

    const applicationAResponse = await send(
      "POST",
      "/v1/applications",
      organizationAId,
      { slug: "bakery", name: "Bakery A", description: "" },
    );
    assertEquals(applicationAResponse.status, 201);
    const applicationA = await applicationAResponse.json() as { id: string };

    principal = principalB;
    const applicationBResponse = await send(
      "POST",
      "/v1/applications",
      organizationBId,
      { slug: "bakery", name: "Bakery B", description: "" },
    );
    assertEquals(applicationBResponse.status, 201);
    const applicationB = await applicationBResponse.json() as { id: string };

    principal = principalA;
    const connectionAId = crypto.randomUUID();
    const repositoryAResponse = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationA.id,
        slug: "bakery-a",
        integrationConnectionId: connectionAId,
        providerRepoId: "provider/repository-a",
        owner: "provider-owner",
        name: "Bakery",
        defaultBranch: "main",
      },
    );
    assertEquals(repositoryAResponse.status, 201);
    const duplicateSlugResponse = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationA.id,
        slug: "bakery-a",
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: "provider/repository-a-duplicate-slug",
        owner: "provider-owner",
        name: "Bakery-duplicate-slug",
        defaultBranch: "main",
      },
    );
    assertEquals(duplicateSlugResponse.status, 409);
    assertEquals((await duplicateSlugResponse.json()).code, "STATE_CONFLICT");
    const duplicateSlugRows = await owner`
      select count(*)::integer as count, min(provider_repo_id) as provider_repo_id
        from bakery.repositories
       where organization_id = ${organizationAId}
         and application_id = ${applicationA.id}
         and slug = 'bakery-a'`;
    assertEquals(duplicateSlugRows[0], {
      count: 1,
      provider_repo_id: "provider/repository-a",
    });
    const repositoryA = await repositoryAResponse.json() as { id: string };

    principal = principalB;
    const repositoryBResponse = await send(
      "POST",
      "/v1/repositories",
      organizationBId,
      {
        applicationId: applicationB.id,
        slug: "bakery-b",
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: "provider/repository-b",
        owner: "provider-owner",
        name: "Bakery",
        defaultBranch: "main",
      },
    );
    assertEquals(repositoryBResponse.status, 201);
    const repositoryB = await repositoryBResponse.json() as { id: string };

    const identityRows = await owner`
      select r.organization_id, r.slug, a.slug as application_slug
        from bakery.repositories r
        join bakery.applications a
          on a.organization_id = r.organization_id and a.id = r.application_id
       where r.id in (${repositoryA.id}, ${repositoryB.id})
       order by r.organization_id`;
    assertEquals(
      new Map(identityRows.map((row) => [row.organization_id, {
        slug: row.slug,
        applicationSlug: row.application_slug,
      }])),
      new Map([
        [organizationAId, { slug: "bakery-a", applicationSlug: "bakery" }],
        [organizationBId, { slug: "bakery-b", applicationSlug: "bakery" }],
      ]),
    );

    principal = principalA;
    const duplicateProvider = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationA.id,
        slug: "bakery-a-duplicate",
        integrationConnectionId: connectionAId,
        providerRepoId: "provider/repository-a",
        owner: "provider-owner",
        name: "bakery-duplicate",
        defaultBranch: "main",
      },
    );
    assertEquals(duplicateProvider.status, 409);

    const sameDisplayNameRepository = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationA.id,
        slug: "bakery-a-second",
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: "provider/repository-a-second",
        owner: "provider-owner",
        name: "BAKERY",
        defaultBranch: "main",
      },
    );
    assertEquals(sameDisplayNameRepository.status, 201);

    const foreignApplicationAttachment = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationB.id,
        slug: "foreign-application",
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: "provider/foreign-application",
        owner: "provider-owner",
        name: "foreign-application",
        defaultBranch: "main",
      },
    );
    assertEquals(foreignApplicationAttachment.status, 404);

    const renamed = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { name: "bakery-renamed" },
      '"1"',
    );
    assertEquals(renamed.status, 200);
    const inertSlug = await owner`
      select slug from bakery.repositories where id = ${repositoryA.id}`;
    assertEquals(inertSlug[0]?.slug, "bakery-a");

    const profileResponse = await send(
      "POST",
      `/v1/repositories/${repositoryA.id}/profiles`,
      organizationAId,
      {
        revision: 1,
        config: profileConfig,
        digest: await digestFor(profileConfig),
      },
    );
    assertEquals(profileResponse.status, 201);
    const profileA = await profileResponse.json() as { id: string };
    const activatedRepositoryRows = await owner`
      select version from bakery.repositories where id = ${repositoryA.id}`;
    const profilePublicationEvents = await owner`
      select event_type, application_id, repository_id
        from bakery.domain_events
       where organization_id = ${organizationAId}
         and (
           (
             event_type = 'repositories.updated'
             and aggregate_id = ${repositoryA.id}
             and aggregate_version = ${activatedRepositoryRows[0]?.version}
           )
           or (
             event_type = 'repository.profile_created'
             and aggregate_id = ${profileA.id}
           )
         )
       order by organization_sequence`;
    assertEquals(
      profilePublicationEvents.map((row) => ({
        event_type: row.event_type,
        application_id: row.application_id,
        repository_id: row.repository_id,
      })),
      [
        {
          event_type: "repositories.updated",
          application_id: applicationA.id,
          repository_id: repositoryA.id,
        },
        {
          event_type: "repository.profile_created",
          application_id: applicationA.id,
          repository_id: repositoryA.id,
        },
      ],
    );
    const activeV1ObservationRows = await owner`
      select exists (
        select 1
          from bakery.repository_profile_observations
         where organization_id = ${organizationAId} and profile_id = ${profileA.id}
      ) as has_observation`;
    assertEquals(activeV1ObservationRows[0]?.has_observation, false);
    const alternateV1Config = {
      ...profileConfig,
      branches: { base: "develop", allowedPatterns: ["feature/*"] },
    };
    const alternateV1Digest = await digestFor(alternateV1Config);
    const beforeV1Branch = await owner`
      select default_branch, active_profile_id, version
        from bakery.repositories where id = ${repositoryA.id}`;
    const v1BranchChange = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { defaultBranch: "develop" },
      `"${beforeV1Branch[0]?.version}"`,
    );
    assertEquals(v1BranchChange.status, 200);
    const v1BranchBody = await v1BranchChange.json() as {
      activeProfileId: string | null;
      defaultBranch: string;
    };
    assertEquals(v1BranchBody.defaultBranch, "develop");
    assertEquals(v1BranchBody.activeProfileId, profileA.id);
    const alternateV1Response = await send(
      "POST",
      `/v1/repositories/${repositoryA.id}/profiles`,
      organizationAId,
      {
        revision: 2,
        config: alternateV1Config,
        digest: alternateV1Digest,
      },
    );
    assertEquals(alternateV1Response.status, 201);
    const alternateV1Profile = await alternateV1Response.json() as {
      id: string;
    };
    const afterAlternateV1Publication = await owner`
      select default_branch, active_profile_id, version
        from bakery.repositories where id = ${repositoryA.id}`;
    assertEquals(afterAlternateV1Publication[0]?.default_branch, "develop");
    assertEquals(
      afterAlternateV1Publication[0]?.active_profile_id,
      alternateV1Profile.id,
    );
    const restoreMain = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { defaultBranch: "main" },
      `"${afterAlternateV1Publication[0]?.version}"`,
    );
    assertEquals(restoreMain.status, 200);
    const restoreMainBody = await restoreMain.json() as {
      defaultBranch: string;
    };
    assertEquals(restoreMainBody.defaultBranch, "main");

    principal = principalB;
    const profileBResponse = await send(
      "POST",
      `/v1/repositories/${repositoryB.id}/profiles`,
      organizationBId,
      {
        revision: 1,
        config: profileConfig,
        digest: await digestFor(profileConfig),
      },
    );
    assertEquals(profileBResponse.status, 201);
    const profileB = await profileBResponse.json() as { id: string };

    const archivedRepository = await send(
      "PATCH",
      `/v1/repositories/${repositoryB.id}`,
      organizationBId,
      { archivedAt: "2026-09-27T00:00:00.000Z" },
      '"2"',
    );
    assertEquals(archivedRepository.status, 200);
    const profileWhileArchived = await send(
      "POST",
      `/v1/repositories/${repositoryB.id}/profiles`,
      organizationBId,
      {
        revision: 2,
        config: profileConfig,
        digest: await digestFor(profileConfig),
      },
    );
    assertEquals(profileWhileArchived.status, 409);
    const unarchivedRepository = await send(
      "PATCH",
      `/v1/repositories/${repositoryB.id}`,
      organizationBId,
      { archivedAt: null },
      '"3"',
    );
    assertEquals(unarchivedRepository.status, 200);

    principal = principalA;
    const staleSelection = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { activeProfileId: profileA.id },
      '"1"',
    );
    assertEquals(staleSelection.status, 412);

    const beforeMismatchedProfile = await owner`
      select active_profile_id, default_branch, version
        from bakery.repositories where id = ${repositoryA.id}`;
    const mismatchedProfileBranch = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { defaultBranch: "develop", activeProfileId: profileA.id },
      `"${beforeMismatchedProfile[0]?.version}"`,
    );
    assertEquals(mismatchedProfileBranch.status, 422);
    const afterMismatchedProfile = await owner`
      select active_profile_id, default_branch, version
        from bakery.repositories where id = ${repositoryA.id}`;
    assertEquals(afterMismatchedProfile[0], beforeMismatchedProfile[0]);

    const profileADigest = await digestFor(profileConfig);
    await owner`
      update bakery.repository_profiles
         set digest = ${"0".repeat(64)}
       where id = ${profileA.id}`;
    const tamperedDigest = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { activeProfileId: profileA.id },
      `"${beforeMismatchedProfile[0]?.version}"`,
    );
    assertEquals(tamperedDigest.status, 422);
    await owner`
      update bakery.repository_profiles
         set digest = ${profileADigest}
       where id = ${profileA.id}`;

    const v2Config = {
      schemaVersion: 2,
      branches: { base: "main", allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
      checkPolicy: { checks: [], hostRequirements: {} },
    };
    const v2ProfileId = crypto.randomUUID();
    const blockedProfileId = crypto.randomUUID();
    const eligibleObservationId = crypto.randomUUID();
    const blockedObservationId = crypto.randomUUID();
    const v2Digest = await digestFor(v2Config);
    const eligibleObservationDigest = await digestFor({
      readiness: "eligible",
    });
    const blockedObservationDigest = await digestFor({ readiness: "blocked" });
    const mappingDigest = "1".repeat(64);
    const baseSha = "a".repeat(40);
    const wrongDefaultV1Publication = await send(
      "POST",
      `/v1/repositories/${repositoryA.id}/profiles`,
      organizationAId,
      {
        revision: 3,
        config: alternateV1Config,
        digest: alternateV1Digest,
      },
    );
    assertEquals(wrongDefaultV1Publication.status, 422);
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, application_id, repository_id, revision,
        config, digest, created_by
      ) values (
        ${v2ProfileId}, ${organizationAId}, ${applicationA.id}, ${repositoryA.id},
        3, ${owner.json(v2Config)}, ${v2Digest}, ${principalAId}
      )`;
    await owner`
      insert into bakery.repository_profile_observations (
        id, organization_id, application_id, repository_id, profile_id,
        profile_revision, profile_digest, observation_digest, observed_at,
        source_mapping_revision, source_mapping_digest, base_sha, payload,
        readiness
      ) values (
        ${eligibleObservationId}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, ${v2ProfileId}, 3, ${v2Digest},
        ${eligibleObservationDigest}, now(), 1, ${mappingDigest}, ${baseSha},
        ${owner.json({ readiness: "eligible" })}, 'eligible'
      )`;
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, application_id, repository_id, revision,
        config, digest, created_by
      ) values (
        ${blockedProfileId}, ${organizationAId}, ${applicationA.id}, ${repositoryA.id},
        4, ${owner.json(v2Config)}, ${v2Digest}, ${principalAId}
      )`;
    await owner`
      insert into bakery.repository_profile_observations (
        id, organization_id, application_id, repository_id, profile_id,
        profile_revision, profile_digest, observation_digest, observed_at,
        source_mapping_revision, source_mapping_digest, base_sha, payload,
        readiness
      ) values (
        ${blockedObservationId}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, ${blockedProfileId}, 4, ${v2Digest},
        ${blockedObservationDigest}, now(), 1, ${mappingDigest}, ${baseSha},
        ${owner.json({ readiness: "blocked" })}, 'blocked'
      )`;

    const otherRepositoryId = crypto.randomUUID();
    await owner`
      insert into bakery.repositories (
        id, organization_id, application_id, slug,
        integration_connection_id, provider_repo_id, owner, name,
        default_branch
      ) values (
        ${otherRepositoryId}, ${organizationAId}, ${applicationA.id}, 'other',
        ${crypto.randomUUID()}, 'provider/other', 'provider-owner',
        'other', 'main'
      )`;

    const identityProfileId = crypto.randomUUID();
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, application_id, repository_id, revision,
        config, digest, created_by
      ) values (
        ${identityProfileId}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, 5, ${owner.json(v2Config)}, ${v2Digest},
        ${principalAId}
      )`;

    const observedVersionRows = await owner`
      update bakery.repositories
         set active_profile_id = ${v2ProfileId}, version = version + 1
       where id = ${repositoryA.id}
       returning version`;
    const observedVersion = observedVersionRows[0]?.version;
    const downgradeObserved = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { activeProfileId: profileA.id },
      `"${observedVersion}"`,
    );
    assertEquals(downgradeObserved.status, 422);
    const branchChangeObserved = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { defaultBranch: "develop" },
      `"${observedVersion}"`,
    );
    assertEquals(branchChangeObserved.status, 422);
    const afterObservedRejection = await owner`
      select active_profile_id, version from bakery.repositories
       where id = ${repositoryA.id}`;
    assertEquals(afterObservedRejection[0]?.active_profile_id, v2ProfileId);
    assertEquals(afterObservedRejection[0]?.version, observedVersion);
    await owner`
      update bakery.repositories
         set active_profile_id = ${profileA.id}, version = version + 1
       where id = ${repositoryA.id}`;

    const beforeManualActivation = await owner`
      select active_profile_id, version from bakery.repositories where id = ${repositoryA.id}`;
    const eligibleManualActivation = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { activeProfileId: v2ProfileId },
      `"${beforeManualActivation[0]?.version}"`,
    );
    assertEquals(eligibleManualActivation.status, 422);
    const blockedManualActivation = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { activeProfileId: blockedProfileId },
      `"${beforeManualActivation[0]?.version}"`,
    );
    assertEquals(blockedManualActivation.status, 422);
    const foreignManualActivation = await send(
      "PATCH",
      `/v1/repositories/${repositoryA.id}`,
      organizationAId,
      { activeProfileId: profileB.id },
      `"${beforeManualActivation[0]?.version}"`,
    );
    assertEquals(foreignManualActivation.status, 422);

    const afterManualActivation = await owner`
      select active_profile_id, version from bakery.repositories where id = ${repositoryA.id}`;
    assertEquals(afterManualActivation[0]?.active_profile_id, profileA.id);
    assertEquals(
      afterManualActivation[0]?.version,
      beforeManualActivation[0]?.version,
    );

    const duplicateObservationError = await assertRejects(() =>
      owner`
        insert into bakery.repository_profile_observations (
          id, organization_id, application_id, repository_id, profile_id,
          profile_revision, profile_digest, observation_digest, observed_at,
          source_mapping_revision, source_mapping_digest, base_sha, payload,
          readiness
        ) values (
          ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
          ${repositoryA.id}, ${v2ProfileId}, 3, ${v2Digest},
          ${eligibleObservationDigest}, now(), 1, ${mappingDigest}, ${baseSha},
          ${owner.json({ readiness: "eligible" })}, 'eligible'
        )`
    );
    assertEquals(errorCode(duplicateObservationError), "23505");

    const wrongRepositoryObservationError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.repository_profile_observations (
            id, organization_id, application_id, repository_id, profile_id,
            profile_revision, profile_digest, observation_digest, observed_at,
            source_mapping_revision, source_mapping_digest, base_sha, payload,
            readiness
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
            ${otherRepositoryId}, ${identityProfileId}, 5, ${v2Digest},
            ${eligibleObservationDigest}, now(), 1, ${mappingDigest}, ${baseSha},
            ${owner.json({ readiness: "eligible" })}, 'eligible'
          )`;
      })
    );

    assertEquals(errorCode(wrongRepositoryObservationError), "23503");
    assertEquals(
      errorConstraintName(wrongRepositoryObservationError),
      "repository_profile_observations_profile_identity_fk",
    );

    const wrongRevisionObservationError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.repository_profile_observations (
            id, organization_id, application_id, repository_id, profile_id,
            profile_revision, profile_digest, observation_digest, observed_at,
            source_mapping_revision, source_mapping_digest, base_sha, payload,
            readiness
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
            ${repositoryA.id}, ${identityProfileId}, 6, ${v2Digest},
            ${eligibleObservationDigest}, now(), 1, ${mappingDigest}, ${baseSha},
            ${owner.json({ readiness: "eligible" })}, 'eligible'
          )`;
      })
    );

    assertEquals(errorCode(wrongRevisionObservationError), "23503");
    assertEquals(
      errorConstraintName(wrongRevisionObservationError),
      "repository_profile_observations_profile_identity_fk",
    );
    const wrongProfileDigestObservationError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.repository_profile_observations (
            id, organization_id, application_id, repository_id, profile_id,
            profile_revision, profile_digest, observation_digest, observed_at,
            source_mapping_revision, source_mapping_digest, base_sha, payload,
            readiness
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
            ${repositoryA.id}, ${identityProfileId}, 5, ${"0".repeat(64)},
            ${eligibleObservationDigest}, now(), 1, ${mappingDigest}, ${baseSha},
            ${owner.json({ readiness: "eligible" })}, 'eligible'
          )`;
      })
    );

    assertEquals(errorCode(wrongProfileDigestObservationError), "23503");
    assertEquals(
      errorConstraintName(wrongProfileDigestObservationError),
      "repository_profile_observations_profile_identity_fk",
    );

    const oversizedObservationPayload = Array.from(
      { length: 2048 },
      () => crypto.randomUUID(),
    );
    const oversizedObservationError = await assertRejects(() =>
      owner`
        insert into bakery.repository_profile_observations (
          id, organization_id, application_id, repository_id, profile_id,
          profile_revision, profile_digest, observation_digest, observed_at,
          source_mapping_revision, source_mapping_digest, base_sha, payload,
          readiness
        ) values (
          ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
          ${repositoryA.id}, ${identityProfileId}, 5, ${v2Digest},
          ${"2".repeat(64)}, now(), 1, ${mappingDigest}, ${baseSha},
          ${owner.json({ values: oversizedObservationPayload })}, 'eligible'
        )`
    );
    assertEquals(errorCode(oversizedObservationError), "23514");

    const copiedCompressibleObservationError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          create temporary table phase1_oversized_payload (
            payload jsonb not null
          ) on commit drop`;
        await transaction`
          insert into phase1_oversized_payload (payload)
          values (${owner.json({ values: "x".repeat(70_000) })})`;
        const stagedPayloadRows = await transaction<{
          textLength: number;
          physicalSize: number;
        }[]>`
          select octet_length(payload::text) as "textLength",
                 pg_column_size(payload) as "physicalSize"
            from phase1_oversized_payload`;
        assertEquals(stagedPayloadRows[0]?.textLength > 65_536, true);
        assertEquals(stagedPayloadRows[0]?.physicalSize <= 65_536, true);
        await transaction`
          insert into bakery.repository_profile_observations (
            id, organization_id, application_id, repository_id, profile_id,
            profile_revision, profile_digest, observation_digest, observed_at,
            source_mapping_revision, source_mapping_digest, base_sha, payload,
            readiness
          )
          select ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
            ${repositoryA.id}, ${identityProfileId}, 5, ${v2Digest},
            ${"3".repeat(64)}, now(), 1, ${mappingDigest}, ${baseSha},
            payload, 'eligible'
            from phase1_oversized_payload`;
      })
    );
    assertEquals(errorCode(copiedCompressibleObservationError), "23514");

    const appUpdateObservationError = await assertRejects(() =>
      appPg.query(
        `update bakery.repository_profile_observations
            set payload = payload
          where organization_id = $1 and id = $2`,
        [organizationAId, eligibleObservationId],
      )
    );
    assertEquals(errorCode(appUpdateObservationError), "42501");
    const appDeleteObservationError = await assertRejects(() =>
      appPg.query(
        `delete from bakery.repository_profile_observations
          where organization_id = $1 and id = $2`,
        [organizationAId, eligibleObservationId],
      )
    );
    assertEquals(errorCode(appDeleteObservationError), "42501");

    const foreignBindingError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.repository_role_bindings (
            organization_id, application_id, repository_id, role, alias
          ) values (
            ${organizationAId}, ${applicationA.id}, ${repositoryB.id},
            'source', 'foreign'
          )`;
      })
    );
    assertEquals(errorCode(foreignBindingError), "23503");
    assertEquals(
      errorConstraintName(foreignBindingError),
      "repository_role_bindings_repository_fk",
    );
    const invalidProvenanceError = await assertRejects(() =>
      owner`
        insert into bakery.repository_role_bindings (
          organization_id, application_id, repository_id, role, provenance
        ) values (
          ${organizationAId}, ${applicationA.id}, ${repositoryA.id},
          'source-invalid-provenance', ${"p".repeat(201)}
        )`
    );
    assertEquals(errorCode(invalidProvenanceError), "23514");
    await owner`
      insert into bakery.repository_role_bindings (
        id, organization_id, application_id, repository_id, role, alias
      ) values (
        ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, 'source', 'primary'
      )`;

    const pinBaseSha = baseSha;
    const completeTaskId = crypto.randomUUID();
    const completeConversationId = crypto.randomUUID();
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, repository_id, title, created_by
      ) values (
        ${completeConversationId}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, 'Complete pin task', ${principalAId}
      )`;
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, repository_id, conversation_id,
        title, description, task_type, status, priority, created_by,
        repository_profile_id, repository_profile_revision,
        repository_profile_digest, observation_id, observation_digest, base_sha
      ) values (
        ${completeTaskId}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, ${completeConversationId}, 'Complete pin task',
        '', 'feature', 'draft', 50, ${principalAId}, ${v2ProfileId}, 3,
        ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
        ${pinBaseSha}
      )`;
    const v1TaskId = crypto.randomUUID();
    const v1ConversationId = crypto.randomUUID();
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, repository_id, title, created_by
      ) values (
        ${v1ConversationId}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, 'Unobserved v1 task', ${principalAId}
      )`;
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, repository_id, conversation_id,
        title, description, task_type, status, priority, created_by,
        repository_profile_id, repository_profile_revision,
        repository_profile_digest, observation_id, observation_digest, base_sha
      ) values (
        ${v1TaskId}, ${organizationAId}, ${applicationA.id}, ${repositoryA.id},
        ${v1ConversationId}, 'Unobserved v1 task', '', 'feature', 'draft', 50,
        ${principalAId}, ${profileA.id}, 1, ${profileADigest}, null, null, null
      )`;
    let observationDeleteCallbackCompleted = false;
    const observationDeleteError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          delete from bakery.repository_profile_observations
           where organization_id = ${organizationAId}
             and id = ${eligibleObservationId}`;
        observationDeleteCallbackCompleted = true;
      })
    );
    assertEquals(observationDeleteCallbackCompleted, true);
    assertEquals(errorCode(observationDeleteError), "23503");
    assertEquals(
      errorConstraintName(observationDeleteError),
      "tasks_observation_pin_fk",
    );

    let profileDeleteCallbackCompleted = false;
    const profileDeleteError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          delete from bakery.repository_profiles
           where organization_id = ${organizationAId}
             and id = ${v2ProfileId}`;
        profileDeleteCallbackCompleted = true;
      })
    );
    assertEquals(profileDeleteCallbackCompleted, false);
    assertEquals(errorCode(profileDeleteError), "23503");
    assertEquals(
      errorConstraintName(profileDeleteError),
      "tasks_repository_profile_fk",
    );

    const retainedPin = await owner`
      select task.observation_id as task_observation_id,
             task.repository_profile_id as task_profile_id,
             observation.id as observation_row_id,
             profile.id as profile_row_id
        from bakery.tasks as task
        join bakery.repository_profile_observations as observation
          on observation.organization_id = task.organization_id
         and observation.id = task.observation_id
        join bakery.repository_profiles as profile
          on profile.organization_id = task.organization_id
         and profile.id = task.repository_profile_id
       where task.id = ${completeTaskId}`;
    assertEquals(retainedPin.length, 1);
    assertEquals(
      retainedPin[0]?.task_observation_id,
      eligibleObservationId,
    );
    assertEquals(retainedPin[0]?.task_profile_id, v2ProfileId);
    assertEquals(retainedPin[0]?.observation_row_id, eligibleObservationId);
    assertEquals(retainedPin[0]?.profile_row_id, v2ProfileId);

    const wrongTaskProfileDigestError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.tasks (
            id, organization_id, application_id, repository_id, conversation_id,
            title, description, task_type, status, priority, created_by,
            repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
            ${repositoryA.id}, ${completeConversationId}, 'Wrong task profile digest',
            '', 'feature', 'draft', 50, ${principalAId}, ${v2ProfileId}, 3,
            ${"0".repeat(64)}, ${eligibleObservationId},
            ${eligibleObservationDigest}, ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(wrongTaskProfileDigestError), "23503");
    assertEquals(
      errorConstraintName(wrongTaskProfileDigestError),
      "tasks_repository_profile_identity_fk",
    );

    const wrongTaskObservationDigestError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.tasks (
            id, organization_id, application_id, repository_id, conversation_id,
            title, description, task_type, status, priority, created_by,
            repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
            ${repositoryA.id}, ${completeConversationId},
            'Wrong task observation digest', '', 'feature', 'draft', 50,
            ${principalAId}, ${v2ProfileId}, 3, ${v2Digest},
            ${eligibleObservationId}, ${"1".repeat(64)}, ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(wrongTaskObservationDigestError), "23503");
    assertEquals(
      errorConstraintName(wrongTaskObservationDigestError),
      "tasks_observation_pin_fk",
    );

    const wrongTaskBaseShaError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.tasks (
            id, organization_id, application_id, repository_id, conversation_id,
            title, description, task_type, status, priority, created_by,
            repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
            ${repositoryA.id}, ${completeConversationId}, 'Wrong task base SHA',
            '', 'feature', 'draft', 50, ${principalAId}, ${v2ProfileId}, 3,
            ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
            ${"f".repeat(40)}
          )`;
      })
    );
    assertEquals(errorCode(wrongTaskBaseShaError), "23503");
    assertEquals(
      errorConstraintName(wrongTaskBaseShaError),
      "tasks_observation_pin_fk",
    );

    const partialTaskId = crypto.randomUUID();
    const partialConversationId = crypto.randomUUID();
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, repository_id, title, created_by
      ) values (
        ${partialConversationId}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, 'Partial pin task', ${principalAId}
      )`;
    const partialProfileTaskError = await assertRejects(() =>
      owner`
        insert into bakery.tasks (
          id, organization_id, application_id, repository_id, conversation_id,
          title, description, task_type, status, priority, created_by,
          repository_profile_id, repository_profile_revision,
          repository_profile_digest, observation_id, observation_digest,
          base_sha
        ) values (
          ${crypto.randomUUID()}, ${organizationAId}, ${applicationA.id},
          ${repositoryA.id}, ${partialConversationId}, 'Partial profile task',
          '', 'feature', 'draft', 50, ${principalAId}, ${v2ProfileId}, null,
          null, null, null, null
        )`
    );
    assertEquals(errorCode(partialProfileTaskError), "23514");
    assertEquals(
      errorConstraintName(partialProfileTaskError),
      "tasks_profile_pin_complete",
    );
    const partialTaskError = await assertRejects(() =>
      owner`
        insert into bakery.tasks (
          id, organization_id, application_id, repository_id, conversation_id,
          title, description, task_type, status, priority, created_by,
          repository_profile_id, repository_profile_revision,
          repository_profile_digest, observation_id, observation_digest,
          base_sha
        ) values (
          ${partialTaskId}, ${organizationAId}, ${applicationA.id},
          ${repositoryA.id}, ${partialConversationId}, 'Partial pin task',
          '', 'feature', 'draft', 50, ${principalAId}, ${v2ProfileId}, 3,
          ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
          null
        )`
    );
    assertEquals(errorCode(partialTaskError), "23514");
    assertEquals(
      errorConstraintName(partialTaskError),
      "tasks_observation_pin_complete",
    );

    const mismatchedTaskId = crypto.randomUUID();
    const mismatchedConversationId = crypto.randomUUID();
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, repository_id, title, created_by
      ) values (
        ${mismatchedConversationId}, ${organizationAId}, ${applicationA.id},
        ${repositoryA.id}, 'Mismatched pin task', ${principalAId}
      )`;
    const mismatchedTaskError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.tasks (
            id, organization_id, application_id, repository_id, conversation_id,
            title, description, task_type, status, priority, created_by,
            repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest,
            base_sha
          ) values (
            ${mismatchedTaskId}, ${organizationAId}, ${applicationA.id},
            ${repositoryA.id}, ${mismatchedConversationId}, 'Mismatched pin task',
            '', 'feature', 'draft', 50, ${principalAId}, ${blockedProfileId}, 4,
            ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
            ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(mismatchedTaskError), "23503");
    assertEquals(
      errorConstraintName(mismatchedTaskError),
      "tasks_observation_pin_fk",
    );

    const workflowId = crypto.randomUUID();
    const workflowVersionId = crypto.randomUUID();
    await owner`
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name, description
      ) values (
        ${workflowId}, ${organizationAId}, 'pin-test', 'Pin test', ''
      )`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by
      ) values (
        ${workflowVersionId}, ${organizationAId}, ${workflowId}, 1, 'steps: []',
        ${owner.json({ steps: [] })}, ${"c".repeat(64)}, 'published',
        ${principalAId}
      )`;

    const completeRunId = crypto.randomUUID();
    await owner`
      insert into bakery.workflow_runs (
        id, organization_id, task_id, workflow_version_id,
        repository_profile_id, requested_by, status, snapshot, budget_limit_usd,
        application_id, repository_id, repository_profile_revision,
        repository_profile_digest, observation_id, observation_digest, base_sha
      ) values (
        ${completeRunId}, ${organizationAId}, ${completeTaskId},
        ${workflowVersionId}, ${v2ProfileId}, ${principalAId}, 'queued',
        ${owner.json({})}, 0, ${applicationA.id}, ${repositoryA.id}, 3,
        ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
        ${pinBaseSha}
      )`;
    const v1RunId = crypto.randomUUID();
    await owner`
      insert into bakery.workflow_runs (
        id, organization_id, task_id, workflow_version_id,
        repository_profile_id, requested_by, status, snapshot, budget_limit_usd,
        application_id, repository_id, repository_profile_revision,
        repository_profile_digest, observation_id, observation_digest, base_sha
      ) values (
        ${v1RunId}, ${organizationAId}, ${v1TaskId}, ${workflowVersionId},
        ${profileA.id}, ${principalAId}, 'queued', ${owner.json({})}, 0,
        ${applicationA.id}, ${repositoryA.id}, 1, ${profileADigest},
        null, null, null
      )`;
    const wrongRunProfileDigestError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.workflow_runs (
            id, organization_id, task_id, workflow_version_id,
            repository_profile_id, requested_by, status, snapshot, budget_limit_usd,
            application_id, repository_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${completeTaskId},
            ${workflowVersionId}, ${v2ProfileId}, ${principalAId}, 'queued',
            ${owner.json({})}, 0, ${applicationA.id}, ${repositoryA.id}, 3,
            ${"0".repeat(64)}, ${eligibleObservationId},
            ${eligibleObservationDigest}, ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(wrongRunProfileDigestError), "23503");
    assertEquals(
      errorConstraintName(wrongRunProfileDigestError),
      "workflow_runs_repository_profile_identity_fk",
    );

    const wrongRunObservationDigestError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.workflow_runs (
            id, organization_id, task_id, workflow_version_id,
            repository_profile_id, requested_by, status, snapshot, budget_limit_usd,
            application_id, repository_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${completeTaskId},
            ${workflowVersionId}, ${v2ProfileId}, ${principalAId}, 'queued',
            ${owner.json({})}, 0, ${applicationA.id}, ${repositoryA.id}, 3,
            ${v2Digest}, ${eligibleObservationId}, ${"1".repeat(64)},
            ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(wrongRunObservationDigestError), "23503");
    assertEquals(
      errorConstraintName(wrongRunObservationDigestError),
      "workflow_runs_observation_pin_fk",
    );

    const wrongRunBaseShaError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.workflow_runs (
            id, organization_id, task_id, workflow_version_id,
            repository_profile_id, requested_by, status, snapshot, budget_limit_usd,
            application_id, repository_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${completeTaskId},
            ${workflowVersionId}, ${v2ProfileId}, ${principalAId}, 'queued',
            ${owner.json({})}, 0, ${applicationA.id}, ${repositoryA.id}, 3,
            ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
            ${"f".repeat(40)}
          )`;
      })
    );
    assertEquals(errorCode(wrongRunBaseShaError), "23503");
    assertEquals(
      errorConstraintName(wrongRunBaseShaError),
      "workflow_runs_observation_pin_fk",
    );

    const partialProfileRunError = await assertRejects(() =>
      owner`
        insert into bakery.workflow_runs (
          id, organization_id, task_id, workflow_version_id,
          repository_profile_id, requested_by, status, snapshot, budget_limit_usd,
          application_id, repository_id, repository_profile_revision,
          repository_profile_digest, observation_id, observation_digest, base_sha
        ) values (
          ${crypto.randomUUID()}, ${organizationAId}, ${completeTaskId},
          ${workflowVersionId}, ${v2ProfileId}, ${principalAId}, 'queued',
          ${owner.json({})}, 0, ${applicationA.id}, ${repositoryA.id}, null,
          null, null, null, null
        )`
    );
    assertEquals(errorCode(partialProfileRunError), "23514");
    assertEquals(
      errorConstraintName(partialProfileRunError),
      "workflow_runs_repository_profile_identity_complete",
    );
    const partialRunId = crypto.randomUUID();
    const partialRunError = await assertRejects(() =>
      owner`
        insert into bakery.workflow_runs (
          id, organization_id, task_id, workflow_version_id,
          repository_profile_id, requested_by, status, snapshot, budget_limit_usd,
          application_id, repository_id, repository_profile_revision,
          repository_profile_digest, observation_id, observation_digest, base_sha
        ) values (
          ${partialRunId}, ${organizationAId}, ${completeTaskId},
          ${workflowVersionId}, ${v2ProfileId}, ${principalAId}, 'queued',
          ${owner.json({})}, 0, ${applicationA.id}, ${repositoryA.id}, 3,
          ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
          null
        )`
    );
    assertEquals(errorCode(partialRunError), "23514");
    assertEquals(
      errorConstraintName(partialRunError),
      "workflow_runs_observation_pin_complete",
    );

    const mismatchedRunError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.workflow_runs (
            id, organization_id, task_id, workflow_version_id,
            repository_profile_id, requested_by, status, snapshot, budget_limit_usd,
            application_id, repository_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${completeTaskId},
            ${workflowVersionId}, ${blockedProfileId}, ${principalAId}, 'queued',
            ${owner.json({})}, 0, ${applicationA.id}, ${repositoryA.id}, 4,
            ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
            ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(mismatchedRunError), "23503");
    assertEquals(
      errorConstraintName(mismatchedRunError),
      "workflow_runs_observation_pin_fk",
    );

    const completeRunStepId = crypto.randomUUID();
    await owner`
      insert into bakery.run_steps (
        id, organization_id, run_id, step_key, position, input
      ) values (
        ${completeRunStepId}, ${organizationAId}, ${completeRunId}, 'complete',
        0, ${owner.json({})}
      )`;
    const completeJobId = crypto.randomUUID();
    await owner`
      insert into bakery.jobs (
        id, organization_id, run_step_id, repository_id, action,
        application_id, repository_profile_id, repository_profile_revision,
        repository_profile_digest, observation_id, observation_digest, base_sha
      ) values (
        ${completeJobId}, ${organizationAId}, ${completeRunStepId},
        ${repositoryA.id}, 'complete', ${applicationA.id}, ${v2ProfileId}, 3,
        ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
        ${pinBaseSha}
      )`;
    const v1RunStepId = crypto.randomUUID();
    await owner`
      insert into bakery.run_steps (
        id, organization_id, run_id, step_key, position, input
      ) values (
        ${v1RunStepId}, ${organizationAId}, ${v1RunId}, 'v1', 0,
        ${owner.json({})}
      )`;
    const v1JobId = crypto.randomUUID();
    await owner`
      insert into bakery.jobs (
        id, organization_id, run_step_id, repository_id, action,
        application_id, repository_profile_id, repository_profile_revision,
        repository_profile_digest, observation_id, observation_digest, base_sha
      ) values (
        ${v1JobId}, ${organizationAId}, ${v1RunStepId}, ${repositoryA.id},
        'v1', ${applicationA.id}, ${profileA.id}, 1, ${profileADigest},
        null, null, null
      )`;
    const wrongJobProfileDigestError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.jobs (
            id, organization_id, run_step_id, repository_id, action,
            application_id, repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${completeRunStepId},
            ${repositoryA.id}, 'wrong-profile-digest', ${applicationA.id},
            ${v2ProfileId}, 3, ${"0".repeat(64)}, ${eligibleObservationId},
            ${eligibleObservationDigest}, ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(wrongJobProfileDigestError), "23503");
    assertEquals(
      errorConstraintName(wrongJobProfileDigestError),
      "jobs_repository_profile_identity_fk",
    );

    const wrongJobObservationDigestError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.jobs (
            id, organization_id, run_step_id, repository_id, action,
            application_id, repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${completeRunStepId},
            ${repositoryA.id}, 'wrong-observation-digest', ${applicationA.id},
            ${v2ProfileId}, 3, ${v2Digest}, ${eligibleObservationId},
            ${"1".repeat(64)}, ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(wrongJobObservationDigestError), "23503");
    assertEquals(
      errorConstraintName(wrongJobObservationDigestError),
      "jobs_observation_pin_fk",
    );

    const wrongJobBaseShaError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.jobs (
            id, organization_id, run_step_id, repository_id, action,
            application_id, repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${completeRunStepId},
            ${repositoryA.id}, 'wrong-base-sha', ${applicationA.id},
            ${v2ProfileId}, 3, ${v2Digest}, ${eligibleObservationId},
            ${eligibleObservationDigest}, ${"f".repeat(40)}
          )`;
      })
    );
    assertEquals(errorCode(wrongJobBaseShaError), "23503");
    assertEquals(
      errorConstraintName(wrongJobBaseShaError),
      "jobs_observation_pin_fk",
    );

    const partialRunStepId = crypto.randomUUID();
    const partialJobId = crypto.randomUUID();
    await owner`
      insert into bakery.run_steps (
        id, organization_id, run_id, step_key, position, input
      ) values (
        ${partialRunStepId}, ${organizationAId}, ${completeRunId}, 'partial',
        1, ${owner.json({})}
      )`;
    const partialProfileJobError = await assertRejects(() =>
      owner`
        insert into bakery.jobs (
          id, organization_id, run_step_id, repository_id, action,
          application_id, repository_profile_id, repository_profile_revision,
          repository_profile_digest, observation_id, observation_digest, base_sha
        ) values (
          ${crypto.randomUUID()}, ${organizationAId}, ${partialRunStepId},
          ${repositoryA.id}, 'partial-profile', ${applicationA.id},
          ${v2ProfileId}, null, null, null, null, null
        )`
    );
    assertEquals(errorCode(partialProfileJobError), "23514");
    assertEquals(
      errorConstraintName(partialProfileJobError),
      "jobs_repository_profile_identity_complete",
    );
    const partialJobError = await assertRejects(() =>
      owner`
        insert into bakery.jobs (
          id, organization_id, run_step_id, repository_id, action,
          application_id, repository_profile_id, repository_profile_revision,
          repository_profile_digest, observation_id, observation_digest, base_sha
        ) values (
          ${partialJobId}, ${organizationAId}, ${partialRunStepId},
          ${repositoryA.id}, 'partial', ${applicationA.id}, ${v2ProfileId}, 3,
          ${v2Digest}, ${eligibleObservationId}, ${eligibleObservationDigest},
          null
        )`
    );
    assertEquals(errorCode(partialJobError), "23514");
    assertEquals(
      errorConstraintName(partialJobError),
      "jobs_observation_pin_complete",
    );

    const mismatchedRunStepId = crypto.randomUUID();
    await owner`
      insert into bakery.run_steps (
        id, organization_id, run_id, step_key, position, input
      ) values (
        ${mismatchedRunStepId}, ${organizationAId}, ${completeRunId},
        'mismatched', 2, ${owner.json({})}
      )`;
    const mismatchedJobError = await assertRejects(() =>
      owner.begin(async (transaction) => {
        await transaction`
          insert into bakery.jobs (
            id, organization_id, run_step_id, repository_id, action,
            application_id, repository_profile_id, repository_profile_revision,
            repository_profile_digest, observation_id, observation_digest, base_sha
          ) values (
            ${crypto.randomUUID()}, ${organizationAId}, ${mismatchedRunStepId},
            ${repositoryA.id}, 'mismatched', ${applicationA.id},
            ${blockedProfileId}, 4, ${v2Digest}, ${eligibleObservationId},
            ${eligibleObservationDigest}, ${pinBaseSha}
          )`;
      })
    );
    assertEquals(errorCode(mismatchedJobError), "23503");
    assertEquals(
      errorConstraintName(mismatchedJobError),
      "jobs_observation_pin_fk",
    );

    const completePinRows = await owner`
      select
        (select base_sha from bakery.tasks where id = ${completeTaskId}) as task_base_sha,
        (select base_sha from bakery.workflow_runs where id = ${completeRunId}) as run_base_sha,
        (select base_sha from bakery.jobs where id = ${completeJobId}) as job_base_sha`;
    assertEquals(completePinRows[0]?.task_base_sha, pinBaseSha);
    assertEquals(completePinRows[0]?.run_base_sha, pinBaseSha);
    assertEquals(completePinRows[0]?.job_base_sha, pinBaseSha);
    const unobservedV1PinRows = await owner`
      select
        (select repository_profile_id from bakery.tasks where id = ${v1TaskId})
          as task_profile_id,
        (select repository_profile_revision from bakery.tasks where id = ${v1TaskId})
          as task_profile_revision,
        (select repository_profile_digest from bakery.tasks where id = ${v1TaskId})
          as task_profile_digest,
        (select observation_id from bakery.tasks where id = ${v1TaskId})
          as task_observation_id,
        (select repository_profile_id from bakery.workflow_runs where id = ${v1RunId})
          as run_profile_id,
        (select repository_profile_revision from bakery.workflow_runs where id = ${v1RunId})
          as run_profile_revision,
        (select repository_profile_digest from bakery.workflow_runs where id = ${v1RunId})
          as run_profile_digest,
        (select observation_id from bakery.workflow_runs where id = ${v1RunId})
          as run_observation_id,
        (select repository_profile_id from bakery.jobs where id = ${v1JobId})
          as job_profile_id,
        (select repository_profile_revision from bakery.jobs where id = ${v1JobId})
          as job_profile_revision,
        (select repository_profile_digest from bakery.jobs where id = ${v1JobId})
          as job_profile_digest,
        (select observation_id from bakery.jobs where id = ${v1JobId})
          as job_observation_id`;
    assertEquals(unobservedV1PinRows[0], {
      task_profile_id: profileA.id,
      task_profile_revision: 1,
      task_profile_digest: profileADigest,
      task_observation_id: null,
      run_profile_id: profileA.id,
      run_profile_revision: 1,
      run_profile_digest: profileADigest,
      run_observation_id: null,
      job_profile_id: profileA.id,
      job_profile_revision: 1,
      job_profile_digest: profileADigest,
      job_observation_id: null,
    });
    await owner.begin(async (transaction) => {
      await transaction`
        delete from bakery.organizations where id = ${organizationAId}`;
    });
    const organizationACascadeRows = await owner`
      select
        not exists (
          select 1 from bakery.repository_profile_observations
           where organization_id = ${organizationAId}
        ) as observations_gone,
        not exists (
          select 1 from bakery.repository_role_bindings
           where organization_id = ${organizationAId}
        ) as role_bindings_gone,
        not exists (
          select 1 from bakery.tasks where organization_id = ${organizationAId}
        ) as tasks_gone,
        not exists (
          select 1 from bakery.workflow_runs
           where organization_id = ${organizationAId}
        ) as runs_gone,
        not exists (
          select 1 from bakery.jobs where organization_id = ${organizationAId}
        ) as jobs_gone`;
    assertEquals(organizationACascadeRows[0], {
      observations_gone: true,
      role_bindings_gone: true,
      tasks_gone: true,
      runs_gone: true,
      jobs_gone: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

Deno.test(
  "Workflow admission preserves strict-v1/cloud-only pins and rejects malformed or unpublished observed tuples",
  async () => {
    const fixture = await migrateTestDatabase();
    const { owner, appPg, legacyJob } = fixture;
    const workflowId = crypto.randomUUID();
    const workflowVersionId = crypto.randomUUID();
    const workflowSpec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "issue-46-admit",
      steps: [{
        id: "step_1",
        uses: "quality.check",
        with: {
          repositoryId: "$task.repositoryId",
          revision: "$input.message",
          checks: ["source.integrity"],
        },
      }],
    };
    const workflowDigest = await digestFor(workflowSpec);
    const profileDigest = await digestFor(profileConfig);
    const now = new Date("2026-09-27T00:00:00.000Z");
    let secondAppPg: PgDatabase | undefined;
    try {
      const databaseRows = await owner`
        select current_database() as "databaseName"
      `;
      const databaseName = databaseRows[0]?.databaseName;
      if (!databaseName) throw new Error("CURRENT_DATABASE_MISSING");
      const isolatedAppUrl = new URL(appDatabaseUrl);
      isolatedAppUrl.pathname = `/${databaseName}`;
      secondAppPg = openPgDatabase(isolatedAppUrl.toString(), 1);
      await owner`
        insert into bakery.workflow_definitions (
          id, organization_id, slug, name, description
        ) values (
          ${workflowId}, ${legacyJob.organizationId}, 'issue-46-admit',
          'Issue 46 Admit', ''
        )`;
      await owner`
        insert into bakery.workflow_versions (
          id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by
        ) values (
          ${workflowVersionId}, ${legacyJob.organizationId}, ${workflowId},
          1, '', ${owner.json(workflowSpec)}, ${workflowDigest}, 'published',
          ${legacyJob.principalId}
        )`;
      await owner`
        update bakery.workflow_definitions
           set active_version_id = ${workflowVersionId}
         where organization_id = ${legacyJob.organizationId}
           and id = ${workflowId}`;

      const principal = {
        principalId: legacyJob.principalId,
        principalType: "human" as const,
        displayName: "Legacy Job",
      };
      const authorityRunner = new PostgresAuthorityRunner(appPg);
      const tasksApi = createApiRouter({
        registry: createTaskActionRegistry(
          createWorkTaskHandlers("issue-46-admit-secret"),
          {
            authorityRunner,
            commandRunner: createPostgresCommandRunner(),
          },
        ),
        createContext: () => ({ principal }),
      });
      const projectsApi = createApiRouter({
        registry: createProjectsActionRegistry(
          createProjectsHandlers("issue-46-admit-secret"),
          {
            authorityRunner,
            commandRunner: createPostgresCommandRunner(),
          },
        ),
        createContext: () => ({ principal }),
      });
      let commandNumber = 0;
      const request = async (
        app: Hono,
        method: string,
        path: string,
        body?: unknown,
        ifMatch?: string,
      ): Promise<Response> => {
        const headers: Record<string, string> = {
          "Bakery-Organization-Id": legacyJob.organizationId,
        };
        if (method !== "GET") {
          headers["Idempotency-Key"] = `issue46-admit-${commandNumber++}`;
        }
        if (body !== undefined) headers["content-type"] = "application/json";
        if (ifMatch !== undefined) headers["If-Match"] = ifMatch;
        return await app.fetch(
          new Request(`http://issue-46.test${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
      };

      const apiTaskResponse = await request(tasksApi, "POST", "/v1/tasks", {
        applicationId: legacyJob.applicationId,
        repositoryId: legacyJob.repositoryId,
        title: "Issue 46 API admission",
        description: "",
        taskType: "feature",
      });
      assertEquals(apiTaskResponse.status, 201);
      const apiTask = await apiTaskResponse.json() as { id: string };
      const apiRunResponse = await request(
        tasksApi,
        "POST",
        `/v1/tasks/${apiTask.id}/runs`,
        {
          workflowVersionId,
          repositoryProfileId: legacyJob.profileId,
          executionMode: "repository",
          budgetLimitUsd: "0.005000",
          inputs: { message: "from-api-snapshot" },
        },
      );
      assertEquals(apiRunResponse.status, 201);
      const apiRun = await apiRunResponse.json() as { id: string };
      const apiRequestEvents = await owner`
        select event_type, aggregate_id, payload
          from bakery.domain_events
         where organization_id = ${legacyJob.organizationId}
           and aggregate_id = ${apiRun.id}
           and event_type = 'run.requested'
      `;
      assertEquals(apiRequestEvents.length, 1);
      assertEquals(apiRequestEvents[0], {
        event_type: "run.requested",
        aggregate_id: apiRun.id,
        payload: { runId: apiRun.id },
      });

      const repository = createBakeryPostgresWorkflowRepository({
        database: appPg,
        maxAttempts: 3,
      });
      const concurrentRepository = createBakeryPostgresWorkflowRepository({
        database: secondAppPg,
        maxAttempts: 3,
      });
      const logical = await repository.findNext(apiRun.id);
      if (!logical) throw new Error("API_RUN_LOGICAL_KEY_MISSING");
      assertEquals(
        logical,
        {
          runId: apiRun.id,
          stepKey: "step_1",
          iteration: 0,
          actionVersion: workflowVersionId,
        } satisfies LogicalInvocationKey,
      );
      const apiOwner = await repository.acquireEngineOwner(
        apiRun.id,
        "issue46-api-admit-owner",
        60_000,
      );
      if (!apiOwner) throw new Error("API_RUN_OWNER_MISSING");
      const apiAdmissions = await Promise.all([
        repository.admit(logical, apiOwner),
        concurrentRepository.admit(logical, apiOwner),
      ]);
      assertEquals(apiAdmissions.map((admission) => admission.terminal), [
        false,
        false,
      ]);
      assertEquals(
        apiAdmissions[0]?.jobId,
        apiAdmissions[1]?.jobId,
      );
      const apiJobs = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          repository_profile_id as "profileId",
          repository_profile_revision as "profileRevision",
          repository_profile_digest as "profileDigest",
          observation_id as "observationId",
          observation_digest as "observationDigest",
          base_sha as "baseSha",
          action, input, status, max_attempts as "maxAttempts"
          from bakery.jobs
         where organization_id = ${legacyJob.organizationId}
           and run_step_id in (
             select id from bakery.run_steps
              where organization_id = ${legacyJob.organizationId}
                and run_id = ${apiRun.id}
           )
      `;
      assertEquals(apiJobs.length, 1);
      const apiJob = apiJobs[0];
      if (!apiJob) throw new Error("API_JOB_MISSING");
      const { id: apiJobId, ...apiJobPins } = apiJob;
      assertEquals(apiJobPins, {
        applicationId: legacyJob.applicationId,
        repositoryId: legacyJob.repositoryId,
        profileId: legacyJob.profileId,
        profileRevision: 1,
        profileDigest,
        observationId: null,
        observationDigest: null,
        baseSha: null,
        action: "quality.check",
        input: {
          repositoryId: legacyJob.repositoryId,
          revision: "from-api-snapshot",
          checks: ["source.integrity"],
          repositoryProfile: {
            organizationId: legacyJob.organizationId,
            applicationId: legacyJob.applicationId,
            repositoryId: legacyJob.repositoryId,
            id: legacyJob.profileId,
            revision: 1,
            digest: profileDigest,
            config: profileConfig,
            observationId: null,
            observationDigest: null,
            baseSha: null,
            // Pinned empty baseline: no organization rules, no overrides.
            repositoryRules: {
              organizationRevision: 0,
              profileId: legacyJob.profileId,
              profileRevision: 1,
              entries: [],
              digest:
                "29b63ecc492e00756b31919bc5c780cca04a908684a519265743512a08406a1d",
            },
          },
        },
        status: "queued",
        maxAttempts: 3,
      });
      const apiStateRows = await owner`
        select run.status as run_status,
               run.engine_owner_token as owner_token,
               run.engine_owner_lease_expires_at as owner_lease,
               step.status as step_status
          from bakery.workflow_runs run
          join bakery.run_steps step
            on step.organization_id = run.organization_id
           and step.run_id = run.id
         where run.organization_id = ${legacyJob.organizationId}
           and run.id = ${apiRun.id}
      `;
      assertEquals(apiStateRows[0]?.run_status, "running");
      assertEquals(
        apiStateRows[0]?.owner_token,
        "issue46-api-admit-owner",
      );
      assertEquals(apiStateRows[0]?.owner_lease !== null, true);
      assertEquals(apiStateRows[0]?.step_status, "running");
      const apiState = await repository.read(logical, apiOwner);
      if (!apiState?.admission) throw new Error("API_ADMISSION_STATE_MISSING");
      assertEquals(apiState.admission.jobId, apiJobId);
      assertEquals(await repository.releaseEngineOwner(apiOwner), true);

      const expectedApiRunSnapshot = {
        schemaVersion: 1,
        executionMode: "repository",
        inputs: { message: "from-api-snapshot" },
        stepAgents: {},
        stepActions: {
          step_1: {
            action: "quality.check",
            registryVersion: 1,
            metadata: WORKFLOW_ACTION_METADATA["quality.check"],
            capabilities: ["git", "shell", "browser"],
          },
        },
        workflow: {
          id: workflowVersionId,
          revision: 1,
          digest: workflowDigest,
          normalizedSpec: workflowSpec,
        },
        repositoryProfile: {
          organizationId: legacyJob.organizationId,
          applicationId: legacyJob.applicationId,
          repositoryId: legacyJob.repositoryId,
          id: legacyJob.profileId,
          revision: 1,
          digest: profileDigest,
          config: profileConfig,
          observationId: null,
          observationDigest: null,
          baseSha: null,
          // Pinned empty baseline: no organization rules, no overrides.
          repositoryRules: {
            organizationRevision: 0,
            profileId: legacyJob.profileId,
            profileRevision: 1,
            entries: [],
            digest:
              "29b63ecc492e00756b31919bc5c780cca04a908684a519265743512a08406a1d",
          },
        },
        admission: {
          dependencies: [],
          status: "queued",
          reason: null,
        },
      };
      const apiRunBeforeSwitchRows = await owner`
        select snapshot,
          application_id as "applicationId",
          repository_id as "repositoryId",
          repository_profile_id as "profileId",
          repository_profile_revision as "profileRevision",
          repository_profile_digest as "profileDigest"
          from bakery.workflow_runs
         where organization_id = ${legacyJob.organizationId}
           and id = ${apiRun.id}
      `;
      assertEquals(apiRunBeforeSwitchRows.length, 1);
      const apiRunBeforeSwitch = apiRunBeforeSwitchRows[0];
      assertEquals(apiRunBeforeSwitch, {
        snapshot: expectedApiRunSnapshot,
        applicationId: legacyJob.applicationId,
        repositoryId: legacyJob.repositoryId,
        profileId: legacyJob.profileId,
        profileRevision: 1,
        profileDigest,
      });
      const originalProfileBeforeSwitchRows = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          revision, digest, config
          from bakery.repository_profiles
         where organization_id = ${legacyJob.organizationId}
           and id = ${legacyJob.profileId}
      `;
      assertEquals(originalProfileBeforeSwitchRows.length, 1);
      const originalProfileBeforeSwitch = originalProfileBeforeSwitchRows[0];
      assertEquals(originalProfileBeforeSwitch, {
        id: legacyJob.profileId,
        applicationId: legacyJob.applicationId,
        repositoryId: legacyJob.repositoryId,
        revision: 1,
        digest: profileDigest,
        config: profileConfig,
      });

      const secondProfileConfig = {
        ...profileConfig,
        worktree: { root: ".bakery/worktrees-v2" },
      };
      const secondProfileDigest = await digestFor(secondProfileConfig);
      const secondProfileResponse = await request(
        projectsApi,
        "POST",
        `/v1/repositories/${legacyJob.repositoryId}/profiles`,
        {
          revision: 2,
          config: secondProfileConfig,
          digest: secondProfileDigest,
        },
      );
      assertEquals(secondProfileResponse.status, 201);
      const secondProfile = await secondProfileResponse.json() as {
        id: string;
        repositoryId: string;
        revision: number;
        config: unknown;
        digest: string;
      };
      assertEquals({
        repositoryId: secondProfile.repositoryId,
        revision: secondProfile.revision,
        config: secondProfile.config,
        digest: secondProfile.digest,
      }, {
        repositoryId: legacyJob.repositoryId,
        revision: 2,
        config: secondProfileConfig,
        digest: secondProfileDigest,
      });
      assertEquals(secondProfile.id === legacyJob.profileId, false);
      assertEquals(secondProfile.digest === profileDigest, false);
      const persistedSecondProfileRows = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          revision, digest, config
          from bakery.repository_profiles
         where organization_id = ${legacyJob.organizationId}
           and id = ${secondProfile.id}
      `;
      assertEquals(persistedSecondProfileRows.length, 1);
      assertEquals(persistedSecondProfileRows[0], {
        id: secondProfile.id,
        applicationId: legacyJob.applicationId,
        repositoryId: legacyJob.repositoryId,
        revision: 2,
        digest: secondProfileDigest,
        config: secondProfileConfig,
      });
      const mismatchTaskResponse = await request(
        tasksApi,
        "POST",
        "/v1/tasks",
        {
          applicationId: legacyJob.applicationId,
          repositoryId: legacyJob.repositoryId,
          title: "Issue 46 mismatched admission",
          description: "",
          taskType: "feature",
        },
      );
      assertEquals(mismatchTaskResponse.status, 201);
      const mismatchTask = await mismatchTaskResponse.json() as { id: string };
      const mismatchRunResponse = await request(
        tasksApi,
        "POST",
        `/v1/tasks/${mismatchTask.id}/runs`,
        {
          workflowVersionId,
          repositoryProfileId: legacyJob.profileId,
          executionMode: "repository",
          budgetLimitUsd: "0.005000",
          inputs: { message: "mismatched-profile" },
        },
      );
      assertEquals(mismatchRunResponse.status, 201);
      const mismatchRun = await mismatchRunResponse.json() as { id: string };
      await owner`
        update bakery.workflow_runs
           set repository_profile_id = ${secondProfile.id},
               repository_profile_revision = ${secondProfile.revision},
               repository_profile_digest = ${secondProfile.digest}
         where organization_id = ${legacyJob.organizationId}
           and id = ${mismatchRun.id}
      `;
      const mismatchLogical = await repository.findNext(mismatchRun.id);
      if (!mismatchLogical) throw new Error("MISMATCH_RUN_LOGICAL_KEY_MISSING");
      const mismatchOwner = await repository.acquireEngineOwner(
        mismatchRun.id,
        "issue46-mismatch-admit-owner",
        60_000,
      );
      if (!mismatchOwner) throw new Error("MISMATCH_RUN_OWNER_MISSING");
      const mismatchError = await assertRejects(() =>
        repository.admit(mismatchLogical, mismatchOwner)
      );
      assertEquals(errorCode(mismatchError), "STATE_CONFLICT");
      const mismatchStateRows = await owner`
        select run.status as run_status,
               step.status as step_status,
               count(job.id)::integer as job_count
          from bakery.workflow_runs run
          join bakery.run_steps step
            on step.organization_id = run.organization_id
           and step.run_id = run.id
          left join bakery.jobs job
            on job.organization_id = step.organization_id
           and job.run_step_id = step.id
         where run.organization_id = ${legacyJob.organizationId}
           and run.id = ${mismatchRun.id}
         group by run.status, step.status
      `;
      assertEquals(mismatchStateRows[0], {
        run_status: "queued",
        step_status: "pending",
        job_count: 0,
      });
      assertEquals(await repository.releaseEngineOwner(mismatchOwner), true);

      const repositoryBeforeSwitchResponse = await request(
        projectsApi,
        "GET",
        `/v1/repositories/${legacyJob.repositoryId}`,
      );
      assertEquals(repositoryBeforeSwitchResponse.status, 200);
      const repositoryBeforeSwitch = await repositoryBeforeSwitchResponse
        .json() as {
          id: string;
          applicationId: string;
          activeProfileId: string | null;
          version: number;
        };
      assertEquals({
        id: repositoryBeforeSwitch.id,
        applicationId: repositoryBeforeSwitch.applicationId,
        activeProfileId: repositoryBeforeSwitch.activeProfileId,
        version: repositoryBeforeSwitch.version,
      }, {
        id: legacyJob.repositoryId,
        applicationId: legacyJob.applicationId,
        activeProfileId: legacyJob.profileId,
        version: 1,
      });
      const switchProfileResponse = await request(
        projectsApi,
        "PATCH",
        `/v1/repositories/${legacyJob.repositoryId}`,
        { activeProfileId: secondProfile.id },
        `"${repositoryBeforeSwitch.version}"`,
      );
      assertEquals(switchProfileResponse.status, 200);
      const switchedRepository = await switchProfileResponse.json() as {
        id: string;
        applicationId: string;
        activeProfileId: string | null;
        version: number;
      };
      assertEquals({
        id: switchedRepository.id,
        applicationId: switchedRepository.applicationId,
        activeProfileId: switchedRepository.activeProfileId,
        version: switchedRepository.version,
      }, {
        id: legacyJob.repositoryId,
        applicationId: legacyJob.applicationId,
        activeProfileId: secondProfile.id,
        version: repositoryBeforeSwitch.version + 1,
      });
      const persistedRepositoryAfterSwitch = await owner`
        select active_profile_id as "activeProfileId", version
          from bakery.repositories
         where organization_id = ${legacyJob.organizationId}
           and id = ${legacyJob.repositoryId}
      `;
      assertEquals(persistedRepositoryAfterSwitch.length, 1);
      assertEquals(persistedRepositoryAfterSwitch[0], {
        activeProfileId: secondProfile.id,
        version: repositoryBeforeSwitch.version + 1,
      });

      const originalProfileAfterSwitch = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          revision, digest, config
          from bakery.repository_profiles
         where organization_id = ${legacyJob.organizationId}
           and id = ${legacyJob.profileId}
      `;
      assertEquals(originalProfileAfterSwitch.length, 1);
      assertEquals(originalProfileAfterSwitch[0], originalProfileBeforeSwitch);
      const apiRunAfterSwitch = await owner`
        select snapshot,
          application_id as "applicationId",
          repository_id as "repositoryId",
          repository_profile_id as "profileId",
          repository_profile_revision as "profileRevision",
          repository_profile_digest as "profileDigest"
          from bakery.workflow_runs
         where organization_id = ${legacyJob.organizationId}
           and id = ${apiRun.id}
      `;
      assertEquals(apiRunAfterSwitch.length, 1);
      assertEquals(apiRunAfterSwitch[0], apiRunBeforeSwitch);
      assertEquals(apiRunAfterSwitch[0]?.snapshot, expectedApiRunSnapshot);
      const apiJobsAfterSwitch = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          repository_profile_id as "profileId",
          repository_profile_revision as "profileRevision",
          repository_profile_digest as "profileDigest",
          observation_id as "observationId",
          observation_digest as "observationDigest",
          base_sha as "baseSha",
          action, input, status, max_attempts as "maxAttempts"
          from bakery.jobs
         where organization_id = ${legacyJob.organizationId}
           and run_step_id in (
             select id from bakery.run_steps
              where organization_id = ${legacyJob.organizationId}
                and run_id = ${apiRun.id}
           )
      `;
      assertEquals(apiJobsAfterSwitch.length, 1);
      assertEquals(apiJobsAfterSwitch[0], apiJob);
      const reusedOwner = await repository.acquireEngineOwner(
        apiRun.id,
        "issue46-v1-reuse-owner",
        60_000,
      );
      if (!reusedOwner) throw new Error("V1_REUSE_OWNER_MISSING");
      const reusedAdmission = await repository.admit(logical, reusedOwner);
      assertEquals(reusedAdmission.jobId, apiJobId);
      assertEquals(await repository.releaseEngineOwner(reusedOwner), true);

      const cloudWorkflowId = crypto.randomUUID();
      const cloudWorkflowVersionId = crypto.randomUUID();
      const cloudSpec = {
        apiVersion: "bakery.dev/v1",
        kind: "workflow",
        name: "issue46-cloud-only",
        steps: [{
          id: "cloud_review",
          uses: "mcp.discover",
          with: { connectionId: crypto.randomUUID() },
        }],
      };
      await owner`
        insert into bakery.workflow_definitions (id, organization_id, slug, name, description)
        values (${cloudWorkflowId}, ${legacyJob.organizationId}, 'issue46-cloud-only', 'Cloud-only', '')`;
      await owner`
        insert into bakery.workflow_versions (
          id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by
        ) values (
          ${cloudWorkflowVersionId}, ${legacyJob.organizationId}, ${cloudWorkflowId}, 1, '',
          ${owner.json(cloudSpec)}, ${await digestFor(
        cloudSpec,
      )}, 'published', ${legacyJob.principalId}
        )`;
      await owner`
        update bakery.workflow_definitions set active_version_id = ${cloudWorkflowVersionId}
         where organization_id = ${legacyJob.organizationId} and id = ${cloudWorkflowId}`;
      const cloudTaskResponse = await request(tasksApi, "POST", "/v1/tasks", {
        applicationId: legacyJob.applicationId,
        title: "Cloud-only compatibility",
        description: "",
        taskType: "maintenance",
      });
      assertEquals(cloudTaskResponse.status, 201);
      const cloudTask = await cloudTaskResponse.json() as { id: string };
      const cloudRunResponse = await request(
        tasksApi,
        "POST",
        `/v1/tasks/${cloudTask.id}/runs`,
        {
          workflowVersionId: cloudWorkflowVersionId,
          executionMode: "cloud_only",
          budgetLimitUsd: "0.005000",
          inputs: {},
        },
      );
      assertEquals(cloudRunResponse.status, 201);
      const cloudRun = await cloudRunResponse.json() as { id: string };
      const cloudLogical = await repository.findNext(cloudRun.id);
      if (!cloudLogical) throw new Error("CLOUD_LOGICAL_MISSING");
      const cloudOwner = await repository.acquireEngineOwner(
        cloudRun.id,
        "issue46-cloud-only-owner",
        60_000,
      );
      if (!cloudOwner) throw new Error("CLOUD_OWNER_MISSING");
      const cloudAdmission = await repository.admit(cloudLogical, cloudOwner);
      const cloudJobId = cloudAdmission.jobId;
      if (cloudJobId === undefined) throw new Error("CLOUD_JOB_NOT_ADMITTED");
      const cloudJobs = await owner`
        select application_id, repository_id, repository_profile_id,
          repository_profile_revision, repository_profile_digest,
          observation_id, observation_digest, base_sha, action, status
          from bakery.jobs where id = ${cloudJobId}`;
      assertEquals(cloudJobs[0], {
        application_id: null,
        repository_id: null,
        repository_profile_id: null,
        repository_profile_revision: null,
        repository_profile_digest: null,
        observation_id: null,
        observation_digest: null,
        base_sha: null,
        action: "mcp.discover",
        status: "queued",
      });
      assertEquals(await repository.releaseEngineOwner(cloudOwner), true);

      // A forged readiness string without a canonical policy and completed
      // authorized publication cannot authorize admission or queued-job reuse.
      const v2ProfileId = crypto.randomUUID();
      const observationId = crypto.randomUUID();
      const v2TaskId = crypto.randomUUID();
      const v2ConversationId = crypto.randomUUID();
      const v2RunId = crypto.randomUUID();
      const v2RunStepId = crypto.randomUUID();
      const v2Config = {
        schemaVersion: 2,
        branches: { base: "main", allowedPatterns: ["feature/*"] },
        worktree: { root: ".bakery/worktrees" },
        checkPolicy: { checks: [], hostRequirements: {} },
      };
      const v2Digest = await digestFor(v2Config);
      const observationDigest = await digestFor({
        readiness: "eligible",
      });
      const mappingDigest = "1".repeat(64);
      const baseSha = "a".repeat(40);
      await owner`
        insert into bakery.repository_profiles (
          id, organization_id, application_id, repository_id, revision,
          config, digest, created_by
        ) values (
          ${v2ProfileId}, ${legacyJob.organizationId}, ${legacyJob.applicationId},
          ${legacyJob.repositoryId}, 3, ${owner.json(v2Config)}, ${v2Digest},
          ${legacyJob.principalId}
        )`;
      await owner`
        insert into bakery.repository_profile_observations (
          id, organization_id, application_id, repository_id, profile_id,
          profile_revision, profile_digest, observation_digest, observed_at,
          source_mapping_revision, source_mapping_digest, base_sha, payload,
          readiness
        ) values (
          ${observationId}, ${legacyJob.organizationId}, ${legacyJob.applicationId},
          ${legacyJob.repositoryId}, ${v2ProfileId}, 3, ${v2Digest},
          ${observationDigest}, ${now}, 1, ${mappingDigest}, ${baseSha},
          ${owner.json({ readiness: "eligible" })}, 'eligible'
        )`;
      await owner`
        insert into bakery.conversations (
          id, organization_id, application_id, repository_id, title, created_by
        ) values (
          ${v2ConversationId}, ${legacyJob.organizationId},
          ${legacyJob.applicationId}, ${legacyJob.repositoryId},
          'Issue 46 observed v2', ${legacyJob.principalId}
        )`;
      await owner`
        insert into bakery.tasks (
          id, organization_id, application_id, repository_id, conversation_id,
          title, description, task_type, status, priority, created_by,
          repository_profile_id, repository_profile_revision,
          repository_profile_digest, observation_id, observation_digest, base_sha
        ) values (
          ${v2TaskId}, ${legacyJob.organizationId}, ${legacyJob.applicationId},
          ${legacyJob.repositoryId}, ${v2ConversationId}, 'Issue 46 observed v2',
          '', 'feature', 'draft', 50, ${legacyJob.principalId}, ${v2ProfileId},
          3, ${v2Digest}, ${observationId}, ${observationDigest}, ${baseSha}
        )`;
      const v2Snapshot = {
        executionMode: "repository",
        inputs: { message: "from-observed-v2" },
        workflow: {
          id: workflowId,
          revision: 1,
          digest: workflowDigest,
          normalizedSpec: workflowSpec,
        },
        repositoryProfile: {
          id: v2ProfileId,
          revision: 3,
          digest: v2Digest,
          config: v2Config,
        },
        dependencies: [],
      };
      await owner`
        insert into bakery.workflow_runs (
          id, organization_id, task_id, workflow_version_id,
          repository_profile_id, requested_by, status, snapshot,
          budget_limit_usd, application_id, repository_id,
          repository_profile_revision, repository_profile_digest,
          observation_id, observation_digest, base_sha
        ) values (
          ${v2RunId}, ${legacyJob.organizationId}, ${v2TaskId},
          ${workflowVersionId}, ${v2ProfileId}, ${legacyJob.principalId},
          'queued', ${owner.json(v2Snapshot)}, 0, ${legacyJob.applicationId},
          ${legacyJob.repositoryId}, 3, ${v2Digest}, ${observationId},
          ${observationDigest}, ${baseSha}
        )`;
      await owner`
        update bakery.tasks
           set current_run_id = ${v2RunId}
         where organization_id = ${legacyJob.organizationId}
           and id = ${v2TaskId}`;
      await owner`
        insert into bakery.run_steps (
          id, organization_id, run_id, step_key, position, iteration,
          status, input
        ) values (
          ${v2RunStepId}, ${legacyJob.organizationId}, ${v2RunId}, 'step_1',
          0, 0, 'pending', ${owner.json({})}
        )`;
      await withPgTransaction(
        appPg,
        (transaction) =>
          appendDomainEvent(transaction, {
            organizationId: legacyJob.organizationId,
            applicationId: legacyJob.applicationId,
            repositoryId: legacyJob.repositoryId,
            taskId: v2TaskId,
            conversationId: v2ConversationId,
            eventType: "run.requested",
            aggregateId: v2RunId,
            aggregateVersion: 1,
            payload: { runId: v2RunId },
            traceId: "issue46-observed-v2-trace",
          }),
      );
      const v2Logical = await repository.findNext(v2RunId);
      if (!v2Logical) throw new Error("V2_RUN_LOGICAL_KEY_MISSING");
      assertEquals(
        v2Logical,
        {
          runId: v2RunId,
          stepKey: "step_1",
          iteration: 0,
          actionVersion: workflowVersionId,
        } satisfies LogicalInvocationKey,
      );
      const v2Owner = await repository.acquireEngineOwner(
        v2RunId,
        "issue46-v2-admit-owner",
        60_000,
      );
      if (!v2Owner) throw new Error("V2_RUN_OWNER_MISSING");
      for (const adapter of [repository, concurrentRepository]) {
        const error = await assertRejects(() =>
          adapter.admit(v2Logical, v2Owner)
        );
        assertEquals(errorCode(error), "STATE_CONFLICT");
      }
      const v2Jobs = await owner`
        select
          application_id as "applicationId",
          repository_id as "repositoryId",
          repository_profile_id as "profileId",
          repository_profile_revision as "profileRevision",
          repository_profile_digest as "profileDigest",
          observation_id as "observationId",
          observation_digest as "observationDigest",
          base_sha as "baseSha",
          action, input, status, max_attempts as "maxAttempts"
          from bakery.jobs
         where organization_id = ${legacyJob.organizationId}
           and run_step_id = ${v2RunStepId}
      `;
      assertEquals([...v2Jobs], []);
      const v2StateRows = await owner`
        select run.status as run_status,
               run.engine_owner_token as owner_token,
               run.engine_owner_lease_expires_at as owner_lease,
               step.status as step_status
          from bakery.workflow_runs run
          join bakery.run_steps step
            on step.organization_id = run.organization_id
           and step.run_id = run.id
         where run.organization_id = ${legacyJob.organizationId}
           and run.id = ${v2RunId}
      `;
      assertEquals(v2StateRows[0]?.run_status, "queued");
      assertEquals(v2StateRows[0]?.owner_token, "issue46-v2-admit-owner");
      assertEquals(v2StateRows[0]?.step_status, "pending");
      const seededJobId = crypto.randomUUID();
      await owner`
        insert into bakery.jobs (
          id, organization_id, run_step_id, repository_id, action, input,
          application_id, repository_profile_id, repository_profile_revision,
          repository_profile_digest, observation_id, observation_digest, base_sha
        ) values (
          ${seededJobId}, ${legacyJob.organizationId}, ${v2RunStepId}, ${legacyJob.repositoryId},
          'quality.check', ${
        owner.json({ repositoryId: legacyJob.repositoryId, message: "seeded" })
      },
          ${legacyJob.applicationId}, ${v2ProfileId}, 3, ${v2Digest},
          ${observationId}, ${observationDigest}, ${baseSha}
        )`;
      const beforeSeededReuse = await owner`
        select * from bakery.jobs where id = ${seededJobId}`;
      const reusedObservedError = await assertRejects(() =>
        repository.admit(v2Logical, v2Owner)
      );
      assertEquals(errorCode(reusedObservedError), "STATE_CONFLICT");
      assertEquals(
        [...await owner`select * from bakery.jobs where id = ${seededJobId}`],
        [...beforeSeededReuse],
      );
      assertEquals(
        [
          ...await owner`
        select run.status as run_status, run.engine_owner_token as owner_token,
          run.engine_owner_lease_expires_at as owner_lease, step.status as step_status
          from bakery.workflow_runs run
          join bakery.run_steps step on step.organization_id = run.organization_id
           and step.run_id = run.id
         where run.organization_id = ${legacyJob.organizationId} and run.id = ${v2RunId}`,
        ],
        [...v2StateRows],
      );
      assertEquals(await repository.releaseEngineOwner(v2Owner), true);
    } finally {
      try {
        if (secondAppPg !== undefined) {
          await closePgDatabase(secondAppPg);
        }
      } finally {
        await fixture.cleanup();
      }
    }
  },
);

Deno.test(
  "Projects 0047 rejects existing archived cross-application slug collisions atomically",
  async () => {
    const fixture = await migrateTestDatabase({
      through: projectsMigration0046,
    });
    const { owner, legacyJob, migrateThrough } = fixture;
    const secondApplicationId = crypto.randomUUID();
    const secondRepositoryId = crypto.randomUUID();
    try {
      await owner`
        update bakery.repositories
           set slug = 'archived-collision',
               archived_at = ${new Date("2026-09-27T00:01:00.000Z")}
         where id = ${legacyJob.repositoryId}`;
      await owner`
        insert into bakery.applications (
          id, organization_id, slug, name, description
        ) values (
          ${secondApplicationId}, ${legacyJob.organizationId},
          'legacy-secondary', 'Legacy-Secondary', ''
        )`;
      await owner`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch, slug, archived_at
        ) values (
          ${secondRepositoryId}, ${legacyJob.organizationId},
          ${secondApplicationId}, ${crypto.randomUUID()},
          'legacy/secondary-repository', 'legacy-owner',
          'legacy-secondary', 'main', 'archived-collision',
          ${new Date("2026-09-27T00:02:00.000Z")}
        )`;

      const migrationError = await assertRejects(() =>
        migrateThrough(projectsMigration0047)
      );
      assertEquals(errorCode(migrationError), "23505");

      const collisionRows = await owner`
        select slug, archived_at is not null as archived
          from bakery.repositories
         where organization_id = ${legacyJob.organizationId}
           and slug = 'archived-collision'
         order by id`;
      assertEquals([...collisionRows], [
        { slug: "archived-collision", archived: true },
        { slug: "archived-collision", archived: true },
      ]);
      const rollbackRows = await owner`
        select
          (
            select count(*)::integer
              from bakery.schema_migrations
             where version = ${projectsMigration0047}
          ) as ledger_count,
          (
            select count(*)::integer
              from pg_constraint
             where conname = 'repositories_organization_slug_unique'
          ) as constraint_count`;
      assertEquals(rollbackRows[0], {
        ledger_count: 0,
        constraint_count: 0,
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "Projects 0047 migration preserves legacy NULLs and permits cross-organization slugs",
  async () => {
    const fixture = await migrateTestDatabase({
      through: projectsMigration0046,
    });
    const { owner, legacyJob, migrateThrough } = fixture;
    const nullRepositoryAId = crypto.randomUUID();
    const nullRepositoryBId = crypto.randomUUID();
    const otherOrganizationId = crypto.randomUUID();
    const otherPrincipalId = crypto.randomUUID();
    const otherUserId = crypto.randomUUID();
    const otherApplicationId = crypto.randomUUID();
    const otherRepositoryId = crypto.randomUUID();
    try {
      const before0046 = await owner`
        select checksum from bakery.schema_migrations
         where version = ${projectsMigration0046}`;
      const deployed0046 = (await loadMigrations(projectsBakeryMigrationSource))
        .find((migration) => migration.version === projectsMigration0046);
      if (!deployed0046) throw new Error("DEPLOYED_0046_MISSING");
      assertEquals(before0046[0]?.checksum, deployed0046.checksum);
      await owner`
        update bakery.repositories
           set slug = 'shared-slug'
         where id = ${legacyJob.repositoryId}`;
      await owner`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch
        ) values (
          ${nullRepositoryAId}, ${legacyJob.organizationId},
          ${legacyJob.applicationId}, ${crypto.randomUUID()},
          'legacy/null-repository-a', 'legacy-owner',
          'legacy-null-a', 'main'
        )`;
      await owner`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch
        ) values (
          ${nullRepositoryBId}, ${legacyJob.organizationId},
          ${legacyJob.applicationId}, ${crypto.randomUUID()},
          'legacy/null-repository-b', 'legacy-owner',
          'legacy-null-b', 'main'
        )`;
      await seedOrganization(
        owner,
        otherOrganizationId,
        otherPrincipalId,
        otherUserId,
        "Other Org",
      );
      await owner`
        insert into bakery.applications (
          id, organization_id, slug, name, description
        ) values (
          ${otherApplicationId}, ${otherOrganizationId},
          'other-project', 'Other-Project', ''
        )`;
      await owner`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch, slug
        ) values (
          ${otherRepositoryId}, ${otherOrganizationId},
          ${otherApplicationId}, ${crypto.randomUUID()},
          'other/shared-repository', 'other-owner',
          'shared-repository', 'main', 'shared-slug'
        )`;

      await migrateThrough(projectsMigration0047);
      const after0046 = await owner`
        select checksum from bakery.schema_migrations
         where version = ${projectsMigration0046}`;
      assertEquals(after0046, before0046);

      const persistedRows = await owner`
        select
          count(*) filter (where slug is null)::integer as null_count,
          count(*) filter (where slug = 'shared-slug')::integer as shared_slug_count
          from bakery.repositories
      `;
      assertEquals(persistedRows[0], {
        null_count: 2,
        shared_slug_count: 2,
      });
      const migrationStateRows = await owner`
        select
          (
            select count(*)::integer
              from bakery.schema_migrations
             where version = ${projectsMigration0047}
          ) as ledger_count,
          (
            select count(*)::integer
              from pg_constraint
             where conname = 'repositories_organization_slug_unique'
          ) as constraint_count`;
      assertEquals(migrationStateRows[0], {
        ledger_count: 1,
        constraint_count: 1,
      });
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "Projects upgraded ledger maps concurrent cross-application slug collisions to API conflict",
  async () => {
    const fixture = await migrateTestDatabase({
      through: projectsMigration0046,
    });
    const { owner, legacyJob, migrateThrough } = fixture;
    let concurrentPg: PgDatabase | undefined;
    try {
      await migrateThrough(projectsMigration0047);
      const databaseRows = await owner`select current_database() as name`;
      const concurrentUrl = new URL(appDatabaseUrl);
      concurrentUrl.pathname = `/${databaseRows[0]?.name}`;
      concurrentPg = openPgDatabase(concurrentUrl.toString(), 2);
      const secondApplicationId = crypto.randomUUID();
      await owner`
        insert into bakery.applications (id, organization_id, slug, name, description)
        values (${secondApplicationId}, ${legacyJob.organizationId}, 'race-app', 'Race App', '')`;
      const principal = {
        principalId: legacyJob.principalId,
        principalType: "human" as const,
        displayName: "Legacy Job",
      };
      const app = createApiRouter({
        registry: createProjectsActionRegistry(
          createProjectsHandlers("issue46-slug-race-secret"),
          {
            authorityRunner: new PostgresAuthorityRunner(concurrentPg),
            commandRunner: createPostgresCommandRunner(),
          },
        ),
        createContext: () => ({ principal }),
      });
      const responses = await Promise.all(
        [legacyJob.applicationId, secondApplicationId].map((
          applicationId,
          index,
        ) =>
          app.fetch(
            new Request("http://projects.test/v1/repositories", {
              method: "POST",
              headers: {
                "Bakery-Organization-Id": legacyJob.organizationId,
                "Idempotency-Key": `issue46-slug-race-${index}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                applicationId,
                slug: "race-slug",
                integrationConnectionId: crypto.randomUUID(),
                providerRepoId: `race/repo-${index}`,
                owner: "race-owner",
                name: `race-repo-${index}`,
                defaultBranch: "main",
              }),
            }),
          )
        ),
      );
      assertEquals(responses.map((response) => response.status).sort(), [
        201,
        409,
      ]);
      const winner = await responses.find((response) =>
        response.status === 201
      )!.json();
      const loser = await responses.find((response) => response.status === 409)!
        .json();
      assertEquals(loser.code, "STATE_CONFLICT");
      await owner`update bakery.repositories set archived_at = now() where id = ${winner.id}`;
      const archivedCollision = await app.fetch(
        new Request("http://projects.test/v1/repositories", {
          method: "POST",
          headers: {
            "Bakery-Organization-Id": legacyJob.organizationId,
            "Idempotency-Key": "issue46-slug-race-archived",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            applicationId: winner.applicationId === secondApplicationId
              ? legacyJob.applicationId
              : secondApplicationId,
            slug: "race-slug",
            integrationConnectionId: crypto.randomUUID(),
            providerRepoId: "race/archived-collision",
            owner: "race-owner",
            name: "archived-collision",
            defaultBranch: "main",
          }),
        }),
      );
      assertEquals(archivedCollision.status, 409);
      const repositories = await owner`
        select id from bakery.repositories
         where organization_id = ${legacyJob.organizationId} and slug = 'race-slug'`;
      assertEquals([...repositories], [{ id: winner.id }]);
    } finally {
      if (concurrentPg !== undefined) await closePgDatabase(concurrentPg);
      await fixture.cleanup();
    }
  },
);

Deno.test(
  "Projects role bindings persist normalized values and reject stale compare-and-swap updates",
  async () => {
    const fixture = await migrateTestDatabase();
    try {
      const { owner, appPg, legacyJob } = fixture;
      let principal = {
        principalId: legacyJob.principalId,
        principalType: "human" as const,
        displayName: "Legacy Job",
      };
      const tenantBoundaryOrganizationId = crypto.randomUUID();
      const tenantBoundaryPrincipalId = crypto.randomUUID();
      const tenantBoundaryUserId = crypto.randomUUID();
      const tenantBoundaryPrincipal = {
        principalId: tenantBoundaryPrincipalId,
        principalType: "human" as const,
        displayName: "Role Tenant B",
      };
      await seedOrganization(
        owner,
        tenantBoundaryOrganizationId,
        tenantBoundaryPrincipalId,
        tenantBoundaryUserId,
        "Role Tenant B",
      );
      const projectsApi = createApiRouter({
        registry: createProjectsActionRegistry(
          createProjectsHandlers("issue-46-role-cas-secret"),
          {
            authorityRunner: new PostgresAuthorityRunner(appPg),
            commandRunner: createPostgresCommandRunner(),
          },
        ),
        createContext: () => ({ principal }),
      });
      let commandNumber = 0;
      const request = async (
        method: string,
        path: string,
        body?: unknown,
        ifMatch?: string,
        organizationId = legacyJob.organizationId,
      ): Promise<Response> => {
        const headers: Record<string, string> = {
          "Bakery-Organization-Id": organizationId,
        };
        if (method !== "GET") {
          headers["Idempotency-Key"] = `issue46-role-cas-${commandNumber++}`;
        }
        if (body !== undefined) headers["content-type"] = "application/json";
        if (ifMatch !== undefined) headers["If-Match"] = ifMatch;
        return await projectsApi.fetch(
          new Request(`http://issue-46-role-cas.test${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
      };

      const createdResponse = await request(
        "POST",
        `/v1/applications/${legacyJob.applicationId}/roles`,
        {
          applicationId: legacyJob.applicationId,
          repositoryId: legacyJob.repositoryId,
          role: " Source.Role ",
          alias: " Primary.Alias ",
          provenance: "integration-role-cas",
        },
      );
      assertEquals(createdResponse.status, 201);
      const created = await createdResponse.json() as {
        id: string;
        applicationId: string;
        repositoryId: string;
        role: string;
        alias: string | null;
        version: number;
      };
      assertEquals(
        {
          applicationId: created.applicationId,
          repositoryId: created.repositoryId,
          role: created.role,
          alias: created.alias,
          version: created.version,
        },
        {
          applicationId: legacyJob.applicationId,
          repositoryId: legacyJob.repositoryId,
          role: "source.role",
          alias: "primary.alias",
          version: 1,
        },
      );

      const persistedAfterCreate = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          role, alias, version
          from bakery.repository_role_bindings
         where organization_id = ${legacyJob.organizationId}
           and id = ${created.id}
      `;
      assertEquals(persistedAfterCreate.length, 1);
      assertEquals(persistedAfterCreate[0], {
        id: created.id,
        applicationId: legacyJob.applicationId,
        repositoryId: legacyJob.repositoryId,
        role: "source.role",
        alias: "primary.alias",
        version: 1,
      });

      const updatedResponse = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}/roles/${created.id}`,
        {
          expectedVersion: 1,
          role: " Deploy.Role ",
          alias: " Canary.Alias ",
        },
        '"1"',
      );
      assertEquals(updatedResponse.status, 200);
      const updated = await updatedResponse.json() as {
        id: string;
        applicationId: string;
        repositoryId: string;
        role: string;
        alias: string | null;
        version: number;
      };
      assertEquals(
        {
          id: updated.id,
          applicationId: updated.applicationId,
          repositoryId: updated.repositoryId,
          role: updated.role,
          alias: updated.alias,
          version: updated.version,
        },
        {
          id: created.id,
          applicationId: legacyJob.applicationId,
          repositoryId: legacyJob.repositoryId,
          role: "deploy.role",
          alias: "canary.alias",
          version: 2,
        },
      );

      const persistedAfterUpdateRows = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          role, alias, version
          from bakery.repository_role_bindings
         where organization_id = ${legacyJob.organizationId}
           and id = ${created.id}
      `;
      assertEquals(persistedAfterUpdateRows.length, 1);
      const persistedAfterUpdate = persistedAfterUpdateRows[0];
      assertEquals(persistedAfterUpdate, {
        id: created.id,
        applicationId: legacyJob.applicationId,
        repositoryId: legacyJob.repositoryId,
        role: "deploy.role",
        alias: "canary.alias",
        version: 2,
      });

      const staleResponse = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}/roles/${created.id}`,
        {
          expectedVersion: 1,
          role: " Stale.Role ",
          alias: " Stale.Alias ",
        },
        '"1"',
      );
      assertEquals(staleResponse.status, 412);
      assertEquals((await staleResponse.json()).code, "PRECONDITION_FAILED");

      const persistedAfterStale = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          role, alias, version
          from bakery.repository_role_bindings
         where organization_id = ${legacyJob.organizationId}
           and id = ${created.id}
      `;
      assertEquals(persistedAfterStale, persistedAfterUpdateRows);

      principal = tenantBoundaryPrincipal;
      const foreignTenantResponse = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}/roles/${created.id}`,
        {
          expectedVersion: 2,
          role: " Foreign.Role ",
          alias: " Foreign.Alias ",
        },
        '"2"',
        tenantBoundaryOrganizationId,
      );
      assertEquals(foreignTenantResponse.status, 404);
      assertEquals(
        (await foreignTenantResponse.json()).code,
        "RESOURCE_NOT_FOUND",
      );
      const persistedAfterTenantBoundary = await owner`
        select id,
          application_id as "applicationId",
          repository_id as "repositoryId",
          role, alias, version
          from bakery.repository_role_bindings
         where organization_id = ${legacyJob.organizationId}
           and id = ${created.id}
      `;
      assertEquals(
        persistedAfterTenantBoundary,
        persistedAfterUpdateRows,
      );

      principal = {
        principalId: legacyJob.principalId,
        principalType: "human" as const,
        displayName: "Legacy Job",
      };
      const archivedAt = "2026-09-27T00:06:00.000Z";
      const archiveResponse = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}/roles/${created.id}`,
        { expectedVersion: 2, archivedAt },
        '"2"',
      );
      assertEquals(archiveResponse.status, 200);
      assertEquals((await archiveResponse.json()).archivedAt, archivedAt);
      const archivedResolution = await request(
        "POST",
        `/v1/applications/${legacyJob.applicationId}/roles/resolve`,
        { role: "deploy.role", alias: "canary.alias" },
      );
      assertEquals(await archivedResolution.json(), {
        status: "unavailable",
        reason: "no_matching_binding",
      });
      const archivedList = await request(
        "GET",
        `/v1/applications/${legacyJob.applicationId}/roles`,
      );
      assertEquals(
        (await archivedList.json()).items.find((item: { id: string }) =>
          item.id === created.id
        ).archivedAt,
        archivedAt,
      );
      const restoreResponse = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}/roles/${created.id}`,
        { expectedVersion: 3, archivedAt: null },
        '"3"',
      );
      assertEquals(restoreResponse.status, 200);
      assertEquals((await restoreResponse.json()).version, 4);
      const restoredResolution = await request(
        "POST",
        `/v1/applications/${legacyJob.applicationId}/roles/resolve`,
        { role: "deploy.role", alias: "canary.alias" },
      );
      assertEquals(
        (await restoredResolution.json()).binding.repositoryId,
        legacyJob.repositoryId,
      );

      const renamedApplication = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}`,
        { name: "Renamed", slug: "renamed", description: "Updated" },
        '"1"',
      );
      assertEquals(renamedApplication.status, 200);
      const renamed = await renamedApplication.json();
      assertEquals(
        {
          name: renamed.name,
          slug: renamed.slug,
          description: renamed.description,
          version: renamed.version,
        },
        {
          name: "Renamed",
          slug: "renamed",
          description: "Updated",
          version: 2,
        },
      );
      const staleApplication = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}`,
        { name: "Stale" },
        '"1"',
      );
      assertEquals(staleApplication.status, 412);
      const archiveApplication = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}`,
        { archivedAt },
        '"2"',
      );
      assertEquals(archiveApplication.status, 200);
      const blockedRole = await request(
        "POST",
        `/v1/applications/${legacyJob.applicationId}/roles`,
        {
          applicationId: legacyJob.applicationId,
          repositoryId: legacyJob.repositoryId,
          role: "blocked",
        },
      );
      assertEquals(blockedRole.status, 409);
      const blockedProfile = await request(
        "POST",
        `/v1/repositories/${legacyJob.repositoryId}/profiles`,
        {
          revision: 2,
          config: profileConfig,
          digest: await digestFor(profileConfig),
        },
      );
      assertEquals(blockedProfile.status, 409);
      const restoreApplication = await request(
        "PATCH",
        `/v1/applications/${legacyJob.applicationId}`,
        { archivedAt: null },
        '"3"',
      );
      assertEquals(restoreApplication.status, 200);
      const storedApplication = await owner`
        select name, slug, description, archived_at, version from bakery.applications
         where organization_id = ${legacyJob.organizationId} and id = ${legacyJob.applicationId}`;
      assertEquals(storedApplication[0], {
        name: "Renamed",
        slug: "renamed",
        description: "Updated",
        archived_at: null,
        version: 4,
      });
    } finally {
      await fixture.cleanup();
    }
  },
);
Deno.test(
  "Projects binding resolution hides archived applications from direct and role selectors",
  async () => {
    const fixture = await migrateTestDatabase();
    const { owner, appPg, legacyJob } = fixture;
    const profileId = crypto.randomUUID();
    const observationId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const profileConfig = {
      schemaVersion: 2,
      branches: { base: "main", allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
      checkPolicy: { checks: [], hostRequirements: {} },
    };
    const profileDigest = await digestFor(profileConfig);
    const observationDigest = await digestFor({
      readiness: "eligible",
      source: "archived-application-regression",
    });
    const baseSha = "a".repeat(40);
    const observedAt = new Date("2026-09-27T00:04:00.000Z");
    const resolve = (
      organizationId: string,
      applicationId: string,
      input: unknown,
    ) =>
      withPgTransaction(appPg, (transaction) =>
        resolveRepositoryBinding(
          transaction,
          organizationId,
          applicationId,
          input,
        ));
    try {
      await owner`
        insert into bakery.repository_profiles (
          id, organization_id, application_id, repository_id, revision,
          config, digest, created_by
        ) values (
          ${profileId}, ${legacyJob.organizationId}, ${legacyJob.applicationId},
          ${legacyJob.repositoryId}, 2, ${owner.json(profileConfig)},
          ${profileDigest}, ${legacyJob.principalId}
        )`;
      await owner`
        insert into bakery.repository_profile_observations (
          id, organization_id, application_id, repository_id, profile_id,
          profile_revision, profile_digest, observation_digest, observed_at,
          source_mapping_revision, source_mapping_digest, base_sha, payload,
          readiness
        ) values (
          ${observationId}, ${legacyJob.organizationId}, ${legacyJob.applicationId},
          ${legacyJob.repositoryId}, ${profileId}, 2, ${profileDigest},
          ${observationDigest}, ${observedAt}, 1, ${"b".repeat(64)},
          ${baseSha}, ${owner.json({ readiness: "eligible" })}, 'eligible'
        )`;
      await owner`
        update bakery.repositories
           set active_profile_id = ${profileId}
         where organization_id = ${legacyJob.organizationId}
           and application_id = ${legacyJob.applicationId}
           and id = ${legacyJob.repositoryId}`;
      await owner`
        insert into bakery.repository_role_bindings (
          id, organization_id, application_id, repository_id,
          role, alias, provenance
        ) values (
          ${bindingId}, ${legacyJob.organizationId}, ${legacyJob.applicationId},
          ${legacyJob.repositoryId}, 'source', 'primary',
          'archived-application-regression'
        )`;

      assertEquals(
        await resolve(
          legacyJob.organizationId,
          legacyJob.applicationId,
          { repositoryId: legacyJob.repositoryId },
        ),
        {
          status: "resolved",
          binding: {
            organizationId: legacyJob.organizationId,
            applicationId: legacyJob.applicationId,
            repositoryId: legacyJob.repositoryId,
            repositoryProfileId: null,
            repositoryProfileRevision: null,
            repositoryProfileDigest: null,
            observationId: null,
            observationDigest: null,
            baseSha: null,
          },
        },
      );
      assertEquals(
        (await resolve(
          legacyJob.organizationId,
          legacyJob.applicationId,
          { role: "source", alias: "primary" },
        )).status,
        "resolved",
      );

      await owner`
        update bakery.applications
           set archived_at = ${new Date("2026-09-27T00:05:00.000Z")}
         where organization_id = ${legacyJob.organizationId}
           and id = ${legacyJob.applicationId}`;

      // Preserve direct-selector foreign/not-found privacy for an archived
      // application rather than exposing its otherwise eligible binding.
      assertEquals(
        await resolve(
          legacyJob.organizationId,
          legacyJob.applicationId,
          { repositoryId: legacyJob.repositoryId },
        ),
        { status: "foreign", reason: "repository_scope_mismatch" },
      );
      assertEquals(
        await resolve(
          legacyJob.organizationId,
          legacyJob.applicationId,
          { role: "source", alias: "primary" },
        ),
        { status: "unavailable", reason: "no_matching_binding" },
      );
      assertEquals(
        await resolve(
          crypto.randomUUID(),
          legacyJob.applicationId,
          { repositoryId: legacyJob.repositoryId },
        ),
        { status: "foreign", reason: "repository_scope_mismatch" },
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

Deno.test("Projects resolves distinct repository identities before the 32-candidate overflow bound", async () => {
  const fixture = await migrateTestDatabase();
  const { owner, appPg, legacyJob } = fixture;
  try {
    const principal = {
      principalId: legacyJob.principalId,
      principalType: "human" as const,
      displayName: "Legacy Job",
    };
    const app = createApiRouter({
      registry: createProjectsActionRegistry(
        createProjectsHandlers("issue46-distinct-secret"),
        {
          authorityRunner: new PostgresAuthorityRunner(appPg),
          commandRunner: createPostgresCommandRunner(),
        },
      ),
      createContext: () => ({ principal }),
    });
    const resolve = async (selector: unknown) => {
      const response = await app.fetch(
        new Request(
          `http://projects.test/v1/applications/${legacyJob.applicationId}/roles/resolve`,
          {
            method: "POST",
            headers: {
              "Bakery-Organization-Id": legacyJob.organizationId,
              "content-type": "application/json",
            },
            body: JSON.stringify(selector),
          },
        ),
      );
      assertEquals(response.status, 201);
      return await response.json();
    };
    // More than 33 matching bindings for one repository must not consume the
    // distinct-repository bound or manufacture ambiguity.
    await owner`
      insert into bakery.repository_role_bindings (
        id, organization_id, application_id, repository_id, role, alias
      )
      select gen_random_uuid(), ${legacyJob.organizationId}, ${legacyJob.applicationId},
        ${legacyJob.repositoryId}, 'duplicate-' || n, case when n % 2 = 0 then 'primary' else 'secondary' end
        from generate_series(1, 40) n`;
    const unique = await resolve({ aliases: ["primary", "secondary"] });
    assertEquals(unique, {
      status: "resolved",
      binding: {
        organizationId: legacyJob.organizationId,
        applicationId: legacyJob.applicationId,
        repositoryId: legacyJob.repositoryId,
        repositoryProfileId: legacyJob.profileId,
        repositoryProfileRevision: 1,
        repositoryProfileDigest: await digestFor(profileConfig),
        observationId: null,
        observationDigest: null,
        baseSha: null,
      },
    });
    const repositoryIds = [legacyJob.repositoryId];
    for (let index = 0; index < 32; index++) {
      const repositoryId = crypto.randomUUID();
      repositoryIds.push(repositoryId);
      await owner`
        insert into bakery.repositories (
          id, organization_id, application_id, integration_connection_id,
          provider_repo_id, owner, name, default_branch
        ) values (
          ${repositoryId}, ${legacyJob.organizationId}, ${legacyJob.applicationId},
          ${crypto.randomUUID()}, ${`distinct/repo-${index}`}, 'distinct-owner',
          ${`repo-${index}`}, 'main'
        )`;
      await owner`
        insert into bakery.repository_role_bindings (
          id, organization_id, application_id, repository_id, role, alias
        ) values (
          ${crypto.randomUUID()}, ${legacyJob.organizationId}, ${legacyJob.applicationId},
          ${repositoryId}, 'source', 'primary'
        )`;
      if (index === 0) {
        const noProfile = await resolve({ repositoryId });
        assertEquals(noProfile.binding, {
          organizationId: legacyJob.organizationId,
          applicationId: legacyJob.applicationId,
          repositoryId,
          repositoryProfileId: null,
          repositoryProfileRevision: null,
          repositoryProfileDigest: null,
          observationId: null,
          observationDigest: null,
          baseSha: null,
        });
      }
      if (index === 30) {
        const complete = await resolve({ aliases: ["primary", "secondary"] });
        assertEquals(complete.status, "ambiguous");
        assertEquals(complete.truncated, false);
        assertEquals(
          complete.candidates.map((item: { repositoryId: string }) =>
            item.repositoryId
          ),
          [...repositoryIds].sort(),
        );
      }
    }
    const overflow = await resolve({ aliases: ["primary", "secondary"] });
    assertEquals(overflow.status, "ambiguous");
    assertEquals(overflow.truncated, true);
    assertEquals(
      overflow.candidates.map((item: { repositoryId: string }) =>
        item.repositoryId
      ),
      [...repositoryIds].sort().slice(0, 32),
    );
    assertEquals(
      overflow.candidates.every((item: { hasEligibleObservation: boolean }) =>
        item.hasEligibleObservation === false
      ),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("Projects inspection publishes exact immutable eligible and blocked evidence atomically", async () => {
  const fixture = await migrateTestDatabase();
  try {
    for (
      const scenario of [
        "optional-tool-missing",
        "required-tool-missing",
        "required-check-failed",
        "platform-mismatch",
      ] as const
    ) {
      const readiness = scenario === "optional-tool-missing"
        ? "eligible"
        : "blocked";
      const harness = await openRepositoryInspectionHarness(
        fixture,
        fixture.legacyJob,
        { os: scenario === "platform-mismatch" ? "macos" : "linux" },
      );
      try {
        const repository = await harness.createRepository(
          scenario === "required-tool-missing" ||
            scenario === "required-check-failed",
        );
        const onboarding = await harness.onboard(repository.repositoryId);
        assertEquals(onboarding.status, "queued");
        assertEquals(onboarding.profileId, null);
        assertEquals(onboarding.observationId, null);
        const assignment = await readInspectionAssignment(
          await harness.claim(),
        );
        assertEquals(assignment.jobId, onboarding.jobId);
        assertEquals(assignment.action, "repository.inspect");
        assertEquals(
          assignment.input.organizationId,
          fixture.legacyJob.organizationId,
        );
        assertEquals(assignment.input.applicationId, repository.applicationId);
        assertEquals(assignment.input.repositoryId, repository.repositoryId);
        assertEquals(
          assignment.input.baseline.profileId,
          repository.baselineProfileId,
        );
        assertEquals(assignment.input.source.baseSha, repository.snapshotSha);
        assertEquals(
          assignment.input.profile.digest,
          await digestFor(assignment.input.profile.config),
        );
        const standalone = await fixture.authDb.query(
          "select run_step_id from bakery.jobs where organization_id = $1 and id = $2",
          [harness.organizationId, assignment.jobId],
        );
        assertEquals(standalone.rows, [{ run_step_id: null }]);
        await harness.start(assignment);
        const receipt = await receiveInspectionSource(harness, assignment);
        assertEquals(receipt.inputDigest, await digestFor(assignment.input));
        assertEquals(receipt.attemptId, assignment.attemptId);
        assertEquals(receipt.workerHostId, harness.registration.workerHostId);
        const report = await harness.report(assignment.input, receipt);
        if (scenario === "optional-tool-missing") {
          assertEquals(
            report.checks.filter((check) => !check.required).map((check) => ({
              id: check.id,
              status: check.status,
              reason: check.reason,
            })),
            [
              { id: "tool.deno", status: "missing", reason: "tool_missing" },
              { id: "tool.node", status: "missing", reason: "tool_missing" },
            ],
          );
        } else if (scenario === "required-check-failed") {
          // Construct coherent publication inputs, not native execution evidence.
          const nodeVersion = "v22.0.0";
          const nodeDigest = await sha256Hex(`${nodeVersion}\n`);
          const failureDigest = await sha256Hex("fixture syntax failure\n");
          report.host.tools = report.host.tools.map((tool) =>
            tool.tool === "node"
              ? {
                ...tool,
                status: "available" as const,
                version: nodeVersion,
                outputDigest: nodeDigest,
              }
              : tool
          );
          report.checks = report.checks.map((check) =>
            check.template === "node.syntax.v1"
              ? {
                ...check,
                status: "failed" as const,
                reason: "exit_nonzero" as const,
                exitCode: 1,
                outputDigest: failureDigest,
              }
              : check.id === "tool.node"
              ? {
                ...check,
                status: "passed" as const,
                reason: "verified" as const,
                exitCode: 0,
                outputDigest: nodeDigest,
              }
              : check
          );
          assertEquals(
            report.checks.filter((check) =>
              check.required && check.status !== "passed"
            )
              .map(({ template, status, reason, exitCode }) => ({
                template,
                status,
                reason,
                exitCode,
              })),
            [{
              template: "node.syntax.v1",
              status: "failed",
              reason: "exit_nonzero",
              exitCode: 1,
            }],
          );
          assertEquals(
            assignment.input.profile.config.checkPolicy.tools.filter((tool) =>
              tool.required
            ).map((tool) =>
              report.host.tools.find((observed) => observed.tool === tool.tool)
                ?.status
            ),
            ["available", "available"],
          );
        } else if (scenario === "platform-mismatch") {
          assertEquals(report.host.os, "macos");
          assertEquals(
            assignment.input.profile.config.checkPolicy.platform,
            "linux",
          );
          report.checks = report.checks.map((check) =>
            check.template === "source.integrity.v1" ? check : {
              ...check,
              status: "unsupported" as const,
              reason: "platform_mismatch" as const,
              exitCode: null,
              outputDigest: null,
            }
          );
        }
        RepositoryInspectionReportSchema.parse(report);
        const before = await harness.snapshot(
          repository.repositoryId,
          assignment.jobId,
        );
        const key = crypto.randomUUID();
        const result = await harness.result(assignment, report, { key });
        assertEquals(result.status, 200);
        const ack = await result.json();
        const after = await harness.snapshot(
          repository.repositoryId,
          assignment.jobId,
        );
        assertEquals(after.job_status, "completed");
        assertEquals(after.published_profile_id, assignment.input.profile.id);
        assertEquals(
          after.active_profile_id,
          readiness === "eligible"
            ? assignment.input.profile.id
            : repository.baselineProfileId,
        );
        assertEquals(
          after.version,
          Number(before.version) + (readiness === "eligible" ? 1 : 0),
        );
        assertEquals(after.attempts, [{
          id: assignment.attemptId,
          status: "completed",
          result: { localSeq: "2", status: "completed", result: report },
          seq: "2",
        }]);
        assertEquals(after.profiles, [
          {
            id: repository.baselineProfileId,
            revision: 1,
            digest: await digestFor(repository.config),
            config: repository.config,
          },
          {
            id: assignment.input.profile.id,
            revision: 2,
            digest: assignment.input.profile.digest,
            config: assignment.input.profile.config,
          },
        ]);
        const observations = await fixture.authDb.query(
          `select organization_id, application_id, repository_id, profile_id,
                  profile_revision, profile_digest, observation_digest,
                  source_mapping_revision, source_mapping_digest, base_sha, payload, readiness
             from bakery.repository_profile_observations
            where organization_id = $1 and id = $2`,
          [harness.organizationId, after.observation_id],
        );
        const payload = RepositoryProfileObservationPayloadSchema.parse({
          schemaVersion: 1,
          inspectionId: onboarding.id,
          jobId: assignment.jobId,
          organizationId: harness.organizationId,
          applicationId: repository.applicationId,
          repositoryId: repository.repositoryId,
          profileId: assignment.input.profile.id,
          profileRevision: 2,
          profileDigest: assignment.input.profile.digest,
          source: assignment.input.source,
          receipt,
          host: report.host,
          checks: report.checks,
          readiness,
          observedAt: report.completedAt,
        });
        assertEquals(observations.rows, [{
          organization_id: harness.organizationId,
          application_id: repository.applicationId,
          repository_id: repository.repositoryId,
          profile_id: assignment.input.profile.id,
          profile_revision: 2,
          profile_digest: assignment.input.profile.digest,
          observation_digest: await digestFor(payload),
          source_mapping_revision: assignment.input.source.mappingRevision,
          source_mapping_digest: assignment.input.source.mappingDigest,
          base_sha: repository.snapshotSha,
          payload,
          readiness,
        }]);
        assertEquals(after.observations, [{
          id: after.observation_id,
          digest: await digestFor(payload),
          payload,
        }]);
        assertEquals(after.events, [
          {
            type: "job.started",
            payload: (before.events as { payload: unknown }[])[0].payload,
          },
          {
            type: "job.succeeded",
            payload: { localSeq: "2", status: "completed", result: report },
          },
        ]);
        const publicOnboarding = await harness.memberRequest(
          "GET",
          `/v1/repository-onboardings/${onboarding.id}`,
        );
        assertEquals(publicOnboarding.status, 200);
        const completed = contractSchemas.RepositoryOnboarding.parse(
          await publicOnboarding.json(),
        );
        assertEquals(completed.status, "completed");
        assertEquals(completed.profileId, assignment.input.profile.id);
        assertEquals(completed.observationId, after.observation_id);
        const publicObservation = await harness.memberRequest(
          "GET",
          `/v1/repository-profile-observations/${after.observation_id}`,
        );
        assertEquals(publicObservation.status, 200);
        const observed = contractSchemas.RepositoryProfileObservation.parse(
          await publicObservation.json(),
        );
        assertEquals(observed.payload, payload);
        assertEquals(observed.observationDigest, await digestFor(payload));
        const replay = await harness.result(assignment, report, { key });
        assertEquals(replay.status, 200);
        assertEquals(await replay.json(), ack);
        assertEquals(
          await harness.snapshot(repository.repositoryId, assignment.jobId),
          after,
        );
      } finally {
        await harness.close();
      }
    }
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("Projects overlapping publication and starts preserve one immutable pair and the new active baseline", async () => {
  const fixture = await migrateTestDatabase();
  let concurrentPg: PgDatabase | undefined;
  try {
    const database = await fixture.owner`select current_database() as name`;
    const concurrentUrl = new URL(appDatabaseUrl);
    concurrentUrl.pathname = `/${database[0].name}`;
    concurrentPg = openPgDatabase(concurrentUrl.toString(), 3);
    const harness = await openRepositoryInspectionHarness(
      { authDb: fixture.authDb, appPg: concurrentPg },
      fixture.legacyJob,
    );
    const requests: Promise<Response>[] = [];
    try {
      const repository = await harness.createRepository();
      const onboarding = await harness.onboard(repository.repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      await harness.start(assignment);
      const receipt = await receiveInspectionSource(harness, assignment);
      const report = await harness.report(assignment.input, receipt);
      const before = await harness.snapshot(
        repository.repositoryId,
        assignment.jobId,
      );
      const resultKey = crypto.randomUUID();
      await withPgTransaction(fixture.authDb, async (transaction) => {
        const blocker = await transaction.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        );
        const blockingPid = blocker.rows[0].pid;
        await transaction.query(
          `select id from bakery.repositories
            where organization_id = $1 and id = $2 for update`,
          [harness.organizationId, repository.repositoryId],
        );
        const waitForBlockedRequests = async (expected: number) => {
          const deadline = performance.now() + 10_000;
          let waitingPids: number[] = [];
          while (performance.now() < deadline) {
            const waiting = await fixture.owner`
              with recursive blocked(pid) as (
                select pid from pg_stat_activity
                 where datname = current_database()
                   and ${blockingPid} = any(pg_blocking_pids(pid))
                union
                select activity.pid from pg_stat_activity activity
                  join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
                 where activity.datname = current_database()
              ) select pid from blocked`;
            waitingPids = waiting.map((row) => row.pid as number);
            if (waitingPids.length === expected) return;
          }
          throw new Error(
            `INSPECTION_OVERLAP_NOT_OBSERVED:${expected}:${
              JSON.stringify(waitingPids)
            }`,
          );
        };
        requests.push(Promise.resolve(
          harness.result(assignment, report, { key: resultKey }),
        ));
        // Queue publication first, then observe both real starts behind the same lock.
        await waitForBlockedRequests(1);
        for (let index = 0; index < 2; index++) {
          requests.push(Promise.resolve(harness.memberRequest(
            "POST",
            `/v1/repositories/${repository.repositoryId}/onboarding-runs`,
            {},
          )));
        }
        await waitForBlockedRequests(3);
      });
      const [publication, ...starts] = await Promise.all(requests);
      assertEquals(publication.status, 200);
      const acknowledgement = await publication.json();
      assertEquals(starts.map((response) => response.status).sort(), [
        201,
        409,
      ]);
      const conflict = starts.find((response) => response.status === 409)!;
      assertEquals((await conflict.json()).code, "STATE_CONFLICT");
      const fresh = contractSchemas.RepositoryOnboarding.parse(
        await starts.find((response) => response.status === 201)!.json(),
      );
      assertEquals(fresh.status, "queued");
      assertEquals(fresh.id === onboarding.id, false);
      assertEquals(fresh.jobId === assignment.jobId, false);
      assertEquals(fresh.profileId, null);
      assertEquals(fresh.observationId, null);
      const after = await harness.snapshot(
        repository.repositoryId,
        assignment.jobId,
      );
      assertEquals(after.job_status, "completed");
      assertEquals(after.active_profile_id, assignment.input.profile.id);
      assertEquals(after.published_profile_id, assignment.input.profile.id);
      assertEquals(after.version, Number(before.version) + 1);
      assertEquals(after.profiles, [
        ...(before.profiles as unknown[]),
        {
          id: assignment.input.profile.id,
          revision: assignment.input.profile.revision,
          digest: assignment.input.profile.digest,
          config: assignment.input.profile.config,
        },
      ]);
      const observed = contractSchemas.RepositoryProfileObservation.parse(
        await (await harness.memberRequest(
          "GET",
          `/v1/repository-profile-observations/${after.observation_id}`,
        )).json(),
      );
      assertEquals(observed.payload.readiness, "eligible");
      assertEquals(observed.payload.profileId, after.active_profile_id);
      assertEquals(after.observations, [{
        id: after.observation_id,
        digest: await digestFor(observed.payload),
        payload: observed.payload,
      }]);
      const nextJob = await fixture.authDb.query<
        { status: string; input: unknown }
      >(
        `select status, input from bakery.jobs
          where organization_id = $1 and id = $2`,
        [harness.organizationId, fresh.jobId],
      );
      assertEquals(nextJob.rows[0].status, "queued");
      const nextInput = RepositoryInspectionJobInputSchema.parse(
        nextJob.rows[0].input,
      );
      assertEquals(nextInput.baseline, {
        ...assignment.input.baseline,
        profileId: assignment.input.profile.id,
        revision: assignment.input.profile.revision,
        digest: assignment.input.profile.digest,
        repositoryVersion: Number(after.version),
      });
      assertEquals(
        nextInput.profile.revision,
        assignment.input.profile.revision + 1,
      );
      const onboardings = await fixture.authDb.query<
        { id: string; job_id: string }
      >(
        `select id, job_id from bakery.repository_onboardings
          where organization_id = $1 and repository_id = $2 order by id`,
        [harness.organizationId, repository.repositoryId],
      );
      assertEquals(
        onboardings.rows,
        [
          { id: onboarding.id, job_id: assignment.jobId },
          { id: fresh.id, job_id: fresh.jobId },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      const replay = await harness.result(assignment, report, {
        key: resultKey,
      });
      assertEquals(replay.status, 200);
      assertEquals(await replay.json(), acknowledgement);
      assertEquals(
        await harness.snapshot(repository.repositoryId, assignment.jobId),
        after,
      );
    } finally {
      // The blocker is committed/rolled back before draining any pending HTTP work.
      await Promise.allSettled(requests);
      await harness.close();
    }
  } finally {
    if (concurrentPg !== undefined) await closePgDatabase(concurrentPg);
    await fixture.cleanup();
  }
});

Deno.test("Projects expired standalone inspection fails exhausted recovery and permits fresh onboarding", async () => {
  const fixture = await migrateTestDatabase();
  try {
    const harness = await openRepositoryInspectionHarness(
      fixture,
      fixture.legacyJob,
    );
    try {
      const repository = await harness.createRepository();
      const onboarding = await harness.onboard(repository.repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      assertEquals(assignment.jobId, onboarding.jobId);
      await harness.start(assignment);
      const receipt = await receiveInspectionSource(harness, assignment);
      const report = await harness.report(assignment.input, receipt);
      const before = await harness.snapshot(
        repository.repositoryId,
        assignment.jobId,
      );
      const jobBefore = await fixture.authDb.query<
        { version: number; max_attempts: number; run_step_id: string | null }
      >(
        "select version, max_attempts, run_step_id from bakery.jobs where organization_id = $1 and id = $2",
        [harness.organizationId, assignment.jobId],
      );
      assertEquals(jobBefore.rows[0].max_attempts, 1);
      assertEquals(jobBefore.rows[0].run_step_id, null);
      await fixture.authDb.query(
        "update bakery.job_attempts set lease_expires_at = clock_timestamp() - interval '1 second' where organization_id = $1 and id = $2",
        [harness.organizationId, assignment.attemptId],
      );
      const metadata = {
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
      };
      await withPgTransaction(
        fixture.appPg,
        (transaction) =>
          reclaimExpiredAttempts(transaction, harness.organizationId, metadata),
      );
      const after = await harness.snapshot(
        repository.repositoryId,
        assignment.jobId,
      );
      assertEquals(after.job_status, "failed");
      assertEquals(
        after.current_fence,
        (BigInt(assignment.fence) + 1n).toString(),
      );
      assertEquals(after.attempts, [{
        id: assignment.attemptId,
        status: "lost",
        result: null,
        seq: "1",
      }]);
      assertEquals(after.profiles, before.profiles);
      assertEquals(after.observations, before.observations);
      assertEquals(after.active_profile_id, before.active_profile_id);
      assertEquals(after.version, before.version);
      assertEquals(after.published_profile_id, null);
      assertEquals(after.observation_id, null);
      assertEquals(after.source_attempt_id, before.source_attempt_id);
      assertEquals(after.source_next_offset, before.source_next_offset);
      assertEquals(after.events, before.events);
      const version = jobBefore.rows[0].version + 1;
      const updated = await fixture.authDb.query(
        "select version from bakery.jobs where organization_id = $1 and id = $2",
        [harness.organizationId, assignment.jobId],
      );
      assertEquals(updated.rows, [{ version }]);
      const events = await fixture.authDb.query(
        `select application_id, repository_id, task_id, conversation_id,
                aggregate_id, aggregate_version, payload, trace_id
           from bakery.domain_events
          where organization_id = $1 and aggregate_id = $2
            and event_type = 'job.updated' and aggregate_version = $3`,
        [harness.organizationId, assignment.jobId, version],
      );
      assertEquals(events.rows, [{
        application_id: repository.applicationId,
        repository_id: repository.repositoryId,
        task_id: null,
        conversation_id: null,
        aggregate_id: assignment.jobId,
        aggregate_version: version,
        payload: {
          jobId: assignment.jobId,
          attemptId: assignment.attemptId,
          version,
        },
        trace_id: metadata.traceId,
      }]);
      const audits = await fixture.authDb.query(
        `select principal_id, operation, resource_type, resource_id, outcome, details
           from bakery.audit_events
          where organization_id = $1 and request_id = $2 and resource_type = 'job'
            and resource_id = $3`,
        [harness.organizationId, metadata.requestId, assignment.jobId],
      );
      assertEquals(audits.rows, [{
        principal_id: null,
        operation: "jobs.attempt_budget_exhausted",
        resource_type: "job",
        resource_id: assignment.jobId,
        outcome: "succeeded",
        details: { code: "ATTEMPT_BUDGET_EXHAUSTED" },
      }]);
      await withPgTransaction(
        fixture.appPg,
        (transaction) =>
          reclaimExpiredAttempts(transaction, harness.organizationId, metadata),
      );
      assertEquals(
        await harness.snapshot(repository.repositoryId, assignment.jobId),
        after,
      );
      const statusResponse = await harness.memberRequest(
        "GET",
        `/v1/repository-onboardings/${onboarding.id}`,
      );
      assertEquals(statusResponse.status, 200);
      assertEquals(
        contractSchemas.RepositoryOnboarding.parse(await statusResponse.json())
          .status,
        "failed",
      );
      const staleSource = await harness.source(assignment);
      assertEquals(staleSource.status, 409);
      assertEquals((await staleSource.json()).code, "LEASE_FENCED");
      const staleResult = await harness.result(assignment, report);
      assertEquals(staleResult.status, 409);
      assertEquals((await staleResult.json()).code, "LEASE_FENCED");
      assertEquals(
        await harness.snapshot(repository.repositoryId, assignment.jobId),
        after,
      );
      const fresh = await harness.onboard(repository.repositoryId);
      assertEquals(fresh.status, "queued");
      assertEquals(fresh.jobId === onboarding.jobId, false);
      assertEquals(fresh.id === onboarding.id, false);
      const freshState = await harness.snapshot(
        repository.repositoryId,
        fresh.jobId,
      );
      assertEquals(freshState.profiles, before.profiles);
      assertEquals(freshState.observations, before.observations);
      assertEquals(freshState.active_profile_id, before.active_profile_id);

      // Exhaustion alone never authorizes arbitrary standalone jobs.
      for (const action of ["repository.inspect", "harness.implement"]) {
        const jobId = crypto.randomUUID();
        const attemptId = crypto.randomUUID();
        await fixture.authDb.query(
          `insert into bakery.jobs (
             id, organization_id, application_id, repository_id, repository_profile_id,
             repository_profile_revision, repository_profile_digest, action, input, requirements,
             max_attempts, status, current_fence
           ) select $3, organization_id, application_id, repository_id, repository_profile_id,
                    repository_profile_revision, repository_profile_digest, $4, '{}'::jsonb, requirements,
                    1, 'running', 1
               from bakery.jobs where organization_id = $1 and id = $2`,
          [harness.organizationId, assignment.jobId, jobId, action],
        );
        await fixture.authDb.query(
          `insert into bakery.job_attempts (
             id, organization_id, job_id, worker_host_id, worker_session_id,
             worker_session_generation, attempt_no, fence, lease_token_hash,
             lease_expires_at, status
           ) select $3, organization_id, $4, worker_host_id, worker_session_id,
                    worker_session_generation, 1, 1, lease_token_hash,
                    lease_expires_at, 'lost'
               from bakery.job_attempts where organization_id = $1 and id = $2`,
          [harness.organizationId, assignment.attemptId, attemptId, jobId],
        );
        const unbackedBefore = await harness.snapshot(
          repository.repositoryId,
          jobId,
        );
        await withPgTransaction(
          fixture.appPg,
          (transaction) =>
            markJobAttemptBudgetExhausted(
              transaction,
              harness.organizationId,
              jobId,
              attemptId,
              metadata,
            ),
        );
        assertEquals(
          await harness.snapshot(repository.repositoryId, jobId),
          unbackedBefore,
        );
        const unexpectedEffects = await fixture.authDb.query(
          `select
             (select count(*)::integer from bakery.domain_events
               where organization_id = $1 and aggregate_id = $2::uuid) as events,
             (select count(*)::integer from bakery.audit_events
               where organization_id = $1 and resource_type = 'job'
                 and resource_id = $2::text) as audits`,
          [harness.organizationId, jobId],
        );
        assertEquals(unexpectedEffects.rows, [{ events: 0, audits: 0 }]);
      }
    } finally {
      await harness.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("Projects standalone inspection failure and cancellation retain the baseline and release onboarding", async () => {
  for (const status of ["failed", "canceled", "unbacked"] as const) {
    const fixture = await migrateTestDatabase();
    try {
      const harness = await openRepositoryInspectionHarness(
        fixture,
        fixture.legacyJob,
      );
      try {
        const repository = await harness.createRepository();
        const onboarding = await harness.onboard(repository.repositoryId);
        const assignment = await readInspectionAssignment(
          await harness.claim(),
        );
        assertEquals(assignment.jobId, onboarding.jobId);
        await harness.start(assignment);
        if (status === "unbacked") {
          await fixture.owner`
            delete from bakery.repository_onboardings
             where organization_id = ${harness.organizationId}
               and id = ${onboarding.id}
          `;
        }
        const before = await harness.snapshot(
          repository.repositoryId,
          assignment.jobId,
        );
        if (status === "unbacked") {
          const denied = await harness.memberRequest(
            "POST",
            `/v1/execution/attempts/${assignment.attemptId}/control`,
            { action: "cancel" },
          );
          assertEquals(denied.status, 409);
          assertEquals((await denied.json()).code, "STATE_CONFLICT");
          assertEquals(
            await harness.snapshot(repository.repositoryId, assignment.jobId),
            before,
          );
          const commands = await fixture.authDb.query<{ count: number }>(
            `select count(*)::integer as count from bakery.worker_commands
              where organization_id = $1 and attempt_id = $2`,
            [harness.organizationId, assignment.attemptId],
          );
          assertEquals(commands.rows, [{ count: 0 }]);
          continue;
        }
        if (status === "failed") {
          const response = await harness.workerRequest(
            `/v1/worker/attempts/${assignment.attemptId}/result`,
            {
              leaseToken: assignment.leaseToken,
              fence: assignment.fence,
              localSeq: "2",
              status,
              fault: {
                type: "about:blank",
                title: "Native worker action failed",
                status: 500,
                detail: "Inspection exceeded its boundary.",
                code: "INSPECTION_BOUNDED_FAILURE",
                requestId: crypto.randomUUID(),
                retryable: false,
              },
            },
          );
          assertEquals(response.status, 200);
          assertEquals(
            contractSchemas.WorkerAck.parse(await response.json()).status,
            "applied",
          );
        } else {
          const response = await harness.memberRequest(
            "POST",
            `/v1/execution/attempts/${assignment.attemptId}/control`,
            { action: "cancel" },
          );
          assertEquals(response.status, 202);
          const pending = await fixture.authDb.query<{
            cancellation: { processExited: boolean; cleanupStatus: string };
          }>(
            `select result->'cancellation' as cancellation
               from bakery.job_attempts
              where organization_id = $1 and id = $2`,
            [harness.organizationId, assignment.attemptId],
          );
          assertEquals(pending.rows[0].cancellation.processExited, false);
          assertEquals(pending.rows[0].cancellation.cleanupStatus, "pending");
          const cleanup = await harness.workerRequest(
            `/v1/worker/attempts/${assignment.attemptId}/cleanup`,
            {
              fence: assignment.fence,
              observedByWorkerSessionId: harness.registration.workerSessionId,
              observedByWorkerSessionGeneration:
                harness.registration.workerSessionGeneration,
              exitedAt: new Date().toISOString(),
            },
          );
          assertEquals(cleanup.status, 200);
          const acknowledged = await cleanup.json();
          assertEquals(acknowledged.attemptId, assignment.attemptId);
          assertEquals(acknowledged.status, "canceled");
          assertEquals(acknowledged.cancellation.processExited, true);
          assertEquals(acknowledged.cancellation.cleanupStatus, "complete");
          assertEquals(
            acknowledged.cancellation.terminationStatus,
            "confirmed",
          );
          const events = await fixture.authDb.query<{
            application_id: string;
            repository_id: string;
          }>(
            `select event.application_id, event.repository_id
               from bakery.domain_events event
               join bakery.jobs job
                 on job.organization_id = event.organization_id
                and job.id = event.aggregate_id
                and job.version = event.aggregate_version
              where event.organization_id = $1 and event.aggregate_id = $2
                and event.event_type = 'job.updated' and job.status = 'canceled'`,
            [harness.organizationId, assignment.jobId],
          );
          assertEquals(events.rows, [{
            application_id: repository.applicationId,
            repository_id: repository.repositoryId,
          }]);
        }
        const terminalResponse = await harness.memberRequest(
          "GET",
          `/v1/repository-onboardings/${onboarding.id}`,
        );
        assertEquals(terminalResponse.status, 200);
        const terminal = contractSchemas.RepositoryOnboarding.parse(
          await terminalResponse.json(),
        );
        assertEquals(terminal.status, status);
        assertEquals(terminal.profileId, null);
        assertEquals(terminal.observationId, null);
        const after = await harness.snapshot(
          repository.repositoryId,
          assignment.jobId,
        );
        assertEquals(after.job_status, status);
        assertEquals(after.profiles, before.profiles);
        assertEquals(after.observations, before.observations);
        assertEquals(after.active_profile_id, repository.baselineProfileId);
        assertEquals((await harness.source(assignment)).status, 409);
        assertEquals(
          (await harness.onboard(repository.repositoryId)).status,
          "queued",
        );
      } finally {
        await harness.close();
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

Deno.test("Observed task/run/job pins survive reinspection and incapable authenticated hosts cannot claim", async () => {
  const fixture = await migrateTestDatabase();
  let concurrentPg: PgDatabase | undefined;
  let lockObserver: ReturnType<typeof openDatabase> | undefined;
  try {
    const database = await fixture.owner`select current_database() as name`;
    const concurrentUrl = new URL(appDatabaseUrl);
    concurrentUrl.pathname = `/${database[0].name}`;
    const pool = openPgDatabase(concurrentUrl.toString(), 3);
    concurrentPg = pool;
    const { database: appPg, faults } = recordPgFaults(pool);
    // What a 503 under the lock needs to be told apart: queued callers, or a
    // connection failure the problem body does not name.
    const poolState = () =>
      `pool total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount} faults=${
        JSON.stringify(faults)
      }`;
    const observerUrl = new URL(adminDatabaseUrl);
    observerUrl.pathname = `/${database[0].name}`;
    lockObserver = openDatabase(observerUrl.toString(), 1);
    const observer = lockObserver;
    const harness = await openRepositoryInspectionHarness(
      { authDb: fixture.authDb, appPg },
      fixture.legacyJob,
    );
    try {
      const source = await harness.createRepository(true);
      // Transaction-boundary reports exercise publication and execution admission;
      // these manufactured Node outcomes are not native inspection proof.
      const preparePublish = async () => {
        const onboarding = await harness.onboard(source.repositoryId);
        const assignment = await readInspectionAssignment(
          await harness.claim(),
        );
        assertEquals(assignment.jobId, onboarding.jobId);
        await harness.start(assignment);
        const receipt = await receiveInspectionSource(harness, assignment);
        const report = await harness.report(assignment.input, receipt);
        const nodeDigest = await digestFor(
          "transaction-boundary node evidence",
        );
        const node = report.host.tools.find((tool) => tool.tool === "node");
        if (!node) throw new Error("NODE_POLICY_MISSING");
        node.status = "available";
        node.version = "Node transaction fixture";
        node.outputDigest = nodeDigest;
        for (
          const check of assignment.input.profile.config.checkPolicy.checks
        ) {
          if (check.tool !== "node") continue;
          const outcome = report.checks.find((outcome) =>
            outcome.id === check.id
          );
          if (!outcome) throw new Error("NODE_CHECK_MISSING");
          outcome.status = "passed";
          outcome.reason = "verified";
          outcome.exitCode = 0;
          outcome.outputDigest = nodeDigest;
        }
        return async () => {
          const result = await harness.result(assignment, report);
          assertEquals(
            result.status,
            200,
            `${await result.clone().text()} ${poolState()}`,
          );
          const response = await harness.memberRequest(
            "GET",
            `/v1/repository-onboardings/${onboarding.id}`,
          );
          assertEquals(response.status, 200);
          const published = contractSchemas.RepositoryOnboarding.parse(
            await response.json(),
          );
          if (!published.observationId || !published.profileId) {
            throw new Error("PUBLICATION_MISSING");
          }
          const observationResponse = await harness.memberRequest(
            "GET",
            `/v1/repository-profile-observations/${published.observationId}`,
          );
          assertEquals(observationResponse.status, 200);
          const observation = contractSchemas.RepositoryProfileObservation
            .parse(
              await observationResponse.json(),
            );
          const payload = RepositoryProfileObservationPayloadSchema.parse(
            observation.payload,
          );
          assertEquals(payload.readiness, "eligible");
          assertEquals(
            payload.host.tools.find((tool) => tool.tool === "deno")?.status,
            "missing",
          );
          return { ...observation, payload };
        };
      };
      const publish = async () => await (await preparePublish())();
      const original = await publish();
      const pins = {
        repositoryProfileId: original.profileId,
        repositoryProfileRevision: original.payload.profileRevision,
        repositoryProfileDigest: original.profileDigest,
        observationId: original.id,
        observationDigest: original.observationDigest,
        baseSha: original.baseSha,
      };
      const taskDurableState = async (taskId: string) => {
        const [state] = await fixture.owner`
          with selected_runs as (
            select * from bakery.workflow_runs where task_id = ${taskId}
          ), selected_steps as (
            select step.* from bakery.run_steps step
              join selected_runs run on run.id = step.run_id
          ), selected_jobs as (
            select job.* from bakery.jobs job
              join selected_steps step on step.id = job.run_step_id
          )
          select
            (select to_jsonb(task) from bakery.tasks task
              where task.id = ${taskId}) as task,
            coalesce((select jsonb_agg(to_jsonb(run) order by run.id)
              from selected_runs run), '[]'::jsonb) as runs,
            coalesce((select jsonb_agg(to_jsonb(step) order by step.id)
              from selected_steps step), '[]'::jsonb) as steps,
            coalesce((select jsonb_agg(to_jsonb(job) order by job.id)
              from selected_jobs job), '[]'::jsonb) as jobs,
            coalesce((select jsonb_agg(to_jsonb(attempt) order by attempt.id)
              from bakery.job_attempts attempt join selected_jobs job
                on job.id = attempt.job_id), '[]'::jsonb) as attempts,
            coalesce((select jsonb_agg(to_jsonb(event)
                                      order by event.organization_sequence)
              from bakery.domain_events event
             where event.task_id = ${taskId}
                or event.aggregate_id in (select id from selected_runs)
                or event.aggregate_id in (select id from selected_steps)
                or event.aggregate_id in (select id from selected_jobs)),
              '[]'::jsonb) as events,
            coalesce((select jsonb_agg(to_jsonb(outbox) order by outbox.id)
              from bakery.outbox outbox join bakery.domain_events event
                on event.id = outbox.event_id
             where event.task_id = ${taskId}), '[]'::jsonb) as outbox,
            coalesce((select jsonb_agg(to_jsonb(audit) order by audit.id)
              from bakery.audit_events audit
             where audit.organization_id = ${harness.organizationId}
               and audit.operation = 'runs.create'),
              '[]'::jsonb) as audit_events,
            coalesce((select jsonb_agg(to_jsonb(record) order by record.id)
              from bakery.idempotency_records record
             where record.organization_id = ${harness.organizationId}
               and record.operation = 'runs.create'),
              '[]'::jsonb) as idempotency_records`;
        return state;
      };
      for (const alias of ["primary", "shared"]) {
        const binding = await harness.memberRequest(
          "POST",
          `/v1/applications/${source.applicationId}/roles`,
          {
            applicationId: source.applicationId,
            repositoryId: source.repositoryId,
            role: "source",
            alias,
          },
        );
        assertEquals(binding.status, 201);
      }
      for (
        const selector of [{ repositoryId: source.repositoryId }, {
          role: "source",
          alias: "primary",
        }, { aliases: ["primary", "shared"] }]
      ) {
        const response = await harness.memberRequest(
          "POST",
          `/v1/applications/${source.applicationId}/roles/resolve`,
          selector,
        );
        assertEquals(response.status, 201, await response.clone().text());
        const resolved = contractSchemas.RepositoryBindingResolution.parse(
          await response.json(),
        );
        const expectedResolution: Awaited<
          ReturnType<typeof resolveRepositoryBinding>
        > = {
          status: "resolved",
          binding: {
            organizationId: harness.organizationId,
            applicationId: source.applicationId,
            repositoryId: source.repositoryId,
            ...pins,
          },
        };
        assertEquals(resolved, expectedResolution);
      }
      const created = await harness.memberRequest("POST", "/v1/tasks", {
        applicationId: source.applicationId,
        repositoryId: source.repositoryId,
        taskType: "feature",
        title: "Frozen observed task",
      });
      assertEquals(created.status, 201, await created.clone().text());
      const task = contractSchemas.Task.parse(await created.json());
      for (const [key, value] of Object.entries(pins)) {
        assertEquals((task as Record<string, unknown>)[key], value);
      }
      const staleCreated = await harness.memberRequest("POST", "/v1/tasks", {
        applicationId: source.applicationId,
        repositoryId: source.repositoryId,
        taskType: "feature",
        title: "Frozen observed task awaiting admission",
      });
      assertEquals(staleCreated.status, 201);
      const staleTask = contractSchemas.Task.parse(await staleCreated.json());
      for (const [key, value] of Object.entries(pins)) {
        assertEquals((staleTask as Record<string, unknown>)[key], value);
      }

      const workflowId = crypto.randomUUID();
      const workflowVersionId = crypto.randomUUID();
      const spec = {
        apiVersion: "bakery.dev/v1",
        kind: "workflow",
        name: "observed-execution",
        steps: [{
          id: "required_checks",
          uses: "quality.check",
          with: {
            repositoryId: "$task.repositoryId",
            revision: "$input.revision",
            checks: "$input.checks",
          },
        }],
      };
      await fixture.owner`
        insert into bakery.workflow_definitions (id, organization_id, slug, name, description)
        values (${workflowId}, ${harness.organizationId}, 'observed-execution', 'Observed execution', '')`;
      await fixture.owner`
        insert into bakery.workflow_versions (id, organization_id, workflow_id, revision, source_yaml, normalized_spec, digest, status, created_by)
        values (${workflowVersionId}, ${harness.organizationId}, ${workflowId}, 1, '', ${
        fixture.owner.json(spec)
      }, ${await digestFor(
        spec,
      )}, 'published', ${fixture.legacyJob.principalId})`;
      await fixture.owner`
        update bakery.workflow_definitions set active_version_id = ${workflowVersionId}
        where organization_id = ${harness.organizationId} and id = ${workflowId}`;
      const runInput = {
        workflowVersionId,
        repositoryProfileId: original.profileId,
        executionMode: "repository",
        budgetLimitUsd: "0.005000",
        inputs: { revision: source.snapshotSha, checks: ["source.integrity"] },
      };
      // Establish the historical run while its immutable profile is current.
      const runKey = crypto.randomUUID();
      const runResponse = await harness.memberRequest(
        "POST",
        `/v1/tasks/${task.id}/runs`,
        runInput,
        harness.organizationId,
        { "Idempotency-Key": runKey },
      );
      assertEquals(runResponse.status, 201);
      const runResponseBytes = await runResponse.clone().text();
      const run = contractSchemas.Run.parse(await runResponse.json());
      for (const [key, value] of Object.entries(pins)) {
        assertEquals((run as Record<string, unknown>)[key], value);
      }

      const newer = await publish();
      assertEquals(
        newer.payload.profileRevision,
        original.payload.profileRevision + 1,
      );
      assertEquals(newer.profileId === original.profileId, false);
      const updated = await harness.app.fetch(
        new Request(`http://inspection.test/v1/tasks/${staleTask.id}`, {
          method: "PATCH",
          headers: {
            "Bakery-Organization-Id": harness.organizationId,
            "content-type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
            "If-Match": `"${staleTask.version}"`,
          },
          body: JSON.stringify({ title: "Edited without repinning" }),
        }),
      );
      assertEquals(updated.status, 200);
      const edited = contractSchemas.Task.parse(await updated.json());
      for (const [key, value] of Object.entries(pins)) {
        assertEquals((edited as Record<string, unknown>)[key], value);
      }
      const repin = await harness.memberRequest(
        "POST",
        `/v1/tasks/${staleTask.id}/runs`,
        { ...runInput, repositoryProfileId: newer.profileId },
      );
      assertEquals(repin.status, 409);
      assertEquals((await repin.json()).code, "STATE_CONFLICT");
      const staleRun = await harness.memberRequest(
        "POST",
        `/v1/tasks/${staleTask.id}/runs`,
        runInput,
      );
      assertEquals(staleRun.status, 409);
      assertEquals((await staleRun.json()).code, "STATE_CONFLICT");
      assertEquals(
        (await fixture.owner`
          select id from bakery.workflow_runs
           where task_id = ${staleTask.id}`).length,
        0,
      );
      const replay = await harness.memberRequest(
        "POST",
        `/v1/tasks/${task.id}/runs`,
        runInput,
        harness.organizationId,
        { "Idempotency-Key": runKey },
      );
      assertEquals(replay.status, 201);
      assertEquals(await replay.text(), runResponseBytes);
      const changedReplay = await harness.memberRequest(
        "POST",
        `/v1/tasks/${task.id}/runs`,
        { ...runInput, budgetLimitUsd: "0.006000" },
        harness.organizationId,
        { "Idempotency-Key": runKey },
      );
      assertEquals(changedReplay.status, 422);
      assertEquals(
        (await changedReplay.json()).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );
      const foreignReplay = await harness.memberRequest(
        "POST",
        `/v1/tasks/${task.id}/runs`,
        runInput,
        crypto.randomUUID(),
        { "Idempotency-Key": runKey },
      );
      assertEquals(foreignReplay.status, 404);
      assertEquals((await foreignReplay.json()).code, "RESOURCE_NOT_FOUND");
      await fixture.owner`
        update bakery.organization_memberships set status = 'inactive'
         where organization_id = ${harness.organizationId}
           and principal_id = ${fixture.legacyJob.principalId}`;
      const revokedReplay = await harness.memberRequest(
        "POST",
        `/v1/tasks/${task.id}/runs`,
        runInput,
        harness.organizationId,
        { "Idempotency-Key": runKey },
      );
      assertEquals(revokedReplay.status, 404);
      assertEquals((await revokedReplay.json()).code, "RESOURCE_NOT_FOUND");
      await fixture.owner`
        update bakery.organization_memberships set status = 'active'
         where organization_id = ${harness.organizationId}
           and principal_id = ${fixture.legacyJob.principalId}`;

      const raceTaskResponse = await harness.memberRequest(
        "POST",
        "/v1/tasks",
        {
          applicationId: source.applicationId,
          repositoryId: source.repositoryId,
          taskType: "feature",
          title: "Controlled current-policy publication race",
        },
      );
      assertEquals(raceTaskResponse.status, 201);
      const raceTask = contractSchemas.Task.parse(
        await raceTaskResponse.json(),
      );
      assertEquals(raceTask.repositoryProfileId, newer.profileId);
      const beforeRace = await taskDurableState(raceTask.id);
      const commitPublication = await preparePublish();
      let publicationPromise: ReturnType<typeof commitPublication> | undefined;
      let racePromise: Promise<Response> | undefined;
      // Both requests are observed from creation: one that fails or answers
      // while the test still holds the lock fails this test with its own
      // outcome, not as an unhandled rejection that cancels the rest of the
      // module.
      const underLock: {
        name: string;
        request: Promise<unknown>;
        done: () => boolean;
      }[] = [];
      const startUnderLock = <T>(name: string, request: Promise<T>) => {
        underLock.push({ name, request, done: settled(request) });
        return request;
      };
      await withPgTransaction(fixture.authDb, async (transaction) => {
        const [{ pid: blockingPid }] = (await transaction.query<{
          pid: number;
        }>("select pg_backend_pid() as pid")).rows;
        await transaction.query(
          `select id from bakery.applications
            where organization_id = $1 and id = $2 for update`,
          [harness.organizationId, source.applicationId],
        );
        const waitForBlockedRequests = async (expected: number) => {
          const deadline = performance.now() + 10_000;
          let observed: { pid: number; query: string }[] = [];
          while (performance.now() < deadline) {
            for (const { name, request, done } of underLock) {
              if (!done()) continue;
              // It did not wait on the lock; its own outcome says why.
              const outcome = await request;
              throw new Error(
                `CURRENT_POLICY_${name}_SETTLED_UNDER_LOCK:${
                  outcome instanceof Response
                    ? `${outcome.status} ${await outcome.clone().text()}`
                    : "resolved"
                } ${poolState()}`,
              );
            }
            observed = await observer`
              with recursive blocked(pid) as (
                select pid from pg_stat_activity
                 where datname = current_database()
                   and ${blockingPid} = any(pg_blocking_pids(pid))
                union
                select activity.pid from pg_stat_activity activity
                  join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
                 where activity.datname = current_database()
              )
              select activity.pid, lower(activity.query) as query
                from pg_stat_activity activity join blocked using (pid)
               order by activity.pid` as { pid: number; query: string }[];
            if (observed.length === expected) return observed;
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          throw new Error(
            `CURRENT_POLICY_LOCK_WAITERS_NOT_OBSERVED:${expected}:${
              JSON.stringify(observed)
            } ${poolState()}`,
          );
        };
        publicationPromise = startUnderLock("PUBLICATION", commitPublication());
        const publicationWaiters = await waitForBlockedRequests(1);
        assertEquals(
          publicationWaiters[0].query.includes("for share of a"),
          true,
        );
        racePromise = startUnderLock(
          "RACE",
          Promise.resolve(harness.memberRequest(
            "POST",
            `/v1/tasks/${raceTask.id}/runs`,
            { ...runInput, repositoryProfileId: newer.profileId },
          )),
        );
        const orderedWaiters = await waitForBlockedRequests(2);
        assertEquals(
          orderedWaiters.some((waiter) =>
            waiter.query.includes("bakery.applications") &&
            waiter.query.includes("for update")
          ),
          true,
        );
      });
      if (!publicationPromise || !racePromise) {
        throw new Error("CURRENT_POLICY_RACE_NOT_STARTED");
      }
      const racePublication = await publicationPromise;
      const raceResponse = await racePromise;
      assertEquals(
        raceResponse.status,
        409,
        `${await raceResponse.clone().text()} ${poolState()}`,
      );
      assertEquals((await raceResponse.json()).code, "STATE_CONFLICT");
      assertEquals(await taskDurableState(raceTask.id), beforeRace);
      assertEquals(racePublication.profileId === newer.profileId, false);

      // A task pinned while the trusted profile is current must not fall back
      // when the repository pointer is moved to an unobserved pending/invalid
      // profile. Both denials must leave every durable command table unchanged.
      const currentProfileId = racePublication.profileId;
      const [currentProfile] = await fixture.owner`
        select revision, config, digest from bakery.repository_profiles
         where id = ${currentProfileId}`;
      const currentTaskResponse = await harness.memberRequest(
        "POST",
        "/v1/tasks",
        {
          applicationId: source.applicationId,
          repositoryId: source.repositoryId,
          taskType: "feature",
          title: "Current policy pending and invalid denial",
        },
      );
      assertEquals(currentTaskResponse.status, 201);
      const currentTask = contractSchemas.Task.parse(
        await currentTaskResponse.json(),
      );
      assertEquals(currentTask.repositoryProfileId, currentProfileId);
      const pendingProfileId = crypto.randomUUID();
      const pendingRevision = Number(currentProfile.revision) + 1;
      await fixture.owner`
        insert into bakery.repository_profiles (
          id, organization_id, application_id, repository_id, revision,
          config, digest, created_by
        ) values (
          ${pendingProfileId}, ${harness.organizationId}, ${source.applicationId},
          ${source.repositoryId}, ${pendingRevision}, ${currentProfile.config},
          ${currentProfile.digest}, ${fixture.legacyJob.principalId}
        )`;
      const invalidProfileId = crypto.randomUUID();
      const invalidConfig = {
        ...fixedPolicyProfileConfig,
        worktree: { root: "" },
      };
      const invalidRevision = pendingRevision + 1;
      await fixture.owner`
        insert into bakery.repository_profiles (
          id, organization_id, application_id, repository_id, revision,
          config, digest, created_by
        ) values (
          ${invalidProfileId}, ${harness.organizationId}, ${source.applicationId},
          ${source.repositoryId}, ${invalidRevision}, ${
        fixture.owner.json(invalidConfig)
      },
          ${await digestFor(invalidConfig)}, ${fixture.legacyJob.principalId}
        )`;
      const currentRunInput = {
        workflowVersionId,
        repositoryProfileId: currentProfileId,
        executionMode: "repository",
        budgetLimitUsd: "0.005000",
        inputs: { revision: source.snapshotSha, checks: ["source.integrity"] },
      };
      for (
        const [label, profileId] of [["pending", pendingProfileId], [
          "invalid",
          invalidProfileId,
        ]] as const
      ) {
        await fixture.owner`
          update bakery.repositories
             set active_profile_id = ${profileId}, version = version + 1
           where id = ${source.repositoryId}`;
        const beforeDenied = await taskDurableState(currentTask.id);
        const denied = await harness.memberRequest(
          "POST",
          `/v1/tasks/${currentTask.id}/runs`,
          currentRunInput,
          harness.organizationId,
          { "Idempotency-Key": crypto.randomUUID() },
        );
        assertEquals(denied.status, 409, `${label} current profile`);
        assertEquals((await denied.json()).code, "STATE_CONFLICT");
        assertEquals(await taskDurableState(currentTask.id), beforeDenied);
      }
      await fixture.owner`
        update bakery.repositories
           set active_profile_id = ${currentProfileId}, version = version + 1
         where id = ${source.repositoryId}`;

      const storedRun = (await fixture
        .owner`select snapshot from bakery.workflow_runs where id = ${run.id}`)[
          0
        ]!;
      const context = storedRun.snapshot.repositoryProfile;
      assertEquals(context, {
        organizationId: harness.organizationId,
        applicationId: source.applicationId,
        repositoryId: source.repositoryId,
        id: original.profileId,
        revision: original.payload.profileRevision,
        digest: original.profileDigest,
        config: (await fixture
          .owner`select config from bakery.repository_profiles where id = ${original.profileId}`)[
            0
          ]!.config,
        observationId: original.id,
        observationDigest: original.observationDigest,
        baseSha: source.snapshotSha,
        // Pinned empty baseline: no organization rules, no overrides.
        repositoryRules: {
          organizationRevision: 0,
          profileId: original.profileId,
          profileRevision: original.payload.profileRevision,
          entries: [],
          digest:
            "29b63ecc492e00756b31919bc5c780cca04a908684a519265743512a08406a1d",
        },
      });
      const adapter = createBakeryPostgresWorkflowRepository({
        database: fixture.appPg,
        maxAttempts: 2,
      });
      const key = await adapter.findNext(run.id);
      if (!key) throw new Error("OBSERVED_LOGICAL_KEY_MISSING");
      const owner = await adapter.acquireEngineOwner(
        run.id,
        crypto.randomUUID(),
        60_000,
      );
      if (!owner) throw new Error("OBSERVED_OWNER_MISSING");
      const forgedSnapshot = structuredClone(storedRun.snapshot);
      forgedSnapshot.repositoryProfile.organizationId = crypto.randomUUID();
      await fixture.owner`update bakery.workflow_runs set snapshot = ${
        fixture.owner.json(forgedSnapshot)
      } where id = ${run.id}`;
      await assertRejects(() => adapter.admit(key, owner));
      assertEquals(
        (await fixture
          .owner`select id from bakery.jobs where run_step_id in (select id from bakery.run_steps where run_id = ${run.id})`)
          .length,
        0,
      );
      assertEquals(
        (await fixture
          .owner`select status from bakery.run_steps where run_id = ${run.id}`)[
            0
          ]?.status,
        "pending",
      );
      await fixture.owner`update bakery.workflow_runs set snapshot = ${
        fixture.owner.json(storedRun.snapshot)
      } where id = ${run.id}`;
      const executionState = async () =>
        await fixture.owner`
          select to_jsonb(run) as run, to_jsonb(step) as step, to_jsonb(job) as job,
            (select jsonb_agg(to_jsonb(attempt) order by attempt.id)
               from bakery.job_attempts attempt
              where attempt.organization_id = run.organization_id and attempt.job_id = job.id) as attempts,
            (select jsonb_agg(to_jsonb(event) order by event.organization_sequence)
               from bakery.domain_events event
              where event.organization_id = run.organization_id
                and event.aggregate_id in (run.id, step.id, job.id)) as events
          from bakery.workflow_runs run
          join bakery.run_steps step on step.organization_id = run.organization_id and step.run_id = run.id
          left join bakery.jobs job on job.organization_id = step.organization_id and job.run_step_id = step.id
          where run.id = ${run.id} order by step.id, job.id`;
      const nearLimitSnapshot = structuredClone(storedRun.snapshot);
      const emptyCaller = {
        repositoryId: source.repositoryId,
        revision: "",
        checks: ["source.integrity"],
      };
      const callerBytes =
        new TextEncoder().encode(canonicalJson(emptyCaller)).length;
      const nearLimitCaller = {
        ...emptyCaller,
        revision: "é".repeat(40_000) +
          "a".repeat(100_000 - callerBytes - 80_000),
      };
      contractSchemas.CheckInput.parse(nearLimitCaller);
      assertEquals(
        new TextEncoder().encode(canonicalJson(nearLimitCaller)).length,
        100_000,
      );
      assertEquals(
        new TextEncoder().encode(canonicalJson({
          ...nearLimitCaller,
          repositoryProfile: context,
        })).length > 100_000,
        true,
      );
      nearLimitSnapshot.inputs.revision = nearLimitCaller.revision;
      await fixture.owner`update bakery.workflow_runs set snapshot = ${
        fixture.owner.json(nearLimitSnapshot)
      } where id = ${run.id}`;
      const beforeOversizedAdmission = await executionState();
      await assertRejects(() => adapter.admit(key, owner));
      assertEquals(await executionState(), beforeOversizedAdmission);
      await fixture.owner`update bakery.workflow_runs set snapshot = ${
        fixture.owner.json(storedRun.snapshot)
      } where id = ${run.id}`;
      const admission = await adapter.admit(key, owner);
      if (!admission.jobId) throw new Error("OBSERVED_JOB_MISSING");
      const job = (await fixture
        .owner`select * from bakery.jobs where id = ${admission.jobId}`)[0]!;
      assertEquals(job.input.repositoryProfile, context);
      assertEquals(job.input.repositoryId, source.repositoryId);
      assertEquals(job.input.revision, source.snapshotSha);
      assertEquals(job.input.checks, ["source.integrity"]);
      assertEquals(job.requirements, {
        capabilities: ["git", "shell", "browser", "node"],
        platform: "linux",
      });
      assertEquals([
        job.repository_profile_id,
        job.repository_profile_revision,
        job.repository_profile_digest,
        job.observation_id,
        job.observation_digest,
        job.base_sha,
      ], [
        pins.repositoryProfileId,
        pins.repositoryProfileRevision,
        pins.repositoryProfileDigest,
        pins.observationId,
        pins.observationDigest,
        pins.baseSha,
      ]);
      assertEquals((await adapter.admit(key, owner)).jobId, admission.jobId);
      for (const defect of ["revision", "action", "transport-size"] as const) {
        const substitutedInput = structuredClone(job.input);
        let substitutedAction = job.action;
        const substitutedSnapshot = structuredClone(storedRun.snapshot);
        if (defect === "revision") substitutedInput.revision = "b".repeat(40);
        if (defect === "action") substitutedAction = "mcp.discover";
        if (defect === "transport-size") {
          substitutedInput.revision = nearLimitCaller.revision;
          substitutedSnapshot.inputs.revision = nearLimitCaller.revision;
        }
        await fixture.owner`update bakery.workflow_runs set snapshot = ${
          fixture.owner.json(substitutedSnapshot)
        } where id = ${run.id}`;
        await fixture
          .owner`update bakery.jobs set action = ${substitutedAction}, input = ${
          fixture.owner.json(substitutedInput)
        } where id = ${admission.jobId}`;
        const beforeReuse = await executionState();
        await assertRejects(() => adapter.admit(key, owner));
        await assertRejects(() =>
          withPgTransaction(
            fixture.appPg,
            (transaction) =>
              admitRepositoryExecutionJob(
                transaction,
                harness.organizationId,
                admission.jobId!,
              ),
          )
        );
        assertEquals(await executionState(), beforeReuse);
      }
      await fixture.owner`update bakery.workflow_runs set snapshot = ${
        fixture.owner.json(storedRun.snapshot)
      } where id = ${run.id}`;
      await fixture
        .owner`update bakery.jobs set action = ${job.action}, input = ${
        fixture.owner.json(job.input)
      } where id = ${admission.jobId}`;
      await adapter.releaseEngineOwner(owner);
      const hostId = harness.registration.workerHostId;
      const capabilities = ["git", "shell", "browser", "node"];
      const claim = async (requested: string[]) => {
        const claimKey = crypto.randomUUID();
        return await harness.workerRequest("/v1/worker/claims", {
          claimKey,
          workerHostId: hostId,
          capabilities: requested,
          supportedActions: ["quality.check"],
        }, claimKey);
      };
      await fixture.owner`update bakery.worker_hosts set capabilities = ${
        fixture.owner.json(["git", "shell", "browser"])
      } where id = ${hostId}`;
      assertEquals((await claim(["git", "shell", "browser"])).status, 204);
      assertEquals((await claim(capabilities)).status, 403);
      await fixture.owner`update bakery.worker_hosts set capabilities = ${
        fixture.owner.json(capabilities)
      }, os = 'macos' where id = ${hostId}`;
      assertEquals((await claim(capabilities)).status, 204);
      await fixture
        .owner`update bakery.worker_hosts set os = 'linux' where id = ${hostId}`;
      const wrongRevision = { ...job.input, revision: "b".repeat(40) };
      await fixture.owner`update bakery.jobs set input = ${
        fixture.owner.json(wrongRevision)
      } where id = ${admission.jobId}`;
      const beforeDeniedClaim = await executionState();
      assertEquals((await claim(capabilities)).status, 204);
      assertEquals(await executionState(), beforeDeniedClaim);
      const forgedInput = structuredClone(job.input);
      forgedInput.repositoryProfile.repositoryId = crypto.randomUUID();
      await fixture.owner`update bakery.jobs set input = ${
        fixture.owner.json(forgedInput)
      } where id = ${admission.jobId}`;
      assertEquals((await claim(capabilities)).status, 204);
      assertEquals(
        (await fixture
          .owner`select id from bakery.job_attempts where job_id = ${admission.jobId}`)
          .length,
        0,
      );
      await fixture.owner`update bakery.jobs set input = ${
        fixture.owner.json(job.input)
      }, requirements = '{"capabilities":[]}'::jsonb where id = ${admission.jobId}`;
      assertEquals((await claim(capabilities)).status, 204);
      assertEquals(
        (await fixture
          .owner`select status from bakery.jobs where id = ${admission.jobId}`)[
            0
          ]?.status,
        "queued",
      );
      await fixture.owner`update bakery.jobs set requirements = ${
        fixture.owner.json(job.requirements)
      } where id = ${admission.jobId}`;

      // A second same-application repository stays ambiguous even though only
      // the original repository has eligible observation evidence.
      const otherResponse = await harness.memberRequest(
        "POST",
        "/v1/repositories",
        {
          applicationId: source.applicationId,
          slug: "ambiguous-baseline",
          integrationConnectionId: crypto.randomUUID(),
          providerRepoId: crypto.randomUUID(),
          owner: "inspection",
          name: "ambiguous-baseline",
          defaultBranch: "main",
        },
      );
      assertEquals(otherResponse.status, 201);
      const other = await otherResponse.json() as { id: string };
      assertEquals(
        (await harness.memberRequest(
          "POST",
          `/v1/repositories/${other.id}/profiles`,
          {
            revision: 1,
            config: source.config,
            digest: await digestFor(source.config),
          },
        )).status,
        201,
      );
      assertEquals(
        (await harness.memberRequest(
          "POST",
          `/v1/applications/${source.applicationId}/roles`,
          {
            applicationId: source.applicationId,
            repositoryId: other.id,
            role: "source",
            alias: "shared",
          },
        )).status,
        201,
      );
      const ambiguity = await harness.memberRequest(
        "POST",
        `/v1/applications/${source.applicationId}/roles/resolve`,
        { aliases: ["shared", "primary"] },
      );
      assertEquals(ambiguity.status, 201, await ambiguity.clone().text());
      const resolution = contractSchemas.RepositoryBindingResolution.parse(
        await ambiguity.json(),
      ) as Awaited<ReturnType<typeof resolveRepositoryBinding>>;
      assertEquals(resolution.status, "ambiguous");
      if (resolution.status !== "ambiguous") throw new Error("AMBIGUITY_LOST");
      assertEquals(
        resolution.candidates.map((candidate) =>
          candidate.hasEligibleObservation
        ).sort(),
        [false, true],
      );
      assertEquals(
        resolution.candidates.map((candidate) => candidate.repositoryId).sort(),
        [source.repositoryId, other.id].sort(),
      );
      const foreign = await withPgTransaction(
        fixture.appPg,
        (transaction) =>
          resolveRepositoryBinding(
            transaction,
            harness.organizationId,
            source.applicationId,
            { repositoryId: fixture.legacyJob.repositoryId },
          ),
      );
      assertEquals(foreign, {
        status: "foreign",
        reason: "repository_scope_mismatch",
      });

      const blockedSource = await harness.createRepository(true);
      const blockedOnboarding = await harness.onboard(
        blockedSource.repositoryId,
      );
      // All execution claims above are filtered to quality.check; this claim
      // remains the unchanged standalone native inspection admission path.
      const blockedAssignment = await readInspectionAssignment(
        await harness.claim(),
      );
      assertEquals(blockedAssignment.jobId, blockedOnboarding.jobId);
      await harness.start(blockedAssignment);
      const blockedReceipt = await receiveInspectionSource(
        harness,
        blockedAssignment,
      );
      const blockedReport = await harness.report(
        blockedAssignment.input,
        blockedReceipt,
      );
      assertEquals(
        (await harness.result(blockedAssignment, blockedReport)).status,
        200,
      );
      const blockedRead = await harness.memberRequest(
        "GET",
        `/v1/repository-onboardings/${blockedOnboarding.id}`,
      );
      const blocked = contractSchemas.RepositoryOnboarding.parse(
        await blockedRead.json(),
      );
      if (!blocked.profileId) throw new Error("BLOCKED_PROFILE_MISSING");
      await fixture
        .owner`update bakery.repositories set active_profile_id = ${blocked.profileId} where id = ${blockedSource.repositoryId}`;
      const beforeDenial = await fixture
        .owner`select count(*)::int as count from bakery.tasks where application_id = ${blockedSource.applicationId}`;
      const denied = await harness.memberRequest("POST", "/v1/tasks", {
        applicationId: blockedSource.applicationId,
        repositoryId: blockedSource.repositoryId,
        taskType: "feature",
        title: "Cannot execute blocked inspection",
      });
      assertEquals(denied.status, 409);
      assertEquals([
        ...await fixture
          .owner`select count(*)::int as count from bakery.tasks where application_id = ${blockedSource.applicationId}`,
      ], [...beforeDenial]);
      assertEquals(
        (await fixture
          .owner`select id from bakery.jobs where repository_id = ${blockedSource.repositoryId} and run_step_id is not null`)
          .length,
        0,
      );
      const claimed = await claim(capabilities);
      assertEquals(claimed.status, 200);
      const assignment = contractSchemas.JobAssignment.parse(
        await claimed.json(),
      );
      assertEquals(assignment.jobId, admission.jobId);
      assertEquals(
        (assignment.input as Record<string, unknown>).repositoryProfile,
        context,
      );
      assertEquals(assignment.requirements, job.requirements);
    } finally {
      await harness.close();
    }
  } finally {
    if (concurrentPg !== undefined) await closePgDatabase(concurrentPg);
    if (lockObserver !== undefined) await closeDatabase(lockObserver);
    await fixture.cleanup();
  }
});

Deno.test("fixed repository policy is CAS-published, inspection-bound, pinned, enforced, and revalidated", async () => {
  const fixture = await migrateTestDatabase();
  try {
    const harness = await openRepositoryInspectionHarness(
      fixture,
      fixture.legacyJob,
    );
    try {
      const source = await harness.createRepository(false, {
        profileConfig: fixedPolicyProfileConfig,
        profileHeaders: { "If-Match": '"1"' },
      });
      const onboarding = await harness.onboard(source.repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      assertEquals(assignment.jobId, onboarding.jobId);
      const observedPolicy = assignment.input.profile.config.fixedPolicy;
      if (!observedPolicy) throw new Error("FIXED_POLICY_NOT_OBSERVED");
      assertEquals(
        observedPolicy.trustedChecker.configDigest,
        await digestFor(assignment.input.profile.config.checkPolicy),
      );
      await harness.start(assignment);
      const receipt = await receiveInspectionSource(harness, assignment);
      const report = await harness.report(assignment.input, receipt);
      assertEquals((await harness.result(assignment, report)).status, 200);

      const [active] = await fixture.owner`
        select repository.active_profile_id as "profileId", repository.version,
               profile.revision, profile.digest, profile.config
          from bakery.repositories repository
          join bakery.repository_profiles profile
            on profile.organization_id = repository.organization_id
           and profile.id = repository.active_profile_id
         where repository.organization_id = ${harness.organizationId}
           and repository.id = ${source.repositoryId}`;
      assertEquals(active.profileId, assignment.input.profile.id);
      assertEquals(active.revision, 2);
      assertEquals(active.config.fixedPolicy, observedPolicy);

      const workflowId = crypto.randomUUID();
      const workflowVersionId = crypto.randomUUID();
      const spec = {
        apiVersion: "bakery.dev/v1",
        kind: "workflow",
        name: "fixed-policy-check",
        steps: [{
          id: "fixed_checks",
          uses: "quality.check",
          with: {
            repositoryId: "$task.repositoryId",
            revision: "$input.revision",
            checks: "$input.checks",
          },
        }],
      };
      await fixture.owner`
        insert into bakery.workflow_definitions (id, organization_id, slug, name, description)
        values (${workflowId}, ${harness.organizationId}, 'fixed-policy-check', 'Fixed policy check', '')`;
      await fixture.owner`
        insert into bakery.workflow_versions (id, organization_id, workflow_id, revision, source_yaml, normalized_spec, digest, status, created_by)
        values (${workflowVersionId}, ${harness.organizationId}, ${workflowId}, 1, '', ${
        fixture.owner.json(spec)
      }, ${await digestFor(
        spec,
      )}, 'published', ${fixture.legacyJob.principalId})`;
      await fixture.owner`
        update bakery.workflow_definitions set active_version_id = ${workflowVersionId}
         where organization_id = ${harness.organizationId} and id = ${workflowId}`;

      const createTask = async (title: string) => {
        const response = await harness.memberRequest("POST", "/v1/tasks", {
          applicationId: source.applicationId,
          repositoryId: source.repositoryId,
          taskType: "feature",
          title,
        });
        assertEquals(response.status, 201, await response.clone().text());
        return contractSchemas.Task.parse(await response.json());
      };
      const createRun = async (taskId: string, checks: string[]) => {
        const response = await harness.memberRequest(
          "POST",
          `/v1/tasks/${taskId}/runs`,
          {
            workflowVersionId,
            repositoryProfileId: active.profileId,
            executionMode: "repository",
            budgetLimitUsd: "0.005000",
            inputs: { revision: source.snapshotSha, checks },
          },
        );
        assertEquals(response.status, 201, await response.clone().text());
        return contractSchemas.Run.parse(await response.json());
      };

      const task = await createTask("Fixed policy accepted run");
      const run = await createRun(task.id, ["test.required"]);
      const [stored] = await fixture.owner`
        select snapshot from bakery.workflow_runs
         where organization_id = ${harness.organizationId} and id = ${run.id}`;
      const context = stored.snapshot.repositoryProfile;
      assertEquals(
        context.fixedPolicyDigest,
        await digestFor(observedPolicy),
      );
      assertEquals(
        context.trustedCheckerConfigDigest,
        observedPolicy.trustedChecker.configDigest,
      );
      assertEquals(
        context.config.fixedPolicy.decisions,
        fixedPolicyDraft.decisions,
      );

      const adapter = createBakeryPostgresWorkflowRepository({
        database: fixture.appPg,
        maxAttempts: 2,
      });
      const key = await adapter.findNext(run.id);
      if (!key) throw new Error("FIXED_POLICY_KEY_MISSING");
      const owner = await adapter.acquireEngineOwner(
        run.id,
        crypto.randomUUID(),
        60_000,
      );
      if (!owner) throw new Error("FIXED_POLICY_OWNER_MISSING");
      for (const defect of ["missing", "unauthorized"] as const) {
        const corrupt = structuredClone(stored.snapshot);
        if (defect === "missing") {
          delete corrupt.repositoryProfile.config.fixedPolicy.trustedChecker;
        } else {
          corrupt.repositoryProfile.config.fixedPolicy.trustedChecker
            .configDigest = "0".repeat(64);
        }
        await fixture.owner`update bakery.workflow_runs set snapshot = ${
          fixture.owner.json(corrupt)
        } where id = ${run.id}`;
        await assertRejects(() => adapter.admit(key, owner));
        assertEquals(
          (await fixture.owner`
            select count(*)::int as count from bakery.jobs
             where run_step_id in (select id from bakery.run_steps where run_id = ${run.id})`)[
            0
          ].count,
          0,
        );
      }
      await fixture.owner`update bakery.workflow_runs set snapshot = ${
        fixture.owner.json(stored.snapshot)
      } where id = ${run.id}`;
      const admission = await adapter.admit(key, owner);
      if (!admission.jobId) throw new Error("FIXED_POLICY_JOB_MISSING");
      const [job] = await fixture.owner`
        select input, requirements from bakery.jobs where id = ${admission.jobId}`;
      assertEquals(job.input.repositoryProfile, context);
      assertEquals(job.input.checks, ["test.required"]);
      assertEquals(
        await withPgTransaction(
          fixture.appPg,
          (transaction) =>
            admitRepositoryExecutionJob(
              transaction,
              harness.organizationId,
              admission.jobId!,
            ),
        ),
        job.requirements,
      );
      await adapter.releaseEngineOwner(owner);

      const missingTask = await createTask("Fixed policy missing requirement");
      const missingRun = await createRun(missingTask.id, ["lint.warn"]);
      const missingKey = await adapter.findNext(missingRun.id);
      if (!missingKey) throw new Error("FIXED_POLICY_MISSING_KEY");
      const missingOwner = await adapter.acquireEngineOwner(
        missingRun.id,
        crypto.randomUUID(),
        60_000,
      );
      if (!missingOwner) throw new Error("FIXED_POLICY_MISSING_OWNER");
      await assertRejects(() => adapter.admit(missingKey, missingOwner));
      assertEquals(
        (await fixture.owner`
          select count(*)::int as count from bakery.jobs
           where run_step_id in (
             select id from bakery.run_steps where run_id = ${missingRun.id}
           )`)[0].count,
        0,
      );
      assertEquals(
        (await fixture.owner`
          select count(*)::int as count from bakery.job_attempts attempt
          join bakery.jobs job on job.id = attempt.job_id
          join bakery.run_steps step on step.id = job.run_step_id
          where step.run_id = ${missingRun.id}`)[0].count,
        0,
      );
      await adapter.releaseEngineOwner(missingOwner);

      const changedPolicy = {
        ...fixedPolicyDraft,
        commands: fixedPolicyDraft.commands.map((command) =>
          command.id === "test.required"
            ? { ...command, argv: [...command.argv, "changed"] }
            : command
        ),
      };
      const changedConfig = { ...profileConfig, fixedPolicy: changedPolicy };
      const changedResponse = await harness.memberRequest(
        "POST",
        `/v1/repositories/${source.repositoryId}/profiles`,
        {
          revision: 3,
          config: changedConfig,
          digest: await digestFor(changedConfig),
        },
        harness.organizationId,
        { "If-Match": `"${active.version}"` },
      );
      assertEquals(
        changedResponse.status,
        201,
        await changedResponse.clone().text(),
      );
      assertEquals(
        (await fixture
          .owner`select snapshot from bakery.workflow_runs where id = ${run.id}`)[
            0
          ].snapshot,
        stored.snapshot,
      );
      assertEquals(
        await withPgTransaction(
          fixture.appPg,
          (transaction) =>
            admitRepositoryExecutionJob(
              transaction,
              harness.organizationId,
              admission.jobId!,
            ),
        ),
        job.requirements,
      );
      const revalidation = await harness.memberRequest("POST", "/v1/tasks", {
        applicationId: source.applicationId,
        repositoryId: source.repositoryId,
        taskType: "feature",
        title: "Changed policy needs inspection",
      });
      assertEquals(revalidation.status, 409);

      const concurrentSource = await harness.createRepository();
      const [concurrentRepository] = await fixture.owner`
        select version from bakery.repositories where id = ${concurrentSource.repositoryId}`;
      const concurrentConfig = fixedPolicyProfileConfig;
      const concurrentBody = {
        revision: 2,
        config: concurrentConfig,
        digest: await digestFor(concurrentConfig),
      };
      const concurrent = await Promise.all([
        harness.memberRequest(
          "POST",
          `/v1/repositories/${concurrentSource.repositoryId}/profiles`,
          concurrentBody,
          harness.organizationId,
          { "If-Match": `"${concurrentRepository.version}"` },
        ),
        harness.memberRequest(
          "POST",
          `/v1/repositories/${concurrentSource.repositoryId}/profiles`,
          concurrentBody,
          harness.organizationId,
          { "If-Match": `"${concurrentRepository.version}"` },
        ),
      ]);
      assertEquals(concurrent.map((response) => response.status).sort(), [
        201,
        412,
      ]);
      assertEquals(
        (await fixture.owner`
          select count(*)::int as count from bakery.repository_profiles
           where repository_id = ${concurrentSource.repositoryId}`)[0].count,
        2,
      );

      const [afterConcurrent] = await fixture.owner`
        select version from bakery.repositories where id = ${concurrentSource.repositoryId}`;
      const weakenedImport = {
        ...fixedPolicyProfileConfig,
        fixedPolicy: {
          ...fixedPolicyDraft,
          trustedChecker: {
            kind: "repository-inspection",
            configDigest: "0".repeat(64),
          },
        },
      };
      const weakened = await harness.memberRequest(
        "POST",
        `/v1/repositories/${concurrentSource.repositoryId}/profiles`,
        {
          revision: 3,
          config: weakenedImport,
          digest: await digestFor(weakenedImport),
        },
        harness.organizationId,
        { "If-Match": `"${afterConcurrent.version}"` },
      );
      assertEquals(weakened.status, 422);
      const foreign = await harness.memberRequest(
        "POST",
        `/v1/repositories/${concurrentSource.repositoryId}/profiles`,
        concurrentBody,
        crypto.randomUUID(),
        { "If-Match": `"${afterConcurrent.version}"` },
      );
      assertEquals(foreign.status, 404);
    } finally {
      await harness.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("Data migration 0049 preserves frozen v1 execution, replay bytes and cloud contexts without repinning", async () => {
  const fixture = await migrateTestDatabase({
    through: "0048_issue46_trusted_inspection",
    throughData: EVENT_CLOCK_DATA_BOUNDARY,
  });
  const { owner, appPg, legacyJob } = fixture;
  try {
    const profileDigest = await digestFor(profileConfig);
    const context = {
      id: legacyJob.profileId,
      revision: 1,
      digest: profileDigest,
      config: profileConfig,
    };
    const oldInput = {
      repositoryId: legacyJob.repositoryId,
      revision: "a".repeat(40),
      checks: ["source.integrity"],
    };
    const [{ workflowVersionId, workflowId }] = await owner`
      select run.workflow_version_id as "workflowVersionId", version.workflow_id as "workflowId"
      from bakery.workflow_runs run
      join bakery.workflow_versions version on version.organization_id = run.organization_id and version.id = run.workflow_version_id
      where run.id = ${legacyJob.runId}`;
    const oldSpec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "legacy",
      steps: [{ id: "legacy", uses: "quality.check", with: oldInput }],
    };
    const workflowDigest = await digestFor(oldSpec);
    await owner`
      update bakery.workflow_versions set source_yaml = ${
      JSON.stringify(oldSpec)
    },
        normalized_spec = ${owner.json(oldSpec)}, digest = ${workflowDigest}
      where id = ${workflowVersionId} and organization_id = ${legacyJob.organizationId}`;
    const oldSnapshot = {
      schemaVersion: 1,
      executionMode: "repository",
      repositoryProfile: context,
      inputs: { message: "frozen" },
      workflow: {
        id: workflowVersionId,
        revision: 1,
        digest: workflowDigest,
        normalizedSpec: oldSpec,
      },
      admission: { dependencies: [], status: "queued", reason: null },
    };
    await owner`
      update bakery.run_steps set input = ${
      owner.json(oldInput)
    }, status = 'running'
      where run_id = ${legacyJob.runId} and organization_id = ${legacyJob.organizationId}`;
    const oldRequirements = {
      capabilities: ["operator.approved", "git"],
      queueClass: "legacy-operator",
    };
    await owner`
      update bakery.tasks set task_type = 'maintenance', status = 'active', current_run_id = ${legacyJob.runId}
       where organization_id = ${legacyJob.organizationId} and id = ${legacyJob.taskId}`;
    await owner`
      update bakery.workflow_runs set snapshot = ${
      owner.json(oldSnapshot)
    }, status = 'running'
       where organization_id = ${legacyJob.organizationId} and id = ${legacyJob.runId}`;
    await owner`
      update bakery.jobs set action = 'quality.check', input = ${
      owner.json(oldInput)
    },
        requirements = ${
      owner.json(oldRequirements)
    }, current_fence = 7, status = 'leased'
       where organization_id = ${legacyJob.organizationId} and id = ${legacyJob.jobId}`;
    const activeId = crypto.randomUUID();
    const activeConfig = {
      ...profileConfig,
      worktree: { root: ".bakery/new-active" },
    };
    await owner`
      insert into bakery.repository_profiles (id, organization_id, repository_id, revision, config, digest, created_by)
      values (${activeId}, ${legacyJob.organizationId}, ${legacyJob.repositoryId}, 2,
        ${owner.json(activeConfig)}, ${await digestFor(
      activeConfig,
    )}, ${legacyJob.principalId})`;
    await owner`
      update bakery.repositories set active_profile_id = ${activeId}
       where organization_id = ${legacyJob.organizationId} and id = ${legacyJob.repositoryId}`;

    const cloudRunId = crypto.randomUUID();
    const cloudStepId = crypto.randomUUID();
    const cloudJobId = crypto.randomUUID();
    const cloudVersionId = crypto.randomUUID();
    const cloudInput = { connectionId: crypto.randomUUID() };
    const cloudSpec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "legacy-cloud",
      steps: [{ id: "cloud", uses: "mcp.discover", with: cloudInput }],
    };
    const cloudDigest = await digestFor(cloudSpec);
    await owner`
      insert into bakery.workflow_versions (id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by)
      values (${cloudVersionId}, ${legacyJob.organizationId}, ${workflowId}, 2, ${
      JSON.stringify(cloudSpec)
    },
        ${
      owner.json(cloudSpec)
    }, ${cloudDigest}, 'published', ${legacyJob.principalId})`;
    const cloudSnapshot = {
      schemaVersion: 1,
      executionMode: "cloud_only",
      repositoryProfile: null,
      inputs: { frozenCloud: true },
      workflow: {
        id: cloudVersionId,
        revision: 2,
        digest: cloudDigest,
        normalizedSpec: cloudSpec,
      },
      admission: { dependencies: [], status: "queued", reason: null },
    };
    await owner`
      insert into bakery.workflow_runs (id, organization_id, task_id, workflow_version_id, requested_by, status, snapshot)
      values (${cloudRunId}, ${legacyJob.organizationId}, ${legacyJob.taskId}, ${cloudVersionId},
        ${legacyJob.principalId}, 'completed', ${owner.json(cloudSnapshot)})`;
    await owner`
      insert into bakery.run_steps (id, organization_id, run_id, step_key, position, input, status)
      values (${cloudStepId}, ${legacyJob.organizationId}, ${cloudRunId}, 'cloud', 0, ${
      owner.json(cloudInput)
    }, 'completed')`;
    await owner`
      insert into bakery.jobs (id, organization_id, run_step_id, action, input, requirements, status)
      values (${cloudJobId}, ${legacyJob.organizationId}, ${cloudStepId}, 'mcp.discover',
        ${owner.json(cloudInput)},
        ${
      owner.json({
        capabilities: ["mcp.host_local", "operator.cloud"],
        cloudMetadata: "retained",
      })
    }, 'completed')`;
    const cloudBefore = await owner`
      select run.snapshot, (to_jsonb(job) - 'conversation_turn_id') as job from bakery.workflow_runs run
      join bakery.run_steps step on step.organization_id = run.organization_id and step.run_id = run.id
      join bakery.jobs job on job.organization_id = step.organization_id and job.run_step_id = step.id
      where run.id = ${cloudRunId}`;

    const workerPrincipalId = crypto.randomUUID();
    const workerHostId = crypto.randomUUID();
    const workerSessionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const claimKey = crypto.randomUUID();
    const serverTime = new Date().toISOString();
    const expiresAt = new Date(Date.parse(serverTime) + 60_000).toISOString();
    const savedAssignment = contractSchemas.JobAssignment.parse({
      jobId: legacyJob.jobId,
      attemptId,
      workerHostId,
      leaseToken: "l".repeat(64),
      fence: "7",
      leaseExpiresAt: expiresAt,
      action: "quality.check",
      requirements: oldRequirements,
      input: oldInput,
      currentCheckpoints: [],
      agentConfig: {},
      skillRefs: [],
      agentVersionId: null,
      billing: null,
      installationReservationId: null,
      workerSessionId,
      workerSessionGeneration: "1",
      leaseDurationSeconds: 60,
      serverTime,
      sealedCredentialOperation: null,
    });
    const ciphertext = await protect(
      "issue46-migration-replay-secret",
      savedAssignment,
    );
    await owner`
      insert into bakery.principals (id, display_name, principal_type)
      values (${workerPrincipalId}, 'Frozen v1 replay worker', 'worker')`;
    await owner`
      insert into bakery.worker_hosts (id, organization_id, principal_id, name, os, architecture, slots,
        capabilities, credential_hash, worker_session_id, worker_session_generation)
      values (${workerHostId}, ${legacyJob.organizationId}, ${workerPrincipalId}, 'Frozen v1 worker',
        'linux', 'x86_64', 1, ${
      owner.json(["git", "shell", "browser", "operator.approved"])
    },
        ${"e".repeat(64)}, ${workerSessionId}, 1)`;
    await owner`
      insert into bakery.job_attempts (id, organization_id, job_id, worker_host_id, worker_session_id,
        worker_session_generation, attempt_no, fence, lease_token_hash, lease_expires_at, status)
      values (${attemptId}, ${legacyJob.organizationId}, ${legacyJob.jobId}, ${workerHostId},
        ${workerSessionId}, 1, 1, 7, ${await sha256Hex(
      savedAssignment.leaseToken,
    )}, ${expiresAt}, 'leased')`;
    await owner`
      insert into bakery.worker_claim_replays (organization_id, worker_host_id, attempt_id, claim_key,
        request_digest, response_status, response_ciphertext, expires_at)
      values (${legacyJob.organizationId}, ${workerHostId}, ${attemptId}, ${claimKey},
        ${"d".repeat(64)}, 200, ${ciphertext}, ${expiresAt})`;
    const attemptsBefore =
      await owner`select * from bakery.job_attempts where id = ${attemptId}`;
    const replaysBefore =
      await owner`select * from bakery.worker_claim_replays where attempt_id = ${attemptId}`;
    await assertRejects(() =>
      withPgTransaction(
        appPg,
        (transaction) =>
          admitRepositoryExecutionJob(
            transaction,
            legacyJob.organizationId,
            legacyJob.jobId,
          ),
      )
    );

    const invalidConfig = { ...profileConfig, worktree: { root: "" } };
    const corruptCases = [
      {
        config: {
          ...profileConfig,
          worktree: { root: ".bakery/corrupt-digest" },
        },
        digest: "c".repeat(64),
      },
      { config: invalidConfig, digest: await digestFor(invalidConfig) },
    ];
    const corruptJobIds: string[] = [];
    for (const [index, corrupt] of corruptCases.entries()) {
      const corruptProfileId = crypto.randomUUID();
      const corruptTaskId = crypto.randomUUID();
      const corruptRunId = crypto.randomUUID();
      const corruptStepId = crypto.randomUUID();
      const corruptJobId = crypto.randomUUID();
      corruptJobIds.push(corruptJobId);
      await owner`
        insert into bakery.repository_profiles (id, organization_id, repository_id, revision, config, digest, created_by)
        values (${corruptProfileId}, ${legacyJob.organizationId}, ${legacyJob.repositoryId}, ${
        3 + index
      },
          ${
        owner.json(corrupt.config)
      }, ${corrupt.digest}, ${legacyJob.principalId})`;
      await owner`
        insert into bakery.tasks (id, organization_id, application_id, repository_id, conversation_id,
          title, description, task_type, priority, created_by, repository_profile_id, repository_profile_revision, repository_profile_digest)
        select ${corruptTaskId}, organization_id, application_id, repository_id, conversation_id,
          'Corrupt legacy source', '', 'feature', 50, created_by, ${corruptProfileId}, ${
        3 + index
      }, ${corrupt.digest}
        from bakery.tasks where organization_id = ${legacyJob.organizationId} and id = ${legacyJob.taskId}`;
      const corruptSnapshot = {
        ...oldSnapshot,
        repositoryProfile: {
          id: corruptProfileId,
          revision: 3 + index,
          digest: corrupt.digest,
          config: corrupt.config,
        },
      };
      await owner`
        insert into bakery.workflow_runs (id, organization_id, task_id, workflow_version_id, requested_by, status, snapshot,
          application_id, repository_id, repository_profile_id, repository_profile_revision, repository_profile_digest)
        values (${corruptRunId}, ${legacyJob.organizationId}, ${corruptTaskId}, ${workflowVersionId}, ${legacyJob.principalId},
          'queued', ${
        owner.json(corruptSnapshot)
      }, ${legacyJob.applicationId}, ${legacyJob.repositoryId},
          ${corruptProfileId}, ${3 + index}, ${corrupt.digest})`;
      await owner`
        insert into bakery.run_steps (id, organization_id, run_id, step_key, position, input)
        values (${corruptStepId}, ${legacyJob.organizationId}, ${corruptRunId}, 'legacy', 0, ${
        owner.json(oldInput)
      })`;
      await owner`
        insert into bakery.jobs (id, organization_id, run_step_id, action, input, requirements,
          application_id, repository_id, repository_profile_id, repository_profile_revision, repository_profile_digest)
        values (${corruptJobId}, ${legacyJob.organizationId}, ${corruptStepId}, 'quality.check', ${
        owner.json(oldInput)
      },
          ${
        owner.json({ capabilities: ["git", "shell", "browser"] })
      }, ${legacyJob.applicationId}, ${legacyJob.repositoryId},
          ${corruptProfileId}, ${3 + index}, ${corrupt.digest})`;
    }
    const corruptBefore = (await owner`
      select to_jsonb(run) as run, (to_jsonb(job) - 'conversation_turn_id') as job
      from bakery.jobs job join bakery.run_steps step on step.organization_id = job.organization_id and step.id = job.run_step_id
      join bakery.workflow_runs run on run.organization_id = step.organization_id and run.id = step.run_id
      where job.id in ${owner(corruptJobIds)} order by job.id`).map((
      { run, job },
    ) => ({
      run,
      job,
    }));
    const expandedContext = {
      ...context,
      organizationId: legacyJob.organizationId,
      applicationId: legacyJob.applicationId,
      repositoryId: legacyJob.repositoryId,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    };
    const emptyCaller = { ...oldInput, revision: "" };
    const nearLimitCaller = {
      ...oldInput,
      revision: "é".repeat(40_000) + "a".repeat(
        100_000 -
          new TextEncoder().encode(canonicalJson(emptyCaller)).length - 80_000,
      ),
    };
    contractSchemas.CheckInput.parse(nearLimitCaller);
    assertEquals(
      new TextEncoder().encode(canonicalJson(nearLimitCaller)).length,
      100_000,
    );
    assertEquals(
      new TextEncoder().encode(canonicalJson({
        ...nearLimitCaller,
        repositoryProfile: expandedContext,
      })).length > 100_000,
      true,
    );
    const deniedJobIds: string[] = [];
    let variableJobId = "";
    for (
      const [index, defect] of [
        "revision",
        "action",
        "transport-size",
        "valid-variables",
      ].entries()
    ) {
      const versionId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      const variable = defect === "valid-variables";
      if (variable) variableJobId = jobId;
      else deniedJobIds.push(jobId);
      const authorizedInput = defect === "transport-size"
        ? nearLimitCaller
        : oldInput;
      const storedInput = defect === "revision"
        ? { ...oldInput, revision: "b".repeat(40) }
        : authorizedInput;
      const spec = {
        ...oldSpec,
        steps: [
          ...(variable
            ? [{ id: "source", uses: "quality.check", with: oldInput }]
            : []),
          {
            id: "legacy",
            uses: "quality.check",
            ...(variable ? { needs: ["source"] } : {}),
            with: variable || defect === "transport-size"
              ? {
                repositoryId: "$task.repositoryId",
                revision: variable
                  ? "$step.source.revision"
                  : "$input.revision",
                checks: "$input.checks",
              }
              : authorizedInput,
          },
        ],
      };
      const digest = await digestFor(spec);
      await owner`
        insert into bakery.workflow_versions (id, organization_id, workflow_id, revision, source_yaml,
          normalized_spec, digest, status, created_by)
        values (${versionId}, ${legacyJob.organizationId}, ${workflowId}, ${
        3 + index
      }, ${JSON.stringify(spec)}, ${
        owner.json(spec)
      }, ${digest}, 'published', ${legacyJob.principalId})`;
      const snapshot = {
        ...oldSnapshot,
        inputs: { revision: authorizedInput.revision, checks: oldInput.checks },
        workflow: {
          id: versionId,
          revision: 3 + index,
          digest,
          normalizedSpec: spec,
        },
      };
      await owner`
        insert into bakery.workflow_runs (id, organization_id, task_id, workflow_version_id, requested_by,
          status, snapshot, application_id, repository_id, repository_profile_id,
          repository_profile_revision, repository_profile_digest)
        values (${runId}, ${legacyJob.organizationId}, ${legacyJob.taskId}, ${versionId},
          ${legacyJob.principalId}, 'queued', ${
        owner.json(snapshot)
      }, ${legacyJob.applicationId},
          ${legacyJob.repositoryId}, ${legacyJob.profileId}, 1, ${profileDigest})`;
      if (variable) {
        await owner`
          insert into bakery.run_steps (id, organization_id, run_id, step_key, position, input, output, status)
          values (${crypto.randomUUID()}, ${legacyJob.organizationId}, ${runId}, 'source', 0,
            ${owner.json(oldInput)}, ${
          owner.json({ revision: oldInput.revision })
        }, 'completed')`;
      }
      await owner`
        insert into bakery.run_steps (id, organization_id, run_id, step_key, position, input)
        values (${stepId}, ${legacyJob.organizationId}, ${runId}, 'legacy', ${
        variable ? 1 : 0
      },
          ${owner.json(storedInput)})`;
      await owner`
        insert into bakery.jobs (id, organization_id, run_step_id, action, input, requirements,
          application_id, repository_id, repository_profile_id, repository_profile_revision, repository_profile_digest)
        values (${jobId}, ${legacyJob.organizationId}, ${stepId}, ${
        defect === "action" ? "mcp.discover" : "quality.check"
      }, ${owner.json(storedInput)}, ${
        owner.json({
          capabilities: ["git", "shell", "browser", "mcp.host_local"],
        })
      }, ${legacyJob.applicationId}, ${legacyJob.repositoryId}, ${legacyJob.profileId}, 1, ${profileDigest})`;
    }
    // Compare every persisted job field, not postgres.js Result statement and
    // connection metadata (the post-migration query has a different statement).
    const deniedBefore = (await owner`
      select (to_jsonb(job) - 'conversation_turn_id') as job from bakery.jobs job
      where job.id in ${owner(deniedJobIds)} order by job.id`).map((row) =>
      row.job
    );
    const reserved = await owner.reserve();
    try {
      await assertRejects(
        () =>
          frozenExecutionContextBackfill.run(reserved, {
            maxBatches: 1,
            beforeCommit: () => {
              throw new Error("CUTOVER_ABORT_BEFORE_COMMIT");
            },
          }),
        Error,
        "CUTOVER_ABORT_BEFORE_COMMIT",
      );
    } finally {
      reserved.release();
    }
    assertEquals(
      (await owner`select snapshot from bakery.workflow_runs where id = ${legacyJob.runId}`)[
        0
      ].snapshot,
      oldSnapshot,
    );
    await assertRejects(
      () => migrateData(owner, bakeryDataMigrations, { maxBatches: 1 }),
      Error,
      "DATA_MIGRATION_INCOMPLETE:0049_issue46_frozen_execution_context",
    );
    assertEquals(
      (await owner`
      select exists (select 1 from bakery.data_migrations where version = '0049_issue46_frozen_execution_context') as recorded`)[
        0
      ].recorded,
      false,
    );
    const [{ databaseName }] =
      await owner`select current_database() as "databaseName"`;
    const isolatedOwnerUrl = new URL(databaseUrl);
    isolatedOwnerUrl.pathname = `/${databaseName}`;
    // Exercise both real entry points, including phased history on startup replay.
    for (const task of ["migrate", "startup"]) {
      const result = await new Deno.Command(Deno.execPath(), {
        cwd: new URL("../../apps/server/", import.meta.url),
        args: [
          "run",
          "--allow-env",
          "--allow-net",
          "--allow-read=src/platform/migrations,src/modules/auth/migrations,src/modules/work/migrations,src/modules/projects/migrations,src/modules/agents/migrations,src/modules/repository-rules/migrations,src/modules/integrations/migrations,src/modules/delivery/migrations",
          "src/tasks.ts",
          task,
        ],
        env: { DATABASE_URL: isolatedOwnerUrl.toString() },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    }
    assertEquals(
      (await owner`
      select count(*)::int as count from bakery.data_migrations where version = '0049_issue46_frozen_execution_context'`)[
        0
      ].count,
      1,
    );
    const corruptAfter = await owner`
      select to_jsonb(run) as run, (to_jsonb(job) - 'conversation_turn_id') as job
      from bakery.jobs job join bakery.run_steps step on step.organization_id = job.organization_id and step.id = job.run_step_id
      join bakery.workflow_runs run on run.organization_id = step.organization_id and run.id = step.run_id
      where job.id in ${owner(corruptJobIds)} order by job.id`;
    const corruptLegacyProjection = corruptAfter.map(({ run, job }) => {
      const { kind, skill_source_id: skillSourceId, ...legacyRun } = run;
      assertEquals(kind, "workflow");
      assertEquals(skillSourceId, null);
      return { run: legacyRun, job };
    });
    assertEquals(corruptLegacyProjection, corruptBefore);
    for (const id of corruptJobIds) {
      await assertRejects(() =>
        withPgTransaction(
          appPg,
          (transaction) =>
            admitRepositoryExecutionJob(
              transaction,
              legacyJob.organizationId,
              id,
            ),
        )
      );
    }
    const frozenContext = {
      ...context,
      organizationId: legacyJob.organizationId,
      applicationId: legacyJob.applicationId,
      repositoryId: legacyJob.repositoryId,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    };
    const [run] = await owner`
      select snapshot, repository_profile_id as "profileId", repository_profile_revision as revision,
        repository_profile_digest as digest, observation_id as observation, observation_digest as observation_digest, base_sha
      from bakery.workflow_runs where id = ${legacyJob.runId}`;
    assertEquals(run.snapshot, {
      ...oldSnapshot,
      repositoryProfile: frozenContext,
    });
    assertEquals([
      run.profileId,
      run.revision,
      run.digest,
      run.observation,
      run.observation_digest,
      run.base_sha,
    ], [legacyJob.profileId, 1, profileDigest, null, null, null]);
    const [job] = await owner`
      select input, requirements, application_id as "applicationId", repository_profile_id as "profileId",
        repository_profile_revision as revision, repository_profile_digest as digest, current_fence::text as fence
      from bakery.jobs where id = ${legacyJob.jobId}`;
    assertEquals(job.input, { ...oldInput, repositoryProfile: frozenContext });
    assertEquals([
      job.applicationId,
      job.profileId,
      job.revision,
      job.digest,
      job.fence,
    ], [legacyJob.applicationId, legacyJob.profileId, 1, profileDigest, "7"]);
    assertEquals(job.requirements, {
      ...oldRequirements,
      capabilities: ["operator.approved", "git", "shell", "browser"],
    });
    assertEquals(
      await withPgTransaction(
        appPg,
        (transaction) =>
          admitRepositoryExecutionJob(
            transaction,
            legacyJob.organizationId,
            legacyJob.jobId,
          ),
      ),
      { capabilities: ["git", "shell", "browser", "operator.approved"] },
    );
    assertEquals(
      await owner`select * from bakery.job_attempts where id = ${attemptId}`,
      attemptsBefore,
    );
    assertEquals(
      await owner`select * from bakery.worker_claim_replays where attempt_id = ${attemptId}`,
      replaysBefore,
    );
    assertEquals(
      await owner`
      select run.snapshot, (to_jsonb(job) - 'conversation_turn_id') as job from bakery.workflow_runs run
      join bakery.run_steps step on step.organization_id = run.organization_id and step.run_id = run.id
      join bakery.jobs job on job.organization_id = step.organization_id and job.run_step_id = step.id
      where run.id = ${cloudRunId}`,
      cloudBefore,
    );
    assertEquals(
      await withPgTransaction(
        appPg,
        (transaction) =>
          admitRepositoryExecutionJob(
            transaction,
            legacyJob.organizationId,
            cloudJobId,
          ),
      ),
      { capabilities: ["mcp.host_local", "operator.cloud"] },
    );
    assertEquals(
      (await owner`
        select (to_jsonb(job) - 'conversation_turn_id') as job from bakery.jobs job
        where job.id in ${owner(deniedJobIds)} order by job.id`).map((row) =>
        row.job
      ),
      deniedBefore,
    );
    for (const jobId of deniedJobIds) {
      await assertRejects(() =>
        withPgTransaction(
          appPg,
          (transaction) =>
            admitRepositoryExecutionJob(
              transaction,
              legacyJob.organizationId,
              jobId,
            ),
        )
      );
    }
    const [variableJob] = await owner`
      select input, requirements from bakery.jobs where id = ${variableJobId}`;
    assertEquals(variableJob.input, {
      ...oldInput,
      repositoryProfile: expandedContext,
    });
    assertEquals(
      await withPgTransaction(
        appPg,
        (transaction) =>
          admitRepositoryExecutionJob(
            transaction,
            legacyJob.organizationId,
            variableJobId,
          ),
      ),
      { capabilities: ["git", "shell", "browser", "mcp.host_local"] },
    );

    // Structural backfill never substitutes for canonical config/digest validation.
    await owner`
      update bakery.repository_profiles set config = ${
      owner.json({ ...profileConfig, worktree: { root: "" } })
    }
       where id = ${legacyJob.profileId}`;
    await assertRejects(() =>
      withPgTransaction(
        appPg,
        (transaction) =>
          admitRepositoryExecutionJob(
            transaction,
            legacyJob.organizationId,
            legacyJob.jobId,
          ),
      )
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("new runs reject stale task policy selections atomically", async () => {
  const fixture = await migrateTestDatabase();
  try {
    const harness = await openRepositoryInspectionHarness(
      fixture,
      fixture.legacyJob,
    );
    try {
      const source = await harness.createRepository(false, {
        profileConfig: fixedPolicyProfileConfig,
        profileHeaders: { "If-Match": '"1"' },
      });
      await harness.onboard(source.repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      await harness.start(assignment);
      const receipt = await receiveInspectionSource(harness, assignment);
      const report = await harness.report(assignment.input, receipt);
      assertEquals((await harness.result(assignment, report)).status, 200);
      const [active] = await fixture.owner`
        select active_profile_id as "profileId", version
          from bakery.repositories where id = ${source.repositoryId}`;
      const workflowId = crypto.randomUUID();
      const workflowVersionId = crypto.randomUUID();
      const spec = {
        apiVersion: "bakery.dev/v1",
        kind: "workflow",
        name: "issue289-stale-policy",
        steps: [{
          id: "fixed_checks",
          uses: "quality.check",
          with: {
            repositoryId: "$task.repositoryId",
            revision: "$input.revision",
            checks: "$input.checks",
          },
        }],
      };
      await fixture.owner`
        insert into bakery.workflow_definitions
          (id, organization_id, slug, name, description)
        values
          (${workflowId}, ${harness.organizationId}, 'issue289-stale-policy',
           'issue289-stale-policy', '')`;
      await fixture.owner`
        insert into bakery.workflow_versions
          (id, organization_id, workflow_id, revision, source_yaml,
           normalized_spec, digest, status, created_by)
        values
          (${workflowVersionId}, ${harness.organizationId}, ${workflowId}, 1,
           '', ${fixture.owner.json(spec)}, ${await digestFor(spec)},
           'published', ${fixture.legacyJob.principalId})`;
      await fixture.owner`
        update bakery.workflow_definitions set active_version_id = ${workflowVersionId}
         where organization_id = ${harness.organizationId} and id = ${workflowId}`;
      const taskResponse = await harness.memberRequest("POST", "/v1/tasks", {
        applicationId: source.applicationId,
        repositoryId: source.repositoryId,
        taskType: "feature",
        title: "stale policy run",
      });
      assertEquals(taskResponse.status, 201, await taskResponse.clone().text());
      const task = contractSchemas.Task.parse(await taskResponse.json());
      const [before] = await fixture.owner`
        select status, current_run_id as "currentRunId"
          from bakery.tasks where id = ${task.id}`;
      const changedConfig = {
        ...fixedPolicyProfileConfig,
        fixedPolicy: {
          ...fixedPolicyDraft,
          commands: fixedPolicyDraft.commands.map((command) =>
            command.id === "test.required"
              ? { ...command, argv: [...command.argv, "changed"] }
              : command
          ),
        },
      };
      const changedResponse = await harness.memberRequest(
        "POST",
        `/v1/repositories/${source.repositoryId}/profiles`,
        {
          revision: 3,
          config: changedConfig,
          digest: await digestFor(changedConfig),
        },
        harness.organizationId,
        { "If-Match": `"${active.version}"` },
      );
      assertEquals(changedResponse.status, 201, await changedResponse.text());
      const runResponse = await harness.memberRequest(
        "POST",
        `/v1/tasks/${task.id}/runs`,
        {
          workflowVersionId,
          repositoryProfileId: active.profileId,
          executionMode: "repository",
          budgetLimitUsd: "0.005000",
          inputs: { revision: source.snapshotSha, checks: ["test.required"] },
        },
      );
      assertEquals(
        runResponse.status,
        409,
        await runResponse.clone().text(),
      );
      assertEquals((await runResponse.json()).code, "STATE_CONFLICT");
      const [after] = await fixture.owner`
        select status, current_run_id as "currentRunId"
          from bakery.tasks where id = ${task.id}`;
      assertEquals(after, before);
      assertEquals(
        (await fixture.owner`
          select count(*)::int as count from bakery.workflow_runs
           where task_id = ${task.id}`)[0].count,
        0,
      );
    } finally {
      await harness.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
