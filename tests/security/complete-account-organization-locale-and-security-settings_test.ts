import { assert, assertEquals, assertRejects } from "@std/assert";
import { AuthProviderError } from "../../packages/contracts/src/auth-provider-client.ts";
import {
  call,
  type Json,
  orgHeader,
  seed,
} from "../helpers/account-settings.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  enrollTotp,
  openAuthFixture,
  signSessionCookie,
  userIdFor,
} from "../helpers/auth.ts";
import {
  clientWithJar,
  meStatus,
  newAuthenticator,
  passkeySignIn,
  passwordSignIn,
  registerWithClient,
  seedPasswordUser,
} from "../helpers/passkey-account.ts";

const unauthenticated = (path: string, method = "GET") =>
  new Request(`${authTestOrigin}${path}`, {
    method,
    headers: { origin: authTestOrigin, "content-type": "application/json" },
    body: method === "GET" ? undefined : "{}",
  });

Deno.test("profile and preference routes refuse anonymous callers", async () => {
  const fixture = await openAuthFixture();
  try {
    for (
      const [method, path] of [
        ["GET", "/v1/me/profile"],
        ["PATCH", "/v1/me/profile"],
        ["GET", "/v1/user-preferences"],
        ["PATCH", "/v1/user-preferences"],
      ]
    ) {
      const response = await fixture.app.fetch(unauthenticated(path, method));
      assertEquals(response.status, 401, `${method} ${path}`);
      assertEquals((await response.json()).code, "AUTH_REQUIRED");
    }
  } finally {
    await fixture.close();
  }
});

Deno.test("a profile write can only reach the session's own user", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, true);
  try {
    const victim = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    )).json() as Json;
    for (
      const smuggled of [
        { userId: victim.principalId },
        { principalId: victim.principalId },
        { id: victim.principalId },
        { email: "takeover@example.test" },
        { role: "admin" },
        { organizationId: seeded.organizationId },
        { emailVerified: true },
      ]
    ) {
      const response = await call(
        fixture,
        "PATCH",
        "/v1/me/profile",
        seeded.developerCookie,
        {
          body: { title: "Smuggler", ...smuggled },
          headers: {
            "idempotency-key": crypto.randomUUID(),
            "if-match": '"v1"',
          },
        },
      );
      assert(
        response.status >= 400 && response.status < 500,
        `${JSON.stringify(smuggled)} -> ${response.status}`,
      );
    }
    const after = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    )).json() as Json;
    assertEquals(after, victim);
    const own = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.developerCookie,
    )).json() as Json;
    assertEquals(own.title, null);
    assertEquals(own.email, seeded.developerEmail);
    assertEquals(own.version, 1);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("the provider update-user passthrough cannot write bounded profile fields", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, false);
  try {
    const before = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    )).json() as Json;
    for (
      const field of [
        { firstName: "x".repeat(5000) },
        { lastName: "Bypass" },
        { title: "Bypass" },
        { profileVersion: 99 },
      ]
    ) {
      const response = await fixture.app.fetch(
        authRequest("/api/auth/update-user", field, {
          cookie: seeded.adminCookie,
        }),
      );
      assert(
        response.status >= 400 && response.status < 500,
        `${JSON.stringify(Object.keys(field))} -> ${response.status}`,
      );
    }
    const after = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    )).json() as Json;
    assertEquals(after, before);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("profile image rejects non-HTTPS, credentialed, data and oversized URLs", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, false);
  try {
    for (
      const image of [
        "http://cdn.example.test/a.png",
        "https://user:secret@cdn.example.test/a.png",
        "data:image/png;base64,iVBORw0KGgo=",
        "javascript:alert(1)",
        "//cdn.example.test/a.png",
        `https://cdn.example.test/${"a".repeat(2100)}`,
      ]
    ) {
      const response = await call(
        fixture,
        "PATCH",
        "/v1/me/profile",
        seeded.adminCookie,
        {
          body: { image },
          headers: {
            "idempotency-key": crypto.randomUUID(),
            "if-match": '"v1"',
          },
        },
      );
      assert(
        response.status === 422 || response.status === 400,
        `${image.slice(0, 40)} -> ${response.status}`,
      );
    }
    const unchanged = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    )).json() as Json;
    assertEquals(unchanged.image, null);
    assertEquals(unchanged.version, 1);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("mutating profile and preference routes enforce Origin before touching state", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, false);
  try {
    for (const origin of [undefined, "https://attacker.example.test"]) {
      const profile = await fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/me/profile`, {
          method: "PATCH",
          headers: {
            cookie: seeded.adminCookie,
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
            "if-match": '"v1"',
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify({ title: "Cross site" }),
        }),
      );
      assertEquals(profile.status, 403);
      const preferences = await fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/user-preferences`, {
          method: "PATCH",
          headers: {
            cookie: seeded.adminCookie,
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
            ...orgHeader(seeded.organizationId),
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify({ theme: "dark", expectedCasVersion: 0 }),
        }),
      );
      assertEquals(preferences.status, 403);
    }
    const profile = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    )).json() as Json;
    assertEquals(profile.title, null);
    const stored = await fixture.pgDatabase.query(
      "select 1 from bakery.user_preferences where organization_id = $1",
      [seeded.organizationId],
    );
    assertEquals(stored.rowCount, 0);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("preferences are unreachable without live membership and never cross people or organizations", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, true);
  const foreignOrganization = crypto.randomUUID();
  try {
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values ($1, 'Foreign Org', $2, '{}'::jsonb, now(), now(), 1)`,
      [foreignOrganization, `foreign-${suffix}`],
    );
    const foreign = await call(
      fixture,
      "GET",
      "/v1/user-preferences",
      seeded.developerCookie,
      { headers: orgHeader(foreignOrganization) },
    );
    // Cross-organization probes get the scoped 404, never a membership hint.
    assertEquals(foreign.status, 404);
    const foreignWrite = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.developerCookie,
      {
        body: { theme: "dark", expectedCasVersion: 0 },
        headers: {
          ...orgHeader(foreignOrganization),
          "idempotency-key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(foreignWrite.status, 404);
    const missingHeader = await call(
      fixture,
      "GET",
      "/v1/user-preferences",
      seeded.developerCookie,
    );
    assertEquals(missingHeader.status, 403);
    assertEquals((await missingHeader.json()).code, "SCOPE_REQUIRED");

    // Each person's row is their own; a smuggled principal changes nothing.
    const admin = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.adminCookie,
      {
        body: { theme: "dark", expectedCasVersion: 0 },
        headers: {
          ...orgHeader(seeded.organizationId),
          "idempotency-key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(admin.status, 200);
    const adminView = await admin.json() as Json;
    const smuggle = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.developerCookie,
      {
        body: {
          theme: "light",
          principalId: adminView.principalId,
          expectedCasVersion: 0,
        },
        headers: {
          ...orgHeader(seeded.organizationId),
          "idempotency-key": crypto.randomUUID(),
        },
      },
    );
    // The input schema is strict, so an unknown `principalId` key is refused.
    assertEquals(smuggle.status, 400);
    const adminAfter = await (await call(
      fixture,
      "GET",
      "/v1/user-preferences",
      seeded.adminCookie,
      { headers: orgHeader(seeded.organizationId) },
    )).json() as Json;
    assertEquals(adminAfter.theme, "dark");
    assertEquals(adminAfter.casVersion, 1);

    // Removing the membership closes the door immediately.
    await fixture.pgDatabase.query(
      `delete from bakery.organization_memberships
       where principal_id = (
         select principal.id from bakery.principals as principal
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
         where provider_user.email = $1)`,
      [seeded.developerEmail],
    );
    const removed = await call(
      fixture,
      "GET",
      "/v1/user-preferences",
      seeded.developerCookie,
      { headers: orgHeader(seeded.organizationId) },
    );
    assertEquals(removed.status, 404);
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.organizations where id = $1",
      [foreignOrganization],
    );
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("only an Admin may set the organization default language", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, true);
  try {
    const headers = orgHeader(seeded.organizationId);
    const developer = await call(
      fixture,
      "PATCH",
      `/v1/organizations/${seeded.organizationId}`,
      seeded.developerCookie,
      {
        body: { defaultLocale: "ar-XB" },
        headers: { ...headers, "if-match": '"v1"' },
      },
    );
    assertEquals(developer.status, 403);
    const read = await (await call(
      fixture,
      "GET",
      `/v1/organizations/${seeded.organizationId}`,
      seeded.developerCookie,
      { headers },
    )).json() as Json;
    assertEquals(read.defaultLocale, null);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("installation capabilities expose only the three public policy fields", async () => {
  const fixture = await openAuthFixture();
  try {
    const response = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/installation/capabilities`, {
        headers: { cookie: "better-auth.session_token=ignored" },
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as Json;
    assertEquals(Object.keys(body).sort(), [
      "organizationCreation",
      "registration",
      "ssoAvailable",
    ]);
    assertEquals(typeof body.registration, "string");
    assertEquals(typeof body.organizationCreation, "string");
    assertEquals(typeof body.ssoAvailable, "boolean");
  } finally {
    await fixture.close();
  }
});

Deno.test("a refused or foreign passkey delete leaves every bound session alive", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), true);
  const owner = {
    email: seeded.adminEmail,
    password: `Settings-${
      seeded.adminEmail.slice("settings-admin-".length, -"@example.test".length)
    }`,
  };
  const intruder = { email: seeded.developerEmail, password: owner.password };
  try {
    const authenticator = await newAuthenticator();
    const ownerCookie = await passwordSignIn(
      fixture,
      owner.email,
      owner.password,
    );
    const { passkey } = await registerWithClient(
      fixture,
      authenticator,
      ownerCookie,
      "Laptop",
    );
    const boundCookie = await passkeySignIn(fixture, authenticator);

    // Another person naming the owner's passkey id is refused, nothing deleted.
    const intruderCookie = await passwordSignIn(
      fixture,
      intruder.email,
      intruder.password,
    );
    const foreign = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: passkey.id },
      { cookie: intruderCookie },
    ));
    assert(foreign.status === 401 || foreign.status === 404);
    assertEquals((await meStatus(fixture, boundCookie)).status, 200);

    // No usable method would remain: the last-method guard refuses and the
    // passkey-bound session stays.
    await fixture.pgDatabase.query(
      `update public.account set password = null
        where "providerId" = 'credential' and "userId" = (
          select id from public."user" where email = $1)`,
      [owner.email],
    );
    const bound = clientWithJar(fixture, boundCookie);
    const refusal = await assertRejects(
      () => bound.client.passkey.deletePasskey({ id: passkey.id }),
      AuthProviderError,
    );
    assertEquals(refusal.code, "LAST_SIGN_IN_METHOD");
    assertEquals((await meStatus(fixture, boundCookie)).status, 200);
    assertEquals(
      (await bound.client.passkey.listUserPasskeys()).length,
      1,
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [owner.email, intruder.email]);
    await fixture.close();
  }
});

async function agedSession(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  email: string,
  factorVerified: boolean,
): Promise<{ cookie: string; token: string }> {
  const token = `sec-${crypto.randomUUID()}`;
  const now = Date.now();
  await fixture.pgDatabase.query(
    `insert into public.session
       (id, token, "userId", "expiresAt", "createdAt", "updatedAt", "factorVerifiedAt")
     values ($1, $2, $3, $4, $5, $5, $6)`,
    [
      crypto.randomUUID(),
      token,
      await userIdFor(fixture.pgDatabase, email),
      new Date(now + 3_600_000),
      new Date(now - 11 * 60_000),
      factorVerified ? new Date(now) : null,
    ],
  );
  return {
    token,
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
  };
}

const stampOf = async (
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  token: string,
) =>
  (await fixture.pgDatabase.query<{ at: Date | null }>(
    `select "reauthenticatedAt" as at from public.session where token = $1`,
    [token],
  )).rows[0].at;

Deno.test("blank re-authentication input never spends the lockout budget on a password account", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "reauth-blank");
  try {
    const { cookie, token } = await agedSession(fixture, email, true);
    const session = clientWithJar(fixture, cookie);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const failure = await assertRejects(
        () => session.client.reauthenticate({ password: "" }),
        AuthProviderError,
      );
      assertEquals(failure.code, "INVALID_PASSWORD");
    }
    assertEquals(await stampOf(fixture, token), null);
    await session.client.reauthenticate({ password });
    assert((await stampOf(fixture, token)) !== null);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a passwordless account gets PASSWORD_NOT_SET for any input without spending budget", async () => {
  const fixture = await openAuthFixture();
  const { email } = await seedPasswordUser(fixture, "reauth-nopw-budget");
  try {
    await fixture.pgDatabase.query(
      `update public.account set password = null
        where "providerId" = 'credential' and "userId" = $1`,
      [await userIdFor(fixture.pgDatabase, email)],
    );
    const { cookie, token } = await agedSession(fixture, email, true);
    const session = clientWithJar(fixture, cookie);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const failure = await assertRejects(
        () =>
          session.client.reauthenticate({
            password: attempt % 2 === 0 ? "" : "wrong-password-0",
          }),
        AuthProviderError,
      );
      assertEquals(failure.code, "PASSWORD_NOT_SET");
    }
    assertEquals(await stampOf(fixture, token), null);
    const spent = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from public.verification
        where identifier like $1`,
      [`bakery-reauth-failure-${await userIdFor(fixture.pgDatabase, email)}-%`],
    );
    assertEquals(spent.rows[0].n, "0");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a wrong password never stamps the session and repeated failures lock re-authentication", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "reauth-lock");
  try {
    const { cookie, token } = await agedSession(fixture, email, true);
    const session = clientWithJar(fixture, cookie);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await assertRejects(
        () => session.client.reauthenticate({ password: "wrong-password-0" }),
        AuthProviderError,
      );
      assertEquals(failure.code, "INVALID_PASSWORD");
    }
    assertEquals(await stampOf(fixture, token), null);

    // Budget spent: even the right password is refused until the window lapses.
    const locked = await assertRejects(
      () => session.client.reauthenticate({ password }),
      AuthProviderError,
    );
    assertEquals(locked.code, "RATE_LIMITED");
    assertEquals(locked.status, 429);
    assertEquals(await stampOf(fixture, token), null);
    const refused = await assertRejects(
      () => session.client.passkey.generateRegisterOptions({}),
      AuthProviderError,
    );
    assertEquals(refused.code, "FRESH_SIGN_IN_REQUIRED");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a pending-factor session cannot re-authenticate", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "reauth-pending");
  try {
    const enrolled = await enrollTotp(
      fixture,
      await passwordSignIn(fixture, email, password),
      password,
    );
    assert(enrolled.cookie.length > 0);
    const { cookie, token } = await agedSession(fixture, email, false);
    const failure = await assertRejects(
      () => clientWithJar(fixture, cookie).client.reauthenticate({ password }),
      AuthProviderError,
    );
    assertEquals(failure.code, "TWO_FACTOR_REQUIRED");
    assertEquals(await stampOf(fixture, token), null);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("re-authentication only ever stamps the caller's own session", async () => {
  const fixture = await openAuthFixture();
  const seeded = await seed(fixture, crypto.randomUUID(), true);
  const owner = {
    email: seeded.adminEmail,
    password: `Settings-${
      seeded.adminEmail.slice("settings-admin-".length, -"@example.test".length)
    }`,
  };
  const other = {
    email: seeded.developerEmail,
    password: `Distinct-${crypto.randomUUID()}`,
  };
  try {
    // Give the second person a different password than the owner's.
    await clientWithJar(fixture, seeded.developerCookie).client.changePassword({
      currentPassword: owner.password,
      newPassword: other.password,
      revokeOtherSessions: false,
    });
    const ownerSession = await agedSession(fixture, owner.email, true);
    const otherSession = await agedSession(fixture, other.email, true);

    // The other person's cookie with the owner's password proves nothing.
    const failure = await assertRejects(
      () =>
        clientWithJar(fixture, otherSession.cookie).client.reauthenticate({
          password: owner.password,
        }),
      AuthProviderError,
    );
    assertEquals(failure.code, "INVALID_PASSWORD");
    assertEquals(await stampOf(fixture, ownerSession.token), null);
    assertEquals(await stampOf(fixture, otherSession.token), null);

    await clientWithJar(fixture, otherSession.cookie).client.reauthenticate({
      password: other.password,
    });
    assert(await stampOf(fixture, otherSession.token) !== null);
    assertEquals(await stampOf(fixture, ownerSession.token), null);

    // Anonymous callers are refused outright.
    const anonymous = await fixture.app.fetch(authRequest(
      "/api/auth/bakery/reauthenticate",
      { password: owner.password },
    ));
    assert(anonymous.status === 401 || anonymous.status === 403);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [owner.email, other.email]);
    await fixture.close();
  }
});

Deno.test("a passwordless account is told its password is not set and no session is stamped", async () => {
  const fixture = await openAuthFixture();
  const { email } = await seedPasswordUser(fixture, "reauth-nopw");
  try {
    const { cookie, token } = await agedSession(fixture, email, true);
    await fixture.pgDatabase.query(
      `update public.account set password = null
        where "providerId" = 'credential' and "userId" = $1`,
      [await userIdFor(fixture.pgDatabase, email)],
    );
    const failure = await assertRejects(
      () =>
        clientWithJar(fixture, cookie).client.reauthenticate({
          password: "any-password-value",
        }),
      AuthProviderError,
    );
    assertEquals(failure.code, "PASSWORD_NOT_SET");
    assertEquals(await stampOf(fixture, token), null);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
