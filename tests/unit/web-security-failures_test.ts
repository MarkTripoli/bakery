import { assertEquals } from "@std/assert";
import {
  AuthProviderError,
  type AuthProviderFailureCode,
} from "../../packages/contracts/src/auth-provider-client.ts";
import {
  reauthSearch,
  safeReturnPath,
  securityFailure,
} from "../../apps/web/src/app/security-failures.ts";

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

Deno.test("a fresh sign-in refusal routes to re-authentication, a factor refusal is proved in place", () => {
  assertEquals(securityFailure(providerError("FRESH_SIGN_IN_REQUIRED")), {
    kind: "reauthRequired",
  });
  assertEquals(securityFailure(providerError("FACTOR_PROOF_REQUIRED")), {
    kind: "factorRequired",
  });
  assertEquals(securityFailure(providerError("PASSWORD_NOT_SET")), {
    kind: "passwordNotSet",
  });
});

Deno.test("password and passkey failures name the field or outcome", () => {
  assertEquals(securityFailure(providerError("INVALID_PASSWORD")), {
    kind: "invalidPassword",
  });
  assertEquals(securityFailure(providerError("INVALID_CREDENTIALS")), {
    kind: "invalidPassword",
  });
  for (
    const code of [
      "PASSWORD_TOO_SHORT",
      "PASSWORD_TOO_LONG",
      "WEAK_PASSWORD",
    ] as const
  ) {
    assertEquals(securityFailure(providerError(code)), {
      kind: "weakPassword",
    });
  }
  assertEquals(securityFailure(providerError("LAST_SIGN_IN_METHOD")), {
    kind: "lastSignInMethod",
  });
  assertEquals(securityFailure(providerError("NETWORK")), { kind: "offline" });
});

Deno.test("everything else is a form-level notice, with a countdown only when told", () => {
  assertEquals(securityFailure(new Error("boom")), {
    kind: "notice",
    messageKey: "auth.signIn.unavailable",
    retryAfterSeconds: null,
  });
  assertEquals(securityFailure(providerError("RATE_LIMITED", 30)), {
    kind: "notice",
    messageKey: "auth.signIn.rateLimited",
    retryAfterSeconds: 30,
  });
  // Two-factor-only classes never surface as field errors on these pages.
  assertEquals(securityFailure(providerError("TWO_FACTOR_INVALID")), {
    kind: "notice",
    messageKey: "auth.signIn.unavailable",
    retryAfterSeconds: null,
  });
});

Deno.test("return paths stay same-origin and never loop back to re-authentication", () => {
  assertEquals(
    safeReturnPath("/settings/security/passkeys", "/x"),
    "/settings/security/passkeys",
  );
  assertEquals(safeReturnPath("//evil.example", "/x"), "/x");
  assertEquals(safeReturnPath("https://evil.example", "/x"), "/x");
  assertEquals(safeReturnPath("/\\evil.example", "/x"), "/x");
  assertEquals(
    safeReturnPath("/account/reauthenticate?returnTo=/a", "/x"),
    "/x",
  );
  assertEquals(safeReturnPath(null, "/x"), "/x");
  // Control characters are stripped by URL parsers, leaving a host.
  for (
    const smuggled of [
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r\n/evil.com",
      "/ok\u0000/evil.com",
      "/ok\u007f",
      "/a/b\\c",
    ]
  ) {
    assertEquals(
      safeReturnPath(smuggled, "/x"),
      "/x",
      JSON.stringify(smuggled),
    );
  }
  assertEquals(
    safeReturnPath("/settings?tab=a&b=c#top", "/x"),
    "/settings?tab=a&b=c#top",
  );
  assertEquals(reauthSearch("/settings/security/password"), {
    returnTo: "/settings/security/password",
  });
});
