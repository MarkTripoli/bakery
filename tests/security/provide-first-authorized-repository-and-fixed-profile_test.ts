import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assert, assertEquals } from "@std/assert";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import {
  principalId as asPrincipalId,
  PrincipalType,
} from "../../packages/contracts/src/contracts.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type { AuthenticatedSubject } from "../../apps/server/src/modules/auth/application/identity.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import {
  createProjectsActionRegistry,
  createProjectsHandlers,
} from "../../apps/server/src/modules/projects/index.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import { createPostgresCommandRunner } from "../../apps/server/src/platform/command-replay.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
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
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { encodeCursor } from "../../apps/server/src/platform/cursor.ts";

// -- Header matrix (fake database) -------------------------------------------
//
// Copied from `tests/security/enforce-live-organization-roles-grants-and-tenant-isolation_test.ts:36-102`
// (file-local helper); the projects registry's nine actions all declare
// `organizationContext: "required_authenticated_context"` with no
// `organizationIdParam`, so a header naming a real-but-foreign organization
// ("conflicting") behaves exactly like one naming an org the caller has no
// membership in ("unauthorized"): both reach the transaction and fail on the
// empty membership lookup, unlike the organization-scoped routes the
// reference test covers, where a path-embedded organization id short-circuits
// "conflicting" before any query runs.

type FakeState = {
  principal: AuthenticatedSubject | null;
  memberships?: Record<
    string,
    {
      principalId?: string;
      role: "admin" | "developer" | null;
      status: "active" | "inactive";
    }
  >;
  grants?: Array<{
    organizationId: string;
    capability: string;
    role?: "admin" | "developer";
    expiresAt?: number;
    revoked?: boolean;
  }>;
  installationAdministrator?: boolean;
};

function fakeDatabase(state: FakeState) {
  const statements: string[] = [];
  let releases = 0;
  const client = {
    query(text: string, values: unknown[] = []) {
      const sql = text.replaceAll(/\s+/g, " ").trim().toLowerCase();
      statements.push(sql);
      let rows: unknown[] = [];
      if (sql.includes("from bakery.principals")) {
        rows = state.principal && state.principal.principalId === values[0]
          ? [state.principal]
          : [];
      } else if (sql.includes("from bakery.organization_memberships")) {
        const membership = state.memberships?.[String(values[1])];
        rows = membership &&
            (!membership.principalId || membership.principalId === values[0])
          ? [{ role: membership.role, status: membership.status }]
          : [];
      } else if (sql.includes("from public.member")) {
        const membership = state.memberships?.[String(values[1])];
        rows = membership?.status === "active" &&
            (!membership.principalId || membership.principalId === values[0])
          ? [{ role: membership.role }]
          : [];
      } else if (sql.includes("from bakery.permission_grants")) {
        const now = Date.now();
        rows = (state.grants ?? []).filter((grant) =>
          grant.organizationId === values[0] && !grant.revoked &&
          (!grant.expiresAt || grant.expiresAt > now)
        ).map(({ capability, role }) => ({ capability, role: role ?? null }));
      } else if (sql.includes("from bakery.installation_administrators")) {
        rows = state.installationAdministrator ? [{ exists: 1 }] : [];
      }
      return { rows, rowCount: rows.length };
    },
    release() {
      releases++;
    },
  };
  return {
    database: {
      connect: () => Promise.resolve(client),
    } as unknown as PgDatabase,
    statements,
    releases: () => releases,
  };
}

Deno.test("every projects REST route rejects hostile organization headers before touching repository or profile data", async () => {
  const principal: AuthenticatedSubject = {
    principalId: asPrincipalId("00000000-0000-4000-8000-000000000001"),
    principalType: PrincipalType.Human,
    displayName: "Bakery User",
  };
  const fixture = fakeDatabase({ principal, memberships: {} });
  const registry = createProjectsActionRegistry(
    createProjectsHandlers("phase4-header-matrix-secret"),
    {
      authorityRunner: new PostgresAuthorityRunner(fixture.database),
      commandRunner: createPostgresCommandRunner(),
    },
  );
  const app = createApiRouter({
    registry,
    createContext: () => ({ principal }),
  });

  const organizationA = "00000000-0000-4000-8000-00000000000a";
  const organizationB = "00000000-0000-4000-8000-00000000000b";
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const profileConfig = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };

  const routes: readonly {
    method: string;
    path: string;
    body?: unknown;
    command?: boolean;
  }[] = [
    { method: "GET", path: "/v1/applications" },
    { method: "GET", path: `/v1/applications/${applicationId}` },
    {
      method: "POST",
      path: "/v1/applications",
      body: { slug: "hostile-app", name: "Hostile App", description: "" },
      command: true,
    },
    {
      method: "PATCH",
      path: `/v1/applications/${applicationId}`,
      body: { name: "Hostile App" },
      command: true,
    },
    { method: "GET", path: "/v1/repositories" },
    { method: "GET", path: `/v1/repositories/${repositoryId}` },
    {
      method: "POST",
      path: "/v1/repositories",
      body: {
        applicationId,
        slug: "hostile-repo",
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: "owner/hostile-repo",
        owner: "hostile-owner",
        name: "hostile-repo",
        defaultBranch: "main",
      },
      command: true,
    },
    {
      method: "PATCH",
      path: `/v1/repositories/${repositoryId}`,
      body: {},
      command: true,
    },
    { method: "GET", path: `/v1/repositories/${repositoryId}/profiles` },
    {
      method: "POST",
      path: `/v1/repositories/${repositoryId}/profiles`,
      body: { revision: 1, config: profileConfig, digest: "0".repeat(64) },
      command: true,
    },
    {
      method: "GET",
      path: `/v1/applications/${applicationId}/roles`,
    },
    {
      method: "POST",
      path: `/v1/applications/${applicationId}/roles`,
      body: { applicationId, repositoryId, role: "source", alias: "primary" },
      command: true,
    },
    {
      method: "PATCH",
      path: `/v1/applications/${applicationId}/roles/${crypto.randomUUID()}`,
      body: { expectedVersion: 1, archivedAt: "2026-09-27T00:00:00.000Z" },
      command: true,
    },
    {
      method: "POST",
      path: `/v1/applications/${applicationId}/roles/resolve`,
      body: { repositoryId },
    },
  ];

  const cases: readonly {
    name: string;
    header?: string;
    expectedStatus: number;
    expectedCode: string;
    entersTransaction: boolean;
  }[] = [
    {
      name: "missing",
      expectedStatus: 403,
      expectedCode: "SCOPE_REQUIRED",
      entersTransaction: false,
    },
    {
      name: "malformed",
      header: "not-a-uuid",
      expectedStatus: 400,
      expectedCode: "MALFORMED_REQUEST",
      entersTransaction: false,
    },
    {
      name: "duplicate",
      header: `${organizationA}, ${organizationB}`,
      expectedStatus: 400,
      expectedCode: "MALFORMED_REQUEST",
      entersTransaction: false,
    },
    {
      name: "conflicting",
      header: organizationB,
      expectedStatus: 404,
      expectedCode: "RESOURCE_NOT_FOUND",
      entersTransaction: true,
    },
    {
      name: "unauthorized",
      header: organizationA,
      expectedStatus: 404,
      expectedCode: "RESOURCE_NOT_FOUND",
      entersTransaction: true,
    },
  ];

  for (const route of routes) {
    for (const hostile of cases) {
      const headers = new Headers({
        "x-request-id": `phase4-${hostile.name}`,
      });
      if (route.body !== undefined) {
        headers.set("content-type", "application/json");
      }
      if (hostile.header) {
        headers.set("Bakery-Organization-Id", hostile.header);
      }
      if (route.command) {
        headers.set("Idempotency-Key", `phase4-${hostile.name}-key`);
      }
      if (route.method === "PATCH") headers.set("If-Match", '"1"');
      const before = fixture.statements.length;
      const response = await app.fetch(
        new Request(`http://test${route.path}`, {
          method: route.method,
          headers,
          body: route.body === undefined
            ? undefined
            : JSON.stringify(route.body),
        }),
      );
      assertEquals(
        response.status,
        hostile.expectedStatus,
        `${route.method} ${route.path} ${hostile.name}`,
      );
      const body = await response.text();
      assert(body.includes(`"code":"${hostile.expectedCode}"`), body);
      for (
        const secret of [
          "postgres://",
          "public.member",
          "bakery.principals",
          "permission_grants",
          "rowCount",
        ]
      ) assertEquals(body.includes(secret), false, `${route.path}: ${secret}`);
      const statements = fixture.statements.slice(before);
      if (hostile.entersTransaction) {
        assert(
          statements.includes("rollback"),
          `${route.path} ${hostile.name}`,
        );
        assertEquals(
          statements.includes("commit"),
          false,
          `${route.path} ${hostile.name}`,
        );
      } else {
        assertEquals(statements, [], `${route.path}: ${hostile.name}`);
      }
    }
  }
});

Deno.test("Developer cannot publish fixed repository policy before repository state is read", async () => {
  const principal: AuthenticatedSubject = {
    principalId: asPrincipalId("00000000-0000-4000-8000-000000000001"),
    principalType: PrincipalType.Human,
    displayName: "Bakery Developer",
  };
  const organizationId = "00000000-0000-4000-8000-00000000000a";
  const fixture = fakeDatabase({
    principal,
    memberships: {
      [organizationId]: { role: "developer", status: "active" },
    },
  });
  const registry = createProjectsActionRegistry(
    createProjectsHandlers("issue72-developer-denial-secret"),
    {
      authorityRunner: new PostgresAuthorityRunner(fixture.database),
      commandRunner: createPostgresCommandRunner(),
    },
  );
  const app = createApiRouter({
    registry,
    createContext: () => ({ principal }),
  });
  const response = await app.fetch(
    new Request(
      `http://local/v1/repositories/${crypto.randomUUID()}/profiles`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "Bakery-Organization-Id": organizationId,
          "If-Match": '"1"',
        },
        body: JSON.stringify({
          revision: 1,
          digest: "0".repeat(64),
          config: {
            schemaVersion: 1,
            workflow: { kind: "fixed" },
            branches: { base: "main", allowedPatterns: ["feature/*"] },
            worktree: { root: ".bakery/worktrees" },
            fixedPolicy: {
              schemaVersion: 1,
              commands: [{ id: "test.required", argv: ["pnpm", "test"] }],
              allowedEffects: ["evidence_only"],
              lockedConfiguration: {
                branches: true,
                worktree: true,
                checker: true,
              },
              decisions: [{ commandId: "test.required", mode: "require" }],
            },
          },
        }),
      },
    ),
  );
  assertEquals(response.status, 403);
  assertEquals(
    fixture.statements.some((statement) =>
      statement.includes("bakery.repositories") ||
      statement.includes("bakery.repository_profiles")
    ),
    false,
  );
});

// -- Real database ------------------------------------------------------------

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

Deno.test(
  "absent and foreign repositories, empty foreign lists, and an unaffiliated installation administrator all return identical bounded problems",
  async (test) => {
    const owner = openDatabase(databaseUrl);
    const authDb = openPgDatabase(databaseUrl);
    const appPg = openPgDatabase(appDatabaseUrl);
    const organizationAId = crypto.randomUUID();
    const organizationBId = crypto.randomUUID();
    const adminAUserId = crypto.randomUUID();
    const adminBUserId = crypto.randomUUID();
    const installationAdminUserId = crypto.randomUUID();
    const adminAPrincipalId = crypto.randomUUID();
    const adminBPrincipalId = crypto.randomUUID();
    const installationAdminPrincipalId = crypto.randomUUID();
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

      const now = new Date("2026-09-18T00:00:00.000Z");
      const adminAEmail = `phase4-admin-a-${adminAUserId}@example.test`;
      const adminBEmail = `phase4-admin-b-${adminBUserId}@example.test`;
      const installationAdminEmail =
        `phase4-installation-admin-${installationAdminUserId}@example.test`;

      for (
        const [userId, email, displayName] of [
          [adminAUserId, adminAEmail, "Admin A"],
          [adminBUserId, adminBEmail, "Admin B"],
          [
            installationAdminUserId,
            installationAdminEmail,
            "Installation Admin",
          ],
        ] as const
      ) {
        await owner`
          insert into public."user" (
            id, name, email, "emailVerified", "createdAt", "updatedAt"
          ) values (${userId}, ${displayName}, ${email}, true, ${now}, ${now})`;
      }
      for (
        const [principalIdValue, userId, displayName] of [
          [adminAPrincipalId, adminAUserId, "Admin A"],
          [adminBPrincipalId, adminBUserId, "Admin B"],
          [
            installationAdminPrincipalId,
            installationAdminUserId,
            "Installation Admin",
          ],
        ] as const
      ) {
        await owner`
          insert into bakery.principals (
            id, provider_user_id, display_name, principal_type
          ) values (${principalIdValue}, ${userId}, ${displayName}, 'human')`;
      }
      await owner`
        insert into bakery.organizations (
          id, name, slug, metadata, created_at, updated_at, version
        ) values (
          ${organizationAId}, 'Phase 4 Org A', ${`phase4-org-a-${organizationAId}`},
          '{}'::jsonb, ${now}, ${now}, 1
        )`;
      await owner`
        insert into bakery.organizations (
          id, name, slug, metadata, created_at, updated_at, version
        ) values (
          ${organizationBId}, 'Phase 4 Org B', ${`phase4-org-b-${organizationBId}`},
          '{}'::jsonb, ${now}, ${now}, 1
        )`;
      for (
        const [organizationIdValue, principalIdValue, role] of [
          [organizationAId, adminAPrincipalId, "admin"],
          [organizationBId, adminBPrincipalId, "admin"],
        ] as const
      ) {
        await owner`
          insert into bakery.organization_memberships (
            id, organization_id, principal_id, role, status, joined_at,
            created_at, updated_at, version
          ) values (
            ${crypto.randomUUID()}, ${organizationIdValue}, ${principalIdValue},
            ${role}, 'active', ${now}, ${now}, ${now}, 1
          )`;
      }
      await owner`
        insert into bakery.installation_administrators (
          principal_id, granted_by_principal_id
        ) values (${installationAdminPrincipalId}, ${adminAPrincipalId})`;

      const adminA: Principal = {
        principalId: adminAPrincipalId,
        principalType: "human",
        displayName: "Admin A",
      };
      const adminB: Principal = {
        principalId: adminBPrincipalId,
        principalType: "human",
        displayName: "Admin B",
      };
      const installationAdmin: Principal = {
        principalId: installationAdminPrincipalId,
        principalType: "human",
        displayName: "Installation Admin",
      };
      let principal: Principal = adminA;

      const secret = "provide-first-authorized-security-secret";
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

      const FIXED_REQUEST_ID = "phase4-fixed-request-id";
      const FIXED_TRACEPARENT =
        "00-33333333333333333333333333333333-4444444444444444-01";

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
          "x-request-id": FIXED_REQUEST_ID,
          traceparent: FIXED_TRACEPARENT,
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

      const profileConfig: ProfileConfig = {
        schemaVersion: 1,
        workflow: { kind: "fixed" },
        branches: { base: "main", allowedPatterns: ["feature/*"] },
        worktree: { root: ".bakery/worktrees" },
      };
      let applicationId = "";
      let repositoryId = "";
      let profileDigestValue = "";

      await test.step("1. setup: one application, repository and profile in A", async () => {
        principal = adminA;
        const createApplication = await send("POST", "/v1/applications", {
          organizationId: organizationAId,
          idempotencyKey: "phase4-app-create",
          body: { slug: "phase4-app", name: "Phase 4 App", description: "" },
        });
        assertEquals(createApplication.status, 201);
        applicationId = (await createApplication.json() as { id: string }).id;

        const createRepository = await send("POST", "/v1/repositories", {
          organizationId: organizationAId,
          idempotencyKey: "phase4-repo-create",
          body: {
            applicationId,
            slug: "phase4-repo",
            integrationConnectionId: crypto.randomUUID(),
            providerRepoId: "owner/phase4-repo",
            owner: "phase4-owner",
            name: "phase4-repo",
            defaultBranch: "main",
          },
        });
        assertEquals(createRepository.status, 201);
        repositoryId = (await createRepository.json() as { id: string }).id;

        profileDigestValue = await sha256Hex(canonicalJson(profileConfig));
        const publishProfile = await send(
          "POST",
          `/v1/repositories/${repositoryId}/profiles`,
          {
            organizationId: organizationAId,
            idempotencyKey: "phase4-profile-create",
            body: {
              revision: 1,
              config: profileConfig,
              digest: profileDigestValue,
            },
          },
        );
        assertEquals(publishProfile.status, 201);
      });

      await test.step("2. byte-identical 404s for absent and foreign ids", async () => {
        principal = adminB;
        const snapshot = async (response: Response) => ({
          status: response.status,
          headers: [...response.headers.entries()],
          body: await response.text(),
        });
        const taskApplicationId = crypto.randomUUID();
        const taskMutationCountBefore = await owner`
          select
            (select count(*)::int from bakery.conversations) as conversations,
            (select count(*)::int from bakery.tasks) as tasks,
            (select count(*)::int from bakery.workflow_runs) as runs,
            (select count(*)::int from bakery.jobs) as jobs
        `;
        const comparisons: ReadonlyArray<
          readonly [
            () => Response | Promise<Response>,
            () => Response | Promise<Response>,
          ]
        > = [
          [
            () =>
              send("GET", `/v1/applications/${crypto.randomUUID()}`, {
                organizationId: organizationBId,
              }),
            () =>
              send("GET", `/v1/applications/${applicationId}`, {
                organizationId: organizationBId,
              }),
          ],
          [
            () =>
              send("GET", `/v1/repositories/${crypto.randomUUID()}`, {
                organizationId: organizationBId,
              }),
            () =>
              send("GET", `/v1/repositories/${repositoryId}`, {
                organizationId: organizationBId,
              }),
          ],
          [
            () =>
              send(
                "GET",
                `/v1/repositories/${crypto.randomUUID()}/profiles`,
                { organizationId: organizationBId },
              ),
            () =>
              send("GET", `/v1/repositories/${repositoryId}/profiles`, {
                organizationId: organizationBId,
              }),
          ],
          [
            () =>
              send("PATCH", `/v1/repositories/${crypto.randomUUID()}`, {
                organizationId: organizationBId,
                idempotencyKey: "phase4-patch-absent",
                ifMatch: '"1"',
                body: { name: "Unreachable" },
              }),
            () =>
              send("PATCH", `/v1/repositories/${repositoryId}`, {
                organizationId: organizationBId,
                idempotencyKey: "phase4-patch-foreign",
                ifMatch: '"1"',
                body: { name: "Unreachable" },
              }),
          ],
          [
            () =>
              send(
                "POST",
                `/v1/repositories/${crypto.randomUUID()}/profiles`,
                {
                  organizationId: organizationBId,
                  idempotencyKey: "phase4-profile-absent",
                  body: {
                    revision: 1,
                    config: profileConfig,
                    digest: "0".repeat(64),
                  },
                },
              ),
            () =>
              send("POST", `/v1/repositories/${repositoryId}/profiles`, {
                organizationId: organizationBId,
                idempotencyKey: "phase4-profile-foreign",
                body: {
                  revision: 1,
                  config: profileConfig,
                  digest: "0".repeat(64),
                },
              }),
          ],
          [
            () =>
              send("POST", "/v1/tasks", {
                organizationId: organizationBId,
                idempotencyKey: "phase4-task-absent",
                body: {
                  applicationId: taskApplicationId,
                  repositoryId: crypto.randomUUID(),
                  repositoryProfileId: crypto.randomUUID(),
                  taskType: "feature",
                  title: "Phase 4 task",
                },
              }),
            () =>
              send("POST", "/v1/tasks", {
                organizationId: organizationBId,
                idempotencyKey: "phase4-task-foreign",
                body: {
                  applicationId: taskApplicationId,
                  repositoryId,
                  repositoryProfileId: crypto.randomUUID(),
                  taskType: "feature",
                  title: "Phase 4 task",
                },
              }),
          ],
        ];
        for (const [absentRequest, foreignRequest] of comparisons) {
          const absent = await snapshot(await absentRequest());
          const foreign = await snapshot(await foreignRequest());
          assertEquals(absent, foreign);
          assertEquals(absent.status, 404);
          assert(
            absent.body.includes('"code":"RESOURCE_NOT_FOUND"'),
            absent.body,
          );
          for (
            const secret of [organizationAId, repositoryId, profileDigestValue]
          ) assertEquals(absent.body.includes(secret), false, secret);
        }
        const taskMutationCountAfter = await owner`
          select
            (select count(*)::int from bakery.conversations) as conversations,
            (select count(*)::int from bakery.tasks) as tasks,
            (select count(*)::int from bakery.workflow_runs) as runs,
            (select count(*)::int from bakery.jobs) as jobs
        `;
        assertEquals(taskMutationCountAfter[0], taskMutationCountBefore[0]);
      });

      await test.step("3. foreign lists are empty and a cross-tenant cursor is invalid", async () => {
        principal = adminB;
        const listApplicationsAsB = await send("GET", "/v1/applications", {
          organizationId: organizationBId,
        });
        assertEquals(listApplicationsAsB.status, 200);
        assertEquals(
          (await listApplicationsAsB.json() as { items: unknown[] }).items,
          [],
        );

        const listRepositoriesAsB = await send("GET", "/v1/repositories", {
          organizationId: organizationBId,
        });
        assertEquals(listRepositoriesAsB.status, 200);
        assertEquals(
          (await listRepositoriesAsB.json() as { items: unknown[] }).items,
          [],
        );

        const foreignCursor = await encodeCursor(
          secret,
          {
            action: "repositories.list",
            principalId: adminAPrincipalId,
            organizationId: organizationAId,
            ordering: "createdAt:desc,id:desc",
            filters: "{}",
            schemaVersion: 1,
          },
          { createdAt: new Date().toISOString(), id: crypto.randomUUID() },
        );
        const crossTenantCursor = await send(
          "GET",
          `/v1/repositories?cursor=${encodeURIComponent(foreignCursor)}`,
          { organizationId: organizationBId },
        );
        assertEquals(crossTenantCursor.status, 400);
        assertEquals(
          (await crossTenantCursor.json() as { code: string }).code,
          "INVALID_CURSOR",
        );
      });

      await test.step("4. an installation administrator without membership is not authorized", async () => {
        principal = installationAdmin;
        const getRepositoryAsInstallationAdmin = await send(
          "GET",
          `/v1/repositories/${repositoryId}`,
          { organizationId: organizationAId },
        );
        assertEquals(getRepositoryAsInstallationAdmin.status, 404);
        assertEquals(
          (await getRepositoryAsInstallationAdmin.json() as { code: string })
            .code,
          "RESOURCE_NOT_FOUND",
        );

        const createRepositoryAsInstallationAdmin = await send(
          "POST",
          "/v1/repositories",
          {
            organizationId: organizationAId,
            idempotencyKey: "phase4-installation-admin-repo-create",
            body: {
              applicationId,
              slug: "installation-admin-repo",
              integrationConnectionId: crypto.randomUUID(),
              providerRepoId: "owner/installation-admin-repo",
              owner: "installation-admin",
              name: "installation-admin-repo",
              defaultBranch: "main",
            },
          },
        );
        assertEquals(createRepositoryAsInstallationAdmin.status, 404);
        assertEquals(
          (await createRepositoryAsInstallationAdmin.json() as {
            code: string;
          }).code,
          "RESOURCE_NOT_FOUND",
        );
      });
    } finally {
      await owner`
        delete from bakery.installation_administrators
        where principal_id = ${installationAdminPrincipalId}`;
      await owner`
        delete from bakery.organizations
        where id in (${organizationAId}, ${organizationBId})`;
      await owner`
        delete from bakery.principals
        where id in (
          ${adminAPrincipalId}, ${adminBPrincipalId},
          ${installationAdminPrincipalId}
        )`;
      await owner`
        delete from public."user"
        where id in (
          ${adminAUserId}, ${adminBUserId}, ${installationAdminUserId}
        )`;
      await closePgDatabase(appPg);
      await closePgDatabase(authDb);
      await closeDatabase(owner);
    }
  },
);
