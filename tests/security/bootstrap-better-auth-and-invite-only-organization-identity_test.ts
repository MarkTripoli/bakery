import { assert, assertEquals } from "@std/assert";
import { englishCatalog } from "../../packages/i18n/src/index.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { AuthProblemCode } from "../../packages/contracts/src/http.ts";
import { buildBetterAuthOptions } from "../../apps/server/src/modules/auth/adapters/better-auth.ts";
import { OrganizationRole } from "../../apps/server/src/modules/auth/domain/authorization.ts";
import { AuthErrorCode } from "../../apps/server/src/modules/auth/domain/errors.ts";
import {
  decideRegistration,
  RegistrationAction,
  RegistrationErrorCode,
} from "../../apps/server/src/modules/auth/domain/registration.ts";
import type { AuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import { createAuthV1Routes } from "../../apps/server/src/modules/auth/transport/http/v1/routes.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  authTestSecret,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "../helpers/auth.ts";

const baseProductionConfig = {
  BAKERY_ENV: "production",
  BAKERY_APP_DATABASE_URL: "postgres://bakery-app.example.test/bakery",
  INNGEST_URL: "https://inngest.example.test",
  INNGEST_SIGNING_KEY: "a".repeat(32),
  INNGEST_EVENT_KEY: "test-event-key",
  BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
};

Deno.test("auth configuration rejects unsafe secrets and origins by name only", () => {
  const secret = "do-not-expose-this-short-secret";
  const cases = [
    {
      env: { ...baseProductionConfig, BETTER_AUTH_SECRET: "" },
      missing: ["BETTER_AUTH_SECRET"],
      invalid: [],
    },
    {
      env: { ...baseProductionConfig, BETTER_AUTH_SECRET: secret },
      missing: [],
      invalid: ["BETTER_AUTH_SECRET"],
    },
    {
      env: {
        ...baseProductionConfig,
        BETTER_AUTH_SECRET: "a".repeat(32),
        BAKERY_PUBLIC_BASE_URL: "https://user:password@bakery.example.test",
      },
      missing: [],
      invalid: ["BAKERY_PUBLIC_BASE_URL"],
    },
    {
      env: {
        ...baseProductionConfig,
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_TRUSTED_ORIGINS: "https://*.example.test",
      },
      missing: [],
      invalid: ["BETTER_AUTH_TRUSTED_ORIGINS"],
    },
    {
      env: {
        ...baseProductionConfig,
        BETTER_AUTH_SECRET: "a".repeat(32),
        BAKERY_PUBLIC_BASE_URL: "http://bakery.example.test",
      },
      missing: [],
      invalid: ["BAKERY_PUBLIC_BASE_URL"],
    },
    {
      env: {
        ...baseProductionConfig,
        BETTER_AUTH_SECRET: "a".repeat(32),
        BAKERY_PUBLIC_BASE_URL: "https://203.0.113.5",
      },
      missing: [],
      invalid: ["BAKERY_PUBLIC_BASE_URL"],
    },
    {
      env: {
        ...baseProductionConfig,
        BETTER_AUTH_SECRET: "a".repeat(32),
        BAKERY_PUBLIC_BASE_URL: "https://[2001:db8::1]",
      },
      missing: [],
      invalid: ["BAKERY_PUBLIC_BASE_URL"],
    },
    {
      env: {
        ...baseProductionConfig,
        BETTER_AUTH_SECRET: "a".repeat(32),
        INNGEST_SIGNING_KEY: "short",
      },
      missing: [],
      invalid: ["INNGEST_SIGNING_KEY"],
    },
  ];

  for (const { env, missing, invalid } of cases) {
    const config = readRuntimeConfig(env);
    assertEquals(config.missingConfig, missing);
    assertEquals(config.invalidConfig, invalid);
    const diagnostics = JSON.stringify({
      missingConfig: config.missingConfig,
      invalidConfig: config.invalidConfig,
    });
    assert(!diagnostics.includes(secret));
    assert(!diagnostics.includes("password"));
  }
});

Deno.test("auth configuration rejects half-configured GitHub credentials", () => {
  const valid = {
    ...baseProductionConfig,
    BETTER_AUTH_SECRET: "a".repeat(32),
  };
  assertEquals(
    readRuntimeConfig({ ...valid, GITHUB_CLIENT_ID: "client-id" })
      .invalidConfig,
    ["GITHUB_CLIENT_SECRET"],
  );
  assertEquals(
    readRuntimeConfig({ ...valid, GITHUB_CLIENT_SECRET: "client-secret" })
      .invalidConfig,
    ["GITHUB_CLIENT_ID"],
  );
});

Deno.test("remote creation and existing identity paths fail closed", async () => {
  const calls: string[] = [];
  const persistence: AuthPersistence = {
    hasLiveInvitation(email) {
      calls.push(email);
      return Promise.resolve(false);
    },
    hasEnabledPrincipal() {
      return Promise.resolve(false);
    },
    upsertHumanPrincipal() {
      return Promise.resolve();
    },
    upsertHumanPrincipalForProviderUser() {
      return Promise.resolve();
    },
  };
  const now = new Date();

  assertEquals(
    await decideRegistration({
      action: RegistrationAction.CreateUser,
      email: "  USER@EXAMPLE.TEST  ",
      hasRequest: true,
      now,
      signupsEnabled: true,
    }, persistence),
    { error: RegistrationErrorCode.IdentityNotAllowed },
  );
  assertEquals(calls, ["user@example.test"]);
  assertEquals(
    await decideRegistration({
      action: RegistrationAction.CreateUser,
      email: "bootstrap@example.test",
      hasRequest: false,
      now,
      signupsEnabled: true,
    }, persistence),
    undefined,
  );
  for (
    const action of [
      RegistrationAction.LinkAccount,
      RegistrationAction.SignIn,
    ]
  ) {
    assertEquals(
      await decideRegistration({
        action,
        providerUserId: crypto.randomUUID(),
        hasRequest: true,
        now,
        signupsEnabled: true,
      }, persistence),
      { error: RegistrationErrorCode.IdentityNotAllowed },
    );
  }
});

Deno.test("provider hooks redact persistence failures and reject sessions", async () => {
  const sensitive = "postgres://user:secret@example.test/bakery";
  const logs: string[] = [];
  const persistence: AuthPersistence = {
    hasLiveInvitation() {
      throw new Error(sensitive);
    },
    hasEnabledPrincipal() {
      throw new Error(sensitive);
    },
    upsertHumanPrincipal() {
      throw new Error(sensitive);
    },
    upsertHumanPrincipalForProviderUser() {
      throw new Error(sensitive);
    },
  };
  const options = buildBetterAuthOptions({
    pgDatabase: {} as never,
    persistence,
    config: {
      secret: "a".repeat(32),
      publicOrigin: "https://bakery.example.test",
      trustedOrigins: ["https://bakery.example.test"],
    },
    log: (code) => logs.push(code),
  });
  const result = await options.user.validateUserInfo(
    {
      user: { email: "user@example.test" },
      source: {
        action: RegistrationAction.CreateUser,
        method: "email-password",
      },
    },
    {
      request: new Request(
        "https://bakery.example.test/api/auth/sign-up/email",
      ),
    } as never,
  );
  assertEquals(result, {
    error: RegistrationErrorCode.IdentityNotAllowed,
    errorDescription: englishCatalog["auth.registration.identityNotAllowed"],
  });
  assert(!JSON.stringify(result).includes(sensitive));

  await options.databaseHooks.user?.create?.after?.({
    id: crypto.randomUUID(),
    name: "User",
  } as never);
  const providerLog = options.logger?.log as
    | ((...values: unknown[]) => void)
    | undefined;
  providerLog?.("error", sensitive, { password: sensitive });
  assertEquals(logs, [
    AuthErrorCode.PrincipalSyncFailed,
    AuthErrorCode.ProviderError,
  ]);
  assert(!JSON.stringify(logs).includes(sensitive));

  const before = options.databaseHooks.session?.create?.before;
  assert(before);
  assertEquals(
    await before(
      { userId: crypto.randomUUID() } as never,
      undefined as never,
    ),
    false,
  );
  assertEquals(
    await before(
      { userId: crypto.randomUUID() } as never,
      { request: new Request("https://bakery.example.test") } as never,
    ),
    false,
  );
  assertEquals(
    await before(
      { userId: crypto.randomUUID() } as never,
      { request: undefined } as never,
    ),
    undefined,
  );
});

Deno.test("createsuperuser rejects piped secrets before reading them", async () => {
  const sensitive = "phase-4-password-must-not-appear";
  const child = new Deno.Command("pnpm", {
    args: ["createsuperuser"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`${sensitive}\n`));
  await writer.close();
  const output = await child.output();
  const text = new TextDecoder().decode(
    new Uint8Array([...output.stdout, ...output.stderr]),
  );
  assert(output.code !== 0);
  assert(text.includes(AuthErrorCode.InteractiveStdinRequired));
  assert(!text.includes(sensitive));

  const serverPackage = JSON.parse(
    await Deno.readTextFile("apps/server/package.json"),
  );
  const command = serverPackage.scripts.createsuperuser as string;
  assert(command.includes("--allow-env=DATABASE_URL,"));
  assert(command.includes("--allow-net"));
  assert(
    command.includes(
      "--allow-read=src/platform/migrations,src/modules/auth/migrations",
    ),
  );
  assert(!command.includes("--allow-all"));
  assert(!command.includes("--allow-run"));
});

Deno.test("browser session middleware returns bounded distinct failures", async () => {
  type Session = {
    session: { expiresAt: Date };
    user: { id: string; name: string; email: string };
  } | null;
  const sensitive = "provider-token-and-database-secret";
  const cases: Array<{
    name: string;
    cookie?: string;
    getSession: () => Promise<Session>;
    expected: string;
  }> = [
    {
      name: "missing",
      getSession: () => Promise.resolve(null),
      expected: AuthProblemCode.Required,
    },
    {
      name: "malformed",
      cookie: "malformed-cookie",
      getSession: () => Promise.resolve(null),
      expected: AuthProblemCode.Invalid,
    },
    {
      name: "provider-error",
      cookie: sensitive,
      getSession: () => Promise.reject(new Error(sensitive)),
      expected: AuthProblemCode.Invalid,
    },
    {
      name: "expired",
      cookie: sensitive,
      getSession: () =>
        Promise.resolve({
          session: { expiresAt: new Date(0) },
          user: {
            id: "provider-user",
            name: "Bakery Admin",
            email: "admin@example.test",
          },
        }),
      expected: AuthProblemCode.Expired,
    },
  ];

  for (const testCase of cases) {
    let calls = 0;
    const app = createAuthV1Routes({
      auth: {
        api: {
          getSession: () => {
            calls++;
            return testCase.getSession();
          },
        },
      },
      database: {} as never,
      store: {
        findSessionState: () => Promise.resolve(null),
        loadEnabledPrincipal: () => {
          throw new Error("principal lookup must not run");
        },
      },
      publicBaseUrl: "https://bakery.example.test",
      secret: "a".repeat(32),
    });
    const response = await app.fetch(
      new Request("https://bakery.example.test/v1/me", {
        headers: testCase.cookie
          ? { cookie: `better-auth.session_token=${testCase.cookie}` }
          : undefined,
      }),
    );
    const body = await response.json();
    assertEquals(response.status, 401, testCase.name);
    assertEquals(body.code, testCase.expected, testCase.name);
    assertEquals(calls, 1, testCase.name);
    assert(!JSON.stringify(body).includes(sensitive), testCase.name);
  }
});

Deno.test("absent and failed principal mapping stays fail closed", async () => {
  const sensitive = "postgres://user:secret@example.test/bakery";
  const secret = "a".repeat(32);
  const sessionToken = "principal-mapping-verified-session";
  for (
    const [loadEnabledPrincipal, expected] of [
      [() => Promise.resolve(null), AuthProblemCode.Forbidden],
      [() => Promise.reject(new Error(sensitive)), AuthProblemCode.Internal],
    ] as const
  ) {
    const app = createAuthV1Routes({
      auth: {
        api: {
          getSession: () =>
            Promise.resolve({
              session: { expiresAt: new Date(Date.now() + 60_000) },
              user: {
                id: "provider-user",
                name: "Bakery Admin",
                email: "admin@example.test",
              },
            }),
        },
      },
      database: {} as never,
      store: {
        findSessionState: () =>
          Promise.resolve({
            id: sessionToken,
            expiresAt: new Date(Date.now() + 60_000),
            twoFactorEnabled: false,
            factorVerifiedAt: null,
          }),
        loadEnabledPrincipal,
      },
      publicBaseUrl: "https://bakery.example.test",
      secret,
    });
    const response = await app.fetch(
      new Request("https://bakery.example.test/v1/me", {
        headers: { cookie: await signSessionCookie(sessionToken, secret) },
      }),
    );
    const body = await response.json();
    assertEquals(body.code, expected);
    assert(!JSON.stringify(body).includes(sensitive));
  }
});

Deno.test("real provider registration and session boundaries fail closed", async () => {
  const providerLogs: string[] = [];
  const fixture = await openAuthFixture({
    log: (code) => providerLogs.push(code),
  });
  const suffix = crypto.randomUUID();
  const adminEmail = `security-admin-${suffix}@example.test`;
  const invitedEmail = `security-invited-${suffix}@example.test`;
  const mismatchEmail = `security-mismatch-${suffix}@example.test`;
  const expiredEmail = `security-expired-${suffix}@example.test`;
  const canceledEmail = `security-canceled-${suffix}@example.test`;
  const hostileEmail = `security-hostile-${suffix}@example.test`;
  const oauthEmail = `security-oauth-${suffix}@example.test`;
  const password = `Security-${suffix}`;
  const failureBodies: string[] = [];

  const signup = (email: string, origin = authTestOrigin) =>
    fixture.app.fetch(authRequest(
      "/api/auth/sign-up/email",
      { email, password, name: "Invited Developer" },
      { origin },
    ));
  const assertDenied = async (response: Response, code?: string) => {
    const body = await response.text();
    failureBodies.push(body);
    assert(response.status >= 400);
    assert(
      !response.headers.get("content-type")?.includes(
        "application/problem+json",
      ),
    );
    if (code) assert(body.includes(code), body);
  };
  const assertSignupRejected = async (response: Response, email: string) => {
    const body = await response.json();
    failureBodies.push(JSON.stringify(body));
    assertEquals(response.status, 200);
    assertEquals(body.token, null);
    assertEquals(
      (await fixture.pgDatabase.query<{ count: number }>(
        'select count(*)::int as count from public."user" where email = $1',
        [email],
      )).rows[0].count,
      0,
    );
  };

  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, {
      email: adminEmail,
      displayName: "Security Admin",
      password,
    });
    const adminSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: adminEmail, password },
    ));
    const adminCookie = sessionCookie(adminSignIn);
    const adminSignInBody = await adminSignIn.json();
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
    const adminPrincipal = await fixture.pgDatabase.query<{ id: string }>(
      `select principal.id
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [adminEmail],
    );
    const organizationId = organization.rows[0].id;
    const invite = async (email: string) => {
      const response = await fixture.app.fetch(authRequest(
        `/v1/organizations/${organizationId}/invitations`,
        { email, role: OrganizationRole.Developer },
        {
          cookie: adminCookie,
          headers: { "Bakery-Organization-Id": organizationId },
        },
      ));
      assertEquals(response.status, 201);
      return await response.json();
    };

    for (
      const [path, body] of [
        [
          "/api/auth/organization/invite-member",
          {
            email: `provider-${suffix}@example.test`,
            role: OrganizationRole.Developer,
            organizationId,
          },
        ],
        [
          "/api/auth/organization/cancel-invitation",
          { invitationId: crypto.randomUUID() },
        ],
      ] as const
    ) {
      const response = await fixture.app.fetch(authRequest(path, body, {
        cookie: adminCookie,
      }));
      assertEquals(response.status, 404, path);
    }

    const directEmail = `security-direct-${suffix}@example.test`;
    await assertSignupRejected(
      await signup(directEmail),
      directEmail,
    );

    await fixture.pgDatabase.query(
      `insert into bakery.organization_invitations (
        id, organization_id, email, role, status, expires_at,
        inviter_principal_id, inviter_membership_id,
        created_at, updated_at, version
      ) values ($1, $2, $3, 'developer', 'pending', $4, $5,
        (select id from bakery.organization_memberships
         where organization_id = $2 and principal_id = $5),
        current_timestamp, current_timestamp, 1)`,
      [
        crypto.randomUUID(),
        organizationId,
        expiredEmail,
        new Date(0),
        adminPrincipal.rows[0].id,
      ],
    );
    await assertSignupRejected(await signup(expiredEmail), expiredEmail);

    const canceledInvitation = await invite(canceledEmail);
    await fixture.pgDatabase.query(
      "update bakery.organization_invitations set status = 'canceled' where id = $1",
      [canceledInvitation.id],
    );
    await assertSignupRejected(await signup(canceledEmail), canceledEmail);

    const invitation = await invite(invitedEmail);
    await assertSignupRejected(await signup(mismatchEmail), mismatchEmail);

    const validation = fixture.auth.options.user?.validateUserInfo;
    assert(validation);
    assertEquals(
      await validation({
        user: { email: oauthEmail },
        source: {
          action: RegistrationAction.CreateUser,
          method: "oauth",
          oauth: { providerId: "github", profile: {} },
        },
      } as never, {
        request: new Request(
          `${authTestOrigin}/api/auth/callback/github`,
        ),
      } as never),
      {
        error: RegistrationErrorCode.IdentityNotAllowed,
        errorDescription:
          englishCatalog["auth.registration.identityNotAllowed"],
      },
    );

    const signUp = await signup(invitedEmail);
    assertEquals(signUp.status, 200, await signUp.clone().text());
    const signUpBody = await signUp.json();
    assertEquals(signUpBody.token, null);
    const invitedSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: invitedEmail, password },
    ));
    assertEquals(invitedSignIn.status, 200);
    const invitedCookie = sessionCookie(invitedSignIn);
    const invitedSignInBody = await invitedSignIn.json();
    const accept = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: invitation.id },
      { cookie: invitedCookie },
    ));
    assertEquals(accept.status, 200);
    const accepted = await accept.json();
    assertEquals(accepted.invitation.status, "accepted");
    assertEquals(accepted.member.role, OrganizationRole.Developer);

    const replayedAccept = await fixture.app.fetch(authRequest(
      "/api/auth/organization/accept-invitation",
      { invitationId: invitation.id },
      { cookie: invitedCookie },
    ));
    assertEquals(replayedAccept.status, 200);
    assertEquals(
      replayedAccept.headers.get("Idempotent-Replayed"),
      "true",
    );
    assertEquals(await replayedAccept.json(), accepted);
    const replayedSignup = await signup(invitedEmail);
    assertEquals(replayedSignup.status, 200);
    assertEquals((await replayedSignup.json()).token, null);
    const invitedRows = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count
       from public."user"
       where email = $1`,
      [invitedEmail],
    );
    const memberships = await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count
       from bakery.organization_memberships as membership
       join bakery.principals as principal
         on principal.id = membership.principal_id
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [invitedEmail],
    );
    assertEquals(invitedRows.rows[0].count, 1);
    assertEquals(memberships.rows[0].count, 1);

    await assertDenied(
      await fixture.app.fetch(authRequest(
        "/api/auth/organization/create",
        { name: "Forbidden", slug: `forbidden-${suffix}` },
        { cookie: invitedCookie },
      )),
    );
    for (
      const [path, body] of [
        [
          "/api/auth/organization/update-member-role",
          {
            memberId: "00000000-0000-4000-8000-000000000001",
            role: OrganizationRole.Admin,
          },
        ],
        [
          "/api/auth/organization/remove-member",
          { memberIdOrEmail: invitedEmail },
        ],
        [
          "/api/auth/organization/update",
          { data: { name: "Forbidden" } },
        ],
        [
          "/api/auth/organization/set-active",
          { organizationId: organizationId },
        ],
      ] as const
    ) {
      const response = await fixture.app.fetch(authRequest(
        path,
        body,
        { cookie: invitedCookie },
      ));
      assertEquals(response.status, 404, path);
    }
    const listedInvitations = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/api/auth/organization/list-invitations?organizationId=${organizationId}`,
        {
          headers: {
            cookie: invitedCookie,
            origin: authTestOrigin,
          },
        },
      ),
    );
    assertEquals(listedInvitations.status, 404);

    await invite(hostileEmail);
    await assertDenied(
      await fixture.app.fetch(authRequest(
        "/api/auth/sign-up/email",
        { email: hostileEmail, password, name: "Hostile" },
        {
          origin: "https://hostile.example.test",
          headers: {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        },
      )),
      "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
    );

    const csrfSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: adminEmail, password },
    ));
    const csrfCookie = sessionCookie(csrfSignIn);
    const csrfSignInBody = await csrfSignIn.json();
    const apiErrorLogCount = providerLogs.length;
    await assertDenied(
      await fixture.app.fetch(authRequest(
        "/api/auth/sign-out",
        {},
        { cookie: csrfCookie, origin: null },
      )),
      "MISSING_OR_NULL_ORIGIN",
    );
    await assertDenied(
      await fixture.app.fetch(
        new Request(`${authTestOrigin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: authTestOrigin,
          },
          body: '{"password":"must-not-be-logged"',
        }),
      ),
    );
    assertEquals(providerLogs.slice(apiErrorLogCount), [
      AuthErrorCode.ProviderError,
      AuthErrorCode.ProviderError,
    ]);

    const malformed = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: "better-auth.session_token=malformed" },
      }),
    );
    assertEquals(malformed.status, 401);
    const malformedBody = await malformed.text();
    failureBodies.push(malformedBody);
    assert(malformedBody.includes(AuthProblemCode.Invalid));

    await fixture.pgDatabase.query(
      `update public.session
       set "expiresAt" = $2
       where token = $1`,
      [invitedSignInBody.token, new Date(0)],
    );
    const expired = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: invitedCookie },
      }),
    );
    assertEquals(expired.status, 401);
    const expiredBody = await expired.text();
    failureBodies.push(expiredBody);
    assert(expiredBody.includes(AuthProblemCode.Expired));

    const revokedSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: invitedEmail, password },
    ));
    const revokedCookie = sessionCookie(revokedSignIn);
    const revokedBody = await revokedSignIn.json();
    await fixture.pgDatabase.query(
      "delete from public.session where token = $1",
      [revokedBody.token],
    );
    const revoked = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: revokedCookie },
      }),
    );
    assertEquals(revoked.status, 401);
    failureBodies.push(await revoked.text());

    const signedOutSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: invitedEmail, password },
    ));
    const signedOutCookie = sessionCookie(signedOutSignIn);
    const signedOutSignInBody = await signedOutSignIn.json();
    const signOut = await fixture.app.fetch(authRequest(
      "/api/auth/sign-out",
      {},
      { cookie: signedOutCookie },
    ));
    assertEquals(signOut.status, 200);
    const stale = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: signedOutCookie },
      }),
    );
    assertEquals(stale.status, 401);
    failureBodies.push(await stale.text());

    const disabledSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: invitedEmail, password },
    ));
    const disabledCookie = sessionCookie(disabledSignIn);
    const disabledSignInBody = await disabledSignIn.json();
    await fixture.pgDatabase.query(
      `update bakery.principals
       set disabled_at = $2
       where provider_user_id = (
         select id from public."user" where email = $1
       )`,
      [invitedEmail, new Date()],
    );
    const disabled = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: disabledCookie },
      }),
    );
    assertEquals(disabled.status, 403);
    const disabledBody = await disabled.text();
    failureBodies.push(disabledBody);
    assert(disabledBody.includes(AuthProblemCode.Forbidden));

    for (
      const [path, body] of [
        ["/api/auth/get-session", undefined],
        ["/api/auth/update-user", { name: "Must stay disabled" }],
        [
          "/api/auth/organization/accept-invitation",
          { invitationId: invitation.id },
        ],
      ] as const
    ) {
      const response = await fixture.app.fetch(
        body === undefined
          ? new Request(`${authTestOrigin}${path}`, {
            headers: { cookie: disabledCookie },
          })
          : authRequest(path, body, { cookie: disabledCookie }),
      );
      assertEquals(response.status, 403, path);
      const responseBody = await response.text();
      failureBodies.push(responseBody);
      assert(responseBody.includes(AuthProblemCode.Forbidden), responseBody);
    }

    const leakedValues = [
      password,
      authTestSecret,
      adminCookie,
      invitedCookie,
      revokedCookie,
      signedOutCookie,
      disabledCookie,
      adminSignInBody.token,
      csrfSignInBody.token,
      invitedSignInBody.token,
      revokedBody.token,
      signedOutSignInBody.token,
      disabledSignInBody.token,
      "postgres://",
      "public.session",
      "bakery.principals",
    ];
    const captured = failureBodies.join("\n");
    for (const leaked of leakedValues) {
      assert(!captured.includes(leaked), leaked);
    }
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [
      adminEmail,
      invitedEmail,
      mismatchEmail,
      expiredEmail,
      canceledEmail,
      hostileEmail,
      oauthEmail,
      `security-direct-${suffix}@example.test`,
    ]);
    await fixture.close();
  }
});
