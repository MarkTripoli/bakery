import { assert, assertEquals, assertRejects } from "@std/assert";
import { AuthProviderError } from "../../packages/contracts/src/auth-provider-client.ts";
import { createTotpOffsets, totpCode } from "../helpers/totp.ts";
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

Deno.test("profile round trip persists, syncs the display name, conflicts on a stale version and replays", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, false);
  try {
    const read = await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    );
    assertEquals(read.status, 200);
    const before = await read.json() as Json;
    assertEquals(before.name, "Settings Admin");
    assertEquals(before.firstName, null);
    assertEquals(before.email, seeded.adminEmail);
    assertEquals(before.version, 1);
    assertEquals(typeof before.emailVerified, "boolean");
    await fixture.pgDatabase.query(
      'update public."user" set "emailVerified" = not $2::boolean where id = $1',
      [
        await userIdFor(fixture.pgDatabase, seeded.adminEmail),
        before.emailVerified,
      ],
    );
    const flipped = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    )).json() as Json;
    assertEquals(flipped.emailVerified, !before.emailVerified);

    const key = crypto.randomUUID();
    const patch = {
      name: "  Ada Lovelace ",
      firstName: "Ada",
      lastName: "",
      title: "Engineer",
      image: "https://cdn.example.test/ada.png",
    };
    const updated = await call(
      fixture,
      "PATCH",
      "/v1/me/profile",
      seeded.adminCookie,
      {
        body: patch,
        headers: { "idempotency-key": key, "if-match": '"v1"' },
      },
    );
    assertEquals(updated.status, 200, await updated.clone().text());
    const after = await updated.json() as Json;
    assertEquals(after.name, "Ada Lovelace");
    assertEquals(after.firstName, "Ada");
    assertEquals(after.lastName, null);
    assertEquals(after.title, "Engineer");
    assertEquals(after.version, 2);

    const persisted = await (await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.adminCookie,
    )).json() as Json;
    assertEquals(persisted, after);

    const identity = await (await call(
      fixture,
      "GET",
      "/v1/me",
      seeded.adminCookie,
    )).json() as Json;
    assertEquals(identity.displayName, "Ada Lovelace");

    const replay = await call(
      fixture,
      "PATCH",
      "/v1/me/profile",
      seeded.adminCookie,
      {
        body: patch,
        headers: { "idempotency-key": key, "if-match": '"v1"' },
      },
    );
    assertEquals(replay.status, 200);
    assertEquals(replay.headers.get("idempotent-replayed"), "true");
    assertEquals(await replay.json(), after);

    const mismatch = await call(
      fixture,
      "PATCH",
      "/v1/me/profile",
      seeded.adminCookie,
      {
        body: { ...patch, title: "Other" },
        headers: { "idempotency-key": key, "if-match": '"v1"' },
      },
    );
    assertEquals(mismatch.status, 422);
    assertEquals((await mismatch.json()).code, "IDEMPOTENCY_PAYLOAD_MISMATCH");

    const stale = await call(
      fixture,
      "PATCH",
      "/v1/me/profile",
      seeded.adminCookie,
      {
        body: { title: "Stale" },
        headers: { "idempotency-key": crypto.randomUUID(), "if-match": '"v1"' },
      },
    );
    assertEquals(stale.status, 409);
    assertEquals((await stale.json()).code, "VERSION_CONFLICT");

    const missingMatch = await call(
      fixture,
      "PATCH",
      "/v1/me/profile",
      seeded.adminCookie,
      {
        body: { title: "No precondition" },
        headers: { "idempotency-key": crypto.randomUUID() },
      },
    );
    assertEquals(missingMatch.status, 428);

    const invalid = await call(
      fixture,
      "PATCH",
      "/v1/me/profile",
      seeded.adminCookie,
      {
        body: { image: "http://cdn.example.test/ada.png" },
        headers: { "idempotency-key": crypto.randomUUID(), "if-match": '"v2"' },
      },
    );
    assertEquals(invalid.status, 422);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("profile needs no organization membership", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, true);
  try {
    await fixture.pgDatabase.query(
      `delete from bakery.organization_memberships
       where principal_id = (
         select principal.id from bakery.principals as principal
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
         where provider_user.email = $1)`,
      [seeded.developerEmail],
    );
    const read = await call(
      fixture,
      "GET",
      "/v1/me/profile",
      seeded.developerCookie,
    );
    assertEquals(read.status, 200);
    const updated = await call(
      fixture,
      "PATCH",
      "/v1/me/profile",
      seeded.developerCookie,
      {
        body: { title: "Between teams" },
        headers: { "idempotency-key": crypto.randomUUID(), "if-match": '"v1"' },
      },
    );
    assertEquals(updated.status, 200, await updated.clone().text());
    assertEquals((await updated.json()).title, "Between teams");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("preferences persist per organization, compare-and-swap, replay and write the account language", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, false);
  const secondOrganization = crypto.randomUUID();
  try {
    const headers = orgHeader(seeded.organizationId);
    const initial = await (await call(
      fixture,
      "GET",
      "/v1/user-preferences",
      seeded.adminCookie,
      { headers },
    )).json() as Json;
    assertEquals(initial.id, null);
    assertEquals(initial.casVersion, 0);
    assertEquals(initial.theme, "system");
    assertEquals(initial.locale, null);
    assertEquals(initial.timeZone, null);
    assertEquals(initial.availableLocales, ["en", "en-XA", "ar-XB"]);

    const key = crypto.randomUUID();
    const change = {
      theme: "dark",
      timeZone: "europe/berlin",
      locale: "en-XA",
      expectedCasVersion: 0,
    };
    const saved = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.adminCookie,
      {
        body: change,
        headers: { ...headers, "idempotency-key": key },
      },
    );
    assertEquals(saved.status, 200, await saved.clone().text());
    const after = await saved.json() as Json;
    assertEquals(after.theme, "dark");
    assertEquals(after.timeZone, "Europe/Berlin");
    assertEquals(after.locale, "en-XA");
    assertEquals(after.effectiveLocale, "en-XA");
    assertEquals(after.casVersion, 1);
    assert(typeof after.id === "string");

    const principal = await fixture.pgDatabase.query<
      { preferred_locale: string }
    >(
      `select principal.preferred_locale from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       where provider_user.email = $1`,
      [seeded.adminEmail],
    );
    assertEquals(principal.rows[0].preferred_locale, "en-XA");

    const replay = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.adminCookie,
      {
        body: change,
        headers: { ...headers, "idempotency-key": key },
      },
    );
    assertEquals(replay.headers.get("idempotent-replayed"), "true");
    assertEquals(await replay.json(), after);

    const conflict = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.adminCookie,
      {
        body: { theme: "light", expectedCasVersion: 0 },
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      },
    );
    assertEquals(conflict.status, 409);
    assertEquals((await conflict.json()).code, "VERSION_CONFLICT");

    const empty = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.adminCookie,
      {
        body: { expectedCasVersion: 1 },
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      },
    );
    assertEquals(empty.status, 422);
    const badZone = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.adminCookie,
      {
        body: { timeZone: "Mars/Olympus", expectedCasVersion: 1 },
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      },
    );
    assertEquals(badZone.status, 422);
    const badLocale = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.adminCookie,
      {
        body: { locale: "fr", expectedCasVersion: 1 },
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      },
    );
    assertEquals(badLocale.status, 422);

    const events = await fixture.pgDatabase.query<
      { aggregate_version: number }
    >(
      `select aggregate_version from bakery.domain_events
       where organization_id = $1 and event_type = 'user.preferences_changed'`,
      [seeded.organizationId],
    );
    assertEquals(events.rows.map((row) => row.aggregate_version), [1]);

    // A second organization keeps its own theme and time zone; the language
    // is account-wide.
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values ($1, 'Second Settings Org', $2, '{}'::jsonb, now(), now(), 1)`,
      [secondOrganization, `second-settings-${suffix}`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status,
        joined_at, created_at, updated_at, version
      ) select gen_random_uuid(), $1, principal.id, 'admin', 'active',
          now(), now(), now(), 1
        from bakery.principals as principal
        join public."user" as provider_user
          on provider_user.id = principal.provider_user_id
        where provider_user.email = $2`,
      [secondOrganization, seeded.adminEmail],
    );
    const other = await (await call(
      fixture,
      "GET",
      "/v1/user-preferences",
      seeded.adminCookie,
      { headers: orgHeader(secondOrganization) },
    )).json() as Json;
    assertEquals(other.theme, "system");
    assertEquals(other.timeZone, null);
    assertEquals(other.casVersion, 0);
    assertEquals(other.locale, "en-XA");
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.organizations where id = $1",
      [secondOrganization],
    );
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("effective locale falls back preference, organization default, Accept-Language, English", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, true);
  try {
    const headers = orgHeader(seeded.organizationId);
    const identity = async (acceptLanguage: string) => {
      const response = await call(
        fixture,
        "GET",
        "/v1/me",
        seeded.developerCookie,
        {
          headers: { ...headers, "accept-language": acceptLanguage },
        },
      );
      assertEquals(response.status, 200);
      return await response.json() as Json;
    };
    // No saved language and no organization default: Accept-Language, then
    // English.
    assertEquals((await identity("en-XA")).locale, "en-XA");
    assertEquals((await identity("fr")).locale, "en");

    const organization = await call(
      fixture,
      "GET",
      `/v1/organizations/${seeded.organizationId}`,
      seeded.adminCookie,
      { headers },
    );
    const { version } = await organization.json() as { version: number };
    const setDefault = await call(
      fixture,
      "PATCH",
      `/v1/organizations/${seeded.organizationId}`,
      seeded.adminCookie,
      {
        body: { defaultLocale: "ar-xb" },
        headers: {
          ...headers,
          "if-match": `"v${version}"`,
          "idempotency-key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(setDefault.status, 200, await setDefault.clone().text());
    const updated = await setDefault.json() as Json;
    assertEquals(updated.defaultLocale, "ar-XB");
    assertEquals(updated.version, version + 1);

    const viaDefault = await identity("en-XA");
    assertEquals(viaDefault.locale, "ar-XB");
    assertEquals(viaDefault.direction, "rtl");

    const preference = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.developerCookie,
      {
        body: {
          locale: "en-XA",
          timeZone: "Asia/Tokyo",
          expectedCasVersion: 0,
        },
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      },
    );
    assertEquals(preference.status, 200, await preference.clone().text());
    const viaPreference = await identity("en");
    assertEquals(viaPreference.locale, "en-XA");
    assertEquals(viaPreference.timeZone, "Asia/Tokyo");

    const cleared = await call(
      fixture,
      "PATCH",
      "/v1/user-preferences",
      seeded.developerCookie,
      {
        body: { locale: null, expectedCasVersion: 1 },
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      },
    );
    assertEquals(cleared.status, 200);
    assertEquals((await identity("en")).locale, "ar-XB");

    // An Admin clearing the organization default restores Accept-Language.
    const current = await (await call(
      fixture,
      "GET",
      `/v1/organizations/${seeded.organizationId}`,
      seeded.adminCookie,
      { headers },
    )).json() as { version: number };
    const clearDefault = await call(
      fixture,
      "PATCH",
      `/v1/organizations/${seeded.organizationId}`,
      seeded.adminCookie,
      {
        body: { defaultLocale: null },
        headers: {
          ...headers,
          "if-match": `"v${current.version}"`,
          "idempotency-key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(clearDefault.status, 200, await clearDefault.clone().text());
    assertEquals((await clearDefault.json()).defaultLocale, null);
    assertEquals((await identity("en-XA")).locale, "en-XA");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("organization default language is Admin-only, version-checked and limited to offered locales", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, true);
  try {
    const headers = orgHeader(seeded.organizationId);
    const path = `/v1/organizations/${seeded.organizationId}`;
    const read =
      await (await call(fixture, "GET", path, seeded.developerCookie, {
        headers,
      })).json() as Json;
    assertEquals(read.defaultLocale, null);

    const developer = await call(
      fixture,
      "PATCH",
      path,
      seeded.developerCookie,
      {
        body: { defaultLocale: "en-XA" },
        headers: {
          ...headers,
          "if-match": `"v${read.version}"`,
          "idempotency-key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(developer.status, 403);

    const unavailable = await call(fixture, "PATCH", path, seeded.adminCookie, {
      body: { defaultLocale: "fr" },
      headers: {
        ...headers,
        "if-match": `"v${read.version}"`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    assertEquals(unavailable.status, 422);

    const admin = await call(fixture, "PATCH", path, seeded.adminCookie, {
      body: { defaultLocale: "en-XA" },
      headers: {
        ...headers,
        "if-match": `"v${read.version}"`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    assertEquals(admin.status, 200);

    const stale = await call(fixture, "PATCH", path, seeded.adminCookie, {
      body: { defaultLocale: "en" },
      headers: {
        ...headers,
        "if-match": `"v${read.version}"`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    assertEquals(stale.status, 409);
    assertEquals((await stale.json()).code, "VERSION_CONFLICT");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("organization update without If-Match is refused with 428 and a stale one conflicts", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const seeded = await seed(fixture, suffix, true);
  try {
    const headers = orgHeader(seeded.organizationId);
    const path = `/v1/organizations/${seeded.organizationId}`;
    const read = await (await call(fixture, "GET", path, seeded.adminCookie, {
      headers,
    })).json() as Json;

    const missing = await call(fixture, "PATCH", path, seeded.adminCookie, {
      body: { defaultLocale: "en-XA" },
      headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    });
    assertEquals(missing.status, 428);
    await missing.body?.cancel();

    // The refused write changed nothing: the version the person read still applies.
    const unchanged =
      await (await call(fixture, "GET", path, seeded.adminCookie, {
        headers,
      })).json() as Json;
    assertEquals(unchanged.version, read.version);
    assertEquals(unchanged.defaultLocale, read.defaultLocale);

    const saved = await call(fixture, "PATCH", path, seeded.adminCookie, {
      body: { defaultLocale: "en-XA" },
      headers: {
        ...headers,
        "if-match": `"v${read.version}"`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    assertEquals(saved.status, 200);
    await saved.body?.cancel();

    const stale = await call(fixture, "PATCH", path, seeded.adminCookie, {
      body: { defaultLocale: "en" },
      headers: {
        ...headers,
        "if-match": `"v${read.version}"`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    assertEquals(stale.status, 409);
    assertEquals((await stale.json()).code, "VERSION_CONFLICT");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, seeded.emails);
    await fixture.close();
  }
});

Deno.test("installation capabilities are public and report the live policy projection", async () => {
  const fixture = await openAuthFixture({
    installationPolicy: {
      registrationMode: "closed",
      organizationCreationPolicy: "any_user",
    },
  });
  try {
    const response = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/installation/capabilities`),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      registration: "closed",
      organizationCreation: "any_user",
      ssoAvailable: false,
    });
  } finally {
    await fixture.close();
  }
});

async function boundSessionCount(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  passkeyId: string,
): Promise<number> {
  const rows = await fixture.pgDatabase.query<{ count: string }>(
    'select count(*)::text as count from public.session where "passkeyId" = $1',
    [passkeyId],
  );
  return Number(rows.rows[0].count);
}

Deno.test("the typed client registers, lists, renames and removes a passkey with public fields only", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "typed-passkey");
  try {
    const authenticator = await newAuthenticator();
    const cookie = await passwordSignIn(fixture, email, password);
    const { passkey } = await registerWithClient(
      fixture,
      authenticator,
      cookie,
      "Laptop",
    );
    assertEquals(passkey.name, "Laptop");
    assertEquals(passkey.credentialId, authenticator.credentialId);

    const session = clientWithJar(fixture, cookie);
    const listed = await session.client.passkey.listUserPasskeys();
    assertEquals(listed.length, 1);
    assertEquals(Object.keys(listed[0]).sort(), [
      "backedUp",
      "createdAt",
      "credentialId",
      "deviceType",
      "id",
      "name",
      "transports",
    ]);
    const renamed = await session.client.passkey.updatePasskey({
      id: passkey.id,
      name: "Desk",
    });
    assertEquals(renamed.name, "Desk");
    await session.client.passkey.deletePasskey({ id: passkey.id });
    assertEquals(await session.client.passkey.listUserPasskeys(), []);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("deleting a passkey deletes the sessions it created and keeps every other session", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "bound-revoke");
  try {
    const laptop = await newAuthenticator();
    const phone = await newAuthenticator();
    const passwordCookie = await passwordSignIn(fixture, email, password);
    const laptopKey = (await registerWithClient(
      fixture,
      laptop,
      passwordCookie,
      "Laptop",
    )).passkey;
    const phoneKey = (await registerWithClient(
      fixture,
      phone,
      passwordCookie,
      "Phone",
    )).passkey;

    const laptopCookie = await passkeySignIn(fixture, laptop);
    const phoneCookie = await passkeySignIn(fixture, phone);
    assertEquals((await meStatus(fixture, laptopCookie)).status, 200);
    assertEquals(await boundSessionCount(fixture, laptopKey.id), 1);
    assertEquals(await boundSessionCount(fixture, phoneKey.id), 1);

    // The password session carries no passkey binding.
    const unbound = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from public.session
        where "userId" = $1 and "passkeyId" is null`,
      [await userIdFor(fixture.pgDatabase, email)],
    );
    assertEquals(Number(unbound.rows[0].count), 1);

    const removal = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: laptopKey.id },
      { cookie: passwordCookie },
    ));
    assertEquals(removal.status, 200);

    const revoked = await meStatus(fixture, laptopCookie);
    assertEquals(revoked.status, 401);
    assertEquals(
      (revoked.body as { code?: string }).code ??
        (revoked.body as { problem?: { code?: string } }).problem?.code,
      "AUTH_INVALID",
    );
    assertEquals(await boundSessionCount(fixture, laptopKey.id), 0);
    assertEquals((await meStatus(fixture, passwordCookie)).status, 200);
    assertEquals((await meStatus(fixture, phoneCookie)).status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a passkey-bound session that removes its own passkey loses access in the same request path", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "bound-self");
  try {
    const authenticator = await newAuthenticator();
    const passwordCookie = await passwordSignIn(fixture, email, password);
    const { passkey } = await registerWithClient(
      fixture,
      authenticator,
      passwordCookie,
      "Laptop",
    );
    const boundCookie = await passkeySignIn(fixture, authenticator);
    const bound = clientWithJar(fixture, boundCookie);
    await bound.client.passkey.deletePasskey({ id: passkey.id });
    assertEquals((await meStatus(fixture, boundCookie)).status, 401);
    assertEquals((await meStatus(fixture, passwordCookie)).status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("password change refuses a wrong or out-of-policy password and keeps sessions as asked", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "pw-change");
  try {
    const current = await passwordSignIn(fixture, email, password);
    const other = await passwordSignIn(fixture, email, password);
    const session = clientWithJar(fixture, current);
    const failure = async (input: {
      currentPassword: string;
      newPassword: string;
    }) =>
      (await assertRejects(
        () =>
          session.client.changePassword({
            ...input,
            revokeOtherSessions: false,
          }),
        AuthProviderError,
      )).code;
    assertEquals(
      await failure({
        currentPassword: "wrong-password-value",
        newPassword: `${password}-x`,
      }),
      "INVALID_PASSWORD",
    );
    assertEquals(
      await failure({ currentPassword: password, newPassword: "short" }),
      "PASSWORD_TOO_SHORT",
    );
    assertEquals(
      await failure({
        currentPassword: password,
        newPassword: "x".repeat(300),
      }),
      "PASSWORD_TOO_LONG",
    );

    // Without revoke: the other session survives and the new password works.
    const second = `${password}-second`;
    await session.client.changePassword({
      currentPassword: password,
      newPassword: second,
      revokeOtherSessions: false,
    });
    assertEquals((await meStatus(fixture, other)).status, 200);
    await passwordSignIn(fixture, email, second);

    // With revoke: the other session dies, the calling person stays signed in.
    const third = `${password}-third`;
    const keep = clientWithJar(fixture, other);
    await keep.client.changePassword({
      currentPassword: second,
      newPassword: third,
      revokeOtherSessions: true,
    });
    assertEquals((await meStatus(fixture, current)).status, 401);
    const replacement = keep.sessionCookie();
    assert(replacement !== null);
    assertEquals((await meStatus(fixture, replacement)).status, 200);
    await passwordSignIn(fixture, email, third);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a stale session is refused for passkey registration with the fresh-sign-in code", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "stale-add");
  try {
    await passwordSignIn(fixture, email, password);
    const staleToken = `stale-${crypto.randomUUID()}`;
    const now = new Date();
    await fixture.pgDatabase.query(
      `insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
       values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        staleToken,
        await userIdFor(fixture.pgDatabase, email),
        new Date(now.getTime() + 3_600_000),
        new Date(now.getTime() - 11 * 60_000),
      ],
    );
    const stale = clientWithJar(
      fixture,
      await signSessionCookie(staleToken, fixture.config.auth!.secret),
    );
    const failure = await assertRejects(
      () => stale.client.passkey.generateRegisterOptions({}),
      AuthProviderError,
    );
    assertEquals(failure.code, "FRESH_SIGN_IN_REQUIRED");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

async function sessionCountFor(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  email: string,
): Promise<number> {
  const rows = await fixture.pgDatabase.query<{ count: string }>(
    `select count(*)::text as count from public.session where "userId" = $1`,
    [await userIdFor(fixture.pgDatabase, email)],
  );
  return Number(rows.rows[0].count);
}

/** Inserts a session aged `ageMinutes`, optionally with a factor proof aged `factorAgeMinutes`. */
async function insertAgedSession(
  fixture: Awaited<ReturnType<typeof openAuthFixture>>,
  email: string,
  options: { ageMinutes: number; factorAgeMinutes?: number },
): Promise<{ cookie: string; token: string }> {
  const token = `aged-${crypto.randomUUID()}`;
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
      new Date(now - options.ageMinutes * 60_000),
      options.factorAgeMinutes === undefined
        ? null
        : new Date(now - options.factorAgeMinutes * 60_000),
    ],
  );
  return {
    token,
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
  };
}

Deno.test("reauthenticate stamps the current session and unlocks passkey register and delete without a new session", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "reauth-ok");
  try {
    const { cookie, token } = await insertAgedSession(fixture, email, {
      ageMinutes: 11,
    });
    const session = clientWithJar(fixture, cookie);
    const refused = await assertRejects(
      () => session.client.passkey.generateRegisterOptions({}),
      AuthProviderError,
    );
    assertEquals(refused.code, "FRESH_SIGN_IN_REQUIRED");
    const sessionsBefore = await sessionCountFor(fixture, email);

    await session.client.reauthenticate({ password });
    assertEquals(await sessionCountFor(fixture, email), sessionsBefore);
    const stamped = await fixture.pgDatabase.query<{ at: Date | null }>(
      `select "reauthenticatedAt" as at from public.session where token = $1`,
      [token],
    );
    assert(stamped.rows[0].at !== null);

    // Same session, same cookie: register then delete in place.
    const authenticator = await newAuthenticator();
    const options = await session.client.passkey.generateRegisterOptions({});
    const passkey = await session.client.passkey.verifyRegistration({
      response: await authenticator.register({ challenge: options.challenge }),
      name: "Laptop",
    });
    await session.client.passkey.deletePasskey({ id: passkey.id });
    assertEquals(await sessionCountFor(fixture, email), sessionsBefore);
    assertEquals((await meStatus(fixture, cookie)).status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a TOTP user re-proves the password then the factor in place and removes a passkey without losing the cookie", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "reauth-totp");
  const nextOffset = createTotpOffsets();
  try {
    const signedIn = await passwordSignIn(fixture, email, password);
    const enrolled = await enrollTotp(fixture, signedIn, password);
    const authenticator = await newAuthenticator();
    const { passkey } = await registerWithClient(
      fixture,
      authenticator,
      enrolled.cookie,
      "Laptop",
    );
    // Age the only session past both freshness windows.
    await fixture.pgDatabase.query(
      `update public.session
          set "createdAt" = now() - interval '11 minutes',
              "factorVerifiedAt" = now() - interval '6 minutes'
        where "userId" = $1`,
      [await userIdFor(fixture.pgDatabase, email)],
    );
    const session = clientWithJar(fixture, enrolled.cookie);
    const sessionsBefore = await sessionCountFor(fixture, email);

    const stale = await assertRejects(
      () => session.client.passkey.deletePasskey({ id: passkey.id }),
      AuthProviderError,
    );
    assertEquals(stale.code, "FRESH_SIGN_IN_REQUIRED");
    // The refused call must not have cleared the cookie.
    assertEquals((await meStatus(fixture, enrolled.cookie)).status, 200);

    await session.client.reauthenticate({ password });
    const factor = await assertRejects(
      () => session.client.passkey.deletePasskey({ id: passkey.id }),
      AuthProviderError,
    );
    assertEquals(factor.code, "FACTOR_PROOF_REQUIRED");

    await session.client.twoFactor.verifyTotp({
      code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }),
    });
    await session.client.passkey.deletePasskey({ id: passkey.id });
    assertEquals(await session.client.passkey.listUserPasskeys(), []);
    assertEquals(await sessionCountFor(fixture, email), sessionsBefore);
    assertEquals((await meStatus(fixture, enrolled.cookie)).status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a TOTP user's password change that revokes other sessions keeps the calling session fully verified", async () => {
  const fixture = await openAuthFixture();
  const { email, password } = await seedPasswordUser(fixture, "pw-totp");
  try {
    const signedIn = await passwordSignIn(fixture, email, password);
    const enrolled = await enrollTotp(fixture, signedIn, password);
    const session = clientWithJar(fixture, enrolled.cookie);
    await session.client.changePassword({
      currentPassword: password,
      newPassword: `${password}-next`,
      revokeOtherSessions: true,
    });
    const replacement = session.sessionCookie();
    assert(replacement !== null);
    assertEquals((await meStatus(fixture, replacement)).status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a passwordless account adds and removes passkeys on a fresh session and is refused fresh only when stale", async () => {
  const fixture = await openAuthFixture();
  const { email } = await seedPasswordUser(fixture, "reauth-nopw-flow");
  try {
    await fixture.pgDatabase.query(
      `update public.account set password = null
        where "providerId" = 'credential' and "userId" = $1`,
      [await userIdFor(fixture.pgDatabase, email)],
    );
    const fresh = await insertAgedSession(fixture, email, { ageMinutes: 1 });
    const session = clientWithJar(fixture, fresh.cookie);
    const sessionsBefore = await sessionCountFor(fixture, email);

    // The password step has nothing to prove; the passkey actions still work.
    // Blank and non-blank input alike report the missing password.
    for (const typed of ["", " ", "anything-typed-0"]) {
      const noPassword = await assertRejects(
        () => session.client.reauthenticate({ password: typed }),
        AuthProviderError,
      );
      assertEquals(noPassword.code, "PASSWORD_NOT_SET");
    }
    const register = async (name: string) => {
      const authenticator = await newAuthenticator();
      const options = await session.client.passkey.generateRegisterOptions({
        name,
      });
      return session.client.passkey.verifyRegistration({
        response: await authenticator.register({
          challenge: options.challenge,
        }),
        name,
      });
    };
    const first = await register("Laptop");
    await register("Phone");
    await session.client.passkey.deletePasskey({ id: first.id });
    assertEquals(await sessionCountFor(fixture, email), sessionsBefore);
    assertEquals((await meStatus(fixture, fresh.cookie)).status, 200);

    // A stale passwordless session is asked for a fresh sign-in, nothing else.
    const stale = clientWithJar(
      fixture,
      (await insertAgedSession(fixture, email, { ageMinutes: 11 })).cookie,
    );
    const refused = await assertRejects(
      () => stale.client.passkey.generateRegisterOptions({}),
      AuthProviderError,
    );
    assertEquals(refused.code, "FRESH_SIGN_IN_REQUIRED");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
