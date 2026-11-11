import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { catalogVersion } from "../../packages/i18n/src/index.ts";
import { openPgDatabase } from "../../apps/server/src/platform/database.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  createAuthProvider,
  createSuperuser,
} from "../../apps/server/src/modules/auth/index.ts";
import { OrganizationRole } from "../../apps/server/src/modules/auth/domain/authorization.ts";
import type { AuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import type { PasskeyPlugin } from "../../apps/server/src/modules/auth/adapters/passkey-policy.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { MigrationOwner } from "../../apps/server/src/platform/migrate.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { AuthProblemCode } from "../../packages/contracts/src/http.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "../helpers/auth.ts";

const persistence: AuthPersistence = {
  hasLiveInvitation: () => Promise.resolve(false),
  hasEnabledPrincipal: () => Promise.resolve(true),
  upsertHumanPrincipal: () => Promise.resolve(),
  upsertHumanPrincipalForProviderUser: () => Promise.resolve(),
};

Deno.test("the auth module exposes one configured Better Auth factory", async () => {
  const pgDatabase = openPgDatabase("postgres://127.0.0.1:1/bakery");
  try {
    const auth = createAuthProvider({
      pgDatabase,
      persistence,
      config: {
        secret: "a".repeat(32),
        publicOrigin: "http://127.0.0.1:8788",
        trustedOrigins: [
          "http://127.0.0.1:8788",
          "https://bakery.example.test",
        ],
      },
    });

    // Plugin `init` seeds the OAuth resource row, so readiness needs the
    // database. This one is unreachable: each instance must reject its
    // readiness promise before any assertion can end the test and the pool,
    // or the pending seed query would outlive the pool as an uncaught error.
    await assertRejects(() => auth.$context);

    assertStrictEquals(auth.options.database, pgDatabase);
    assertEquals(auth.options.baseURL, "http://127.0.0.1:8788");
    assertEquals(auth.options.basePath, "/api/auth");
    assertEquals(auth.options.emailAndPassword, {
      enabled: true,
      autoSignIn: false,
    });
    assertEquals(auth.options.session?.cookieCache?.enabled, false);
    assertEquals(auth.options.advanced?.database?.generateId, "uuid");
    assertEquals(auth.options.trustedOrigins, [
      "http://127.0.0.1:8788",
      "https://bakery.example.test",
    ]);
    assertEquals(auth.options.socialProviders, undefined);

    assertEquals(
      auth.options.plugins?.map((plugin) => plugin.id),
      [
        "bakery-session-assurance",
        "bakery-credential-audit",
        "two-factor",
        "passkey",
        "jwt",
        "oauth-provider",
        "bakery-oauth-organization",
        "sso",
        "bakery-sso-guard",
        "bakery-sso-enforcement",
        "scim",
        "bakery-scim-projection",
      ],
    );
    // `auth.options.plugins` is typed as the union of every registered
    // plugin, which erases each one's own `options`.
    const passkeyPlugin = auth.options.plugins?.find(
      (plugin) => plugin.id === "passkey",
    ) as PasskeyPlugin;
    // `https://bakery.example.test` is a trusted origin but not in the RP
    // ID's realm, so SimpleWebAuthn could never match it: it is filtered out.
    assertEquals(passkeyPlugin.options?.rpID, "127.0.0.1");
    assertEquals(passkeyPlugin.options?.origin, ["http://127.0.0.1:8788"]);
    assertEquals(
      passkeyPlugin.options?.authenticatorSelection?.userVerification,
      "required",
    );
    assert(auth.options.user?.validateUserInfo);
    assert(auth.options.databaseHooks?.user?.create?.after);
    assert(auth.options.databaseHooks?.session?.create?.before);

    const github = createAuthProvider({
      pgDatabase,
      persistence,
      config: {
        secret: "b".repeat(32),
        publicOrigin: "https://bakery.example.test",
        trustedOrigins: ["https://bakery.example.test"],
        github: { clientId: "client-id", clientSecret: "client-secret" },
      },
    });
    await assertRejects(() => github.$context);
    assertEquals(github.options.socialProviders?.github?.clientId, "client-id");
    assertEquals(
      github.options.socialProviders?.github?.clientSecret,
      "client-secret",
    );
    assertEquals(betterAuthMigrationSource.owner, MigrationOwner.BetterAuth);
    assertEquals(authBakeryMigrationSource.owner, MigrationOwner.Bakery);
  } finally {
    await pgDatabase.end();
  }
});

Deno.test("app composition isolates provider, identity, health, and task routes", async () => {
  const principalId = "00000000-0000-4000-8000-000000000001";
  const secret = "a".repeat(32);
  const sessionToken = "app-composition-verified-session";
  let providerCalls = 0;
  let sessionCalls = 0;
  const auth = {
    handler() {
      providerCalls++;
      return Promise.resolve(
        new Response("provider-response", {
          status: 202,
          headers: { "x-provider": "better-auth" },
        }),
      );
    },
    api: {
      getSession(options: {
        headers: Headers;
        query: { disableCookieCache: true };
      }) {
        sessionCalls++;
        assertEquals(options.query.disableCookieCache, true);
        if (!options.headers.get("cookie")) return Promise.resolve(null);
        return Promise.resolve({
          session: { expiresAt: new Date(Date.now() + 60_000) },
          user: {
            id: "provider-user",
            name: "Bakery Admin",
            email: "admin@example.test",
          },
        });
      },
    },
  };
  const authPersistence = {
    hasLiveInvitation: () => Promise.resolve(false),
    hasEnabledPrincipal: () => Promise.resolve(true),
    upsertHumanPrincipal: () => Promise.resolve(),
    upsertHumanPrincipalForProviderUser: () => Promise.resolve(),
    findSessionState: () =>
      Promise.resolve({
        id: sessionToken,
        expiresAt: new Date(Date.now() + 60_000),
        twoFactorEnabled: false,
        factorVerifiedAt: null,
      }),
    loadEnabledPrincipal: () =>
      Promise.resolve({
        principalId,
        principalType: "human" as const,
        displayName: "Bakery Admin",
      }),
  };
  const app = createApp({
    config: readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
      BETTER_AUTH_SECRET: secret,
      BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8788",
    }),
    database: (() => Promise.resolve([])) as never,
    pgDatabase: {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as never,
    auth,
    authPersistence,
  });

  const provider = await app.fetch(
    new Request("http://test/api/auth/provider-envelope"),
  );
  assertEquals(provider.status, 202);
  assertEquals(provider.headers.get("x-provider"), "better-auth");
  assertEquals(provider.headers.get("cache-control"), "no-store");
  assertEquals(await provider.text(), "provider-response");
  assertEquals(providerCalls, 1);
  assertEquals(sessionCalls, 0);

  let recipientProviderCalls = 0;
  const recipientApp = createApp({
    config: readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
      BETTER_AUTH_SECRET: "a".repeat(32),
      BAKERY_PUBLIC_BASE_URL: "http://127.0.0.1:8788",
    }),
    database: (() => Promise.resolve([])) as never,
    pgDatabase: {} as never,
    auth: {
      handler() {
        recipientProviderCalls++;
        return Promise.resolve(
          Response.json({ message: "provider" }, { status: 202 }),
        );
      },
      api: { getSession: () => Promise.resolve(null) },
    },
    authPersistence,
  });
  const recipientCases = [
    {
      path: "/api/auth/organization/get-invitation?id=absent",
      method: "GET",
      expectedStatus: 401,
    },
    {
      path: "/api/auth/organization/accept-invitation",
      method: "POST",
      expectedStatus: 403,
    },
    {
      path: "/api/auth/organization/reject-invitation",
      method: "POST",
      expectedStatus: 403,
    },
  ] as const;
  for (const requestCase of recipientCases) {
    const response = await recipientApp.fetch(
      new Request(`http://test${requestCase.path}`, {
        method: requestCase.method,
        ...(requestCase.method === "POST"
          ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ invitationId: "absent" }),
          }
          : {}),
      }),
    );
    assertEquals(response.status, requestCase.expectedStatus, requestCase.path);
    assertEquals(
      response.headers.get("cache-control"),
      "no-store",
      requestCase.path,
    );
    assert(
      !(await response.clone().text()).includes("provider"),
      requestCase.path,
    );
  }
  assertEquals(recipientProviderCalls, 0);

  const live = await app.fetch(new Request("http://test/health/live"));
  assertEquals(live.status, 200);
  assertEquals(sessionCalls, 0);

  const identity = await app.fetch(
    new Request("http://test/v1/me", {
      headers: { cookie: await signSessionCookie(sessionToken, secret) },
    }),
  );
  assertEquals(identity.status, 200);
  assertEquals(await identity.json(), {
    principalId,
    principalType: "human",
    displayName: "Bakery Admin",
    locale: "en",
    direction: "ltr",
    catalogVersion,
    twoFactorEnabled: false,
    email: "admin@example.test",
    backupCodesRemaining: null,
    timeZone: null,
  });
  assertEquals(sessionCalls, 1);

  const task = await app.fetch(new Request("http://test/v1/tasks"));
  assertEquals(task.status, 401);
  assertEquals((await task.json()).code, "AUTH_REQUIRED");
  assertEquals(sessionCalls, 2);
});

Deno.test("real provider envelopes remain separate from Bakery identity responses", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const adminEmail = `contract-admin-${suffix}@example.test`;
  const invitedEmail = `contract-invited-${suffix}@example.test`;
  const password = `Contract-${suffix}`;

  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, {
      email: adminEmail,
      displayName: "Contract Admin",
      password,
    });
    const principal = await fixture.pgDatabase.query<{ id: string }>(
      `select principal.id
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [adminEmail],
    );
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

    const signIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: adminEmail, password },
    ));
    const adminCookie = sessionCookie(signIn);
    const signInBody = await signIn.json();
    assertEquals(signIn.status, 200);
    assert(signIn.headers.get("content-type")?.includes("application/json"));
    assert(signIn.headers.get("set-cookie")?.includes("HttpOnly"));
    assertEquals(signInBody.redirect, false);
    assertEquals(signInBody.user.email, adminEmail);
    assert(typeof signInBody.token === "string");

    const required = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`),
    );
    assertEquals(required.status, 401);
    assert(
      required.headers.get("content-type")?.includes(
        "application/problem+json",
      ),
    );
    assertEquals((await required.json()).code, AuthProblemCode.Required);

    const identity = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: adminCookie },
      }),
    );
    assertEquals(identity.status, 200);
    assertEquals(await identity.json(), {
      principalId: principal.rows[0].id,
      principalType: "human",
      displayName: "Contract Admin",
      locale: "en",
      direction: "ltr",
      catalogVersion,
      twoFactorEnabled: false,
      email: adminEmail,
      backupCodesRemaining: null,
      timeZone: null,
    });

    const invitation = await fixture.app.fetch(authRequest(
      `/v1/organizations/${organization.rows[0].id}/invitations`,
      {
        email: invitedEmail,
        role: OrganizationRole.Developer,
      },
      {
        cookie: adminCookie,
        headers: {
          "Bakery-Organization-Id": organization.rows[0].id,
        },
      },
    ));
    const invitationBody = await invitation.json();
    assertEquals(invitation.status, 201);
    assert(
      invitation.headers.get("content-type")?.includes("application/json"),
    );
    assert(
      !invitation.headers.get("content-type")?.includes(
        "application/problem+json",
      ),
    );
    assertEquals(invitationBody.email, invitedEmail);
    assertEquals(invitationBody.role, OrganizationRole.Developer);
    assertEquals(invitationBody.organizationId, organization.rows[0].id);
    assertEquals(invitationBody.inviterPrincipalId, principal.rows[0].id);

    for (
      const [path, body] of [
        [
          "/api/auth/organization/invite-member",
          {
            email: `direct-${invitedEmail}`,
            role: OrganizationRole.Developer,
            organizationId: organization.rows[0].id,
          },
        ],
        [
          "/api/auth/organization/cancel-invitation",
          { invitationId: invitationBody.id },
        ],
      ] as const
    ) {
      const direct = await fixture.app.fetch(authRequest(path, body, {
        cookie: adminCookie,
      }));
      assertEquals(direct.status, 404, path);
    }

    const malformed = await fixture.app.fetch(
      new Request(`${authTestOrigin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: authTestOrigin,
        },
        body: "{",
      }),
    );
    assertEquals(malformed.status, 400);
    assert(
      !malformed.headers.get("content-type")?.includes(
        "application/problem+json",
      ),
    );

    const signOut = await fixture.app.fetch(authRequest(
      "/api/auth/sign-out",
      {},
      { cookie: adminCookie },
    ));
    assertEquals(signOut.status, 200);
    assertEquals((await signOut.json()).success, true);
    assert(
      !signOut.headers.get("content-type")?.includes(
        "application/problem+json",
      ),
    );
    assert(
      signOut.headers.getSetCookie().some((cookie) =>
        cookie.startsWith("better-auth.session_token=") &&
        cookie.includes("Max-Age=0")
      ),
    );

    const stale = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: adminCookie },
      }),
    );
    assertEquals(stale.status, 401);
    assertEquals((await stale.json()).code, AuthProblemCode.Invalid);

    const health = await fixture.app.fetch(
      new Request(`${authTestOrigin}/health/live`, {
        headers: { cookie: "better-auth.session_token=malformed" },
      }),
    );
    assertEquals(health.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [adminEmail, invitedEmail]);
    await fixture.close();
  }
});
