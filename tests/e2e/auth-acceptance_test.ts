// Real-process auth admission: password sign-in, TOTP challenge and verify,
// and the rate limiter's real remote-address hop. See `backend-stack_test.ts`
// header for what belongs in this lane.
//
// Sign-up over HTTP is invite-only, so a stack has exactly one seedable user
// (`createSuperuser` is a one-shot bootstrap — a second call throws
// `AUTH_BOOTSTRAP_CONFLICT`, as CI run 35088596155 found). All three steps
// below share the one seeded superuser and its evolving session cookie.
import { assert, assertEquals, assertExists } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import {
  authRequest,
  authTestOrigin,
  enrollTotp,
  sessionCookie,
} from "../helpers/auth.ts";
import { createTotpOffsets, totpCode } from "../helpers/totp.ts";
import { type Stack, upStack } from "./helpers/stack.ts";

function twoFactorChallengeCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) =>
    value.startsWith("better-auth.two_factor=")
  );
  if (!cookie) throw new Error("TWO_FACTOR_CHALLENGE_COOKIE_REQUIRED");
  return cookie.split(";", 1)[0];
}

function meRequest(cookie: string): Request {
  return new Request(`${authTestOrigin}/v1/me`, {
    headers: { cookie, origin: authTestOrigin },
  });
}

/**
 * Seeds a user the same way `tasks.ts createsuperuser` does, without a TTY:
 * calls `createSuperuser` directly against the owner-role connection, using
 * the same secret/public-base-url the container was started with. This is
 * the one out-of-process shortcut in the lane — everything else goes over
 * real HTTP. Password hashing is secret-independent, so the containerized
 * server authenticates the row. Called exactly once per stack: a second
 * call throws `AUTH_BOOTSTRAP_CONFLICT`.
 */
async function seedSuperuser(
  stack: Stack,
  email: string,
  password: string,
): Promise<void> {
  const pgDatabase = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: stack.ownerDatabaseUrl,
      BAKERY_PUBLIC_BASE_URL: stack.origin,
      BETTER_AUTH_SECRET: stack.authSecret,
    }).auth!;
    await createSuperuser({ pgDatabase, config }, {
      email,
      displayName: "E2E Auth Acceptance",
      password,
    });
  } finally {
    await closePgDatabase(pgDatabase);
  }
}

Deno.test(
  "backend e2e auth admission through the real process",
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    const stack = await upStack("auth");
    const suffix = crypto.randomUUID();
    const email = `e2e-auth-${suffix}@example.test`;
    const password = `E2e-Auth-${suffix}`;
    let fullSessionCookie = "";
    try {
      await t.step(
        "password sign-in with no factor yields a full session; protected surface reachable",
        async () => {
          await seedSuperuser(stack, email, password);

          const signIn = await stack.fetch(
            authRequest("/api/auth/sign-in/email", { email, password }),
          );
          assertEquals(signIn.status, 200);
          const setCookie = signIn.headers.getSetCookie().find((value) =>
            value.startsWith("better-auth.session_token=")
          );
          assertExists(setCookie, "sign-in must set a session cookie");
          assert(setCookie!.includes("HttpOnly"));
          assert(setCookie!.includes("SameSite=Lax"));
          assert(setCookie!.includes("Path=/"));
          fullSessionCookie = sessionCookie(signIn);

          const me = await stack.fetch(meRequest(fullSessionCookie));
          assertEquals(me.status, 200);
          const identity = await me.json() as { displayName: string };
          assertEquals(identity.displayName, "E2E Auth Acceptance");
        },
      );

      await t.step("TOTP enrollment then challenged sign-in", async () => {
        const nextOffset = createTotpOffsets();
        const enrolled = await enrollTotp(
          { app: { fetch: (request) => stack.fetch(request) } },
          fullSessionCookie,
          password,
        );
        await stack.fetch(
          authRequest("/api/auth/sign-out", {}, { cookie: enrolled.cookie }),
        );

        const challenge = await stack.fetch(
          authRequest("/api/auth/sign-in/email", { email, password }),
        );
        assertEquals(challenge.status, 200);
        const challengeBody = await challenge.json() as {
          twoFactorRedirect: unknown;
          twoFactorMethods: unknown;
        };
        assertEquals(challengeBody.twoFactorRedirect, true);
        assertEquals(challengeBody.twoFactorMethods, ["totp"]);
        // The provider clears any prior session with an empty-valued
        // `session_token=` cookie; only a non-empty value is a live session.
        const sessionTokenCookie = challenge.headers.getSetCookie().find(
          (value) => value.startsWith("better-auth.session_token="),
        );
        assert(
          sessionTokenCookie === undefined ||
            sessionTokenCookie.split(";", 1)[0] ===
              "better-auth.session_token=",
          "a pending challenge must not issue a live session cookie",
        );
        const challengeCookie = twoFactorChallengeCookie(challenge);

        // The middleware has no session token to resolve at all behind a bare
        // two-factor challenge cookie, so it rejects as AUTH_REQUIRED rather
        // than AUTH_FACTOR_REQUIRED (pinned by
        // `tests/integration/require-totp-assurance-...`).
        const pendingMe = await stack.fetch(meRequest(challengeCookie));
        assertEquals(pendingMe.status, 401);
        assertEquals((await pendingMe.json()).code, "AUTH_REQUIRED");

        const verify = await stack.fetch(
          authRequest(
            "/api/auth/two-factor/verify-totp",
            {
              code: await totpCode(enrolled.secret, {
                stepOffset: nextOffset(),
              }),
            },
            { cookie: challengeCookie },
          ),
        );
        assertEquals(verify.status, 200);

        const me = await stack.fetch(meRequest(sessionCookie(verify)));
        assertEquals(me.status, 200);
        const identity = await me.json() as { displayName: string };
        assertEquals(identity.displayName, "E2E Auth Acceptance");
      });

      // Runs last: the sign-in path limiter is a single durable per-IP
      // bucket shared with the two sign-ins above, so this step both spends
      // and proves that shared budget rather than starting from a clean one.
      await t.step(
        "remote address reaches the rate limiter through the real TCP hop",
        async () => {
          const statuses: number[] = [];
          for (let attempt = 0; attempt < 11; attempt++) {
            const response = await stack.fetch(
              authRequest("/api/auth/sign-in/email", {
                email,
                password: "wrong-password",
              }),
            );
            statuses.push(response.status);
          }
          assert(
            statuses.includes(429),
            `expected at least one 429 among ${statuses.join(",")}`,
          );
          assertEquals(statuses.at(-1), 429);

          // Per-IP, not per-credential: even the correct password is still
          // limited once the bucket is spent.
          const correctPassword = await stack.fetch(
            authRequest("/api/auth/sign-in/email", { email, password }),
          );
          assertEquals(correctPassword.status, 429);

          const rows = await stack.psql<{ count: string }>(
            `select count(*) as count from public."rateLimit"`,
          );
          assert(Number(rows[0].count) >= 1);
        },
      );
    } finally {
      await stack.down();
    }
  },
);
