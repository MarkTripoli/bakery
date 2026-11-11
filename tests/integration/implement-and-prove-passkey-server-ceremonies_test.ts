import { assert, assertEquals } from "@std/assert";
import { AuthProblemCode } from "../../packages/contracts/src/http.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  type AppFixture,
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  enrollTotp,
  get,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
  userIdFor,
} from "../helpers/auth.ts";
import { createTotpOffsets, totpCode } from "../helpers/totp.ts";
import {
  challengeCookie,
  challengeIdentifier,
  createSoftwareAuthenticator,
  type SoftwareAuthenticator,
} from "../helpers/webauthn.ts";

/** The plugin derives the RP ID from the public origin (`authTestOrigin`). */
const PASSKEY_RP_ID = "127.0.0.1";

/** The eleven columns the plugin's schema declares; no private key can be among them. */
const PASSKEY_COLUMNS = [
  "aaguid",
  "backedUp",
  "counter",
  "createdAt",
  "credentialID",
  "deviceType",
  "id",
  "name",
  "publicKey",
  "transports",
  "userId",
];

/** `GET generate-register-options`: the challenge, the cookies the ceremony must echo, the stored `verification.identifier`. */
async function registerOptions(fixture: AppFixture, cookie: string) {
  const response = await fixture.app.fetch(
    get("/api/auth/passkey/generate-register-options", cookie),
  );
  assertEquals(response.status, 200);
  const options = await response.json() as { challenge: string };
  return {
    challenge: options.challenge,
    cookies: `${cookie}; ${challengeCookie(response)}`,
    identifier: challengeIdentifier(response),
  };
}

async function registerPasskey(
  fixture: AppFixture,
  authenticator: SoftwareAuthenticator,
  cookie: string,
  name: string,
): Promise<Response> {
  const options = await registerOptions(fixture, cookie);
  return await fixture.app.fetch(authRequest(
    "/api/auth/passkey/verify-registration",
    {
      response: await authenticator.register({ challenge: options.challenge }),
      name,
    },
    { cookie: options.cookies },
  ));
}

/** Anonymous sign-in ceremony: options with no session, then the assertion. */
async function signInWithPasskey(
  fixture: AppFixture,
  authenticator: SoftwareAuthenticator,
): Promise<Response> {
  const response = await fixture.app.fetch(
    get("/api/auth/passkey/generate-authenticate-options"),
  );
  assertEquals(response.status, 200);
  const options = await response.json() as { challenge: string };
  return await fixture.app.fetch(authRequest(
    "/api/auth/passkey/verify-authentication",
    {
      response: await authenticator.authenticate({
        challenge: options.challenge,
      }),
    },
    { cookie: challengeCookie(response) },
  ));
}

async function listPasskeys(
  fixture: AppFixture,
  cookie: string,
): Promise<{ id: string; name: string }[]> {
  const response = await fixture.app.fetch(
    get("/api/auth/passkey/list-user-passkeys", cookie),
  );
  assertEquals(response.status, 200);
  return await response.json() as { id: string; name: string }[];
}

Deno.test("a signed-in person registers, lists, renames and removes a passkey, and only public credential data is stored", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-manage-${suffix}@example.test`;
  const password = `Passkey-Manage-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Manage", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);

    const registration = await registerPasskey(
      fixture,
      authenticator,
      cookie,
      "Laptop",
    );
    assertEquals(registration.status, 200);
    const registered = await registration.json() as Record<string, unknown>;
    assertEquals(registered.name, "Laptop");
    assertEquals(registered.credentialID, authenticator.credentialId);
    assert(
      !("session" in registered),
      "registration must not answer with a session",
    );

    const columns = await fixture.pgDatabase.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'passkey'`,
      [],
    );
    assertEquals(
      columns.rows.map((row) => row.column_name).sort(),
      PASSKEY_COLUMNS,
    );

    const listed = await listPasskeys(fixture, cookie);
    assertEquals(listed.length, 1);
    assertEquals(listed[0].name, "Laptop");

    const rename = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/update-passkey",
      { id: listed[0].id, name: "Desk" },
      { cookie },
    ));
    assertEquals(rename.status, 200);
    assertEquals((await listPasskeys(fixture, cookie))[0].name, "Desk");

    const remove = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: listed[0].id },
      { cookie },
    ));
    assertEquals(remove.status, 200);
    assertEquals(await listPasskeys(fixture, cookie), []);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("passkey sign-in without two-factor yields a verified session and advances the counter", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-signin-${suffix}@example.test`;
  const password = `Passkey-Signin-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Signin", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    assertEquals(
      (await registerPasskey(fixture, authenticator, cookie, "Laptop")).status,
      200,
    );
    await fixture.app.fetch(
      authRequest("/api/auth/sign-out", {}, { cookie }),
    );

    const authentication = await signInWithPasskey(fixture, authenticator);
    assertEquals(authentication.status, 200);
    const body = await authentication.json() as Record<string, unknown>;
    assert(
      !("twoFactorRedirect" in body),
      "a person without two-factor must not be pended",
    );

    const me = await fixture.app.fetch(
      get("/v1/me", sessionCookie(authentication)),
    );
    assertEquals(me.status, 200);

    const stored = await fixture.pgDatabase.query<{ counter: number }>(
      'select counter from public.passkey where "credentialID" = $1',
      [authenticator.credentialId],
    );
    assertEquals(stored.rows[0].counter, 1);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("passkey sign-in for a two-factor person pends until a code is entered", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-pending-${suffix}@example.test`;
  const password = `Passkey-Pending-${suffix}`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Pending", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    assertEquals(
      (await registerPasskey(fixture, authenticator, cookie, "Laptop")).status,
      200,
    );
    const enrolled = await enrollTotp(fixture, cookie, password);
    await fixture.app.fetch(
      authRequest("/api/auth/sign-out", {}, { cookie: enrolled.cookie }),
    );

    const authentication = await signInWithPasskey(fixture, authenticator);
    assertEquals(authentication.status, 200);
    const body = await authentication.json() as Record<string, unknown>;
    assertEquals(body.twoFactorRedirect, true);
    const pendingCookie = sessionCookie(authentication);

    const pendingMe = await fixture.app.fetch(get("/v1/me", pendingCookie));
    assertEquals(pendingMe.status, 401);
    assertEquals((await pendingMe.json()).code, AuthProblemCode.FactorRequired);

    const verify = await fixture.app.fetch(authRequest(
      "/api/auth/two-factor/verify-totp",
      { code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }) },
      { cookie: pendingCookie },
    ));
    assertEquals(verify.status, 200);

    const me = await fixture.app.fetch(get("/v1/me", pendingCookie));
    assertEquals(me.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("passkey management needs a sign-in within ten minutes even for a password holder", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-fresh-${suffix}@example.test`;
  const password = `Passkey-Fresh-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Fresh", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    const registration = await registerPasskey(
      fixture,
      authenticator,
      cookie,
      "Laptop",
    );
    assertEquals(registration.status, 200);
    const registered = await registration.json() as { id: string };

    // Creates the `twoFactor` row `get-totp-uri` needs without completing
    // enrollment, so `twoFactorEnabled` stays false and the stale session
    // below is Verified rather than Pending.
    const enable = await fixture.app.fetch(
      authRequest("/api/auth/two-factor/enable", { password }, { cookie }),
    );
    assertEquals(enable.status, 200);

    const now = new Date();
    const staleToken = `passkey-stale-session-${suffix}`;
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        staleToken,
        await userIdFor(fixture.pgDatabase, email),
        new Date(now.getTime() + 3_600_000),
        new Date(now.getTime() - 11 * 60_000),
      ],
    );
    const staleCookie = await signSessionCookie(
      staleToken,
      fixture.config.auth!.secret,
    );

    const staleOptions = await fixture.app.fetch(
      get("/api/auth/passkey/generate-register-options", staleCookie),
    );
    assertEquals(staleOptions.status, 403);
    assertEquals((await staleOptions.json()).code, "FRESH_SIGN_IN_REQUIRED");

    // The same stale cookie on a `password-or-fresh` path: the password in
    // the body proves identity, so the ten-minute rule does not apply there.
    const staleTotpUri = await fixture.app.fetch(authRequest(
      "/api/auth/two-factor/get-totp-uri",
      { password },
      { cookie: staleCookie },
    ));
    assertEquals(staleTotpUri.status, 200);

    const staleRename = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/update-passkey",
      { id: registered.id, name: "Desk" },
      { cookie: staleCookie },
    ));
    assertEquals(staleRename.status, 403);
    assertEquals((await staleRename.json()).code, "FRESH_SIGN_IN_REQUIRED");

    const freshRename = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/update-passkey",
      { id: registered.id, name: "Desk" },
      { cookie },
    ));
    assertEquals(freshRename.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("an expired challenge is refused and an abandoned ceremony changes nothing", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-challenge-${suffix}@example.test`;
  const password = `Passkey-Challenge-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Challenge", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    const userId = await userIdFor(fixture.pgDatabase, email);

    const options = await registerOptions(fixture, cookie);
    await fixture.pgDatabase.query(
      `update public.verification set "expiresAt" = now() - interval '1 minute'
        where identifier = $1`,
      [options.identifier],
    );
    const expired = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/verify-registration",
      {
        response: await authenticator.register({
          challenge: options.challenge,
        }),
        name: "Laptop",
      },
      { cookie: options.cookies },
    ));
    assertEquals(expired.status, 400);
    assertEquals((await expired.json()).code, "CHALLENGE_NOT_FOUND");

    const afterExpiry = await fixture.pgDatabase.query<{ count: number }>(
      'select count(*)::int as count from public.passkey where "userId" = $1',
      [userId],
    );
    assertEquals(afterExpiry.rows[0].count, 0);

    // A ceremony the person abandons: options issued, nothing submitted.
    await registerOptions(fixture, cookie);
    assertEquals(await listPasskeys(fixture, cookie), []);
    assertEquals((await fixture.app.fetch(get("/v1/me", cookie))).status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
