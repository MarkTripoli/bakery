import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
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
import { workBakeryMigrationSource } from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { createCoordinationActionRegistry } from "../../apps/server/src/coordination-actions.ts";
import { createConversationActionRegistry } from "../../apps/server/src/conversation-actions.ts";
import {
  answerQuestion,
  createQuestionsListHandler,
  getQuestion,
} from "../../apps/server/src/modules/conversation/questions.ts";
import {
  cancelCoordinationPlanCommand,
  createCoordinationPlanCommand,
  createCoordinationPlanFromWorkflowCommand,
  materializeCoordinationPlanCommand,
  setApplicationRepositoryRoleCommand,
  setTaskRepositoryCommand,
} from "../../apps/server/src/modules/work/coordination-command.ts";
import { createCoordinationQueryHandlers } from "../../apps/server/src/modules/work/coordination-query.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { cleanupAuthFixture, signSessionCookie } from "./auth.ts";

export type FixturePrincipal = {
  principalId: string;
  principalType: "human";
  displayName: string;
  userId: string;
};

export type Send = (
  principal: FixturePrincipal,
  method: string,
  path: string,
  options?: {
    organizationId?: string;
    body?: unknown;
    key?: string;
    ifMatch?: string;
  },
) => Promise<Response>;

const now = new Date("2026-10-15T00:00:00.000Z");
const profileConfig = {
  schemaVersion: 1,
  workflow: { kind: "fixed" },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};

export type CoordinationFixtureState = {
  suffix: string;
  organizationId: string;
  hostileOrganizationId: string;
  applicationId: string;
  otherApplicationId: string;
  admin: FixturePrincipal;
  developer: FixturePrincipal;
  viewer: FixturePrincipal;
  outsider: FixturePrincipal;
  repositories: Record<
    "api" | "web" | "mobile" | "integration" | "foreign",
    { repositoryId: string; profileId: string }
  >;
  workflowId: string;
  workflowVersionId: string;
  profileDigest: string;
  userEmails: string[];
};

/** Seeds one organization graph and returns ids a second process can attach to. */
async function seedCoordinationState(
  owner: ReturnType<typeof openDatabase>,
): Promise<CoordinationFixtureState> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const organizationId = crypto.randomUUID();
  const hostileOrganizationId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const otherApplicationId = crypto.randomUUID();
  await owner`
    insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
    values (${organizationId}, 'Coordination Org', ${`coord-${suffix}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
  await owner`
    insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
    values (${hostileOrganizationId}, 'Hostile Org', ${`hostile-${suffix}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
  for (
    const [id, slug] of [[applicationId, "main"], [otherApplicationId, "other"]]
  ) {
    await owner`
      insert into bakery.applications (id, organization_id, slug, name, description)
      values (${id}, ${organizationId}, ${`${slug}-${suffix}`}, ${slug}, '')`;
  }

  const userEmails: string[] = [];
  const makePrincipal = async (
    name: string,
    orgId: string,
    role: "admin" | "developer" | "viewer",
  ): Promise<FixturePrincipal> => {
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    userEmails.push(`${name}-${userId}@example.test`);
    await owner`
      insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, ${name}, ${`${name}-${userId}@example.test`}, true, ${now}, ${now})`;
    await owner`
      insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${userId}, ${name}, 'human')`;
    await owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version
      ) values (${crypto.randomUUID()}, ${orgId}, ${principalId}, ${role}, 'active', ${now}, ${now}, ${now}, 1)`;
    return { principalId, principalType: "human", displayName: name, userId };
  };
  const admin = await makePrincipal("coord-admin", organizationId, "admin");
  const developer = await makePrincipal(
    "coord-developer",
    organizationId,
    "developer",
  );
  const viewer = await makePrincipal("coord-viewer", organizationId, "viewer");
  const outsider = await makePrincipal(
    "coord-outsider",
    hostileOrganizationId,
    "admin",
  );

  const profileDigest = await sha256Hex(canonicalJson(profileConfig));
  const makeRepository = async (name: string, appId = applicationId) => {
    const repositoryId = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    await owner`
      insert into bakery.repositories (
        id, organization_id, application_id, integration_connection_id,
        provider_repo_id, owner, name, default_branch, version
      ) values (${repositoryId}, ${organizationId}, ${appId}, ${crypto.randomUUID()},
        ${`owner/${name}-${suffix}`}, 'bakery-owner', ${`${name}-${suffix}`}, 'main', 1)`;
    await owner`
      insert into bakery.repository_profiles (
        id, organization_id, repository_id, revision, config, digest, created_by, version
      ) values (${profileId}, ${organizationId}, ${repositoryId}, 1,
        ${
      owner.json(profileConfig)
    }, ${profileDigest}, ${admin.principalId}, 1)`;
    await owner`
      update bakery.repositories set active_profile_id = ${profileId}, version = 2
       where organization_id = ${organizationId} and id = ${repositoryId}`;
    return { repositoryId, profileId };
  };
  const repositories = {
    api: await makeRepository("api"),
    web: await makeRepository("web"),
    mobile: await makeRepository("mobile"),
    integration: await makeRepository("integration"),
    foreign: await makeRepository("foreign", otherApplicationId),
  };

  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const workflowSpec = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "coordination-fixed",
    steps: [{
      id: "review",
      uses: "mcp.discover",
      with: { connectionId: crypto.randomUUID() },
    }],
  };
  await owner`
    insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled, version)
    values (${workflowId}, ${organizationId}, ${`coord-${suffix}`}, 'Coordination', true, 1)`;
  await owner`
    insert into bakery.workflow_versions (
      id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
      digest, status, created_by, version
    ) values (${workflowVersionId}, ${organizationId}, ${workflowId}, 1, '',
      ${owner.json(workflowSpec)}, ${await sha256Hex(
    canonicalJson(workflowSpec),
  )},
      'published', ${admin.principalId}, 1)`;
  await owner`
    update bakery.workflow_definitions set active_version_id = ${workflowVersionId}
     where organization_id = ${organizationId} and id = ${workflowId}`;

  return {
    suffix,
    organizationId,
    hostileOrganizationId,
    applicationId,
    otherApplicationId,
    admin,
    developer,
    viewer,
    outsider,
    repositories,
    workflowId,
    workflowVersionId,
    profileDigest,
    userEmails,
  };
}

/**
 * Real Postgres, real registries, repositories and principals. With `attach`,
 * another process continues over the rows an earlier process seeded.
 */
export async function openCoordinationFixture(
  options: { attach?: CoordinationFixtureState } = {},
) {
  const { databaseUrl, appDatabaseUrl } = readTestDatabaseConfig();
  const owner = openDatabase(databaseUrl);
  const authDb = openPgDatabase(databaseUrl);
  let appPg = openPgDatabase(appDatabaseUrl);
  let appDatabase = openDatabase(appDatabaseUrl);
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

  const state: CoordinationFixtureState = options.attach ??
    await seedCoordinationState(owner);
  const {
    suffix,
    organizationId,
    hostileOrganizationId,
    applicationId,
    otherApplicationId,
    admin,
    developer,
    viewer,
    outsider,
    repositories,
    workflowVersionId,
    profileDigest,
    userEmails,
  } = state;

  const commandRunner = createPostgresCommandRunner();
  const queries = createCoordinationQueryHandlers("coordination-test-secret");
  let current: FixturePrincipal = developer;
  const secret = "coordination-production-secret-value-32-bytes";
  const config = readRuntimeConfig({
    BAKERY_ENV: "test",
    BAKERY_APP_DATABASE_URL: appDatabaseUrl,
    BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8788",
    BETTER_AUTH_SECRET: secret,
  });
  // The server side of the fixture: everything that holds an application
  // database connection. A restart drops it and builds it again over the same
  // rows, like a restarted server process.
  const compose = async () => {
    const authorityRunner = new PostgresAuthorityRunner(appPg);
    const registryApp = createApiRouter({
      registry: createCoordinationActionRegistry({
        plansCreate: createCoordinationPlanCommand,
        plansCreateFromWorkflow: createCoordinationPlanFromWorkflowCommand,
        plansList: queries.plansList,
        plansGet: queries.plansGet,
        plansMaterialize: materializeCoordinationPlanCommand,
        plansCancel: cancelCoordinationPlanCommand,
        taskRepositoriesList: queries.taskRepositoriesList,
        taskRepositoriesSet: setTaskRepositoryCommand,
        rolesList: queries.rolesList,
        rolesSet: setApplicationRepositoryRoleCommand,
      }, { authorityRunner, commandRunner }),
      createContext: () => ({ principal: current }),
    });
    const taskApp = createApiRouter({
      registry: createTaskActionRegistry(
        createWorkTaskHandlers("coordination-task-secret"),
        { authorityRunner, commandRunner },
      ),
      createContext: () => ({ principal: current }),
    });
    // The real question-reading and answering operations; every other
    // conversation operation is out of scope for this fixture.
    const real: Record<string, unknown> = {
      questionsList: createQuestionsListHandler("coordination-question-secret"),
      questionsGet: getQuestion,
      questionsAnswer: answerQuestion,
    };
    const questionsApp = createApiRouter({
      registry: createConversationActionRegistry(
        new Proxy({}, {
          get: (_, name) => real[String(name)] ?? (() => undefined),
        }) as never,
        { authorityRunner, commandRunner },
      ),
      createContext: () => ({ principal: current }),
    });
    // Full production composition (session cookie, middleware, routes).
    const persistence = createPostgresAuthPersistence(appPg);
    const auth = await createReadyAuthProvider({
      pgDatabase: appPg,
      config: config.auth!,
      persistence,
    });
    const productionApp = createApp({
      config,
      database: appDatabase,
      pgDatabase: appPg,
      auth,
      authPersistence: persistence,
    });
    return { registryApp, taskApp, questionsApp, productionApp };
  };
  let composed = await compose();
  let counter = 0;
  const dispatch = (
    pick: () => { fetch: (request: Request) => Response | Promise<Response> },
  ): Send =>
  async (principal, method, path, options = {}) => {
    current = principal;
    const headers: Record<string, string> = {
      "Bakery-Organization-Id": options.organizationId ?? organizationId,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (method !== "GET") {
      headers["Idempotency-Key"] = options.key ??
        `coord-${suffix}-${++counter}`;
    }
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    return await pick().fetch(
      new Request(`http://test${path}`, {
        method,
        headers,
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
      }),
    );
  };
  const send = dispatch(() => composed.registryApp);
  const sendTask = dispatch(() => composed.taskApp);
  const sendQuestions = dispatch(() => composed.questionsApp);

  const cookieFor = async (principal: FixturePrincipal) => {
    const token = `coord-session-${crypto.randomUUID()}`;
    await owner`
      insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
      values (${crypto.randomUUID()}, ${token}, ${principal.userId},
        ${new Date(Date.now() + 3_600_000)}, ${new Date()}, ${new Date()})`;
    return await signSessionCookie(token, config.auth!.secret);
  };

  let taskCounter = 0;
  const insertTask = async (
    title: string,
    options: { status?: string; repo?: keyof typeof repositories | null } = {},
  ) => {
    const id = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const repo = options.repo === undefined || options.repo === null
      ? null
      : repositories[options.repo];
    await owner`
      insert into bakery.conversations (id, organization_id, application_id, repository_id, title, created_by, created_at, updated_at, version)
      values (${conversationId}, ${organizationId}, ${applicationId}, ${
      repo?.repositoryId ?? null
    }, ${title}, ${admin.principalId}, ${now}, ${now}, 1)`;
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, repository_id, conversation_id,
        title, description, task_type, status, priority, created_by,
        repository_profile_id, repository_profile_revision, repository_profile_digest,
        created_at, updated_at, version
      ) values (${id}, ${organizationId}, ${applicationId}, ${
      repo?.repositoryId ?? null
    },
        ${conversationId}, ${`${title} ${++taskCounter}`}, '', 'epic', ${
      options.status ?? "draft"
    }, 50,
        ${admin.principalId}, ${repo?.profileId ?? null}, ${repo ? 1 : null},
        ${repo ? profileDigest : null}, ${now}, ${now}, 1)`;
    return id;
  };

  return {
    owner,
    ownerPg: authDb,
    get appPg() {
      return appPg;
    },
    state,
    organizationId,
    hostileOrganizationId,
    applicationId,
    otherApplicationId,
    admin,
    developer,
    viewer,
    outsider,
    repositories,
    workflowVersionId,
    profileDigest,
    send,
    sendTask,
    sendQuestions,
    get productionApp() {
      return composed.productionApp;
    },
    cookieFor,
    publicBaseUrl: config.publicBaseUrl,
    insertTask,
    /** Maps the standard aliases so plans can name repositories. */
    async seedAliases() {
      for (
        const [alias, role, key] of [
          ["api", "backend", "api"],
          ["web", "frontend", "web"],
          ["mobile", "mobile", "mobile"],
          ["integration", "integration", "integration"],
        ] as const
      ) {
        const response = await send(
          admin,
          "PUT",
          `/v1/applications/${applicationId}/repository-roles`,
          {
            body: {
              alias,
              role,
              repositoryId: repositories[key].repositoryId,
            },
          },
        );
        if (response.status !== 200) {
          throw new Error(`alias seed failed: ${response.status}`);
        }
      }
    },
    /**
     * Simulates a server restart: every application-database connection is
     * closed and the registries and production app are composed again over the
     * same rows. The test's own admin connection (`owner`) survives.
     */
    async restart() {
      await Promise.all([closePgDatabase(appPg), closeDatabase(appDatabase)]);
      appPg = openPgDatabase(appDatabaseUrl);
      appDatabase = openDatabase(appDatabaseUrl);
      composed = await compose();
    },
    /** Publishes a workflow version with this normalized spec in the org. */
    async publishWorkflowVersion(
      normalizedSpec: unknown,
      options: {
        status?: "published" | "draft";
        organizationId?: string;
        /** Publish another version of an existing definition. */
        workflowId?: string;
        revision?: number;
      } = {},
    ) {
      const orgId = options.organizationId ?? organizationId;
      const id = options.workflowId ?? crypto.randomUUID();
      const versionId = crypto.randomUUID();
      if (!options.workflowId) {
        await owner`
          insert into bakery.workflow_definitions (id, organization_id, slug, name, enabled, version)
          values (${id}, ${orgId}, ${`wf-${
          crypto.randomUUID().slice(0, 8)
        }`}, 'Parallel', true, 1)`;
      }
      await owner`
        insert into bakery.workflow_versions (
          id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
          digest, status, created_by, version
        ) values (${versionId}, ${orgId}, ${id}, ${options.revision ?? 1}, '',
          ${owner.json(normalizedSpec as never)}, ${await sha256Hex(
        canonicalJson(normalizedSpec),
      )}, ${options.status ?? "published"}, ${admin.principalId}, 1)`;
      return { workflowId: id, workflowVersionId: versionId };
    },
    async close() {
      try {
        await cleanupAuthFixture(authDb, userEmails);
      } finally {
        await Promise.all([
          closePgDatabase(authDb),
          closePgDatabase(appPg),
          closeDatabase(appDatabase),
          closeDatabase(owner),
        ]);
      }
    },
  };
}

export type CoordinationFixture = Awaited<
  ReturnType<typeof openCoordinationFixture>
>;

/** Three-lane spec: api exports a contract that web consumes; mobile is independent. */
export function threeLaneSpec(
  overrides: { mobileInstructions?: string } = {},
) {
  return {
    lanes: [
      {
        key: "api",
        repositoryAlias: "api",
        title: "API contract",
        instructions: "publish the contract",
        prerequisites: [],
        outputs: [{ key: "contract", kind: "artifact" }],
        inputs: [],
      },
      {
        key: "web",
        repositoryAlias: "web",
        title: "Web client",
        instructions: "consume the contract",
        prerequisites: ["api"],
        outputs: [],
        inputs: [{ fromLane: "api", outputKey: "contract" }],
      },
      {
        key: "mobile",
        repositoryAlias: "mobile",
        title: "Mobile client",
        instructions: overrides.mobileInstructions ?? "independent work",
        prerequisites: [],
        outputs: [],
        inputs: [],
      },
    ],
    maxConcurrency: 2,
    join: "all-required",
    failurePolicy: "stop-dependent",
  };
}

/**
 * Four-lane spec over four repositories (plans allow one lane per repository):
 * `contract` on api publishes `contract`; independent writers `web` and
 * `mobile` consume it; `integration` consumes both writers' `patch` outputs.
 * Equal, byte for byte, to what the saved-workflow mapper produces for
 * `fourLaneWorkflowDocument`, so every origin describes one request.
 */
export function fourLaneSpec() {
  const patch = { key: "patch", kind: "artifact", artifactType: "patch" };
  return {
    lanes: [
      {
        key: "contract",
        repositoryAlias: "api",
        title: "contract",
        instructions:
          "Workflow lane contract, steps in order:\n- define: agent.implement",
        prerequisites: [],
        outputs: [{ key: "contract", kind: "artifact", artifactType: "patch" }],
        inputs: [],
      },
      {
        key: "web",
        repositoryAlias: "web",
        title: "web",
        instructions:
          "Workflow lane web, steps in order:\n- build: agent.implement",
        prerequisites: ["contract"],
        outputs: [patch],
        inputs: [{ fromLane: "contract", outputKey: "contract" }],
      },
      {
        key: "mobile",
        repositoryAlias: "mobile",
        title: "mobile",
        instructions:
          "Workflow lane mobile, steps in order:\n- build: agent.implement",
        prerequisites: ["contract"],
        outputs: [patch],
        inputs: [{ fromLane: "contract", outputKey: "contract" }],
      },
      {
        key: "integration",
        repositoryAlias: "integration",
        title: "integration",
        instructions:
          "Workflow lane integration, steps in order:\n- verify: agent.implement",
        prerequisites: ["web", "mobile"],
        outputs: [],
        inputs: [
          { fromLane: "web", outputKey: "patch" },
          { fromLane: "mobile", outputKey: "patch" },
        ],
      },
    ],
    maxConcurrency: 2,
    join: "all-required",
    failurePolicy: "stop-dependent",
  };
}

/** Normalized workflow document whose `delivery` parallel node is `fourLaneSpec`. */
export function fourLaneWorkflowDocument() {
  const step = (id: string) => ({
    kind: "action",
    id,
    needs: [],
    action: "agent.implement",
  });
  const exported = { kind: "literal", value: "exported" };
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    steps: [{
      kind: "parallel",
      id: "delivery",
      needs: [],
      maxConcurrency: 2,
      join: "all-required",
      failurePolicy: "stop-dependent",
      lanes: [
        {
          id: "contract",
          needs: [],
          repository: "api",
          steps: [step("define")],
        },
        {
          id: "web",
          needs: ["contract"],
          repository: "web",
          steps: [step("build")],
        },
        {
          id: "mobile",
          needs: ["contract"],
          repository: "mobile",
          steps: [step("build")],
        },
        {
          id: "integration",
          needs: ["web", "mobile"],
          repository: "integration",
          steps: [step("verify")],
        },
      ],
      outputs: {
        contract: { contract: exported },
        web: { patch: exported },
        mobile: { patch: exported },
      },
    }],
  };
}
