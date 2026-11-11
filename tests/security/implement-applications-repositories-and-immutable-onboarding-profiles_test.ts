import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import {
  readRuntimeConfig,
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
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../apps/server/src/platform/command-replay.ts";
import {
  createProjectsActionRegistry,
  createProjectsHandlers,
} from "../../apps/server/src/modules/projects/index.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  RepositoryInspectionReportSchema,
  RepositoryInspectionSourceChunkSchema,
} from "../../packages/contracts/src/repository-inspection.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
  receiveInspectionSource,
} from "../helpers/repository-inspection.ts";
import { validateWorkerReferences } from "../../packages/persistence/src/event-journal.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import type { AttemptRow } from "../../packages/persistence/src/types.ts";
import { seedEligibleJob } from "../helpers/worker-execution.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/createsuperuser.ts";
import { createReadyAuthProvider } from "../../apps/server/src/modules/auth/adapters/better-auth.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import { authRequest, sessionCookie } from "../helpers/auth.ts";

const { databaseUrl, appDatabaseUrl, adminDatabaseUrl } =
  readTestDatabaseConfig(Deno.env.toObject(), { requireAdmin: true });

const profileConfig = {
  schemaVersion: 1 as const,
  workflow: { kind: "fixed" as const },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};

async function digestFor(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

type SecurityDatabaseFixture = {
  owner: Database;
  authDb: PgDatabase;
  appPg: PgDatabase;
  appDatabaseUrl: string;
  cleanup: () => Promise<void>;
};

async function migrateTestDatabase(): Promise<SecurityDatabaseFixture> {
  const admin = openDatabase(adminDatabaseUrl, 1);
  const databaseName = `bakery_security_${
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
    // Bootstrap holds its transaction while Better Auth creates the user.
    authDb = openPgDatabase(isolatedOwnerUrl.toString(), 2);
    appPg = openPgDatabase(isolatedAppUrl.toString(), 1);
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
    return {
      owner: owner!,
      authDb: authDb!,
      appPg: appPg!,
      appDatabaseUrl: isolatedAppUrl.toString(),
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

Deno.test("Projects rejects foreign references without disclosure or mutation", async () => {
  const fixture = await migrateTestDatabase();
  const { owner, appPg } = fixture;
  try {
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
      "Security A",
    );
    await seedOrganization(
      owner,
      organizationBId,
      principalBId,
      userBId,
      "Security B",
    );

    const principalA = {
      principalId: principalAId,
      principalType: "human" as const,
      displayName: "Security A",
    };
    const principalB = {
      principalId: principalBId,
      principalType: "human" as const,
      displayName: "Security B",
    };
    let principal = principalA;
    let commandNumber = 0;
    const registry = createProjectsActionRegistry(
      createProjectsHandlers("issue-46-security-secret"),
      {
        authorityRunner: new PostgresAuthorityRunner(appPg),
        commandRunner: createPostgresCommandRunner(),
      },
    );
    const app = createApiRouter({
      registry,
      createContext: () => ({ principal }),
    });
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
        headers["Idempotency-Key"] = `security-phase1-${commandNumber++}`;
      }
      if (body !== undefined) headers["content-type"] = "application/json";
      if (ifMatch !== undefined) headers["If-Match"] = ifMatch;
      return await app.fetch(
        new Request(`http://projects-security.test${path}`, {
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
      { slug: "security", name: "Security A", description: "" },
    );
    assertEquals(applicationAResponse.status, 201);
    const applicationA = await applicationAResponse.json() as { id: string };

    principal = principalB;
    const applicationBResponse = await send(
      "POST",
      "/v1/applications",
      organizationBId,
      { slug: "security", name: "Security B", description: "" },
    );
    assertEquals(applicationBResponse.status, 201);
    const applicationB = await applicationBResponse.json() as { id: string };

    principal = principalA;
    const integrationConnectionAId = crypto.randomUUID();
    const repositoryAResponse = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationA.id,
        slug: "security-a",
        integrationConnectionId: integrationConnectionAId,
        providerRepoId: "security/repository-a",
        owner: "security-owner",
        name: "security-a",
        defaultBranch: "main",
      },
    );
    assertEquals(repositoryAResponse.status, 201);
    const repositoryABody = await repositoryAResponse.json() as { id: string };
    const sameDisplayNameRepository = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationA.id,
        slug: "security-a-second",
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: "security/repository-a-renamed",
        owner: "security-owner",
        name: "SECURITY-A",
        defaultBranch: "main",
      },
    );
    assertEquals(sameDisplayNameRepository.status, 201);
    const duplicateProviderRepository = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationA.id,
        slug: "security-a-duplicate",
        integrationConnectionId: integrationConnectionAId,
        providerRepoId: "security/repository-a",
        owner: "security-owner",
        name: "security-a-provider-duplicate",
        defaultBranch: "main",
      },
    );
    assertEquals(duplicateProviderRepository.status, 409);

    principal = principalB;
    const repositoryBResponse = await send(
      "POST",
      "/v1/repositories",
      organizationBId,
      {
        applicationId: applicationB.id,
        slug: "security-b",
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: "security/repository-b",
        owner: "security-owner",
        name: "security-b",
        defaultBranch: "main",
      },
    );
    assertEquals(repositoryBResponse.status, 201);
    const repositoryBBody = await repositoryBResponse.json() as { id: string };

    const profileBResponse = await send(
      "POST",
      `/v1/repositories/${repositoryBBody.id}/profiles`,
      organizationBId,
      {
        revision: 1,
        config: profileConfig,
        digest: await digestFor(profileConfig),
      },
    );
    assertEquals(profileBResponse.status, 201);
    const profileB = await profileBResponse.json() as { id: string };

    principal = principalA;
    assertEquals(
      (await send(
        "GET",
        `/v1/applications/${applicationB.id}`,
        organizationAId,
      )).status,
      404,
    );
    assertEquals(
      (await send(
        "GET",
        `/v1/repositories/${repositoryBBody.id}`,
        organizationAId,
      )).status,
      404,
    );
    assertEquals(
      (
        await send(
          "GET",
          `/v1/repositories/${repositoryBBody.id}/profiles`,
          organizationAId,
        )
      ).status,
      404,
    );

    const crossTenantAttachment = await send(
      "POST",
      "/v1/repositories",
      organizationAId,
      {
        applicationId: applicationB.id,
        slug: "foreign-application",
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: "security/foreign",
        owner: "security-owner",
        name: "foreign",
        defaultBranch: "main",
      },
    );
    assertEquals(crossTenantAttachment.status, 404);

    const repositoryAProfileResponse = await send(
      "POST",
      `/v1/repositories/${repositoryABody.id}/profiles`,
      organizationAId,
      {
        revision: 1,
        config: profileConfig,
        digest: await digestFor(profileConfig),
      },
    );
    assertEquals(repositoryAProfileResponse.status, 201);
    const profileA = await repositoryAProfileResponse.json() as { id: string };
    const beforeForeignActivation = await owner`
      select active_profile_id, version from bakery.repositories
       where organization_id = ${organizationAId} and id = ${repositoryABody.id}`;

    const foreignActivation = await send(
      "PATCH",
      `/v1/repositories/${repositoryABody.id}`,
      organizationAId,
      { activeProfileId: profileB.id },
      `"${beforeForeignActivation[0]?.version}"`,
    );
    assertEquals(foreignActivation.status, 422);
    const afterForeignActivation = await owner`
      select active_profile_id, version from bakery.repositories
       where organization_id = ${organizationAId} and id = ${repositoryABody.id}`;
    assertEquals(afterForeignActivation[0]?.active_profile_id, profileA.id);
    assertEquals(
      afterForeignActivation[0]?.version,
      beforeForeignActivation[0]?.version,
    );

    const roleAResponse = await send(
      "POST",
      `/v1/applications/${applicationA.id}/roles`,
      organizationAId,
      {
        applicationId: applicationA.id,
        repositoryId: repositoryABody.id,
        role: "source",
        alias: "primary",
      },
    );
    assertEquals(roleAResponse.status, 201);
    const roleA = await roleAResponse.json() as { id: string };
    principal = principalB;
    const roleBResponse = await send(
      "POST",
      `/v1/applications/${applicationB.id}/roles`,
      organizationBId,
      {
        applicationId: applicationB.id,
        repositoryId: repositoryBBody.id,
        role: "source",
        alias: "primary",
      },
    );
    assertEquals(roleBResponse.status, 201);
    const roleB = await roleBResponse.json() as { id: string };
    principal = principalA;
    const beforeBoundary = await owner`
      select id, repository_id, role, alias, archived_at, version
        from bakery.repository_role_bindings
       where id in (${roleA.id}, ${roleB.id}) order by id`;
    const foreignRepositoryRole = await send(
      "POST",
      `/v1/applications/${applicationA.id}/roles`,
      organizationAId,
      {
        applicationId: applicationA.id,
        repositoryId: repositoryBBody.id,
        role: "source",
        alias: "foreign",
      },
    );
    assertEquals(foreignRepositoryRole.status, 404);
    const foreignApplicationRole = await send(
      "POST",
      `/v1/applications/${applicationB.id}/roles`,
      organizationAId,
      {
        applicationId: applicationB.id,
        repositoryId: repositoryABody.id,
        role: "foreign",
      },
    );
    assertEquals(foreignApplicationRole.status, 404);
    const foreignRoleUpdate = await send(
      "PATCH",
      `/v1/applications/${applicationA.id}/roles/${roleB.id}`,
      organizationAId,
      {
        expectedVersion: 1,
        role: "foreign",
        archivedAt: "2026-09-27T00:00:00.000Z",
      },
      '"1"',
    );
    assertEquals(foreignRoleUpdate.status, 404);
    for (const repositoryId of [repositoryBBody.id, crypto.randomUUID()]) {
      const resolution = await send(
        "POST",
        `/v1/applications/${applicationA.id}/roles/resolve`,
        organizationAId,
        { repositoryId },
      );
      assertEquals(resolution.status, 404);
      const problem = await resolution.text();
      assertEquals(problem.includes(repositoryBBody.id), false);
      assertEquals(problem.includes("repository_scope_mismatch"), false);
    }
    const authorizedResolution = await send(
      "POST",
      `/v1/applications/${applicationA.id}/roles/resolve`,
      organizationAId,
      { role: "source", alias: "primary" },
    );
    const authorizedBody = await authorizedResolution.json();
    assertEquals(authorizedBody.binding.repositoryId, repositoryABody.id);
    assertEquals(authorizedBody.binding.observationId, null);
    assertEquals(authorizedBody.binding.repositoryProfileId, profileA.id);
    const beforeApplicationBoundary = await owner`
      select name, slug, description, archived_at, version from bakery.applications
       where id = ${applicationB.id}`;
    const foreignApplicationUpdate = await send(
      "PATCH",
      `/v1/applications/${applicationB.id}`,
      organizationAId,
      { name: "Foreign", archivedAt: "2026-09-27T00:00:00.000Z" },
      '"1"',
    );
    assertEquals(foreignApplicationUpdate.status, 404);
    assertEquals(
      await owner`
      select name, slug, description, archived_at, version from bakery.applications
       where id = ${applicationB.id}`,
      beforeApplicationBoundary,
    );
    assertEquals(
      await owner`
      select id, repository_id, role, alias, archived_at, version
        from bakery.repository_role_bindings
       where id in (${roleA.id}, ${roleB.id}) order by id`,
      beforeBoundary,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("Projects inspection rejects incomplete forged stale and foreign evidence with durable redacted denial", async () => {
  const fixture = await migrateTestDatabase();
  try {
    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await seedOrganization(
      fixture.owner,
      organizationId,
      principalId,
      crypto.randomUUID(),
      "Inspection Security",
    );
    const harness = await openRepositoryInspectionHarness(fixture, {
      organizationId,
      principalId,
    });
    try {
      const repository = await harness.createRepository();
      const onboarding = await harness.onboard(repository.repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      await harness.start(assignment);
      const firstSource = await harness.source(assignment, 0, 1);
      assertEquals(firstSource.status, 200);
      const firstChunk = RepositoryInspectionSourceChunkSchema.parse(
        await firstSource.json(),
      );
      assertEquals(firstChunk.done, false);
      const report = await harness.report(assignment.input, firstChunk.receipt);
      let denialCount = 0;
      const denialIds = new Set<string>();
      const denied = async (
        candidate: unknown,
        code: string,
        fence?: string,
      ) => {
        const before = await harness.snapshot(
          repository.repositoryId,
          assignment.jobId,
        );
        const response = await harness.result(assignment, candidate, { fence });
        assertEquals((await response.json()).code, code);
        assertEquals(
          await harness.snapshot(repository.repositoryId, assignment.jobId),
          before,
        );
        const audits = await fixture.authDb.query<
          {
            id: string;
            details: { code: string };
            principal_id: string;
            resource_id: string;
          }
        >(
          `select id, details, principal_id, resource_id from bakery.audit_events
            where organization_id = $1 and operation = 'repositoryObservations.publish'
              and outcome = 'denied' and resource_id = $2`,
          [organizationId, assignment.attemptId],
        );
        assertEquals(audits.rows.length, ++denialCount);
        assertEquals(
          audits.rows.filter((audit) => !denialIds.has(audit.id))
            .map((audit) => audit.details),
          [{ code }],
        );
        const host = await fixture.authDb.query<{ principal_id: string }>(
          "select principal_id from bakery.worker_hosts where organization_id = $1 and id = $2",
          [organizationId, harness.registration.workerHostId],
        );
        for (const audit of audits.rows) {
          assertEquals(Object.keys(audit.details), ["code"]);
          assertEquals(audit.principal_id, host.rows[0].principal_id);
          assertEquals(audit.resource_id, assignment.attemptId);
          denialIds.add(audit.id);
        }
      };
      await denied(report, "VALIDATION_FAILED"); // Receipt without a complete transfer cannot publish.
      const sourceState = await harness.snapshot(
        repository.repositoryId,
        assignment.jobId,
      );
      const invalidHeaders: Record<string, string>[] = [
        { "X-Worker-Fence": (BigInt(assignment.fence) + 1n).toString() },
        { "X-Worker-Lease-Token": "forged-redaction-sentinel" },
        { "X-Worker-Session-Id": crypto.randomUUID() },
      ];
      for (const headers of invalidHeaders) {
        const response = await harness.source(assignment, 1, 32768, headers);
        assertEquals(response.status, 409);
        assertEquals(
          await harness.snapshot(repository.repositoryId, assignment.jobId),
          sourceState,
        );
      }
      const remaining = await harness.source(assignment, 1);
      assertEquals(remaining.status, 200);
      const finalChunk = RepositoryInspectionSourceChunkSchema.parse(
        await remaining.json(),
      );
      assertEquals(finalChunk.done, true);
      assertEquals(finalChunk.receipt, firstChunk.receipt);
      const withGitCheck = (
        changes: Partial<(typeof report.checks)[number]>,
      ) => ({
        ...report,
        checks: report.checks.map((check) =>
          check.id === "tool.git" ? { ...check, ...changes } : check
        ),
      });
      // Schema-valid contradictions must reach publication verification, not JSON rejection.
      const contradictions = [
        withGitCheck({ status: "missing" }),
        withGitCheck({ reason: "tool_missing" }),
        withGitCheck({ exitCode: 1 }),
        {
          ...report,
          completedAt: new Date(Date.parse(report.startedAt) - 1).toISOString(),
        },
        {
          ...report,
          // Equal cardinality, but a duplicate hides a policy check.
          checks: report.checks.map((check, index) =>
            index === report.checks.length - 1 ? report.checks[0] : check
          ),
        },
        {
          ...report,
          host: {
            ...report.host,
            // Equal cardinality, but a duplicate hides a policy tool.
            tools: report.host.tools.map((tool, index) =>
              index === report.host.tools.length - 1
                ? report.host.tools[0]
                : tool
            ),
          },
        },
      ];
      for (const contradiction of contradictions) {
        const candidate = RepositoryInspectionReportSchema.parse(contradiction);
        await denied(candidate, "VALIDATION_FAILED");
      }
      await denied({
        ...report,
        input: {
          ...report.input,
          profile: { ...report.input.profile, digest: "f".repeat(64) },
        },
      }, "VALIDATION_FAILED");
      await denied({
        ...report,
        receipt: { ...report.receipt, repositoryId: crypto.randomUUID() },
      }, "VALIDATION_FAILED");
      await denied(
        { ...report, checks: report.checks.slice(1) },
        "VALIDATION_FAILED",
      );
      await denied(
        report,
        "LEASE_FENCED",
        (BigInt(assignment.fence) + 1n).toString(),
      );
      await fixture.authDb.query(
        "update bakery.repositories set version = version + 1 where organization_id = $1 and id = $2",
        [organizationId, repository.repositoryId],
      );
      await denied(report, "STATE_CONFLICT");
      await fixture.authDb.query(
        "update bakery.job_attempts set created_at = clock_timestamp() - interval '61 seconds' where organization_id = $1 and id = $2",
        [organizationId, assignment.attemptId],
      );
      const expiredState = await harness.snapshot(
        repository.repositoryId,
        assignment.jobId,
      );
      const expiredSource = await harness.source(assignment);
      assertEquals(expiredSource.status, 409);
      assertEquals((await expiredSource.json()).code, "LEASE_EXPIRED");
      assertEquals(
        await harness.snapshot(repository.repositoryId, assignment.jobId),
        expiredState,
      );
      await denied(report, "LEASE_EXPIRED");
      const unchanged = await harness.snapshot(
        repository.repositoryId,
        assignment.jobId,
      );
      assertEquals(unchanged.profiles, [{
        id: repository.baselineProfileId,
        revision: 1,
        config: repository.config,
        digest: await digestFor(repository.config),
      }]);
      assertEquals(unchanged.observations, []);
      assertEquals(unchanged.active_profile_id, repository.baselineProfileId);
      assertEquals(unchanged.published_profile_id, null);
      assertEquals(unchanged.observation_id, null);
      assertEquals(unchanged.job_status, "running");
      const foreignOrganizationId = crypto.randomUUID();
      const foreignPrincipalId = crypto.randomUUID();
      await seedOrganization(
        fixture.owner,
        foreignOrganizationId,
        foreignPrincipalId,
        crypto.randomUUID(),
        "Inspection Foreign",
      );
      const foreign = await openRepositoryInspectionHarness(fixture, {
        organizationId: foreignOrganizationId,
        principalId: foreignPrincipalId,
      });
      try {
        const foreignSource = await foreign.source(assignment);
        assertEquals(foreignSource.status, 404);
        const foreignResult = await foreign.result(assignment, report);
        assertEquals(foreignResult.status, 404);
        assertEquals((await foreignResult.json()).code, "RESOURCE_NOT_FOUND");
        assertEquals(
          await harness.snapshot(repository.repositoryId, assignment.jobId),
          unchanged,
        );
        const foreignAudits = await fixture.authDb.query(
          `select details from bakery.audit_events
            where organization_id = $1 and operation = 'repositoryObservations.publish'
              and outcome = 'denied' and resource_id = $2`,
          [foreignOrganizationId, assignment.attemptId],
        );
        assertEquals(foreignAudits.rows, [{
          details: { code: "RESOURCE_NOT_FOUND" },
        }]);
        assertEquals(
          (await foreign.memberRequest(
            "GET",
            `/v1/repository-onboardings/${onboarding.id}`,
          )).status,
          404,
        );
      } finally {
        await foreign.close();
      }
    } finally {
      await harness.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("Projects standalone inspection admits normal lifecycle but denies workflow-owned references", async () => {
  const fixture = await migrateTestDatabase();
  try {
    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await seedOrganization(
      fixture.owner,
      organizationId,
      principalId,
      crypto.randomUUID(),
      "Inspection References",
    );
    const harness = await openRepositoryInspectionHarness(fixture, {
      organizationId,
      principalId,
    });
    try {
      const repository = await harness.createRepository();
      await harness.onboard(repository.repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      await harness.start(assignment);
      const workflow = await seedEligibleJob(
        fixture.authDb,
        organizationId,
        principalId,
        {
          input: {},
          capabilities: ["workflow-only"],
        },
      );
      const before = await harness.snapshot(
        repository.repositoryId,
        assignment.jobId,
      );
      const attempts = await fixture.authDb.query<AttemptRow>(
        `select a.id, a.organization_id as "organizationId", a.job_id as "jobId",
                a.worker_host_id as "workerHostId", a.worker_session_id as "workerSessionId",
                a.worker_session_generation::text as "workerSessionGeneration", a.fence::text,
                a.lease_token_hash as "leaseTokenHash", a.lease_expires_at as "leaseExpiresAt",
                false as "leaseExpired", a.status, a.last_event_seq::text as "lastEventSeq",
                j.current_fence::text as "jobCurrentFence"
           from bakery.job_attempts a join bakery.jobs j
             on j.organization_id = a.organization_id and j.id = a.job_id
          where a.organization_id = $1 and a.id = $2`,
        [organizationId, assignment.attemptId],
      );
      const attempt = attempts.rows[0];
      // Exercise the persistence consumer for result-only nested references,
      // which nonterminal event schemas intentionally cannot carry.
      await withPgTransaction(fixture.appPg, async (transaction) => {
        await validateWorkerReferences(transaction, attempt, "job.started", {
          startedAt: new Date().toISOString(),
          workspaceId: crypto.randomUUID(),
        });
        await validateWorkerReferences(transaction, attempt, "job.succeeded", {
          result: { input: assignment.input },
        });
      });
      for (
        const reference of [
          {
            runId: workflow.runId,
            runStepId: workflow.runStepId,
            taskId: workflow.taskId,
          },
          {
            artifactId: crypto.randomUUID(),
            artifactVersionId: crypto.randomUUID(),
          },
          {
            checkRunId: crypto.randomUUID(),
            checkRunIds: [crypto.randomUUID()],
          },
          { sessionId: workflow.sessionId },
          { externalEffectId: crypto.randomUUID() },
        ]
      ) {
        const error = await assertRejects(
          () =>
            withPgTransaction(fixture.appPg, async (transaction) => {
              await validateWorkerReferences(
                transaction,
                attempt,
                "job.succeeded",
                { result: { nested: reference } },
              );
            }),
          StandardError,
        );
        assertEquals((error as StandardError).code, "RESOURCE_NOT_FOUND");
        assertEquals(
          await harness.snapshot(repository.repositoryId, assignment.jobId),
          before,
        );
      }
      for (
        const event of [
          {
            eventType: "job.artifact",
            payload: {
              artifact: {
                artifactId: crypto.randomUUID(),
                versionId: crypto.randomUUID(),
                sha256: "a".repeat(64),
              },
            },
          },
          {
            eventType: "job.checkpoint",
            payload: {
              artifact: {
                artifactId: crypto.randomUUID(),
                versionId: crypto.randomUUID(),
                sha256: "a".repeat(64),
              },
              resumeHandleRef: null,
            },
          },
          {
            eventType: "job.effect_pending",
            payload: { externalEffectId: crypto.randomUUID() },
          },
        ]
      ) {
        const eventId = crypto.randomUUID();
        const response = await harness.workerRequest(
          `/v1/worker/attempts/${assignment.attemptId}/events`,
          {
            leaseToken: assignment.leaseToken,
            fence: assignment.fence,
            events: [{ eventId, localSeq: "2", ...event }],
          },
          eventId,
        );
        assertEquals(response.status, 404);
        assertEquals((await response.json()).code, "RESOURCE_NOT_FOUND");
        assertEquals(
          await harness.snapshot(repository.repositoryId, assignment.jobId),
          before,
        );
      }
    } finally {
      await harness.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("Projects worker claim excludes null-step noninspection and missing-onboarding jobs", async () => {
  const fixture = await migrateTestDatabase();
  try {
    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    await seedOrganization(
      fixture.owner,
      organizationId,
      principalId,
      crypto.randomUUID(),
      "Inspection Claim",
    );
    const harness = await openRepositoryInspectionHarness(fixture, {
      organizationId,
      principalId,
    });
    try {
      const repository = await harness.createRepository();
      const invalidIds = [crypto.randomUUID(), crypto.randomUUID()];
      for (
        const [index, action] of ["harness.implement", "repository.inspect"]
          .entries()
      ) {
        await fixture.authDb.query(
          `insert into bakery.jobs (
             id, organization_id, application_id, repository_id, repository_profile_id,
             repository_profile_revision, repository_profile_digest, run_step_id,
             action, input, requirements, status, priority, max_attempts
           ) values ($1, $2, $3, $4, $5, 1, $6, null, $7, '{}'::jsonb,
                     '{"capabilities":["git"]}'::jsonb, 'queued', 100, 1)`,
          [
            invalidIds[index],
            organizationId,
            repository.applicationId,
            repository.repositoryId,
            repository.baselineProfileId,
            await digestFor(repository.config),
            action,
          ],
        );
      }
      const supportedActions = ["repository.inspect", "harness.implement"];
      const empty = await harness.claim(supportedActions);
      assertEquals(empty.status, 204);
      const onboarding = await harness.onboard(repository.repositoryId);
      const assignment = await readInspectionAssignment(
        await harness.claim(supportedActions),
      );
      assertEquals(assignment.jobId, onboarding.jobId);
      const invalidJobs = await fixture.authDb.query(
        `select id, status, current_fence::text,
                (select count(*)::int from bakery.job_attempts a
                  where a.organization_id = j.organization_id and a.job_id = j.id) as attempts
           from bakery.jobs j where organization_id = $1 and id = any($2::uuid[])`,
        [organizationId, invalidIds],
      );
      for (const id of invalidIds) {
        assertEquals(invalidJobs.rows.find((job) => job.id === id), {
          id,
          status: "queued",
          current_fence: "0",
          attempts: 0,
        });
      }
    } finally {
      await harness.close();
    }
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("Projects inspection reads require real sessions and return exact tenant-bound evidence", async () => {
  const fixture = await migrateTestDatabase();
  let harness:
    | Awaited<ReturnType<typeof openRepositoryInspectionHarness>>
    | undefined;
  try {
    const email = `inspection-reader-${crypto.randomUUID()}@example.test`;
    const password = "inspection-reader-test-password-123";
    const signInRequest = authRequest("/api/auth/sign-in/email", {
      email,
      password,
      rememberMe: false,
    });
    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: fixture.appDatabaseUrl,
      BAKERY_PUBLIC_BASE_URL: new URL(signInRequest.url).origin,
      BETTER_AUTH_SECRET: "inspection-real-session-regression-secret-123",
    });
    await createSuperuser(
      { pgDatabase: fixture.authDb, config: config.auth! },
      { email, displayName: "Inspection Reader", password },
    );
    const persistence = createPostgresAuthPersistence(fixture.appPg);
    const auth = await createReadyAuthProvider({
      pgDatabase: fixture.appPg,
      config: config.auth!,
      persistence,
    });
    const app = createApp({
      config,
      database: fixture.owner,
      pgDatabase: fixture.appPg,
      auth,
      authPersistence: persistence,
    });
    const signIn = await app.fetch(signInRequest, {
      remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 12345 },
    });
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);
    const scope = await fixture.authDb.query<{
      principal_id: string;
      organization_id: string;
    }>(
      `select p.id as principal_id, m.organization_id
       from bakery.principals p
       join bakery.organization_memberships m on m.principal_id = p.id
       join public."user" u on u.id = p.provider_user_id
       where u.email = $1 order by m.organization_id limit 1`,
      [email],
    );
    const principalId = scope.rows[0].principal_id;
    const organizationId = scope.rows[0].organization_id;
    harness = await openRepositoryInspectionHarness(fixture, {
      organizationId,
      principalId,
    });
    const repository = await harness.createRepository();
    const onboarding = await harness.onboard(repository.repositoryId);
    const assignment = await readInspectionAssignment(await harness.claim());
    await harness.start(assignment);
    const receipt = await receiveInspectionSource(harness, assignment);
    const report = await harness.report(assignment.input, receipt);
    assertEquals((await harness.result(assignment, report)).status, 200);
    const snapshot = await harness.snapshot(
      repository.repositoryId,
      assignment.jobId,
    );
    const paths = [
      `/v1/repository-onboardings/${onboarding.id}`,
      `/v1/repository-profile-observations/${snapshot.observation_id}`,
    ];
    const read = (path: string, authenticated: boolean) =>
      app.fetch(
        new Request(new URL(path, config.publicBaseUrl), {
          headers: {
            "Bakery-Organization-Id": organizationId,
            ...(authenticated ? { Cookie: cookie } : {}),
          },
        }),
      );
    for (const path of paths) {
      assertEquals((await read(path, false)).status, 401);
    }
    const completedResponse = await read(paths[0], true);
    assertEquals(completedResponse.status, 200);
    const completed = contractSchemas.RepositoryOnboarding.parse(
      await completedResponse.json(),
    );
    assertEquals(completed.status, "completed");
    assertEquals(completed.repositoryId, repository.repositoryId);
    assertEquals(completed.profileId, assignment.input.profile.id);
    assertEquals(completed.observationId, snapshot.observation_id);
    const observationResponse = await read(paths[1], true);
    assertEquals(observationResponse.status, 200);
    const observation = contractSchemas.RepositoryProfileObservation.parse(
      await observationResponse.json(),
    );
    assertEquals(observation.profileId, completed.profileId);
    assertEquals(observation.payload.organizationId, organizationId);
    assertEquals(observation.baseSha, repository.snapshotSha);
    assertEquals(observation.payload.receipt, receipt);
    assertEquals(observation.payload.checks, report.checks);
  } finally {
    await harness?.close();
    await fixture.cleanup();
  }
});
