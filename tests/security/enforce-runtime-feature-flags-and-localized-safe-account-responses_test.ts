import { assert, assertEquals } from "@std/assert";
import { catalogs, englishCatalog } from "../../packages/i18n/src/index.ts";
import { AuthProblemCode } from "../../packages/contracts/src/http.ts";
import { buildBetterAuthOptions } from "../../apps/server/src/modules/auth/adapters/better-auth.ts";
import { AuthErrorCode } from "../../apps/server/src/modules/auth/domain/errors.ts";
import {
  RegistrationAction,
  RegistrationErrorCode,
} from "../../apps/server/src/modules/auth/domain/registration.ts";
import { OrganizationRole } from "../../apps/server/src/modules/auth/domain/authorization.ts";
import type { AuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";

// 1. A web request cannot claim the CLI exception.
Deno.test("a web request cannot claim the CLI signups exception", async () => {
  const logs: string[] = [];
  const persistence: AuthPersistence = {
    hasLiveInvitation: () => {
      throw new Error(
        "must not check invitation existence when signups are disabled",
      );
    },
    hasEnabledPrincipal: () => {
      throw new Error(
        "must not check principal existence when signups are disabled",
      );
    },
    upsertHumanPrincipal: () => Promise.resolve(),
    upsertHumanPrincipalForProviderUser: () => Promise.resolve(),
  };
  const options = buildBetterAuthOptions({
    pgDatabase: {} as never,
    persistence,
    installationSettings: {
      current: () =>
        Promise.resolve({
          registrationMode: "closed",
          organizationCreationPolicy: "installation_admins",
          version: 1,
          updatedByPrincipalId: null,
          updatedAt: new Date().toISOString(),
        }),
    },
    config: {
      secret: "a".repeat(32),
      publicOrigin: "https://bakery.example.test",
      trustedOrigins: ["https://bakery.example.test"],
    },
    log: (code) => logs.push(code),
  });

  const attackerEmail = "attacker-cli-impersonator@example.test";
  const emailResult = await options.user.validateUserInfo({
    user: { email: attackerEmail },
    source: {
      action: RegistrationAction.CreateUser,
      method: "email-password",
    },
  } as never, {
    request: new Request(`${authTestOrigin}/api/auth/sign-up/email`),
  } as never);
  assertEquals(emailResult, {
    error: RegistrationErrorCode.SignupsDisabled,
    errorDescription: englishCatalog["auth.registration.paused"],
  });
  assert(!JSON.stringify(emailResult).includes(attackerEmail));

  const attackerProviderUserId = "attacker-oauth-provider-user-id";
  const oauthEmail = "attacker-oauth-impersonator@example.test";
  const oauthResult = await options.user.validateUserInfo({
    user: { email: oauthEmail, id: attackerProviderUserId },
    source: {
      action: RegistrationAction.CreateUser,
      method: "oauth",
      oauth: { providerId: "github", profile: {} },
    },
  } as never, {
    request: new Request(`${authTestOrigin}/api/auth/callback/github`),
  } as never);
  assertEquals(oauthResult, {
    error: RegistrationErrorCode.SignupsDisabled,
    errorDescription: englishCatalog["auth.registration.paused"],
  });
  assert(!JSON.stringify(oauthResult).includes(oauthEmail));
  assert(!JSON.stringify(oauthResult).includes(attackerProviderUserId));

  assertEquals(logs, [
    AuthErrorCode.SignupsDisabled,
    AuthErrorCode.SignupsDisabled,
  ]);
});

// 2. An invited sign-up under a non-default locale ends up scoped to
//    exactly the role and organization it was invited into.
Deno.test("invited sign-up accepted under a non-default locale yields exactly the invited role and one organization", async () => {
  const fixture = await openAuthFixture({
    installationPolicy: {
      registrationMode: "invitation",
      organizationCreationPolicy: "installation_admins",
    },
  });
  const suffix = crypto.randomUUID();
  const adminEmail = `flag-admin-${suffix}@example.test`;
  const invitedEmail = `flag-invited-${suffix}@example.test`;
  const password = `Flag-${suffix}`;
  const acceptLanguage = "ar-XB";

  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email: adminEmail, displayName: "Flag Admin", password });

    const adminSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: adminEmail, password },
      { headers: { "accept-language": acceptLanguage } },
    ));
    assertEquals(adminSignIn.status, 200);
    const adminCookie = sessionCookie(adminSignIn);
    const organization = await fixture.pgDatabase.query<{ id: string }>(
      `select organization.id
       from bakery.organizations as organization
       join bakery.organization_memberships as membership
         on membership.organization_id = organization.id
       join bakery.principals as principal
         on principal.id = membership.principal_id
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [adminEmail],
    );
    const organizationId = organization.rows[0].id;

    const invite = await fixture.app.fetch(authRequest(
      `/v1/organizations/${organizationId}/invitations`,
      { email: invitedEmail, role: OrganizationRole.Developer },
      {
        cookie: adminCookie,
        headers: {
          "Bakery-Organization-Id": organizationId,
          "accept-language": acceptLanguage,
        },
      },
    ));
    assertEquals(invite.status, 201);
    const invitation = await invite.json();

    const signUp = await fixture.app.fetch(authRequest(
      "/api/auth/sign-up/email",
      { email: invitedEmail, password, name: "Flag Invited" },
      { headers: { "accept-language": acceptLanguage } },
    ));
    assertEquals(signUp.status, 200);
    assertEquals((await signUp.json()).token, null);

    const invitedSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: invitedEmail, password },
      { headers: { "accept-language": acceptLanguage } },
    ));
    assertEquals(invitedSignIn.status, 200);
    const invitedCookie = sessionCookie(invitedSignIn);

    const accept = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: invitation.id },
      {
        cookie: invitedCookie,
        headers: { "accept-language": acceptLanguage },
      },
    ));
    assertEquals(accept.status, 200);
    const accepted = await accept.json();
    assertEquals(accepted.member.role, OrganizationRole.Developer);

    const organizations = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/organizations`, {
        headers: {
          cookie: invitedCookie,
          "accept-language": acceptLanguage,
        },
      }),
    );
    assertEquals(organizations.status, 200);
    const organizationsBody = await organizations.json() as {
      items: Array<{ id: string; role: string }>;
      nextCursor: string | null;
    };
    assertEquals(organizationsBody.items.length, 1);
    assertEquals(organizationsBody.items[0].id, organizationId);
    assertEquals(organizationsBody.items[0].role, OrganizationRole.Developer);
    assertEquals(organizationsBody.nextCursor, null);

    // The ar-XB header on every request above must be load-bearing: it does
    // reach the invited member's own identity response, and it still changes
    // nothing about who they are or what they may do.
    const identity = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: {
          cookie: invitedCookie,
          "accept-language": acceptLanguage,
        },
      }),
    );
    assertEquals(identity.status, 200);
    const identityBody = await identity.json() as {
      locale: string;
      direction: string;
      principalId: string;
      principalType: string;
    };
    assertEquals(identityBody.locale, "ar-XB");
    assertEquals(identityBody.direction, "rtl");
    assertEquals(identityBody.principalType, "human");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [adminEmail, invitedEmail]);
    await fixture.close();
  }
});

// 3. Locale input cannot change identity or authority.
Deno.test("hostile Accept-Language input cannot change identity or bypass authorization", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const adminEmail = `locale-admin-${suffix}@example.test`;
  const password = `Locale-${suffix}`;

  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email: adminEmail, displayName: "Locale Admin", password });

    const adminSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: adminEmail, password },
    ));
    assertEquals(adminSignIn.status, 200);
    const adminCookie = sessionCookie(adminSignIn);

    const baseline = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: adminCookie },
      }),
    );
    assertEquals(baseline.status, 200);
    const baselineBody = await baseline.json();

    // Digits can never form a valid BCP-47 primary subtag, so this ~4KB
    // header is guaranteed to parse to zero language tags without throwing.
    const junkAcceptLanguage = "9".repeat(4096);
    const hostile = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: {
          cookie: adminCookie,
          "accept-language": junkAcceptLanguage,
        },
      }),
    );
    assertEquals(hostile.status, 200);
    const hostileBody = await hostile.json();
    assertEquals(hostileBody.locale, "en");
    assertEquals(hostileBody.principalId, baselineBody.principalId);
    assertEquals(hostileBody.principalType, baselineBody.principalType);

    const organization = await fixture.pgDatabase.query<{ id: string }>(
      `select organization.id
       from bakery.organizations as organization
       join bakery.organization_memberships as membership
         on membership.organization_id = organization.id
       where membership.principal_id = $1`,
      [baselineBody.principalId],
    );
    const organizationId = organization.rows[0].id;

    // A disabled principal is the codebase's genuine 403 AUTH_FORBIDDEN
    // boundary (see the "absent and failed principal mapping" and
    // "real provider registration" security tests); a caller who is simply
    // not a member of an organization instead gets a non-disclosing 404,
    // so that scenario cannot exercise this attack.
    await fixture.pgDatabase.query(
      "update bakery.principals set disabled_at = current_timestamp where id = $1",
      [baselineBody.principalId],
    );
    const forbidden = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/organizations/${organizationId}`,
        {
          headers: {
            cookie: adminCookie,
            "Bakery-Organization-Id": organizationId,
            "accept-language": "ar-XB",
          },
        },
      ),
    );
    assertEquals(forbidden.status, 403);
    const forbiddenBody = await forbidden.json();
    assertEquals(forbiddenBody.code, AuthProblemCode.Forbidden);
    assertEquals(forbidden.headers.get("Content-Language"), "ar-XB");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [adminEmail]);
    await fixture.close();
  }
});

// 4. Accept-Language is never logged.
Deno.test("Accept-Language header value is never logged", async () => {
  const providerLogs: string[] = [];
  const consoleLogs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleLogs.push(args);
  };
  const marker = `leak-marker-${crypto.randomUUID()}`;
  const fixture = await openAuthFixture({
    installationPolicy: {
      registrationMode: "closed",
      organizationCreationPolicy: "installation_admins",
    },
    log: (code) => providerLogs.push(code),
  });
  const suffix = crypto.randomUUID();
  const deniedEmail = `locale-denied-${suffix}@example.test`;

  try {
    const localized401 = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: {
          cookie: "better-auth.session_token=malformed",
          "accept-language": marker,
        },
      }),
    );
    assertEquals(localized401.status, 401);

    const deniedSignUp = await fixture.app.fetch(authRequest(
      "/api/auth/sign-up/email",
      { email: deniedEmail, password: `Locale-${suffix}`, name: "Denied" },
      { headers: { "accept-language": marker } },
    ));
    assertEquals(deniedSignUp.status, 200);
    assertEquals((await deniedSignUp.json()).token, null);

    assert(providerLogs.length > 0);
    for (const entry of providerLogs) {
      assert(!entry.includes(marker), entry);
    }
    for (const args of consoleLogs) {
      assert(
        !args.some((value) => String(value).includes(marker)),
        JSON.stringify(args),
      );
    }
  } finally {
    console.error = originalConsoleError;
    await cleanupAuthFixture(fixture.pgDatabase, [deniedEmail]);
    await fixture.close();
  }
});

// 5. The non-disclosing invitation-lookup 404 is localized.
Deno.test("the invitation-lookup 404 stays localized and discloses nothing about invitation existence", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const adminEmail = `invitation-lookup-admin-${suffix}@example.test`;
  const password = `Invite-${suffix}`;

  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email: adminEmail, displayName: "Invitation Lookup Admin", password });

    const adminSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: adminEmail, password },
    ));
    assertEquals(adminSignIn.status, 200);
    const adminCookie = sessionCookie(adminSignIn);

    const missingInvitationId = crypto.randomUUID();
    const lookup = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/api/auth/organization/get-invitation?id=${missingInvitationId}`,
        {
          headers: { cookie: adminCookie, "accept-language": "en-XA" },
        },
      ),
    );
    assertEquals(lookup.status, 404);
    assertEquals(lookup.headers.get("Content-Language"), "en-XA");
    assert(
      lookup.headers.get("Vary")?.split(",").some((value) =>
        value.trim().toLowerCase() === "accept-language"
      ),
      lookup.headers.get("Vary") ?? "",
    );
    const lookupBody = await lookup.json();
    assertEquals(lookupBody.code, "RESOURCE_NOT_FOUND");
    assertEquals(
      lookupBody.title,
      catalogs["en-XA"]["problems.RESOURCE_NOT_FOUND.title"],
    );
    assertEquals(
      lookupBody.detail,
      catalogs["en-XA"]["problems.RESOURCE_NOT_FOUND.description"],
    );
    assert(!JSON.stringify(lookupBody).includes(missingInvitationId));
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [adminEmail]);
    await fixture.close();
  }
});
