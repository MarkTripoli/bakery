import { assert, assertEquals, assertExists } from "@std/assert";
import { AuthProblemCode } from "../../packages/contracts/src/http.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  authTestSecret,
  cleanupAuthFixture,
  enrollTotp,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "../helpers/auth.ts";
import { createTotpOffsets, totpCode } from "../helpers/totp.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import type {
  WebSocketHandshakeFailure,
  WebSocketNext,
  WsClient,
} from "../helpers/ws-client.ts";

type RemoteAddrEnv = {
  readonly remoteAddr: {
    readonly transport: "tcp";
    readonly hostname: string;
    readonly port: number;
  };
};

// TEST-NET-1 (RFC 5737): reserved for hand-picked literals in this file so
// they can never collide with `nextClientEnv()`'s synthetic `10.x.x.x`
// clients (see `tests/helpers/auth.ts`).
function remoteAddrEnv(hostname: string): RemoteAddrEnv {
  return { remoteAddr: { transport: "tcp", hostname, port: 1 } };
}

function twoFactorChallengeCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) =>
    value.startsWith("better-auth.two_factor=")
  );
  if (!cookie) throw new Error("TWO_FACTOR_CHALLENGE_COOKIE_REQUIRED");
  return cookie.split(";", 1)[0];
}

function isWsClient(
  value: WsClient | WebSocketHandshakeFailure,
): value is WsClient {
  return "send" in value;
}

Deno.test("exactly one concurrent backup-code use succeeds and the code is consumed", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-race-${suffix}@example.test`;
  const password = `Totp-Race-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Race", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);
    const targetCode = enrolled.backupCodes[0];

    const clientCount = 6;
    const challengeCookies = await Promise.all(
      Array.from({ length: clientCount }, async (_, index) => {
        const response = await fixture.app.fetch(
          authRequest("/api/auth/sign-in/email", { email, password }),
          remoteAddrEnv(`192.0.2.${index + 1}`),
        );
        return twoFactorChallengeCookie(response);
      }),
    );

    const attempts = await Promise.all(
      challengeCookies.map((cookie, index) =>
        fixture.app.fetch(
          authRequest(
            "/api/auth/two-factor/verify-backup-code",
            { code: targetCode },
            { cookie },
          ),
          remoteAddrEnv(`192.0.2.${11 + index}`),
        )
      ),
    );
    const statuses = attempts.map((response) => response.status);
    assertEquals(statuses.filter((status) => status === 200).length, 1);
    assert(
      statuses.every((status) =>
        status === 200 || status === 401 || status === 409
      ),
      `unexpected statuses: ${statuses.join(",")}`,
    );

    // The one consumed code is gone from the identity's remaining count.
    const winner = attempts.find((response) => response.status === 200)!;
    const identity = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`, {
        headers: { cookie: sessionCookie(winner) },
      }),
    );
    assertEquals(identity.status, 200);
    assertEquals(
      (await identity.json()).backupCodesRemaining,
      enrolled.backupCodes.length - 1,
    );

    const replaySignIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
      remoteAddrEnv("192.0.2.20"),
    );
    const replayCookie = twoFactorChallengeCookie(replaySignIn);
    const consumed = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-backup-code",
        { code: targetCode },
        { cookie: replayCookie },
      ),
      remoteAddrEnv("192.0.2.20"),
    );
    assertEquals(consumed.status, 401);
    assertEquals((await consumed.json()).code, "INVALID_BACKUP_CODE");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a valid TOTP code cannot be replayed through any path, and stale steps are rejected", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-replay-${suffix}@example.test`;
  const password = `Totp-Replay-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Replay", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);
    const nextOffset = createTotpOffsets();
    const code = await totpCode(enrolled.secret, { stepOffset: nextOffset() });

    const first = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code },
        { cookie: enrolled.cookie },
      ),
      remoteAddrEnv("192.0.2.31"),
    );
    assertEquals(first.status, 200);

    const replay = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code },
        { cookie: enrolled.cookie },
      ),
      remoteAddrEnv("192.0.2.32"),
    );
    assertEquals(replay.status, 401);
    assertEquals((await replay.json()).code, "INVALID_CODE");

    // The realistic replay scenario: a code observed during the victim's
    // own (session-based) verification, replayed via a fresh password
    // challenge (the sign-in-path branch, which resolves the user id from
    // the `two_factor` cookie instead of a session). The challenge itself
    // must still be usable — proven by accepting a fresh backup code on it
    // — so only the replayed code is refused, not the whole challenge.
    const challenge = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
      remoteAddrEnv("192.0.2.33"),
    );
    const challengeCookie = twoFactorChallengeCookie(challenge);

    const replayViaChallenge = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code },
        { cookie: challengeCookie },
      ),
      remoteAddrEnv("192.0.2.34"),
    );
    assertEquals(replayViaChallenge.status, 401);
    assertEquals((await replayViaChallenge.json()).code, "INVALID_CODE");

    const backupOnChallenge = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-backup-code",
        { code: enrolled.backupCodes[0] },
        { cookie: challengeCookie },
      ),
      remoteAddrEnv("192.0.2.35"),
    );
    assertEquals(backupOnChallenge.status, 200);

    const staleCode = await totpCode(enrolled.secret, { stepOffset: -3 });
    const stale = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: staleCode },
        { cookie: enrolled.cookie },
      ),
      remoteAddrEnv("192.0.2.36"),
    );
    assertEquals(stale.status, 401);
    assertEquals((await stale.json()).code, "INVALID_CODE");
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("an expired two-factor challenge is rejected, and the marker it leaves behind is rolled back", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-expired-${suffix}@example.test`;
  const password = `Totp-Expired-${suffix}`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Expired", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    const user = await fixture.pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    const userId = user.rows[0].id;

    const challenge = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
      remoteAddrEnv("192.0.2.41"),
    );
    const challengeCookie = twoFactorChallengeCookie(challenge);

    // Scoped to this test's own user: the `verification` table is shared
    // across every fixture on the same database, so an unscoped update
    // would expire concurrent lanes' and processes' pending challenges too.
    await fixture.pgDatabase.query(
      `update public.verification
          set "expiresAt" = now() - interval '1 minute'
        where identifier like '2fa-%' and value = $1`,
      [userId],
    );

    const code = await totpCode(enrolled.secret, { stepOffset: nextOffset() });
    const verify = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code },
        { cookie: challengeCookie },
      ),
      remoteAddrEnv("192.0.2.42"),
    );
    assertEquals(verify.status, 401);
    const verifyBody = await verify.json() as { code?: unknown };
    assert(
      verifyBody.code !== "INVALID_CODE",
      "must fail for the expired challenge, not an incidental replay",
    );

    // The endpoint returned an APIError for the expired challenge, so the
    // replay marker recorded for `code` must have been rolled back — a
    // fresh challenge can still accept the same, still-valid code.
    const freshChallenge = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
      remoteAddrEnv("192.0.2.43"),
    );
    const freshChallengeCookie = twoFactorChallengeCookie(freshChallenge);
    const recovered = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code },
        { cookie: freshChallengeCookie },
      ),
      remoteAddrEnv("192.0.2.44"),
    );
    assertEquals(recovered.status, 200);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("verify-totp is rate limited per client and the limit is backed by durable storage", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-ratelimit-${suffix}@example.test`;
  const password = `Totp-RateLimit-${suffix}`;
  const limitedAddr = "192.0.2.51";
  const otherAddr = "192.0.2.52";
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP RateLimit", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    const attempt = (hostname: string) =>
      fixture.app.fetch(
        authRequest(
          "/api/auth/two-factor/verify-totp",
          { code: "000000" },
          { cookie: enrolled.cookie },
        ),
        remoteAddrEnv(hostname),
      );

    let limited: Response | undefined;
    for (let index = 0; index < 4; index += 1) {
      limited = await attempt(limitedAddr);
    }
    assertEquals(limited!.status, 429);
    assertExists(limited!.headers.get("X-Retry-After"));

    const other = await attempt(otherAddr);
    assert(other.status !== 429);

    const restarted = await openAuthFixture();
    try {
      const stillLimited = await restarted.app.fetch(
        authRequest(
          "/api/auth/two-factor/verify-totp",
          { code: "000000" },
          { cookie: enrolled.cookie },
        ),
        remoteAddrEnv(limitedAddr),
      );
      assertEquals(stillLimited.status, 429);
    } finally {
      await restarted.close();
    }
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("trustDevice never yields a trust-device cookie", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-trust-${suffix}@example.test`;
  const password = `Totp-Trust-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Trust", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    const verify = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        {
          code: await totpCode(enrolled.secret, { stepOffset: 1 }),
          trustDevice: true,
        },
        { cookie: enrolled.cookie },
      ),
      remoteAddrEnv("192.0.2.61"),
    );
    assertEquals(verify.status, 200);
    assert(
      !verify.headers.getSetCookie().some((value) =>
        value.startsWith("better-auth.trust_device=")
      ),
      "trustDevice must never be honored",
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a client-supplied issuer never reaches the authenticator URI", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-issuer-${suffix}@example.test`;
  const password = `Totp-Issuer-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Issuer", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );

    const enable = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/enable",
        { password, issuer: "Evil Corp" },
        { cookie: sessionCookie(signIn) },
      ),
    );
    assertEquals(enable.status, 200);
    const { totpURI } = await enable.json() as { totpURI: string };
    assert(
      totpURI.startsWith("otpauth://totp/Bakery:"),
      `issuer was not pinned: ${totpURI}`,
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("ten failed verification attempts lock the account, a correct code is refused while locked, and the lock lapses", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-lockout-${suffix}@example.test`;
  const password = `Totp-Lockout-${suffix}`;
  const nextOffset = createTotpOffsets();
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Lockout", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    // A pending session (the GitHub/passwordless primary sign-in shape):
    // enrolled but no recorded factor evidence yet, seeded directly like
    // the integration lane's pending-session case.
    const user = await fixture.pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [email],
    );
    const userId = user.rows[0].id;
    const token = `totp-lockout-session-${suffix}`;
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

    let tenthAttempt: Response | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      tenthAttempt = await fixture.app.fetch(
        authRequest(
          "/api/auth/two-factor/verify-totp",
          { code: "000000" },
          { cookie: pendingCookie },
        ),
        remoteAddrEnv(`192.0.2.${65 + attempt}`),
      );
    }
    assertEquals(tenthAttempt!.status, 401);

    const eleventh = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: "000000" },
        { cookie: pendingCookie },
      ),
      remoteAddrEnv("192.0.2.75"),
    );
    assertEquals(eleventh.status, 429);
    assertEquals(
      (await eleventh.json()).code,
      "ACCOUNT_TEMPORARILY_LOCKED",
    );

    const correctWhileLocked = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: await totpCode(enrolled.secret, { stepOffset: nextOffset() }) },
        { cookie: pendingCookie },
      ),
      remoteAddrEnv("192.0.2.76"),
    );
    assertEquals(correctWhileLocked.status, 429);
    assertEquals(
      (await correctWhileLocked.json()).code,
      "ACCOUNT_TEMPORARILY_LOCKED",
    );

    // Lapsed-lock recovery: once `lockedUntil` is in the past, a wrong code
    // fails normally again (401, not 429) and a correct proof both
    // succeeds and resets the failure budget.
    await fixture.pgDatabase.query(
      `update public."twoFactor"
          set "lockedUntil" = now() - interval '1 minute'
        where "userId" = $1`,
      [userId],
    );

    const wrongAfterLapse = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: "000000" },
        { cookie: pendingCookie },
      ),
      remoteAddrEnv("192.0.2.77"),
    );
    assertEquals(wrongAfterLapse.status, 401);

    const recovered = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-backup-code",
        { code: enrolled.backupCodes[0] },
        { cookie: pendingCookie },
      ),
      remoteAddrEnv("192.0.2.78"),
    );
    assertEquals(recovered.status, 200);

    const twoFactorRow = await fixture.pgDatabase.query<{
      failedVerificationCount: number;
    }>(
      'select "failedVerificationCount" from public."twoFactor" where "userId" = $1',
      [userId],
    );
    assertEquals(twoFactorRow.rows[0].failedVerificationCount, 0);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("a TOTP code cannot be accepted twice even when submitted concurrently through different paths", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-concurrent-code-${suffix}@example.test`;
  const password = `Totp-ConcurrentCode-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Concurrent Code", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);
    const nextOffset = createTotpOffsets();
    const code = await totpCode(enrolled.secret, { stepOffset: nextOffset() });

    const challenge = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
      remoteAddrEnv("192.0.2.81"),
    );
    const challengeCookie = twoFactorChallengeCookie(challenge);

    const [viaSession, viaChallenge] = await Promise.all([
      fixture.app.fetch(
        authRequest(
          "/api/auth/two-factor/verify-totp",
          { code },
          { cookie: enrolled.cookie },
        ),
        remoteAddrEnv("192.0.2.82"),
      ),
      fixture.app.fetch(
        authRequest(
          "/api/auth/two-factor/verify-totp",
          { code },
          { cookie: challengeCookie },
        ),
        remoteAddrEnv("192.0.2.83"),
      ),
    ]);
    const statuses = [viaSession.status, viaChallenge.status];
    assertEquals(
      statuses.filter((status) => status === 200).length,
      1,
      `expected exactly one 200, got ${statuses.join(",")}`,
    );
    assert(statuses.every((status) => status === 200 || status === 401));
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("the events socket rejects a pending handshake and closes a session that becomes pending mid-flight", async () => {
  const socket = await openSocketFixture({
    eventsSocket: { limits: { pollIntervalMs: 50, heartbeatMs: 300 } },
  });
  try {
    const enrolled = await enrollTotp(socket, socket.cookie, socket.password);

    const user = await socket.pgDatabase.query<{ id: string }>(
      'select id from public."user" where email = $1',
      [socket.email],
    );
    const userId = user.rows[0].id;
    const token = `totp-socket-pending-${crypto.randomUUID()}`;
    const now = new Date();
    await socket.pgDatabase.query(
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
      socket.config.auth!.secret,
    );

    const rejected = await socket.connect({ cookie: pendingCookie });
    if (isWsClient(rejected)) {
      await rejected.close();
      throw new Error("expected the pending session to fail the handshake");
    }
    assertEquals(rejected.status, 401);
    const rejectedBody = rejected.body;
    if (
      !rejectedBody || typeof rejectedBody !== "object" ||
      !("code" in rejectedBody)
    ) {
      throw new Error("expected a problem body with a code");
    }
    assertEquals(rejectedBody.code, AuthProblemCode.FactorRequired);

    const connected = await socket.connect({ cookie: enrolled.cookie });
    if (!isWsClient(connected)) {
      throw new Error(
        `verified socket handshake failed: ${JSON.stringify(connected.body)}`,
      );
    }
    try {
      await socket.pgDatabase.query(
        `update public.session set "factorVerifiedAt" = null where "userId" = $1`,
        [userId],
      );
      const deadline = Date.now() + 3_000;
      let outcome: WebSocketNext = "";
      while (Date.now() < deadline) {
        outcome = await connected.next(Math.max(100, deadline - Date.now()));
        if (typeof outcome !== "string") break;
      }
      if (typeof outcome === "string") {
        throw new Error("expected the socket to close within the deadline");
      }
      assertEquals(outcome.code, 1008);
    } finally {
      await connected.close();
    }
  } finally {
    await socket.close();
  }
});

Deno.test("two-factor failure bodies never leak secret material", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `totp-leaks-${suffix}@example.test`;
  const password = `Totp-Leaks-${suffix}`;
  const failureBodies: string[] = [];
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "TOTP Leaks", password });
    const signIn = await fixture.app.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    const enrolled = await enrollTotp(fixture, sessionCookie(signIn), password);

    const wrongCode = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-totp",
        { code: "000000" },
        { cookie: enrolled.cookie },
      ),
      remoteAddrEnv("192.0.2.91"),
    );
    failureBodies.push(await wrongCode.text());

    const wrongBackupCode = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/verify-backup-code",
        { code: "aaaaa-aaaaa" },
        { cookie: enrolled.cookie },
      ),
      remoteAddrEnv("192.0.2.92"),
    );
    failureBodies.push(await wrongBackupCode.text());

    const staleDisable = await fixture.app.fetch(
      authRequest(
        "/api/auth/two-factor/disable",
        { password: "wrong-password" },
        { cookie: enrolled.cookie },
      ),
      remoteAddrEnv("192.0.2.93"),
    );
    failureBodies.push(await staleDisable.text());

    const noSession = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/me`),
    );
    failureBodies.push(await noSession.text());

    const captured = failureBodies.join("\n");
    const leakedValues = [
      password,
      enrolled.secret,
      ...enrolled.backupCodes,
      authTestSecret,
      enrolled.cookie,
      "$ba$",
      "postgres://",
      "public.session",
      "public.twoFactor",
      "public.verification",
    ];
    for (const leaked of leakedValues) {
      assert(!captured.includes(leaked), leaked);
    }
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
