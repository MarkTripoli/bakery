import { assert, assertEquals, assertExists } from "@std/assert";
import { AuthProblemCode } from "../../packages/contracts/src/http.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  enrollTotp,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "../helpers/auth.ts";
import { createTotpOffsets, totpCode } from "../helpers/totp.ts";

function get(path: string, cookie: string): Request {
  return new Request(`${authTestOrigin}${path}`, { headers: { cookie } });
}

Deno.test("password sign-in for an enrolled user pends until the factor is verified", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-password-${suffix}@example.test`;
  const password = `Totp-Password-${suffix}`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Password", password });

    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);
    await fixture.app.fetch(
      authRequest("/api/auth/sign-out", {}, { cookie: enrolled.cookie }),
    );

    const challenge = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(challenge.status, 200);
    const challengeBody = await challenge.json() as {
      twoFactorRedirect: unknown;
    };
    assertEquals(challengeBody.twoFactorRedirect, true);
    const sessionTokenCookie = challenge.headers.getSetCookie().find((value) =>
      value.startsWith("better-auth.session_token=")
    );
    assert(
      sessionTokenCookie === undefined ||
        sessionTokenCookie.split(";", 1)[0] === "better-auth.session_token=",
      "a pending challenge must not issue a live session cookie",
    );
    const pendingCookie = challenge.headers.getSetCookie()
      .find((value) => value.startsWith("better-auth.two_factor="))
      ?.split(";", 1)[0];
    assertExists(pendingCookie);

    const pendingMe = await fixture.app.fetch(get("/v1/me", pendingCookie!));
    assertEquals(pendingMe.status, 401);
    assertEquals((await pendingMe.json()).code, AuthProblemCode.Required);

    const verify = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }) },
        { cookie: pendingCookie! },
      ),
    );
    assertEquals(verify.status, 200);

    const me = await fixture.app.fetch(get("/v1/me", sessionCookie(verify)));
    assertEquals(me.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a session with no recorded factor evidence is rejected everywhere except recovery and sign-out", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-pending-${suffix}@example.test`;
  const password = `Totp-Pending-${suffix}`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Pending", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    const user = await fixture.pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    const userId = user.rows[0].id;
    const token = `totp-pending-session-${suffix}`;
    const now = new Date();
    await fixture.pgDatabase.query(
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
    const pendingCookie = await signSessionCookie(
      token,
      fixture.config.auth!.secret,
    );

    const me = await fixture.app.fetch(get("/v1/me", pendingCookie));
    assertEquals(me.status, 401);
    assertEquals((await me.json()).code, AuthProblemCode.FactorRequired);

    const organizations = await fixture.app.fetch(
      get("/v1/organizations", pendingCookie),
    );
    assertEquals(organizations.status, 401);
    assertEquals(
      (await organizations.json()).code,
      AuthProblemCode.FactorRequired,
    );

    const invitation = await fixture.app.fetch(
      get(
        `/api/auth/organization/get-invitation?id=${crypto.randomUUID()}`,
        pendingCookie,
      ),
    );
    assertEquals(invitation.status, 401);
    assertEquals(
      (await invitation.json()).code,
      AuthProblemCode.FactorRequired,
    );

    const enable = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/enable",
        { password },
        { cookie: pendingCookie },
      ),
    );
    assertEquals(enable.status, 403);
    assertEquals((await enable.json()).code, "TWO_FACTOR_REQUIRED");

    const getSession = await fixture.app.fetch(
      get("/api/auth/get-session", pendingCookie),
    );
    assertEquals(getSession.status, 200);

    const verify = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }) },
        { cookie: pendingCookie },
      ),
    );
    assertEquals(verify.status, 200);

    const verifiedMe = await fixture.app.fetch(get("/v1/me", pendingCookie));
    assertEquals(verifiedMe.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("completing enrollment revokes every other session of the user", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-revoke-${suffix}@example.test`;
  const password = `Totp-Revoke-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Revoke", password });

    const signInA = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookieA = sessionCookie(signInA);
    const signInB = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const cookieB = sessionCookie(signInB);

    await enrollTotp(fixture, cookieA, password);

    const meB = await fixture.app.fetch(get("/v1/me", cookieB));
    assertEquals(meB.status, 401);
    assertEquals((await meB.json()).code, AuthProblemCode.Invalid);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("backup code regeneration replaces the whole set after a fresh factor proof", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-regen-${suffix}@example.test`;
  const password = `Totp-Regen-${suffix}`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Regen", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);
    const staleCode = enrolled.backupCodes[0];

    const reauth = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }) },
        { cookie: enrolled.cookie },
      ),
    );
    assertEquals(reauth.status, 200);

    const regenerate = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/generate-backup-codes",
        { password },
        { cookie: enrolled.cookie },
      ),
    );
    assertEquals(regenerate.status, 200);
    const { backupCodes: freshCodes } = await regenerate.json() as {
      backupCodes: string[];
    };
    assertEquals(freshCodes.length, enrolled.backupCodes.length);
    assert(!freshCodes.includes(staleCode));

    const rejected = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-backup-code",
        { code: staleCode },
        { cookie: enrolled.cookie },
      ),
    );
    assertEquals(rejected.status, 401);
    assertEquals((await rejected.json()).code, "INVALID_BACKUP_CODE");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("disabling two-factor requires a fresh factor proof and revokes other sessions", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-disable-${suffix}@example.test`;
  const password = `Totp-Disable-${suffix}`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Disable", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    const user = await fixture.pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    const userId = user.rows[0].id;
    const now = new Date();
    const otherToken = `totp-disable-other-${suffix}`;
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt",
         "factorVerifiedAt"
       ) values ($1, $2, $3, $4, $5, $5, $5)`,
      [
        crypto.randomUUID(),
        otherToken,
        userId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    const otherCookie = await signSessionCookie(
      otherToken,
      fixture.config.auth!.secret,
    );

    await fixture.pgDatabase.query(
      `update public.session
          set "factorVerifiedAt" = now() - interval '10 minutes'
        where "userId" = $1 and token != $2`,
      [userId, otherToken],
    );

    const staleDisable = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/disable",
        { password },
        { cookie: enrolled.cookie },
      ),
    );
    assertEquals(staleDisable.status, 403);
    assertEquals((await staleDisable.json()).code, "FACTOR_PROOF_REQUIRED");

    const reverify = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }) },
        { cookie: enrolled.cookie },
      ),
    );
    assertEquals(reverify.status, 200);

    const disable = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/disable",
        { password },
        { cookie: enrolled.cookie },
      ),
    );
    assertEquals(disable.status, 200);

    const otherMe = await fixture.app.fetch(get("/v1/me", otherCookie));
    assertEquals(otherMe.status, 401);
    assertEquals((await otherMe.json()).code, AuthProblemCode.Invalid);

    const nextSignIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(nextSignIn.status, 200);
    const nextBody = await nextSignIn.json() as Record<string, unknown>;
    assert(!("twoFactorRedirect" in nextBody));
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("passwordless accounts require a recent sign-in before managing two-factor", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-passwordless-${suffix}@example.test`;
  try {
    const userId = crypto.randomUUID();
    const now = new Date();
    await fixture.pgDatabase.query(
      `insert into public."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) values ($1, 'Passwordless User', $2, true, $3, $3)`,
      [userId, email, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
         id, provider_user_id, display_name, principal_type
       ) values ($1, $2, 'Passwordless User', 'human')`,
      [crypto.randomUUID(), userId],
    );

    const freshToken = `totp-passwordless-fresh-${suffix}`;
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        freshToken,
        userId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    const freshCookie = await signSessionCookie(
      freshToken,
      fixture.config.auth!.secret,
    );

    const enable = await fixture.app.fetch(
      authRequest("/api/auth/two-factor/enable", {}, { cookie: freshCookie }),
    );
    assertEquals(enable.status, 200);

    const staleToken = `totp-passwordless-stale-${suffix}`;
    const staleCreatedAt = new Date(now.getTime() - 11 * 60_000);
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        staleToken,
        userId,
        new Date(now.getTime() + 3_600_000),
        staleCreatedAt,
      ],
    );
    const staleCookie = await signSessionCookie(
      staleToken,
      fixture.config.auth!.secret,
    );

    const staleEnable = await fixture.app.fetch(
      authRequest("/api/auth/two-factor/enable", {}, { cookie: staleCookie }),
    );
    assertEquals(staleEnable.status, 403);
    assertEquals((await staleEnable.json()).code, "FRESH_SIGN_IN_REQUIRED");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("verifying a pending session older than the refresh window still stamps factor evidence", async () => {
  // Regression coverage for the policy hook's own `getSessionFromCtx` read
  // (adapters/session-assurance.ts) triggering Better Auth's session
  // refresh once a session is older than `session.updateAge` (24h default):
  // an unpatched hook lets `ctx.context.newSession` get populated by that
  // side effect, so the after-hook's "was a session created?" branch takes
  // the wrong path and never stamps `factorVerifiedAt` — permanently
  // locking the account out of every `/v1/*` route.
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-stale-session-${suffix}@example.test`;
  const password = `Totp-StaleSession-${suffix}`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Stale Session", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    const user = await fixture.pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    const userId = user.rows[0].id;
    const token = `totp-stale-session-${suffix}`;
    const createdAt = new Date(Date.now() - 25 * 60 * 60_000);
    const expiresAt = new Date(Date.now() + 6 * 24 * 60 * 60_000);
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [crypto.randomUUID(), token, userId, expiresAt, createdAt],
    );
    const pendingCookie = await signSessionCookie(
      token,
      fixture.config.auth!.secret,
    );

    const verify = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        {
          code: await totpCode(enrolled.secret, {
            stepOffset: nextOffset(),
          }),
        },
        { cookie: pendingCookie },
      ),
    );
    assertEquals(verify.status, 200);

    const stamped = await fixture.pgDatabase.query<{
      factorVerifiedAt: Date | null;
    }>(
      'select "factorVerifiedAt" from public.session where token = $1',
      [token],
    );
    assertExists(stamped.rows[0]);
    assert(
      stamped.rows[0].factorVerifiedAt !== null,
      "factorVerifiedAt was not stamped on the old pending session",
    );

    const me = await fixture.app.fetch(get("/v1/me", pendingCookie));
    assertEquals(me.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
