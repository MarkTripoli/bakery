import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
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
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import { createPostgresCommandRunner } from "../../apps/server/src/platform/command-replay.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import {
  createProjectsActionRegistry,
  createProjectsHandlers,
} from "../../apps/server/src/modules/projects/index.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";

const { databaseUrl, appDatabaseUrl } = readTestDatabaseConfig();

type Principal = {
  principalId: string;
  principalType: "human";
  displayName: string;
};

type ProfileConfig = {
  schemaVersion: 1;
  workflow: { kind: "fixed" };
  branches: { base: string; allowedPatterns: string[] };
  worktree: { root: string };
};

async function digestFor(config: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(config));
}

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

Deno.test("provide the first authorized repository and immutable fixed execution profile", async (test) => {
  const owner = openDatabase(databaseUrl);
  const authDb = openPgDatabase(databaseUrl);
  const appPg = openPgDatabase(appDatabaseUrl);
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

    const organizationAId = crypto.randomUUID();
    const organizationBId = crypto.randomUUID();
    const adminAUserId = crypto.randomUUID();
    const developerAUserId = crypto.randomUUID();
    const adminBUserId = crypto.randomUUID();
    const adminAPrincipalId = crypto.randomUUID();
    const developerAPrincipalId = crypto.randomUUID();
    const adminBPrincipalId = crypto.randomUUID();
    const secondApplicationId = crypto.randomUUID();
    const now = new Date("2026-09-12T00:00:00.000Z");
    const adminAEmail = `admin-a-${adminAUserId}@example.test`;
    const developerAEmail = `developer-a-${developerAUserId}@example.test`;
    const adminBEmail = `admin-b-${adminBUserId}@example.test`;

    for (
      const [userId, email, displayName] of [
        [adminAUserId, adminAEmail, "Admin A"],
        [developerAUserId, developerAEmail, "Developer A"],
        [adminBUserId, adminBEmail, "Admin B"],
      ] as const
    ) {
      await owner`
        insert into public."user" (
          id, name, email, "emailVerified", "createdAt", "updatedAt"
        ) values (${userId}, ${displayName}, ${email}, true, ${now}, ${now})`;
    }
    for (
      const [principalId, userId, displayName] of [
        [adminAPrincipalId, adminAUserId, "Admin A"],
        [developerAPrincipalId, developerAUserId, "Developer A"],
        [adminBPrincipalId, adminBUserId, "Admin B"],
      ] as const
    ) {
      await owner`
        insert into bakery.principals (
          id, provider_user_id, display_name, principal_type
        ) values (${principalId}, ${userId}, ${displayName}, 'human')`;
    }
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationAId}, 'Org A', ${`org-a-${organizationAId}`},
        '{}'::jsonb, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationBId}, 'Org B', ${`org-b-${organizationBId}`},
        '{}'::jsonb, ${now}, ${now}, 1
      )`;
    for (
      const [organizationId, principalId, role] of [
        [organizationAId, adminAPrincipalId, "admin"],
        [organizationAId, developerAPrincipalId, "developer"],
        [organizationBId, adminBPrincipalId, "admin"],
      ] as const
    ) {
      await owner`
        insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status, joined_at,
          created_at, updated_at, version
        ) values (
          ${crypto.randomUUID()}, ${organizationId}, ${principalId}, ${role},
          'active', ${now}, ${now}, ${now}, 1
        )`;
    }
    await owner`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${secondApplicationId}, ${organizationAId},
        ${`second-app-${secondApplicationId}`}, 'Second App', ''
      )`;

    const adminA: Principal = {
      principalId: adminAPrincipalId,
      principalType: "human",
      displayName: "Admin A",
    };
    const developerA: Principal = {
      principalId: developerAPrincipalId,
      principalType: "human",
      displayName: "Developer A",
    };
    const adminB: Principal = {
      principalId: adminBPrincipalId,
      principalType: "human",
      displayName: "Admin B",
    };
    let principal: Principal = adminA;

    const secret = "provide-first-authorized-repository-secret";
    const authorityRunner = new PostgresAuthorityRunner(appPg);
    const commandRunner = createPostgresCommandRunner();
    const taskRegistry = createTaskActionRegistry(
      createWorkTaskHandlers(secret),
      { authorityRunner, commandRunner },
    );
    const projectsRegistry = createProjectsActionRegistry(
      createProjectsHandlers(secret),
      { authorityRunner, commandRunner },
    );
    const app = createApiRouter({
      registry: taskRegistry,
      createContext: () => ({ principal }),
    });
    app.route(
      "/",
      createApiRouter({
        registry: projectsRegistry,
        createContext: () => ({ principal }),
      }),
    );

    const send = (
      method: string,
      path: string,
      options: {
        organizationId: string;
        body?: unknown;
        idempotencyKey?: string;
        ifMatch?: string;
      },
    ): Response | Promise<Response> => {
      const headers: Record<string, string> = {
        "Bakery-Organization-Id": options.organizationId,
      };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (options.idempotencyKey !== undefined) {
        headers["Idempotency-Key"] = options.idempotencyKey;
      }
      if (options.ifMatch !== undefined) headers["If-Match"] = options.ifMatch;
      return app.fetch(
        new Request(`http://test${path}`, {
          method,
          headers,
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        }),
      );
    };

    let applicationId = "";
    let repositoryId = "";
    let mainIntegrationConnectionId = "";
    let revision1ProfileBody: Record<string, unknown> = {};
    let revision2ProfileId = "";
    let revision3ProfileId = "";
    let taskId = "";
    const profileConfig: ProfileConfig = {
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      branches: { base: "main", allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
    };
    let successfulCommandCount = 0;

    await test.step("1. owner flow", async () => {
      const createApplication = await send("POST", "/v1/applications", {
        organizationId: organizationAId,
        idempotencyKey: "app-create-1",
        body: { slug: "bakery", name: "Bakery", description: "" },
      });
      assertEquals(createApplication.status, 201);
      successfulCommandCount++;
      const applicationBody = await createApplication.json() as Record<
        string,
        unknown
      >;
      applicationId = applicationBody.id as string;

      mainIntegrationConnectionId = crypto.randomUUID();
      const createRepository = await send("POST", "/v1/repositories", {
        organizationId: organizationAId,
        idempotencyKey: "repo-create-1",
        body: {
          applicationId,
          slug: "bakery",
          integrationConnectionId: mainIntegrationConnectionId,
          providerRepoId: "owner/bakery",
          owner: "bakery-owner",
          name: "bakery",
          defaultBranch: "main",
        },
      });
      assertEquals(createRepository.status, 201);
      successfulCommandCount++;
      const repositoryBody = await createRepository.json() as Record<
        string,
        unknown
      >;
      repositoryId = repositoryBody.id as string;
      assertEquals(repositoryBody.version, 1);
      assertEquals(repositoryBody.activeProfileId, null);

      const publishRevision1 = await send(
        "POST",
        `/v1/repositories/${repositoryId}/profiles`,
        {
          organizationId: organizationAId,
          idempotencyKey: "profile-create-1",
          body: {
            revision: 1,
            config: profileConfig,
            digest: await digestFor(profileConfig),
          },
        },
      );
      assertEquals(publishRevision1.status, 201);
      successfulCommandCount++;
      const revision1Body = await publishRevision1.json() as Record<
        string,
        unknown
      >;
      const revision1ProfileId = revision1Body.id as string;

      const repositoryAfterActivation = await send(
        "GET",
        `/v1/repositories/${repositoryId}`,
        { organizationId: organizationAId },
      );
      assertEquals(repositoryAfterActivation.status, 200);
      const repositoryAfterActivationBody = await repositoryAfterActivation
        .json() as Record<string, unknown>;
      assertEquals(
        repositoryAfterActivationBody.activeProfileId,
        revision1ProfileId,
      );
      assertEquals(repositoryAfterActivationBody.version, 2);

      const listProfiles = await send(
        "GET",
        `/v1/repositories/${repositoryId}/profiles`,
        { organizationId: organizationAId },
      );
      assertEquals(listProfiles.status, 200);
      const listProfilesBody = await listProfiles.json() as {
        items: Record<string, unknown>[];
      };
      assertEquals(listProfilesBody.items.length, 1);
      revision1ProfileBody = listProfilesBody.items[0];

      principal = developerA;
      const developerList = await send("GET", "/v1/repositories", {
        organizationId: organizationAId,
      });
      assertEquals(developerList.status, 200);
      const developerGet = await send(
        "GET",
        `/v1/repositories/${repositoryId}`,
        { organizationId: organizationAId },
      );
      assertEquals(developerGet.status, 200);
      const developerCreateApplication = await send(
        "POST",
        "/v1/applications",
        {
          organizationId: organizationAId,
          idempotencyKey: "developer-app-create",
          body: {
            slug: "developer-app",
            name: "Developer App",
            description: "",
          },
        },
      );
      assertEquals(developerCreateApplication.status, 403);
      const developerCreateApplicationBody = await developerCreateApplication
        .json() as Record<string, unknown>;
      assertEquals(developerCreateApplicationBody.code, "AUTH_FORBIDDEN");
      principal = adminA;
    });

    await test.step("2. validation", async () => {
      const repeatRevision1 = await send(
        "POST",
        `/v1/repositories/${repositoryId}/profiles`,
        {
          organizationId: organizationAId,
          idempotencyKey: "profile-revision-1-repeat",
          body: {
            revision: 1,
            config: profileConfig,
            digest: await digestFor(profileConfig),
          },
        },
      );
      assertEquals(repeatRevision1.status, 409);
      const repeatRevision1Body = await repeatRevision1.json() as Record<
        string,
        unknown
      >;
      assertEquals(repeatRevision1Body.code, "STATE_CONFLICT");

      const wrongDigest = await send(
        "POST",
        `/v1/repositories/${repositoryId}/profiles`,
        {
          organizationId: organizationAId,
          idempotencyKey: "profile-wrong-digest",
          body: { revision: 2, config: profileConfig, digest: "a".repeat(64) },
        },
      );
      assertEquals(wrongDigest.status, 422);
      const wrongDigestBody = await wrongDigest.json() as {
        issues: { code: string; path: unknown[] }[];
      };
      assertEquals(wrongDigestBody.issues[0].code, "digest_mismatch");
      assertEquals(wrongDigestBody.issues[0].path, ["digest"]);

      const mismatchedBaseConfig: ProfileConfig = {
        ...profileConfig,
        branches: { ...profileConfig.branches, base: "develop" },
      };
      const wrongBase = await send(
        "POST",
        `/v1/repositories/${repositoryId}/profiles`,
        {
          organizationId: organizationAId,
          idempotencyKey: "profile-wrong-base",
          body: {
            revision: 2,
            config: mismatchedBaseConfig,
            digest: await digestFor(mismatchedBaseConfig),
          },
        },
      );
      assertEquals(wrongBase.status, 422);
      const wrongBaseBody = await wrongBase.json() as {
        issues: { code: string }[];
      };
      assertEquals(wrongBaseBody.issues[0].code, "base_branch_mismatch");

      const escapingWorktreeConfig: ProfileConfig = {
        ...profileConfig,
        worktree: { root: "../x" },
      };
      const wrongWorktree = await send(
        "POST",
        `/v1/repositories/${repositoryId}/profiles`,
        {
          organizationId: organizationAId,
          idempotencyKey: "profile-wrong-worktree",
          body: {
            revision: 2,
            config: escapingWorktreeConfig,
            digest: await digestFor(escapingWorktreeConfig),
          },
        },
      );
      assertEquals(wrongWorktree.status, 422);
      const wrongWorktreeBody = await wrongWorktree.json() as {
        issues: { path: string[] }[];
      };
      assertEquals(
        wrongWorktreeBody.issues[0].path.slice(0, 3),
        ["config", "worktree", "root"],
      );

      const duplicateRepository = await send("POST", "/v1/repositories", {
        organizationId: organizationAId,
        idempotencyKey: "repo-duplicate",
        body: {
          applicationId,
          slug: "bakery-duplicate",
          integrationConnectionId: mainIntegrationConnectionId,
          providerRepoId: "owner/bakery",
          owner: "bakery-owner",
          name: "bakery-duplicate",
          defaultBranch: "main",
        },
      });
      assertEquals(duplicateRepository.status, 409);
      const duplicateRepositoryBody = await duplicateRepository
        .json() as Record<string, unknown>;
      assertEquals(duplicateRepositoryBody.code, "STATE_CONFLICT");
    });

    await test.step("3. immutability", async () => {
      const publishRevision2 = await send(
        "POST",
        `/v1/repositories/${repositoryId}/profiles`,
        {
          organizationId: organizationAId,
          idempotencyKey: "profile-create-2",
          body: {
            revision: 2,
            config: profileConfig,
            digest: await digestFor(profileConfig),
          },
        },
      );
      assertEquals(publishRevision2.status, 201);
      successfulCommandCount++;
      const revision2Body = await publishRevision2.json() as Record<
        string,
        unknown
      >;
      revision2ProfileId = revision2Body.id as string;

      const listAfterRevision2 = await send(
        "GET",
        `/v1/repositories/${repositoryId}/profiles`,
        { organizationId: organizationAId },
      );
      const listAfterRevision2Body = await listAfterRevision2.json() as {
        items: Record<string, unknown>[];
      };
      const revision1Item = listAfterRevision2Body.items.find((item) =>
        item.revision === 1
      );
      assertEquals(revision1Item, revision1ProfileBody);

      const versionCheck = await owner`
        select count(*)::int as count from bakery.repository_profiles
        where version <> 1
      `;
      assertEquals(versionCheck[0].count, 0);

      const permissionError = await assertRejects(() =>
        appPg.query("update bakery.repository_profiles set digest = digest")
      );
      const pgPermissionError = permissionError as { code?: string };
      assertEquals(pgPermissionError.code, "42501");
    });

    await test.step("4. selection and cas", async () => {
      const staleIfMatch = await send(
        "PATCH",
        `/v1/repositories/${repositoryId}`,
        {
          organizationId: organizationAId,
          idempotencyKey: "repo-select-stale",
          ifMatch: '"1"',
          body: { activeProfileId: revision2ProfileId },
        },
      );
      assertEquals(staleIfMatch.status, 412);
      const staleIfMatchBody = await staleIfMatch.json() as Record<
        string,
        unknown
      >;
      assertEquals(staleIfMatchBody.code, "PRECONDITION_FAILED");

      const selectRevision2 = await send(
        "PATCH",
        `/v1/repositories/${repositoryId}`,
        {
          organizationId: organizationAId,
          idempotencyKey: "repo-select-revision-2",
          ifMatch: '"2"',
          body: { activeProfileId: revision2ProfileId },
        },
      );
      assertEquals(selectRevision2.status, 200);
      successfulCommandCount++;
      const selectRevision2Body = await selectRevision2.json() as Record<
        string,
        unknown
      >;
      assertEquals(selectRevision2Body.version, 3);

      const otherRepository = await send("POST", "/v1/repositories", {
        organizationId: organizationAId,
        idempotencyKey: "other-repo-create",
        body: {
          applicationId,
          slug: "other-repo",
          integrationConnectionId: crypto.randomUUID(),
          providerRepoId: "owner/other-repo",
          owner: "bakery-owner",
          name: "other-repo",
          defaultBranch: "main",
        },
      });
      assertEquals(otherRepository.status, 201);
      successfulCommandCount++;
      const otherRepositoryBody = await otherRepository.json() as Record<
        string,
        unknown
      >;
      const otherRepositoryId = otherRepositoryBody.id as string;
      const otherRepositoryConfig: ProfileConfig = { ...profileConfig };
      const otherRepositoryProfile = await send(
        "POST",
        `/v1/repositories/${otherRepositoryId}/profiles`,
        {
          organizationId: organizationAId,
          idempotencyKey: "other-repo-profile-create",
          body: {
            revision: 1,
            config: otherRepositoryConfig,
            digest: await digestFor(otherRepositoryConfig),
          },
        },
      );
      assertEquals(otherRepositoryProfile.status, 201);
      successfulCommandCount++;
      const otherRepositoryProfileBody = await otherRepositoryProfile
        .json() as Record<string, unknown>;

      const crossRepositorySelect = await send(
        "PATCH",
        `/v1/repositories/${repositoryId}`,
        {
          organizationId: organizationAId,
          idempotencyKey: "repo-select-cross-repo",
          ifMatch: '"3"',
          body: { activeProfileId: otherRepositoryProfileBody.id },
        },
      );
      assertEquals(crossRepositorySelect.status, 422);
      const crossRepositorySelectBody = await crossRepositorySelect.json() as {
        issues: { code: string }[];
      };
      assertEquals(
        crossRepositorySelectBody.issues[0].code,
        "profile_not_in_repository",
      );

      const raceResponses = await Promise.all([
        send("PATCH", `/v1/repositories/${repositoryId}`, {
          organizationId: organizationAId,
          idempotencyKey: "repo-select-race-1",
          ifMatch: '"3"',
          body: { name: "bakery-renamed-one" },
        }),
        send("PATCH", `/v1/repositories/${repositoryId}`, {
          organizationId: organizationAId,
          idempotencyKey: "repo-select-race-2",
          ifMatch: '"3"',
          body: { name: "bakery-renamed-two" },
        }),
      ]);
      assertEquals(
        raceResponses.map((response) => response.status).sort(),
        [200, 412],
      );
      successfulCommandCount++;
    });

    await test.step("5. racing publishes", async () => {
      const revision3Config: ProfileConfig = { ...profileConfig };
      const revision3Digest = await digestFor(revision3Config);
      const raceResponses = await Promise.all([
        send("POST", `/v1/repositories/${repositoryId}/profiles`, {
          organizationId: organizationAId,
          idempotencyKey: "profile-race-1",
          body: {
            revision: 3,
            config: revision3Config,
            digest: revision3Digest,
          },
        }),
        send("POST", `/v1/repositories/${repositoryId}/profiles`, {
          organizationId: organizationAId,
          idempotencyKey: "profile-race-2",
          body: {
            revision: 3,
            config: revision3Config,
            digest: revision3Digest,
          },
        }),
      ]);
      assertEquals(
        raceResponses.map((response) => response.status).sort(),
        [201, 409],
      );
      successfulCommandCount++;
      const raceBodies = await Promise.all(
        raceResponses.map((response) => response.json()),
      );
      const winnerIndex = raceResponses.findIndex((response) =>
        response.status === 201
      );
      const winnerBody = raceBodies[winnerIndex] as Record<string, unknown>;
      revision3ProfileId = winnerBody.id as string;
    });

    await test.step("6. task pin", async () => {
      const createTask = await send("POST", "/v1/tasks", {
        organizationId: organizationAId,
        idempotencyKey: "task-create-pin",
        body: {
          applicationId,
          repositoryId,
          repositoryProfileId: revision2ProfileId,
          taskType: "feature",
          title: "Pinned task",
        },
      });
      assertEquals(createTask.status, 201);
      successfulCommandCount++;
      const taskBody = await createTask.json() as Record<string, unknown>;
      taskId = taskBody.id as string;
      assertEquals(taskBody.repositoryProfileId, revision2ProfileId);
      assertEquals(taskBody.repositoryProfileRevision, 2);
      assertEquals(
        taskBody.repositoryProfileDigest,
        await digestFor(profileConfig),
      );

      const selectRevision3 = await send(
        "PATCH",
        `/v1/repositories/${repositoryId}`,
        {
          organizationId: organizationAId,
          idempotencyKey: "repo-select-revision-3",
          ifMatch: '"4"',
          body: { activeProfileId: revision3ProfileId },
        },
      );
      assertEquals(selectRevision3.status, 200);
      successfulCommandCount++;
      const selectRevision3Body = await selectRevision3.json() as Record<
        string,
        unknown
      >;
      assertEquals(selectRevision3Body.version, 5);

      const beforeStale = await owner`
        select
          (select count(*)::int from bakery.conversations where organization_id = ${organizationAId}) as conversations,
          (select count(*)::int from bakery.tasks where organization_id = ${organizationAId}) as tasks,
          (select count(*)::int from bakery.workflow_runs where organization_id = ${organizationAId}) as runs,
          (select count(*)::int from bakery.jobs where organization_id = ${organizationAId}) as jobs
      `;
      const staleProfileTask = await send("POST", "/v1/tasks", {
        organizationId: organizationAId,
        idempotencyKey: "task-create-stale-profile",
        body: {
          applicationId,
          repositoryId,
          repositoryProfileId: revision2ProfileId,
          taskType: "feature",
          title: "Stale profile task",
        },
      });
      assertEquals(staleProfileTask.status, 409);
      assertEquals(
        (await staleProfileTask.json() as { code: string }).code,
        "STATE_CONFLICT",
      );
      const afterStale = await owner`
        select
          (select count(*)::int from bakery.conversations where organization_id = ${organizationAId}) as conversations,
          (select count(*)::int from bakery.tasks where organization_id = ${organizationAId}) as tasks,
          (select count(*)::int from bakery.workflow_runs where organization_id = ${organizationAId}) as runs,
          (select count(*)::int from bakery.jobs where organization_id = ${organizationAId}) as jobs
      `;
      assertEquals(afterStale[0], beforeStale[0]);

      const taskAfterSelection = await send(
        "GET",
        `/v1/tasks/${taskId}`,
        { organizationId: organizationAId },
      );
      assertEquals(taskAfterSelection.status, 200);
      const taskAfterSelectionBody = await taskAfterSelection.json() as Record<
        string,
        unknown
      >;
      assertEquals(
        taskAfterSelectionBody.repositoryProfileId,
        revision2ProfileId,
      );

      const rejectedTaskUpdate = await send("PATCH", `/v1/tasks/${taskId}`, {
        organizationId: organizationAId,
        idempotencyKey: "task-update-reject-pin",
        ifMatch: '"1"',
        body: { repositoryProfileId: revision3ProfileId },
      });
      assertEquals(rejectedTaskUpdate.status, 400);
    });

    await test.step("7. admission guard", async () => {
      const unknownRepository = await send("POST", "/v1/tasks", {
        organizationId: organizationAId,
        idempotencyKey: "task-unknown-repo",
        body: {
          applicationId,
          repositoryId: crypto.randomUUID(),
          taskType: "feature",
          title: "Unknown repo",
        },
      });
      assertEquals(unknownRepository.status, 404);

      const secondApplicationRepository = await send(
        "POST",
        "/v1/repositories",
        {
          organizationId: organizationAId,
          idempotencyKey: "second-app-repo-create",
          body: {
            applicationId: secondApplicationId,
            slug: "second-app-repo",
            integrationConnectionId: crypto.randomUUID(),
            providerRepoId: "owner/second-app-repo",
            owner: "bakery-owner",
            name: "second-app-repo",
            defaultBranch: "main",
          },
        },
      );
      assertEquals(secondApplicationRepository.status, 201);
      successfulCommandCount++;
      const secondApplicationRepositoryBody = await secondApplicationRepository
        .json() as Record<string, unknown>;

      const crossApplicationTask = await send("POST", "/v1/tasks", {
        organizationId: organizationAId,
        idempotencyKey: "task-cross-application-repo",
        body: {
          applicationId,
          repositoryId: secondApplicationRepositoryBody.id,
          taskType: "feature",
          title: "Cross application",
        },
      });
      assertEquals(crossApplicationTask.status, 404);

      const archiveRepository = await send(
        "PATCH",
        `/v1/repositories/${repositoryId}`,
        {
          organizationId: organizationAId,
          idempotencyKey: "repo-archive",
          ifMatch: '"5"',
          body: { archivedAt: now.toISOString() },
        },
      );
      assertEquals(archiveRepository.status, 200);
      successfulCommandCount++;

      const archivedRepositoryTask = await send("POST", "/v1/tasks", {
        organizationId: organizationAId,
        idempotencyKey: "task-archived-repo",
        body: {
          applicationId,
          repositoryId,
          taskType: "feature",
          title: "Archived repo",
        },
      });
      assertEquals(archivedRepositoryTask.status, 409);
      const archivedRepositoryTaskBody = await archivedRepositoryTask
        .json() as Record<string, unknown>;
      assertEquals(archivedRepositoryTaskBody.code, "STATE_CONFLICT");

      const freshRepository = await send("POST", "/v1/repositories", {
        organizationId: organizationAId,
        idempotencyKey: "fresh-repo-no-profile",
        body: {
          applicationId,
          slug: "fresh-repo",
          integrationConnectionId: crypto.randomUUID(),
          providerRepoId: "owner/fresh-repo",
          owner: "bakery-owner",
          name: "fresh-repo",
          defaultBranch: "main",
        },
      });
      assertEquals(freshRepository.status, 201);
      successfulCommandCount++;
      const freshRepositoryBody = await freshRepository.json() as Record<
        string,
        unknown
      >;

      const freshRepositoryTask = await send("POST", "/v1/tasks", {
        organizationId: organizationAId,
        idempotencyKey: "task-fresh-repo-no-profile",
        body: {
          applicationId,
          repositoryId: freshRepositoryBody.id,
          taskType: "feature",
          title: "Fresh repo no profile",
        },
      });
      assertEquals(freshRepositoryTask.status, 409);
      const freshRepositoryTaskBody = await freshRepositoryTask
        .json() as Record<string, unknown>;
      assertEquals(freshRepositoryTaskBody.code, "STATE_CONFLICT");

      const inconsistentExpectation = await send("POST", "/v1/tasks", {
        organizationId: organizationAId,
        idempotencyKey: "task-profile-without-repository",
        body: {
          applicationId,
          repositoryProfileId: revision3ProfileId,
          taskType: "feature",
          title: "Profile without repository",
        },
      });
      assertEquals(inconsistentExpectation.status, 422);

      const noRepositoryTask = await send("POST", "/v1/tasks", {
        organizationId: organizationAId,
        idempotencyKey: "task-no-repository",
        body: { applicationId, taskType: "feature", title: "No repository" },
      });
      assertEquals(noRepositoryTask.status, 201);
      successfulCommandCount++;
      const noRepositoryTaskBody = await noRepositoryTask.json() as Record<
        string,
        unknown
      >;
      assertEquals(noRepositoryTaskBody.repositoryProfileId, null);
      assertEquals(noRepositoryTaskBody.repositoryProfileRevision, null);
      assertEquals(noRepositoryTaskBody.repositoryProfileDigest, null);
    });

    await test.step("8. tenant isolation", async () => {
      principal = adminB;
      const listAsB = await send("GET", "/v1/repositories", {
        organizationId: organizationBId,
      });
      assertEquals(listAsB.status, 200);
      const listAsBBody = await listAsB.json() as { items: unknown[] };
      assertEquals(listAsBBody.items, []);

      const getAsB = await send("GET", `/v1/repositories/${repositoryId}`, {
        organizationId: organizationBId,
      });
      assertEquals(getAsB.status, 404);

      const createTaskAsB = await send("POST", "/v1/tasks", {
        organizationId: organizationBId,
        idempotencyKey: "task-cross-tenant",
        body: {
          applicationId: crypto.randomUUID(),
          repositoryId,
          taskType: "feature",
          title: "Cross tenant",
        },
      });
      assertEquals(createTaskAsB.status, 404);

      const listWithHeaderA = await send("GET", "/v1/repositories", {
        organizationId: organizationAId,
      });
      assertEquals(listWithHeaderA.status, 404);

      principal = adminA;
    });

    await test.step("9. replay after restart", async () => {
      const dropKey = "repo-replay-restart";
      const replayIntegrationConnectionId = crypto.randomUUID();
      const replayProviderRepoId = "owner/replay-repo";
      const requestHeaders = {
        "content-type": "application/json",
        "Bakery-Organization-Id": organizationAId,
        "Idempotency-Key": dropKey,
      };
      const createBody = JSON.stringify({
        applicationId,
        slug: "replay-repo",
        integrationConnectionId: replayIntegrationConnectionId,
        providerRepoId: replayProviderRepoId,
        owner: "bakery-owner",
        name: "replay-repo",
        defaultBranch: "main",
      });
      const commonEnv = {
        FIXTURE_APP_DATABASE_URL: appDatabaseUrl,
        FIXTURE_PRINCIPAL_ID: adminAPrincipalId,
        FIXTURE_DISPLAY_NAME: "Admin A",
      };

      const first = await startFixture({
        ...commonEnv,
        FIXTURE_DROP_KEY: dropKey,
      });
      let dropped = false;
      try {
        await fetch(`http://127.0.0.1:${first.port}/v1/repositories`, {
          method: "POST",
          headers: requestHeaders,
          body: createBody,
        });
      } catch {
        dropped = true;
      }
      assertEquals(dropped, true);
      await first.child.status;
      successfulCommandCount++;

      const committedRepositories = await owner`
        select id from bakery.repositories
        where organization_id = ${organizationAId}
          and provider_repo_id = ${replayProviderRepoId}
          and integration_connection_id = ${replayIntegrationConnectionId}
      `;
      assertEquals(committedRepositories.length, 1);
      const committedRepositoryId = committedRepositories[0].id as string;

      const idempotencyRow = await owner`
        select status, response_status from bakery.idempotency_records
        where organization_id = ${organizationAId}
          and operation = 'repositories.create' and key = ${dropKey}
      `;
      assertEquals(idempotencyRow.length, 1);
      assertEquals(idempotencyRow[0].status, "completed");
      assertEquals(idempotencyRow[0].response_status, 201);

      const beforeReplayCount = await owner`
        select count(*)::int as count from bakery.repositories
      `;
      const second = await startFixture(commonEnv);
      try {
        const replay = await fetch(
          `http://127.0.0.1:${second.port}/v1/repositories`,
          { method: "POST", headers: requestHeaders, body: createBody },
        );
        assertEquals(replay.status, 201);
        assertEquals(replay.headers.get("idempotent-replayed"), "true");
        const replayedBody = await replay.json() as Record<string, unknown>;
        assertEquals(replayedBody.id, committedRepositoryId);
      } finally {
        second.child.kill();
        await second.child.status;
      }
      const afterReplayCount = await owner`
        select count(*)::int as count from bakery.repositories
      `;
      assertEquals(afterReplayCount[0].count, beforeReplayCount[0].count);
    });

    await test.step("10. facts", async () => {
      const eventTypeRows = await owner`
        select event_type as "eventType" from bakery.domain_events
        where organization_id = ${organizationAId}
        order by organization_sequence
      `;
      const eventTypes = eventTypeRows.map((row) => row.eventType as string);
      for (
        const expected of [
          "applications.created",
          "repositories.created",
          "repositories.updated",
          "repository.profile_created",
          "tasks.created",
        ]
      ) {
        assert(
          eventTypes.includes(expected),
          `expected ${expected} in domain events, got ${eventTypes.join(", ")}`,
        );
      }

      const unmappedOutbox = await owner`
        select count(*)::int as count
        from bakery.outbox as o
        join bakery.domain_events as e on e.id = o.event_id
        where e.event_type like 'repositor%' or e.event_type = 'applications.created'
      `;
      assertEquals(unmappedOutbox[0].count, 0);

      const auditCount = await owner`
        select count(*)::int as count from bakery.audit_events
        where organization_id = ${organizationAId}
      `;
      assertEquals(auditCount[0].count, successfulCommandCount);
    });
  } finally {
    await closePgDatabase(appPg);
    await closePgDatabase(authDb);
    try {
      await resetTestDatabase(owner, {
        targetUrl: databaseUrl,
        ...readTestDatabaseResetOptions(),
      });
    } finally {
      await closeDatabase(owner);
    }
  }
});
