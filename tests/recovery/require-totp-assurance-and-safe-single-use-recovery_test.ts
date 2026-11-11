import { assert, assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  cleanupAuthFixture,
  enrollTotp,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";
import { createTotpOffsets, totpCode } from "../helpers/totp.ts";

function twoFactorChallengeCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) =>
    value.startsWith("better-auth.two_factor=")
  );
  if (!cookie) throw new Error("TWO_FACTOR_CHALLENGE_COOKIE_REQUIRED");
  return cookie.split(";", 1)[0];
}

Deno.test("a database restored under a different secret fails closed without leaking material, and the original secret still verifies after restart", async () => {
  const suffix = crypto.randomUUID();
  const email = `totp-recovery-${suffix}@example.test`;
  const password = `Totp-Recovery-${suffix}`;
  const originalSecret = `totp-recovery-original-secret-${suffix}`;
  const restoredSecret = `totp-recovery-restored-secret-${suffix}`;

  // Three independent Better Auth instances against the same durable store:
  // A enrolls under the original key; B emulates a database restored with a
  // different `BETTER_AUTH_SECRET`; C emulates a plain process restart with
  // the original key restored.
  const fixtureA = await openAuthFixture({ secret: originalSecret });
  const fixtureB = await openAuthFixture({ secret: restoredSecret });
  const fixtureC = await openAuthFixture({ secret: originalSecret });
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixtureA.pgDatabase,
      config: fixtureA.config.auth!,
    }, { email, displayName: "TOTP Recovery", password });
    const signIn = await fixtureA.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(
      fixtureA,
      sessionCookie(signIn),
      password,
    );

    const restoredChallenge = await fixtureB.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(restoredChallenge.status, 200);
    const restoredChallengeBody = await restoredChallenge.json() as {
      twoFactorRedirect: unknown;
    };
    assertEquals(restoredChallengeBody.twoFactorRedirect, true);
    const restoredCookie = twoFactorChallengeCookie(restoredChallenge);

    const restoredTotp = await fixtureB.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }) },
        { cookie: restoredCookie },
      ),
    );
    assertEquals(restoredTotp.status, 500);
    assertEquals((await restoredTotp.json()).code, "INTERNAL");
    assert(
      !restoredTotp.headers.getSetCookie().some((value) =>
        value.startsWith("better-auth.session_token=")
      ),
      "a restored-key failure must never issue a session",
    );

    const restoredBackupCode = await fixtureB.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-backup-code",
        { code: enrolled.backupCodes[0] },
        { cookie: restoredCookie },
      ),
    );
    assertEquals(restoredBackupCode.status, 500);
    assertEquals((await restoredBackupCode.json()).code, "INTERNAL");
    assert(
      !restoredBackupCode.headers.getSetCookie().some((value) =>
        value.startsWith("better-auth.session_token=")
      ),
      "a restored-key failure must never issue a session",
    );

    const restartChallenge = await fixtureC.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(restartChallenge.status, 200);
    const restartChallengeBody = await restartChallenge.json() as {
      twoFactorRedirect: unknown;
    };
    assertEquals(restartChallengeBody.twoFactorRedirect, true);
    const restartCookie = twoFactorChallengeCookie(restartChallenge);

    const restartVerify = await fixtureC.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-backup-code",
        { code: enrolled.backupCodes[1] },
        { cookie: restartCookie },
      ),
    );
    assertEquals(restartVerify.status, 200);
  } finally {
    await cleanupAuthFixture(fixtureA.pgDatabase, [email]);
    await Promise.all([
      fixtureA.close(),
      fixtureB.close(),
      fixtureC.close(),
    ]);
  }
});
