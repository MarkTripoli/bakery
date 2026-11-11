import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ActionKind,
  ActionRegistry,
  HttpMethod,
} from "../../packages/contracts/src/action-registry.ts";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
  principalId as asPrincipalId,
  PrincipalType,
} from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { catalogVersion } from "../../packages/i18n/src/index.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  createSuperuser,
} from "../../apps/server/src/modules/auth/index.ts";
import { workBakeryMigrationSource } from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { PostgresOrganizationStore } from "../../apps/server/src/modules/auth/adapters/organization-postgres.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import { idempotencyLockKey } from "../../apps/server/src/platform/command-replay.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../../apps/server/src/modules/auth/application/authority.ts";
import type { OrganizationUpdateInput } from "../../apps/server/src/modules/auth/application/organizations.ts";
import type { AuthenticatedSubject } from "../../apps/server/src/modules/auth/application/identity.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
} from "../../apps/server/src/platform/migrate.ts";
import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";

type Page = {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
};

const stableProblem = (body: Record<string, unknown>) => {
  const {
    requestId: _requestId,
    traceId: _traceId,
    instance: _instance,
    ...rest
  } = body;
  return rest;
};

const ADMIN_MINIMUM_ACCESS = [
  "Admin",
  "Developer for personal; Admin for organization",
  "Owner for personal; Admin for organization",
];

const DEVELOPER_MINIMUM_ACCESS = [
  "Developer",
  "Developer or Worker (pinned version + current lease)",
  "Developer+action grant",
  "Authorized owner/member",
  "Authorized owner/member+install grant",
  "Current member",
  "Current member linking self",
  "Developer+admission authority",
  "Developer+deploy grant",
  "Developer+exact external action grant",
  "Developer+resource read",
  "Developer+source and destination read",
  "Developer+source read",
  "Exact action/read grant",
  "Initiating principal or Admin",
  "Linked principal or Admin",
  "Organization member",
];

/**
 * Distinct permission-key counts per minimum role, derived directly from the
 * catalog source (`docs/technical-design/api-catalog.json`) rather than from
 * `rolePermissions`, so the assertions below catch drift in either direction
 * without re-asserting the implementation's own derivation.
 */
async function catalogPermissionCounts(): Promise<{
  admin: number;
  developer: number;
}> {
  const catalog = JSON.parse(
    await Deno.readTextFile(
      new URL("../../docs/technical-design/api-catalog.json", import.meta.url),
    ),
  ) as {
    actions: Array<{ permission: string | null; access: string }>;
  };
  const admin = new Set<string>();
  const developer = new Set<string>();
  for (const action of catalog.actions) {
    if (!action.permission) continue;
    if (ADMIN_MINIMUM_ACCESS.includes(action.access)) {
      admin.add(action.permission);
    } else if (DEVELOPER_MINIMUM_ACCESS.includes(action.access)) {
      developer.add(action.permission);
    }
  }
  // Admin holds every role-bearing key: admin-minimum plus developer-minimum.
  return { admin: admin.size + developer.size, developer: developer.size };
}

Deno.test("principal and organization reads observe live multi-organization authority", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const adminEmail = `phase4-admin-${suffix}@example.test`;
  const invitedEmail = `phase4-invited-${suffix}@example.test`;
  const password = `Phase4-${suffix}`;
  const organizationB = crypto.randomUUID();
  const inactiveOrganization = crypto.randomUUID();
  const invitationId = crypto.randomUUID();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, {
      email: adminEmail,
      displayName: "Phase 4 Admin",
      password,
    });
    const state = await createPostgresAuthPersistence(fixture.pgDatabase)
      .withBootstrapLock((transaction) => transaction.inspect());
    const providerUserId = state.users[0].id;
    const organizationA = state.organizations[0].id;
    const principal = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.principals where provider_user_id = $1",
      [providerUserId],
    );
    const principalId = principal.rows[0].id;
    const now = Date.now();
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values
        ($1, 'Organization B', $2, '{"tier":"b"}'::jsonb, $3, $3, 1),
        ($4, 'Inactive Organization', $5, '{}'::jsonb, $6, $6, 1)`,
      [
        organizationB,
        `organization-b-${suffix}`,
        new Date(now + 1_000),
        inactiveOrganization,
        `inactive-${suffix}`,
        new Date(now + 2_000),
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status,
        joined_at, created_at, updated_at, version
      ) values
        ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1),
        ($5, $6, $3, 'admin', 'inactive', $7, $7, $7, 1)`,
      [
        crypto.randomUUID(),
        organizationB,
        principalId,
        new Date(now + 1_000),
        crypto.randomUUID(),
        inactiveOrganization,
        new Date(now + 2_000),
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id,
        created_at, updated_at, version
      ) values (
        $1, $2, $3, 'developer', 'pending', $4, $5,
        (select id from bakery.organization_memberships
         where organization_id = $2 and principal_id = $5),
        $6, $6, 1
      )`,
      [
        invitationId,
        organizationA,
        invitedEmail,
        new Date(now + 60_000),
        principalId,
        new Date(now + 500),
      ],
    );

    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email: adminEmail, password },
    ));
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);
    const get = (path: string, organizationId?: string) => {
      const headers = new Headers({ cookie });
      if (organizationId) {
        headers.set("Bakery-Organization-Id", organizationId);
      }
      return fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, { headers }),
      );
    };

    const identity = await get("/v1/me");
    assertEquals(identity.status, 200);
    const identityBody = await identity.json();
    assertEquals(identityBody, {
      principalId,
      principalType: "human",
      displayName: "Phase 4 Admin",
      locale: "en",
      direction: "ltr",
      catalogVersion,
      twoFactorEnabled: false,
      email: adminEmail,
      backupCodesRemaining: null,
      timeZone: null,
    });

    const first = await get("/v1/organizations?limit=1");
    assertEquals(first.status, 200);
    const firstPage = await first.json() as Page;
    assertEquals(firstPage.items.length, 1);
    assert(firstPage.nextCursor);
    const second = await get(
      `/v1/organizations?limit=1&cursor=${
        encodeURIComponent(firstPage.nextCursor)
      }`,
    );
    assertEquals(second.status, 200);
    const secondPage = await second.json() as Page;
    assertEquals(secondPage.items.length, 1);
    assertEquals(secondPage.nextCursor, null);
    const accessById = new Map(
      [...firstPage.items, ...secondPage.items].map((item) => [item.id, item]),
    );
    assertEquals(accessById.get(organizationA)?.role, "admin");
    assertEquals(accessById.get(organizationB)?.role, "developer");
    assertEquals(accessById.has(inactiveOrganization), false);

    const organization = await get(
      `/v1/organizations/${organizationB}`,
      organizationB,
    );
    assertEquals(organization.status, 200);
    assertEquals((await organization.json()).metadata, { tier: "b" });

    const permissionCounts = await catalogPermissionCounts();

    const adminAccess = await get(
      `/v1/organizations/${organizationA}/effective-access`,
      organizationA,
    );
    assertEquals(adminAccess.status, 200);
    const adminBody = await adminAccess.json() as {
      organizationId: string;
      role: string;
      capabilities: string[];
    };
    assertEquals(adminBody.organizationId, organizationA);
    assertEquals(adminBody.role, "admin");
    assertEquals(adminBody.capabilities.length, permissionCounts.admin);
    for (
      const key of ["organization:manage", "organizationMembership:manage"]
    ) {
      assert(adminBody.capabilities.includes(key));
    }
    const developerAccess = await get(
      `/v1/organizations/${organizationB}/effective-access`,
      organizationB,
    );
    assertEquals(developerAccess.status, 200);
    const developerBody = await developerAccess.json() as {
      organizationId: string;
      role: string;
      capabilities: string[];
    };
    assertEquals(developerBody.organizationId, organizationB);
    assertEquals(developerBody.role, "developer");
    assertEquals(developerBody.capabilities.length, permissionCounts.developer);
    for (const key of ["organization:read", "task:read", "artifact:write"]) {
      assert(developerBody.capabilities.includes(key));
    }
    for (
      const key of ["organization:manage", "organizationMembership:manage"]
    ) {
      assert(!developerBody.capabilities.includes(key));
    }
    for (const key of developerBody.capabilities) {
      assert(adminBody.capabilities.includes(key));
    }

    const memberships = await get(
      `/v1/organizations/${organizationB}/memberships`,
      organizationB,
    );
    assertEquals(memberships.status, 200);
    const membershipPage = await memberships.json() as Page;
    assertEquals(membershipPage.items.length, 1);
    assertEquals(membershipPage.items[0].principalId, principalId);
    assertEquals(membershipPage.items[0].role, "developer");

    const invitations = await get(
      `/v1/organizations/${organizationA}/invitations`,
      organizationA,
    );
    assertEquals(invitations.status, 200);
    const invitationPage = await invitations.json() as Page;
    assertEquals(invitationPage.items.length, 1);
    assertEquals(invitationPage.items[0], {
      id: invitationId,
      organizationId: organizationA,
      email: invitedEmail,
      role: "developer",
      status: "pending",
      expiresAt: invitationPage.items[0].expiresAt,
      inviterPrincipalId: principalId,
      createdAt: invitationPage.items[0].createdAt,
    });
    assertEquals(await (await get("/v1/me")).json(), identityBody);

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships
       set role = 'developer', updated_at = current_timestamp,
         version = version + 1
       where organization_id = $1 and principal_id = $2`,
      [organizationA, principalId],
    );
    const demoted = await get(
      `/v1/organizations/${organizationA}/effective-access`,
      organizationA,
    );
    assertEquals(demoted.status, 200);
    const demotedBody = await demoted.json() as {
      capabilities: string[];
    };
    assertEquals(demotedBody.capabilities.length, permissionCounts.developer);
    for (const key of ["organization:read", "task:read", "artifact:write"]) {
      assert(demotedBody.capabilities.includes(key));
    }
    assert(!demotedBody.capabilities.includes("organization:manage"));

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships
       set status = 'inactive', updated_at = current_timestamp,
         version = version + 1
       where organization_id = $1 and principal_id = $2`,
      [organizationB, principalId],
    );
    const deactivated = await get(
      `/v1/organizations/${organizationB}/effective-access`,
      organizationB,
    );
    assertEquals(deactivated.status, 404);
    assertEquals((await deactivated.json()).code, "RESOURCE_NOT_FOUND");
    const afterDeactivation = await get("/v1/organizations");
    assertEquals(afterDeactivation.status, 200);
    const currentOrganizations = await afterDeactivation.json() as Page;
    assertEquals(
      currentOrganizations.items.map((item) => item.id),
      [organizationA],
    );

    await fixture.pgDatabase.query(
      "update bakery.principals set disabled_at = current_timestamp where id = $1",
      [principalId],
    );
    const disabled = await get("/v1/me");
    assertEquals(disabled.status, 403);
    assertEquals((await disabled.json()).code, "AUTH_FORBIDDEN");
    const disabledEffectiveAccess = await get(
      `/v1/organizations/${organizationA}/effective-access`,
      organizationA,
    );
    assertEquals(disabledEffectiveAccess.status, 403);
    assertEquals(
      (await disabledEffectiveAccess.json()).code,
      "AUTH_FORBIDDEN",
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [adminEmail]);
    await fixture.close();
  }
});

Deno.test("authorized lifecycle mutations remain Better Auth compatible", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const founderEmail = `phase5-founder-${suffix}@example.test`;
  const memberEmail = `phase5-member-${suffix}@example.test`;
  const canceledEmail = `phase5-canceled-${suffix}@example.test`;
  const deletedInviterEmail = `phase5-deleted-inviter-${suffix}@example.test`;
  const deletedRecipientEmail =
    `phase5-deleted-recipient-${suffix}@example.test`;
  const password = `Phase5-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, {
      email: founderEmail,
      displayName: "Phase 5 Founder",
      password,
    });
    const bootstrap = await createPostgresAuthPersistence(fixture.pgDatabase)
      .withBootstrapLock((transaction) => transaction.inspect());
    const organizationA = bootstrap.organizations[0].id;
    const founderPrincipal = await fixture.pgDatabase.query<{ id: string }>(
      `select principal.id
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [founderEmail],
    );
    const founderInstallationGrant = async () =>
      (await fixture.pgDatabase.query(
        `select principal_id, granted_by_principal_id, created_at,
                revoked_at, version, updated_at
         from bakery.installation_administrators where principal_id = $1`,
        [founderPrincipal.rows[0].id],
      )).rows;
    const bootstrapGrant = await founderInstallationGrant();
    assertEquals(bootstrapGrant.length, 1);
    assertEquals(
      bootstrapGrant[0].granted_by_principal_id,
      founderPrincipal.rows[0].id,
    );
    assertEquals(bootstrapGrant[0].revoked_at, null);
    const founderSignIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email: founderEmail, password },
    ));
    assertEquals(founderSignIn.status, 200);
    const founderCookie = sessionCookie(founderSignIn);
    const bakeryRequest = (
      cookie: string,
      method: string,
      path: string,
      organizationId?: string,
      body?: unknown,
      ifMatch?: string,
      idempotencyKey?: string,
    ) => {
      const headers = new Headers({ cookie, origin: authTestOrigin });
      if (organizationId) {
        headers.set("Bakery-Organization-Id", organizationId);
      }
      if (body !== undefined) headers.set("content-type", "application/json");
      if (ifMatch !== undefined) headers.set("If-Match", ifMatch);
      if (idempotencyKey !== undefined) {
        headers.set("Idempotency-Key", idempotencyKey);
      }
      return fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    };

    const created = await bakeryRequest(
      founderCookie,
      "POST",
      "/v1/organizations",
      undefined,
      { name: "Phase 5 Team", slug: `phase5-${suffix}` },
    );
    assertEquals(created.status, 201, await created.clone().text());
    const organizationB = await created.json();
    assertEquals(organizationB.name, "Phase 5 Team");
    assertEquals(organizationB.metadata, {});
    assertEquals(organizationB.version, 1);
    const secondCreated = await bakeryRequest(
      founderCookie,
      "POST",
      "/v1/organizations",
      undefined,
      { name: "Phase 5 Second Team", slug: `phase5-second-${suffix}` },
    );
    assertEquals(secondCreated.status, 201, await secondCreated.clone().text());
    const organizationC = await secondCreated.json();
    assertEquals(organizationC.name, "Phase 5 Second Team");
    assertEquals(organizationC.metadata, {});
    assertEquals(organizationC.version, 1);
    const thirdCreated = await bakeryRequest(
      founderCookie,
      "POST",
      "/v1/organizations",
      undefined,
      { name: "Phase 5 Third Team", slug: `phase5-third-${suffix}` },
    );
    assertEquals(thirdCreated.status, 201, await thirdCreated.clone().text());
    const organizationD = await thirdCreated.json();
    assertEquals(organizationD.name, "Phase 5 Third Team");
    assertEquals(organizationD.metadata, {});
    assertEquals(organizationD.version, 1);
    const fourthCreated = await bakeryRequest(
      founderCookie,
      "POST",
      "/v1/organizations",
      undefined,
      { name: "Phase 5 Reject Team", slug: `phase5-reject-${suffix}` },
    );
    assertEquals(fourthCreated.status, 201, await fourthCreated.clone().text());
    const organizationE = await fourthCreated.json();
    assertEquals(organizationE.name, "Phase 5 Reject Team");
    assertEquals(organizationE.metadata, {});
    assertEquals(organizationE.version, 1);
    assertEquals(await founderInstallationGrant(), bootstrapGrant);

    const duplicate = await bakeryRequest(
      founderCookie,
      "POST",
      "/v1/organizations",
      undefined,
      { name: "Duplicate", slug: `phase5-${suffix}` },
    );
    assertEquals(duplicate.status, 409);
    assertEquals((await duplicate.json()).code, "STATE_CONFLICT");

    const updated = await bakeryRequest(
      founderCookie,
      "PATCH",
      `/v1/organizations/${organizationB.id}`,
      organizationB.id,
      { name: "Phase 5 Updated", metadata: { tier: "team" } },
      `"v${organizationB.version}"`,
      `phase5-update-${suffix}`,
    );
    assertEquals(updated.status, 200, await updated.clone().text());
    assertEquals((await updated.json()).metadata, { tier: "team" });

    const createInvitation = (organizationId: string, email: string) =>
      bakeryRequest(
        founderCookie,
        "POST",
        `/v1/organizations/${organizationId}/invitations`,
        organizationId,
        { email, role: "developer" },
      );
    const invitationResponse = await createInvitation(
      organizationB.id,
      `  ${memberEmail.toUpperCase()}  `,
    );
    assertEquals(
      invitationResponse.status,
      201,
      await invitationResponse.clone().text(),
    );
    const invitation = await invitationResponse.json();
    assertEquals(invitation.email, memberEmail);
    assertEquals(invitation.role, "developer");
    assertEquals(invitation.organizationId, organizationB.id);
    assertEquals(invitation.inviterPrincipalId, founderPrincipal.rows[0].id);
    const secondInvitationResponse = await createInvitation(
      organizationC.id,
      memberEmail,
    );
    assertEquals(
      secondInvitationResponse.status,
      201,
      await secondInvitationResponse.clone().text(),
    );
    const secondInvitation = await secondInvitationResponse.json();
    assertEquals(secondInvitation.email, memberEmail);
    assertEquals(secondInvitation.organizationId, organizationC.id);
    const explicitInvitationResponse = await createInvitation(
      organizationD.id,
      memberEmail,
    );
    assertEquals(
      explicitInvitationResponse.status,
      201,
      await explicitInvitationResponse.clone().text(),
    );
    const explicitInvitation = await explicitInvitationResponse.json();
    assertEquals(explicitInvitation.email, memberEmail);
    assertEquals(explicitInvitation.organizationId, organizationD.id);

    const expiredEmail = `expired-${suffix}@example.test`;
    await fixture.pgDatabase.query(
      `insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id,
        created_at, updated_at, version
      ) values ($1, $2, $3, 'developer', 'pending',
        current_timestamp - interval '1 second', $4,
        (select id from bakery.organization_memberships
         where organization_id = $2 and principal_id = $4),
        current_timestamp, current_timestamp, 1)`,
      [
        crypto.randomUUID(),
        organizationB.id,
        expiredEmail,
        founderPrincipal.rows[0].id,
      ],
    );
    const replacementResponse = await createInvitation(
      organizationB.id,
      expiredEmail,
    );
    assertEquals(
      replacementResponse.status,
      201,
      await replacementResponse.clone().text(),
    );
    const canceledResponse = await createInvitation(
      organizationB.id,
      canceledEmail,
    );
    assertEquals(canceledResponse.status, 201);
    const canceledInvitation = await canceledResponse.json();
    const replayKey = `cancel-${suffix}`;
    const canceled = await bakeryRequest(
      founderCookie,
      "DELETE",
      `/v1/organizations/${organizationB.id}/invitations/${canceledInvitation.id}`,
      organizationB.id,
      undefined,
      '"1"',
      replayKey,
    );
    assertEquals(canceled.status, 204);
    const replayedCancel = await bakeryRequest(
      founderCookie,
      "DELETE",
      `/v1/organizations/${organizationB.id}/invitations/${canceledInvitation.id}`,
      organizationB.id,
      undefined,
      '"1"',
      replayKey,
    );
    assertEquals(replayedCancel.status, 204);
    assertEquals(replayedCancel.headers.get("Idempotent-Replayed"), "true");
    const mismatchedCancel = await bakeryRequest(
      founderCookie,
      "DELETE",
      `/v1/organizations/${organizationB.id}/invitations/${canceledInvitation.id}`,
      organizationB.id,
      undefined,
      '"2"',
      replayKey,
    );
    assertEquals(mismatchedCancel.status, 422);
    assertEquals(
      (await mismatchedCancel.json()).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const malformedCancel = await bakeryRequest(
      founderCookie,
      "DELETE",
      `/v1/organizations/${organizationB.id}/invitations/${canceledInvitation.id}`,
      organizationB.id,
      undefined,
      undefined,
      " ",
    );
    assertEquals(malformedCancel.status, 428);
    assertEquals(
      (await malformedCancel.json()).code,
      "PRECONDITION_REQUIRED",
    );

    const staleDifferentKey = await bakeryRequest(
      founderCookie,
      "DELETE",
      `/v1/organizations/${organizationB.id}/invitations/${canceledInvitation.id}`,
      organizationB.id,
      undefined,
      '"1"',
      `cancel-stale-${suffix}`,
    );
    assertEquals(
      staleDifferentKey.status,
      412,
      await staleDifferentKey.clone().text(),
    );
    assertEquals(
      (await staleDifferentKey.json()).code,
      "PRECONDITION_FAILED",
    );
    assertEquals(
      (await fixture.pgDatabase.query<
        { status: string; version: number }
      >(
        "select status, version from bakery.organization_invitations where id = $1",
        [canceledInvitation.id],
      )).rows[0],
      { status: "canceled", version: 2 },
    );
    const cancelInFlightKey = `cancel-flight-${suffix}`;
    const cancelLockHolder = await fixture.pgDatabase.connect();
    try {
      await cancelLockHolder.query("begin");
      await cancelLockHolder.query(
        `select pg_advisory_xact_lock(
          hashtextextended($1::text, 0)
        )`,
        [idempotencyLockKey({
          scope: "organization",
          organizationId: organizationB.id,
          principalId: founderPrincipal.rows[0].id,
          operation: "organizationInvitations.cancel",
          key: cancelInFlightKey,
        })],
      );
      const cancelInFlight = await bakeryRequest(
        founderCookie,
        "DELETE",
        `/v1/organizations/${organizationB.id}/invitations/${canceledInvitation.id}`,
        organizationB.id,
        undefined,
        undefined,
        cancelInFlightKey,
      );
      assertEquals(cancelInFlight.status, 409);
      assertEquals(
        (await cancelInFlight.json()).code,
        "IDEMPOTENCY_IN_FLIGHT",
      );
    } finally {
      await cancelLockHolder.query("rollback").catch(() => undefined);
      cancelLockHolder.release();
    }

    const signUp = await fixture.auth.handler(authRequest(
      "/api/auth/sign-up/email",
      { email: memberEmail, password, name: "Phase 5 Member" },
    ));
    assertEquals(signUp.status, 200, await signUp.clone().text());
    const memberSignIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email: memberEmail, password },
    ));
    assertEquals(memberSignIn.status, 200);
    const memberCookie = sessionCookie(memberSignIn);
    const providerInvitation = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/api/auth/organization/get-invitation?id=${invitation.id}`,
        { headers: { cookie: memberCookie, origin: authTestOrigin } },
      ),
    );
    assertEquals(providerInvitation.status, 200);
    assertEquals(providerInvitation.headers.get("cache-control"), "no-store");
    assertEquals((await providerInvitation.json()).id, invitation.id);
    const absentProviderInvitation = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/api/auth/organization/get-invitation?id=${crypto.randomUUID()}`,
        { headers: { cookie: memberCookie, origin: authTestOrigin } },
      ),
    );
    const foreignProviderInvitation = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/api/auth/organization/get-invitation?id=${invitation.id}`,
        { headers: { cookie: founderCookie, origin: authTestOrigin } },
      ),
    );
    assertEquals(absentProviderInvitation.status, 404);
    assertEquals(foreignProviderInvitation.status, 404);
    assertEquals(
      stableProblem(await absentProviderInvitation.json()),
      stableProblem(await foreignProviderInvitation.json()),
    );
    assertEquals(
      absentProviderInvitation.headers.get("cache-control"),
      "no-store",
    );
    assertEquals(
      foreignProviderInvitation.headers.get("cache-control"),
      "no-store",
    );
    for (
      const path of [
        "/api/auth/organization/accept-invitation",
        "/api/auth/organization/reject-invitation",
      ]
    ) {
      const absent = await fixture.app.fetch(authRequest(
        path,
        { invitationId: crypto.randomUUID() },
        { cookie: memberCookie },
      ));
      const foreign = await fixture.app.fetch(authRequest(
        path,
        { invitationId: invitation.id },
        { cookie: founderCookie },
      ));
      assertEquals(absent.status, 404, path);
      assertEquals(foreign.status, 404, path);
      assertEquals(
        stableProblem(await absent.clone().json()),
        stableProblem(await foreign.clone().json()),
        path,
      );
      assertEquals(absent.headers.get("cache-control"), "no-store", path);
      assertEquals(foreign.headers.get("cache-control"), "no-store", path);
    }
    const accepted = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: invitation.id },
      { cookie: memberCookie },
    ));
    assertEquals(accepted.status, 200, await accepted.clone().text());
    assertEquals((await accepted.json()).invitation.status, "accepted");
    const replayedAccepted = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: invitation.id },
      { cookie: memberCookie },
    ));
    assertEquals(replayedAccepted.status, 200);
    assertEquals(
      replayedAccepted.headers.get("Idempotent-Replayed"),
      "true",
    );
    const secondAccepted = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: secondInvitation.id },
      { cookie: memberCookie },
    ));
    assertEquals(
      secondAccepted.status,
      200,
      await secondAccepted.clone().text(),
    );
    assertEquals((await secondAccepted.json()).invitation.status, "accepted");
    const replayedSecondAccepted = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: secondInvitation.id },
      { cookie: memberCookie },
    ));
    assertEquals(replayedSecondAccepted.status, 200);
    assertEquals(
      replayedSecondAccepted.headers.get("Idempotent-Replayed"),
      "true",
    );
    const explicitAcceptKey = `recipient-accept-${suffix}`;
    const malformedRecipientKey = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: explicitInvitation.id },
      {
        cookie: memberCookie,
        headers: { "Idempotency-Key": " " },
      },
    ));
    assertEquals(malformedRecipientKey.status, 428);
    assertEquals(
      (await malformedRecipientKey.json()).code,
      "PRECONDITION_REQUIRED",
    );
    const explicitAccepted = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: explicitInvitation.id },
      {
        cookie: memberCookie,
        headers: { "Idempotency-Key": explicitAcceptKey },
      },
    ));
    assertEquals(explicitAccepted.status, 200);
    assertEquals((await explicitAccepted.json()).invitation.status, "accepted");
    const explicitReplay = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: explicitInvitation.id },
      {
        cookie: memberCookie,
        headers: { "Idempotency-Key": explicitAcceptKey },
      },
    ));
    assertEquals(explicitReplay.status, 200);
    assertEquals(explicitReplay.headers.get("Idempotent-Replayed"), "true");
    const explicitMismatch = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: crypto.randomUUID() },
      {
        cookie: memberCookie,
        headers: { "Idempotency-Key": explicitAcceptKey },
      },
    ));
    assertEquals(explicitMismatch.status, 422);
    assertEquals(
      (await explicitMismatch.json()).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    const rejectInvitationResponse = await createInvitation(
      organizationE.id,
      memberEmail,
    );
    assertEquals(rejectInvitationResponse.status, 201);
    const rejectInvitation = await rejectInvitationResponse.json();
    const malformedRejectKey = await fixture.app.fetch(authRequest(
      "/api/auth/organization/reject-invitation",
      { invitationId: rejectInvitation.id },
      {
        cookie: memberCookie,
        headers: { "Idempotency-Key": " " },
      },
    ));
    assertEquals(malformedRejectKey.status, 428);
    assertEquals(
      (await malformedRejectKey.json()).code,
      "PRECONDITION_REQUIRED",
    );
    const explicitRejectKey = `recipient-reject-${suffix}`;
    const rejected = await fixture.app.fetch(authRequest(
      "/api/auth/organization/reject-invitation",
      { invitationId: rejectInvitation.id },
      {
        cookie: memberCookie,
        headers: { "Idempotency-Key": explicitRejectKey },
      },
    ));
    assertEquals(rejected.status, 200);
    assertEquals((await rejected.json()).invitation.status, "rejected");
    const replayedReject = await fixture.app.fetch(authRequest(
      "/api/auth/organization/reject-invitation",
      { invitationId: rejectInvitation.id },
      {
        cookie: memberCookie,
        headers: { "Idempotency-Key": explicitRejectKey },
      },
    ));
    assertEquals(replayedReject.status, 200);
    assertEquals(replayedReject.headers.get("Idempotent-Replayed"), "true");
    const mismatchedReject = await fixture.app.fetch(authRequest(
      "/api/auth/organization/reject-invitation",
      { invitationId: crypto.randomUUID() },
      {
        cookie: memberCookie,
        headers: { "Idempotency-Key": explicitRejectKey },
      },
    ));
    assertEquals(mismatchedReject.status, 422);
    assertEquals(
      (await mismatchedReject.json()).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );

    const providerSession = await fixture.auth.handler(
      new Request(`${authTestOrigin}/api/auth/get-session`, {
        headers: { cookie: memberCookie, origin: authTestOrigin },
      }),
    );
    assertEquals(providerSession.status, 200);
    assertEquals((await providerSession.json()).user.email, memberEmail);

    const memberPrincipal = await fixture.pgDatabase.query<{ id: string }>(
      `select principal.id
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [memberEmail],
    );
    const acceptInFlightKey = `recipient-accept-flight-${suffix}`;
    const acceptLockHolder = await fixture.pgDatabase.connect();
    try {
      await acceptLockHolder.query("begin");
      await acceptLockHolder.query(
        `select pg_advisory_xact_lock(
          hashtextextended($1::text, 0)
        )`,
        [idempotencyLockKey({
          scope: "installation",
          organizationId: null,
          principalId: memberPrincipal.rows[0].id,
          operation: "organizationInvitations.recipientAccept",
          key: acceptInFlightKey,
        })],
      );
      const acceptInFlight = await fixture.app.fetch(authRequest(
        "/api/auth/organization/accept-invitation",
        { invitationId: crypto.randomUUID() },
        {
          cookie: memberCookie,
          headers: { "Idempotency-Key": acceptInFlightKey },
        },
      ));
      assertEquals(acceptInFlight.status, 409);
      assertEquals(
        (await acceptInFlight.json()).code,
        "IDEMPOTENCY_IN_FLIGHT",
      );
    } finally {
      await acceptLockHolder.query("rollback").catch(() => undefined);
      acceptLockHolder.release();
    }
    const rejectInFlightKey = `recipient-reject-flight-${suffix}`;
    const rejectLockHolder = await fixture.pgDatabase.connect();
    try {
      await rejectLockHolder.query("begin");
      await rejectLockHolder.query(
        `select pg_advisory_xact_lock(
          hashtextextended($1::text, 0)
        )`,
        [idempotencyLockKey({
          scope: "installation",
          organizationId: null,
          principalId: memberPrincipal.rows[0].id,
          operation: "organizationInvitations.recipientReject",
          key: rejectInFlightKey,
        })],
      );
      const rejectInFlight = await fixture.app.fetch(authRequest(
        "/api/auth/organization/reject-invitation",
        { invitationId: crypto.randomUUID() },
        {
          cookie: memberCookie,
          headers: { "Idempotency-Key": rejectInFlightKey },
        },
      ));
      assertEquals(rejectInFlight.status, 409);
      assertEquals(
        (await rejectInFlight.json()).code,
        "IDEMPOTENCY_IN_FLIGHT",
      );
    } finally {
      await rejectLockHolder.query("rollback").catch(() => undefined);
      rejectLockHolder.release();
    }
    const acceptedMembership = await fixture.pgDatabase.query<{
      id: string;
      status: string;
      joinedAt: Date;
      updatedAt: Date;
      version: number;
    }>(
      `select membership.id, membership.status,
        membership.joined_at as "joinedAt",
        membership.updated_at as "updatedAt", membership.version
       from bakery.organization_memberships as membership
       join bakery.principals as principal
         on principal.id = membership.principal_id
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where membership.organization_id = $1
         and provider_user.email = $2`,
      [organizationB.id, memberEmail],
    );
    assertEquals(acceptedMembership.rows[0].status, "active");
    assert(acceptedMembership.rows[0].joinedAt instanceof Date);
    assert(acceptedMembership.rows[0].updatedAt instanceof Date);
    assertEquals(acceptedMembership.rows[0].version, 1);

    const changeMembership = (
      cookie: string,
      membershipId: string,
      body: Record<string, string>,
    ) =>
      bakeryRequest(
        cookie,
        "PATCH",
        `/v1/organizations/${organizationB.id}/memberships/${membershipId}`,
        organizationB.id,
        body,
      );
    const promoted = await changeMembership(
      founderCookie,
      acceptedMembership.rows[0].id,
      { role: "admin" },
    );
    assertEquals(promoted.status, 200, await promoted.clone().text());
    assertEquals((await promoted.json()).version, 2);
    assertEquals(
      (await changeMembership(
        founderCookie,
        acceptedMembership.rows[0].id,
        { status: "inactive" },
      )).status,
      200,
    );
    assertEquals(
      (await changeMembership(
        founderCookie,
        acceptedMembership.rows[0].id,
        { status: "active" },
      )).status,
      200,
    );
    assertEquals(
      (await bakeryRequest(
        founderCookie,
        "DELETE",
        `/v1/organizations/${organizationB.id}/memberships/${
          acceptedMembership.rows[0].id
        }`,
        organizationB.id,
      )).status,
      204,
    );
    const recreated = await bakeryRequest(
      founderCookie,
      "POST",
      `/v1/organizations/${organizationB.id}/memberships`,
      organizationB.id,
      { principalId: memberPrincipal.rows[0].id, role: "developer" },
    );
    assertEquals(recreated.status, 201, await recreated.clone().text());
    const recreatedMembership = await recreated.json();
    assertEquals(recreatedMembership.version, 1);
    assertEquals(
      (await changeMembership(
        founderCookie,
        recreatedMembership.id,
        { role: "admin" },
      )).status,
      200,
    );

    const founderMembership = await fixture.pgDatabase.query<{ id: string }>(
      `select membership.id
       from bakery.organization_memberships as membership
       join bakery.principals as principal
         on principal.id = membership.principal_id
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where membership.organization_id = $1
         and provider_user.email = $2`,
      [organizationB.id, founderEmail],
    );
    assertEquals(
      (await changeMembership(
        memberCookie,
        founderMembership.rows[0].id,
        { role: "developer" },
      )).status,
      200,
    );
    const developerDenied = await bakeryRequest(
      founderCookie,
      "POST",
      `/v1/organizations/${organizationB.id}/invitations`,
      organizationB.id,
      { email: `denied-${suffix}@example.test`, role: "developer" },
    );
    assertEquals(developerDenied.status, 403);
    assertEquals((await developerDenied.json()).code, "AUTH_FORBIDDEN");
    assertEquals(
      (await changeMembership(
        memberCookie,
        founderMembership.rows[0].id,
        { role: "admin" },
      )).status,
      200,
    );

    const [demotion, deactivation, removal] = await Promise.all([
      changeMembership(
        founderCookie,
        founderMembership.rows[0].id,
        { role: "developer" },
      ),
      changeMembership(
        founderCookie,
        founderMembership.rows[0].id,
        { status: "inactive" },
      ),
      bakeryRequest(
        memberCookie,
        "DELETE",
        `/v1/organizations/${organizationB.id}/memberships/${recreatedMembership.id}`,
        organizationB.id,
      ),
    ]);
    const successful = [demotion.status, deactivation.status, removal.status]
      .filter((status) => status >= 200 && status < 300);
    assertEquals(successful.length, 1);
    const remaining = await fixture.pgDatabase.query<{
      id: string;
      role: string;
      status: string;
    }>(
      `select id, role, status
       from bakery.organization_memberships
       where organization_id = $1
       order by id`,
      [organizationB.id],
    );
    assertEquals(
      remaining.rows.filter(({ role, status }) =>
        role === "admin" && status === "active"
      ).length,
      1,
    );
    if (demotion.status === 200 || deactivation.status === 200) {
      assert(remaining.rows.some(({ id }) => id === recreatedMembership.id));
    } else {
      assert(
        remaining.rows.some(({ id, role, status }) =>
          id === founderMembership.rows[0].id && role === "admin" &&
          status === "active"
        ),
      );
    }

    await migrateProvider(
      fixture.pgDatabase,
      await loadMigrations(betterAuthMigrationSource),
    );
    await migrate(fixture.database, [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ]);
    assertEquals(
      (await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::int as count
         from bakery.organization_memberships
         where organization_id = $1
           and status = 'active'`,
        [organizationA],
      )).rows[0].count,
      1,
    );

    const deletedInviterId = crypto.randomUUID();
    const deletedInviterPrincipalId = crypto.randomUUID();
    const deletedInvitationId = crypto.randomUUID();
    const deletedInviterMembershipId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values ($1, 'Deleted Inviter', $2, true, current_timestamp,
        current_timestamp)`,
      [deletedInviterId, deletedInviterEmail],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values ($1, $2, 'Deleted Inviter', 'human')`,
      [deletedInviterPrincipalId, deletedInviterId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status,
        joined_at, created_at, updated_at, version
      ) values ($1, $2, $3, 'admin', 'active', current_timestamp,
        current_timestamp, current_timestamp, 1)`,
      [deletedInviterMembershipId, organizationB.id, deletedInviterPrincipalId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id,
        created_at, updated_at, version
      ) values ($1, $2, $3, 'developer', 'pending',
        current_timestamp + interval '1 hour', $4, $5,
        current_timestamp, current_timestamp, 1)`,
      [
        deletedInvitationId,
        organizationB.id,
        deletedRecipientEmail,
        deletedInviterPrincipalId,
        deletedInviterMembershipId,
      ],
    );
    const remainingAdmin = await fixture.pgDatabase.query<{ email: string }>(
      `select provider_user.email
       from bakery.organization_memberships as membership
       join bakery.principals as principal
         on principal.id = membership.principal_id
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where membership.organization_id = $1
         and membership.role = 'admin'
         and membership.status = 'active'
       limit 1`,
      [organizationB.id],
    );
    const remainingAdminCookie = remainingAdmin.rows[0].email === founderEmail
      ? founderCookie
      : memberCookie;
    const deletedInviterMembership = await bakeryRequest(
      remainingAdminCookie,
      "DELETE",
      `/v1/organizations/${organizationB.id}/memberships/${deletedInviterMembershipId}`,
      organizationB.id,
    );
    assertEquals(
      deletedInviterMembership.status,
      204,
      await deletedInviterMembership.clone().text(),
    );
    const invitationAfterRemoval = await fixture.pgDatabase.query<{
      status: string;
      inviterPrincipalId: string | null;
      inviterMembershipId: string | null;
    }>(
      `select status, inviter_principal_id as "inviterPrincipalId",
        inviter_membership_id as "inviterMembershipId"
       from bakery.organization_invitations
       where organization_id = $1 and id = $2`,
      [organizationB.id, deletedInvitationId],
    );
    assertEquals(invitationAfterRemoval.rows, [{
      status: "pending",
      inviterPrincipalId: deletedInviterPrincipalId,
      inviterMembershipId: null,
    }]);
    assertEquals(
      (await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::int as count
         from bakery.organization_memberships
         where organization_id = $1 and id = $2`,
        [organizationB.id, deletedInviterMembershipId],
      )).rows[0].count,
      0,
    );
    const deletedRecipientSignUp = await fixture.auth.handler(authRequest(
      "/api/auth/sign-up/email",
      {
        email: deletedRecipientEmail,
        password,
        name: "Deleted Inviter Recipient",
      },
    ));
    assertEquals(
      deletedRecipientSignUp.status,
      200,
      await deletedRecipientSignUp.clone().text(),
    );
    const deletedRecipientSignIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email: deletedRecipientEmail, password },
    ));
    assertEquals(deletedRecipientSignIn.status, 200);
    const deletedRecipientCookie = sessionCookie(deletedRecipientSignIn);
    const deletedInviterInvitation = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/api/auth/organization/get-invitation?id=${deletedInvitationId}`,
        {
          headers: {
            cookie: deletedRecipientCookie,
            origin: authTestOrigin,
          },
        },
      ),
    );
    assertEquals(
      deletedInviterInvitation.status,
      200,
      await deletedInviterInvitation.clone().text(),
    );
    assertEquals(
      deletedInviterInvitation.headers.get("cache-control"),
      "no-store",
    );
    assertEquals(
      (await deletedInviterInvitation.json()).inviterId,
      deletedInviterId,
    );
    const acceptedAfterInviterDeletion = await fixture.app.fetch(
      authRequest(
        "/api/auth/organization/accept-invitation",
        { invitationId: deletedInvitationId },
        { cookie: deletedRecipientCookie },
      ),
    );
    assertEquals(
      acceptedAfterInviterDeletion.status,
      200,
      await acceptedAfterInviterDeletion.clone().text(),
    );
    assertEquals(
      (await acceptedAfterInviterDeletion.json()).invitation.status,
      "accepted",
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [
      founderEmail,
      memberEmail,
      canceledEmail,
      `denied-${suffix}@example.test`,
      deletedInviterEmail,
      deletedRecipientEmail,
    ]);
    await fixture.close();
  }
});

Deno.test("non-owner transactions isolate grants, clean one pooled connection, and enforce composite ownership", async () => {
  const fixture = await openAuthFixture();
  const { appDatabaseUrl, adminDatabaseUrl } = readTestDatabaseConfig(
    Deno.env.toObject(),
    { requireAdmin: true },
  );
  const runtime = openPgDatabase(appDatabaseUrl, 1);
  const administrator = openPgDatabase(adminDatabaseUrl, 1);
  const organizationA = crypto.randomUUID();
  const organizationB = crypto.randomUUID();
  const providerAdmin = crypto.randomUUID();
  const providerDeveloper = crypto.randomUUID();
  const adminPrincipalId = asPrincipalId(crypto.randomUUID());
  const developerPrincipalId = asPrincipalId(crypto.randomUUID());
  const servicePrincipalId = asPrincipalId(crypto.randomUUID());
  const adminMembershipA = crypto.randomUUID();
  const adminMembershipB = crypto.randomUUID();
  const developerMembershipB = crypto.randomUUID();
  const invitationA = crypto.randomUUID();
  const invitationCrossTenant = crypto.randomUUID();
  const suffix = crypto.randomUUID();
  const admin: AuthenticatedSubject = {
    principalId: adminPrincipalId,
    principalType: PrincipalType.Human,
    displayName: "Phase 6 Admin",
  };
  const developer: AuthenticatedSubject = {
    principalId: developerPrincipalId,
    principalType: PrincipalType.Human,
    displayName: "Phase 6 Developer",
  };
  const service: AuthenticatedSubject = {
    principalId: servicePrincipalId,
    principalType: PrincipalType.Service,
    displayName: "Phase 6 Service",
  };
  const context = (
    subject: AuthenticatedSubject,
    organizationId: string,
    signal: AbortSignal = new AbortController().signal,
  ) => ({
    request: new Request(
      `${authTestOrigin}/v1/organizations/${organizationId}/phase-6`,
      { headers: { "Bakery-Organization-Id": organizationId } },
    ),
    params: { id: organizationId },
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal,
    principal: subject,
  });
  const expectStandardError = async (
    work: () => Promise<unknown>,
    code: string,
  ) => {
    let caught: unknown;
    try {
      await work();
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof StandardError);
    assertEquals(caught.code, code);
  };
  const expectPostgresError = async (
    work: () => Promise<unknown>,
    code: string,
  ) => {
    let caught: unknown;
    try {
      await work();
    } catch (error) {
      caught = error;
    }
    assert(caught && typeof caught === "object" && "code" in caught);
    assertEquals((caught as { code: string }).code, code);
  };

  try {
    const now = new Date();
    await fixture.pgDatabase.query(
      `create table bakery.test_persisted_probe (
        id uuid primary key,
        organization_id uuid not null,
        value text not null
      )`,
    );
    await fixture.pgDatabase.query(
      "grant select, insert on bakery.test_persisted_probe to bakery_app",
    );
    await fixture.pgDatabase.query(
      `insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values
        ($1, 'Phase 6 Admin', $2, true, $5, $5),
        ($3, 'Phase 6 Developer', $4, true, $5, $5)`,
      [
        providerAdmin,
        `phase6-admin-${suffix}@example.test`,
        providerDeveloper,
        `phase6-developer-${suffix}@example.test`,
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values
        ($1, $2, 'Phase 6 Admin', 'human'),
        ($3, $4, 'Phase 6 Developer', 'human'),
        ($5, null, 'Phase 6 Service', 'service')`,
      [
        adminPrincipalId,
        providerAdmin,
        developerPrincipalId,
        providerDeveloper,
        servicePrincipalId,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into public.organization (
        id, name, slug, "createdAt", "updatedAt"
      ) values
        ($1, 'Phase 6 A', $2, $5, $5),
        ($3, 'Phase 6 B', $4, $5, $5)`,
      [
        organizationA,
        `phase6-a-${suffix}`,
        organizationB,
        `phase6-b-${suffix}`,
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at
      ) values
        ($1, 'Phase 6 A', $2, '{}'::jsonb, $5, $5),
        ($3, 'Phase 6 B', $4, '{}'::jsonb, $5, $5)`,
      [
        organizationA,
        `phase6-a-${suffix}`,
        organizationB,
        `phase6-b-${suffix}`,
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into public.member (
        id, "organizationId", "userId", role, status,
        "createdAt", "joinedAt", "updatedAt"
      ) values
        ($1, $2, $3, 'admin', 'active', $8, $8, $8),
        ($4, $5, $3, 'admin', 'active', $8, $8, $8),
        ($6, $5, $7, 'developer', 'active', $8, $8, $8)`,
      [
        adminMembershipA,
        organizationA,
        providerAdmin,
        adminMembershipB,
        organizationB,
        developerMembershipB,
        providerDeveloper,
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at
      ) values
        ($1, $2, $3, 'admin', 'active', $7, $7, $7),
        ($4, $5, $3, 'admin', 'active', $7, $7, $7),
        ($6, $5, $8, 'developer', 'active', $7, $7, $7)`,
      [
        adminMembershipA,
        organizationA,
        adminPrincipalId,
        adminMembershipB,
        organizationB,
        developerMembershipB,
        now,
        developerPrincipalId,
      ],
    );
    await administrator.query(
      `insert into bakery.permission_grants (
        organization_id, principal_id, capability,
        granted_by_principal_id
      ) values
        ($1, $4, 'organizations.get', $2),
        ($3, $4, 'organizations.effectiveAccess', $2),
        ($1, $4, 'permissionGrants.create', $2),
        ($3, $4, 'permissionGrants.create', $2),
        ($1, $4, 'permissionGrants.list', $2),
        ($3, $4, 'tasks.list', $2)`,
      [
        organizationA,
        adminPrincipalId,
        organizationB,
        servicePrincipalId,
      ],
    );
    await expectPostgresError(
      () =>
        administrator.query(
          `insert into bakery.installation_administrators (
            principal_id, granted_by_principal_id
          ) values ($1, $2)`,
          [servicePrincipalId, adminPrincipalId],
        ),
      "23503",
    );

    await fixture.pgDatabase.query(
      `insert into public.invitation (
        id, "organizationId", email, role, status,
        "expiresAt", "createdAt", "inviterId"
      ) values ($1, $2, $3, 'developer', 'pending', $4, $5, $6)`,
      [
        invitationA,
        organizationA,
        `phase6-valid-${suffix}@example.test`,
        new Date(now.getTime() + 60_000),
        now,
        providerAdmin,
      ],
    );
    await expectPostgresError(
      () =>
        fixture.pgDatabase.query(
          `insert into public.invitation (
            id, "organizationId", email, role, status,
            "expiresAt", "createdAt", "inviterId"
          ) values ($1, $2, $3, 'developer', 'pending', $4, $5, $6)`,
          [
            invitationCrossTenant,
            organizationA,
            `phase6-cross-${suffix}@example.test`,
            new Date(now.getTime() + 60_000),
            now,
            providerDeveloper,
          ],
        ),
      "23503",
    );
    assertEquals(
      (await runtime.query<{ count: number }>(
        `select count(*)::int as count from bakery.permission_grants
         where organization_id = $1`,
        [organizationA],
      )).rows[0].count,
      3,
    );

    const backendPids: number[] = [];
    const committedCapabilities: string[] = [];
    const committed = new ActionRegistry(new PostgresAuthorityRunner(runtime))
      .register({
        name: "permissionGrants.create",
        method: HttpMethod.Post,
        path: "/v1/organizations/:id/phase-6",
        input: contractSchemas.Empty,
        output: contractSchemas.NoContent,
        policy: {
          type: ActionKind.Command,
          access: ActionAccess.Admin,
          organizationContext:
            OrganizationContextPolicy.RequiredAuthenticatedContext,
        },
        handler: async (rawContext) => {
          const authorized = rawContext as AuthorizedActionContext;
          const organizationId = authorized.params.id;
          const expectedSeed = organizationId === organizationA
            ? "organizations.get"
            : "organizations.effectiveAccess";
          const capability = organizationId === organizationA
            ? "phase6.committed-a"
            : "phase6.committed-b";
          const state = await authorized.transaction.query<{
            backendPid: number;
          }>(`select pg_backend_pid() as "backendPid"`);
          backendPids.push(state.rows[0].backendPid);
          const visible = await authorized.transaction.query<{
            capability: string;
          }>(
            `select capability from bakery.permission_grants
             where organization_id = $1
             order by capability`,
            [organizationId],
          );
          assertEquals(
            visible.rows.map(({ capability }) => capability),
            organizationId === organizationA
              ? [
                expectedSeed,
                "permissionGrants.create",
                "permissionGrants.list",
              ]
              : [expectedSeed, "permissionGrants.create", "tasks.list"],
          );
          await authorized.transaction.query(
            `insert into bakery.test_persisted_probe (id, organization_id, value)
             values ($1, $2, $3)`,
            [crypto.randomUUID(), organizationId, capability],
          );
          committedCapabilities.push(capability);
          return null;
        },
      });
    await committed.execute(
      "permissionGrants.create",
      context(service, organizationA),
      {},
    );
    await committed.execute(
      "permissionGrants.create",
      context(service, organizationB),
      {},
    );
    assertEquals(backendPids.length, 2);
    assertEquals(backendPids[0], backendPids[1]);
    assertEquals(committedCapabilities, [
      "phase6.committed-a",
      "phase6.committed-b",
    ]);

    const outside = await runtime.query<{ backendPid: number }>(
      `select pg_backend_pid() as "backendPid"`,
    );
    assertEquals(outside.rows[0].backendPid, backendPids[0]);
    assertEquals(
      (await runtime.query<{ count: number }>(
        "select count(*)::int as count from pg_settings where name like 'app.%'",
      )).rows[0].count,
      0,
    );

    // The database no longer filters by session, so cross-organization
    // non-disclosure depends on callers supplying an explicit predicate.
    await withPgTransaction(runtime, async (transaction) => {
      assertEquals(
        (await transaction.query(
          `select 1 from bakery.permission_grants
           where organization_id = $1 and capability = 'tasks.list'`,
          [organizationA],
        )).rowCount,
        0,
      );
      assertEquals(
        (await transaction.query(
          `select 1 from bakery.permission_grants
           where organization_id = $1 and capability = 'organizations.get'`,
          [organizationA],
        )).rowCount,
        1,
      );
    });
    await withPgTransaction(runtime, async (transaction) => {
      assertEquals(
        (await transaction.query<{ capability: string }>(
          `select capability from bakery.permission_grants
           where organization_id = $1
           order by capability`,
          [organizationA],
        )).rows.map(({ capability }) => capability),
        [
          "organizations.get",
          "permissionGrants.create",
          "permissionGrants.list",
        ],
      );
      await transaction.query(
        `insert into bakery.permission_grants (
          organization_id, principal_id, capability, granted_by_principal_id
        ) values ($1, $2, 'permissionGrants.delete', $3)`,
        [organizationA, servicePrincipalId, adminPrincipalId],
      );
    });
    await administrator.query(
      `insert into bakery.permission_grants (
        organization_id, principal_id, capability, expires_at,
        granted_by_principal_id
      ) values ($1, $2, 'organizationInvitations.cancel',
        current_timestamp - interval '1 second', $3)`,
      [organizationA, servicePrincipalId, adminPrincipalId],
    );
    await withPgTransaction(runtime, async (transaction) => {
      await transaction.query(
        `insert into bakery.permission_grants (
          organization_id, principal_id, capability, expires_at,
          granted_by_principal_id
        ) values ($1, $2, 'organizationInvitations.cancel',
          current_timestamp + interval '1 minute', $3)`,
        [organizationA, servicePrincipalId, adminPrincipalId],
      );
    });
    assertEquals(
      (await administrator.query<{ count: string }>(
        `select count(*)::text as count from bakery.permission_grants
         where organization_id = $1 and principal_id = $2
           and capability = 'organizationInvitations.cancel'`,
        [organizationA, servicePrincipalId],
      )).rows[0].count,
      "2",
    );
    await expectPostgresError(
      () =>
        withPgTransaction(runtime, async (transaction) => {
          await transaction.query(
            `insert into bakery.permission_grants (
              organization_id, principal_id, capability, expires_at,
              granted_by_principal_id
            ) values ($1, $2, 'organizationInvitations.cancel',
              current_timestamp + interval '2 minutes', $3)`,
            [organizationA, servicePrincipalId, adminPrincipalId],
          );
        }),
      "23505",
    );
    await withPgTransaction(runtime, async (transaction) => {
      assertEquals(
        (await transaction.query<{ capability: string }>(
          `select capability from bakery.permission_grants
           where organization_id = $1 and principal_id = $2
           order by capability`,
          [organizationA, servicePrincipalId],
        )).rows.map(({ capability }) => capability),
        [
          "organizationInvitations.cancel",
          "organizationInvitations.cancel",
          "organizations.get",
          "permissionGrants.create",
          "permissionGrants.delete",
          "permissionGrants.list",
        ],
      );
    });
    await withPgTransaction(runtime, async (transaction) => {
      await transaction.query(
        `insert into bakery.permission_grants (
          organization_id, principal_id, capability,
          granted_by_principal_id
        ) values ($1, $2, 'organizationInvitations.create', $3)`,
        [organizationB, servicePrincipalId, adminPrincipalId],
      );
      assertEquals(
        (await transaction.query(
          `select 1 from bakery.permission_grants
           where organization_id = $1 and capability = 'organizationInvitations.create'`,
          [organizationA],
        )).rowCount,
        0,
      );
    });

    const abortController = new AbortController();
    const rolledBack = new ActionRegistry(new PostgresAuthorityRunner(runtime))
      .register({
        name: "organizations.update",
        method: HttpMethod.Post,
        path: "/v1/organizations/:id/phase-6",
        input: contractSchemas.Empty,
        output: contractSchemas.NoContent,
        policy: {
          type: ActionKind.Command,
          access: ActionAccess.Admin,
          organizationContext:
            OrganizationContextPolicy.RequiredAuthenticatedContext,
        },
        handler: async (rawContext) => {
          const authorized = rawContext as AuthorizedActionContext;
          await authorized.transaction.query(
            `insert into bakery.test_persisted_probe (id, organization_id, value)
             values ($1, $2, 'phase6.thrown')`,
            [crypto.randomUUID(), organizationA],
          );
          throw new Error("PHASE6_THROWN");
        },
      })
      .register({
        name: "organizationMemberships.create",
        method: HttpMethod.Post,
        path: "/v1/organizations/:id/phase-6-aborted",
        input: contractSchemas.Empty,
        output: contractSchemas.NoContent,
        policy: {
          type: ActionKind.Command,
          access: ActionAccess.Admin,
          organizationContext:
            OrganizationContextPolicy.RequiredAuthenticatedContext,
        },
        handler: async (rawContext) => {
          const authorized = rawContext as AuthorizedActionContext;
          await authorized.transaction.query(
            `insert into bakery.test_persisted_probe (id, organization_id, value)
             values ($1, $2, 'phase6.aborted')`,
            [crypto.randomUUID(), organizationA],
          );
          abortController.abort();
          return null;
        },
      });
    await assertRejects(
      () =>
        rolledBack.execute(
          "organizations.update",
          context(admin, organizationA),
          {},
        ),
      Error,
      "PHASE6_THROWN",
    );
    await assertRejects(
      () =>
        rolledBack.execute(
          "organizationMemberships.create",
          context(admin, organizationA, abortController.signal),
          {},
        ),
      DOMException,
      "Action aborted",
    );

    let unauthorizedHandlerCalls = 0;
    const adminOnly = new ActionRegistry(new PostgresAuthorityRunner(runtime))
      .register({
        name: "organizations.update",
        method: HttpMethod.Post,
        path: "/v1/organizations/:id/phase-6",
        input: contractSchemas.Empty,
        output: contractSchemas.NoContent,
        policy: {
          type: ActionKind.Command,
          access: ActionAccess.Admin,
          organizationContext:
            OrganizationContextPolicy.RequiredAuthenticatedContext,
        },
        handler: () => {
          unauthorizedHandlerCalls++;
          return null;
        },
      });
    await expectStandardError(
      () =>
        adminOnly.execute(
          "organizations.update",
          context(developer, organizationB),
          {},
        ),
      "AUTH_FORBIDDEN",
    );
    assertEquals(unauthorizedHandlerCalls, 0);

    let serviceHandlerCalls = 0;
    const serviceAction = new ActionRegistry(
      new PostgresAuthorityRunner(runtime),
    ).register({
      name: "permissionGrants.list",
      method: HttpMethod.Get,
      path: "/v1/organizations/:id/phase-6",
      input: contractSchemas.Empty,
      output: contractSchemas.NoContent,
      policy: {
        type: ActionKind.Query,
        access: ActionAccess.Developer,
        organizationContext:
          OrganizationContextPolicy.RequiredAuthenticatedContext,
      },
      handler: () => {
        serviceHandlerCalls++;
        return null;
      },
    });
    await serviceAction.execute(
      "permissionGrants.list",
      context(service, organizationA),
      {},
    );
    let secondOrganizationServiceHandlerCalls = 0;
    const secondOrganizationServiceAction = new ActionRegistry(
      new PostgresAuthorityRunner(runtime),
    ).register({
      name: "tasks.list",
      method: HttpMethod.Get,
      path: "/v1/organizations/:id/phase-6-role",
      input: contractSchemas.Empty,
      output: contractSchemas.NoContent,
      policy: {
        type: ActionKind.Query,
        access: ActionAccess.Developer,
        organizationContext:
          OrganizationContextPolicy.RequiredAuthenticatedContext,
      },
      handler: () => {
        secondOrganizationServiceHandlerCalls++;
        return null;
      },
    });
    await secondOrganizationServiceAction.execute(
      "tasks.list",
      context(service, organizationB),
      {},
    );
    assertEquals(secondOrganizationServiceHandlerCalls, 1);
    await expectStandardError(
      () =>
        secondOrganizationServiceAction.execute(
          "tasks.list",
          context(service, organizationA),
          {},
        ),
      "RESOURCE_NOT_FOUND",
    );
    await administrator.query(
      `insert into bakery.permission_grants (
        organization_id, principal_id, capability, granted_by_principal_id,
        policy_revision
      ) values ($1, $2, 'organizationMemberships.update', $3, 2)`,
      [organizationA, servicePrincipalId, adminPrincipalId],
    );
    let stalePolicyHandlerCalls = 0;
    const stalePolicyAction = new ActionRegistry(
      new PostgresAuthorityRunner(runtime),
    ).register({
      name: "organizationMemberships.update",
      method: HttpMethod.Get,
      path: "/v1/organizations/:id/phase-6-stale-policy",
      input: contractSchemas.Empty,
      output: contractSchemas.NoContent,
      policy: {
        type: ActionKind.Query,
        access: ActionAccess.Developer,
        organizationContext:
          OrganizationContextPolicy.RequiredAuthenticatedContext,
      },
      handler: () => {
        stalePolicyHandlerCalls++;
        return null;
      },
    });
    await expectStandardError(
      () =>
        stalePolicyAction.execute(
          "organizationMemberships.update",
          context(service, organizationA),
          {},
        ),
      "AUTH_FORBIDDEN",
    );
    assertEquals(stalePolicyHandlerCalls, 0);
    await administrator.query(
      `update bakery.permission_grants
       set expires_at = current_timestamp - interval '1 second'
       where organization_id = $1 and principal_id = $2
         and capability = 'permissionGrants.list'`,
      [organizationA, servicePrincipalId],
    );
    await expectStandardError(
      () =>
        serviceAction.execute(
          "permissionGrants.list",
          context(service, organizationA),
          {},
        ),
      "RESOURCE_NOT_FOUND",
    );
    await administrator.query(
      `update bakery.permission_grants
       set expires_at = null, revoked_at = current_timestamp
       where organization_id = $1 and principal_id = $2
         and capability = 'permissionGrants.list'`,
      [organizationA, servicePrincipalId],
    );
    await expectStandardError(
      () =>
        serviceAction.execute(
          "permissionGrants.list",
          context(service, organizationA),
          {},
        ),
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(serviceHandlerCalls, 1);

    await administrator.query(
      `insert into bakery.permission_grants (
        organization_id, principal_id, capability, granted_by_principal_id
      ) values ($1, $2, 'organizations.update', $3)`,
      [organizationA, servicePrincipalId, adminPrincipalId],
    );
    const serviceStore = new PostgresOrganizationStore(
      "phase-6-service-mutation-secret",
    );
    const serviceMutation = new ActionRegistry(
      new PostgresAuthorityRunner(runtime),
    ).register({
      name: "organizations.update",
      method: HttpMethod.Patch,
      path: "/v1/organizations/:id",
      input: contractSchemas.OrganizationUpdate,
      output: contractSchemas.Organization,
      policy: {
        type: ActionKind.Command,
        access: ActionAccess.Admin,
        organizationContext:
          OrganizationContextPolicy.RequiredAuthenticatedContext,
      },
      handler: (rawContext, input) => {
        const authorized = rawContext as AuthorizedActionContext;
        return serviceStore.updateOrganization(
          authorized.transaction,
          authorized.authority as OrganizationActor,
          authorized.params.id,
          input as OrganizationUpdateInput,
        );
      },
    });
    const serviceMutationResult = await serviceMutation.execute(
      "organizations.update",
      context(service, organizationA),
      { name: "Phase 6 Service Updated" },
    ) as { name: string };
    assertEquals(serviceMutationResult.name, "Phase 6 Service Updated");

    const persisted = await administrator.query<{ value: string }>(
      `select value from bakery.test_persisted_probe
       where organization_id = any($1::uuid[])
         and value like 'phase6.%'
       order by value`,
      [[organizationA, organizationB]],
    );
    assertEquals(
      persisted.rows.map(({ value }) => value),
      ["phase6.committed-a", "phase6.committed-b"],
    );
    await expectPostgresError(
      () =>
        fixture.pgDatabase.query(
          `delete from public.member
           where "organizationId" = $1 and id = $2`,
          [organizationA, adminMembershipA],
        ),
      "23503",
    );
    assertEquals(
      (await fixture.pgDatabase.query<{
        id: string;
        status: string;
        inviterId: string | null;
      }>(
        `select id, status, "inviterId" as "inviterId"
         from public.invitation
         where id = $1`,
        [invitationA],
      )).rows,
      [{ id: invitationA, status: "pending", inviterId: providerAdmin }],
    );
    const cleaned = await runtime.query<{ count: number }>(
      "select count(*)::int as count from pg_settings where name like 'app.%'",
    );
    assertEquals(cleaned.rows[0].count, 0);
  } finally {
    await closePgDatabase(runtime);
    await closePgDatabase(administrator);
    await fixture.pgDatabase.query(
      "drop table if exists bakery.test_persisted_probe",
    );
    await fixture.pgDatabase.query(
      "delete from public.organization where id = any($1::uuid[])",
      [[organizationA, organizationB]],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.organizations where id = any($1::uuid[])",
      [[organizationA, organizationB]],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.principals where id = any($1::uuid[])",
      [[adminPrincipalId, developerPrincipalId, servicePrincipalId]],
    );
    await fixture.pgDatabase.query(
      'delete from public."user" where id = any($1::uuid[])',
      [[providerAdmin, providerDeveloper]],
    );
    await fixture.close();
  }
});
