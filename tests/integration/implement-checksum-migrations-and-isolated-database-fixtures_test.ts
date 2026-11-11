import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  bakeryPlatformMigrationSource,
  checksumSql,
  loadMigrations,
  migrate,
  migrateProvider,
  MigrationOwner,
  resetTestDatabase,
} from "../../apps/server/src/platform/migrate.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
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
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { readUsageSummary } from "../../apps/server/src/modules/work/usage.ts";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";

const { databaseUrl: url, appDatabaseUrl: appUrl } = readTestDatabaseConfig();
const { adminDatabaseUrl: adminUrl } = readTestDatabaseConfig(
  Deno.env.toObject(),
  { requireAdmin: true },
);

async function waitForAdvisoryMigrationLock(
  database: ReturnType<typeof openPgDatabase>,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const result = await database.query<{ locked: boolean }>(`
      select exists (
        select 1
        from pg_locks
        where locktype = 'advisory'
          and granted
          and database = (
            select oid from pg_database where datname = current_database()
          )
          and pid <> pg_backend_pid()
      ) as locked
    `);
    if (result.rows[0]?.locked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("MIGRATION_LOCK_NOT_OBSERVED");
}

Deno.test("checksum migrations and tenant context use real Postgres", async () => {
  const db = openDatabase(url);
  const authDb = openPgDatabase(url);
  const appPg = openPgDatabase(appUrl);
  try {
    const providerMigrations = await loadMigrations(betterAuthMigrationSource);
    const bakeryMigrations = [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ];
    assertEquals(
      (await loadMigrations(authBakeryMigrationSource)).map(({ version }) =>
        version
      ),
      [
        "0002_auth_principals",
        "0003_live_tenant_authority",
        "0005_canonical_lifecycle",
        "0007_canonical_lifecycle_mutations",
        "0022_locale_preferences",
        "0070_user_preferences",
        "0071_organization_default_locale_optional",
        "0072_oauth_grant_revocations",
        "0073_oauth_grant_activity",
        "0077_installation_settings",
        "0078_permission_roles",
        "0079_audit_events_installation_scope",
        "0080_set_installation_license_function",
        "0081_access_tokens",
        "0085_access_bindings",
        "0090_audit_retention",
        "0095_scim_connections",
        "0100_organization_roles",
        "0105_organization_sso_settings",
        "0146_drop_installation_license",
      ],
    );
    await migrateProvider(authDb, providerMigrations);
    await migrate(db, bakeryMigrations);
    await Promise.all([
      migrateProvider(authDb, providerMigrations),
      migrateProvider(authDb, providerMigrations),
      migrate(db, bakeryMigrations),
      migrate(db, bakeryMigrations),
    ]);
    await migrateData(db, bakeryDataMigrations);
    const rows =
      await db`select version, checksum from bakery.schema_migrations`;
    assertEquals(
      rows.filter((row) => row.version === "0001_platform_bootstrap").length,
      1,
    );
    assertEquals(rows.length, bakeryMigrations.length);
    assertEquals(
      Number(
        (await db`
        select count(*)::int as count from bakery.data_migrations
      `)[0].count,
      ),
      bakeryDataMigrations.length,
    );
    await assertRejects(
      () =>
        migrateData(db, [
          {
            ...bakeryDataMigrations[0],
            source: new URL(
              "../../apps/server/src/platform/outbox-state.ts",
              import.meta.url,
            ),
          },
          ...bakeryDataMigrations.slice(1),
        ]),
      Error,
      "DATA_MIGRATION_CHECKSUM_MISMATCH:0015_outbox_dispatch_backfill",
    );
    assertEquals(
      (await db`
        select count(*)::int as count
        from information_schema.columns
        where table_schema = 'bakery'
          and table_name = 'permission_grants'
          and column_name = 'role'
      `)[0].count,
      0,
    );
    const canonicalTables = await db`
      select table_name
      from information_schema.tables
      where table_schema = 'bakery'
        and table_name in (
          'organizations',
          'organization_memberships',
          'organization_invitations'
        )
      order by table_name
    `;
    assertEquals(
      [...canonicalTables].map((row) => row.table_name),
      [
        "organization_invitations",
        "organization_memberships",
        "organizations",
      ],
    );
    const canonicalConstraints = await db`
      select constraint_name
      from information_schema.table_constraints
      where table_schema = 'bakery'
        and table_name in (
          'organizations',
          'organization_memberships',
          'organization_invitations'
        )
        and constraint_type in ('FOREIGN KEY', 'UNIQUE')
      order by constraint_name
    `;
    assertEquals(
      [...canonicalConstraints].map((row) => row.constraint_name),
      [
        "organization_invitations_inviter_membership_fk",
        "organization_invitations_inviter_principal_fk",
        "organization_invitations_organization_fk",
        "organization_invitations_organization_id_unique",
        "organization_memberships_custom_role_fk",
        "organization_memberships_organization_fk",
        "organization_memberships_organization_id_principal_unique",
        "organization_memberships_organization_id_unique",
        "organization_memberships_organization_principal_unique",
        "organization_memberships_principal_fk",
        "organizations_slug_unique",
      ],
    );
    const canonicalRls = await db`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        r.rolname as owner
      from pg_class as c
      join pg_namespace as n on n.oid = c.relnamespace
      join pg_roles as r on r.oid = c.relowner
      where n.nspname = 'bakery'
        and c.relname in (
          'organizations',
          'organization_memberships',
          'organization_invitations'
        )
      order by c.relname
    `;
    assertEquals(
      [...canonicalRls].map((row) => ({
        relname: row.relname,
        relrowsecurity: row.relrowsecurity,
        relforcerowsecurity: row.relforcerowsecurity,
        owner: row.owner,
      })),
      [
        {
          relname: "organization_invitations",
          relrowsecurity: false,
          relforcerowsecurity: false,
          owner: "bakery",
        },
        {
          relname: "organization_memberships",
          relrowsecurity: false,
          relforcerowsecurity: false,
          owner: "bakery",
        },
        {
          relname: "organizations",
          relrowsecurity: false,
          relforcerowsecurity: false,
          owner: "bakery",
        },
      ],
    );
    assertEquals(
      (await db`
        select count(*)::int as count
        from pg_policies
        where schemaname = 'bakery'
      `)[0].count,
      0,
    );
    const providerRows = await authDb.query(
      "select version from public.better_auth_schema_migrations",
    );
    assertEquals(providerRows.rows, [
      { version: "0001_better_auth" },
      { version: "0002_application_grants" },
      { version: "0003_bakery_authority_columns" },
      { version: "0004_two_factor_assurance" },
      { version: "0005_passkey" },
      { version: "0006_profile_fields" },
      { version: "0007_session_passkey" },
      { version: "0008_session_reauthenticated_at" },
      { version: "0009_oauth_provider" },
      { version: "0010_permission_roles" },
      { version: "0011_scim" },
      { version: "0012_sso_provider" },
      { version: "0013_rate_limit_timestamp_double_precision" },
    ]);
    const providerTables = await authDb.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[]) order by table_name",
      [[
        "user",
        "account",
        "session",
        "verification",
        "organization",
        "member",
        "invitation",
        "passkey",
      ]],
    );
    assertEquals(providerTables.rowCount, 8);
    const providerColumns = await authDb.query<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name, column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = any($1::text[])
         and column_name = any($2::text[])
       order by table_name, column_name`,
      [["organization", "member"], [
        "updatedAt",
        "version",
        "status",
        "joinedAt",
      ]],
    );
    assertEquals(providerColumns.rows, [
      { table_name: "member", column_name: "joinedAt" },
      { table_name: "member", column_name: "status" },
      { table_name: "member", column_name: "updatedAt" },
      { table_name: "member", column_name: "version" },
      { table_name: "organization", column_name: "updatedAt" },
      { table_name: "organization", column_name: "version" },
    ]);
    const altered = bakeryMigrations.map((migration) => ({ ...migration }));
    altered[0].sql += "\n-- changed";
    altered[0].checksum = await checksumSql(altered[0].sql);
    await assertRejects(
      () => migrate(db, altered),
      Error,
      "MIGRATION_CHECKSUM_MISMATCH:0001_platform_bootstrap",
    );
    await assertRejects(
      async () =>
        migrate(db, [{
          owner: MigrationOwner.BetterAuth,
          version: "0001_auth",
          sql: "select 1",
          checksum: await checksumSql("select 1"),
        }]),
      Error,
      `MIGRATION_OWNER_MISMATCH:${MigrationOwner.Bakery}:${MigrationOwner.BetterAuth}:0001_auth`,
    );
    await db`create table bakery.test_tx_probe (
      id uuid primary key,
      tenant_id uuid not null,
      value text not null
    )`;
    await db`grant select, insert on bakery.test_tx_probe to bakery_app`;
    try {
      const tenantOne = crypto.randomUUID();
      const tenantTwo = crypto.randomUUID();
      const committed = await withPgTransaction(appPg, async (client) => {
        await client.query(
          "insert into bakery.test_tx_probe (id, tenant_id, value) values ($1, $2, $3)",
          [crypto.randomUUID(), tenantOne, "committed"],
        );
        const state = await client.query<{ backendPid: number }>(
          'select pg_backend_pid() as "backendPid"',
        );
        return {
          backendPid: state.rows[0].backendPid,
          count: (await client.query<{ count: number }>(
            "select count(*)::int as count from bakery.test_tx_probe where tenant_id = $1",
            [tenantOne],
          )).rows[0].count,
        };
      });
      assertEquals(committed.count, 1);
      await assertRejects(
        () =>
          withPgTransaction(appPg, async (client) => {
            await client.query(
              "insert into bakery.test_tx_probe (id, tenant_id, value) values ($1, $2, $3)",
              [crypto.randomUUID(), tenantOne, "rolled-back"],
            );
            throw new Error("PG_TX_ROLLBACK");
          }),
        Error,
        "PG_TX_ROLLBACK",
      );
      const second = await withPgTransaction(appPg, async (client) => {
        await client.query(
          "insert into bakery.test_tx_probe (id, tenant_id, value) values ($1, $2, $3)",
          [crypto.randomUUID(), tenantTwo, "second"],
        );
        const state = await client.query<{ backendPid: number }>(
          'select pg_backend_pid() as "backendPid"',
        );
        return {
          backendPid: state.rows[0].backendPid,
          total: (await client.query<{ count: number }>(
            "select count(*)::int as count from bakery.test_tx_probe",
          )).rows[0].count,
        };
      });
      assertEquals(second.total, 2);
      assertEquals(second.backendPid, committed.backendPid);
      const controller = new AbortController();
      await assertRejects(
        () =>
          withPgTransaction(
            appPg,
            async (client) => {
              await client.query(
                "insert into bakery.test_tx_probe (id, tenant_id, value) values ($1, $2, $3)",
                [crypto.randomUUID(), tenantTwo, "aborted"],
              );
              controller.abort();
            },
            controller.signal,
          ),
        DOMException,
        "Action aborted",
      );
      assertEquals(
        (await appPg.query<{ count: number }>(
          "select count(*)::int as count from bakery.test_tx_probe",
        )).rows[0].count,
        2,
      );
      assertEquals(
        (await appPg.query<{ count: number }>(
          "select count(*)::int as count from pg_settings where name like 'app.%'",
        )).rows[0].count,
        0,
      );
    } finally {
      await db`drop table if exists bakery.test_tx_probe`;
    }
  } finally {
    await closePgDatabase(appPg);
    await closePgDatabase(authDb);
    await closeDatabase(db);
  }
});

Deno.test("canonical lifecycle preserves populated upgrades and rolls back mappings", async () => {
  const db = openDatabase(url);
  const authDb = openPgDatabase(url);
  const admin = openDatabase(adminUrl);
  try {
    const providerMigrations = await loadMigrations(betterAuthMigrationSource);
    const platformMigrations = await loadMigrations(
      bakeryPlatformMigrationSource,
    );
    const authMigrations = await loadMigrations(authBakeryMigrationSource);
    const preCanonicalMigrations = [
      ...platformMigrations,
      ...authMigrations.filter(({ version }) =>
        version < "0005_canonical_lifecycle"
      ),
    ];
    // Later auth migrations (0079, 0090) alter work-owned audit tables.
    const bakeryMigrations = [
      ...preCanonicalMigrations,
      ...authMigrations.filter(({ version }) =>
        version >= "0005_canonical_lifecycle"
      ),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ].sort((left, right) => left.version.localeCompare(right.version));
    await resetTestDatabase(db, {
      targetUrl: url,
      ...readTestDatabaseResetOptions(),
    });
    await migrateProvider(authDb, providerMigrations);
    await migrate(db, preCanonicalMigrations);

    const organizationId = crypto.randomUUID();
    const adminUserId = crypto.randomUUID();
    const disabledUserId = crypto.randomUUID();
    const recipientUserId = crypto.randomUUID();
    const adminPrincipalId = crypto.randomUUID();
    const disabledPrincipalId = crypto.randomUUID();
    const servicePrincipalId = crypto.randomUUID();
    const adminMembershipId = crypto.randomUUID();
    const disabledMembershipId = crypto.randomUUID();
    const invitationId = crypto.randomUUID();
    const grantId = crypto.randomUUID();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const disabledAt = new Date("2026-01-02T00:00:00.000Z");
    const recipientEmail = `recipient-${recipientUserId}@example.test`;
    await db`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values
        (${adminUserId}, 'Legacy Admin',
          ${`admin-${adminUserId}@example.test`}, true, ${createdAt}, ${createdAt}),
        (${disabledUserId}, 'Legacy Disabled',
          ${`disabled-${disabledUserId}@example.test`}, true, ${createdAt}, ${createdAt}),
        (${recipientUserId}, 'Legacy Recipient', ${recipientEmail}, true,
          ${createdAt}, ${createdAt})
    `;
    await db`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type, disabled_at
      ) values
        (${adminPrincipalId}, ${adminUserId}, 'Legacy Admin', 'human', null),
        (${disabledPrincipalId}, ${disabledUserId}, 'Legacy Disabled',
          'human', ${disabledAt}),
        (${servicePrincipalId}, null, 'Legacy Service', 'service', null)
    `;
    await db`
      insert into public.organization (
        id, name, slug, logo, "createdAt", metadata, "updatedAt", version
      ) values (
        ${organizationId}, 'Legacy Organization',
        ${`legacy-${organizationId}`}, null, ${createdAt},
        '{"source":"provider"}', ${createdAt}, 7
      )
    `;
    await db`
      insert into public.member (
        id, "organizationId", "userId", role, status, "createdAt",
        "joinedAt", "updatedAt", version
      ) values
        (${adminMembershipId}, ${organizationId}, ${adminUserId}, 'admin',
          'active', ${createdAt}, ${createdAt}, ${createdAt}, 3),
        (${disabledMembershipId}, ${organizationId}, ${disabledUserId},
          'developer', 'active', ${createdAt}, ${createdAt}, ${createdAt}, 4)
    `;
    await db`
      insert into public.invitation (
        id, "organizationId", email, role, status, "expiresAt",
        "createdAt", "inviterId"
      ) values (
        ${invitationId}, ${organizationId}, ${recipientEmail}, 'developer',
        'pending', ${new Date("2026-02-01T00:00:00.000Z")}, ${createdAt},
        ${adminUserId}
      )
    `;
    await admin`
      insert into bakery.permission_grants (
        id, organization_id, principal_id, capability,
        granted_by_principal_id, policy_revision, created_at, updated_at, version
      ) values (
        ${grantId}, ${organizationId}, ${servicePrincipalId}, 'organizations.get',
        ${adminPrincipalId}, 1, ${createdAt}, ${createdAt}, 2
      )
    `;

    const providerBefore = await db`
      select id, name, slug from public.organization
      where id = ${organizationId}
    `;
    await migrate(db, bakeryMigrations);
    assertEquals([
      ...await db`
      select id, name, slug from bakery.organizations
      where id = ${organizationId}
    `,
    ], [...providerBefore]);
    assertEquals([
      ...await db`
      select id, organization_id, principal_id, role, status, version
      from bakery.organization_memberships
      where organization_id = ${organizationId}
      order by role
    `,
    ], [
      {
        id: adminMembershipId,
        organization_id: organizationId,
        principal_id: adminPrincipalId,
        role: "admin",
        status: "active",
        version: 3,
      },
      {
        id: disabledMembershipId,
        organization_id: organizationId,
        principal_id: disabledPrincipalId,
        role: "developer",
        status: "active",
        version: 4,
      },
    ]);
    assertEquals([
      ...await db`
      select id, organization_id, email, role, status,
        inviter_principal_id, inviter_membership_id
      from bakery.organization_invitations
      where id = ${invitationId}
    `,
    ], [{
      id: invitationId,
      organization_id: organizationId,
      email: recipientEmail,
      role: "developer",
      status: "pending",
      inviter_principal_id: adminPrincipalId,
      inviter_membership_id: adminMembershipId,
    }]);
    assertEquals([
      ...await db`
      select id, organization_id, principal_id, capability,
        granted_by_principal_id, policy_revision::int as policy_revision, version
      from bakery.permission_grants
      where id = ${grantId}
    `,
    ], [{
      id: grantId,
      organization_id: organizationId,
      principal_id: servicePrincipalId,
      capability: "organizations.get",
      granted_by_principal_id: adminPrincipalId,
      policy_revision: 1,
      version: 2,
    }]);
    assertEquals(
      (await db`
      select disabled_at from bakery.principals
      where id = ${disabledPrincipalId}
    `)[0].disabled_at,
      disabledAt,
    );
    await db`
      update public.member set role = 'developer'
      where id = ${adminMembershipId}
    `;
    assertEquals(
      (await db`
      select role from bakery.organization_memberships
      where id = ${adminMembershipId}
    `)[0].role,
      "admin",
    );
    await db`
      update public.member set role = 'admin'
      where id = ${adminMembershipId}
    `;
    const legacyOnlyUserId = crypto.randomUUID();
    const legacyOnlyPrincipalId = crypto.randomUUID();
    const legacyOnlyMembershipId = crypto.randomUUID();
    const legacyOnlyEmail = `legacy-only-${legacyOnlyUserId}@example.test`;
    await db`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${legacyOnlyUserId}, 'Legacy Only', ${legacyOnlyEmail}, true,
        ${createdAt}, ${createdAt}
      )
    `;
    await db`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (
        ${legacyOnlyPrincipalId}, ${legacyOnlyUserId}, 'Legacy Only', 'human'
      )
    `;
    await db`
      insert into public.member (
        id, "organizationId", "userId", role, status, "createdAt",
        "joinedAt", "updatedAt", version
      ) values (
        ${legacyOnlyMembershipId}, ${organizationId}, ${legacyOnlyUserId},
        'admin', 'active', ${createdAt}, ${createdAt}, ${createdAt}, 1
      )
    `;
    await db`delete from public.member where id = ${legacyOnlyMembershipId}`;
    await db`delete from bakery.principals where id = ${legacyOnlyPrincipalId}`;
    await db`delete from public."user" where id = ${legacyOnlyUserId}`;
    assertEquals(
      (await db`
      select id, "organizationId", email, role, status, "inviterId"
      from public.invitation where id = ${invitationId}
    `)[0],
      {
        id: invitationId,
        organizationId,
        email: recipientEmail,
        role: "developer",
        status: "pending",
        inviterId: adminUserId,
      },
    );
    assertEquals(
      (await db`
      select version from bakery.schema_migrations order by version
    `).map(({ version }) => version),
      bakeryMigrations.map(({ version }) => version),
    );
    await migrate(db, bakeryMigrations);
    const altered = bakeryMigrations.map((migration) => ({ ...migration }));
    const canonicalIndex = altered.findIndex(({ version }) =>
      version === "0005_canonical_lifecycle"
    );
    altered[canonicalIndex].sql += "\n-- checksum probe";
    altered[canonicalIndex].checksum = await checksumSql(
      altered[canonicalIndex].sql,
    );
    await assertRejects(
      () => migrate(db, altered),
      Error,
      "MIGRATION_CHECKSUM_MISMATCH:0005_canonical_lifecycle",
    );

    await resetTestDatabase(db, {
      targetUrl: url,
      ...readTestDatabaseResetOptions(),
    });
    await migrateProvider(authDb, providerMigrations);
    await migrate(db, preCanonicalMigrations);
    await db`alter table bakery.permission_grants add column role text`;
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "CANONICAL_MIGRATION_UNAPPROVED_PERMISSION_GRANT_ROLE_COLUMN",
    );
    assertEquals(
      (await db`
      select to_regclass('bakery.organizations') as table_name
    `)[0].table_name,
      null,
    );
    await db`alter table bakery.permission_grants drop column role`;
    const unmappableUserId = crypto.randomUUID();
    await db`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${unmappableUserId}, ' ', ${`unmappable-${unmappableUserId}@example.test`},
        true, ${createdAt}, ${createdAt}
      )
    `;
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "CANONICAL_MIGRATION_PRINCIPAL_MAPPING_REQUIRED",
    );
    assertEquals(
      (await db`
      select to_regclass('bakery.organizations') as table_name
    `)[0].table_name,
      null,
    );
    assertEquals(
      (await db`
      select version from bakery.schema_migrations order by version
    `).map(({ version }) => version),
      [
        "0001_platform_bootstrap",
        "0002_auth_principals",
        "0003_live_tenant_authority",
      ],
    );
    await db`delete from public."user" where id = ${unmappableUserId}`;
    await migrate(db, bakeryMigrations);
    assertEquals(
      (await db`
      select count(*)::int as count
      from information_schema.columns
      where table_schema = 'bakery'
        and table_name = 'permission_grants'
        and column_name = 'role'
    `)[0].count,
      0,
    );
  } finally {
    await closeDatabase(admin);
    await closePgDatabase(authDb);
    await closeDatabase(db);
  }
});

Deno.test("provider migration preserves pending inviter state for canonical cutover", async () => {
  const db = openDatabase(url);
  const authDb = openPgDatabase(url);
  try {
    const providerMigrations = await loadMigrations(betterAuthMigrationSource);
    const providerBeforeCanonical = providerMigrations.filter(({ version }) =>
      version < "0003_bakery_authority_columns"
    );
    const platformMigrations = await loadMigrations(
      bakeryPlatformMigrationSource,
    );
    const authMigrations = await loadMigrations(authBakeryMigrationSource);
    const preProviderCanonicalMigrations = [
      ...platformMigrations,
      ...authMigrations.filter(({ version }) =>
        version === "0002_auth_principals"
      ),
    ];
    const canonicalMigrations = [
      ...platformMigrations,
      ...authMigrations,
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ].sort((left, right) => left.version.localeCompare(right.version));
    await resetTestDatabase(db, {
      targetUrl: url,
      ...readTestDatabaseResetOptions(),
    });
    await migrateProvider(authDb, providerBeforeCanonical);
    await migrate(db, preProviderCanonicalMigrations);

    const organizationId = crypto.randomUUID();
    const inviterUserId = crypto.randomUUID();
    const inviterPrincipalId = crypto.randomUUID();
    const invitationId = crypto.randomUUID();
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const expiresAt = new Date("2026-02-01T00:00:00.000Z");
    const inviterEmail = `removed-inviter-${inviterUserId}@example.test`;
    const recipientEmail = `recipient-${invitationId}@example.test`;
    await db`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${inviterUserId}, 'Removed Inviter', ${inviterEmail}, true,
        ${createdAt}, ${createdAt}
      )
    `;
    await db`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (
        ${inviterPrincipalId}, ${inviterUserId}, 'Removed Inviter', 'human'
      )
    `;
    await db`
      insert into public.organization (
        id, name, slug, "createdAt", metadata
      ) values (
        ${organizationId}, 'Legacy Organization',
        ${`legacy-${organizationId}`}, ${createdAt}, '{}'
      )
    `;
    await db`
      insert into public.invitation (
        id, "organizationId", email, role, status, "expiresAt",
        "createdAt", "inviterId"
      ) values (
        ${invitationId}, ${organizationId}, ${recipientEmail}, 'developer',
        'pending', ${expiresAt}, ${createdAt}, ${inviterUserId}
      )
    `;

    await migrateProvider(authDb, providerMigrations, {
      beforeApply: preserveProviderInvitationState,
    });
    assertEquals(
      (await db`
        select status, "inviterId" from public.invitation where id = ${invitationId}
      `)[0],
      { status: "canceled", inviterId: null },
    );
    await migrate(db, canonicalMigrations);
    assertEquals(
      (await db`
        select status, inviter_principal_id, inviter_membership_id
        from bakery.organization_invitations where id = ${invitationId}
      `)[0],
      {
        status: "pending",
        inviter_principal_id: inviterPrincipalId,
        inviter_membership_id: null,
      },
    );
    assertEquals(
      (await db`
        select to_regclass('bakery.provider_invitation_migration_snapshot')
          as snapshot
      `)[0].snapshot,
      null,
    );
  } finally {
    await closePgDatabase(authDb);
    await closeDatabase(db);
  }
});

Deno.test("confirmed reset removes provider and Bakery state", async () => {
  const db = openDatabase(url);
  const authDb = openPgDatabase(url);
  try {
    await resetTestDatabase(db, {
      targetUrl: url,
      ...readTestDatabaseResetOptions(),
    });
    const state = await db`
      select
        to_regclass('public.user') as provider_user,
        to_regclass('public.better_auth_schema_migrations') as provider_ledger,
        to_regnamespace('bakery') as bakery_schema
    `;
    assertEquals(state[0], {
      provider_user: null,
      provider_ledger: null,
      bakery_schema: null,
    });

    const providerMigrations = await loadMigrations(betterAuthMigrationSource);
    const bakeryMigrations = [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ];
    const delayedProviderMigrations = [...providerMigrations];
    const delayedFirstSql = `select pg_sleep(0.2);\n${
      delayedProviderMigrations[0].sql
    }`;
    delayedProviderMigrations[0] = {
      ...delayedProviderMigrations[0],
      sql: delayedFirstSql,
      checksum: await checksumSql(delayedFirstSql),
    };
    const providerMigration = migrateProvider(
      authDb,
      delayedProviderMigrations,
    );
    await waitForAdvisoryMigrationLock(authDb);
    await Promise.all([providerMigration, migrate(db, bakeryMigrations)]);

    await resetTestDatabase(db, {
      targetUrl: url,
      ...readTestDatabaseResetOptions(),
    });
    await migrateProvider(authDb, providerMigrations);
    await migrate(db, bakeryMigrations);
    assertEquals(
      (await authDb.query(
        "select version from public.better_auth_schema_migrations order by version",
      )).rows,
      [
        { version: "0001_better_auth" },
        { version: "0002_application_grants" },
        { version: "0003_bakery_authority_columns" },
        { version: "0004_two_factor_assurance" },
        { version: "0005_passkey" },
        { version: "0006_profile_fields" },
        { version: "0007_session_passkey" },
        { version: "0008_session_reauthenticated_at" },
        { version: "0009_oauth_provider" },
        { version: "0010_permission_roles" },
        { version: "0011_scim" },
        { version: "0012_sso_provider" },
        { version: "0013_rate_limit_timestamp_double_precision" },
      ],
    );
  } finally {
    await closePgDatabase(authDb);
    await closeDatabase(db);
  }
});

Deno.test("budget provenance upgrade preserves legacy measurements and their reserved month", async () => {
  const db = openDatabase(url);
  const pg = openPgDatabase(url);
  try {
    const migrations = [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ];
    await resetTestDatabase(db, {
      targetUrl: url,
      ...readTestDatabaseResetOptions(),
    });
    await migrateProvider(pg, await loadMigrations(betterAuthMigrationSource));
    await migrate(db, migrations.filter(({ version }) => version < "0064_"));

    const organizationId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    const usageId = crypto.randomUUID();
    await pg.query(
      `insert into bakery.organizations (
         id, name, slug, metadata, created_at, updated_at, version
       ) values ($1, 'Legacy budget upgrade', $2, '{}'::jsonb,
                 clock_timestamp(), clock_timestamp(), 1)`,
      [organizationId, `legacy-budget-${organizationId}`],
    );
    await pg.query(
      `insert into bakery.budget_accounts (
         id, scope, period_start, period_end, limit_usd, reserved_usd, settled_usd
       ) values ($1, 'installation', '2026-09-01T00:00:00Z',
                 '2026-10-01T00:00:00Z', 100, 0, 0.125)`,
      [accountId],
    );
    await pg.query(
      `insert into bakery.budget_reservations (
         id, organization_id, budget_account_id, dedupe_key,
         reserved_usd, settled_usd, status, expires_at
       ) values ($1, $2, $3, 'legacy-hold', 0.2, 0.125, 'settled',
                 '2026-10-01T00:30:00Z')`,
      [reservationId, organizationId, accountId],
    );
    await pg.query(
      `insert into bakery.usage_records (
         id, organization_id, run_id, run_step_id, attempt_id,
         worker_host_id, worker_session_id, worker_session_generation, fence,
         result_event_id, usage_fact_id, canonical_digest,
         provider, billing_account_id, model, billing_type,
         input_tokens, output_tokens, cost_usd, measurement,
         provider_call_id, pricing_metadata_snapshot, dedupe_key,
         occurred_at, budget_reservation_id, reconciled_canonical_digest,
         original_input_tokens, original_output_tokens, original_cost_usd,
         original_measurement, original_occurred_at
       ) values (
         $1, $2, $3, $4, $5, $6, $7, 1, 1, $8, $9, repeat('a', 64),
         'legacy-upgrade', 'legacy-account', 'legacy-model', 'api',
         10, 20, 0.125, 'reported', 'legacy-call', 'legacy-unverified-price',
         'legacy-usage', '2026-10-01T00:01:00Z', $10, repeat('b', 64),
         8, 16, null, 'unknown', '2026-10-01T00:00:00Z'
       )`,
      [
        usageId,
        organizationId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        `legacy-fact-${usageId}`,
        reservationId,
      ],
    );
    const history = () =>
      pg.query(
        `select usage.cost_usd::text, usage.measurement, usage.canonical_digest,
                usage.reconciled_canonical_digest, usage.input_tokens::text,
                usage.output_tokens::text, usage.occurred_at::text,
                usage.original_input_tokens::text, usage.original_output_tokens::text,
                usage.original_cost_usd::text, usage.original_measurement,
                usage.original_occurred_at::text, reservation.status,
                reservation.reserved_usd::text, reservation.settled_usd::text,
                account.period_start::text, account.period_end::text,
                account.reserved_usd::text as account_reserved,
                account.settled_usd::text as account_settled
           from bakery.usage_records usage
           join bakery.budget_reservations reservation
             on reservation.id = usage.budget_reservation_id
           join bakery.budget_accounts account
             on account.id = reservation.budget_account_id
          where usage.id = $1`,
        [usageId],
      );
    const before = await history();
    await migrate(db, migrations);
    assertEquals((await history()).rows, before.rows);
    assertEquals(
      (await pg.query(
        `select provenance from bakery.usage_records where id = $1`,
        [usageId],
      )).rows,
      [{ provenance: "worker-unverified" }],
    );
    const summary = await withPgTransaction(
      pg,
      (transaction) =>
        readUsageSummary(transaction, {
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-10-01T00:00:00.000Z",
          provider: "legacy-upgrade",
        }),
    );
    assertEquals(summary.knownCostUsd, "0");
    assertEquals(summary.unverifiedCostUsd, "0.125");
    assertEquals(summary.unknownCount, 0);
    assertEquals(summary.unverifiedCount, 1);
    assertEquals(summary.completeness, "unknown");
    await pg.query("delete from bakery.organizations where id = $1", [
      organizationId,
    ]);
    await pg.query("delete from bakery.budget_accounts where id = $1", [
      accountId,
    ]);
  } finally {
    await closePgDatabase(pg);
    await closeDatabase(db);
  }
});
