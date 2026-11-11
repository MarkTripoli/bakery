import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertApplicationDatabase,
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
} from "../../apps/server/src/modules/auth/migrations.ts";
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";

const {
  databaseUrl: url,
  appDatabaseUrl: appUrl,
  adminDatabaseUrl: adminUrl,
} = readTestDatabaseConfig(Deno.env.toObject(), { requireAdmin: true });
const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error("TEST_DATABASE_NAME_UNSAFE");
}
const databaseIdentifier = `"${databaseName.replaceAll('"', '""')}"`;
const wrongTargetName = `${databaseName}_wrong_target`;
const wrongTargetIdentifier = `"${wrongTargetName.replaceAll('"', '""')}"`;
const unexpectedLedgerWriter = `bakery_ledger_${
  crypto.randomUUID().replaceAll("-", "")
}`;
const unexpectedLedgerWriterIdentifier = `"${unexpectedLedgerWriter}"`;
Deno.test("database fixture boundary is fail closed", async () => {
  const db = openDatabase(url);
  const authDb = openPgDatabase(url);
  const app = openDatabase(appUrl);
  const appPg = openPgDatabase(appUrl, 1);
  const adminPg = openPgDatabase(adminUrl, 1);
  const admin = openDatabase(adminUrl);
  const assumedOwner = openDatabase(adminUrl, 1);
  const wrongTargetUrl = new URL(url);
  wrongTargetUrl.pathname = `/${wrongTargetName}`;
  const wrongTarget = openDatabase(wrongTargetUrl.toString());
  const canonicalAdminUserId = crypto.randomUUID();
  const canonicalRecipientUserId = crypto.randomUUID();
  const canonicalAdminEmail =
    `canonical-admin-${canonicalAdminUserId}@example.test`;
  const canonicalRecipientEmail =
    `canonical-recipient-${canonicalRecipientUserId}@example.test`;
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
    await migrateProvider(authDb, providerMigrations);
    await migrate(db, bakeryMigrations);
    await migrateData(db, bakeryDataMigrations);
    await assertApplicationDatabase(appPg);
    await assertRejects(
      () => migrateProvider(appPg, providerMigrations),
      Error,
      "MIGRATION_SESSION_OWNER_UNSAFE",
    );
    await assertRejects(
      () => migrate(app, bakeryMigrations),
      Error,
      "MIGRATION_SESSION_OWNER_UNSAFE",
    );
    await admin`drop table if exists bakery.application_database_runtime_probe`;
    await assertRejects(
      () => assertApplicationDatabase(adminPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await adminPg.query("set role bakery_app");
    try {
      await assertRejects(
        () => assertApplicationDatabase(adminPg),
        Error,
        "BAKERY_APP_DATABASE_ROLE_UNSAFE",
      );
    } finally {
      await adminPg.query("reset role");
    }
    await admin`alter role bakery_app replication`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrateProvider(authDb, providerMigrations),
      Error,
      "BAKERY_APP_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "BAKERY_APP_ROLE_UNSAFE",
    );
    await admin`alter role bakery_app noreplication`;
    await admin`grant bakery to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await admin`revoke bakery from bakery_app`;
    await admin.unsafe(
      `grant create on database ${databaseIdentifier} to bakery_app`,
    );
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await admin.unsafe(
      `revoke create on database ${databaseIdentifier} from bakery_app`,
    );
    await admin`grant create on schema public to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await admin`revoke create on schema public from bakery_app`;
    await admin`grant create on schema bakery to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await admin`revoke create on schema bakery from bakery_app`;
    await admin`alter schema bakery owner to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await admin`alter schema bakery owner to bakery`;
    await admin`create table bakery.application_database_runtime_probe (id integer)`;
    await admin`alter table bakery.application_database_runtime_probe owner to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await admin`alter table bakery.application_database_runtime_probe owner to bakery`;
    await admin`drop table bakery.application_database_runtime_probe`;
    await assertRejects(
      () => migrateProvider(adminPg, providerMigrations),
      Error,
      "MIGRATION_SESSION_OWNER_UNSAFE",
    );
    await assertRejects(
      () => migrate(admin, bakeryMigrations),
      Error,
      "MIGRATION_SESSION_OWNER_UNSAFE",
    );
    await adminPg.query("set role bakery");
    try {
      await assertRejects(
        () => migrateProvider(adminPg, providerMigrations),
        Error,
        "MIGRATION_SESSION_OWNER_UNSAFE",
      );
    } finally {
      await adminPg.query("reset role");
    }
    await assumedOwner.unsafe("set role bakery");
    try {
      await assertRejects(
        () => migrate(assumedOwner, bakeryMigrations),
        Error,
        "MIGRATION_SESSION_OWNER_UNSAFE",
      );
    } finally {
      await assumedOwner.unsafe("reset role");
    }
    await assertRejects(
      async () =>
        await migrateProvider(authDb, [{
          owner: MigrationOwner.Bakery,
          version: "0001_wrong_owner",
          sql: "select 1",
          checksum: await checksumSql("select 1"),
        }]),
      Error,
      `MIGRATION_OWNER_MISMATCH:${MigrationOwner.BetterAuth}:${MigrationOwner.Bakery}:0001_wrong_owner`,
    );
    await assertRejects(
      () => resetTestDatabase(db, { targetUrl: url }),
      Error,
      "DESTRUCTIVE_RESET_REQUIRES_CONFIRMATION",
    );
    await admin.unsafe(
      `create database ${wrongTargetIdentifier} owner bakery_app`,
    );
    await assertRejects(
      () => migrate(wrongTarget, bakeryMigrations),
      Error,
      "BAKERY_DATABASE_OWNER_UNSAFE",
    );
    const roles =
      await db`select rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname in ('bakery', 'bakery_app') order by rolname`;
    assert(
      roles.some((r) =>
        r.rolname === "bakery_app" && !r.rolsuper && !r.rolcreatedb &&
        !r.rolbypassrls
      ),
    );
    const schemas =
      await db`select nspname from pg_namespace where nspname = 'bakery'`;
    assert(schemas.length === 1);
    const providerConstraints = await db`
      select conname
      from pg_constraint
      where conname in (
        'organization_version_positive',
        'member_status_supported',
        'member_version_positive',
        'member_organization_user_unique',
        'member_organization_id_unique',
        'invitation_same_organization_inviter_fk'
      )
      order by conname
    `;
    assertEquals(providerConstraints.map((row) => row.conname), [
      "invitation_same_organization_inviter_fk",
      "member_organization_id_unique",
      "member_organization_user_unique",
      "member_status_supported",
      "member_version_positive",
      "organization_version_positive",
    ]);
    const authorityTables = await db`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        r.rolname as owner
      from pg_class as c
      join pg_namespace as n on n.oid = c.relnamespace
      join pg_roles as r on r.oid = c.relowner
      where n.nspname = 'bakery'
        and c.relname in (
          'installation_administrators',
          'permission_grants',
          'organizations',
          'organization_memberships',
          'organization_invitations'
        )
      order by c.relname
    `;
    assertEquals(
      authorityTables.map((row) => ({
        relname: row.relname,
        relrowsecurity: row.relrowsecurity,
        relforcerowsecurity: row.relforcerowsecurity,
        owner: row.owner,
      })),
      [
        {
          relname: "installation_administrators",
          relrowsecurity: false,
          relforcerowsecurity: false,
          owner: "bakery",
        },
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
        {
          relname: "permission_grants",
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
    await app`select 1`;
    const ledger =
      await db`select has_table_privilege('bakery_app', 'bakery.schema_migrations', 'INSERT') as can_insert`;
    assert(ledger[0].can_insert === false);
    await assertRejects(
      () =>
        app`insert into bakery.schema_migrations (version, checksum) values ('9999_forged', 'f')`,
    );
    await admin`grant insert on bakery.schema_migrations to public`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "SCHEMA_MIGRATIONS_DML_UNSAFE:public:INSERT",
    );
    await admin`revoke insert on bakery.schema_migrations from public`;
    await admin`grant insert on bakery.schema_migrations to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "SCHEMA_MIGRATIONS_DML_UNSAFE:bakery_app:INSERT",
    );
    await admin`revoke insert on bakery.schema_migrations from bakery_app`;
    await admin`grant insert(version) on bakery.schema_migrations to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "SCHEMA_MIGRATIONS_DML_UNSAFE:bakery_app:INSERT",
    );
    await admin`revoke insert(version) on bakery.schema_migrations from bakery_app`;
    await admin.unsafe(
      `create role ${unexpectedLedgerWriterIdentifier} nologin`,
    );
    await admin.unsafe(
      `grant update(checksum) on bakery.schema_migrations to ${unexpectedLedgerWriterIdentifier}`,
    );
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      `SCHEMA_MIGRATIONS_DML_UNSAFE:${unexpectedLedgerWriter}:UPDATE`,
    );
    await admin.unsafe(
      `revoke update(checksum) on bakery.schema_migrations from ${unexpectedLedgerWriterIdentifier}`,
    );
    await admin.unsafe(`drop role ${unexpectedLedgerWriterIdentifier}`);
    await admin`grant insert on bakery.data_migrations to public`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrateData(db, bakeryDataMigrations),
      Error,
      "DATA_MIGRATIONS_DML_UNSAFE:public:INSERT",
    );
    await admin`revoke insert on bakery.data_migrations from public`;
    await admin`grant insert on bakery.data_migrations to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrateData(db, bakeryDataMigrations),
      Error,
      "DATA_MIGRATIONS_DML_UNSAFE:bakery_app:INSERT",
    );
    await admin`revoke insert on bakery.data_migrations from bakery_app`;
    await admin`grant update(checksum) on bakery.data_migrations to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrateData(db, bakeryDataMigrations),
      Error,
      "DATA_MIGRATIONS_DML_UNSAFE:bakery_app:UPDATE",
    );
    await admin`revoke update(checksum) on bakery.data_migrations from bakery_app`;
    await admin`grant insert on public.better_auth_schema_migrations to public`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrateProvider(authDb, providerMigrations),
      Error,
      "PROVIDER_SCHEMA_MIGRATIONS_DML_UNSAFE:",
    );
    await admin`revoke insert on public.better_auth_schema_migrations from public`;
    await admin`grant insert on public.better_auth_schema_migrations to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrateProvider(authDb, providerMigrations),
      Error,
      "PROVIDER_SCHEMA_MIGRATIONS_DML_UNSAFE:bakery_app:INSERT",
    );
    await admin`revoke insert on public.better_auth_schema_migrations from bakery_app`;
    await admin`grant insert(version) on public.better_auth_schema_migrations to bakery_app`;
    await assertRejects(
      () => assertApplicationDatabase(appPg),
      Error,
      "BAKERY_APP_DATABASE_ROLE_UNSAFE",
    );
    await assertRejects(
      () => migrateProvider(authDb, providerMigrations),
      Error,
      "PROVIDER_SCHEMA_MIGRATIONS_DML_UNSAFE:bakery_app:INSERT",
    );
    await admin`revoke insert(version) on public.better_auth_schema_migrations from bakery_app`;
    await admin`grant create on schema public to bakery_app`;
    await assertRejects(
      () => migrateProvider(authDb, providerMigrations),
      Error,
      "BAKERY_APP_PROVIDER_SCHEMA_CREATE_UNSAFE",
    );
    await admin`revoke create on schema public from bakery_app`;
    await admin`alter schema bakery owner to bakery_app`;
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "BAKERY_APP_ROLE_OWNS_SCHEMA",
    );
    await admin`alter schema bakery owner to bakery`;
    await admin`grant create on schema bakery to bakery_app`;
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "BAKERY_APP_SCHEMA_CREATE_UNSAFE",
    );
    await admin`revoke create on schema bakery from bakery_app`;
    await admin`grant bakery to bakery_app`;
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "BAKERY_APP_ROLE_MEMBERSHIP_UNSAFE",
    );
    await admin`revoke bakery from bakery_app`;
    await admin.unsafe(
      `alter database ${databaseIdentifier} owner to bakery_app`,
    );
    await app.unsafe(
      `alter database ${databaseIdentifier} connection limit 0`,
    );
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "BAKERY_DATABASE_OWNER_UNSAFE",
    );
    await admin.unsafe(`alter database ${databaseIdentifier} owner to bakery`);
    await admin.unsafe(
      `alter database ${databaseIdentifier} connection limit -1`,
    );
    await admin.unsafe(
      `grant create on database ${databaseIdentifier} to bakery`,
    );
    await admin`grant bakery to bakery_app`;
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "BAKERY_APP_ROLE_MEMBERSHIP_UNSAFE",
    );
    await admin`revoke bakery from bakery_app`;
    await admin.unsafe(
      `grant create on database ${databaseIdentifier} to bakery_app`,
    );
    await assertRejects(
      () => migrate(db, bakeryMigrations),
      Error,
      "BAKERY_APP_DATABASE_CREATE_UNSAFE",
    );
    await admin.unsafe(
      `revoke create on database ${databaseIdentifier} from bakery_app`,
    );
    await admin.unsafe(
      `grant create on database ${databaseIdentifier} to bakery`,
    );
    await admin`grant usage on schema bakery to bakery_app`;
    await migrate(db, bakeryMigrations);
    const canonicalOrganizationId = crypto.randomUUID();
    const canonicalAdminPrincipalId = crypto.randomUUID();
    const canonicalRecipientPrincipalId = crypto.randomUUID();
    const canonicalServicePrincipalId = crypto.randomUUID();
    const canonicalAdminMembershipId = crypto.randomUUID();
    const canonicalServiceMembershipId = crypto.randomUUID();
    const canonicalInvitationId = crypto.randomUUID();
    const canonicalGrantId = crypto.randomUUID();
    const canonicalNow = new Date();
    await admin`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values
        (${canonicalAdminUserId}, 'Canonical Admin',
          ${canonicalAdminEmail}, true,
          ${canonicalNow}, ${canonicalNow}),
        (${canonicalRecipientUserId}, 'Canonical Recipient',
          ${canonicalRecipientEmail}, true, ${canonicalNow}, ${canonicalNow})
    `;
    await admin`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values
        (${canonicalAdminPrincipalId}, ${canonicalAdminUserId},
          'Canonical Admin', 'human'),
        (${canonicalRecipientPrincipalId}, ${canonicalRecipientUserId},
          'Canonical Recipient', 'human'),
        (${canonicalServicePrincipalId}, null, 'Canonical Service', 'service')
    `;
    await admin`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at
      ) values (
        ${canonicalOrganizationId}, 'Canonical Organization',
        ${`canonical-${canonicalOrganizationId}`}, '{}',
        ${canonicalNow}, ${canonicalNow}
      )
    `;
    const creatorOrganizationId = crypto.randomUUID();
    const creatorMembershipId = crypto.randomUUID();
    await appPg.query("begin");
    await appPg.query(
      `insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at
      ) values ($1, $2, $3, '{}'::jsonb, current_timestamp, current_timestamp)`,
      [
        creatorOrganizationId,
        "Creator Organization",
        `creator-${creatorOrganizationId}`,
      ],
    );
    await appPg.query(
      `insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at
      ) values ($1, $2, $3, 'admin', 'active', current_timestamp,
        current_timestamp, current_timestamp)`,
      [creatorMembershipId, creatorOrganizationId, canonicalAdminPrincipalId],
    );
    await appPg.query("commit");
    await admin`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at
      ) values
        (${canonicalAdminMembershipId}, ${canonicalOrganizationId},
          ${canonicalAdminPrincipalId}, 'admin', 'active', ${canonicalNow},
          ${canonicalNow}, ${canonicalNow}),
        (${canonicalServiceMembershipId}, ${canonicalOrganizationId},
          ${canonicalServicePrincipalId}, null, 'active', ${canonicalNow},
          ${canonicalNow}, ${canonicalNow})
    `;
    await admin`
      insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id, created_at, updated_at
      ) values (
        ${canonicalInvitationId}, ${canonicalOrganizationId},
        ${canonicalRecipientEmail}, 'developer', 'pending',
        ${new Date(canonicalNow.getTime() + 60_000)},
        ${canonicalAdminPrincipalId}, ${canonicalAdminMembershipId},
        ${canonicalNow}, ${canonicalNow}
      )
    `;
    await admin`
      insert into bakery.permission_grants (
        id, organization_id, principal_id, capability,
        granted_by_principal_id
      ) values (
        ${canonicalGrantId}, ${canonicalOrganizationId},
        ${canonicalServicePrincipalId}, 'organizations.get',
        ${canonicalAdminPrincipalId}
      )
    `;
    // RLS is gone, so direct bakery_app reads return every row that the grants
    // allow. Isolation must come from adapter predicates, not the database.
    const unfiltered = await appPg.query<{
      organizations: number;
      memberships: number;
      invitations: number;
      grants: number;
    }>(`
      select
        (select count(*)::int from bakery.organizations) as organizations,
        (select count(*)::int from bakery.organization_memberships) as memberships,
        (select count(*)::int from bakery.organization_invitations) as invitations,
        (select count(*)::int from bakery.permission_grants) as grants
    `);
    assertEquals(unfiltered.rows[0], {
      organizations: 2,
      memberships: 3,
      invitations: 1,
      grants: 1,
    });
    assertEquals(
      [
        ...await db`
        select
          (select count(*)::int from bakery.organizations) as organizations,
          (select count(*)::int from bakery.organization_memberships) as memberships,
          (select count(*)::int from bakery.organization_invitations) as invitations,
          (select count(*)::int from bakery.permission_grants) as grants
      `,
      ],
      [unfiltered.rows[0]],
    );
    await assertRejects(
      () =>
        appPg.query(
          `insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status, joined_at,
          created_at, updated_at
        ) values ($1, $2, $3, null, 'active', current_timestamp,
          current_timestamp, current_timestamp)`,
          [
            crypto.randomUUID(),
            canonicalOrganizationId,
            canonicalAdminPrincipalId,
          ],
        ),
      Error,
      "HUMAN_MEMBERSHIP_ROLE_REQUIRED",
    );
    await appPg.query("rollback");
    await appPg.query("begin");
    const adminInvitationId = crypto.randomUUID();
    await appPg.query(
      `insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id, created_at, updated_at
      ) values ($1, $2, $3, 'developer', 'pending',
        current_timestamp + interval '1 hour', $4, $5,
        current_timestamp, current_timestamp)`,
      [
        adminInvitationId,
        canonicalOrganizationId,
        `admin-created-${adminInvitationId}@example.test`,
        canonicalAdminPrincipalId,
        canonicalAdminMembershipId,
      ],
    );
    assertEquals(
      (await appPg.query<{ id: string }>(
        `select id from bakery.organization_invitations where id = $1`,
        [adminInvitationId],
      )).rows,
      [{ id: adminInvitationId }],
    );
    await appPg.query("rollback");
    await appPg.query("begin");
    await assertRejects(
      () =>
        appPg.query(
          `update bakery.organization_invitations
           set email = $1, status = 'canceled'
           where id = $2`,
          ["mutated@example.test", canonicalInvitationId],
        ),
      Error,
      "INVITATION_SCOPE_FIELDS_IMMUTABLE",
    );
    await appPg.query("rollback");
    await admin`
      delete from bakery.organization_memberships
      where id = ${canonicalAdminMembershipId}
    `;
    const retainedInvitation = await admin`
      select status, inviter_principal_id, inviter_membership_id
      from bakery.organization_invitations
      where id = ${canonicalInvitationId}
    `;
    assertEquals([...retainedInvitation], [{
      status: "pending",
      inviter_principal_id: canonicalAdminPrincipalId,
      inviter_membership_id: null,
    }]);
    await admin`
      delete from bakery.organizations
      where id = ${creatorOrganizationId}
    `;
    const restored = await admin`
      select has_database_privilege('bakery', 'bakery', 'CREATE') as owner_can_create,
        has_database_privilege('bakery_app', 'bakery', 'CREATE') as app_can_create,
        has_schema_privilege('bakery_app', 'bakery', 'USAGE') as app_can_use
    `;
    assert(restored[0].owner_can_create === true);
    assert(restored[0].app_can_create === false);
    assert(restored[0].app_can_use === true);
    const authPrivileges = await db`
      select
        has_table_privilege('public', 'public.better_auth_schema_migrations', 'INSERT') as public_can_forge_provider_ledger,
        has_table_privilege('bakery_app', 'bakery.principals', 'SELECT') as app_can_read_principals,
        has_table_privilege('bakery_app', 'bakery.principals', 'INSERT') as app_can_create_principals,
        has_table_privilege('bakery_app', 'bakery.principals', 'UPDATE') as app_can_update_principals,
        has_table_privilege('bakery_app', 'bakery.principals', 'DELETE') as app_can_delete_principals,
        has_table_privilege('bakery_app', 'public.user', 'SELECT') as app_can_read_provider_users,
        has_table_privilege('bakery_app', 'public.session', 'INSERT') as app_can_create_sessions,
        has_table_privilege('bakery_app', 'public.invitation', 'UPDATE') as app_can_accept_invitations,
        has_table_privilege('bakery_app', 'public.user', 'TRUNCATE') as app_can_truncate_provider_users,
        has_table_privilege('bakery_app', 'bakery.installation_administrators', 'SELECT') as app_can_read_installation_administrators,
        has_table_privilege('bakery_app', 'bakery.permission_grants', 'SELECT') as app_can_read_permission_grants,
        has_table_privilege('bakery_app', 'bakery.permission_grants', 'INSERT') as app_can_create_permission_grants,
        has_table_privilege('bakery_app', 'bakery.permission_grants', 'UPDATE') as app_can_update_permission_grants,
        has_table_privilege('bakery_app', 'bakery.permission_grants', 'DELETE') as app_can_delete_permission_grants,
        has_function_privilege('bakery_app', 'bakery.enforce_permission_grant_active_unique()', 'EXECUTE') as app_can_execute_permission_grant_trigger,
        has_table_privilege('bakery_app', 'bakery.access_tokens', 'SELECT') as app_can_read_access_tokens,
        has_table_privilege('bakery_app', 'bakery.access_tokens', 'INSERT') as app_can_create_access_tokens,
        has_table_privilege('bakery_app', 'bakery.access_tokens', 'UPDATE') as app_can_update_access_tokens,
        has_table_privilege('bakery_app', 'bakery.access_tokens', 'DELETE') as app_can_delete_access_tokens,
        has_table_privilege('bakery_app', 'bakery.organizations', 'SELECT') as app_can_read_organizations,
        has_table_privilege('bakery_app', 'bakery.organization_memberships', 'INSERT') as app_can_create_memberships,
        has_table_privilege('bakery_app', 'bakery.organization_invitations', 'UPDATE') as app_can_update_invitations,
        has_schema_privilege('bakery_app', 'public', 'CREATE') as app_can_create_provider_objects
    `;
    assert(authPrivileges[0].public_can_forge_provider_ledger === false);
    assert(authPrivileges[0].app_can_read_principals === true);
    assert(authPrivileges[0].app_can_create_principals === true);
    assert(authPrivileges[0].app_can_update_principals === true);
    assert(authPrivileges[0].app_can_delete_principals === false);
    assert(authPrivileges[0].app_can_read_provider_users === true);
    assert(authPrivileges[0].app_can_create_sessions === true);
    assert(authPrivileges[0].app_can_accept_invitations === true);
    assert(authPrivileges[0].app_can_truncate_provider_users === false);
    assert(authPrivileges[0].app_can_read_installation_administrators === true);
    assert(authPrivileges[0].app_can_read_permission_grants === true);
    assert(authPrivileges[0].app_can_create_permission_grants === true);
    assert(authPrivileges[0].app_can_update_permission_grants === false);
    assert(authPrivileges[0].app_can_delete_permission_grants === true);
    assert(
      authPrivileges[0].app_can_execute_permission_grant_trigger === false,
    );
    assert(authPrivileges[0].app_can_read_access_tokens === true);
    assert(authPrivileges[0].app_can_create_access_tokens === true);
    assert(authPrivileges[0].app_can_update_access_tokens === true);
    assert(authPrivileges[0].app_can_delete_access_tokens === false);
    assert(authPrivileges[0].app_can_read_organizations === true);
    assert(authPrivileges[0].app_can_create_memberships === true);
    assert(authPrivileges[0].app_can_update_invitations === true);
    assert(authPrivileges[0].app_can_create_provider_objects === false);
    await assertRejects(
      () => app`alter table bakery.organizations enable row level security`,
    );
  } finally {
    await admin`drop table if exists bakery.application_database_runtime_probe`;
    await admin`revoke insert on bakery.schema_migrations from public`;
    await admin`revoke insert on bakery.schema_migrations from bakery_app`;
    await admin`revoke insert(version) on bakery.schema_migrations from bakery_app`;
    await admin`revoke update(checksum) on bakery.data_migrations from bakery_app`;
    await admin`revoke insert on public.better_auth_schema_migrations from public`;
    await admin`revoke insert(version) on public.better_auth_schema_migrations from bakery_app`;
    await admin.unsafe(
      `drop role if exists ${unexpectedLedgerWriterIdentifier}`,
    );
    await admin`alter role bakery_app noreplication`;
    await admin`revoke create on schema public from bakery_app`;
    await admin`revoke create on schema bakery from bakery_app`;
    await admin`alter schema bakery owner to bakery`;
    await admin`revoke bakery from bakery_app`;
    await admin.unsafe(`alter database ${databaseIdentifier} owner to bakery`);
    await admin.unsafe(
      `alter database ${databaseIdentifier} connection limit -1`,
    );
    await admin.unsafe(
      `revoke create on database ${databaseIdentifier} from bakery_app`,
    );
    await admin.unsafe(
      `grant create on database ${databaseIdentifier} to bakery`,
    );
    await admin`grant usage on schema bakery to bakery_app`;
    const restored = await admin`
      select has_database_privilege('bakery', 'bakery', 'CREATE') as owner_can_create,
        has_database_privilege('bakery_app', 'bakery', 'CREATE') as app_can_create,
        has_schema_privilege('bakery_app', 'bakery', 'USAGE') as app_can_use
    `;
    assert(restored[0].owner_can_create === true);
    assert(restored[0].app_can_create === false);
    assert(restored[0].app_can_use === true);
    await closeDatabase(app);
    await closePgDatabase(appPg);
    await closeDatabase(wrongTarget);
    await closePgDatabase(adminPg);
    await closeDatabase(assumedOwner);
    await admin.unsafe(`drop database if exists ${wrongTargetIdentifier}`);
    await closeDatabase(admin);
    await cleanupAuthFixture(authDb, [
      canonicalAdminEmail,
      canonicalRecipientEmail,
    ]);
    await closePgDatabase(authDb);
    await closeDatabase(db);
  }
});
