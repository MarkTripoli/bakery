import { assertEquals } from "@std/assert";
import { AuthProviderError } from "../../packages/contracts/src/auth-provider-client.ts";
import type { AuthProviderFailureCode } from "../../packages/contracts/src/auth-provider-client.ts";
import { twoFactorFailure } from "../../apps/web/src/app/two-factor-failures.ts";
import {
  deviceKind,
  otherSessions,
} from "../../apps/web/src/app/browser-sessions.ts";

function providerError(
  code: AuthProviderFailureCode,
  retryAfterSeconds: number | null = null,
): AuthProviderError {
  return new AuthProviderError(code, {
    status: 400,
    requestId: "req-1",
    retryAfterSeconds,
  });
}

Deno.test("two-factor failures name the field or the navigation the page must take", () => {
  assertEquals(twoFactorFailure(providerError("INVALID_CREDENTIALS")), {
    kind: "invalidPassword",
  });
  assertEquals(twoFactorFailure(providerError("TWO_FACTOR_INVALID")), {
    kind: "invalidCode",
  });
  assertEquals(twoFactorFailure(providerError("FACTOR_PROOF_REQUIRED")), {
    kind: "factorProofRequired",
  });
  assertEquals(twoFactorFailure(providerError("FRESH_SIGN_IN_REQUIRED")), {
    kind: "freshSignInRequired",
  });
  assertEquals(twoFactorFailure(providerError("TWO_FACTOR_SESSION_EXPIRED")), {
    kind: "enrolmentExpired",
  });
});

Deno.test("a rate limit is only a countdown when the server said how long", () => {
  assertEquals(twoFactorFailure(providerError("RATE_LIMITED", 30)), {
    kind: "notice",
    messageKey: "auth.signIn.rateLimited",
    retryAfterSeconds: 30,
  });
  assertEquals(twoFactorFailure(providerError("RATE_LIMITED")), {
    kind: "notice",
    messageKey: "auth.signIn.unavailable",
    retryAfterSeconds: null,
  });
});

Deno.test("unknown and non-provider failures read as the unavailable notice, never as a credential problem", () => {
  const unavailable = {
    kind: "notice",
    messageKey: "auth.signIn.unavailable",
    retryAfterSeconds: null,
  } as const;
  assertEquals(twoFactorFailure(providerError("UNAVAILABLE")), unavailable);
  assertEquals(twoFactorFailure(new TypeError("fetch failed")), unavailable);
  assertEquals(twoFactorFailure(providerError("NETWORK")), {
    kind: "notice",
    messageKey: "auth.signIn.offline",
    retryAfterSeconds: null,
  });
  assertEquals(twoFactorFailure(providerError("LOCKED")), {
    kind: "notice",
    messageKey: "auth.twoFactor.locked",
    retryAfterSeconds: null,
  });
});

Deno.test("other sessions exclude the current browser and lead with the most recently refreshed", () => {
  const session = (
    id: string,
    current: boolean,
    updatedAt: string,
  ) => ({
    id,
    current,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    expiresAt: "2026-02-01T00:00:00.000Z",
    userAgent: null,
    ipAddress: null,
  });
  const others = otherSessions({
    items: [
      session("older", false, "2026-01-02T00:00:00.000Z"),
      session("mine", true, "2026-01-09T00:00:00.000Z"),
      session("newer", false, "2026-01-05T00:00:00.000Z"),
    ],
  });
  assertEquals(others.map((entry) => entry.id), ["newer", "older"]);
});

Deno.test("a handheld user agent reads as a phone; anything else, including none, as a desktop", () => {
  assertEquals(
    deviceKind(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    ),
    "phone",
  );
  assertEquals(
    deviceKind("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile"),
    "phone",
  );
  assertEquals(
    deviceKind("Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36"),
    "desktop",
  );
  assertEquals(deviceKind(null), "desktop");
});
