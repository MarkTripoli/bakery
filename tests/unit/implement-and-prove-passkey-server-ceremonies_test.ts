import { assertEquals } from "@std/assert";
import {
  passkeyOrigins,
  passkeyRpId,
} from "../../apps/server/src/modules/auth/adapters/passkey-policy.ts";
import { rewritePasskeyResponse } from "../../apps/server/src/modules/auth/transport/http/routes.ts";

Deno.test("the RP ID is the public origin's hostname without its port", () => {
  assertEquals(
    passkeyRpId({ publicOrigin: "http://localhost:18788" }),
    "localhost",
  );
  assertEquals(
    passkeyRpId({ publicOrigin: "http://127.0.0.1:8788" }),
    "127.0.0.1",
  );
  assertEquals(
    passkeyRpId({ publicOrigin: "https://bakery.example.test" }),
    "bakery.example.test",
  );
});

Deno.test("passkey origins keep only origins in the RP ID's realm", () => {
  const publicOrigin = "https://bakery.example.test";
  const cases = [
    {
      name: "no trusted origins still leaves the public origin",
      trustedOrigins: [],
      expected: [publicOrigin],
    },
    {
      name: "a wildcard host is dropped, never compared as a string",
      trustedOrigins: ["https://*.example.test"],
      expected: [publicOrigin],
    },
    {
      name: "a foreign host is dropped",
      trustedOrigins: ["https://other.test"],
      expected: [publicOrigin],
    },
    {
      name: "an unparsable entry is skipped",
      trustedOrigins: ["not an origin"],
      expected: [publicOrigin],
    },
    {
      name: "the same host on another port is kept",
      trustedOrigins: ["https://bakery.example.test:8443"],
      expected: [publicOrigin, "https://bakery.example.test:8443"],
    },
    {
      name: "a subdomain of the RP ID is kept",
      trustedOrigins: ["https://app.bakery.example.test"],
      expected: [publicOrigin, "https://app.bakery.example.test"],
    },
    {
      name: "a host merely ending in the RP ID is dropped",
      trustedOrigins: ["https://notbakery.example.test"],
      expected: [publicOrigin],
    },
    {
      name: "the public origin is never duplicated",
      trustedOrigins: [publicOrigin, publicOrigin],
      expected: [publicOrigin],
    },
  ];

  for (const { name, trustedOrigins, expected } of cases) {
    assertEquals(
      passkeyOrigins({ publicOrigin, trustedOrigins }),
      expected,
      name,
    );
  }
});

type RewriteCase = {
  name: string;
  pathname: string;
  status: number;
  body: unknown;
  expected: { status: number; body: unknown } | undefined;
};

Deno.test("passkey envelope rewrites are scoped to path, status and body", () => {
  const registrationPath = "/api/auth/passkey/verify-registration";
  const authenticationPath = "/api/auth/passkey/verify-authentication";
  const failure = { code: "FAILED_TO_VERIFY_REGISTRATION", message: "no" };
  const totpSignIn = {
    session: { token: "t" },
    user: { id: "u", twoFactorEnabled: true },
  };
  const cases: RewriteCase[] = [
    {
      name: "a registration verification failure becomes a 400",
      pathname: registrationPath,
      status: 500,
      body: failure,
      expected: { status: 400, body: failure },
    },
    {
      name: "another 500 on the registration path is left to INTERNAL",
      pathname: registrationPath,
      status: 500,
      body: { code: "UNABLE_TO_CREATE_SESSION" },
      expected: undefined,
    },
    {
      name: "the same code on another path is left to INTERNAL",
      pathname: "/api/auth/sign-in/email",
      status: 500,
      body: failure,
      expected: undefined,
    },
    {
      name: "a TOTP user's passkey sign-in gains the redirect flag",
      pathname: authenticationPath,
      status: 200,
      body: totpSignIn,
      expected: {
        status: 200,
        body: { ...totpSignIn, twoFactorRedirect: true },
      },
    },
    {
      name: "a user without TOTP keeps the provider's body",
      pathname: authenticationPath,
      status: 200,
      body: {
        session: { token: "t" },
        user: { id: "u", twoFactorEnabled: false },
      },
      expected: undefined,
    },
    {
      name: "a failed passkey sign-in is not rewritten",
      pathname: authenticationPath,
      status: 401,
      body: { code: "AUTHENTICATION_FAILED" },
      expected: undefined,
    },
    {
      name: "a non-object body is never rewritten",
      pathname: registrationPath,
      status: 500,
      body: undefined,
      expected: undefined,
    },
    {
      name: "a non-object user is never rewritten",
      pathname: authenticationPath,
      status: 200,
      body: { session: { token: "t" }, user: "u" },
      expected: undefined,
    },
  ];

  for (const { name, pathname, status, body, expected } of cases) {
    assertEquals(
      rewritePasskeyResponse(pathname, status, body),
      expected,
      name,
    );
  }
});
