// Real-process problem+json pipeline. See `backend-stack_test.ts` header for
// what belongs in this lane.
//
// Sign-up over HTTP is invite-only, so a stack has exactly one seedable user
// (`createSuperuser` is a one-shot bootstrap — a second call throws
// `AUTH_BOOTSTRAP_CONFLICT`, as CI run 35088596155 found). The one seeded
// superuser here is shared by the 405 probe (plain session) and the INTERNAL
// probe (TOTP-enrolled, then the server is restarted under a different
// secret) — in that order, since the restart invalidates cookies.
import { assert, assertEquals } from "@std/assert";
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
      displayName: "E2E Errors",
      password,
    });
  } finally {
    await closePgDatabase(pgDatabase);
  }
}

Deno.test(
  "backend e2e problem+json pipeline through the real process",
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    const stack = await upStack("errors");
    const suffix = crypto.randomUUID();
    const email = `e2e-errors-${suffix}@example.test`;
    const password = `E2e-Errors-${suffix}`;
    try {
      await t.step(
        "unknown route -> problem+json from the real process",
        async () => {
          const response = await fetch(`${stack.origin}/v1/does-not-exist`);
          assertEquals(response.status, 404);
          assertEquals(
            response.headers.get("content-type"),
            "application/problem+json",
          );
          const body = await response.json() as { code: string; type: string };
          assertEquals(body.code, "RESOURCE_NOT_FOUND");
          assert(
            body.type.startsWith(`${stack.origin}/problems/`),
            `type must be built from the container's own public base url; got ${body.type}`,
          );
        },
      );

      await t.step("method not allowed on the events socket", async () => {
        await seedSuperuser(stack, email, password);

        // Anonymous, no Origin header: the origin guard in front of
        // `/v1/events` rejects before the route's own 405 handler is ever
        // reached (observed in CI run 35088596155 as an unexpected 403).
        const anonymous = await fetch(`${stack.origin}/v1/events`, {
          method: "POST",
        });
        assertEquals(anonymous.status, 403);
        assertEquals(
          anonymous.headers.get("content-type"),
          "application/problem+json",
        );
        const anonymousBody = await anonymous.json() as { code: string };
        assertEquals(anonymousBody.code, "AUTH_FORBIDDEN");

        // Same-origin and authenticated: now the request reaches the route
        // itself and the 405 handler answers.
        const signIn = await stack.fetch(
          authRequest("/api/auth/sign-in/email", { email, password }),
        );
        assertEquals(signIn.status, 200);
        const response = await stack.fetch(
          new Request(`${authTestOrigin}/v1/events`, {
            method: "POST",
            headers: { cookie: sessionCookie(signIn), origin: authTestOrigin },
          }),
        );
        assertEquals(response.status, 405);
        assertEquals(response.headers.get("allow"), "GET");
        assertEquals(
          response.headers.get("content-type"),
          "application/problem+json",
        );
        const body = await response.json() as { code: string };
        assertEquals(body.code, "METHOD_NOT_ALLOWED");
      });

      await t.step(
        "thrown server error renders as INTERNAL problem, no leak",
        async () => {
          const nextOffset = createTotpOffsets();

          const signIn = await stack.fetch(
            authRequest("/api/auth/sign-in/email", { email, password }),
          );
          const enrolled = await enrollTotp(
            { app: { fetch: (request) => stack.fetch(request) } },
            sessionCookie(signIn),
            password,
          );
          await stack.fetch(
            authRequest("/api/auth/sign-out", {}, { cookie: enrolled.cookie }),
          );

          await stack.restartServer({
            BETTER_AUTH_SECRET: `e2e-errors-restored-${crypto.randomUUID()}`,
          });

          const challenge = await stack.fetch(
            authRequest("/api/auth/sign-in/email", { email, password }),
          );
          assertEquals(challenge.status, 200);
          const challengeCookie = twoFactorChallengeCookie(challenge);

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
          assertEquals(verify.status, 500);
          assertEquals(
            verify.headers.get("content-type"),
            "application/problem+json",
          );
          const body = await verify.json() as Record<string, unknown>;
          assertEquals(body.code, "INTERNAL");
          assertEquals(body.retryable, false);
          assert(
            !verify.headers.getSetCookie().some((value) =>
              value.startsWith("better-auth.session_token=")
            ),
            "a restored-key failure must never issue a session",
          );
          const raw = JSON.stringify(body);
          assert(
            !raw.includes(enrolled.secret),
            "response must not leak the TOTP secret",
          );
          for (const backupCode of enrolled.backupCodes) {
            assert(
              !raw.includes(backupCode),
              "response must not leak a backup code",
            );
          }
        },
      );
    } finally {
      await stack.down();
    }
  },
);
