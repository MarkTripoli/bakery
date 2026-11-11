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
  type CeremonyOverrides,
  challengeCookie,
  createSoftwareAuthenticator,
  type SoftwareAuthenticator,
} from "../helpers/webauthn.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

/** Everything a refused ceremony must leave untouched. */
type AccountState = {
  passkeys: { id: string; counter: number }[];
  sessions: number;
};

/** The plugin derives the RP ID from the public origin (`authTestOrigin`). */
const PASSKEY_RP_ID = "127.0.0.1";

async function accountState(
  pgDatabase: PgDatabase,
  userId: string,
): Promise<AccountState> {
  const passkeys = await pgDatabase.query<{ id: string; counter: number }>(
    'select id, counter from public.passkey where "userId" = $1 order by id',
    [userId],
  );
  const sessions = await pgDatabase.query<{ count: number }>(
    'select count(*)::int as count from public.session where "userId" = $1',
    [userId],
  );
  return { passkeys: passkeys.rows, sessions: sessions.rows[0].count };
}

/** One `public.account` row: the shape `assertNotLastSignInMethod` reads. */
type SeededAccount = { providerId: string; password: string | null };

async function seedAccount(
  pgDatabase: PgDatabase,
  userId: string,
  account: SeededAccount,
): Promise<string> {
  const id = crypto.randomUUID();
  await pgDatabase.query(
    `insert into public.account (
       id, "accountId", "providerId", "userId", password,
       "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, now(), now())`,
    [id, userId, account.providerId, userId, account.password],
  );
  return id;
}

/**
 * A second person in a test: `createSuperuser` bootstraps exactly one
 * installation administrator per database, so everyone after the first is
 * seeded directly. `accounts` are the rows the last-method guard reads; a
 * password value is never verified because the session cookie is signed
 * here rather than earned through `/sign-in/email`.
 */
async function seedUser(
  pgDatabase: PgDatabase,
  secret: string,
  options: {
    email: string;
    displayName: string;
    accounts?: readonly SeededAccount[];
  },
): Promise<{ userId: string; cookie: string }> {
  const userId = crypto.randomUUID();
  const now = new Date();
  await pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, $2, $3, true, $4, $4)`,
    [userId, options.displayName, options.email, now],
  );
  await pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, $3, 'human')`,
    [crypto.randomUUID(), userId, options.displayName],
  );
  for (const account of options.accounts ?? []) {
    await seedAccount(pgDatabase, userId, account);
  }
  const token = `passkey-seeded-session-${userId}`;
  await pgDatabase.query(
    `insert into public.session (
       id, token, "userId", "expiresAt", "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      token,
      userId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  return { userId, cookie: await signSessionCookie(token, secret) };
}

/** `GET generate-register-options`: the challenge and the cookies it must be echoed with. */
async function registerOptions(fixture: AppFixture, cookie: string) {
  const response = await fixture.app.fetch(
    get("/api/auth/passkey/generate-register-options", cookie),
  );
  assertEquals(response.status, 200);
  const options = await response.json() as { challenge: string };
  return {
    challenge: options.challenge,
    ceremonyCookie: challengeCookie(response),
    cookies: `${cookie}; ${challengeCookie(response)}`,
  };
}

async function attemptRegistration(
  fixture: AppFixture,
  authenticator: SoftwareAuthenticator,
  cookie: string,
  overrides?: CeremonyOverrides,
): Promise<Response> {
  const options = await registerOptions(fixture, cookie);
  return await fixture.app.fetch(authRequest(
    "/api/auth/passkey/verify-registration",
    {
      response: await authenticator.register(
        { challenge: options.challenge },
        overrides,
      ),
      name: "Laptop",
    },
    { cookie: options.cookies },
  ));
}

/** `GET generate-authenticate-options` with no session: the anonymous sign-in ceremony. */
async function authenticateOptions(fixture: AppFixture) {
  const response = await fixture.app.fetch(
    get("/api/auth/passkey/generate-authenticate-options"),
  );
  assertEquals(response.status, 200);
  const options = await response.json() as { challenge: string };
  return {
    challenge: options.challenge,
    ceremonyCookie: challengeCookie(response),
  };
}

async function attemptAuthentication(
  fixture: AppFixture,
  authenticator: SoftwareAuthenticator,
  overrides?: CeremonyOverrides,
): Promise<Response> {
  const options = await authenticateOptions(fixture);
  return await fixture.app.fetch(authRequest(
    "/api/auth/passkey/verify-authentication",
    {
      response: await authenticator.authenticate(
        { challenge: options.challenge },
        overrides,
      ),
    },
    { cookie: options.ceremonyCookie },
  ));
}

Deno.test("a wrong origin or RP ID is refused at registration and at sign-in", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-origin-${suffix}@example.test`;
  const password = `Passkey-Origin-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Origin", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    const userId = await userIdFor(fixture.pgDatabase, email);
    const beforeRegistration = await accountState(fixture.pgDatabase, userId);

    // A 500 here would surface as `INTERNAL` instead: the 400 proves the
    // registration rewrite in `secureAuthResponse` is wired.
    const foreignOrigin = await attemptRegistration(
      fixture,
      authenticator,
      cookie,
      { origin: "http://evil.example.test" },
    );
    assertEquals(foreignOrigin.status, 400);
    assertEquals(
      (await foreignOrigin.json()).code,
      "FAILED_TO_VERIFY_REGISTRATION",
    );
    assertEquals(
      await accountState(fixture.pgDatabase, userId),
      beforeRegistration,
    );

    const foreignRpId = await attemptRegistration(
      fixture,
      authenticator,
      cookie,
      { rpId: "evil.example.test" },
    );
    assertEquals(foreignRpId.status, 400);
    assertEquals(
      (await foreignRpId.json()).code,
      "FAILED_TO_VERIFY_REGISTRATION",
    );
    assertEquals(
      await accountState(fixture.pgDatabase, userId),
      beforeRegistration,
    );

    assertEquals(
      (await attemptRegistration(fixture, authenticator, cookie)).status,
      200,
    );
    const registered = await accountState(fixture.pgDatabase, userId);

    const originSignIn = await attemptAuthentication(fixture, authenticator, {
      origin: "http://evil.example.test",
    });
    assertEquals(originSignIn.status, 400);
    assertEquals((await originSignIn.json()).code, "AUTHENTICATION_FAILED");
    assertEquals(await accountState(fixture.pgDatabase, userId), registered);

    const rpIdSignIn = await attemptAuthentication(fixture, authenticator, {
      rpId: "evil.example.test",
    });
    assertEquals(rpIdSignIn.status, 400);
    assertEquals((await rpIdSignIn.json()).code, "AUTHENTICATION_FAILED");
    assertEquals(await accountState(fixture.pgDatabase, userId), registered);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a ceremony without user verification is refused before anything is written", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-uv-${suffix}@example.test`;
  const password = `Passkey-Uv-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Uv", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    const userId = await userIdFor(fixture.pgDatabase, email);
    const beforeRegistration = await accountState(fixture.pgDatabase, userId);

    // A 500 would mean `APIError` identity broke between `better-auth/api`
    // and the plugin's own `@better-auth/core/error` import.
    const options = await registerOptions(fixture, cookie);
    const unverified = await authenticator.register(
      { challenge: options.challenge },
      { userVerified: false },
    );
    const refused = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/verify-registration",
      { response: unverified, name: "Laptop" },
      { cookie: options.cookies },
    ));
    assertEquals(refused.status, 401);
    assertEquals((await refused.json()).code, "USER_VERIFICATION_REQUIRED");
    assertEquals(
      await accountState(fixture.pgDatabase, userId),
      beforeRegistration,
    );

    // The challenge was consumed, so a refused attempt is not retryable.
    const retried = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/verify-registration",
      { response: unverified, name: "Laptop" },
      { cookie: options.cookies },
    ));
    assertEquals(retried.status, 400);
    assertEquals((await retried.json()).code, "CHALLENGE_NOT_FOUND");

    assertEquals(
      (await attemptRegistration(fixture, authenticator, cookie)).status,
      200,
    );
    const registered = await accountState(fixture.pgDatabase, userId);

    const unverifiedSignIn = await attemptAuthentication(
      fixture,
      authenticator,
      { userVerified: false },
    );
    assertEquals(unverifiedSignIn.status, 401);
    assertEquals(
      (await unverifiedSignIn.json()).code,
      "USER_VERIFICATION_REQUIRED",
    );
    assertEquals(await accountState(fixture.pgDatabase, userId), registered);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a replayed assertion, a forged signature or a stale counter is refused", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-replay-${suffix}@example.test`;
  const password = `Passkey-Replay-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Replay", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    const userId = await userIdFor(fixture.pgDatabase, email);
    assertEquals(
      (await attemptRegistration(fixture, authenticator, cookie)).status,
      200,
    );

    const options = await authenticateOptions(fixture);
    const assertion = await authenticator.authenticate({
      challenge: options.challenge,
    });
    const accepted = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/verify-authentication",
      { response: assertion },
      { cookie: options.ceremonyCookie },
    ));
    assertEquals(accepted.status, 200);
    const signedIn = await accountState(fixture.pgDatabase, userId);
    assertEquals(signedIn.passkeys[0].counter, 1);

    const replayed = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/verify-authentication",
      { response: assertion },
      { cookie: options.ceremonyCookie },
    ));
    assertEquals(replayed.status, 400);
    assertEquals((await replayed.json()).code, "CHALLENGE_NOT_FOUND");
    assertEquals(await accountState(fixture.pgDatabase, userId), signedIn);

    // The credential resolves and the counter is fresh: only the signature
    // check can refuse this one. SimpleWebAuthn answers a wrong signature
    // with `verified: false` rather than a throw, so the plugin's 401 path
    // fires instead of the catch-all 400.
    const forged = await attemptAuthentication(fixture, authenticator, {
      signature: "invalid",
    });
    assertEquals(forged.status, 401);
    assertEquals((await forged.json()).code, "AUTHENTICATION_FAILED");
    assertEquals(await accountState(fixture.pgDatabase, userId), signedIn);

    const stale = await attemptAuthentication(fixture, authenticator, {
      counter: 1,
    });
    assertEquals(stale.status, 400);
    assertEquals((await stale.json()).code, "AUTHENTICATION_FAILED");
    assertEquals(await accountState(fixture.pgDatabase, userId), signedIn);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("another person's credential cannot sign in, be renamed or removed, and registration cannot be attributed across users", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const ownerEmail = `passkey-owner-${suffix}@example.test`;
  const otherEmail = `passkey-other-${suffix}@example.test`;
  try {
    const owner = await seedUser(
      fixture.pgDatabase,
      fixture.config.auth!.secret,
      { email: ownerEmail, displayName: "Passkey Owner" },
    );
    const other = await seedUser(
      fixture.pgDatabase,
      fixture.config.auth!.secret,
      { email: otherEmail, displayName: "Passkey Other" },
    );
    const ownerAuthenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const otherAuthenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const strangerAuthenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const ownerCookie = owner.cookie;
    const otherCookie = other.cookie;
    const ownerId = owner.userId;
    const otherId = other.userId;
    const registration = await attemptRegistration(
      fixture,
      ownerAuthenticator,
      ownerCookie,
    );
    assertEquals(registration.status, 200);
    const ownerPasskey = await registration.json() as { id: string };
    const owned = await accountState(fixture.pgDatabase, ownerId);
    const unowned = await accountState(fixture.pgDatabase, otherId);

    // The other person's cookie is a live session before it is used as a
    // negative below: a 401 from a dead cookie would prove nothing.
    const foreignList = await fixture.app.fetch(
      get("/api/auth/passkey/list-user-passkeys", otherCookie),
    );
    assertEquals(foreignList.status, 200);
    assertEquals(await foreignList.json(), []);

    const unknownCredential = await attemptAuthentication(
      fixture,
      strangerAuthenticator,
    );
    assertEquals(unknownCredential.status, 401);
    assertEquals((await unknownCredential.json()).code, "PASSKEY_NOT_FOUND");

    const foreignRename = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/update-passkey",
      { id: ownerPasskey.id, name: "Stolen" },
      { cookie: otherCookie },
    ));
    assertEquals(foreignRename.status, 401);
    assertEquals(
      (await foreignRename.json()).code,
      "YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY",
    );

    // `delete-passkey` carries no `forbiddenError`: a bare 401, so the live
    // listing above is what pins ownership as the cause.
    const foreignRemove = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: ownerPasskey.id },
      { cookie: otherCookie },
    ));
    assertEquals(foreignRemove.status, 401);
    assertEquals(await accountState(fixture.pgDatabase, ownerId), owned);
    const stored = await fixture.pgDatabase.query<{ name: string }>(
      "select name from public.passkey where id = $1",
      [ownerPasskey.id],
    );
    assertEquals(stored.rows[0].name, "Laptop");

    // The other person's session against the owner's challenge: the stored
    // `userData.id` decides, not the cookie the request happens to carry.
    const ownerOptions = await registerOptions(fixture, ownerCookie);
    const crossRegistration = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/verify-registration",
      {
        response: await otherAuthenticator.register({
          challenge: ownerOptions.challenge,
        }),
        name: "Borrowed",
      },
      { cookie: `${otherCookie}; ${ownerOptions.ceremonyCookie}` },
    ));
    assertEquals(crossRegistration.status, 401);
    assertEquals(
      (await crossRegistration.json()).code,
      "YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY",
    );
    assertEquals(await accountState(fixture.pgDatabase, ownerId), owned);
    assertEquals(await accountState(fixture.pgDatabase, otherId), unowned);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [ownerEmail, otherEmail]);
    await fixture.close();
  }
});

Deno.test("a pending passkey session reaches nothing but recovery and sign-out", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-pending-${suffix}@example.test`;
  const password = `Passkey-Pending-${suffix}`;
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
      (await attemptRegistration(fixture, authenticator, cookie)).status,
      200,
    );
    const enrolled = await enrollTotp(fixture, cookie, password);
    await fixture.app.fetch(
      authRequest("/api/auth/sign-out", {}, { cookie: enrolled.cookie }),
    );

    const authentication = await attemptAuthentication(fixture, authenticator);
    assertEquals(authentication.status, 200);
    const pendingCookie = sessionCookie(authentication);

    const me = await fixture.app.fetch(get("/v1/me", pendingCookie));
    assertEquals(me.status, 401);
    assertEquals((await me.json()).code, AuthProblemCode.FactorRequired);

    for (
      const path of [
        "/api/auth/passkey/list-user-passkeys",
        "/api/auth/passkey/generate-register-options",
        "/api/auth/passkey/generate-authenticate-options",
      ]
    ) {
      const response = await fixture.app.fetch(get(path, pendingCookie));
      assertEquals(response.status, 403, path);
      assertEquals((await response.json()).code, "TWO_FACTOR_REQUIRED", path);
    }
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("removing the last passkey is refused when no password and no social account remain", async () => {
  // The guard counts rows, so two concurrent deletes of the last two
  // passkeys can both pass. Not asserted: both outcomes of that race are
  // acceptable (the owner acting against themselves, recovery is an admin
  // invitation), so a test that passes either way proves nothing.
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-last-${suffix}@example.test`;
  try {
    // A credential row without a password is the shape a person who never
    // set one has; it must count for nothing.
    const { userId, cookie } = await seedUser(
      fixture.pgDatabase,
      fixture.config.auth!.secret,
      {
        email,
        displayName: "Passwordless Passkey",
        accounts: [{ providerId: "credential", password: null }],
      },
    );

    const first = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const second = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const firstRegistration = await attemptRegistration(fixture, first, cookie);
    assertEquals(firstRegistration.status, 200);
    const firstPasskey = await firstRegistration.json() as { id: string };

    const refused = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: firstPasskey.id },
      { cookie },
    ));
    assertEquals(refused.status, 403);
    assertEquals((await refused.json()).code, "LAST_SIGN_IN_METHOD");
    assertEquals((await accountState(fixture.pgDatabase, userId)).passkeys, [
      { id: firstPasskey.id, counter: 0 },
    ]);

    const secondRegistration = await attemptRegistration(
      fixture,
      second,
      cookie,
    );
    assertEquals(secondRegistration.status, 200);
    const secondPasskey = await secondRegistration.json() as { id: string };

    const removedOne = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: firstPasskey.id },
      { cookie },
    ));
    assertEquals(removedOne.status, 200);

    const refusedLast = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: secondPasskey.id },
      { cookie },
    ));
    assertEquals(refusedLast.status, 403);
    assertEquals((await refusedLast.json()).code, "LAST_SIGN_IN_METHOD");
    assertEquals((await accountState(fixture.pgDatabase, userId)).passkeys, [
      { id: secondPasskey.id, counter: 0 },
    ]);

    // A social account is a way back in, so the last passkey may go.
    await seedAccount(fixture.pgDatabase, userId, {
      providerId: "github",
      password: null,
    });
    const removedLast = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: secondPasskey.id },
      { cookie },
    ));
    assertEquals(removedLast.status, 200);
    assertEquals((await accountState(fixture.pgDatabase, userId)).passkeys, []);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("removing a passkey needs factor proof within five minutes only for two-factor users", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const totpEmail = `passkey-proof-totp-${suffix}@example.test`;
  const totpPassword = `Passkey-Proof-Totp-${suffix}`;
  const plainEmail = `passkey-proof-plain-${suffix}@example.test`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, {
      email: totpEmail,
      displayName: "Passkey Proof Totp",
      password: totpPassword,
    });
    const plain = await seedUser(
      fixture.pgDatabase,
      fixture.config.auth!.secret,
      {
        email: plainEmail,
        displayName: "Passkey Proof Plain",
        accounts: [{
          providerId: "credential",
          password: "seeded-password-hash",
        }],
      },
    );
    const totpAuthenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const plainAuthenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });

    const totpSignIn = await fixture.app.fetch(authRequest(
      "/api/auth/sign-in/email",
      { email: totpEmail, password: totpPassword },
    ));
    const totpRegistration = await attemptRegistration(
      fixture,
      totpAuthenticator,
      sessionCookie(totpSignIn),
    );
    assertEquals(totpRegistration.status, 200);
    const totpPasskey = await totpRegistration.json() as { id: string };
    const enrolled = await enrollTotp(
      fixture,
      sessionCookie(totpSignIn),
      totpPassword,
    );
    const totpUserId = await userIdFor(fixture.pgDatabase, totpEmail);
    await fixture.pgDatabase.query(
      `update public.session set "factorVerifiedAt" = $2
        where "userId" = $1`,
      [totpUserId, new Date(Date.now() - 10 * 60_000)],
    );
    const enrolledState = await accountState(fixture.pgDatabase, totpUserId);

    const staleProof = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: totpPasskey.id },
      { cookie: enrolled.cookie },
    ));
    assertEquals(staleProof.status, 403);
    assertEquals((await staleProof.json()).code, "FACTOR_PROOF_REQUIRED");
    assertEquals(
      await accountState(fixture.pgDatabase, totpUserId),
      enrolledState,
    );

    const verify = await fixture.app.fetch(authRequest(
      "/api/auth/two-factor/verify-totp",
      { code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }) },
      { cookie: enrolled.cookie },
    ));
    assertEquals(verify.status, 200);
    const provenRemove = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: totpPasskey.id },
      { cookie: enrolled.cookie },
    ));
    assertEquals(provenRemove.status, 200);
    assertEquals(
      (await accountState(fixture.pgDatabase, totpUserId)).passkeys,
      [],
    );

    // Never verified a factor: `totp-users` mode has nothing to demand.
    const plainCookie = plain.cookie;
    const plainRegistration = await attemptRegistration(
      fixture,
      plainAuthenticator,
      plainCookie,
    );
    assertEquals(plainRegistration.status, 200);
    const plainPasskey = await plainRegistration.json() as { id: string };
    const plainRemove = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/delete-passkey",
      { id: plainPasskey.id },
      { cookie: plainCookie },
    ));
    assertEquals(plainRemove.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [totpEmail, plainEmail]);
    await fixture.close();
  }
});

Deno.test("registration cannot mint a session", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `passkey-nosession-${suffix}@example.test`;
  const password = `Passkey-Nosession-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Passkey Nosession", password });
    const authenticator = await createSoftwareAuthenticator({
      origin: authTestOrigin,
      rpId: PASSKEY_RP_ID,
    });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookie = sessionCookie(signIn);
    const userId = await userIdFor(fixture.pgDatabase, email);
    const before = await accountState(fixture.pgDatabase, userId);

    const options = await registerOptions(fixture, cookie);
    const registration = await fixture.app.fetch(authRequest(
      "/api/auth/passkey/verify-registration",
      {
        response: await authenticator.register({
          challenge: options.challenge,
        }),
        name: "Laptop",
        createSession: true,
      },
      { cookie: options.cookies },
    ));
    assertEquals(registration.status, 200);
    const body = await registration.json() as Record<string, unknown>;
    assert(!("session" in body), "registration must not answer with a session");
    assert(
      !registration.headers.getSetCookie().some((value) =>
        value.startsWith("better-auth.session_token=") &&
        value.split(";", 1)[0] !== "better-auth.session_token="
      ),
      "registration must not set a session cookie",
    );

    const after = await accountState(fixture.pgDatabase, userId);
    assertEquals(after.sessions, before.sessions);
    assertEquals(after.passkeys.length, 1);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
