import { assertEquals, assertRejects } from "@std/assert";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  createReadyAuthProvider,
  createSuperuser,
} from "../../apps/server/src/modules/auth/index.ts";
import { workBakeryMigrationSource } from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { OrganizationRole } from "../../apps/server/src/modules/auth/domain/authorization.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  decideRegistration,
  RegistrationAction,
  RegistrationErrorCode,
} from "../../apps/server/src/modules/auth/domain/registration.ts";
import { AuthErrorCode } from "../../apps/server/src/modules/auth/domain/errors.ts";
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
  authRequest,
  cleanupAuthFixture,
  openAuthFixture,
} from "../helpers/auth.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";

const { databaseUrl: url } = readTestDatabaseConfig();

Deno.test("registration decisions use live invitations and enabled principals", async () => {
  const database = openDatabase(url);
  const pgDatabase = openPgDatabase(url);
  const providerUserId = crypto.randomUUID();
  const inviterPrincipalId = crypto.randomUUID();
  const inviterMembershipId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const invitationId = crypto.randomUUID();
  const expiredInvitationId = crypto.randomUUID();
  const suffix = crypto.randomUUID();
  const email = `phase3-${suffix}@example.test`;
  const expiredEmail = `expired-${suffix}@example.test`;
  const now = new Date();
  const persistence = createPostgresAuthPersistence(pgDatabase);

  try {
    await migrateProvider(
      pgDatabase,
      await loadMigrations(betterAuthMigrationSource),
    );
    await migrate(database, [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ]);
    await pgDatabase.query(
      `insert into public."user" (id, name, email, "emailVerified")
       values ($1, 'Phase 3 Inviter', $2, true)`,
      [providerUserId, `inviter-${suffix}@example.test`],
    );
    await pgDatabase.query(
      `insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values ($1, $2, 'Phase 3 Inviter', 'human')`,
      [inviterPrincipalId, providerUserId],
    );
    await pgDatabase.query(
      `insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values ($1, 'Phase 3', $2, '{}'::jsonb, $3, $3, 1)`,
      [organizationId, `phase3-${suffix}`, now],
    );
    await pgDatabase.query(
      `insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status,
        joined_at, created_at, updated_at, version
      ) values ($1, $2, $3, 'admin', 'active', $4, $4, $4, 1)`,
      [inviterMembershipId, organizationId, inviterPrincipalId, now],
    );
    await pgDatabase.query(
      `insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id,
        created_at, updated_at, version
      ) values ($1, $2, $3, 'developer', 'pending', $4, $5, $6, $7, $7, 1)`,
      [
        invitationId,
        organizationId,
        email,
        new Date(now.getTime() + 60_000),
        inviterPrincipalId,
        inviterMembershipId,
        now,
      ],
    );
    await pgDatabase.query(
      `insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id,
        created_at, updated_at, version
      ) values ($1, $2, $3, 'developer', 'pending', $4, $5, $6, $7, $7, 1)`,
      [
        expiredInvitationId,
        organizationId,
        expiredEmail,
        new Date(now.getTime() - 1_000),
        inviterPrincipalId,
        inviterMembershipId,
        now,
      ],
    );

    assertEquals(
      await decideRegistration({
        action: RegistrationAction.CreateUser,
        email: `  ${email.toUpperCase()}  `,
        hasRequest: true,
        now,
        signupsEnabled: true,
      }, persistence),
      undefined,
    );
    assertEquals(await persistence.hasLiveInvitation(expiredEmail, now), false);
    assertEquals(
      await decideRegistration({
        action: RegistrationAction.CreateUser,
        email: `different-${suffix}@example.test`,
        hasRequest: true,
        now,
        signupsEnabled: true,
      }, persistence),
      { error: RegistrationErrorCode.IdentityNotAllowed },
    );
    assertEquals(
      await decideRegistration({
        action: RegistrationAction.CreateUser,
        hasRequest: false,
        now,
        signupsEnabled: true,
      }, persistence),
      undefined,
    );

    await persistence.upsertHumanPrincipal({
      providerUserId,
      displayName: "Phase 3 Inviter",
    });
    assertEquals(
      await decideRegistration({
        action: RegistrationAction.SignIn,
        providerUserId,
        hasRequest: true,
        now,
        signupsEnabled: true,
      }, persistence),
      undefined,
    );

    await pgDatabase.query(
      "update bakery.principals set disabled_at = $2 where provider_user_id = $1",
      [providerUserId, now],
    );
    assertEquals(
      await decideRegistration({
        action: RegistrationAction.LinkAccount,
        providerUserId,
        hasRequest: true,
        now,
        signupsEnabled: true,
      }, persistence),
      { error: RegistrationErrorCode.IdentityNotAllowed },
    );

    for (const status of ["accepted", "rejected", "canceled"]) {
      await pgDatabase.query(
        "update bakery.organization_invitations set status = $2 where id = $1",
        [invitationId, status],
      );
      assertEquals(
        await persistence.hasLiveInvitation(email, now),
        false,
        status,
      );
    }
    assertEquals(await persistence.hasLiveInvitation(expiredEmail, now), false);
  } finally {
    await pgDatabase.query(
      "delete from bakery.organizations where id = $1",
      [organizationId],
    ).catch(() => undefined);
    await pgDatabase.query(
      "delete from bakery.principals where provider_user_id = $1",
      [providerUserId],
    ).catch(() => undefined);
    await pgDatabase.query('delete from public."user" where id = $1', [
      providerUserId,
    ]).catch(() => undefined);
    await Promise.all([
      closePgDatabase(pgDatabase),
      closeDatabase(database),
    ]);
  }
});

Deno.test("createsuperuser converges a fresh and compatible partial bootstrap", async () => {
  const database = openDatabase(url);
  const pgDatabase = openPgDatabase(url);
  const suffix = crypto.randomUUID();
  const email = `bootstrap-${suffix}@example.test`;
  const password = `Phase4-${suffix}`;
  const dependencies = {
    pgDatabase,
    config: {
      secret: "phase-4-integration-secret-value",
      publicOrigin: "http://127.0.0.1:8788",
      trustedOrigins: ["http://127.0.0.1:8788"],
    },
  };
  const input = { email, displayName: "Phase 4 Admin", password };
  const persistence = createPostgresAuthPersistence(pgDatabase);
  let ownsBootstrapRows = false;

  try {
    await migrateProvider(
      pgDatabase,
      await loadMigrations(betterAuthMigrationSource),
    );
    await migrate(database, [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ]);
    await migrateData(database, bakeryDataMigrations);
    const initial = await persistence.withBootstrapLock((transaction) =>
      transaction.inspect()
    );
    assertEquals(initial, {
      users: [],
      organizations: [],
      members: [],
      principals: [],
      installation: {
        principalId: null,
        repairVersion: null,
        grantedByPrincipalId: null,
        revoked: false,
      },
    });
    ownsBootstrapRows = true;

    const concurrent = await Promise.all([
      createSuperuser(dependencies, input),
      createSuperuser(dependencies, input),
    ]);
    assertEquals(
      concurrent.map(({ status }) => status).sort(),
      ["already-complete", "completed"],
    );

    let state = await persistence.withBootstrapLock((transaction) =>
      transaction.inspect()
    );
    assertEquals(state.users.map((user) => user.email), [email]);
    assertEquals(
      state.organizations.map(({ name, slug }) => ({ name, slug })),
      [
        { name: "Personal", slug: "personal" },
      ],
    );
    assertEquals(state.members.map((member) => member.role), [
      OrganizationRole.Admin,
    ]);
    assertEquals(state.installation, {
      principalId: state.principals[0].id,
      repairVersion: 1,
      grantedByPrincipalId: state.principals[0].id,
      revoked: false,
    });
    assertEquals(
      state.principals.map((principal) => ({
        providerUserId: principal.providerUserId,
        principalType: principal.principalType,
        disabled: principal.disabled,
      })),
      [{
        providerUserId: state.users[0].id,
        principalType: "human",
        disabled: false,
      }],
    );
    assertEquals(
      (await pgDatabase.query<{ count: number }>(
        `select count(*)::int as count
         from bakery.principals
         where provider_user_id = $1`,
        [state.users[0].id],
      )).rows[0].count,
      1,
    );
    assertEquals(
      (await pgDatabase.query<{ count: number }>(
        "select count(*)::int as count from public.session",
      )).rows[0].count,
      0,
    );

    await pgDatabase.query(`
      create function public.reject_bootstrap_session_insert()
      returns trigger language plpgsql as $$
      begin
        raise exception 'bootstrap session insert forbidden';
      end
      $$
    `);
    await pgDatabase.query(`
      create trigger reject_bootstrap_session_insert
      before insert on public.session
      for each row execute function public.reject_bootstrap_session_insert()
    `);
    try {
      assertEquals(await createSuperuser(dependencies, input), {
        status: "already-complete",
      });
    } finally {
      await pgDatabase.query(
        "drop trigger reject_bootstrap_session_insert on public.session",
      );
      await pgDatabase.query(
        "drop function public.reject_bootstrap_session_insert()",
      );
    }

    await pgDatabase.query(
      `delete from bakery.organizations
       where id in (
         select membership.organization_id
         from bakery.organization_memberships as membership
         join bakery.principals as principal
           on principal.id = membership.principal_id
         where principal.provider_user_id = $1
       )`,
      [state.users[0].id],
    );
    assertEquals(
      (await pgDatabase.query(
        `update bakery.installation_settings
       set bootstrap_principal_id = null, bootstrap_repair_version = null
       where bootstrap_principal_id = $1`,
        [state.principals[0].id],
      )).rowCount,
      1,
    );
    assertEquals(
      (await pgDatabase.query(
        "delete from bakery.installation_administrators where principal_id = $1",
        [state.principals[0].id],
      )).rowCount,
      1,
    );
    await pgDatabase.query(
      "delete from bakery.principals where provider_user_id = $1",
      [state.users[0].id],
    );
    assertEquals(await createSuperuser(dependencies, input), {
      status: "completed",
    });
    state = await persistence.withBootstrapLock((transaction) =>
      transaction.inspect()
    );
    assertEquals(state.members.length, 1);
    assertEquals(state.principals.length, 1);
    assertEquals(state.installation.principalId, state.principals[0].id);
    assertEquals(state.installation.repairVersion, 1);
    assertEquals(
      state.installation.grantedByPrincipalId,
      state.principals[0].id,
    );
    assertEquals(state.installation.revoked, false);

    await assertRejects(
      () => createSuperuser(dependencies, { ...input, password: "wrong-pass" }),
      Error,
      AuthErrorCode.BootstrapConflict,
    );
    await assertRejects(
      () =>
        createSuperuser(dependencies, {
          ...input,
          email: `conflict-${suffix}@example.test`,
        }),
      Error,
      AuthErrorCode.BootstrapConflict,
    );
    assertEquals(
      (await pgDatabase.query<{ count: number }>(
        "select count(*)::int as count from public.session",
      )).rows[0].count,
      0,
    );
  } finally {
    try {
      if (ownsBootstrapRows) await cleanupAuthFixture(pgDatabase, [email]);
    } finally {
      await Promise.all([
        closePgDatabase(pgDatabase),
        closeDatabase(database),
      ]);
    }
  }
});

Deno.test("sign-in repairs a transient invited principal sync failure", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const adminEmail = `repair-admin-${suffix}@example.test`;
  const invitedEmail = `repair-invited-${suffix}@example.test`;
  const password = `Repair-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, {
      email: adminEmail,
      displayName: "Repair Admin",
      password,
    });
    const bootstrap = createPostgresAuthPersistence(fixture.pgDatabase);
    const state = await bootstrap.withBootstrapLock((transaction) =>
      transaction.inspect()
    );
    const adminPrincipal = await fixture.pgDatabase.query<{ id: string }>(
      `select principal.id
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [adminEmail],
    );
    const adminMembership = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.organization_memberships
       where organization_id = $1 and principal_id = $2`,
      [state.organizations[0].id, adminPrincipal.rows[0].id],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id,
        created_at, updated_at, version
      ) values ($1, $2, $3, 'developer', 'pending', $4, $5, $6,
        current_timestamp, current_timestamp, 1)`,
      [
        crypto.randomUUID(),
        state.organizations[0].id,
        invitedEmail,
        new Date(Date.now() + 60_000),
        adminPrincipal.rows[0].id,
        adminMembership.rows[0].id,
      ],
    );

    const persistence = createPostgresAuthPersistence(fixture.pgDatabase);
    let failPrincipalSync = true;
    const auth = await createReadyAuthProvider({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
      persistence: {
        ...persistence,
        upsertHumanPrincipal(user) {
          if (failPrincipalSync) {
            failPrincipalSync = false;
            throw new Error("TRANSIENT_PRINCIPAL_SYNC_FAILURE");
          }
          return persistence.upsertHumanPrincipal(user);
        },
      },
      log: () => {},
    });
    const signup = await auth.handler(authRequest(
      "/api/auth/sign-up/email",
      { email: invitedEmail, password, name: "Repair Invited" },
    ));
    assertEquals(signup.status, 200);
    assertEquals(
      (await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::int as count
         from bakery.principals as principal
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
         where provider_user.email = $1`,
        [invitedEmail],
      )).rows[0].count,
      0,
    );

    const signIn = await auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email: invitedEmail, password },
    ));
    assertEquals(signIn.status, 200);
    assertEquals(
      (await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::int as count
         from bakery.principals as principal
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
         where provider_user.email = $1`,
        [invitedEmail],
      )).rows[0].count,
      1,
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [adminEmail, invitedEmail]);
    await fixture.close();
  }
});
